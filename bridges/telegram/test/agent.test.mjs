import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, parseConfig } from '../bridge.mjs';

const TOKEN = '123456:TEST-TOKEN-SECRET';
const KEY = 'sk-TEST-LLM-KEY-SECRET';
const BIN = 'C:\\fake\\agent-desktop.exe';
const BASE = 'https://llm.example/v1';
const LLM = { baseUrl: BASE, apiKey: KEY, model: 'test-model' };
const CHAT_BASE = 'https://chat-config.example/v1';
const CHAT_KEY = 'sk-CHAT-SET-KEY-987654321';
const OK_ENVELOPE = '{"version":"2.6","ok":true,"command":"status","data":{"running":true}}';

const update = (id, from, text, chat = from) => ({
  update_id: id,
  message: { message_id: id, from: { id: from }, chat: { id: chat }, text },
});
const json = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
const completion = (content, toolCalls) => ({ choices: [{ message: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] });
const toolCall = (args, id = 'call_1') => [{ id, type: 'function', function: { name: 'agent_desktop', arguments: JSON.stringify({ args }) } }];

function fakeSpawn(responder, calls) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const { stdout = '', stderr = '', code = 0 } = responder(args);
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

function setup({ pages, completions = [completion('ok')], models, llm = LLM, toolStdout = OK_ENVELOPE, spawnResponder }) {
  const controller = new AbortController();
  const telegramCalls = [];
  const llmCalls = [];
  const spawnCalls = [];
  const logs = [];
  let pageIndex = 0;
  let completionIndex = 0;
  const responder = spawnResponder ?? ((args) => args[0] === 'skills'
    ? { stdout: JSON.stringify({ version: '2.6', ok: true, command: 'skills', data: { content: `skill:${args[2]}` } }) }
    : { stdout: toolStdout });
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://api.telegram.org/')) {
      const method = url.split('/').pop();
      const body = init.body instanceof FormData ? init.body : JSON.parse(init.body);
      telegramCalls.push({ method, body });
      if (method === 'getUpdates') {
        if (pageIndex < pages.length) return json({ ok: true, result: pages[pageIndex++] });
        controller.abort();
        return json({ ok: true, result: [] });
      }
      return json({ ok: true, result: {} });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    llmCalls.push({ url, init, body });
    if (url.endsWith('/models')) return json(models ?? { data: [{ id: 'alpha' }, { id: 'beta' }] });
    const payload = completions[Math.min(completionIndex, completions.length - 1)];
    completionIndex += 1;
    if (payload instanceof Error) throw payload;
    return json(payload);
  };
  const bridge = createBridge({
    token: TOKEN,
    allow: [42],
    bin: BIN,
    llm,
    fetchImpl,
    spawnImpl: fakeSpawn(responder, spawnCalls),
    sleep: async () => {},
    log: (line) => logs.push(line),
    signal: controller.signal,
  });
  const sends = (method) => telegramCalls.filter((c) => c.method === method);
  const toolSpawns = () => spawnCalls.filter((c) => c.args[0] !== 'skills');
  return { bridge, telegramCalls, llmCalls, spawnCalls, logs, sends, toolSpawns };
}

test('agent loop: tool call then final text, exact argv and tool result fed back', async () => {
  const t = setup({
    pages: [[update(100, 42, 'buka youtube di brave')]],
    completions: [completion(null, toolCall(['status'])), completion('sudah dibuka')],
  });
  await t.bridge.run();
  assert.equal(t.toolSpawns().length, 1);
  assert.deepEqual(t.toolSpawns()[0].args, ['status']);
  assert.equal(t.toolSpawns()[0].opts.shell, false);
  assert.equal(t.sends('sendMessage').at(-1).body.text, 'sudah dibuka');
  assert.equal(t.llmCalls.length, 2);
  const second = t.llmCalls[1].body;
  const toolMsg = second.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.content, OK_ENVELOPE);
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.equal(second.messages.filter((m) => m.role === 'system').length, 1);
  assert.ok(second.messages[0].content.includes('skill:desktop'));
  assert.ok(second.messages[0].content.includes('skill:platform'));
  assert.equal(second.tools[0].function.name, 'agent_desktop');
  assert.equal(second.tool_choice, 'auto');
});

test('agent loop: max 12 tool rounds then a final request without tools', async () => {
  const t = setup({
    pages: [[update(100, 42, 'loop forever')]],
    completions: [completion('final answer', toolCall(['status']))],
  });
  await t.bridge.run();
  assert.equal(t.llmCalls.length, 13);
  assert.equal(t.toolSpawns().length, 12);
  const last = t.llmCalls.at(-1).body;
  assert.equal(last.tools, undefined);
  assert.equal(last.tool_choice, undefined);
  assert.ok(last.messages.some((m) => m.role === 'system' && m.content.includes('Stop calling tools')));
  assert.ok(t.sends('sendMessage').some((c) => c.body.text === 'final answer'));
  for (const call of t.llmCalls.slice(0, 12)) assert.equal(call.body.tools.length, 1);
});

test('/models lists ids from the API with the bearer key', async () => {
  const t = setup({ pages: [[update(100, 42, '/models')]], models: { data: [{ id: 'alpha' }, { id: 'beta' }] } });
  await t.bridge.run();
  assert.equal(t.llmCalls.length, 1);
  assert.equal(t.llmCalls[0].url, `${BASE}/models`);
  assert.equal(t.llmCalls[0].init.method, 'GET');
  assert.equal(t.llmCalls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(t.sends('sendMessage')[0].body.text, 'alpha\nbeta');
  assert.equal(t.toolSpawns().length, 0);
});

test('/models caps the list at 50 and notes the remainder', async () => {
  const ids = Array.from({ length: 55 }, (_, i) => ({ id: `m${i}` }));
  const t = setup({ pages: [[update(100, 42, '/models')]], models: { data: ids } });
  await t.bridge.run();
  const text = t.sends('sendMessage')[0].body.text;
  assert.ok(text.includes('...and 5 more'));
  assert.equal(text.split('\n').length, 51);
});

test('base URL trailing slash is stripped before building endpoints', async () => {
  const t = setup({ pages: [[update(100, 42, '/models')]], llm: { ...LLM, baseUrl: `${BASE}/` } });
  await t.bridge.run();
  assert.equal(t.llmCalls[0].url, `${BASE}/models`);
});

test('/model sets the runtime model used in the next completion body', async () => {
  const t = setup({
    pages: [[update(100, 42, '/model new-model'), update(101, 42, '/model'), update(102, 42, 'halo')]],
    completions: [completion('hai')],
  });
  await t.bridge.run();
  assert.deepEqual(t.sends('sendMessage').map((c) => c.body.text), ['model: new-model', 'model: new-model', 'hai']);
  assert.equal(t.llmCalls.length, 1);
  assert.equal(t.llmCalls[0].body.model, 'new-model');
});

test('LLM API error containing the key is redacted in the reply and logs', async () => {
  const t = setup({
    pages: [[update(100, 42, 'halo')]],
    completions: [new Error(`401 invalid api key ${KEY}`)],
  });
  await t.bridge.run();
  const replies = t.sends('sendMessage');
  assert.equal(replies.length, 1);
  assert.ok(replies[0].body.text.includes('[REDACTED]'));
  assert.ok(!replies[0].body.text.includes(KEY));
  const joined = t.logs.join('\n');
  assert.ok(joined.includes('[REDACTED]'));
  assert.ok(!joined.includes(KEY));
});

test('raw mode: natural text still spawns as CLI when LLM config absent', async () => {
  const t = setup({ pages: [[update(100, 42, 'buka youtube di brave')]], llm: null });
  await t.bridge.run();
  assert.equal(t.llmCalls.length, 0);
  assert.equal(t.spawnCalls.length, 1);
  assert.deepEqual(t.spawnCalls[0].args, ['buka', 'youtube', 'di', 'brave']);
  assert.equal(t.sends('sendMessage')[0].body.text, OK_ENVELOPE);
});

test('agent mode: ! prefix runs the raw CLI with no LLM call', async () => {
  const t = setup({ pages: [[update(100, 42, '!snapshot --app brave')]] });
  await t.bridge.run();
  assert.equal(t.llmCalls.length, 0);
  assert.equal(t.toolSpawns().length, 1);
  assert.deepEqual(t.toolSpawns()[0].args, ['snapshot', '--app', 'brave']);
  assert.equal(t.sends('sendMessage')[0].body.text, OK_ENVELOPE);
});

test('tool result over 12000 chars is truncated with a marker', async () => {
  const long = 'x'.repeat(13000);
  const t = setup({
    pages: [[update(100, 42, 'snapshot big')]],
    completions: [completion(null, toolCall(['status'])), completion('done')],
    toolStdout: long,
  });
  await t.bridge.run();
  const toolMsg = t.llmCalls[1].body.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.content.length, 12000 + '\n...[truncated]'.length);
  assert.ok(toolMsg.content.endsWith('\n...[truncated]'));
  assert.equal(toolMsg.content.slice(0, 12000), long.slice(0, 12000));
});

test('parseConfig: partial LLM config throws naming the missing piece', () => {
  const base = ['--token', 't', '--allow', '1'];
  assert.throws(() => parseConfig([...base, '--base-url', 'https://x/v1'], {}), /LLM_API_KEY/);
  assert.throws(() => parseConfig([...base, '--base-url', 'https://x/v1'], {}), /LLM_MODEL/);
  assert.throws(() => parseConfig(base, { LLM_BASE_URL: 'https://x/v1', LLM_MODEL: 'm' }), /LLM_API_KEY/);
  assert.throws(() => parseConfig(base, { LLM_API_KEY: 'k' }), /LLM_BASE_URL/);
  const full = parseConfig([...base, '--base-url', 'https://x/v1/', '--api-key', 'k', '--model', 'm'], {});
  assert.deepEqual(full.llm, { baseUrl: 'https://x/v1/', apiKey: 'k', model: 'm' });
  assert.equal(parseConfig(base, {}).llm, undefined);
  assert.equal(parseConfig(base, { LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' }).llm.model, 'm');
});

test('/reset clears history so the next completion has no prior turns', async () => {
  const t = setup({
    pages: [[update(100, 42, 'first message'), update(101, 42, '/reset'), update(102, 42, 'second message')]],
    completions: [completion('one'), completion('two')],
  });
  await t.bridge.run();
  assert.equal(t.llmCalls.length, 2);
  const afterReset = t.llmCalls[1].body.messages;
  assert.ok(!afterReset.some((m) => typeof m.content === 'string' && m.content.includes('first message')));
  assert.ok(!afterReset.some((m) => m.content === 'one'));
  assert.equal(afterReset.filter((m) => m.role === 'user').length, 1);
  assert.equal(afterReset.find((m) => m.role === 'user').content, 'second message');
  assert.ok(t.sends('sendMessage').some((c) => c.body.text === 'history cleared'));
});

test('history caps at 20 non-system messages and never starts with an orphan tool', async () => {
  const pages = [];
  const completions = [];
  for (let n = 0; n < 6; n++) {
    pages.push(update(100 + n, 42, `turn ${n}`));
    completions.push(completion(null, toolCall(['status'], `call_${n}`)));
    completions.push(completion(`answer ${n}`));
  }
  const t = setup({ pages: [pages], completions });
  await t.bridge.run();
  assert.equal(t.llmCalls.length, 12);
  for (const call of t.llmCalls) {
    const nonSystem = call.body.messages.filter((m) => m.role !== 'system');
    assert.ok(nonSystem.length <= 20, `history too long: ${nonSystem.length}`);
    assert.notEqual(nonSystem[0]?.role, 'tool');
  }
  assert.equal(t.sends('sendMessage').length, 6);
});

test('raw mode: /models /model /reset reply the not-configured note', async () => {
  const t = setup({
    pages: [[update(100, 42, '/models'), update(101, 42, '/model x'), update(102, 42, '/reset')]],
    llm: null,
  });
  await t.bridge.run();
  const replies = t.sends('sendMessage').map((c) => c.body.text);
  assert.equal(replies.length, 3);
  for (const r of replies) assert.match(r, /agent mode not configured/);
  assert.equal(t.llmCalls.length, 0);
  assert.equal(t.spawnCalls.length, 0);
});

test('agent mode: screenshot tool sends the photo plus the tool result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
  const file = join(dir, 'shot.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  writeFileSync(file, bytes);
  try {
    const envelope = JSON.stringify({ version: '2.6', ok: true, command: 'screenshot', data: { path: file } });
    const t = setup({
      pages: [[update(100, 42, 'screenshot the screen')]],
      completions: [completion(null, toolCall(['screenshot', '--output', file])), completion('ini screenshot')],
      toolStdout: envelope,
    });
    await t.bridge.run();
    const photos = t.sends('sendPhoto');
    assert.equal(photos.length, 1);
    assert.deepEqual(Buffer.from(await photos[0].body.get('photo').arrayBuffer()), bytes);
    assert.equal(t.llmCalls[1].body.messages.find((m) => m.role === 'tool').content, envelope);
    assert.ok(t.sends('sendMessage').some((c) => c.body.text === 'ini screenshot'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skills spawn failure falls back to the built-in prompt and warns', async () => {
  const t = setup({
    pages: [[update(100, 42, 'halo')]],
    completions: [completion('hai')],
    spawnResponder: (args) => args[0] === 'skills' ? { stdout: 'not json', code: 1 } : { stdout: OK_ENVELOPE },
  });
  await t.bridge.run();
  assert.ok(t.logs.some((l) => /warning/.test(l) && /skill/.test(l)));
  const system = t.llmCalls[0].body.messages[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes('agent_desktop'));
  assert.ok(system.content.includes('envelope'));
  assert.ok(t.sends('sendMessage').some((c) => c.body.text === 'hai'));
});

test('agent mode: non-whitelisted natural text never reaches the LLM', async () => {
  const t = setup({ pages: [[update(100, 999, 'buka youtube')]] });
  await t.bridge.run();
  assert.equal(t.llmCalls.length, 0);
  assert.equal(t.telegramCalls.filter((c) => c.method !== 'getUpdates').length, 0);
  assert.ok(t.logs.some((l) => l.includes('999')));
});

test('chat config: /setbase + /setkey + /model activates agent mode end-to-end', async () => {
  const t = setup({
    pages: [[update(100, 42, `/setbase ${CHAT_BASE}`), update(101, 42, `/setkey ${CHAT_KEY}`), update(102, 42, '/model chat-model'), update(103, 42, 'halo dunia')]],
    completions: [completion('halo juga')],
    llm: null,
  });
  await t.bridge.run();
  assert.equal(t.llmCalls.length, 1);
  assert.equal(t.llmCalls[0].url, `${CHAT_BASE}/chat/completions`);
  assert.equal(t.llmCalls[0].init.headers.authorization, `Bearer ${CHAT_KEY}`);
  assert.equal(t.llmCalls[0].body.model, 'chat-model');
  assert.ok(t.sends('sendMessage').some((c) => c.body.text === 'halo juga'));
});

test('chat config: /config masks the key and never echoes it in full', async () => {
  const t = setup({
    pages: [[update(100, 42, `/setbase ${CHAT_BASE}`), update(101, 42, `/setkey ${CHAT_KEY}`), update(102, 42, '/model chat-model'), update(103, 42, '/config')]],
    llm: null,
  });
  await t.bridge.run();
  const config = t.sends('sendMessage').at(-1).body.text;
  assert.ok(config.includes(CHAT_BASE));
  assert.ok(config.includes('chat-model'));
  assert.ok(config.includes(`${CHAT_KEY.slice(0, 3)}...${CHAT_KEY.slice(-4)}`));
  assert.ok(config.includes('ACTIVE'));
  assert.ok(!config.includes(CHAT_KEY));
  const allReplies = t.sends('sendMessage').map((c) => c.body.text).join('\n');
  assert.ok(!allReplies.includes(CHAT_KEY));
});

test('chat config: /setkey deletes the user message with the right ids', async () => {
  const t = setup({ pages: [[update(100, 42, `/setkey ${CHAT_KEY}`)]], llm: null });
  await t.bridge.run();
  const deletes = t.sends('deleteMessage');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].body.chat_id, 42);
  assert.equal(deletes[0].body.message_id, 100);
});

test('chat config: /setbase mid-session updates the agent in place and preserves history', async () => {
  const newBase = 'https://moved.example/v1';
  const t = setup({
    pages: [[update(100, 42, 'first message'), update(101, 42, `/setbase ${newBase}`), update(102, 42, 'second message')]],
    completions: [completion('one'), completion('two')],
  });
  await t.bridge.run();
  assert.equal(t.llmCalls.length, 2);
  assert.equal(t.llmCalls[0].url, `${BASE}/chat/completions`);
  assert.equal(t.llmCalls[1].url, `${newBase}/chat/completions`);
  assert.ok(t.llmCalls[1].body.messages.some((m) => m.role === 'user' && m.content === 'first message'));
  assert.ok(t.sends('sendMessage').some((c) => c.body.text === 'two'));
});

test('chat config: /models uses the chat-set base URL and key', async () => {
  const t = setup({
    pages: [[update(100, 42, `/setbase ${CHAT_BASE}`), update(101, 42, `/setkey ${CHAT_KEY}`), update(102, 42, '/models')]],
    models: { data: [{ id: 'chat-model-x' }] },
    llm: null,
  });
  await t.bridge.run();
  assert.equal(t.llmCalls.length, 1);
  assert.equal(t.llmCalls[0].url, `${CHAT_BASE}/models`);
  assert.equal(t.llmCalls[0].init.headers.authorization, `Bearer ${CHAT_KEY}`);
  assert.ok(t.sends('sendMessage').some((c) => c.body.text === 'chat-model-x'));
});

test('chat config: non-whitelisted /setkey is silently dropped and changes nothing', async () => {
  const t = setup({
    pages: [[update(100, 999, `/setkey ${CHAT_KEY}`), update(101, 42, '/config')]],
    llm: null,
  });
  await t.bridge.run();
  assert.equal(t.sends('deleteMessage').length, 0);
  assert.equal(t.llmCalls.length, 0);
  const config = t.sends('sendMessage').at(-1).body.text;
  assert.ok(config.includes('API key: not set'));
  assert.ok(!config.includes(CHAT_KEY));
  assert.ok(t.logs.some((l) => l.includes('999')));
});

test('chat config: /setbase with no value replies usage and sets nothing', async () => {
  const t = setup({ pages: [[update(100, 42, '/setbase'), update(101, 42, '/config')]], llm: null });
  await t.bridge.run();
  const replies = t.sends('sendMessage').map((c) => c.body.text);
  assert.match(replies[0], /usage: \/setbase/);
  assert.ok(replies.at(-1).includes('base URL: not set'));
});

test('chat config: partial config stays raw mode and names what is missing', async () => {
  const t = setup({
    pages: [[update(100, 42, `/setbase ${CHAT_BASE}`), update(101, 42, 'snapshot --app brave')]],
    llm: null,
  });
  await t.bridge.run();
  const setbaseReply = t.sends('sendMessage')[0].body.text;
  assert.match(setbaseReply, /still missing/);
  assert.match(setbaseReply, /\/setkey/);
  assert.match(setbaseReply, /\/model/);
  assert.equal(t.llmCalls.length, 0);
  assert.equal(t.toolSpawns().length, 1);
  assert.deepEqual(t.toolSpawns()[0].args, ['snapshot', '--app', 'brave']);
});
