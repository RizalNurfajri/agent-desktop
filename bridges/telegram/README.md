# agent-desktop Telegram bridge

A single-file Node.js bridge (zero npm dependencies, Node >= 20.12) that lets whitelisted
Telegram users run the local [agent-desktop](https://github.com/vercel-labs/agent-desktop)
CLI from chat. A message like `snapshot --app brave -i --compact` is spawned as
`agent-desktop snapshot --app brave -i --compact` (no shell), and the JSON envelope is
returned to the chat. Long results arrive as a `result.json` document; a `screenshot`
that saved a file (`data.path`) arrives as a photo.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Install the CLI once: `npm install -g agent-desktop` (or pass `--bin <path>` to any
   agent-desktop executable). On Windows the bridge spawns the platform `.exe` directly,
   so PowerShell execution policy does not matter.
3. Find your numeric Telegram user id: start the bridge with a placeholder allowlist,
   send `/id` to your bot, and read the reply. `/id` is the only command open to anyone;
   it reveals only the sender's own id.

   ```powershell
   node bridges/telegram/bridge.mjs --token <BOT_TOKEN> --allow 0
   ```

4. Restart with your real id (repeat `--allow` for more users):

   PowerShell:

   ```powershell
   node bridges/telegram/bridge.mjs --token <BOT_TOKEN> --allow <YOUR_ID>
   ```

   bash:

   ```bash
   node bridges/telegram/bridge.mjs --token "$BOT_TOKEN" --allow "$YOUR_ID"
   ```

Environment fallbacks (flags win): `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_ALLOWED_USER_IDS` (comma or space separated), `AGENT_DESKTOP_BIN`.

### .env style

Instead of flags or exported variables, put the config in a `.env` file — either in the
directory you run from or next to `bridge.mjs` (`bridges/telegram/.env`):

```dotenv
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
TELEGRAM_ALLOWED_USER_IDS=123456789
# optional: AGENT_DESKTOP_BIN=C:\path\to\agent-desktop.exe
```

Then just run:

```powershell
node bridges/telegram/bridge.mjs
```

The bridge loads it natively via `process.loadEnvFile` (no dotenv dependency).
Precedence: flags > real environment variables > `.env`. Keep `.env` out of git —
`bridges/telegram/.gitignore` already excludes it.

Without `--bin`/env the bridge resolves the npm global install for this platform/arch
(`%APPDATA%\npm\node_modules` on Windows, `npm root -g` or standard prefixes on Unix).
Startup fails with exit code 2 if the token is missing, the allowlist is empty, or the
binary cannot be found. There is no open mode.

## Whitelist semantics

- `/id`: replies with the sender's numeric id, for anyone (setup aid).
- `/start`, `/help`: short usage, whitelisted users only.
- Any other text: if the sender's numeric id is not in the allowlist, the message is
  dropped silently (a stderr note records the id, never the message). No reply, no
  execution. The check happens before any parsing or spawning.
- Whitelisted text is tokenized with quote awareness (single and double quotes,
  backslash escapes inside double quotes) and spawned as
  `agent-desktop <subcommand> [args...]` with `shell: false`. Unbalanced quotes get an
  error reply and never spawn. Commands are killed after 120 seconds. Updates are
  processed sequentially; desktop automation is serial.

## Security notes

- Keep the bot token secret. It is read from flags/env, never logged, and any error
  text that could contain it is redacted to `[REDACTED]` before it reaches stderr or a
  chat reply. Anyone with the token can read and send messages as the bot.
- The whitelist is the only access boundary. Anyone you allow can run any agent-desktop
  subcommand, including destructive desktop actions. Allow only ids you trust.
- Commands run with the bridge process's OS permissions: same user, same desktop
  session, same accessibility rights. Run the bridge as a dedicated low-privilege user
  if that matters to you.
- No shell is ever involved in command execution; arguments are passed as an argv
  array, so message text cannot inject shell syntax.

## Tests

```bash
node --test bridges/telegram/test/
```

The suite uses injected fake fetch/spawn implementations: no network, no real binary.
