#!/usr/bin/env bash
#
# One-shot provisioning for audiomonkey on a fresh Ubuntu instance
# (built for a t3.nano / t2.nano — 512 MB RAM, so it also adds swap).
#
# Usage, on the instance, from the repo root:
#   bash deploy/setup.sh
# Then create .env with your DISCORD_TOKEN and start the service (printed at end).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="$(id -un)"

# Create swap FIRST — a t3.nano has only 512 MB RAM, and installing Node or
# running npm without swap gets the process OOM-killed mid-unpack.
echo "==> Ensuring 1 GB swap (before anything memory-hungry)"
if ! sudo swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null 2>&1 || true
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Installing system packages (ffmpeg, git, curl)"
sudo apt-get update -y
sudo apt-get install -y ffmpeg git curl ca-certificates

echo "==> Installing Node.js 20 LTS"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Installing yt-dlp (self-updating standalone binary)"
sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

echo "==> Installing app dependencies"
cd "$REPO_DIR"
npm install --omit=dev

echo "==> Installing systemd service"
sudo sed -e "s#__USER__#${RUN_USER}#g" -e "s#__DIR__#${REPO_DIR}#g" \
  "$REPO_DIR/deploy/audiomonkey.service" | sudo tee /etc/systemd/system/audiomonkey.service >/dev/null
sudo systemctl daemon-reload

cat <<EOF

✅ Setup complete.

Next:
  1. Create your env file:
       cp $REPO_DIR/.env.example $REPO_DIR/.env
       nano $REPO_DIR/.env      # paste DISCORD_TOKEN (and STATS_GUILD_ID)
  2. Start the bot:
       sudo systemctl enable --now audiomonkey
  3. Watch logs:
       journalctl -u audiomonkey -f
EOF
