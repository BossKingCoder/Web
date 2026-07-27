# Setup Reference

Private notes for redeploying this from scratch if needed. Lists what's required and where — never the actual secret values themselves.

## Domain & DNS

- Domain: `shauryashub.dev`, registered via Name.com
- Nameservers pointed to Cloudflare
- DNS: A records → GitHub Pages IPs, Cloudflare proxy **on**, SSL mode **Full**

## GitHub Pages

- Repo: `BossKingCoder/Web`
- Pages source: deploy from branch `main`, `/Code`
- Custom domain set to `shauryashub.dev` in repo Settings → Pages

## `site-lock` Worker

Deployed via **Wrangler**, not the dashboard editor (required for the Durable Object).

**Secrets needed** (Worker → Settings → Variables, or `wrangler secret put <NAME>`):
- `AUTH_USERNAME` — owner login username
- `AUTH_PASSWORD` — owner login password (can also be overridden later via `/admin`, which is stored in KV instead — see below)
- `RESEND_API_KEY` — from the Resend account used for outgoing email
- `OWNER_EMAIL` — real email address where password-change and panic-lockdown confirmations get sent
- `SEND_DOMAIN` — the verified sending domain in Resend (`shauryashub.dev`)
- `TURN_KEY_ID` — from Cloudflare Calls → TURN key
- `TURN_KEY_TOKEN` — from Cloudflare Calls → TURN key

**Bindings** (defined in `Code/wrangler.jsonc`):
- KV namespace `GUEST_KV` — stores guest records, maintenance state, time capsules, an owner-password override, pending confirmations
- Durable Object `CHAT_ROOM` → class `ChatRoom` — needs the migration block in `Code/wrangler.jsonc` to register correctly; this is why plain dashboard deploys don't work for this Worker

**Cron Trigger:**
- Add via dashboard: Worker → Settings → Triggers → Cron Triggers
- Schedule: once daily (e.g. `0 9 * * *`) — checks for and delivers any due Time Capsules

**To deploy:**
```
cd <project folder containing /workers/site-lock-worker.js and /Code/wrangler.jsonc>
npx wrangler login
npx wrangler deploy --config Code/wrangler.jsonc
```

## `gemini-proxy` Worker

Deployed via the plain Cloudflare dashboard code editor — no Durable Object, so Wrangler isn't required for this one.

**Secrets needed:**
- `GEMINI_API_KEY` — from Google AI Studio

CORS is restricted to `https://shauryashub.dev` and `https://www.shauryashub.dev` in the Worker code itself.

## Resend (email)

- Account used for all outgoing site email (guest credentials, time capsules, confirmations)
- Sending domain `shauryashub.dev` verified via DNS records in Cloudflare

## Cloudflare Calls (voice)

- Requires billing enabled on the Cloudflare account (free tier is generous — 1,000 GB/month — but the feature needs a card on file to activate)
- A TURN key created under Realtime → Calls, giving the `TURN_KEY_ID` / `TURN_KEY_TOKEN` pair above

## If something breaks

- **Login gate not working at all:** check the Worker route is still attached to `shauryashub.dev/*` in Cloudflare
- **Guests can't log in / admin panel errors:** check the `GUEST_KV` binding still exists
- **Chat/DMs/games/calls not connecting:** check the `CHAT_ROOM` Durable Object binding, and that the latest Worker code was deployed via `wrangler deploy` (not the dashboard editor, which can't update Durable Object code)
- **No emails sending:** check `RESEND_API_KEY` and that the Resend domain is still verified
- **Voice calls failing to connect:** check `TURN_KEY_ID` / `TURN_KEY_TOKEN` are current — TURN keys can be regenerated from the Cloudflare Calls dashboard if needed
