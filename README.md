# WA-Agent

WhatsApp agent that replies in **your style**. Near-zero cost.

- WhatsApp via `whatsapp-web.js` (QR login, no Meta approval, $0)
- Brain via Gemini API (free tier for prototyping, Flash-Lite ~$0.10/$0.40 per 1M tokens, 1M context for long chats)
- Per-chat styles: Professional, Business, Friendly, Slang, Short — or Custom from your exported chats
- Group-chat aware: custom analyzer extracts only *your* messages

## Quick start

1. `npm install`
2. `npm start`
3. Open http://localhost:3000/setup — scan QR, paste your **own Gemini API key** (BYOK — free AI Studio keys work, no paid key needed), set reply timing, assign styles per chat

No `.env` key needed — the key is saved per-user from the Setup page. `.env` `GEMINI_API_KEY` still works as a server default if set.

## Export a WhatsApp chat

WhatsApp > Chat > ⋮ > More > Export chat > **Without media**.
You get `_chat.txt` (or `.zip`). Upload it on the Setup page.

Supported varieties: Android/iOS, `.txt`/`.zip`, date formats
`[M/D/YY, H:MM:SS AM]`, `DD/MM/YYYY, HH:MM`, with/without seconds,
12h/24h, system messages skipped.

## Notes

- **BYOK**: each user pastes their own Gemini key in Setup → stored in `data/db.json`, never logged. Free-tier keys are fine.
- **Reply timing**: global random delay range (default 8–25s) + optional per-chat override. The bot shows "typing…" during the wait so it looks human.
- **Deploy**

Dockerized. Set `GEMINI_API_KEY` env, mount a volume for `.wwebjs_auth`
so the QR session persists:

```
docker build -t wa-agent .
docker run -p 3000:3000 -e GEMINI_API_KEY=... -v wa-auth:/app/.wwebjs_auth wa-agent
```

Fly.io / Render free tier works fine.
