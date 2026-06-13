# audiomonkey — Free Open-Source Discord Music Bot 🎵

[![License](https://img.shields.io/badge/license-MIT-14b8a6)](LICENSE)
[![Node](https://img.shields.io/badge/node-18%2B-0d9488?logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org)
[![Stars](https://img.shields.io/github/stars/Evergreen-Techworks/audiomonkey?style=social)](https://github.com/Evergreen-Techworks/audiomonkey/stargazers)

**audiomonkey** is a dead-simple, free, open-source **Discord music bot**. Type a song name, it searches YouTube, grabs the top result, and streams it straight into your voice channel. No queue gymnastics, no paywall, no premium tier — every line on GitHub.

> **TL;DR:** `!play <anything>` → it finds the song on YouTube and plays it. Streams audio directly via `yt-dlp` + `ffmpeg` (no files saved to disk). Self-host it on a tiny box, or invite the hosted bot in one click.

---

## ➕ Add it to your server

👉 **[Invite audiomonkey](https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=36785152&scope=bot)**

Then join a voice channel and type:

```
!play never gonna give you up
```

> Replace `YOUR_APPLICATION_ID` with the bot's Application ID (Discord Dev Portal → your app → General Information). Self-hosting? See [Self-host](#-self-host) below.

---

## 🎚️ Commands

| Command            | What it does                                   |
| ------------------ | ---------------------------------------------- |
| `!play <words>`    | Search YouTube and play the first result       |
| `!play <url>`      | Play a specific YouTube URL                    |
| `!skip`            | Skip the current track                         |
| `!stop` / `!leave` | Clear the queue and leave the channel          |
| `!queue`           | Show what's playing and what's queued          |
| `!stats`           | Usage stats — **only** in the owner's server (see below) |

---

## ✨ Features

- **Search-to-play** — no URLs needed; it finds the top YouTube match for you
- **Direct streaming** — `yt-dlp → ffmpeg → Ogg/Opus`, nothing written to disk
- **Per-server queue** — `!play` again while a track is going and it lines up
- **Private usage stats** — a gated `!stats` command, locked to one server you choose
- **Tiny footprint** — runs happily on a $4/mo AWS `t3.nano`
- **No native build step** — pure-JS Opus passthrough, so `npm install` just works

---

## 🧱 Repository layout

```
index.js              # the bot: commands, voice, yt-dlp/ffmpeg streaming
stats.js              # usage statistics with JSON-file persistence
deploy/
  setup.sh            # one-shot provisioning for a fresh Ubuntu (t3.nano) box
  audiomonkey.service # systemd unit template
.env.example          # config template (token, prefix, stats server id)
```

---

## 🚀 Self-host

### Requirements
- **Node.js** 18+
- **yt-dlp** — `yt-dlp --version`
- **ffmpeg** with libopus — `ffmpeg -encoders | grep opus`

### Steps

1. **Create the bot**
   - [Discord Developer Portal](https://discord.com/developers/applications) → *New Application*.
   - **Bot** tab → *Reset Token* → copy it.
   - On the **Bot** tab, enable **MESSAGE CONTENT INTENT** (lets it read `!play ...`).
   - To let others add it, turn on **Public Bot**.

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

## 📊 Usage stats

audiomonkey keeps lightweight counters (tracks played, searches, commands,
per-server plays, uptime) in `stats.json`. The `!stats` command prints them, but
it **only responds in the server whose ID you put in `STATS_GUILD_ID`** — and is
silently ignored everywhere else, so regular users never even see it.

```env
STATS_GUILD_ID=123456789012345678   # your "home" server's ID
```

---

## ❓ FAQ

**Does it save MP3 files?**
No — it streams audio directly, which is faster and uses no disk. (If you want
real `.mp3` files, swap `createTrackStream` for a `yt-dlp -x --audio-format mp3`
download and feed the file to `createAudioResource`.)

**Playback suddenly stopped working.**
YouTube probably changed something. Update yt-dlp: `yt-dlp -U`.

**What does it cost to run?**
Pennies. A single `t3.nano` handles a small server's listening just fine.

---

## 🤝 Contributing

PRs welcome — open an issue or ship an improvement.

---

## 📄 License

MIT. See [LICENSE](LICENSE).

---

<details>
<summary><strong>Keywords (for search indexing)</strong></summary>

discord music bot, discord bot, open source discord music bot, free discord music bot, youtube discord bot, play youtube in discord, discord.js music bot, yt-dlp discord bot, ffmpeg discord audio, discord voice bot, self-hosted discord bot, nodejs discord music bot
</details>
