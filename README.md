# WA-Agent

WhatsApp agent that replies in **your style**. Near-zero cost.

- WhatsApp via `whatsapp-web.js` (QR login, uses your own Chrome/Edge/Brave/Opera — no 150MB download)
- Any AI via BYOK: **Gemini, OpenAI, Claude, Grok, OpenRouter** (one key for Claude, Meta Llama, Grok…), **Ollama / LM Studio** local models (free), or any OpenAI-compatible endpoint
- Per-chat styles: Professional, Business, Friendly, Slang, Short — or Custom from your exported chats
- Group-chat aware: custom analyzer extracts only *your* messages
- Human-like timing: random delay + typing indicator per reply

## Quick start

1. `npm install`
2. `npm start`
3. Open http://localhost:3000 — finish the 5-step Setup:
   1. Scan the WhatsApp QR (one-time)
   2. Pick your AI provider, paste your key, **Load models** to see what's available, hit **Test connection**
   3. Set reply timing (random delay range)
   4. Export a WhatsApp chat (**Without media**), **name the style**, upload it — you'll be taken to Chats to choose which chats use it
   5. Assign styles per chat in the Chats tab (bulk: all / groups / personal)

## Styles

- **Tones (built-in):** Professional, Business, Manager, Customer Support, Sales, Formal, Friendly, Slang, Short & Crisp
- **My styles:** upload any chat export, name it, and apply it to any chats. The analyzer learns only *your* messages, even in group chats.

No paid key needed — free tiers (Gemini AI Studio, OpenRouter free models) and local models (Ollama) work.

## AI providers

| Provider | Key | Notes |
|---|---|---|
| Google Gemini | AI Studio (free) | default, 1M context |
| OpenAI | platform.openai.com | |
| Anthropic Claude | console.anthropic.com | native API |
| xAI Grok | console.x.ai | |
| OpenRouter | openrouter.ai (free tier) | one key → Claude, Meta Llama, Grok, … |
| Ollama | none | local, e.g. `llama3.1:8b` at `localhost:11434` |
| LM Studio | none | local at `localhost:1234` |
| Custom | yours | any `…/v1/chat/completions` endpoint |

## Export a WhatsApp chat

WhatsApp > Chat > ⋮ > More > Export chat > **Without media**.
You get `_chat.txt` (or `.zip`). Upload it in Setup step 4.

Supported varieties: Android/iOS, `.txt`/`.zip`, date formats
`[M/D/YY, H:MM:SS AM]`, `DD/MM/YYYY, HH:MM`, with/without seconds,
12h/24h, system messages skipped.

## Notes

- **BYOK**: each user pastes their own key in Setup → stored in `data/db.json`, never logged. Works with any provider above.
- **Reply timing**: global random delay range (default 8–25s) + optional per-chat override. Shows "typing…" during the wait.
- **Browser**: auto-detects Chrome, Edge, Brave, Opera, Vivaldi. Firefox can't be automated by whatsapp-web.js, so it's skipped. Override with `CHROME_PATH`.

## Deploy

Dockerized. Mount volumes for `.wwebjs_auth` (WhatsApp session) and `data` (settings):

```
docker build -t wa-agent .
docker run -p 3000:3000 -v wa-auth:/app/.wwebjs_auth -v wa-data:/app/data wa-agent
```

Fly.io / Render free tier works fine.
