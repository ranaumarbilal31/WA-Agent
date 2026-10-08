/**
 * Style analyzer: builds a "you" profile from exported chats.
 * - Accepts parsed messages (from parser.js), possibly from group chats.
 * - Filters to only the user's messages via identifiers (names/numbers/aliases).
 * - If no identifiers given, falls back to the most frequent sender.
 * - Returns stats + few-shot examples for prompting (no fine-tuning, $0).
 */

function normalize(s) {
  return (s || '').trim().toLowerCase();
}

function detectMe(messages, identifiers) {
  const ids = new Set((identifiers || []).map(normalize));
  if (ids.size) {
    const counts = {};
    for (const m of messages) {
      if (ids.has(normalize(m.sender))) counts[m.sender] = (counts[m.sender] || 0) + 1;
    }
    const found = Object.keys(counts);
    if (found.length) return new Set(found.map(normalize));
  }
  // fallback: most frequent sender
  const freq = {};
  for (const m of messages) freq[m.sender] = (freq[m.sender] || 0) + 1;
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
  return new Set(top ? [normalize(top[0])] : []);
}

function analyze(messages, identifiers) {
  const meSet = detectMe(messages, identifiers);
  const mine = messages.filter(m => meSet.has(normalize(m.sender)));
  const texts = mine.map(m => m.text).filter(t => t && t.length);

  const totalChars = texts.reduce((a, t) => a + t.length, 0);
  const avgLen = texts.length ? Math.round(totalChars / texts.length) : 0;
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const emojiCount = texts.filter(t => emojiRe.test(t)).length;
  const questionCount = texts.filter(t => t.includes('?')).length;
  const lowerStart = texts.filter(t => t[0] && t[0] === t[0].toLowerCase() && /[a-z]/.test(t[0])).length;

  // pick diverse short examples for few-shot
  const examples = [];
  const seen = new Set();
  for (const t of texts) {
    if (t.length > 200 || seen.has(t)) continue;
    seen.add(t);
    examples.push(t);
    if (examples.length >= 60) break;
  }

  return {
    messageCount: texts.length,
    totalMessages: messages.length,
    avgLength: avgLen,
    emojiRate: texts.length ? +(emojiCount / texts.length).toFixed(2) : 0,
    questionRate: texts.length ? +(questionCount / texts.length).toFixed(2) : 0,
    lowercaseStartRate: texts.length ? +(lowerStart / texts.length).toFixed(2) : 0,
    examples,
    instructions:
      `You reply like this person. Avg reply length ~${avgLen} chars. ` +
      `Emoji usage rate ${Math.round((texts.length ? emojiCount / texts.length : 0) * 100)}%. ` +
      (lowerStart > texts.length / 2 ? 'Often starts lowercase, casual. ' : 'Usually proper capitalization. ') +
      'Match their rhythm, slang, and greeting/closing habits from the examples. Never mention you are an AI.',
  };
}

module.exports = { analyze, detectMe };
