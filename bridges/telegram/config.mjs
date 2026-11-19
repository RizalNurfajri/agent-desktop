// Runtime LLM configuration for the Telegram bridge, settable from chat.
// Seeds from the startup config, activates the agent lazily once base URL, API
// key and model are all present, and updates the live agent in place so per-chat
// history survives. Nothing is written to disk; chat config lasts until restart.

import process from 'node:process';
import { createAgent } from './agent.mjs';

const MODELS_SHOWN = 50;
const LLM_TIMEOUT_MS = 120000;
const RAW_MODE_NOTE = 'agent mode not configured (set LLM_BASE_URL, LLM_API_KEY, LLM_MODEL)';

export function createLlmController({
  initial,
  bin,
  sendText,
  sendPhoto,
  deleteMessage,
  fetchImpl = fetch,
  spawnImpl,
  log = (line) => process.stderr.write(`${line}\n`),
  signal = new AbortController().signal,
  commandTimeoutMs = 120000,
}) {
  const state = {
    baseUrl: initial?.baseUrl ? initial.baseUrl.replace(/\/+$/, '') : undefined,
    apiKey: initial?.apiKey || undefined,
    model: initial?.model || undefined,
  };
  let agent;

  const active = () => Boolean(state.baseUrl && state.apiKey && state.model);

  function ensureAgent() {
    if (active() && !agent) {
      agent = createAgent({
        baseUrl: state.baseUrl,
        apiKey: state.apiKey,
        model: state.model,
        bin,
        fetchImpl,
        spawnImpl,
        log,
        signal,
        commandTimeoutMs,
        sendText,
        sendPhoto,
      });
    }
    return agent;
  }
  ensureAgent();

  function applyConfig() {
    if (agent) agent.setConfig(state);
    else ensureAgent();
  }

  function missing() {
    const parts = [];
    if (!state.baseUrl) parts.push('base URL (/setbase)');
    if (!state.apiKey) parts.push('API key (/setkey)');
    if (!state.model) parts.push('model (/model)');
    return parts;
  }

  function statusReply(prefix) {
    if (active()) return `${prefix} agent mode active.`;
    if (state.baseUrl && state.apiKey) return `${prefix} send /models to list models, /model <id> to pick one.`;
    return `${prefix} still missing: ${missing().join(', ')}.`;
  }

  async function fetchModels() {
    const res = await fetchImpl(`${state.baseUrl}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${state.apiKey}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(LLM_TIMEOUT_MS)]),
    });
    if (!res.ok) {
      const detail = typeof res.text === 'function' ? (await res.text()).slice(0, 300) : '';
      throw new Error(`models failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    }
    const data = await res.json();
    return (data?.data ?? []).map((m) => m.id).filter((id) => typeof id === 'string');
  }

  async function handleCommand(chatId, text, messageId) {
    if (text === '/config') {
      const key = state.apiKey;
      const masked = !key ? 'not set' : key.length < 8 ? '***' : `${key.slice(0, 3)}...${key.slice(-4)}`;
      const status = active() ? 'agent mode ACTIVE' : 'raw mode - set all three to enable';
      await sendText(chatId, `base URL: ${state.baseUrl ?? 'not set'}\nAPI key: ${masked}\nmodel: ${state.model ?? 'not set'}\nstatus: ${status}`);
      return true;
    }
    if (text === '/setbase' || text.startsWith('/setbase ')) {
      const value = text.slice('/setbase'.length).trim();
      if (!value) {
        await sendText(chatId, 'usage: /setbase <url>');
        return true;
      }
      state.baseUrl = value.replace(/\/+$/, '');
      applyConfig();
      await sendText(chatId, statusReply('Base URL set.'));
      return true;
    }
    if (text === '/setkey' || text.startsWith('/setkey ')) {
      const value = text.slice('/setkey'.length).trim();
      if (!value) {
        await sendText(chatId, 'usage: /setkey <key>');
        return true;
      }
      state.apiKey = value;
      await deleteMessage(chatId, messageId);
      applyConfig();
      await sendText(chatId, statusReply('API key set.'));
      return true;
    }
    if (text === '/model' || text.startsWith('/model ')) {
      if (!state.baseUrl && !state.apiKey && !agent) {
        await sendText(chatId, RAW_MODE_NOTE);
        return true;
      }
      const id = text.slice('/model'.length).trim();
      if (id) {
        state.model = id;
        applyConfig();
      }
      await sendText(chatId, `model: ${state.model ?? 'not set'}`);
      return true;
    }
    if (text === '/models') {
      if (!state.baseUrl || !state.apiKey) {
        await sendText(chatId, RAW_MODE_NOTE);
        return true;
      }
      try {
        const ids = await fetchModels();
        const shown = ids.slice(0, MODELS_SHOWN).join('\n') || 'no models listed';
        await sendText(chatId, ids.length > MODELS_SHOWN ? `${shown}\n...and ${ids.length - MODELS_SHOWN} more` : shown);
      } catch (err) {
        await sendText(chatId, `could not list models: ${err?.message ?? err}`);
      }
      return true;
    }
    if (text === '/reset') {
      if (!agent) {
        await sendText(chatId, RAW_MODE_NOTE);
        return true;
      }
      agent.reset(chatId);
      await sendText(chatId, 'history cleared');
      return true;
    }
    return false;
  }

  return { handleCommand, currentKey: () => state.apiKey, isActive: active, getAgent: () => agent };
}
