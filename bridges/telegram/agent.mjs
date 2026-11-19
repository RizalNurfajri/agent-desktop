// LLM agent loop for the Telegram bridge. Zero dependencies, Node >= 20.12.
// The model reasons over natural language and drives agent-desktop through a
// single agent_desktop tool. Dependency-injected like createBridge: fake
// fetch/spawn in tests, real ones wired by the bridge. No Telegram specifics
// here; replies and photos leave through the sendText/sendPhoto callbacks.

import { spawn as nodeSpawn } from 'node:child_process';
import process from 'node:process';
import { runCommand } from './bridge.mjs';

const TOOL_RESULT_LIMIT = 12000;
const MAX_TOOL_ROUNDS = 12;
const HISTORY_CAP = 20;
const LLM_TIMEOUT_MS = 120000;
const STDERR_EXCERPT = 2000;

const AGENT_TOOL = {
  type: 'function',
  function: {
    name: 'agent_desktop',
    description: 'Run the agent-desktop CLI on the remote PC and return its JSON envelope.',
    parameters: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'argv tokens for the agent-desktop CLI, e.g. ["snapshot","--app","brave","-i","--compact"]',
        },
      },
      required: ['args'],
    },
  },
};

const ADDENDUM = [
  'You operate this PC remotely through Telegram. Use the agent_desktop tool for every desktop action.',
  "Reply in the user's language, concisely.",
  'Refs are snapshot-scoped: re-snapshot or find after any UI change; never reuse stale refs or invent them.',
  'Chromium accessibility trees need --timeout-ms 15000-25000.',
  'On Indonesian YouTube the pause button is named "Jeda (k)" while playing and "Putar" while paused.',
].join(' ');

const FALLBACK_PROMPT = [
  'You are a desktop automation agent. Use the agent_desktop tool to run the agent-desktop CLI on the remote PC;',
  'pass argv tokens as {"args": string[]}. Every command prints one JSON envelope:',
  '{version, ok, command, data} on success (ok:true) or {version, ok, command, error} on failure (ok:false).',
  'Read the envelope to decide the next step. Typical flow: snapshot --app <name> -i --compact to observe,',
  'then act on snapshot-qualified refs like @s<id>:eN.',
].join(' ');

export async function buildSystemPrompt({
  bin,
  spawnImpl = nodeSpawn,
  commandTimeoutMs = 120000,
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  const parts = [];
  for (const skill of ['desktop', 'platform']) {
    const result = await runCommand(spawnImpl, bin, ['skills', 'get', skill], commandTimeoutMs);
    let content;
    try { content = JSON.parse(result.stdout).data.content; } catch { /* fall back below */ }
    if (result.error || result.timedOut || result.code !== 0 || typeof content !== 'string') {
      log(`warning: could not load bundled skill "${skill}"; using built-in agent prompt`);
      return `${FALLBACK_PROMPT}\n\n${ADDENDUM}`;
    }
    parts.push(content);
  }
  return `${parts.join('\n\n')}\n\n${ADDENDUM}`;
}

export function createAgent({
  baseUrl,
  apiKey,
  model,
  bin,
  sendText,
  sendPhoto,
  fetchImpl = fetch,
  spawnImpl = nodeSpawn,
  log = (line) => process.stderr.write(`${line}\n`),
  signal = new AbortController().signal,
  commandTimeoutMs = 120000,
  systemPrompt,
}) {
  if (!baseUrl || !apiKey || !model) throw new Error('agent requires baseUrl, apiKey and model');
  if (!bin) throw new Error('bin is required');
  if (typeof sendText !== 'function') throw new Error('sendText callback is required');
  let currentBase = baseUrl.replace(/\/+$/, '');
  let currentKey = apiKey;
  let currentModel = model;
  const redact = (value) => String(value).split(currentKey).join('[REDACTED]');
  const errText = (err) => redact([err?.message, err?.cause?.message].filter(Boolean).join(': ') || String(err));
  const histories = new Map();
  const promptReady = systemPrompt !== undefined
    ? Promise.resolve(systemPrompt)
    : buildSystemPrompt({ bin, spawnImpl, commandTimeoutMs, log });

  const llmSignal = () => AbortSignal.any([signal, AbortSignal.timeout(LLM_TIMEOUT_MS)]);

  async function readJson(res, label) {
    if (!res.ok) {
      const detail = typeof res.text === 'function' ? (await res.text()).slice(0, 300) : '';
      throw new Error(`${label} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  }

  async function complete(messages, withTools) {
    const body = { model: currentModel, messages };
    if (withTools) {
      body.tools = [AGENT_TOOL];
      body.tool_choice = 'auto';
    }
    const res = await fetchImpl(`${currentBase}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${currentKey}` },
      body: JSON.stringify(body),
      signal: llmSignal(),
    });
    const data = await readJson(res, 'chat/completions');
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error('chat/completions returned no message');
    return message;
  }

  async function runTool(call) {
    let args;
    try { args = JSON.parse(call.function?.arguments ?? '{}').args; } catch { /* invalid below */ }
    if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== 'string')) {
      return { content: 'invalid tool arguments: expected {"args": string[]}' };
    }
    const result = await runCommand(spawnImpl, bin, args, commandTimeoutMs);
    let content = result.stdout;
    if (content.length === 0) {
      const note = result.timedOut
        ? `command timed out after ${commandTimeoutMs}ms`
        : result.error ? `spawn failed: ${errText(result.error)}` : 'command produced no output';
      const excerpt = result.stderr.slice(0, STDERR_EXCERPT);
      content = excerpt ? `${note}\n${excerpt}` : note;
    }
    content = redact(content);
    if (content.length > TOOL_RESULT_LIMIT) content = `${content.slice(0, TOOL_RESULT_LIMIT)}\n...[truncated]`;
    let photoPath;
    if (args[0] === 'screenshot') {
      try {
        const envelope = JSON.parse(result.stdout);
        if (envelope?.ok === true && typeof envelope?.data?.path === 'string') photoPath = envelope.data.path;
      } catch { /* not an envelope: no photo */ }
    }
    return { content, photoPath };
  }

  function trim(messages) {
    while (messages.length > HISTORY_CAP) messages.shift();
    while (messages.length > 0 && messages[0].role === 'tool') messages.shift();
  }

  async function handle(chatId, text) {
    const system = await promptReady;
    let history = histories.get(chatId);
    if (!history) {
      history = [];
      histories.set(chatId, history);
    }
    history.push({ role: 'user', content: text });
    trim(history);
    try {
      for (let rounds = 0; ; rounds++) {
        const withTools = rounds < MAX_TOOL_ROUNDS;
        const messages = [{ role: 'system', content: system }, ...history];
        if (!withTools) messages.push({ role: 'system', content: 'Stop calling tools; give the user your final answer now.' });
        const message = await complete(messages, withTools);
        const calls = message.tool_calls;
        if (!withTools || !Array.isArray(calls) || calls.length === 0) {
          const answer = typeof message.content === 'string' && message.content.length > 0
            ? message.content
            : '(model returned no text)';
          history.push({ role: 'assistant', content: answer });
          trim(history);
          await sendText(chatId, answer);
          return;
        }
        history.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
        for (const call of calls) {
          const { content, photoPath } = await runTool(call);
          history.push({ role: 'tool', tool_call_id: call.id, content });
          if (photoPath && typeof sendPhoto === 'function') await sendPhoto(chatId, photoPath);
        }
        trim(history);
      }
    } catch (err) {
      log(`agent failed: ${errText(err)}`);
      await sendText(chatId, `agent error: ${errText(err)}`);
    }
  }

  function setConfig({ baseUrl, apiKey, model }) {
    if (baseUrl !== undefined) currentBase = baseUrl.replace(/\/+$/, '');
    if (apiKey !== undefined) currentKey = apiKey;
    if (model !== undefined) currentModel = model;
  }

  return {
    handle,
    setConfig,
    reset: (chatId) => { histories.delete(chatId); },
  };
}
