'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Events,
  ApplicationCommandOptionType,
  MessageFlags,
  EmbedBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const stats = require('./stats');
const cookies = require('./cookies');

const BRAND = 0x14b8a6;
const STATS_GUILD_ID = process.env.STATS_GUILD_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const isBotWall = (m = '') => /not a bot|sign in to confirm/i.test(m);

// --- Per-guild music state --------------------------------------------------

const queues = new Map();

function getQueue(guildId) {
  let q = queues.get(guildId);
  if (q) return q;

  q = {
    tracks: [],
    current: null,
    playing: false,
    textChannel: null,
    // Play even if a subscriber isn't "active" the instant play() is called,
    // otherwise the player silently pauses and you hear nothing.
    player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
  };

  q.player.on('stateChange', (o, n) => console.log(`[player] ${o.status} -> ${n.status}`));
  q.player.on(AudioPlayerStatus.Idle, () => {
    playNext(guildId).catch((e) => console.error('[playNext]', e.message));
  });
  q.player.on('error', (err) => {
    console.error(`[player ${guildId}]`, err.message);
    playNext(guildId).catch((e) => console.error('[playNext]', e.message));
  });

  queues.set(guildId, q);
  return q;
}

// --- YouTube helpers --------------------------------------------------------

function runSearch(query, cookieFile) {
  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch1:${query}`,
      '--flat-playlist',
      '--no-warnings',
      '--print', '%(title)s ::: https://www.youtube.com/watch?v=%(id)s',
    ];
    if (cookieFile) args.push('--cookies', cookieFile);

    const proc = spawn('yt-dlp', args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      const line = out.trim().split('\n')[0];
      if (code !== 0 || !line) return reject(new Error(err.trim() || `no results (exit ${code})`));
      const sep = line.lastIndexOf(' ::: ');
      resolve({ title: line.slice(0, sep), url: line.slice(sep + 5) });
    });
  });
}

// Search YouTube, rotating cookies and retiring any that get bot-walled.
async function searchYouTube(query) {
  let lastErr;
  for (let i = 0; i < Math.max(1, cookies.count()); i++) {
    const cookieFile = cookies.next();
    try {
      const res = await runSearch(query, cookieFile);
      cookies.reportSuccess(cookieFile);
      stats.recordSearch();
      return res;
    } catch (e) {
      lastErr = e;
      if (cookieFile && isBotWall(e.message)) { cookies.reportFailure(cookieFile); continue; }
      break; // no cookie, or a non-wall error (e.g. genuinely no results)
    }
  }
  throw lastErr || new Error('search failed');
}

// Start streaming a URL with one cookie. Resolves with an Ogg/Opus stream ONLY
// once audio actually starts flowing (so a bot-walled cookie rejects before the
// player ever sees silence). Rejects with the yt-dlp error otherwise.
function tryStream(url, cookieFile) {
  return new Promise((resolve, reject) => {
    const ytArgs = ['-f', 'bestaudio', '-o', '-', '--no-playlist', '--quiet', '--no-warnings'];
    if (cookieFile) ytArgs.push('--cookies', cookieFile);
    ytArgs.push(url);

    const ytdlp = spawn('yt-dlp', ytArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ytdlp.stdout.pipe(ffmpeg.stdin);
    ytdlp.stdout.on('error', () => {});
    ffmpeg.stdin.on('error', () => {});

    let settled = false;
    let ytErr = '';
    ytdlp.stderr.on('data', (d) => (ytErr += d.toString()));
    ffmpeg.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[ffmpeg]', s); });

    const kill = () => { try { ytdlp.kill('SIGKILL'); } catch {} try { ffmpeg.kill('SIGKILL'); } catch {} };
    const fail = (msg) => { if (settled) return; settled = true; clearTimeout(timer); kill(); reject(new Error(msg)); };

    // Success = ffmpeg produced its first bytes (read in paused mode so nothing
    // is dropped, then unshifted back for the audio resource to consume).
    const onReadable = () => {
      if (settled) return;
      const chunk = ffmpeg.stdout.read();
      if (!chunk) return;
      settled = true;
      clearTimeout(timer);
      ffmpeg.stdout.removeListener('readable', onReadable);
      ffmpeg.stdout.unshift(chunk);
      resolve(ffmpeg.stdout);
    };
    ffmpeg.stdout.on('readable', onReadable);

    ytdlp.on('close', (code) => { if (!settled && code !== 0) fail(ytErr.trim() || `yt-dlp exit ${code}`); });
    ffmpeg.on('close', () => fail('no audio produced'));
    ytdlp.on('error', (e) => fail(`yt-dlp: ${e.message}`));
    ffmpeg.on('error', (e) => fail(`ffmpeg: ${e.message}`));
    const timer = setTimeout(() => fail('stream start timeout'), 25_000);
  });
}

// Returns a playable Ogg/Opus stream, rotating cookies on bot-walls. null = all failed.
async function createTrackStream(url) {
  let lastErr;
  for (let i = 0; i < Math.max(1, cookies.count()); i++) {
    const cookieFile = cookies.next();
    try {
      const stream = await tryStream(url, cookieFile);
      cookies.reportSuccess(cookieFile);
      return stream;
    } catch (e) {
      lastErr = e;
      const tag = cookieFile ? path.basename(cookieFile) : 'no-cookie';
      console.error('[stream]', tag, '-', e.message.split('\n')[0]);
      if (cookieFile && isBotWall(e.message)) { cookies.reportFailure(cookieFile); continue; }
      break; // no cookie, or a non-wall error specific to this video
    }
  }
  if (lastErr) console.error('[stream] giving up:', lastErr.message.split('\n')[0]);
  return null;
}

// Play the next queued track. `announce` posts a channel embed (auto-advance);
// the /play handler suppresses it and replies to the interaction instead.
async function playNext(guildId, announce = true) {
  const q = getQueue(guildId);
  const next = q.tracks.shift();
  if (!next) {
    q.playing = false;
    q.current = null;
    return false;
  }

  q.playing = true;
  q.current = next;

  const stream = await createTrackStream(next.url);
  if (!stream) {
    if (announce && q.textChannel) q.textChannel.send({ embeds: [failEmbed(next)] }).catch(() => {});
    return playNext(guildId, announce); // skip the dead track, try the next
  }

  q.player.play(createAudioResource(stream, { inputType: StreamType.OggOpus }));

  const guild = q.textChannel?.guild;
  if (guild) stats.recordPlay(guild.id, guild.name);
  if (announce && q.textChannel) q.textChannel.send({ embeds: [trackEmbed(next, '🎶 Now playing')] }).catch(() => {});
  return true;
}

// --- Embeds -----------------------------------------------------------------

function ytThumb(url) {
  const m = url.match(/[?&]v=([\w-]{11})/) || url.match(/youtu\.be\/([\w-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

function trackEmbed(track, author) {
  const e = new EmbedBuilder()
    .setColor(BRAND)
    .setAuthor({ name: author })
    .setTitle((track.title || 'Unknown').slice(0, 256))
    .setFooter({ text: 'audiomonkey' });
  if (/^https?:\/\//.test(track.url)) e.setURL(track.url);
  const thumb = ytThumb(track.url);
  if (thumb) e.setThumbnail(thumb);
  return e;
}

function failEmbed(track) {
  return new EmbedBuilder()
    .setColor(0xef4444)
    .setAuthor({ name: '⚠️ Skipped' })
    .setTitle((track.title || 'Unknown').slice(0, 256))
    .setDescription('YouTube blocked this request (no working cookies available right now).')
    .setFooter({ text: 'audiomonkey' });
}

// --- Slash commands ---------------------------------------------------------

const PUBLIC_COMMANDS = [
  {
    name: 'play',
    description: 'Search YouTube and play a song in your voice channel',
    options: [{
      name: 'query',
      description: 'Song name or YouTube URL',
      type: ApplicationCommandOptionType.String,
      required: true,
    }],
  },
  { name: 'skip', description: 'Skip the current track' },
  { name: 'stop', description: 'Stop playback and leave the voice channel' },
  { name: 'queue', description: 'Show what is playing and what is queued' },
];
const STATS_COMMAND = { name: 'stats', description: 'Show usage stats (owner only)' };

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  console.log(`Cookie pool: ${cookies.count()} file(s).`);
  try {
    await c.application.commands.set(PUBLIC_COMMANDS);
    console.log(`Registered ${PUBLIC_COMMANDS.length} global commands.`);
    if (STATS_GUILD_ID) {
      const g = await c.guilds.fetch(STATS_GUILD_ID).catch(() => null);
      if (g) {
        await g.commands.set([...PUBLIC_COMMANDS, STATS_COMMAND]);
        console.log(`Registered guild commands in "${g.name}" (incl. /stats).`);
      }
    }
  } catch (e) {
    console.error('Command registration failed:', e.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) {
    return interaction.reply({ content: 'Use me in a server.', flags: MessageFlags.Ephemeral });
  }

  const cmd = interaction.commandName;
  stats.recordCommand(cmd);

  if (cmd === 'stats') {
    if (!STATS_GUILD_ID || interaction.guildId !== STATS_GUILD_ID) {
      return interaction.reply({ content: "That command isn't available here.", flags: MessageFlags.Ephemeral });
    }
    const c = cookies.status();
    const text = `${stats.summary(client.guilds.cache.size)}\n• Cookies: **${c.available}/${c.total}** available`;
    return interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  }

  if (cmd === 'play') {
    const query = interaction.options.getString('query', true);
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '🔇 Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    let track;
    try {
      track = /^https?:\/\//.test(query)
        ? { title: query, url: query }
        : await searchYouTube(query);
    } catch (e) {
      console.error('[search]', e.message);
      return interaction.editReply('❌ Could not find anything for that.');
    }

    const q = getQueue(interaction.guild.id);
    q.textChannel = interaction.channel;
    q.tracks.push(track);

    let connection = getVoiceConnection(interaction.guild.id);
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });
      connection.on('stateChange', (o, n) => console.log(`[voice] ${o.status} -> ${n.status}`));
      connection.on('error', (e) => console.error('[voice] error:', e.message));
      connection.subscribe(q.player);
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch (e) {
        console.error('[voice] join failed:', e?.message, '| final state:', connection.state.status);
        connection.destroy();
        queues.delete(interaction.guild.id);
        return interaction.editReply('❌ Failed to join the voice channel.');
      }
    }

    if (q.playing) {
      return interaction.editReply({ embeds: [trackEmbed(track, '➕ Added to queue')] });
    }
    const ok = await playNext(interaction.guild.id, false);
    if (!ok) {
      const c = cookies.status();
      const why = c.total
        ? `all ${c.total} YouTube cookie${c.total === 1 ? '' : 's'} are cooling down`
        : 'the server has no YouTube cookies configured';
      return interaction.editReply(`❌ YouTube blocked this request (${why}). Try again shortly.`);
    }
    return interaction.editReply({ embeds: [trackEmbed(track, '🎶 Now playing')] });
  }

  if (cmd === 'skip') {
    const q = queues.get(interaction.guild.id);
    if (!q || !q.playing) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }
    q.player.stop();
    return interaction.reply('⏭️ Skipped.');
  }

  if (cmd === 'stop') {
    const q = queues.get(interaction.guild.id);
    if (q) {
      q.tracks = [];
      q.playing = false;
      q.player.stop();
    }
    getVoiceConnection(interaction.guild.id)?.destroy();
    return interaction.reply('⏹️ Stopped and left the channel.');
  }

  if (cmd === 'queue') {
    const q = queues.get(interaction.guild.id);
    if (!q || (!q.current && q.tracks.length === 0)) {
      return interaction.reply({ content: 'Queue is empty.', flags: MessageFlags.Ephemeral });
    }
    const e = new EmbedBuilder().setColor(BRAND).setTitle('🎵 Queue').setFooter({ text: 'audiomonkey' });
    if (q.current) e.setDescription(`**Now playing**\n${q.current.title}`);
    if (q.tracks.length) {
      e.addFields({
        name: 'Up next',
        value: q.tracks.map((t, i) => `\`${i + 1}.\` ${t.title}`).join('\n').slice(0, 1024),
      });
    }
    return interaction.reply({ embeds: [e] });
  }
});

// --- Lifecycle --------------------------------------------------------------

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stats.flushOnExit();
    client.destroy();
    process.exit(0);
  });
}

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN — set it in .env (see .env.example).');
  process.exit(1);
}
client.login(token);
