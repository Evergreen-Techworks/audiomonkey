'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
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
const cache = require('./cache');
const proxies = require('./proxies');

const BRAND = 0x14b8a6;
const STATS_GUILD_ID = process.env.STATS_GUILD_ID; // server where /stats is registered
const OWNER_ID = process.env.OWNER_ID;             // user allowed to run /stats
const MAX_TRIES = 4; // how many cookie/proxy combos to try before giving up

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
    player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
  };

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

function runSearch(query, cookieFile, proxy) {
  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch1:${query}`,
      '--flat-playlist',
      '--no-warnings',
      '--print', '%(title)s ::: https://www.youtube.com/watch?v=%(id)s',
    ];
    if (proxy) args.push('--proxy', proxy);
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

// Search YouTube, rotating cookies + proxies and cooling down any that get walled.
async function searchYouTube(query) {
  let lastErr;
  const tries = Math.min(MAX_TRIES, Math.max(1, cookies.count(), proxies.count()));
  for (let i = 0; i < tries; i++) {
    const cookieFile = cookies.next();
    const proxy = proxies.next();
    try {
      const res = await runSearch(query, cookieFile, proxy);
      cookies.reportSuccess(cookieFile);
      proxies.reportSuccess(proxy);
      stats.recordSearch();
      return res;
    } catch (e) {
      lastErr = e;
      if (isBotWall(e.message)) {
        if (cookieFile) cookies.reportFailure(cookieFile);
        if (proxy) proxies.reportFailure(proxy);
        continue;
      }
      break; // genuine "no results" etc.
    }
  }
  throw lastErr || new Error('search failed');
}

// Resolve with ffmpeg.stdout once it produces its first bytes (paused-mode read
// so nothing is dropped). Rejects if a source process dies first.
function firstBytes(ffmpeg, procs, getErr) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ffErr = '';
    ffmpeg.stderr.on('data', (d) => { ffErr += d.toString(); });

    const kill = () => procs.forEach((p) => { try { p.kill('SIGKILL'); } catch {} });
    const fail = (msg) => { if (settled) return; settled = true; clearTimeout(timer); kill(); reject(new Error(msg)); };

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

    procs.forEach((p) => p.on('close', (code) => {
      if (!settled && code) fail((getErr && getErr()) || ffErr.trim() || `exit ${code}`);
    }));
    ffmpeg.on('error', (e) => fail(`ffmpeg: ${e.message}`));
    const timer = setTimeout(() => fail('stream start timeout'), 25_000);
  });
}

// Download a track as an Ogg/Opus stream: yt-dlp -> ffmpeg, optionally through a
// proxy. With a sticky proxy, extraction + download share one IP (no IP-lock).
// Resolves only once audio actually flows.
function streamDownload(url, cookieFile, proxy) {
  const ytArgs = ['-f', 'bestaudio', '-o', '-', '--no-playlist', '--quiet', '--no-warnings'];
  if (proxy) ytArgs.push('--proxy', proxy);
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
  let ytErr = '';
  ytdlp.stderr.on('data', (d) => (ytErr += d.toString()));

  return firstBytes(ffmpeg, [ytdlp, ffmpeg], () => ytErr.trim());
}

// Returns { stream, id, cached } or null. Serves from cache when possible; else
// rotates cookie+proxy pairs (one proxy per attempt for extract AND download).
async function createTrackStream(url) {
  const id = cache.videoId(url);
  const hit = cache.cachedPath(id);
  if (hit) {
    console.log('[cache] hit', id);
    return { stream: fs.createReadStream(hit), id, cached: true };
  }

  let lastErr;
  const tries = Math.min(MAX_TRIES, Math.max(1, cookies.count(), proxies.count()));
  for (let i = 0; i < tries; i++) {
    const cookieFile = cookies.next();
    const proxy = proxies.next();
    const tag = `${proxy ? proxies.label(proxy) : 'no-proxy'}/${cookieFile ? path.basename(cookieFile) : 'no-cookie'}`;
    try {
      const stream = await streamDownload(url, cookieFile, proxy);
      cookies.reportSuccess(cookieFile);
      proxies.reportSuccess(proxy);
      console.log('[stream] ok via', tag);
      return { stream, id, cached: false };
    } catch (e) {
      lastErr = e;
      console.error('[stream]', tag, '-', e.message.split('\n')[0]);
      if (isBotWall(e.message) && cookieFile) cookies.reportFailure(cookieFile);
      if (proxy) proxies.reportFailure(proxy);
    }
  }
  if (lastErr) console.error('[stream] giving up:', lastErr.message.split('\n')[0]);
  return null;
}

// Play the next queued track. `announce` posts a channel embed (auto-advance).
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

  const res = await createTrackStream(next.url);
  if (!res) {
    if (announce && q.textChannel) q.textChannel.send({ embeds: [failEmbed(next)] }).catch(() => {});
    return playNext(guildId, announce);
  }

  // Fresh downloads are tee'd into the cache as they play; cache hits stream as-is.
  const playable = res.cached ? res.stream : cache.teeToCache(res.stream, res.id);
  q.player.play(createAudioResource(playable, { inputType: StreamType.OggOpus }));

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
    .setDescription('YouTube blocked this request (no working cookies/proxies available right now).')
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
  console.log(`Cookies: ${cookies.count()} | Proxies: ${proxies.count()} (${proxies.SCHEME}) | Cache: ${cache.status().count}`);
  try {
    await c.application.commands.set(PUBLIC_COMMANDS);
    // /stats is registered ONLY in the owner's server, so it never appears elsewhere.
    if (STATS_GUILD_ID) {
      const g = await c.guilds.fetch(STATS_GUILD_ID).catch(() => null);
      if (g) await g.commands.set([...PUBLIC_COMMANDS, STATS_COMMAND]);
    }
    console.log('Slash commands registered.');
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
    // Owner-only, and only in the configured server.
    const allowed = STATS_GUILD_ID
      && interaction.guildId === STATS_GUILD_ID
      && (!OWNER_ID || interaction.user.id === OWNER_ID);
    if (!allowed) {
      return interaction.reply({ content: "That command isn't available here.", flags: MessageFlags.Ephemeral });
    }
    const ck = cookies.status();
    const px = proxies.status();
    const cc = cache.status();
    const text = `${stats.summary(client.guilds.cache.size)}`
      + `\n• Cookies: **${ck.available}/${ck.total}** available`
      + `\n• Proxies: **${px.available}/${px.total}** available`
      + `\n• Cache: **${cc.count}** songs (${cc.mb} MB)`;
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
      connection.on('error', (e) => console.error('[voice] error:', e.message));
      connection.subscribe(q.player);
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch {
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
      return interaction.editReply('❌ YouTube blocked this request (all cookies/proxies are cooling down). Try again shortly.');
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
