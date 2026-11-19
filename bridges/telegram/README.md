# agent-desktop Telegram bridge

A zero-dependency Node.js bridge (Node >= 20.12) that lets whitelisted Telegram
users drive the local [agent-desktop](https://github.com/vercel-labs/agent-desktop)
CLI from chat. In raw mode a message like `snapshot --app brave -i --compact` is
spawned as `agent-desktop snapshot --app brave -i --compact` (no shell), and the
JSON envelope is returned to the chat. Long results arrive as a `result.json`
document; a `screenshot` that saved a file (`data.path`) arrives as a photo. With
an OpenAI-compatible endpoint configured, [agent mode](#agent-mode) lets users
send natural language instead and the model drives the CLI via tool calling.

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

## Agent mode

Set all three LLM values (base URL, API key, model) and the bot becomes the agent:
whitelisted users send natural language ("buka youtube di brave, pause videonya"), the
model reasons about it and drives agent-desktop through tool calling, then replies in
chat. You can set them at startup (flags/env/`.env`, below) or later from chat (see
[Configure from chat](#configure-from-chat)). With none of the three set, the bridge
stays in raw CLI mode exactly as before. Setting some but not all three at startup fails
with exit code 2 and a message naming what is missing; chat config is incremental by
design.

```dotenv
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
TELEGRAM_ALLOWED_USER_IDS=123456789
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-your-key
LLM_MODEL=gpt-4o-mini
```

`LLM_BASE_URL` is an OpenAI-compatible API base and includes the `/v1` segment; the bridge
calls `{base}/chat/completions` and `{base}/models`. It works with OpenAI, OpenRouter
(`https://openrouter.ai/api/v1`), or any local server or router that speaks the same API
(`http://localhost:1234/v1`). A trailing `/` is stripped. The flags `--base-url`,
`--api-key`, `--model` override the matching env vars; precedence is flags > env > `.env`.

The system prompt is built once at startup from the binary's own bundled skills
(`agent-desktop skills get desktop` and `skills get platform`), the same knowledge the
official `npx skills add` flow installs, plus a short bridge addendum (reply in the user's
language, refs are snapshot-scoped, Chromium trees need `--timeout-ms 15000-25000`). If a
skill cannot be loaded the bridge logs a warning and uses a built-in fallback prompt.

Chat commands (whitelisted only):

- `/setbase <url>`: set the LLM base URL at runtime (trailing `/` stripped).
- `/setkey <key>`: set the LLM API key at runtime; your message is auto-deleted.
- `/model <id>`: set the runtime model. `/model` with no argument shows the current one.
- `/models`: list model ids from `{base}/models` using the current base URL and key
  (first 50, with a note if there are more).
- `/config`: show the runtime base URL, masked key, model, and whether agent mode is active.
- `/reset`: clear this chat's conversation history.
- `!<command>`: escape hatch that runs a raw agent-desktop CLI command, e.g.
  `!snapshot --app brave -i --compact`.
- Any other text goes to the model when agent mode is active, otherwise it runs as a raw
  CLI command.

The model drives the desktop through one tool, `agent_desktop`, whose `args` are argv
tokens for the CLI (spawned with `shell: false`, 120 s timeout). Each tool result is fed
back to the model, truncated to 12000 chars; a `screenshot` that saved a file is also sent
to chat as a photo. The loop runs at most 12 tool rounds, then asks the model for a final
answer without tools. Per-chat history is capped at 20 messages (whole tool-call groups
are dropped together, never an orphan tool result). Any API or network error is redacted
and reported to chat without stopping the bridge. With no LLM configured at all,
`/models`, `/model`, and `/reset` reply that agent mode is not configured.

### Configure from chat

The operator can set the LLM without restarting, by chatting with the bot (whitelisted
users only). The runtime config seeds from whatever startup config exists, and each
command fills in a piece:

```text
/setbase https://openrouter.ai/api/v1
/setkey sk-or-your-key
/models
/model openai/gpt-4o-mini
```

Agent mode activates lazily the moment all three values are present (any mix of startup
and chat). Until then the bridge stays in raw mode and each confirmation names what is
still missing. Changing a value while the agent is running updates it in place, so
per-chat history survives: a `/setbase` mid-conversation keeps the prior turns. `/models`
always uses the current runtime base URL and key, so you can list models right after
`/setkey` and pick one with `/model`. `/config` shows the current state with the key
masked (first 3 + `...` + last 4 characters); it never echoes the full key or the bot
token.

Security: after `/setkey` is consumed the bridge best-effort deletes your message via
`deleteMessage` so the key does not linger in chat history (a failed delete is logged,
redacted, and ignored); any later message containing the current key is deleted the same
way. The chat-set key is redacted from logs, replies, and error messages just like the
startup key, and confirmations never repeat the secret.

Chat config is runtime-only: nothing is written to disk, and it is lost when the bridge
restarts. Use flags/env/`.env` (above) to persist a configuration across restarts.

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
- In agent mode, whitelisted natural language goes to the model instead; a leading `!`
  forces the raw CLI path above. The whitelist gate runs first in both modes, so a
  non-whitelisted sender never reaches the model or the binary.

## Security notes

- Keep the bot token secret. It is read from flags/env, never logged, and any error
  text that could contain it is redacted to `[REDACTED]` before it reaches stderr or a
  chat reply. Anyone with the token can read and send messages as the bot. The LLM API
  key is redacted the same way from logs, replies, and tool results.
- In agent mode your messages and desktop observations (snapshots, screenshots, command
  output) are sent to the configured LLM endpoint. Point it at a provider you trust.
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

The directory's `test/package.json` main runs `test/index.mjs`, which registers both
suites (`bridge.test.mjs` for raw mode and config parsing, `agent.test.mjs` for the agent
loop and chat configuration) in one run. The suites use injected fake fetch/spawn
implementations: no network, no real binary.

The two CLI contract tests spawn `bridge.mjs` as a child process. Run the suite from a
checkout without a `.env` beside `bridge.mjs`: a live `.env` holding a complete bot token
is loaded by that child, which then starts polling and hangs the "no token exits 2" test.
`.env` is gitignored, so a fresh clone is already clean.
