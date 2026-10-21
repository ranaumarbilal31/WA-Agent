const fs = require('fs');
const path = require('path');
const config = require('./config');

// Tiny JSON store — $0, no DB needed. data/db.json
function dbPath() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return path.join(config.dataDir, 'db.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
  } catch {
    return { chats: {}, histories: {}, settings: {}, styles: {} };
  }
}

function save(db) {
  fs.writeFileSync(dbPath(), JSON.stringify(db, null, 2));
}

function getChatConfig(chatId) {
  const db = load();
  const raw = db.chats[chatId];
  if (!raw) {
    return { mode: 'off', styleId: 'preset:friendly', replyDelayMin: null, replyDelayMax: null, sendBlueTick: null };
  }
  const styleId = raw.styleId || (raw.presetKey ? 'preset:' + raw.presetKey : 'preset:friendly');
  return { mode: 'off', replyDelayMin: null, replyDelayMax: null, sendBlueTick: null, ...raw, styleId };
}

function setChatConfig(chatId, cfg) {
  const db = load();
  const current = getChatConfig(chatId);
  db.chats[chatId] = { ...current, ...cfg };
  save(db);
}

function setChatConfigBulk(chatIds, cfg) {
  const db = load();
  for (const id of chatIds) {
    const current = getChatConfig(id);
    db.chats[id] = { ...current, ...cfg };
  }
  save(db);
}

// ---------- Named styles library ----------
// style = { id, name, kind: 'custom', profile, createdAt }
function getStyles() {
  const db = load();
  return Object.values(db.styles || {}).sort((a, b) => a.name.localeCompare(b.name));
}

function saveStyle(name, profile) {
  const db = load();
  db.styles = db.styles || {};
  const id = 'custom:' + Date.now().toString(36);
  const style = { id, name: (name || 'My style').slice(0, 60), kind: 'custom', profile, createdAt: Date.now() };
  db.styles[id] = style;
  save(db);
  return style;
}

function deleteStyle(id) {
  const db = load();
  if (db.styles && db.styles[id]) {
    delete db.styles[id];
    // chats using it fall back to friendly
    for (const cid of Object.keys(db.chats)) {
      if (db.chats[cid].styleId === id) db.chats[cid].styleId = 'preset:friendly';
    }
    save(db);
    return true;
  }
  return false;
}

function pushHistory(chatId, role, text) {
  const db = load();
  const h = db.histories[chatId] || [];
  h.push({ role, text, ts: Date.now() });
  db.histories[chatId] = h.slice(-80); // keep last 80 turns
  save(db);
}

function getHistory(chatId) {
  return load().histories[chatId] || [];
}

// ---------- Settings (BYOK + reply delay + blue tick) ----------
const DEFAULT_SETTINGS = {
  llmProvider: 'gemini',     // gemini | openai | anthropic | xai | openrouter | ollama | lmstudio | custom
  llmApiKey: '',             // BYOK: user's own key, overrides env
  llmBaseURL: '',            // override endpoint (custom provider / local)
  llmModel: '',              // override model (empty = provider default)
  providerKeys: {},          // keys remembered per provider
  providerModels: {},        // models remembered per provider
  replyDelayMin: 8,          // seconds
  replyDelayMax: 25,         // seconds
  sendBlueTick: false,       // false = silent ghost mode (gray ticks), true = send read receipts (blue ticks)
};

function getSettings() {
  const db = load();
  const raw = db.settings || {};
  const s = {
    ...DEFAULT_SETTINGS,
    ...raw,
    providerKeys: { ...(DEFAULT_SETTINGS.providerKeys), ...(raw.providerKeys || {}) },
    providerModels: { ...(DEFAULT_SETTINGS.providerModels), ...(raw.providerModels || {}) },
  };
  // migrate old gemini-only settings
  if (!s.llmApiKey && raw.geminiApiKey) { s.llmProvider = 'gemini'; s.llmApiKey = raw.geminiApiKey; }
  if (!s.llmModel && raw.geminiModel) s.llmModel = raw.geminiModel;
  if (s.llmApiKey && !s.providerKeys[s.llmProvider]) {
    s.providerKeys[s.llmProvider] = s.llmApiKey;
  }
  return s;
}

function setSettings(patch) {
  const db = load();
  const current = getSettings();
  const updated = { ...current, ...patch };
  if (patch.providerKeys) {
    updated.providerKeys = { ...current.providerKeys, ...patch.providerKeys };
  }
  if (patch.providerModels) {
    updated.providerModels = { ...current.providerModels, ...patch.providerModels };
  }
  if (patch.llmApiKey !== undefined) {
    const prov = updated.llmProvider || 'gemini';
    updated.providerKeys[prov] = patch.llmApiKey;
  }
  if (patch.llmModel !== undefined && patch.llmModel) {
    const prov = updated.llmProvider || 'gemini';
    updated.providerModels[prov] = patch.llmModel;
  }
  db.settings = updated;
  save(db);
  return db.settings;
}

function clearProviderKey(provider) {
  const db = load();
  const current = getSettings();
  const updated = { ...current };
  if (updated.providerKeys) {
    delete updated.providerKeys[provider];
  }
  if (updated.llmProvider === provider) {
    updated.llmApiKey = '';
  }
  db.settings = updated;
  save(db);
  return db.settings;
}

function clearAllKeys() {
  const db = load();
  const current = getSettings();
  const updated = { ...current, providerKeys: {}, llmApiKey: '' };
  db.settings = updated;
  save(db);
  return db.settings;
}

module.exports = {
  getChatConfig,
  setChatConfig,
  setChatConfigBulk,
  pushHistory,
  getHistory,
  load,
  getSettings,
  setSettings,
  clearProviderKey,
  clearAllKeys,
  getStyles,
  saveStyle,
  deleteStyle,
};
