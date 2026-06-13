'use strict';

// Lightweight usage statistics with JSON-file persistence.
// Counts survive restarts (handy when running as a long-lived service).

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'stats.json');

const data = {
  since: Date.now(),     // first time the bot was ever started (persisted)
  totalCommands: 0,
  totalPlays: 0,         // tracks actually started playing
  totalSearches: 0,      // YouTube searches performed
  commands: {},          // { play: 12, skip: 3, ... }
  perGuild: {},          // { guildId: { name, plays } }
};

const bootedAt = Date.now(); // this process's start (in-memory only) -> uptime

// --- load persisted state ---------------------------------------------------
try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  Object.assign(data, saved);
  data.commands = saved.commands || {};
  data.perGuild = saved.perGuild || {};
} catch {
  /* no stats file yet — start fresh */
}

// --- debounced persistence --------------------------------------------------
let dirty = false;
function save() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[stats] failed to save:', e.message);
  }
}
const flushTimer = setInterval(save, 15_000);
flushTimer.unref?.();

// --- recording --------------------------------------------------------------
function recordCommand(name) {
  data.totalCommands++;
  data.commands[name] = (data.commands[name] || 0) + 1;
  dirty = true;
}

function recordSearch() {
  data.totalSearches++;
  dirty = true;
}

function recordPlay(guildId, guildName) {
  data.totalPlays++;
  const g = (data.perGuild[guildId] ||= { name: guildName, plays: 0 });
  g.name = guildName; // keep latest known name
  g.plays++;
  dirty = true;
}

// --- reporting --------------------------------------------------------------
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s % 60}s`);
  return parts.join(' ');
}

// Returns a formatted, multi-line summary string. `liveGuildCount` is the
// number of servers the bot is currently in (from the client cache).
function summary(liveGuildCount) {
  const topGuilds = Object.values(data.perGuild)
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 5)
    .map((g, i) => `  ${i + 1}. ${g.name || 'unknown'} — ${g.plays} plays`)
    .join('\n');

  const cmdBreakdown = Object.entries(data.commands)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  return [
    '📊 **audiomonkey usage stats**',
    `• Servers (now): **${liveGuildCount}**`,
    `• Tracks played: **${data.totalPlays}**`,
    `• Searches: **${data.totalSearches}**`,
    `• Commands run: **${data.totalCommands}**${cmdBreakdown ? ` (${cmdBreakdown})` : ''}`,
    `• Uptime: **${fmtDuration(Date.now() - bootedAt)}**`,
    `• Tracking since: **${new Date(data.since).toISOString().slice(0, 10)}**`,
    topGuilds ? `\n**Top servers by plays:**\n${topGuilds}` : '',
  ].filter(Boolean).join('\n');
}

// Flush on shutdown so we don't lose the last few counts.
function flushOnExit() {
  dirty = true;
  save();
}

module.exports = {
  recordCommand,
  recordSearch,
  recordPlay,
  summary,
  flushOnExit,
};
