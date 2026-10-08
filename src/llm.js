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
    models: ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'],
    needsKey: true, keyUrl: 'https://aistudio.google.com', keyHint: 'Free key from Google AI Studio',
  },
  openai: {
    label: 'OpenAI', kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-5-mini', 'gpt-5', 'gpt-4.1-mini'],
    needsKey: true, keyUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic Claude', kind: 'anthropic',
    models: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6'],
    needsKey: true, keyUrl: 'https://console.anthropic.com',
  },
  xai: {
    label: 'xAI Grok', kind: 'openai',
    baseURL: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3-mini', 'grok-3'],
    needsKey: true, keyUrl: 'https://console.x.ai',
  },
  openrouter: {
    label: 'OpenRouter (Claude, Llama/Meta, Grok + more)', kind: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4', 'x-ai/grok-4', 'meta-llama/llama-4-maverick', 'google/gemini-2.5-flash'],
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

function activeConfig() {
  const s = store.getSettings();
  const p = PROVIDERS[s.llmProvider] || PROVIDERS.gemini;
  return {
    provider: s.llmProvider in PROVIDERS ? s.llmProvider : 'gemini',
    meta: p,
    apiKey: s.llmApiKey || config.geminiApiKey || '',
    baseURL: (s.llmBaseURL || p.baseURL || '').replace(/\/$/, ''),
    model: s.llmModel || p.models[0] || '',
  };
}

async function openAIChat({ baseURL, apiKey, model, system, messages }) {
  if (!baseURL) throw new Error('No API endpoint set for this provider.');
  if (!model) throw new Error('No model set — pick or type a model id.');
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system },
        ...messages.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text }))],
      temperature: 0.9, max_tokens: 1024,
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 220)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty reply from model.');
  return text;
}

async function anthropicChat({ apiKey, model, system, messages }) {
  if (!apiKey) throw new Error('Anthropic needs an API key.');
  if (!model) throw new Error('No model set — pick or type a model id.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model, max_tokens: 1024, system,
      messages: messages.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text })),
    }),
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${(await res.text()).slice(0, 220)}`);
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  if (!text) throw new Error('Empty reply from model.');
  return text;
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
 */
async function listModels({ provider, apiKey, baseURL }) {
  const meta = PROVIDERS[provider];
  if (!meta) throw new Error('Unknown provider.');
  if (meta.kind === 'anthropic') {
    if (!apiKey) throw new Error('Paste your API key first.');
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    if (!res.ok) throw new Error(`Could not list models (${res.status}). Check the key.`);
    const data = await res.json();
    return (data.data || []).map(m => m.id);
  }
  const url = (baseURL || meta.baseURL || '').replace(/\/$/, '');
  if (!url) throw new Error('No API endpoint set.');
  const headers = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${url}/models`, { headers });
  if (!res.ok) throw new Error(`Could not list models (${res.status}). Check the endpoint/key.`);
  const data = await res.json();
  return (data.data || []).map(m => String(m.id).replace(/^models\//, '')).sort();
}

async function generateReply(chatConfig, history, incomingText) {
  const c = activeConfig();
  const system = buildSystemPrompt(chatConfig, store.getStyles());
  const messages = [...history.slice(-40), { role: 'user', text: incomingText }];
  if (c.meta.kind === 'anthropic') return anthropicChat({ ...c, system, messages });
  return openAIChat({ ...c, system, messages });
}

async function testConnection() {
  const c = activeConfig();
  const system = 'You are a test assistant.';
  const messages = [{ role: 'user', text: 'Reply with exactly: OK' }];
  const text = c.meta.kind === 'anthropic'
    ? await anthropicChat({ ...c, system, messages })
    : await openAIChat({ ...c, system, messages });
  return { ok: true, reply: text.slice(0, 200), provider: c.meta.label, model: c.model };
}

module.exports = { PROVIDERS, activeConfig, generateReply, testConnection, buildSystemPrompt, listModels };
