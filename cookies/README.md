# Cookie pool

Drop one **Netscape-format** cookies file per YouTube account in here, named
`*.txt` (e.g. `acct-1.txt`, `acct-2.txt`). The bot rotates through them and puts
any that get bot-walled on a cooldown automatically.

**These files are account secrets — they are gitignored and never committed.**
New/removed files are picked up live (no restart needed).

## How to export a cookies file

1. In a browser **logged into the YouTube account**, install the
   *"Get cookies.txt LOCALLY"* extension.
2. Go to `youtube.com`, click the extension, **Export** → save as `something.txt`.
3. Copy it onto the server, e.g.:
   ```bash
   scp -i ~/.ssh/audiomonkey-key.pem acct-1.txt ubuntu@<server>:~/audiomonkey/cookies/
   ```

That's it — the bot starts using it on the next `/play`. Check `/stats` for how
many cookies are currently available vs cooling down.
