#!/usr/bin/env node
// Telegram bridge for the agent-desktop CLI. Zero dependencies, Node >= 20.
// Whitelisted Telegram users send a command line; the bridge spawns the local
// agent-desktop binary (never a shell) and returns the JSON envelope to chat.

import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API_ROOT = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_S = 25;
const FETCH_TIMEOUT_MS = 35000;
const RETRY_DELAY_MS = 3000;
const COMMAND_TIMEOUT_MS = 120000;
const TEXT_LIMIT = 3900;

const USAGE = `agent-desktop Telegram bridge

Usage: node bridge.mjs --token <bot-token> --allow <numeric-user-id> [--allow <id> ...] [--bin <path>]

Options:
  --token <token>  Telegram bot token (env: TELEGRAM_BOT_TOKEN)
  --allow <id>     Whitelisted numeric Telegram user id, repeatable
                   (env: TELEGRAM_ALLOWED_USER_IDS, comma or space separated)
  --bin <path>     agent-desktop binary (env: AGENT_DESKTOP_BIN;
                   default: the npm global install for this platform/arch)
  --help           Show this help

Config can also live in a .env file (current directory or next to bridge.mjs):
  TELEGRAM_BOT_TOKEN=...  TELEGRAM_ALLOWED_USER_IDS=...  AGENT_DESKTOP_BIN=...
Flags win over environment variables, which win over .env values.

Chat commands:
  /id              Reply with your numeric Telegram user id (open to anyone)
  /start, /help    Short usage (whitelisted users only)
  anything else    Runs as: agent-desktop <subcommand> [args...] (whitelisted only)

There is no open mode: a token and at least one allowed id are required.
`;

const CHAT_HELP = 'Send an agent-desktop command, e.g. snapshot --app brave -i --compact\n/id shows your numeric user id.';

export function loadEnvFiles(paths) {
  for (const path of paths) {
    try { process.loadEnvFile(path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

export function parseConfig(argv, env = process.env) {
  const flags = { allow: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--token' || arg === '--allow' || arg === '--bin') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      if (arg === '--allow') flags.allow.push(value);
      else flags[arg.slice(2)] = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (flags.help) return { help: true };
  const token = flags.token ?? (env.TELEGRAM_BOT_TOKEN || undefined);
  if (!token) throw new Error('missing bot token: pass --token or set TELEGRAM_BOT_TOKEN');
  const ids = flags.allow.length > 0
    ? flags.allow
    : (env.TELEGRAM_ALLOWED_USER_IDS || '').split(/[,\s]+/).filter(Boolean);
  const allow = new Set();
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error(`invalid Telegram user id: ${id} (numeric ids only)`);
    allow.add(Number(id));
  }
  if (allow.size === 0) throw new Error('empty allowlist: pass --allow <id> or set TELEGRAM_ALLOWED_USER_IDS');
  return { help: false, token, allow, bin: flags.bin ?? (env.AGENT_DESKTOP_BIN || undefined) };
}

// Mirrors the npm wrapper's lib/platform.js: agent-desktop-<platform>-<arch>[.exe]
// under agent-desktop/bin/ in the global node_modules tree.
export function resolveBinary(explicit, env = process.env, platform = process.platform, arch = process.arch) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`agent-desktop binary not found: ${explicit}`);
    return explicit;
  }
  const roots = [];
  if (platform === 'win32') {
    if (env.APPDATA) roots.push(join(env.APPDATA, 'npm', 'node_modules'));
  } else {
    try {
      roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim());
    } catch { /* npm absent: fall back to standard prefixes */ }
    roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  }
  const name = `agent-desktop-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
  for (const root of roots) {
    const candidate = join(root, 'agent-desktop', 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('could not locate the agent-desktop binary; pass --bin <path> or set AGENT_DESKTOP_BIN');
}

export function tokenize(text) {
  const tokens = [];
  let current = '';
  let started = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '\\' && i + 1 < text.length) current += text[++i];
      else if (ch === '"') quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new Error('unbalanced quotes in command');
  if (started) tokens.push(current);
  return tokens;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function runCommand(spawnImpl, bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnImpl(bin, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...extra });
    };
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ error: err }));
    child.on('close', (code) => finish({ code }));
  });
}

export function createBridge({
  token,
  allow,
  bin,
  fetchImpl = fetch,
  spawnImpl = nodeSpawn,
  sleep = defaultSleep,
  log = (line) => process.stderr.write(`${line}\n`),
  signal = new AbortController().signal,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
}) {
  if (!token || typeof token !== 'string') throw new Error('token is required');
  const allowSet = allow instanceof Set ? allow : new Set(allow ?? []);
  if (allowSet.size === 0) throw new Error('allowlist is empty; there is no open mode');
  if (!bin) throw new Error('bin is required');

  const redact = (value) => String(value).split(token).join('[REDACTED]');
  const errText = (err) => redact([err?.message, err?.cause?.message].filter(Boolean).join(': ') || String(err));

  async function call(method, payload, form = false) {
    const init = { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) };
    if (form) init.body = payload;
    else {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(payload);
    }
    const res = await fetchImpl(`${API_ROOT}${token}/${method}`, init);
    const data = await res.json();
    if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description ?? 'unknown error'}`);
    return data.result;
  }

  async function sendText(chatId, text) {
    try {
      await call('sendMessage', { chat_id: chatId, text: redact(text) });
    } catch (err) {
      log(`sendMessage failed: ${errText(err)}`);
    }
  }

  async function sendFile(method, chatId, blob, filename, field) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(field, blob, filename);
    try {
      await call(method, form, true);
    } catch (err) {
      log(`${method} failed: ${errText(err)}`);
    }
  }

  async function sendResult(chatId, command, result) {
    let envelope;
    try { envelope = JSON.parse(result.stdout); } catch { /* unparseable: raw text below */ }
    if (command === 'screenshot' && envelope?.ok === true && typeof envelope?.data?.path === 'string') {
      try {
        const bytes = readFileSync(envelope.data.path);
        await sendFile('sendPhoto', chatId, new Blob([bytes]), basename(envelope.data.path), 'photo');
        return;
      } catch (err) {
        log(`screenshot reply failed: ${errText(err)}`);
      }
    }
    if (result.stdout.length > TEXT_LIMIT) {
      const blob = new Blob([redact(result.stdout)], { type: 'application/json' });
      await sendFile('sendDocument', chatId, blob, 'result.json', 'document');
      return;
    }
    if (result.stdout.length > 0) {
      await sendText(chatId, result.stdout);
      return;
    }
    const note = result.timedOut
      ? `command timed out after ${commandTimeoutMs}ms`
      : result.error ? `spawn failed: ${errText(result.error)}` : 'command produced no output';
    const excerpt = result.stderr.slice(0, TEXT_LIMIT);
    await sendText(chatId, excerpt ? `${note}\n${excerpt}` : note);
  }

  async function handleMessage(message) {
    if (!message?.from || !message.chat || typeof message.text !== 'string') return;
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text.trim();
    if (text === '/id') {
      await sendText(chatId, String(userId));
      return;
    }
    if (!allowSet.has(userId)) {
      log(`dropped message from non-whitelisted user ${userId}`);
      return;
    }
    if (text === '/start' || text === '/help' || text === '') {
      await sendText(chatId, CHAT_HELP);
      return;
    }
    let args;
    try {
      args = tokenize(text);
    } catch (err) {
      await sendText(chatId, `Could not parse command: ${err.message}`);
      return;
    }
    const result = await runCommand(spawnImpl, bin, args, commandTimeoutMs);
    await sendResult(chatId, args[0], result);
  }

  async function run() {
    let offset = 0;
    while (!signal.aborted) {
      let updates;
      try {
        updates = await call('getUpdates', { timeout: POLL_TIMEOUT_S, offset, allowed_updates: ['message'] });
      } catch (err) {
        if (signal.aborted) break;
        log(`getUpdates failed: ${errText(err)}`);
        await sleep(RETRY_DELAY_MS, signal);
        continue;
      }
      for (const update of updates) {
        if (signal.aborted) break;
        offset = update.update_id + 1;
        try {
          await handleMessage(update.message);
        } catch (err) {
          log(`update ${update.update_id} failed: ${errText(err)}`);
        }
      }
    }
  }

  return { run };
}

async function main(argv) {
  loadEnvFiles([resolve('.env'), join(dirname(fileURLToPath(import.meta.url)), '.env')]);
  let config;
  try {
    config = parseConfig(argv);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  if (config.help) {
    process.stdout.write(USAGE);
    return;
  }
  let bin;
  try {
    bin = resolveBinary(config.bin);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => controller.abort());
  const bridge = createBridge({ token: config.token, allow: config.allow, bin, signal: controller.signal });
  process.stderr.write(`agent-desktop bridge polling; binary: ${bin}\n`);
  await bridge.run();
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`error: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
