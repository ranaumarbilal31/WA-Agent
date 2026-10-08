require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  // identifiers for "me" in exports, comma separated
  myIdentifiers: (process.env.MY_IDENTIFIERS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
  dataDir: require('path').join(__dirname, '..', 'data'),
};
