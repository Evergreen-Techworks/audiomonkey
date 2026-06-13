'use strict';

// Pool of sticky residential proxy sessions for yt-dlp. One `host:port:user:pass`
// (or full URL) per line in ./proxies.txt. Each line is a distinct sticky
// session, so within one song we use ONE proxy for both extraction and download
// (same exit IP -> no IP-locked 403). Failing sessions get an escalating
// cooldown and are auto-retried, just like the cookie pool.

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'proxies.txt');
// http (default) or socks5h — set PROXY_SCHEME in .env if your endpoint is SOCKS.
const SCHEME = (process.env.PROXY_SCHEME || 'http').trim();
const BASE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

const health = new Map();
let cursor = 0;

function toUrl(raw) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  if (/^[a-z0-9]+:\/\//i.test(line)) return line; // already a full URL
  const parts = line.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `${SCHEME}://${user}:${pass}@${host}:${port}`;
  }
  if (parts.length === 2) return `${SCHEME}://${parts[0]}:${parts[1]}`;
  return null;
}

function list() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').map(toUrl).filter(Boolean);
  } catch {
    return [];
  }
}

function count() {
  return list().length;
}

// A short, non-secret tag for logs (host + last 4 of session id) — never the password.
function label(url) {
  const host = (url.match(/@([^:/]+)/) || [])[1] || 'proxy';
  const sid = (url.match(/sid-(\w+)/) || [])[1];
  return sid ? `${host}#${sid.slice(-4)}` : host;
}

// Next usable proxy URL (round-robin, skipping cooled-down). Falls back to the
// single PROXY env var if the pool file is empty; null if nothing is available.
function next() {
  const urls = list();
  if (urls.length === 0) return process.env.PROXY || null;
  const now = Date.now();
  for (let i = 0; i < urls.length; i++) {
    const u = urls[(cursor + i) % urls.length];
    const h = health.get(u);
    if (!h || h.cooldownUntil <= now) {
      cursor = (cursor + i + 1) % urls.length;
      return u;
    }
  }
  return null;
}

function reportSuccess(url) {
  if (url) health.set(url, { strikes: 0, cooldownUntil: 0 });
}

function reportFailure(url) {
  if (!url) return;
  const h = health.get(url) || { strikes: 0, cooldownUntil: 0 };
  h.strikes += 1;
  h.cooldownUntil = Date.now() + Math.min(BASE_COOLDOWN_MS * h.strikes, MAX_COOLDOWN_MS);
  health.set(url, h);
  console.warn(`[proxy] ${label(url)} failed (strike ${h.strikes}) — cooling down`);
}

function status() {
  const urls = list();
  const now = Date.now();
  const available = urls.filter((u) => {
    const h = health.get(u);
    return !h || h.cooldownUntil <= now;
  }).length;
  return { total: urls.length, available };
}

module.exports = { next, count, label, reportSuccess, reportFailure, status, SCHEME, FILE };
