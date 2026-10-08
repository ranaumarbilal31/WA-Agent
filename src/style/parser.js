/**
 * Robust WhatsApp chat export parser.
 * Handles Android/iOS, .txt/.zip (zip handled by caller), and many date formats:
 *  - [M/D/YY, H:MM:SS AM] Name: message
 *  - [DD/MM/YYYY, HH:MM:SS] Name: message
 *  - M/D/YY, H:MM AM - Name: message
 *  - DD.MM.YY, HH:MM - Name: message
 *  - YYYY-MM-DD, HH:MM - Name: message
 * Continuation lines (no timestamp) are appended to the previous message.
 * System messages (no "Name:") are skipped.
 */

const PATTERNS = [
  // [10/8/26, 2:48:56 PM] Name: msg  |  [08/10/2026, 14:48:56] Name: msg
  /^\[(\d{1,4}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)\]\s?(.*)$/,
  // 10/8/26, 2:48 PM - Name: msg  |  08.10.2026, 14:48 - Name: msg
  /^(\d{1,4}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)\s+-\s(.*)$/,
];

function parseLine(line) {
  for (const re of PATTERNS) {
    const m = line.match(re);
    if (!m) continue;
    const rest = m[3];
    const sep = rest.indexOf(': ');
    if (sep === -1) return { system: true, text: rest }; // system msg, no sender
    return {
      date: m[1],
      time: m[2],
      sender: rest.slice(0, sep).trim(),
      text: rest.slice(sep + 2),
      system: false,
    };
  }
  return null; // continuation line
}

function parseChat(text) {
  const messages = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const parsed = parseLine(line);
    if (parsed === null) {
      // continuation of previous message
      if (current) current.text += '\n' + line;
      continue;
    }
    if (parsed.system) continue; // skip system messages
    if (parsed.text === '<Media omitted>') continue;
    current = { sender: parsed.sender, text: parsed.text, date: parsed.date, time: parsed.time };
    messages.push(current);
  }
  return messages;
}

module.exports = { parseChat, parseLine };
