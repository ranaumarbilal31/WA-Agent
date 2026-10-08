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
  let db = load();
  const raw = db.chats[chatId] || {};
  // migrate old shape {mode, styleType, presetKey, customProfile} -> {mode, styleId}
  let styleId = raw.styleId;
  if (!styleId) {
    if (raw.styleType === 'custom' && raw.customProfile) {
      styleId = saveStyle('My style', raw.customProfile).id;
      db = load(); // reload: saveStyle wrote its own copy
    } else {
      styleId = 'preset:' + (raw.presetKey || 'friendly');
    }
    db.chats[chatId] = { ...raw, styleId };
    delete db.chats[chatId].styleType;
    delete db.chats[chatId].presetKey;
    delete db.chats[chatId].customProfile;
    save(db);
  }
  return { mode: 'off', replyDelayMin: null, replyDelayMax: null, ...db.chats[chatId] };
}

function setChatConfig(chatId, cfg) {
  const db = load();
  db.chats[chatId] = { ...getChatConfig(chatId), ...cfg };
  save(db);
}

function setChatConfigBulk(chatIds, cfg) {
  const db = load();
  for (const id of chatIds) db.chats[id] = { ...getChatConfig(id), ...cfg };
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

// ---------- Settings (BYOK + reply delay) ----------
const DEFAULT_SETTINGS = {
  llmProvider: 'gemini',     // gemini | openai | anthropic | xai | openrouter | ollama | lmstudio | custom
  llmApiKey: '',             // BYOK: user's own key, overrides env
  llmBaseURL: '',            // override endpoint (custom provider / local)
  llmModel: '',              // override model (empty = provider default)
  replyDelayMin: 8,          // seconds
  replyDelayMax: 25,         // seconds
};

function getSettings() {
  const db = load();
  const raw = db.settings || {};
  const s = { ...DEFAULT_SETTINGS, ...raw };
  // migrate old gemini-only settings
  if (!s.llmApiKey && raw.geminiApiKey) { s.llmProvider = 'gemini'; s.llmApiKey = raw.geminiApiKey; }
  if (!s.llmModel && raw.geminiModel) s.llmModel = raw.geminiModel;
  return s;
}

function setSettings(patch) {
  const db = load();
  db.settings = { ...getSettings(), ...patch };
  save(db);
  return db.settings;
}

module.exports = { getChatConfig, setChatConfig, setChatConfigBulk, pushHistory, getHistory, load, getSettings, setSettings, getStyles, saveStyle, deleteStyle };
