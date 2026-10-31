const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const AdmZip = require('adm-zip');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const config = require('./config');
const store = require('./store');
const { parseChat } = require('./style/parser');
const { analyze } = require('./style/analyzer');
const { generateReply, testConnection, activeConfig, PROVIDERS, listModels, getLastLlmError, clearLastLlmError } = require('./llm');
const { PRESETS } = require('./style/presets');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- WhatsApp client ----------
// Persistent session directory: saved in project root .wwebjs_auth so scanning is only required once.
const authDir = path.join(__dirname, '..', '.wwebjs_auth');
if (config.browser) console.log(`Using system browser: ${config.browser.name} (${config.browser.path})`);
const wa = new Client({
  authStrategy: new LocalAuth({ dataPath: authDir }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-gpu',
    ],
    ...(config.browser ? { executablePath: config.browser.path } : {}),
  },
});

let qrText = '';
let waReady = false;
let waInfo = null;
let waError = '';
let waStatus = 'initializing';

wa.on('qr', qr => {
  qrText = qr;
  waError = '';
  waStatus = 'qr';
  qrcode.generate(qr, { small: true });
});

wa.on('authenticated', () => {
  waStatus = 'authenticated';
  waError = '';
  console.log('WhatsApp authenticated');
});

wa.on('loading_screen', (percent, message) => {
  waStatus = `loading:${percent}%`;
  console.log(`WhatsApp loading: ${percent}% (${message || ''})`);
});

wa.on('ready', () => {
  waReady = true;
  waStatus = 'ready';
  waInfo = wa.info;
  qrText = '';
  waError = '';
  console.log('WhatsApp ready');
});

wa.on('auth_failure', m => {
  waReady = false;
  waStatus = 'auth_failure';
  waError = 'WhatsApp login failed: ' + m;
  console.error(waError);
});

wa.on('disconnected', reason => {
  waReady = false;
  waStatus = 'disconnected';
  waError = 'WhatsApp disconnected: ' + reason;
  console.warn(waError);
});

async function sendTypingSafe(client, chatId) {
  try {
    if (client.pupPage) {
      await client.pupPage.evaluate(async (id) => {
        try {
          if (window.WWebJS && window.WWebJS.sendChatstate) {
            await window.WWebJS.sendChatstate('typing', id);
          }
        } catch {}
      }, chatId);
    }
  } catch {}
}

async function clearTypingSafe(client, chatId) {
  try {
    if (client.pupPage) {
      await client.pupPage.evaluate(async (id) => {
        try {
          if (window.WWebJS && window.WWebJS.sendChatstate) {
            await window.WWebJS.sendChatstate('stop', id);
          }
        } catch {}
      }, chatId);
    }
  } catch {}
}

async function sendSeenSafe(client, chatId) {
  try {
    if (client && client.pupPage) {
      await client.pupPage.evaluate(async (id) => {
        try {
          if (window.WWebJS && window.WWebJS.sendSeen) {
            await window.WWebJS.sendSeen(id);
          }
        } catch {}
      }, chatId);
    }
  } catch {}
}

/**
 * Pulses the typing state every 3.5s so WhatsApp client doesn't auto-hide "typing..."
 * after the default ~5s timeout.
 */
async function pulseTyping(client, chatId, durationMs) {
  await sendTypingSafe(client, chatId);
  if (durationMs <= 3500) {
    await new Promise(r => setTimeout(r, durationMs));
    return;
  }
  const start = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - start >= durationMs) {
      clearInterval(timer);
    } else {
      sendTypingSafe(client, chatId);
    }
  }, 3500);
  await new Promise(r => setTimeout(r, durationMs));
  clearInterval(timer);
}

wa.on('message', async msg => {
  try {
    if (msg.fromMe) return;
    if (!msg.body || !msg.body.trim()) return; // ignore empty/non-text messages
    const chatId = msg.from;
    const cfg = store.getChatConfig(chatId);
    if (cfg.mode === 'off') return;
    const history = store.getHistory(chatId);
    store.pushHistory(chatId, 'user', msg.body);
    if (cfg.mode === 'draft') {
      console.log(`[DRAFT for ${chatId}]: would reply, waiting approval`);
      return;
    }

    const s = store.getSettings();
    const shouldBlueTick = cfg.sendBlueTick !== null && cfg.sendBlueTick !== undefined
      ? Boolean(cfg.sendBlueTick)
      : Boolean(s.sendBlueTick);

    // If Blue Tick is enabled: brief noticing/reading delay, then send read receipt
    if (shouldBlueTick) {
      console.log(`Sending read receipt (blue tick) for ${chatId}`);
      await new Promise(r => setTimeout(r, 1800));
      await sendSeenSafe(wa, chatId);
    }

    // Evaluate active Logic Rules (Scammer Trap, Abuse Defense, Custom Keywords)
    const activeRules = store.getRules().filter(r => r.enabled);
    let matchedRule = null;
    const textLower = (msg.body || '').toLowerCase();

    for (const r of activeRules) {
      if (r.chatScope && r.chatScope !== 'all' && Array.isArray(r.chatScope) && !r.chatScope.includes(chatId)) {
        continue;
      }
      if (r.triggerType === 'keywords' && r.keywords && r.keywords.length) {
        if (r.keywords.some(kw => textLower.includes(kw))) {
          matchedRule = r;
          break;
        }
      }
    }

    if (matchedRule) {
      console.log(`[Rule Matched]: "${matchedRule.name}" (action: ${matchedRule.action}) for message in ${chatId}`);
      if (matchedRule.action === 'flag_question') {
        store.saveQuestion({
          chatId,
          chatName: msg._data?.notifyName || (chatId.split('@')[0]),
          question: msg.body,
          sender: msg.author || msg.from,
          detectedTopic: `Rule Flagged: ${matchedRule.name}`,
        });
        console.log(`[Rule Action]: flagged question in Questions folder, silent without auto-reply`);
        return;
      }
    }

    // Call LLM with active configuration, rules, and memory context
    let reply = '';
    let needInfo = null;
    try {
      const options = {
        chatId,
        modeOverride: matchedRule ? matchedRule.action : null,
        customPrompt: matchedRule ? matchedRule.customPrompt : '',
      };

      if (matchedRule && matchedRule.action === 'fixed_reply' && matchedRule.fixedReplyText) {
        reply = matchedRule.fixedReplyText;
      } else {
        const res = await generateReply(cfg, history, msg.body, options);
        reply = res.reply;
        needInfo = res.needInfo;
      }
    } catch (llmErr) {
      console.error(`LLM reply generation failed for ${chatId}:`, llmErr.message);
      return;
    }

    // If model detected an unverified or sensitive question, file it in the Questions queue
    if (needInfo) {
      store.saveQuestion({
        chatId,
        chatName: msg._data?.notifyName || (chatId.split('@')[0]),
        question: msg.body,
        sender: msg.author || msg.from,
        detectedTopic: needInfo,
      });
      console.log(`[Question Filed in Ques Folder]: "${needInfo}" from ${chatId}`);
    }

    if (!reply || !reply.trim()) {
      console.log(`Empty or null reply generated for ${chatId}`);
      return;
    }

    // Realistic human cadence:
    const isAsap = cfg.replyAsap !== null && cfg.replyAsap !== undefined
      ? Boolean(cfg.replyAsap)
      : Boolean(s.replyAsap ?? true);

    if (isAsap) {
      // ASAP mode: Reply is generated; pulse typing for a brief natural duration (2.0s - 4.5s) then send
      const typingDurationMs = Math.max(2000, Math.min(4500, Math.round(reply.trim().length * 30)));
      console.log(`Cadence [ASAP] for ${chatId}: pulsing typing ${(typingDurationMs / 1000).toFixed(1)}s -> send (${reply.trim().length} chars)`);
      await pulseTyping(wa, chatId, typingDurationMs);
    } else {
      // Deliberate delay mode: target delay up to replyDelayMax
      const maxS = Math.max(4, Number(cfg.replyDelayMax ?? s.replyDelayMax ?? 15));
      const targetDelayMs = (3 + Math.random() * (maxS - 3)) * 1000;
      const typingDurationMs = Math.max(2500, Math.min(15000, Math.round(reply.trim().length * 50)));
      const thinkingPauseMs = Math.max(300, targetDelayMs - typingDurationMs);
      console.log(`Cadence [DELAY] for ${chatId}: thinking ${(thinkingPauseMs / 1000).toFixed(1)}s -> typing ${(typingDurationMs / 1000).toFixed(1)}s -> send (${reply.trim().length} chars)`);
      if (thinkingPauseMs > 0) {
        await new Promise(r => setTimeout(r, thinkingPauseMs));
      }
      await pulseTyping(wa, chatId, typingDurationMs);
    }

    // Phase 3: Instant dispatch at the conclusion of typing
    store.pushHistory(chatId, 'model', reply);
    console.log(`Sending reply to ${chatId}: "${reply}"`);
    try {
      await msg.reply(reply);
    } catch (replyErr) {
      console.warn('msg.reply warning, falling back to wa.sendMessage:', replyErr.message);
      await wa.sendMessage(chatId, reply);
    }
    await clearTypingSafe(wa, chatId);
    console.log(`Successfully replied to ${chatId}`);
  } catch (e) {
    console.error('reply error:', e.message);
  }
});

/**
 * Safely retrieve WhatsApp chats without crashing on LID migration
 * or hanging on bulk group metadata updates.
 * Sorts chats by most recent message timestamp (like WhatsApp Web).
 */
async function getChatsSafe(client) {
  // 1. Direct page memory extraction: fast, resilient, and sorted by activity
  if (client.pupPage) {
    try {
      const pageChats = await client.pupPage.evaluate(() => {
        try {
          const col = window.require ? window.require('WAWebCollections') : null;
          const ChatCollection = col?.Chat || window.Store?.Chat;
          if (!ChatCollection) return null;
          const list = ChatCollection.getModelsArray ? ChatCollection.getModelsArray() : (ChatCollection.models || []);
          if (!list || !list.length) return null;
          const msgCol = window.require ? window.require('WAWebCollections')?.Msg : null;
          return list.map(c => {
            try {
              const id = c.id?._serialized || (typeof c.id === 'string' ? c.id : (c.id?.user ? `${c.id.user}@${c.id.server || 'c.us'}` : ''));
              const name = c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || c.id?.user || 'Unknown';
              const isGroup = Boolean(c.isGroup || (c.id && (c.id.server === 'g.us' || String(c.id._serialized || '').endsWith('@g.us'))) || c.groupMetadata);
              const timestamp = c.t ? c.t * 1000 : 0;
              const unreadCount = c.unreadCount || 0;
              let lastMsg = '';
              if (c.lastReceivedKey && msgCol) {
                const m = msgCol.get ? msgCol.get(c.lastReceivedKey._serialized) : null;
                if (m && m.body) lastMsg = m.body;
              }
              return { id, name, isGroup, timestamp, unreadCount, lastMsg };
            } catch {
              return null;
            }
          }).filter(c => c && c.id);
        } catch {
          return null;
        }
      });
      if (Array.isArray(pageChats) && pageChats.length > 0) {
        return pageChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      }
    } catch (e) {
      console.warn('Direct chat extraction note:', e.message);
    }
  }

  // 2. Fallback to client.getChats() with a 10s timeout
  try {
    const raw = await Promise.race([
      client.getChats(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('wa.getChats() timed out after 10s')), 10000)),
    ]);
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map(c => ({
        id: c.id?._serialized || String(c.id),
        name: c.name || c.formattedTitle || c.id?.user || 'Unknown',
        isGroup: Boolean(c.isGroup),
        timestamp: c.timestamp ? c.timestamp * 1000 : 0,
        unreadCount: c.unreadCount || 0,
        lastMsg: c.lastMessage?.body || '',
      })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }
  } catch (e) {
    console.warn('wa.getChats() fallback note:', e.message);
  }

  // 3. Fallback to cached chats from db.json
  const db = store.load();
  const cachedIds = Object.keys(db.chats || {});
  if (cachedIds.length > 0) {
    return cachedIds.map(id => ({
      id,
      name: id.replace(/@.*$/, ''),
      isGroup: id.endsWith('@g.us'),
      timestamp: 0,
      unreadCount: 0,
      lastMsg: '',
    }));
  }

  return [];
}

// ---------- API ----------
app.get('/api/status', (req, res) => {
  const s = store.getSettings();
  const llm = activeConfig();
  res.json({
    waReady,
    waStatus,
    waInfo: waInfo ? { pushname: waInfo.pushname, wid: waInfo.wid } : null,
    sessionSaved: !!(waReady && waInfo),
    qrAvailable: !!qrText,
    waError,
    sendBlueTick: Boolean(s.sendBlueTick),
    lastLlmError: getLastLlmError(),
    llmReady: !!(llm.apiKey || !llm.meta.needsKey) && !!llm.model,
    llmLabel: llm.meta.label,
    llmModel: llm.model,
    llmProvider: llm.provider,
    browser: config.browser,
    presets: Object.keys(PRESETS),
  });
});

app.post('/api/wa-logout', async (req, res) => {
  try {
    waReady = false;
    waStatus = 'disconnected';
    waInfo = null;
    qrText = '';
    await wa.logout();
    res.json({ ok: true });
    setTimeout(() => {
      wa.initialize().catch(e => {
        waError = e.message;
        waStatus = 'error';
      });
    }, 1500);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full reset: terminates browser, wipes lockfiles/session, and generates fresh QR
app.post('/api/wa-reset', async (req, res) => {
  try {
    console.log('Resetting WhatsApp client and clearing session locks...');
    waReady = false;
    waStatus = 'resetting';
    waInfo = null;
    qrText = '';
    waError = '';

    try {
      if (wa && wa.pupBrowser) {
        await wa.destroy();
      }
    } catch (e) {
      console.warn('wa.destroy notice during reset:', e.message);
    }

    const sessionDir = path.join(authDir, 'session');
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (rmErr) {
      console.warn('Session dir removal notice:', rmErr.message);
    }

    res.json({ ok: true, status: 'resetting' });

    setTimeout(() => {
      wa.initialize().catch(e => {
        waError = e.message;
        waStatus = 'error';
        console.error('Re-init after reset failed:', e.message);
      });
    }, 1200);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove saved API key for a provider
app.post('/api/settings/clear-key', (req, res) => {
  try {
    const { provider } = req.body || {};
    const curSettings = store.getSettings();
    const targetProv = provider || curSettings.llmProvider;
    store.clearProviderKey(targetProv);
    clearLastLlmError();
    res.json({ ok: true, provider: targetProv });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    const { provider, apiKey, baseURL, model } = req.body || {};
    const overrides = {};
    if (provider) overrides.provider = provider;
    if (apiKey !== undefined && apiKey !== '') overrides.apiKey = apiKey.trim();
    if (baseURL !== undefined && baseURL !== '') overrides.baseURL = baseURL.trim();
    if (model !== undefined && model !== '') overrides.model = model.trim();
    res.json(await testConnection(overrides));
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
  if (!waReady) return res.json({ chats: [], waReady: false, status: 'waiting_for_wa' });
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const chats = await getChatsSafe(wa);
      if (chats.length > 0) {
        const customs = Object.fromEntries(store.getStyles().map(s => [s.id, s.name]));
        return res.json({
          chats: chats.slice(0, 300).map(c => {
            const cfg = store.getChatConfig(c.id);
            const styleName = cfg.styleId.startsWith('custom:')
              ? (customs[cfg.styleId] || 'custom')
              : (PRESETS[cfg.styleId.slice(7)]?.label || cfg.styleId);
            return {
              id: c.id,
              name: c.name || c.id,
              isGroup: c.isGroup,
              timestamp: c.timestamp || 0,
              unreadCount: c.unreadCount || 0,
              lastMsg: c.lastMsg || '',
              config: { ...cfg, styleName },
            };
          }),
        });
      }
      await new Promise(r => setTimeout(r, 1200));
    } catch (e) {
      lastErr = e.message || String(e);
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  res.json({ chats: [], error: lastErr || 'could not fetch chats from WhatsApp' });
});

async function getMessagesSafe(client, chatId, limit = 40) {
  if (!client || !client.pupPage) return [];
  try {
    const msgs = await client.pupPage.evaluate(async (id, maxCount) => {
      try {
        const widFactory = window.require ? window.require('WAWebWidFactory') : null;
        const wid = widFactory ? widFactory.createWid(id) : null;
        const collections = window.require ? window.require('WAWebCollections') : null;
        let chat = collections?.Chat?.get ? collections.Chat.get(wid || id) : null;
        if (!chat && window.require) {
          const findAction = window.require('WAWebFindChatAction');
          if (findAction && findAction.findOrCreateLatestChat) {
            const found = await findAction.findOrCreateLatestChat(wid || id);
            chat = found?.chat;
          }
        }
        if (!chat && window.Store?.Chat) {
          chat = window.Store.Chat.get(id);
        }
        if (!chat || !chat.msgs) return [];

        let list = chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : (chat.msgs.models || []);
        list = list.filter(m => !m.isNotification);

        if (list.length > maxCount) {
          list = list.slice(-maxCount);
        }

        return list.map(m => {
          const authorId = m.author ? (m.author._serialized || m.author) : '';
          const fromId = m.from ? (m.from._serialized || m.from) : '';
          let body = m.body || m.caption || '';
          if (!body && (m.type === 'image' || m.type === 'video' || m.type === 'document' || m.type === 'audio' || m.type === 'sticker' || m.type === 'ptt')) {
            body = m.filename ? `[${(m.type || 'file').toUpperCase()}: ${m.filename}]` : `[${(m.type || 'media').toUpperCase()}]`;
          }
          return {
            id: m.id?._serialized || String(m.id || Math.random()),
            fromMe: Boolean(m.id?.fromMe ?? m.fromMe),
            body: body,
            timestamp: m.t ? m.t * 1000 : (m.timestamp ? m.timestamp * 1000 : Date.now()),
            author: authorId || fromId,
            type: m.type || 'chat',
            hasMedia: Boolean(m.hasMedia || m.type === 'image' || m.type === 'document' || m.type === 'video'),
            caption: m.caption || '',
            filename: m.filename || '',
          };
        });
      } catch (err) {
        return [];
      }
    }, chatId, limit);
    return Array.isArray(msgs) ? msgs : [];
  } catch {
    return [];
  }
}

// Fetch recent conversation messages for a chat (like a normal WhatsApp window)
app.get('/api/chats/:chatId/messages', async (req, res) => {
  const chatId = req.params.chatId;
  if (!waReady) {
    const h = store.getHistory(chatId).map(x => ({
      fromMe: x.role === 'model',
      body: x.text,
      timestamp: x.ts || Date.now(),
    }));
    return res.json({ messages: h });
  }

  // 1. Direct headless page evaluation (bypasses WAWebLidMigrationUtils on group chats)
  try {
    const msgs = await getMessagesSafe(wa, chatId, 40);
    if (msgs && msgs.length > 0) {
      return res.json({ messages: msgs });
    }
  } catch {}

  // 2. Library fallback for standard 1-on-1 chats
  try {
    const chat = await wa.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: 30 });
    const formatted = msgs.map(m => ({
      id: m.id._serialized,
      fromMe: Boolean(m.fromMe),
      body: m.body || (m.hasMedia ? '[Media]' : ''),
      timestamp: m.timestamp ? m.timestamp * 1000 : Date.now(),
      author: m.author || m.from,
    }));
    if (formatted.length > 0) {
      return res.json({ messages: formatted });
    }
  } catch {}

  // 3. Fallback to local agent history
  const h = store.getHistory(chatId).map(x => ({
    fromMe: x.role === 'model',
    body: x.text,
    timestamp: x.ts || Date.now(),
  }));
  return res.json({ messages: h });
});

// Analyze this chat in 1 click directly from sent messages in WhatsApp
app.post('/api/chats/:chatId/analyze-style', async (req, res) => {
  const chatId = req.params.chatId;
  const { name } = req.body || {};
  try {
    const msgs = await getMessagesSafe(wa, chatId, 100);
    if (!msgs || !msgs.length) {
      return res.status(400).json({ error: 'No recent messages found in this chat to analyze.' });
    }
    const myMsgs = msgs.filter(m => m.fromMe && m.body && m.body.trim().length > 0);
    if (myMsgs.length < 2) {
      return res.status(400).json({
        error: `Only found ${myMsgs.length} message(s) from you in this chat. Send a few more messages or export chat to train.`
      });
    }

    const formatted = msgs
      .filter(m => m.body && m.body.trim())
      .map(m => ({
        sender: m.fromMe ? 'me' : (m.author || 'contact'),
        text: m.body.trim(),
        date: m.timestamp ? new Date(m.timestamp) : new Date(),
      }));

    const profile = analyze(formatted, ['me']);
    if (!profile.messageCount) {
      return res.status(400).json({ error: 'Could not extract style traits from messages.' });
    }

    const fallbackName = (chatId.split('@')[0] || 'Chat').replace(/[^\w\s-]/g, '');
    const styleName = (name || `Style: ${fallbackName}`).slice(0, 50);
    const saved = store.saveStyle(styleName, profile);
    store.setChatConfig(chatId, { styleId: saved.id });

    res.json({
      ok: true,
      style: saved,
      messageCount: profile.messageCount,
      avgLength: profile.avgLength,
      emojiRate: profile.emojiRate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to analyze chat style' });
  }
});

// HTML sanitizer for website link knowledge base extraction
function stripHtml(html) {
  return (html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Knowledge Base API
app.get('/api/knowledge', (req, res) => {
  res.json({ knowledge: store.getKnowledge() });
});

app.post('/api/knowledge', async (req, res) => {
  try {
    const { id, title, type, url, content } = req.body || {};
    let finalContent = (content || '').trim();

    if (type === 'url' && url) {
      let fetchUrl = url.trim();
      if (!/^https?:\/\//i.test(fetchUrl)) fetchUrl = 'https://' + fetchUrl;
      try {
        const resp = await fetch(fetchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        const extracted = stripHtml(html);
        if (extracted && extracted.length > 20) {
          finalContent = extracted.slice(0, 15000); // up to 15,000 chars of clean readable text
        }
      } catch (fetchErr) {
        if (!finalContent) {
          finalContent = `[URL: ${fetchUrl}] (Could not automatically scrape content: ${fetchErr.message})`;
        }
      }
    }

    if (!finalContent && !url) {
      return res.status(400).json({ error: 'Please enter a website link or policy/pricing content.' });
    }

    const item = store.saveKnowledge({
      id,
      title: title || (type === 'url' ? url : 'Knowledge Note'),
      type: type === 'url' ? 'url' : 'text',
      url: url || '',
      content: finalContent,
    });

    res.json({ ok: true, item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/knowledge/:id', (req, res) => {
  const ok = store.deleteKnowledge(req.params.id);
  res.json({ ok });
});

app.post('/api/chat-config', (req, res) => {
  const { chatId, chatIds, mode, styleId, replyDelayMax, replyAsap, sendBlueTick, goal, keepGoing, knowledgeIds } = req.body;
  const ids = chatIds && chatIds.length ? chatIds : (chatId ? [chatId] : []);
  if (!ids.length) return res.status(400).json({ error: 'chatId(s) required' });
  const patch = {};
  if (mode !== undefined) patch.mode = mode;
  if (styleId !== undefined) patch.styleId = styleId;
  if (replyDelayMax !== undefined) patch.replyDelayMax = replyDelayMax === '' || replyDelayMax === null ? null : Number(replyDelayMax);
  if (replyAsap !== undefined) patch.replyAsap = replyAsap === '' || replyAsap === null ? null : Boolean(replyAsap);
  if (sendBlueTick !== undefined) patch.sendBlueTick = sendBlueTick === '' || sendBlueTick === null ? null : Boolean(sendBlueTick);
  if (goal !== undefined) patch.goal = String(goal || '').trim();
  if (keepGoing !== undefined) patch.keepGoing = Boolean(keepGoing);
  if (knowledgeIds !== undefined) patch.knowledgeIds = Array.isArray(knowledgeIds) ? knowledgeIds : [];
  store.setChatConfigBulk(ids, patch);
  res.json({ ok: true, updated: ids.length });
});

// ---------- Named styles ----------
app.get('/api/styles', (req, res) => {
  const labels = {};
  for (const [k, p] of Object.entries(PRESETS)) labels[k] = p.label;
  res.json({ styles: store.getStyles(), presets: Object.keys(PRESETS), presetLabels: labels });
});

app.delete('/api/styles/:id', (req, res) => {
  res.json({ ok: store.deleteStyle(req.params.id) });
});

// ---------- LLM ----------
app.post('/api/llm-models', async (req, res) => {
  try {
    const { provider, apiKey, baseURL } = req.body || {};
    const models = await listModels({ provider, apiKey: (apiKey || '').trim(), baseURL: (baseURL || '').trim() });
    res.json({ ok: true, models });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// One-off outbound message from the user's own WhatsApp number.
app.post('/api/send-message', async (req, res) => {
  const { chatId, text } = req.body || {};
  if (!waReady) return res.status(400).json({ error: 'WhatsApp is not connected yet — pair it in Setup first.' });
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const msg = (text || '').trim();
  if (!msg) return res.status(400).json({ error: 'Message text is empty' });
  if (msg.length > 4000) return res.status(400).json({ error: 'Message too long (max 4000 characters)' });
  try {
    await wa.sendMessage(chatId, msg);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Outbound media attachment message (images, documents, audio, videos)
app.post('/api/send-media', upload.single('file'), async (req, res) => {
  try {
    if (!waReady) return res.status(400).json({ error: 'WhatsApp is not connected yet.' });
    if (!req.file) return res.status(400).json({ error: 'No media file provided.' });
    const chatId = req.body.chatId;
    if (!chatId) return res.status(400).json({ error: 'chatId required.' });
    const caption = (req.body.caption || '').trim();

    const base64 = req.file.buffer.toString('base64');
    const media = new MessageMedia(req.file.mimetype, base64, req.file.originalname);

    await wa.sendMessage(chatId, media, { caption: caption || undefined });

    const historyEntry = caption
      ? `[File: ${req.file.originalname}] ${caption}`
      : `[File: ${req.file.originalname}]`;
    store.pushHistory(chatId, 'model', historyEntry);

    res.json({ ok: true, filename: req.file.originalname });
  } catch (err) {
    console.error('send-media error:', err);
    res.status(500).json({ error: err.message || 'Failed to send attachment' });
  }
});

// ---------- Logic Base / Trigger Rules API ----------
app.get('/api/rules', (req, res) => {
  res.json({ rules: store.getRules() });
});

app.post('/api/rules', (req, res) => {
  try {
    const rule = store.saveRule(req.body);
    res.json({ ok: true, rule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/rules/:id', (req, res) => {
  res.json({ ok: store.deleteRule(req.params.id) });
});

// ---------- Questions Queue API (Unanswered / Sensitive) ----------
app.get('/api/questions', (req, res) => {
  res.json({ questions: store.getQuestions(req.query.status) });
});

app.post('/api/questions', (req, res) => {
  try {
    const { chatId, chatName, topic, questionText, triggerMessage } = req.body || {};
    if (!questionText && !topic) {
      return res.status(400).json({ error: 'questionText or topic is required.' });
    }
    const q = store.saveQuestion({
      chatId,
      chatName,
      topic: topic || 'User Flagged Question',
      questionText: questionText || topic,
      triggerMessage: triggerMessage || questionText,
    });
    res.json({ ok: true, question: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/questions/:id/answer', async (req, res) => {
  try {
    const { answer, accessLevel, topic, sendReply } = req.body || {};
    if (!answer || !answer.trim()) return res.status(400).json({ error: 'Answer is required.' });

    const result = store.resolveQuestion(req.params.id, {
      answer: answer.trim(),
      accessLevel: accessLevel || 'universal',
      topic: topic || 'Learned Fact',
      makeMemory: true,
    });
    if (!result) return res.status(404).json({ error: 'Question not found.' });

    if (sendReply && result.question.chatId && waReady) {
      await wa.sendMessage(result.question.chatId, answer.trim());
      store.pushHistory(result.question.chatId, 'model', answer.trim());
    }

    res.json({ ok: true, question: result.question, memory: result.memory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/questions/:id', (req, res) => {
  res.json({ ok: store.deleteQuestion(req.params.id) });
});

// ---------- Memory Folder API ----------
app.get('/api/memories', (req, res) => {
  res.json({ memories: store.getMemories(req.query.chatId) });
});

app.post('/api/memories', (req, res) => {
  try {
    const mem = store.saveMemory(req.body);
    res.json({ ok: true, memory: mem });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/memories/:id', (req, res) => {
  res.json({ ok: store.deleteMemory(req.params.id) });
});

// ---------- Settings: BYOK (any LLM) + reply delay range ----------
function maskKey(k) { return k ? '••••••' + k.slice(-4) : ''; }

app.get('/api/settings', (req, res) => {
  const s = store.getSettings();
  const maskedKeys = {};
  for (const [k, v] of Object.entries(s.providerKeys || {})) {
    maskedKeys[k] = maskKey(v);
  }
  res.json({
    ...s,
    llmApiKey: maskKey(s.llmApiKey),
    providerKeys: maskedKeys,
  });
});

app.post('/api/settings', (req, res) => {
  const { llmProvider, llmApiKey, llmBaseURL, llmModel, replyDelayMax, replyAsap, sendBlueTick } = req.body;
  const patch = {};
  if (llmProvider !== undefined && PROVIDERS[llmProvider]) patch.llmProvider = llmProvider;
  if (llmApiKey !== undefined) patch.llmApiKey = llmApiKey.trim(); // empty clears it
  if (llmBaseURL !== undefined) patch.llmBaseURL = llmBaseURL.trim();
  if (llmModel !== undefined) patch.llmModel = llmModel.trim();
  if (replyDelayMax !== undefined) patch.replyDelayMax = Math.max(3, Number(replyDelayMax) || 15);
  if (replyAsap !== undefined) patch.replyAsap = Boolean(replyAsap);
  if (sendBlueTick !== undefined) patch.sendBlueTick = Boolean(sendBlueTick);
  const saved = store.setSettings(patch);
  res.json({ ok: true, settings: { ...saved, llmApiKey: maskKey(saved.llmApiKey) } });
});

// Upload exported chat -> analyze -> save as a NAMED style in the library.
app.post('/api/upload-style', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const name = (req.body.name || '').trim().slice(0, 60) || 'My style';
    let text;
    const fname = req.file.originalname.toLowerCase();
    if (fname.endsWith('.zip')) {
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
    if (!profile.messageCount) return res.status(400).json({ error: 'found no messages from you — check the name/number you entered' });
    const style = store.saveStyle(name, profile);
    res.json({ ok: true, styleId: style.id, name: style.name, messageCount: profile.messageCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/history/:chatId', (req, res) => {
  res.json({ history: store.getHistory(req.params.chatId).slice(-20) });
});

const PORT = config.port;
app.listen(PORT, () => console.log(`WA-Agent on http://localhost:${PORT}`));

// WhatsApp initialization
wa.initialize().catch(e => {
  waError = e.message;
  waStatus = 'error';
  console.error('WhatsApp init failed (web UI still running):', e.message);
});

// Graceful shutdown: ensures Chrome session locks are released and data is flushed
let isExiting = false;
async function cleanExit() {
  if (isExiting) return;
  isExiting = true;
  console.log('Shutting down: preserving WhatsApp session...');
  try {
    if (wa && wa.pupBrowser) {
      await wa.destroy();
    }
  } catch {}
  process.exit(0);
}
process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);
