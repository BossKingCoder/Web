# Shaurya's Workspace

A personal dashboard site — study tools, games, an AI assistant, and a live multiplayer section (real-time chat, DMs, voice calls, and turn-based games against actual people) — with a full guest-access mode.

**Live at:** [shauryashub.dev](https://shauryashub.dev)

## What's in here

- `Code/index.html` — the site itself. A single-file frontend (vanilla JS, no framework) covering Study Hub, Entertainment Hub, Game Hub, Utilities Hub, Challenges Hub, and Multiplayer Hub.
- `workers/site-lock-worker.js` — the Cloudflare Worker that gatekeeps the whole site: login, the `/admin` panel, guest management, maintenance mode, and the real-time infrastructure (a Durable Object-backed system).
- `workers/gemini-proxy-worker.js` — a small Worker that proxies requests to the Gemini API, so the API key never touches the browser.
- `Code/wrangler.jsonc` — deployment config for `workers/site-lock-worker.js` (KV binding, Durable Object binding/migration).

## Stack

- **Frontend:** vanilla HTML/CSS/JS, hosted on GitHub Pages
- **Edge/backend:** Cloudflare Workers + KV + Durable Objects
- **Real-time:** WebSockets (chat, DMs, live games) and WebRTC (voice calls, via Cloudflare Calls for TURN)
- **AI:** Google Gemini, via a proxy Worker
- **Email:** Resend

## Deploying

`Code/index.html` is the site frontend file.

`workers/site-lock-worker.js` requires Wrangler (not the plain dashboard editor), since it uses a Durable Object. See `Read/SETUP.md` for the full setup from scratch.

`workers/gemini-proxy-worker.js` can be deployed via the Cloudflare dashboard's code editor directly.
