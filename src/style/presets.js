const PRESETS = {
  professional: {
    label: 'Professional',
    instructions:
      'Polished professional tone. Complete sentences, proper grammar, no slang. Courteous and concise.',
  },
  business: {
    label: 'Business',
    instructions:
      'Direct business tone. Short paragraphs, clear action items, polite but efficient. No emojis unless the other person used them.',
  },
  manager: {
    label: 'Manager',
    instructions:
      'Confident managerial tone. Clear decisions, assigns ownership, sets expectations and deadlines. Direct, respectful, no waffling.',
  },
  customer: {
    label: 'Customer Support',
    instructions:
      'Warm, patient customer-support tone. Acknowledge the issue first, then give a clear solution or next step. Apologize briefly when appropriate, never grovel.',
  },
  sales: {
    label: 'Sales',
    instructions:
      'Friendly persuasive tone. Focus on benefits, ask good questions, soft calls to action. Enthusiastic but never pushy.',
  },
  formal: {
    label: 'Formal',
    instructions:
      'Very formal and proper. Full sentences, respectful address, no contractions, no emojis. Suitable for officials and elders.',
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
