require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Find system Chrome/Chromium so we don't need puppeteer's ~150MB download.
// CHROME_PATH env var wins; otherwise try common install locations.
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Chromium', 'Application', 'chrome.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return candidates.find(p => p && fs.existsSync(p)) || '';
}

module.exports = {
  port: process.env.PORT || 3000,
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  chromePath: findChrome(),
  // identifiers for "me" in exports, comma separated
  myIdentifiers: (process.env.MY_IDENTIFIERS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
  dataDir: path.join(__dirname, '..', 'data'),
};
