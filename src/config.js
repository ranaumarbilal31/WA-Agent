require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Find a usable browser for WhatsApp.
// NOTE: whatsapp-web.js runs on puppeteer-core, which only drives
// Chromium-based browsers (Chrome, Edge, Brave, Opera, Vivaldi).
// Firefox is detected nowhere here on purpose — it can't be automated by it.
// CHROME_PATH env var wins; otherwise try common install locations.
function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return { path: process.env.CHROME_PATH, name: 'Custom' };
  }
  const list = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env.LOCALAPPDATA || '';
    const j = (...a) => path.join(...a);
    list.push(
      [j(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome'],
      [j(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome'],
      [j(la, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome'],
      [j(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Edge'],
      [j(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Edge'],
      [j(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'Brave'],
      [j(la, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'Brave'],
      [j(la, 'Programs', 'Opera', 'opera.exe'), 'Opera'],
      [j(la, 'Opera Software', 'Opera Stable', 'opera.exe'), 'Opera'],
      [j(la, 'Vivaldi', 'Application', 'vivaldi.exe'), 'Vivaldi']
    );
  } else if (process.platform === 'darwin') {
    list.push(
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome'],
      ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Edge'],
      ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave'],
      ['/Applications/Opera.app/Contents/MacOS/Opera', 'Opera'],
      ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi', 'Vivaldi']
    );
  } else {
    const { execSync } = require('child_process');
    for (const [bin, name] of [
      ['google-chrome', 'Chrome'], ['chromium', 'Chromium'],
      ['chromium-browser', 'Chromium'], ['brave-browser', 'Brave'],
      ['microsoft-edge', 'Edge'], ['opera', 'Opera'], ['vivaldi', 'Vivaldi'],
    ]) {
      try {
        const p = execSync(`which ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (p) list.push([p, name]);
      } catch { /* not installed */ }
    }
  }
  const found = list.find(([p]) => p && fs.existsSync(p));
  return found ? { path: found[0], name: found[1] } : null;
}

module.exports = {
  port: process.env.PORT || 3000,
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  browser: findBrowser(),
  // identifiers for "me" in exports, comma separated
  myIdentifiers: (process.env.MY_IDENTIFIERS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
  dataDir: path.join(__dirname, '..', 'data'),
};
