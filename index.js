'use strict';

const { spawn } = require('node:child_process');
const {
  Client,
  GatewayIntentBits,
  Events,
  ApplicationCommandOptionType,
  MessageFlags,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const stats = require('./stats');

// Server (guild) ID where the private /stats command is registered + allowed.
// Leave unset to disable it entirely.
const STATS_GUILD_ID = process.env.STATS_GUILD_ID;

// Slash commands need no privileged intents — just guild + voice state.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// --- Per-guild music state --------------------------------------------------

const queues = new Map();

function getQueue(guildId) {
  let q = queues.get(guildId);
  if (q) return q;

  q = {
    tracks: [],      // upcoming { title, url }
    current: null,   // the track currently playing
    playing: false,
    textChannel: null,
    player: createAudioPlayer(),
  };

  q.player.on(AudioPlayerStatus.Idle, () => {
    q.current = null;
    playNext(guildId);
  });
  q.player.on('error', (err) => {
    console.error(`[player ${guildId}]`, err.message);
    q.current = null;
    playNext(guildId);
  });

  queues.set(guildId, q);
  return q;
}

// --- YouTube helpers --------------------------------------------------------

// Search YouTube and return the first result as { title, url }.
function searchYouTube(query) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      `ytsearch1:${query}`,
      '--flat-playlist',
      '--no-warnings',
      '--print', '%(title)s ::: https://www.youtube.com/watch?v=%(id)s',
    ]);

    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      const line = out.trim().split('\n')[0];
      if (code !== 0 || !line) {
        return reject(new Error(err.trim() || `no results (yt-dlp exit ${code})`));
      }
      const sep = line.lastIndexOf(' ::: ');
      stats.recordSearch();
      resolve({ title: line.slice(0, sep), url: line.slice(sep + 5) });
    });
  });
}

// Stream a YouTube URL's audio as an Ogg/Opus stream: yt-dlp -> ffmpeg.
function createTrackStream(url) {
  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio',
    '-o', '-',          // write media to stdout
    '--no-playlist',
    '--quiet',
    '--no-warnings',
    url,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-vn',              // drop any video stream
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-f', 'ogg',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });

  ytdlp.stdout.pipe(ffmpeg.stdin);
  // A consumer that stops early (skip/stop) closes the pipe; swallow EPIPE.
  ytdlp.stdout.on('error', () => {});
  ffmpeg.stdin.on('error', () => {});

  return ffmpeg.stdout;
}

// Play the next queued track. `announce` controls the channel "Now playing"
// message — the /play handler suppresses it (it replies to the interaction
// instead), while auto-advance between tracks announces.
function playNext(guildId, announce = true) {
  const q = getQueue(guildId);
  const next = q.tracks.shift();
  if (!next) {
    q.playing = false;
    return;
  }

  q.playing = true;
  q.current = next;

  const resource = createAudioResource(createTrackStream(next.url), {
    inputType: StreamType.OggOpus,
  });
  q.player.play(resource);

  const guild = q.textChannel?.guild;
  if (guild) stats.recordPlay(guild.id, guild.name);

  if (announce && q.textChannel) {
    q.textChannel.send(`🎶 Now playing: **${next.title}**`).catch(() => {});
  }
}

// --- Slash command definitions ---------------------------------------------

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
  try {
    // Global commands (every server; can take a little while to propagate).
    await c.application.commands.set(PUBLIC_COMMANDS);
    console.log(`Registered ${PUBLIC_COMMANDS.length} global commands.`);

    // Owner server: register instantly + add the private /stats command.
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

// --- Interaction handling ---------------------------------------------------

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
    return interaction.reply({ content: stats.summary(client.guilds.cache.size), flags: MessageFlags.Ephemeral });
  }

  if (cmd === 'play') {
    const query = interaction.options.getString('query', true);
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '🔇 Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply(); // search + connect can take >3s

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
      return interaction.editReply(`➕ Queued: **${track.title}**`);
    }
    playNext(interaction.guild.id, false);
    return interaction.editReply(`🎶 Now playing: **${track.title}**`);
  }

  if (cmd === 'skip') {
    const q = queues.get(interaction.guild.id);
    if (!q || !q.playing) {
      return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
    }
    q.player.stop(); // fires Idle -> playNext
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
    const lines = [];
    if (q.current) lines.push(`▶️ **${q.current.title}**`);
    q.tracks.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
    return interaction.reply(lines.join('\n').slice(0, 1900));
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
