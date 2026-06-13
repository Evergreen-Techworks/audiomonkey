'use strict';

// Cookie pool for yt-dlp. Drop one Netscape-format cookies file per YouTube
// account into ./cookies/*.txt. The bot rotates through them (round-robin),
// and when one gets bot-walled it's put on an escalating cooldown so we stop
// hammering a flagged account — then automatically retried once it cools down.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'cookies');
const BASE_COOLDOWN_MS = 10 * 60 * 1000;     // 10 min, multiplied by strike count
const MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;  // capped at 2 hours

const health = new Map(); // file -> { strikes, cooldownUntil }
let cursor = 0;

function listFiles() {
  try {
    return fs.readdirSync(DIR)
      .filter((f) => f.endsWith('.txt'))
      .sort()
      .map((f) => path.join(DIR, f));
  } catch {
    return []; // dir missing -> no cookies, run yt-dlp bare
  }
}

function count() {
  return listFiles().length;
}

// Next usable cookie file (round-robin, skipping ones on cooldown).
// Returns a path, or null when there are none / all are cooling down.
function next() {
  const files = listFiles();
  if (files.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < files.length; i++) {
    const file = files[(cursor + i) % files.length];
    const h = health.get(file);
    if (!h || h.cooldownUntil <= now) {
      cursor = (cursor + i + 1) % files.length;
      return file;
    }
  }
  return null; // everything is cooling down
}

function reportSuccess(file) {
  if (file) health.set(file, { strikes: 0, cooldownUntil: 0 });
}

function reportFailure(file) {
  if (!file) return;
  const h = health.get(file) || { strikes: 0, cooldownUntil: 0 };
  h.strikes += 1;
  h.cooldownUntil = Date.now() + Math.min(BASE_COOLDOWN_MS * h.strikes, MAX_COOLDOWN_MS);
  health.set(file, h);
  const mins = Math.round((h.cooldownUntil - Date.now()) / 60000);
  console.warn(`[cookies] ${path.basename(file)} bot-walled (strike ${h.strikes}) — cooling down ${mins}m`);
}

function status() {
  const files = listFiles();
  const now = Date.now();
  const available = files.filter((f) => {
    const h = health.get(f);
    return !h || h.cooldownUntil <= now;
  }).length;
  return { total: files.length, available };
}

module.exports = { next, count, reportSuccess, reportFailure, status, DIR };
