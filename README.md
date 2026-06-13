# audiomonkey — Free Open-Source Discord Music Bot 🎵

[![Add to Discord](https://img.shields.io/badge/add%20to%20discord-invite%20the%20bot-14b8a6?logo=discord&logoColor=white)](https://discord.com/oauth2/authorize?client_id=1102027846106480650&permissions=3165184&scope=bot%20applications.commands)
[![Discord](https://img.shields.io/badge/discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/WC4FGuZFxY)
[![License](https://img.shields.io/badge/license-MIT-14b8a6)](LICENSE)
[![Node](https://img.shields.io/badge/node-18%2B-0d9488?logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org)
[![Stars](https://img.shields.io/github/stars/Evergreen-Techworks/audiomonkey?style=social)](https://github.com/Evergreen-Techworks/audiomonkey/stargazers)

**audiomonkey** is a **free, open-source Discord music bot** that plays music from **YouTube** in your voice channel. Type `/play` and a song name — it searches YouTube, grabs the top result, and streams it straight into the call. No premium tier, no paywall, no vote-locking, no "this command is supporters-only." Just `/play` and it plays.

> **TL;DR:** A simple, self-hostable **YouTube → Discord music bot** built with `discord.js` + `yt-dlp` + `ffmpeg`. Modern **slash commands** (no privileged intents). Invite the hosted bot in one click, or run your own in minutes. 100% open source under MIT — every line on GitHub.

🔎 Want a **free Rythm / Groovy alternative** you actually control? This is it — fork it, host it, keep it running forever. Nobody can shut down a bot you run yourself.

💬 **Questions, bugs, or updates?** Join the EGTW Discord: **[discord.gg/WC4FGuZFxY](https://discord.gg/WC4FGuZFxY)**

---

## ➕ Add it to your server

👉 **[Invite audiomonkey to your Discord server](https://discord.com/oauth2/authorize?client_id=1102027846106480650&permissions=3165184&scope=bot%20applications.commands)**

Then join a voice channel and type:

```
/play query: never gonna give you up
```

> This adds the official **audiomonkey** bot — nothing to install. Want to run your own copy instead? Swap in your bot's Application ID (Dev Portal → General Information) and see [Self-host](#-self-host-your-own-discord-music-bot) below.

---

## ⭐ Why audiomonkey?

- **Actually free** — every command, forever. No premium gate, no paywalled `/skip`, no vote-to-use.
- **Modern slash commands** — type `/` and discover everything; no privileged intents, no 100-server verification wall.
- **Open source (MIT)** — read every line, fork it, self-host it, even build your own bot on top.
- **Plays from YouTube** — search by song name or paste a YouTube URL.
- **Self-hostable** — runs happily on a ~$4/mo AWS `t3.nano`; you own it, so it can't be taken down.
- **No native build pain** — pure-JS Opus passthrough, so `npm install` just works on any machine.

---

## 🎚️ Commands

| Command                  | What it does                                          |
| ------------------------ | ----------------------------------------------------- |
| `/play query:<words>`    | Search YouTube and play the first result              |
| `/play query:<url>`      | Play a specific YouTube URL                           |
| `/skip`                  | Skip the current track                                |
| `/stop`                  | Stop playback and leave the channel                   |
| `/queue`                 | Show what's playing and what's queued                 |
| `/stats`                 | Usage stats — **only** in the owner's server (private) |

---

## ✨ Features

- **Search-to-play** — no URLs needed; it finds the top YouTube match for you
- **Now-playing controls** — Skip / Stop / Queue buttons right under the embed
- **Direct audio streaming** — `yt-dlp → ffmpeg → Ogg/Opus`, nothing written to disk
- **Per-server music queue** — `/play` again while a track is going and it lines up
- **Private usage stats** — a gated `/stats` command, registered only in one server you choose
- **Tiny footprint** — sips RAM; runs on the smallest cloud box you can rent
- **Zero paywalls** — it's a hobby bot, not a freemium funnel

---

## 🧱 Repository layout

```
index.js              # the bot: slash commands, voice, yt-dlp/ffmpeg streaming
stats.js              # usage statistics with JSON-file persistence
deploy/
  setup.sh            # one-shot provisioning for a fresh Ubuntu (t3.nano) box
  audiomonkey.service # systemd unit template
.env.example          # config template (token, stats server id)
```

---

## 🚀 Self-host your own Discord music bot

### Requirements
- **Node.js** 18+
- **yt-dlp** — `yt-dlp --version`
- **ffmpeg** with libopus — `ffmpeg -encoders | grep opus`

### Steps

1. **Create the bot**
   - [Discord Developer Portal](https://discord.com/developers/applications) → *New Application*.
   - **Bot** tab → *Reset Token* → copy it.
   - Turn on **Public Bot** so others can add it.
   - No privileged intents needed — slash commands don't require Message Content. 🎉

2. **Clone + configure**
   ```bash
   git clone https://github.com/Evergreen-Techworks/audiomonkey.git
   cd audiomonkey
   npm install
   cp .env.example .env       # paste your DISCORD_TOKEN
   ```

3. **Run**
   ```bash
   npm start
   ```
   The bot registers its slash commands on startup. Invite your copy with the
   **`bot` + `applications.commands`** scopes so `/play` shows up. Global commands
   can take a little while to appear; commands in your `STATS_GUILD_ID` server
   register instantly.

---

## ☁️ Deploy to AWS (t3.nano)

The repo ships a provisioning script that installs Node, ffmpeg, yt-dlp, adds
swap (the nano only has 512 MB RAM), and registers a `systemd` service.

```bash
# on a fresh Ubuntu 22.04/24.04 instance, after cloning the repo:
bash deploy/setup.sh

# then add your token and start it:
cp .env.example .env && nano .env
sudo systemctl enable --now audiomonkey
journalctl -u audiomonkey -f      # tail the logs
```

To update later: `git pull && npm install --omit=dev && sudo systemctl restart audiomonkey`.

---

## 🍪 YouTube access (cookies)

YouTube blocks requests from datacenter/cloud IPs with a "Sign in to confirm
you're not a bot" wall. audiomonkey gets around it with a **pool of YouTube
account cookies**: drop one Netscape-format cookies file per account in
[`cookies/`](./cookies) (`*.txt`). The bot rotates through them and automatically
puts any that get bot-walled on a cooldown, retrying them once they recover.

- No cookies configured → it runs bare (fine from a home IP, usually blocked on cloud).
- See [`cookies/README.md`](./cookies/README.md) for how to export a cookies file.
- `/stats` shows how many cookies are available vs. cooling down.

> Cookie files are account secrets — they're gitignored and never committed.

**Proxy + cache.** Set `PROXY` in `.env` (see `.env.example`) to route the
bot-walled *extraction* through a proxy. Played songs are cached to `cache/`
(gitignored) and replayed straight from disk — no re-download, no proxy traffic.

---

## 📊 Usage stats

audiomonkey keeps lightweight counters (tracks played, searches, commands,
per-server plays, uptime) in `stats.json`. The `/stats` command is **private**:
it's registered *only* in your `STATS_GUILD_ID` server (so it never appears
anywhere else) and only runs for `OWNER_ID` (so only you can use it).

```env
STATS_GUILD_ID=123456789012345678   # your "home" server's ID
OWNER_ID=123456789012345678         # your Discord user ID
```

---

## ❓ FAQ — Discord music bot questions

**Is there a free Discord music bot?**
Yes. audiomonkey is 100% free and open source — every feature, no premium tier, no paywall, no donation wall on `/play`.

**How do I add a music bot to my Discord server?**
Click the [invite link](#-add-it-to-your-server) above, pick your server, authorize it, then join a voice channel and type `/play`. You need *Manage Server* permission to add bots.

**What's the best open-source Discord music bot?**
"Best" depends on what you want — audiomonkey is built for simplicity: search YouTube, play the top result, done. The whole thing is a couple of small files you can read in five minutes and host yourself.

**Is this a Rythm or Groovy alternative?**
Yes. After the big public music bots got shut down, the reliable move is to host your own. audiomonkey is a free, self-hostable replacement that plays music from YouTube — and because *you* run it, it can't be taken offline.

**Can I self-host my own Discord music bot?**
That's the whole point. Clone the repo, drop in your bot token, `npm start`. It runs on anything from a Raspberry Pi to a $4/mo cloud VM. See [Self-host](#-self-host-your-own-discord-music-bot).

**Does it require a premium subscription, voting, or donations?**
No. There's nothing to buy and nothing to vote for. It's open source under MIT.

**How does it play YouTube audio in Discord?**
It uses `yt-dlp` to find and pull the audio and `ffmpeg` to transcode it to Opus, then streams it into the voice channel via `@discordjs/voice`. No files are saved to disk.

**Does it save MP3 files?**
No — it streams audio directly, which is faster and uses no disk. (If you want real `.mp3` files, swap `createTrackStream` for a `yt-dlp -x --audio-format mp3` download and feed the file to `createAudioResource`.)

**Playback suddenly stopped working.**
YouTube probably changed something. Update yt-dlp: `yt-dlp -U`.

**What does it cost to run?**
Pennies. A single `t3.nano` handles a small server's listening just fine.

---

## 🤝 Contributing

PRs welcome — open an issue, ship an improvement, or hop into the [EGTW Discord](https://discord.gg/WC4FGuZFxY) to chat. It's a small codebase; jump in.

---

## 📄 License

MIT. See [LICENSE](LICENSE). Fork it, host it, build on it.

---

<details>
<summary><strong>Keywords (for search indexing)</strong></summary>

discord music bot, free discord music bot, open source discord music bot, best free discord music bot, discord music bot github, self hosted discord music bot, self host discord music bot, youtube music bot discord, play youtube in discord, discord bot that plays music, discord.js music bot, nodejs discord music bot, yt-dlp discord bot, ffmpeg discord audio, discord voice bot, discord music bot 2026, slash command music bot, rythm alternative, groovy alternative, rythm discord bot alternative, groovy discord bot alternative, free music bot for discord, music bot for discord server, how to add a music bot to discord, how to make a discord music bot, discord music player, mee6 music alternative
</details>
