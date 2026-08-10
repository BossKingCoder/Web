# Shaurya's Hub

A personal dashboard site — study tools, games, an AI assistant, and a live multiplayer section (real-time chat, DMs, voice calls, and turn-based games against actual people) — with a full guest-access admin system, self-service access requests, and branded email notifications built on top.

**Live at:** [shauryashub.dev](https://shauryashub.dev)

## What's in here

The repo is organized into three folders:

- **`Code/`** — the site itself and its deployment config
  - `index.html` — the frontend. A single-file site (vanilla JS, no framework) covering Study Hub, Entertainment Hub, Game Hub, Utilities Hub, Challenges Hub, and Multiplayer Hub
  - `wrangler.jsonc` — deployment config for `site-lock-worker.js` (KV binding, Durable Object binding/migration)
  - `CNAME` — custom domain config for GitHub Pages
  - `favicon.ico`, `email-logo.png` — site and email branding assets

- **`workers/`** — the Cloudflare Workers powering the backend
  - `site-lock-worker.js` — gatekeeps everything: login, the `/admin` panel, guest management, the public `/signup` request-access flow (with email OTP verification), maintenance mode, the panic button, and the real-time infrastructure (a Durable Object powering Live Chat, DMs, voice calls, and live multiplayer games)
  - `gemini-proxy-worker.js` — proxies requests to the Gemini API, so the API key never touches the browser

- **`Read/`** — documentation
  - `README.md` — this file
  - `SETUP.md` — private reference: secret names, redeploy steps, troubleshooting

## Features

**Core site** — Study Hub, Entertainment Hub, Game Hub, Utilities Hub, Challenges Hub, an AI Assistant, and a Time Capsule feature that emails a message to a future date.

**Multiplayer Hub** — Live Chat, Direct Messages (with typing indicators and read receipts), voice calls (WebRTC via Cloudflare Calls), turn-based live games (Tic-Tac-Toe, Connect 4, Word Chain), and a shared Whiteboard — all against real people, not AI, powered by a single Durable Object.

**Access control** — a login gate in front of the whole site, an admin panel for creating/revoking/restricting guest logins, hub-level access restrictions per guest, auto-expiring logins, and a self-service `/signup` page where people can request access (verified via a one-time email code) for the owner to approve or deny.

**Safety features** — a panic button (email + typed-phrase confirmed) that locks the whole site down instantly, an owner password-change flow confirmed via email, and maintenance mode.

**Notifications** — every meaningful account event (access granted, denied, revoked, deleted, or the hub closing) can email the guest automatically, using a consistently branded HTML email template across all outgoing mail.

## Stack

- **Frontend:** vanilla HTML/CSS/JS, hosted on GitHub Pages
- **Edge/backend:** Cloudflare Workers + KV + Durable Objects
- **Real-time:** WebSockets (chat, DMs, live games) and WebRTC (voice calls, via Cloudflare Calls for TURN)
- **AI:** Google Gemini, via a proxy Worker
- **Email:** Resend

## Deploying

`index.html` and its branding assets (at the repo root) deploy via GitHub Pages automatically on push to `main`. The copies inside `Code/` are for organization/reference — the root copies are the ones actually live.

`workers/site-lock-worker.js` requires Wrangler (not the plain dashboard editor), since it uses a Durable Object:
```
cd <folder containing site-lock-worker.js and wrangler.jsonc>
npx wrangler deploy
```

`workers/gemini-proxy-worker.js` can be deployed via the Cloudflare dashboard's code editor directly.

## About the root-level files

`CNAME`, `index.html`, `README.md`, and `email-logo.png` also exist as copies at the repo root, outside the respective folder — this is intentional, not leftover clutter. GitHub Pages serves from the repo root by default, and the Worker's public routes (`/favicon.ico`, `/email-logo.png`) are hardcoded to root-level paths too, since browsers and email clients request them directly without going through any folder. The organized copies inside `Code/` are for readability when browsing the repo; the root copies are what's actually being served live.

## Credit

This was a for-fun personal project. I (Shaurya) came up with the idea, every feature, and all the content — Claude (Anthropic) wrote the actual code, working from my direction throughout.
