/**
 * Universal LLM layer (BYOK).
 * One OpenAI-compatible chat-completions code path covers Gemini, OpenAI,
 * Grok (xAI), OpenRouter (Claude, Meta Llama, Grok, ...), Ollama/LM Studio
 * local models, and any custom OpenAI-compatible endpoint.
 * Anthropic Claude direct gets a small native adapter.
 */
const config = require('./config');
const store = require('./store');
const { PRESETS } = require('./style/presets');

// Public metadata (safe to send to the browser — no secrets).
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini', kind: 'openai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.5-flash'],
    needsKey: true, keyUrl: 'https://aistudio.google.com', keyHint: 'Free key from Google AI Studio',
  },
  openai: {
    label: 'OpenAI', kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'o3-mini', 'o1'],
    needsKey: true, keyUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic Claude', kind: 'anthropic',
    models: ['claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
    needsKey: true, keyUrl: 'https://console.anthropic.com',
  },
  xai: {
    label: 'xAI Grok', kind: 'openai',
    baseURL: 'https://api.x.ai/v1',
    models: ['grok-2-latest', 'grok-2', 'grok-beta'],
    needsKey: true, keyUrl: 'https://console.x.ai',
  },
  openrouter: {
    label: 'OpenRouter (Claude, Llama/Meta, Grok + more)', kind: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    models: ['meta-llama/llama-3.3-70b-instruct', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001', 'openai/gpt-4o-mini'],
    needsKey: true, keyUrl: 'https://openrouter.ai/keys', keyHint: 'One key unlocks Claude, Meta Llama, Grok and more',
  },
  ollama: {
    label: 'Ollama (local, free)', kind: 'openai',
    baseURL: 'http://localhost:11434/v1',
    models: ['llama3.1:8b', 'qwen2.5:7b', 'mistral:7b', 'gemma3:4b'],
    needsKey: false, keyHint: 'No key needed — runs on your machine',
  },
  lmstudio: {
    label: 'LM Studio (local, free)', kind: 'openai',
    baseURL: 'http://localhost:1234/v1',
    models: [], needsKey: false, keyHint: 'No key needed — runs on your machine',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)', kind: 'openai',
    baseURL: '', models: [], needsKey: true, keyHint: 'Any endpoint that speaks /v1/chat/completions',
  },
};

function activeConfig(overrides = {}) {
  const s = store.getSettings();
  const provider = (overrides.provider || s.llmProvider) in PROVIDERS ? (overrides.provider || s.llmProvider) : 'gemini';
  const meta = PROVIDERS[provider] || PROVIDERS.gemini;

  let apiKey = overrides.apiKey;
  if (apiKey === undefined || apiKey === null) {
    apiKey = s.providerKeys?.[provider] || (s.llmProvider === provider ? s.llmApiKey : '') || (provider === 'gemini' ? config.geminiApiKey : '') || '';
  }

  const baseURL = (overrides.baseURL !== undefined ? overrides.baseURL : (s.llmBaseURL || meta.baseURL || '')).replace(/\/$/, '');
  const model = overrides.model || s.providerModels?.[provider] || (s.llmProvider === provider ? s.llmModel : '') || meta.models[0] || '';

  return {
    provider,
    meta,
    apiKey: String(apiKey || '').trim(),
    baseURL,
    model: String(model || '').trim(),
  };
}

function cleanReplyText(text) {
  if (!text) return '';
  let out = String(text).trim();
  // Strip surrounding quotes if the model quoted its entire response
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

async function openAIChat({ baseURL, apiKey, model, system, messages, meta }) {
  if (!baseURL) throw new Error('No API endpoint set for this provider.');
  if (!model) throw new Error('No model set — pick or type a model id.');
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  const validMsgs = (messages || [])
    .filter(m => m && typeof m.text === 'string' && m.text.trim().length > 0)
    .map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text.trim() }));

  const chatMessages = [];
  if (system && system.trim()) {
    chatMessages.push({ role: 'system', content: system.trim() });
  }
  if (validMsgs.length > 0) {
    chatMessages.push(...validMsgs);
  } else {
    chatMessages.push({ role: 'user', content: 'Hello' });
  }

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(35000),
    body: JSON.stringify({
      model,
      messages: chatMessages,
      temperature: 0.9,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    let errMsg = '';
    try {
      const errJson = await res.json();
      errMsg = errJson?.error?.message || errJson?.error || JSON.stringify(errJson);
    } catch {
      errMsg = (await res.text().catch(() => '')).slice(0, 220);
    }
    const providerName = meta?.label || 'LLM';
    throw new Error(`${providerName} error (${res.status}): ${errMsg || 'Request failed'}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty reply from model.');
  return cleanReplyText(text);
}

async function anthropicChat({ apiKey, model, system, messages, meta }) {
  if (!apiKey) throw new Error('Anthropic needs an API key.');
  if (!model) throw new Error('No model set — pick or type a model id.');

  const validMsgs = (messages || [])
    .filter(m => m && typeof m.text === 'string' && m.text.trim().length > 0)
    .map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text.trim() }));

  if (validMsgs.length === 0) {
    validMsgs.push({ role: 'user', content: 'Hello' });
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    signal: AbortSignal.timeout(35000),
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: system || undefined,
      messages: validMsgs,
    }),
  });

  if (!res.ok) {
    let errMsg = '';
    try {
      const errJson = await res.json();
      errMsg = errJson?.error?.message || errJson?.error || JSON.stringify(errJson);
    } catch {
      errMsg = (await res.text().catch(() => '')).slice(0, 220);
    }
    throw new Error(`Claude error (${res.status}): ${errMsg || 'Request failed'}`);
  }

  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  if (!text) throw new Error('Empty reply from model.');
  return cleanReplyText(text);
}

function buildSystemPrompt(chatConfig, styles) {
  // Resolve the chat's style: named custom style, preset, or fallback.
  const styleId = chatConfig.styleId || 'preset:friendly';
  let styleBlock = '';
  if (styleId.startsWith('custom:')) {
    const st = (styles || []).find(s => s.id === styleId);
    if (st && st.profile) {
      const p = st.profile;
      styleBlock =
        `STYLE: "${st.name}" (learned from the user's own messages).\n${p.instructions}\n` +
        `Example messages in their style:\n${p.examples.slice(0, 20).map(e => '- ' + e).join('\n')}`;
    }
  }
  if (!styleBlock) {
    const presetKey = styleId.startsWith('preset:') ? styleId.slice(7) : 'friendly';
    const preset = PRESETS[presetKey] || PRESETS.friendly;
    styleBlock = `STYLE: ${preset.label}.\n${preset.instructions}`;
  }
  return (
    `You are a WhatsApp reply assistant. Reply as the user would reply. ` +
    `Keep replies natural for WhatsApp: short, no headers, no bullet lists unless asked.\n${styleBlock}`
  );
}

/**
 * List available models from a provider (used by "Load models" in Setup).
 * Works with any OpenAI-compatible endpoint and Anthropic.
 * Automatically falls back to the saved key if not passed.
 */
async function listModels({ provider, apiKey, baseURL }) {
  const meta = PROVIDERS[provider];
  if (!meta) throw new Error('Unknown provider.');

  const s = store.getSettings();
  const resolvedKey = (apiKey || '').trim() ||
    s.providerKeys?.[provider] ||
    (s.llmProvider === provider ? s.llmApiKey : '') ||
    (provider === 'gemini' ? config.geminiApiKey : '') ||
    '';

  if (meta.kind === 'anthropic') {
    if (!resolvedKey) throw new Error('Paste your API key first.');
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': resolvedKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Could not list models (${res.status}). Check the key: ${err.slice(0, 150)}`);
    }
    const data = await res.json();
    return (data.data || []).map(m => m.id);
  }

  const url = (baseURL || meta.baseURL || '').replace(/\/$/, '');
  if (!url) throw new Error('No API endpoint set.');
  const headers = {};
  if (resolvedKey) headers['authorization'] = `Bearer ${resolvedKey}`;

  const res = await fetch(`${url}/models`, { headers });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Could not list models (${res.status}). Check endpoint/key: ${err.slice(0, 150)}`);
  }

  const data = await res.json();
  const rawList = (data.data || []).map(m => String(m.id).replace(/^models\//, ''));

  // If Gemini, prioritize conversational models at top
  if (provider === 'gemini') {
    const chatModels = rawList.filter(id => !id.includes('embedding') && !id.includes('imagen') && !id.includes('aqa'));
    return (chatModels.length > 0 ? chatModels : rawList).sort((a, b) => {
      const aG = a.startsWith('gemini');
      const bG = b.startsWith('gemini');
      if (aG && !bG) return -1;
      if (!aG && bG) return 1;
      return a.localeCompare(b);
    });
  }

  return rawList.sort();
}

let lastLlmError = null;

function getLastLlmError() {
  return lastLlmError;
}

function clearLastLlmError() {
  lastLlmError = null;
}

async function generateReply(chatConfig, history, incomingText) {
  if (!incomingText || !incomingText.trim()) return '';
  const c = activeConfig();
  const system = buildSystemPrompt(chatConfig, store.getStyles());
  const messages = [...(history || []).slice(-40), { role: 'user', text: incomingText.trim() }];
  try {
    const text = c.meta.kind === 'anthropic'
      ? await anthropicChat({ ...c, system, messages })
      : await openAIChat({ ...c, system, messages });
    lastLlmError = null;
    return text;
  } catch (err) {
    lastLlmError = {
      message: err.message || 'LLM generation failed',
      provider: c.meta.label,
      model: c.model,
      timestamp: Date.now(),
    };
    throw err;
  }
}

async function testConnection(overrides = {}) {
  const c = activeConfig(overrides);
  const system = 'You are a test assistant.';
  const messages = [{ role: 'user', text: 'Reply with exactly: OK' }];
  const text = c.meta.kind === 'anthropic'
    ? await anthropicChat({ ...c, system, messages })
    : await openAIChat({ ...c, system, messages });
  return { ok: true, reply: text.trim().slice(0, 200), provider: c.meta.label, model: c.model };
}

module.exports = {
  PROVIDERS,
  activeConfig,
  generateReply,
  testConnection,
  buildSystemPrompt,
  listModels,
  getLastLlmError,
  clearLastLlmError,
};
