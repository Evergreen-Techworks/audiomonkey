'use strict';

const { spawn } = require('node:child_process');
const { Client, GatewayIntentBits, Events } = require('discord.js');
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

const PREFIX = process.env.PREFIX || '!';
// Server (guild) ID where the private `!stats` command is allowed. Leave unset
// to disable the command entirely.
const STATS_GUILD_ID = process.env.STATS_GUILD_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — enable in the Dev Portal (see README)
  ],
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

function playNext(guildId) {
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

  if (q.textChannel) {
    q.textChannel.send(`🎶 Now playing: **${next.title}**`).catch(() => {});
  }
}

// --- Commands ---------------------------------------------------------------

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const [raw, ...rest] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = raw.toLowerCase();
  const args = rest.join(' ');

  const KNOWN = ['play', 'p', 'skip', 's', 'stop', 'leave', 'queue', 'q', 'stats'];
  if (KNOWN.includes(command)) stats.recordCommand(command);

  // Private stats command — only works in the configured server, and silently
  // ignored everywhere else so regular users never see it.
  if (command === 'stats') {
    if (!STATS_GUILD_ID || message.guild.id !== STATS_GUILD_ID) return;
    return message.reply(stats.summary(client.guilds.cache.size));
  }

  if (command === 'play' || command === 'p') {
    if (!args) return message.reply('Usage: `!play <search terms or YouTube URL>`');

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('🔇 Join a voice channel first.');

    message.channel.sendTyping().catch(() => {});

    let track;
    try {
      track = /^https?:\/\//.test(args)
        ? { title: args, url: args }
        : await searchYouTube(args);
    } catch (e) {
      console.error('[search]', e.message);
      return message.reply('❌ Could not find anything for that.');
    }

    const q = getQueue(message.guild.id);
    q.textChannel = message.channel;
    q.tracks.push(track);

    let connection = getVoiceConnection(message.guild.id);
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      connection.subscribe(q.player);
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        connection.destroy();
        queues.delete(message.guild.id);
        return message.reply('❌ Failed to join the voice channel.');
      }
    }

    if (q.playing) {
      return message.reply(`➕ Queued: **${track.title}**`);
    }
    playNext(message.guild.id);
    return;
  }

  if (command === 'skip' || command === 's') {
    const q = queues.get(message.guild.id);
    if (!q || !q.playing) return message.reply('Nothing is playing.');
    q.player.stop(); // fires Idle -> playNext
    return message.reply('⏭️ Skipped.');
  }

  if (command === 'stop' || command === 'leave') {
    const q = queues.get(message.guild.id);
    if (q) {
      q.tracks = [];
      q.playing = false;
      q.player.stop();
    }
    getVoiceConnection(message.guild.id)?.destroy();
    return message.reply('⏹️ Stopped and left the channel.');
  }

  if (command === 'queue' || command === 'q') {
    const q = queues.get(message.guild.id);
    if (!q || (!q.current && q.tracks.length === 0)) return message.reply('Queue is empty.');
    const lines = [];
    if (q.current) lines.push(`▶️ **${q.current.title}**`);
    q.tracks.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
    return message.reply(lines.join('\n').slice(0, 1900));
  }
});

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
