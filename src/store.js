const fs = require('fs');
const path = require('path');
const config = require('./config');

// Tiny JSON store — $0, no DB needed. data/db.json
function dbPath() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return path.join(config.dataDir, 'db.json');
}

const DEFAULT_RULES = [
  {
    id: 'rule_scammer',
    name: 'Scammer Time-Waster (Scambait)',
    enabled: true,
    triggerType: 'keywords',
    keywords: ['crypto', 'forex investment', 'double your money', 'lottery winner', 'guaranteed profit', 'wire money', 'send giftcard', 'western union', 'urgent money'],
    action: 'scambait',
    customPrompt: '',
    fixedReplyText: '',
    chatScope: 'all',
  },
  {
    id: 'rule_abuse',
    name: 'Abuse & Dirty Words Defense (Roast)',
    enabled: true,
    triggerType: 'keywords',
    keywords: ['fuck', 'bitch', 'idiot', 'asshole', 'bastard', 'shut up', 'motherfucker', 'dick', 'cunt', 'stfu', 'f**k'],
    action: 'roast',
    customPrompt: '',
    fixedReplyText: '',
    chatScope: 'all',
  },
];

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(dbPath(), 'utf8'));
    if (!data.knowledge) data.knowledge = [];
    if (!data.rules || !data.rules.length) data.rules = DEFAULT_RULES;
    if (!data.questions) data.questions = [];
    if (!data.memories) data.memories = [];
    return data;
  } catch {
    return { chats: {}, histories: {}, settings: {}, styles: {}, knowledge: [], rules: DEFAULT_RULES, questions: [], memories: [] };
  }
}

function save(db) {
  if (!db.knowledge) db.knowledge = [];
  if (!db.rules) db.rules = [];
  if (!db.questions) db.questions = [];
  if (!db.memories) db.memories = [];
  fs.writeFileSync(dbPath(), JSON.stringify(db, null, 2));
}

function getChatConfig(chatId) {
  const db = load();
  const raw = db.chats[chatId];
  if (!raw) {
    return {
      mode: 'off',
      styleId: 'preset:friendly',
      replyDelayMax: null,
      replyAsap: null,
      sendBlueTick: null,
      goal: '',
      keepGoing: false,
      knowledgeIds: []
    };
  }
  const styleId = raw.styleId || (raw.presetKey ? 'preset:' + raw.presetKey : 'preset:friendly');
  return {
    mode: 'off',
    replyDelayMax: null,
    replyAsap: null,
    sendBlueTick: null,
    goal: '',
    keepGoing: false,
    knowledgeIds: [],
    ...raw,
    styleId
  };
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

// ---------- Settings (BYOK + reply delay + blue tick + ASAP) ----------
const DEFAULT_SETTINGS = {
  llmProvider: 'gemini',     // gemini | openai | anthropic | xai | openrouter | ollama | lmstudio | custom
  llmApiKey: '',             // BYOK: user's own key, overrides env
  llmBaseURL: '',            // override endpoint (custom provider / local)
  llmModel: '',              // override model (empty = provider default)
  providerKeys: {},          // keys remembered per provider
  providerModels: {},        // models remembered per provider
  replyAsap: true,           // true = reply as soon as LLM generates + brief typing, false = use delay
  replyDelayMax: 15,         // seconds (only used if replyAsap is false)
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

// ---------- Knowledge Base (site links, FAQs, policies, prices) ----------
function getKnowledge() {
  const db = load();
  return (db.knowledge || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function saveKnowledge({ id, title, type, url, content }) {
  const db = load();
  db.knowledge = db.knowledge || [];
  const now = Date.now();
  const existingIdx = id ? db.knowledge.findIndex(k => k.id === id) : -1;
  const item = {
    id: id || 'kb_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    title: (title || 'Knowledge Note').trim().slice(0, 100),
    type: type === 'url' ? 'url' : 'text',
    url: (url || '').trim(),
    content: (content || '').trim(),
    createdAt: existingIdx >= 0 ? db.knowledge[existingIdx].createdAt : now,
    updatedAt: now,
  };
  if (existingIdx >= 0) {
    db.knowledge[existingIdx] = item;
  } else {
    db.knowledge.unshift(item);
  }
  save(db);
  return item;
}

function deleteKnowledge(id) {
  const db = load();
  if (!db.knowledge) return false;
  const len = db.knowledge.length;
  db.knowledge = db.knowledge.filter(k => k.id !== id);
  if (db.knowledge.length !== len) {
    save(db);
    return true;
  }
  return false;
}

// ---------- Logic Base / Trigger Rules ----------
function getRules() {
  const db = load();
  return db.rules || [];
}

function saveRule(rule) {
  const db = load();
  db.rules = db.rules || [];
  const now = Date.now();
  const existingIdx = rule.id ? db.rules.findIndex(r => r.id === rule.id) : -1;

  let kws = [];
  if (Array.isArray(rule.keywords)) {
    kws = rule.keywords.map(k => String(k).trim().toLowerCase()).filter(Boolean);
  } else if (typeof rule.keywords === 'string') {
    kws = rule.keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  }

  const item = {
    id: rule.id || 'rule_' + now.toString(36) + Math.random().toString(36).slice(2, 5),
    name: (rule.name || 'Custom Rule').trim().slice(0, 80),
    enabled: rule.enabled !== undefined ? Boolean(rule.enabled) : true,
    triggerType: rule.triggerType || 'keywords',
    keywords: kws,
    action: rule.action || 'scambait', // scambait | roast | polite_decline | custom_prompt | fixed_reply | flag_question
    customPrompt: (rule.customPrompt || '').trim(),
    fixedReplyText: (rule.fixedReplyText || '').trim(),
    chatScope: rule.chatScope || 'all', // 'all' or array of chatIds
    updatedAt: now,
  };

  if (existingIdx >= 0) {
    db.rules[existingIdx] = item;
  } else {
    db.rules.push(item);
  }
  save(db);
  return item;
}

function deleteRule(id) {
  const db = load();
  if (!db.rules) return false;
  const len = db.rules.length;
  db.rules = db.rules.filter(r => r.id !== id);
  if (db.rules.length !== len) {
    save(db);
    return true;
  }
  return false;
}

// ---------- Questions Queue (Sensitive / Unknown questions) ----------
function getQuestions(status) {
  const db = load();
  let list = db.questions || [];
  if (status) list = list.filter(q => q.status === status);
  return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function saveQuestion(q) {
  const db = load();
  db.questions = db.questions || [];
  const now = Date.now();

  // Deduplicate if identical question is already pending for this chat
  const existingPending = db.questions.find(item =>
    item.status === 'pending' &&
    item.chatId === q.chatId &&
    item.question?.trim().toLowerCase() === q.question?.trim().toLowerCase()
  );
  if (existingPending) return existingPending;

  const item = {
    id: q.id || 'q_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    chatId: q.chatId || '',
    chatName: q.chatName || q.chatId || 'WhatsApp Contact',
    question: (q.question || q.questionText || '').trim(),
    sender: q.sender || q.chatName || 'Sender',
    detectedTopic: (q.detectedTopic || q.topic || 'Unanswered / Sensitive').trim(),
    status: q.status || 'pending', // 'pending' | 'answered' | 'dismissed'
    answer: q.answer || '',
    createdAt: now,
    resolvedAt: null,
  };
  db.questions.unshift(item);
  save(db);
  return item;
}

function resolveQuestion(id, { answer, accessLevel = 'universal', topic, makeMemory = true }) {
  const db = load();
  const q = (db.questions || []).find(item => item.id === id);
  if (!q) return null;

  q.status = 'answered';
  q.answer = (answer || '').trim();
  q.resolvedAt = Date.now();
  save(db);

  let memoryItem = null;
  if (makeMemory && q.answer) {
    memoryItem = saveMemory({
      fact: q.answer,
      topic: topic || q.detectedTopic || 'Learned Fact',
      accessLevel: accessLevel || 'universal',
      chatId: accessLevel === 'chat' ? q.chatId : null,
      sourceQuestionId: q.id,
    });
  }
  return { question: q, memory: memoryItem };
}

function deleteQuestion(id) {
  const db = load();
  if (!db.questions) return false;
  const len = db.questions.length;
  db.questions = db.questions.filter(q => q.id !== id);
  if (db.questions.length !== len) {
    save(db);
    return true;
  }
  return false;
}

// ---------- Memory Folder (Learned facts with access levels) ----------
function getMemories(chatId) {
  const db = load();
  const list = db.memories || [];
  if (!chatId) {
    return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  // Filter for a specific chat: Universal + specific Chat-only + Private directives
  return list.filter(m =>
    m.accessLevel === 'universal' ||
    m.accessLevel === 'private' ||
    (m.accessLevel === 'chat' && m.chatId === chatId)
  ).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function saveMemory(mem) {
  const db = load();
  db.memories = db.memories || [];
  const now = Date.now();
  const existingIdx = mem.id ? db.memories.findIndex(m => m.id === mem.id) : -1;

  const item = {
    id: mem.id || 'mem_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    fact: (mem.fact || mem.content || '').trim(),
    topic: (mem.topic || 'General Fact').trim().slice(0, 80),
    accessLevel: ['universal', 'chat', 'private'].includes(mem.accessLevel) ? mem.accessLevel : 'universal',
    chatId: mem.accessLevel === 'chat' ? (mem.chatId || null) : null,
    sourceQuestionId: mem.sourceQuestionId || null,
    createdAt: existingIdx >= 0 ? db.memories[existingIdx].createdAt : now,
    updatedAt: now,
  };

  if (existingIdx >= 0) {
    db.memories[existingIdx] = item;
  } else {
    db.memories.unshift(item);
  }
  save(db);
  return item;
}

function deleteMemory(id) {
  const db = load();
  if (!db.memories) return false;
  const len = db.memories.length;
  db.memories = db.memories.filter(m => m.id !== id);
  if (db.memories.length !== len) {
    save(db);
    return true;
  }
  return false;
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
  getKnowledge,
  saveKnowledge,
  deleteKnowledge,
  getRules,
  saveRule,
  deleteRule,
  getQuestions,
  saveQuestion,
  resolveQuestion,
  deleteQuestion,
  getMemories,
  saveMemory,
  deleteMemory,
};
