import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, loadEnvFiles, parseConfig, resolveBinary, tokenize } from '../bridge.mjs';

const BRIDGE_PATH = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const TOKEN = '123456:TEST-TOKEN-SECRET';
const BIN = 'C:\\fake\\agent-desktop.exe';

const update = (id, from, text, chat = from) => ({
  update_id: id,
  message: { message_id: id, from: { id: from }, chat: { id: chat }, text },
});

const jsonResponse = (payload) => ({ json: async () => payload });

function fakeSpawn(stdout, stderr, code, calls) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
}

function setup({ pages, allow = [42], stdout = '{"ok":true,"command":"noop","data":{}}', stderr = '', code = 0 }) {
  const controller = new AbortController();
  const apiCalls = [];
  const spawnCalls = [];
  const logs = [];
  const sleeps = [];
  let pageIndex = 0;
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const body = init.body instanceof FormData ? init.body : JSON.parse(init.body);
    apiCalls.push({ method, body });
    if (method === 'getUpdates') {
      if (pageIndex < pages.length) return jsonResponse({ ok: true, result: pages[pageIndex++] });
      controller.abort();
      return jsonResponse({ ok: true, result: [] });
    }
    return jsonResponse({ ok: true, result: {} });
  };
  const bridge = createBridge({
    token: TOKEN,
    allow,
    bin: BIN,
    fetchImpl,
    spawnImpl: fakeSpawn(stdout, stderr, code, spawnCalls),
    sleep: async (ms) => { sleeps.push(ms); },
    log: (line) => logs.push(line),
    signal: controller.signal,
  });
  const sends = (method) => apiCalls.filter((c) => c.method === method);
  return { bridge, apiCalls, spawnCalls, logs, sleeps, sends };
}

test('non-whitelisted command never spawns and gets no reply', async () => {
  const t = setup({ pages: [[update(100, 999, 'snapshot --app brave')]] });
  await t.bridge.run();
  assert.equal(t.spawnCalls.length, 0);
  assert.equal(t.apiCalls.filter((c) => c.method !== 'getUpdates').length, 0);
  assert.ok(t.logs.some((l) => l.includes('999')));
  assert.ok(!t.logs.join('\n').includes('snapshot'));
});

test('/id replies with the sender id even for a non-whitelisted user', async () => {
  const t = setup({ pages: [[update(100, 999, '/id')]] });
  await t.bridge.run();
  const replies = t.sends('sendMessage');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body.chat_id, 999);
  assert.equal(replies[0].body.text, '999');
  assert.equal(t.spawnCalls.length, 0);
});

test('whitelisted quoted command spawns with preserved args and no shell', async () => {
  const t = setup({ pages: [[update(100, 42, 'type --text "hello world"')]] });
  await t.bridge.run();
  assert.equal(t.spawnCalls.length, 1);
  assert.equal(t.spawnCalls[0].bin, BIN);
  assert.deepEqual(t.spawnCalls[0].args, ['type', '--text', 'hello world']);
  assert.equal(t.spawnCalls[0].opts.shell, false);
  assert.equal(t.sends('sendMessage').length, 1);
});

test('offset advances past every processed update', async () => {
  const t = setup({ pages: [[update(100, 42, '/id')], [update(101, 42, '/id')]] });
  await t.bridge.run();
  const polls = t.apiCalls.filter((c) => c.method === 'getUpdates');
  assert.equal(polls[0].body.offset, 0);
  assert.equal(polls[1].body.offset, 101);
  assert.equal(polls[2].body.offset, 102);
});

test('stdout over 3900 chars goes to sendDocument, not sendMessage', async () => {
  const long = 'x'.repeat(4000);
  const t = setup({ pages: [[update(100, 42, 'snapshot')]], stdout: long });
  await t.bridge.run();
  assert.equal(t.sends('sendMessage').length, 0);
  const docs = t.sends('sendDocument');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].body.get('chat_id'), '42');
  const doc = docs[0].body.get('document');
  assert.equal(doc.name, 'result.json');
  assert.equal(await doc.text(), long);
});

test('screenshot envelope with data.path sends the file via sendPhoto', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const file = join(dir, 'shot.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  writeFileSync(file, bytes);
  try {
    const envelope = JSON.stringify({ ok: true, command: 'screenshot', data: { path: file, format: 'png' } });
    const t = setup({ pages: [[update(100, 42, 'screenshot')]], stdout: envelope });
    await t.bridge.run();
    const photos = t.sends('sendPhoto');
    assert.equal(photos.length, 1);
    assert.equal(photos[0].body.get('chat_id'), '42');
    const photo = photos[0].body.get('photo');
    assert.equal(photo.name, basename(file));
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), bytes);
    assert.equal(t.sends('sendMessage').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup rejects a missing token or an empty allowlist', () => {
  assert.throws(() => parseConfig([], {}), /token/);
  assert.throws(() => parseConfig(['--token', 't'], {}), /allowlist/);
  assert.throws(() => createBridge({ token: '', allow: [1], bin: BIN }), /token/);
  assert.throws(() => createBridge({ token: 't', allow: [], bin: BIN }), /allowlist/);
  assert.throws(() => parseConfig(['--token', 't', '--allow', 'abc'], {}), /numeric/);
});

test('fetch error containing the token is redacted in logs', async () => {
  const controller = new AbortController();
  const logs = [];
  const sleeps = [];
  let calls = 0;
  const bridge = createBridge({
    token: TOKEN,
    allow: [42],
    bin: BIN,
    fetchImpl: async () => {
      calls += 1;
      throw new Error(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`);
    },
    spawnImpl: fakeSpawn('', '', 0, []),
    sleep: async (ms) => { sleeps.push(ms); controller.abort(); },
    log: (line) => logs.push(line),
    signal: controller.signal,
  });
  await bridge.run();
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, [3000]);
  const joined = logs.join('\n');
  assert.ok(joined.includes('[REDACTED]'));
  assert.ok(!joined.includes(TOKEN));
});

test('unbalanced quotes get an error reply and never spawn', async () => {
  const t = setup({ pages: [[update(100, 42, 'type --text "oops')]] });
  await t.bridge.run();
  assert.equal(t.spawnCalls.length, 0);
  const replies = t.sends('sendMessage');
  assert.equal(replies.length, 1);
  assert.match(replies[0].body.text, /quote/);
});

test('/start is silent for non-whitelisted users', async () => {
  const t = setup({ pages: [[update(100, 999, '/start')]] });
  await t.bridge.run();
  assert.equal(t.apiCalls.filter((c) => c.method !== 'getUpdates').length, 0);
});

test('empty stdout replies with the stderr excerpt', async () => {
  const t = setup({ pages: [[update(100, 42, 'snapshot')]], stdout: '', stderr: 'boom: detail' });
  await t.bridge.run();
  const replies = t.sends('sendMessage');
  assert.equal(replies.length, 1);
  assert.match(replies[0].body.text, /boom: detail/);
});

test('env file: loads values, real env keeps precedence, missing file tolerated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-env-'));
  const file = join(dir, 'config-fixture');
  writeFileSync(file, 'TELEGRAM_BOT_TOKEN=file-token\nTELEGRAM_ALLOWED_USER_IDS="7, 8"\n');
  const saved = { ...process.env };
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_ALLOWED_USER_IDS = '99';
    loadEnvFiles([join(dir, 'absent'), file]);
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, 'file-token');
    assert.equal(process.env.TELEGRAM_ALLOWED_USER_IDS, '99');
    const config = parseConfig([]);
    assert.equal(config.token, 'file-token');
    assert.deepEqual([...config.allow], [99]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: env fallbacks, id splitting, and flag override', () => {
  const env = { TELEGRAM_BOT_TOKEN: 'env-token', TELEGRAM_ALLOWED_USER_IDS: '1, 2 3', AGENT_DESKTOP_BIN: 'env-bin' };
  const fromEnv = parseConfig([], env);
  assert.equal(fromEnv.token, 'env-token');
  assert.deepEqual([...fromEnv.allow].sort(), [1, 2, 3]);
  assert.equal(fromEnv.bin, 'env-bin');
  const overridden = parseConfig(['--token', 'flag-token', '--allow', '9'], env);
  assert.equal(overridden.token, 'flag-token');
  assert.deepEqual([...overridden.allow], [9]);
});

test('binary resolution replicates the npm wrapper platform mapping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-bin-'));
  try {
    const binDir = join(dir, 'npm', 'node_modules', 'agent-desktop', 'bin');
    mkdirSync(binDir, { recursive: true });
    const exe = join(binDir, 'agent-desktop-win32-x64.exe');
    writeFileSync(exe, 'fake');
    assert.equal(resolveBinary(undefined, { APPDATA: dir }, 'win32', 'x64'), exe);
    assert.equal(resolveBinary(exe, {}, 'win32', 'x64'), exe);
    assert.throws(() => resolveBinary(join(dir, 'missing.exe'), {}, 'win32', 'x64'), /not found/);
    assert.throws(() => resolveBinary(undefined, { APPDATA: join(dir, 'empty') }, 'win32', 'x64'), /--bin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tokenizer: single quotes, double-quote escapes, empty quoted arg', () => {
  assert.deepEqual(tokenize("a 'b c' d"), ['a', 'b c', 'd']);
  assert.deepEqual(tokenize('a "b \\"c\\" d"'), ['a', 'b "c" d']);
  assert.deepEqual(tokenize('a "" b'), ['a', '', 'b']);
  assert.throws(() => tokenize("a 'b"), /quote/);
});

function cliEnv() {
  const env = { ...process.env };
  // Present-but-empty keys stop loadEnvFile from filling them out of a
  // developer's local credential file, so "no token" stays truly absent.
  env.TELEGRAM_BOT_TOKEN = '';
  env.TELEGRAM_ALLOWED_USER_IDS = '';
  delete env.AGENT_DESKTOP_BIN;
  return env;
}

test('CLI --help prints usage and exits 0', () => {
  const res = spawnSync(process.execPath, [BRIDGE_PATH, '--help'], { encoding: 'utf8', env: cliEnv() });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--token/);
  assert.match(res.stdout, /--allow/);
});

test('CLI without a token exits 2 with a clear stderr message', () => {
  const res = spawnSync(process.execPath, [BRIDGE_PATH], { encoding: 'utf8', env: cliEnv() });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /token/);
});
