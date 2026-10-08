const express = require('express');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const config = require('./config');
const store = require('./store');
const { parseChat } = require('./style/parser');
const { analyze } = require('./style/analyzer');
const { generateReply, testConnection, activeConfig, PROVIDERS } = require('./llm');
const { PRESETS } = require('./style/presets');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- WhatsApp client ----------
// Uses your own browser if found (no 150MB download); set CHROME_PATH in .env to override.
if (config.browser) console.log(`Using system browser: ${config.browser.name} (${config.browser.path})`);
const wa = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    args: ['--no-sandbox'],
    ...(config.browser ? { executablePath: config.browser.path } : {}),
  },
});
let qrText = '';
let waReady = false;
let waInfo = null;
let waError = '';

wa.on('qr', qr => { qrText = qr; waError = ''; qrcode.generate(qr, { small: true }); });
wa.on('ready', () => { waReady = true; waInfo = wa.info; qrText = ''; waError = ''; console.log('WhatsApp ready'); });
wa.on('auth_failure', m => { waError = 'WhatsApp login failed: ' + m; });
wa.on('disconnected', reason => { waReady = false; waError = 'WhatsApp disconnected: ' + reason; });

wa.on('message', async msg => {
  try {
    if (msg.fromMe) return;
    const chatId = msg.from;
    const cfg = store.getChatConfig(chatId);
    if (cfg.mode === 'off') return;
    const history = store.getHistory(chatId);
    store.pushHistory(chatId, 'user', msg.body);
    if (cfg.mode === 'draft') {
      console.log(`[DRAFT for ${chatId}]: would reply, waiting approval`);
      return;
    }
    // Human-like random delay so replies don't look bot-timed.
    // Per-chat override wins, else global settings range.
    const s = store.getSettings();
    const minS = Math.max(0, Number(cfg.replyDelayMin ?? s.replyDelayMin));
    const maxS = Math.max(minS, Number(cfg.replyDelayMax ?? s.replyDelayMax));
    const delayMs = (minS + Math.random() * (maxS - minS)) * 1000;
    console.log(`Replying to ${chatId} in ${(delayMs / 1000).toFixed(1)}s`);
    const chat = await msg.getChat();
    try { await chat.sendStateTyping(); } catch {}
    await new Promise(r => setTimeout(r, delayMs));
    try { await chat.clearState(); } catch {}
    const reply = await generateReply(cfg, history, msg.body);
    store.pushHistory(chatId, 'model', reply);
    await msg.reply(reply);
  } catch (e) {
    console.error('reply error', e.message);
  }
});

// ---------- API ----------
app.get('/api/status', (req, res) => {
  const s = store.getSettings();
  const llm = activeConfig();
  res.json({
    waReady, waInfo: waInfo ? { pushname: waInfo.pushname, wid: waInfo.wid } : null,
    qrAvailable: !!qrText, waError,
    llmReady: !!(llm.apiKey || !llm.meta.needsKey) && !!llm.model,
    llmLabel: llm.meta.label, llmModel: llm.model,
    browser: config.browser,
    presets: Object.keys(PRESETS),
  });
});

// Public LLM provider metadata for the Setup UI (no secrets).
app.get('/api/providers', (req, res) => {
  const out = {};
  for (const [k, p] of Object.entries(PROVIDERS)) {
    out[k] = { label: p.label, kind: p.kind, baseURL: p.baseURL, models: p.models, needsKey: p.needsKey, keyUrl: p.keyUrl, keyHint: p.keyHint };
  }
  res.json(out);
});

app.post('/api/llm-test', async (req, res) => {
  try {
    res.json(await testConnection());
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/qr', async (req, res) => {
  if (!qrText) return res.json({ qr: '', qrImage: '' });
  try {
    const qrImage = await QRCode.toDataURL(qrText, { width: 280, margin: 1 });
    res.json({ qrImage });
  } catch (e) {
    res.json({ qr: '', qrImage: '', error: e.message });
  }
});

app.get('/api/chats', async (req, res) => {
  if (!waReady) return res.json({ chats: [] });
  const chats = await wa.getChats();
  res.json({
    chats: chats.slice(0, 50).map(c => ({
      id: c.id._serialized, name: c.name || c.id.user, isGroup: c.isGroup,
      config: store.getChatConfig(c.id._serialized),
    })),
  });
});

app.post('/api/chat-config', (req, res) => {
  const { chatId, mode, styleType, presetKey, replyDelayMin, replyDelayMax } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const patch = { mode, styleType, presetKey };
  if (replyDelayMin !== undefined) patch.replyDelayMin = replyDelayMin === '' ? null : Number(replyDelayMin);
  if (replyDelayMax !== undefined) patch.replyDelayMax = replyDelayMax === '' ? null : Number(replyDelayMax);
  store.setChatConfig(chatId, patch);
  res.json({ ok: true });
});

// ---------- Settings: BYOK (any LLM) + reply delay range ----------
function maskKey(k) { return k ? '••••••' + k.slice(-4) : ''; }

app.get('/api/settings', (req, res) => {
  const s = store.getSettings();
  res.json({ ...s, llmApiKey: maskKey(s.llmApiKey) });
});

app.post('/api/settings', (req, res) => {
  const { llmProvider, llmApiKey, llmBaseURL, llmModel, replyDelayMin, replyDelayMax } = req.body;
  const patch = {};
  if (llmProvider !== undefined && PROVIDERS[llmProvider]) patch.llmProvider = llmProvider;
  if (llmApiKey !== undefined) patch.llmApiKey = llmApiKey.trim(); // empty clears it
  if (llmBaseURL !== undefined) patch.llmBaseURL = llmBaseURL.trim();
  if (llmModel !== undefined) patch.llmModel = llmModel.trim();
  if (replyDelayMin !== undefined) patch.replyDelayMin = Math.max(0, Number(replyDelayMin) || 0);
  if (replyDelayMax !== undefined) patch.replyDelayMax = Math.max(patch.replyDelayMin ?? store.getSettings().replyDelayMin, Number(replyDelayMax) || 0);
  const saved = store.setSettings(patch);
  res.json({ ok: true, settings: { ...saved, llmApiKey: maskKey(saved.llmApiKey) } });
});

// Upload exported chat -> analyze -> save as custom profile for a chat (or global)
app.post('/api/upload-style', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    let text;
    const name = req.file.originalname.toLowerCase();
    if (name.endsWith('.zip')) {
      const zip = new AdmZip(req.file.buffer);
      const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.txt'));
      if (!entry) return res.status(400).json({ error: 'no .txt found in zip' });
      text = entry.getData().toString('utf8');
    } else {
      text = req.file.buffer.toString('utf8');
    }
    const messages = parseChat(text);
    if (!messages.length) return res.status(400).json({ error: 'could not parse any messages' });
    const identifiers = (req.body.identifiers || '')
      .split(',').map(s => s.trim()).filter(Boolean)
      .concat(config.myIdentifiers);
    const profile = analyze(messages, identifiers);
    const { chatId } = req.body;
    if (chatId) store.setChatConfig(chatId, { styleType: 'custom', customProfile: profile });
    res.json({ ok: true, profile: { ...profile, examples: profile.examples.slice(0, 10) }, messageCount: profile.messageCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/history/:chatId', (req, res) => {
  res.json({ history: store.getHistory(req.params.chatId).slice(-20) });
});

const PORT = config.port;
app.listen(PORT, () => console.log(`WA-Agent on http://localhost:${PORT}`));
// WhatsApp connection is optional for the web UI: if it fails (no network,
// missing Chrome, etc.), the setup pages still work and show the error.
wa.initialize().catch(e => {
  waError = e.message;
  console.error('WhatsApp init failed (web UI still running):', e.message);
});
