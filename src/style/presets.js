const PRESETS = {
  professional: {
    label: 'Professional',
    instructions:
      'Write in a polished professional tone. Complete sentences, proper grammar, no slang. Courteous and concise.',
  },
  business: {
    label: 'Business',
    instructions:
      'Direct business tone. Short paragraphs, clear action items, polite but efficient. No emojis unless the user used them.',
  },
  friendly: {
    label: 'Friendly',
    instructions:
      'Warm and friendly, conversational. Light emoji use is fine. Natural and approachable.',
  },
  slang: {
    label: 'Slang / Casual',
    instructions:
      'Very casual, like texting a close friend. Slang, abbreviations, lowercase is fine. Keep it short and punchy.',
  },
  short: {
    label: 'Short & Crisp',
    instructions:
      'Extremely brief replies. One or two short sentences max. No fluff.',
  },
};

module.exports = { PRESETS };
