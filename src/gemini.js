const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config');
const store = require('./store');
const { PRESETS } = require('./style/presets');

function apiKey() {
  // BYOK first (per-user key from Setup UI), env as fallback
  return store.getSettings().geminiApiKey || config.geminiApiKey;
}

function modelName() {
  return store.getSettings().geminiModel || config.geminiModel;
}

function client() {
  const key = apiKey();
  if (!key) throw new Error('No Gemini API key set — add yours in Setup (BYOK). Free AI Studio keys work.');
  return new GoogleGenerativeAI(key);
}

/**
 * Build the system prompt for a chat.
 * chatConfig: { styleType: 'preset'|'custom', presetKey, customProfile }
 */
function buildSystemPrompt(chatConfig) {
  let styleBlock = '';
  if (chatConfig.styleType === 'custom' && chatConfig.customProfile) {
    const p = chatConfig.customProfile;
    styleBlock =
      `STYLE: custom (learned from user's own messages).\n${p.instructions}\n` +
      `Example messages in their style:\n${p.examples.slice(0, 20).map(e => '- ' + e).join('\n')}`;
  } else {
    const preset = PRESETS[chatConfig.presetKey] || PRESETS.friendly;
    styleBlock = `STYLE: ${preset.label}.\n${preset.instructions}`;
  }
  return (
    `You are a WhatsApp reply assistant. Reply as the user would reply. ` +
    `Keep replies natural for WhatsApp: short, no headers, no bullet lists unless asked.\n${styleBlock}`
  );
}

/**
 * Generate a reply. history: [{role:'user'|'model', text}] — supports long chats
 * via Gemini's 1M context; we trim to the last ~40 turns to stay cheap.
 */
async function generateReply(chatConfig, history, incomingText) {
  const model = client().getGenerativeModel({ model: modelName() });
  const trimmed = history.slice(-40);
  const chat = model.startChat({
    systemInstruction: { role: 'system', parts: [{ text: buildSystemPrompt(chatConfig) }] },
    history: trimmed.map(h => ({
      role: h.role === 'model' ? 'model' : 'user',
      parts: [{ text: h.text }],
    })),
  });
  const result = await chat.sendMessage(incomingText);
  return result.response.text();
}

module.exports = { generateReply, buildSystemPrompt };
