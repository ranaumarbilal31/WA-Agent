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
    return { chats: {}, histories: {}, settings: {} };
  }
}

function save(db) {
  fs.writeFileSync(dbPath(), JSON.stringify(db, null, 2));
}

function getChatConfig(chatId) {
  const db = load();
  return db.chats[chatId] || { mode: 'off', styleType: 'preset', presetKey: 'friendly', customProfile: null };
}

function setChatConfig(chatId, cfg) {
  const db = load();
  db.chats[chatId] = { ...getChatConfig(chatId), ...cfg };
  save(db);
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
  geminiApiKey: '',          // BYOK: user's own key, overrides env
  geminiModel: '',           // override, else config default
  replyDelayMin: 8,          // seconds
  replyDelayMax: 25,         // seconds
};

function getSettings() {
  const db = load();
  return { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
}

function setSettings(patch) {
  const db = load();
  db.settings = { ...getSettings(), ...patch };
  save(db);
  return db.settings;
}

module.exports = { getChatConfig, setChatConfig, pushHistory, getHistory, load, getSettings, setSettings };
