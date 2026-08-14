
import { DurableObject } from "cloudflare:workers";

const HUB_OPTIONS = [
  { id: 'chat', label: 'AI Assistant' },
  { id: 'study', label: 'Study Hub' },
  { id: 'entertainment', label: 'Entertainment Hub' },
  { id: 'games', label: 'Game Hub' },
  { id: 'utilities', label: 'Utilities Hub' },
  { id: 'challenges', label: 'Challenges Hub' },
  { id: 'multiplayer', label: 'Multiplayer Hub' },
];

// Owner credentials normally live as Worker secrets, but a KV override lets
// the password be changed from /admin without editing the dashboard directly.
async function getOwnerCredentials(env) {
  const raw = await env.GUEST_KV.get('owner:override');
  if (raw) {
    const override = JSON.parse(raw);
    return { username: override.username, password: override.password };
  }
  return { username: env.AUTH_USERNAME, password: env.AUTH_PASSWORD };
}

async function isOwner(env, username, password) {
  const creds = await getOwnerCredentials(env);
  return username === creds.username && password === creds.password;
}

// A real guest username could theoretically collide with something like "Shaurya"
// if the owner ever created a guest with that name, so the owner's own AI chat
// history uses a distinct reserved key instead of their display name.
function aiHistoryKey(username) {
  const trimmed = (username || '').trim();
  return trimmed ? trimmed : '__owner__';
}

async function deleteAllAiConversations(env, username) {
  const key = aiHistoryKey(username);
  const list = await env.GUEST_KV.list({ prefix: 'ai_conv:' + key + ':' });
  for (const k of list.keys) {
    await env.GUEST_KV.delete(k.name);
  }
  await env.GUEST_KV.delete('ai_conv_index:' + key);
  await env.GUEST_KV.delete('ai_memory:' + key);
}

// Shared helper for all guest-facing lifecycle emails — granted, denied, revoked,
// deleted, and hub-shutdown notices. No-ops quietly if there's no email to send to.
// Wraps any email's inner content in a consistently branded, table-based HTML shell.
// Table layout + inline styles throughout — the only approach that renders reliably
// across Gmail, Outlook, and Apple Mail, none of which handle modern CSS well.
function wrapEmailHtml(innerHtml) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0E1B3D;padding:40px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background-color:#16234F;border-radius:10px;overflow:hidden;">
      <tr><td style="padding:28px 32px;text-align:center;border-bottom:1px solid #243466;">
        <img src="https://shauryashub.dev/email-logo.png" alt="Shaurya's Hub" width="220" style="display:block;margin:0 auto;max-width:220px;height:auto;">
      </td></tr>
      <tr><td style="padding:32px;color:#F5F1E8;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;">
        ${innerHtml}
      </td></tr>
      <tr><td style="padding:18px 32px;border-top:1px solid #243466;text-align:center;">
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#6C7BA3;">Sent from shauryashub.dev</span>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

async function sendNotificationEmail(env, toEmail, subject, text, html) {
  if (!toEmail) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `Shaurya's Hub <access@${env.SEND_DOMAIN || 'shauryashub.dev'}>`,
        to: toEmail,
        subject,
        text,
        html: wrapEmailHtml(html),
      }),
    });
  } catch (e) {
    // Notification emails are a courtesy, not critical — a failed send here
    // shouldn't block the actual action (revoke/delete/etc.) from completing.
  }
}

// Emails every guest who left an address, whenever the hub closes — covers
// both a manual maintenance toggle and the panic-button lockdown.
async function notifyAllGuestsShutdown(env, message) {
  const list = await env.GUEST_KV.list({ prefix: 'guest:' });
  for (const key of list.keys) {
    const raw = await env.GUEST_KV.get(key.name);
    if (!raw) continue;
    const guest = JSON.parse(raw);
    if (!guest.email) continue;
    await sendNotificationEmail(
      env, guest.email,
      "Shaurya's Hub is temporarily closed",
      `The hub has been temporarily closed.${message ? ' ' + message : ''}`,
      `<p>The hub has been temporarily closed.${message ? ' ' + escapeHtml(message) : ''}</p>`
    );
  }
}

// A Durable Object: unlike the rest of this Worker, this stays alive between
// requests and holds open WebSocket connections, so messages can be pushed
// instantly instead of everyone having to poll and ask "anything new?"
export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.connections = new Map(); // WebSocket -> username
    this.tttState = this.freshTttState();
    this.connect4State = this.freshConnect4State();
    this.wordChainState = this.freshWordChainState();
  }

  freshTttState() {
    return { board: Array(9).fill(null), turn: 'X', players: { X: null, O: null }, winner: null };
  }

  freshConnect4State() {
    return { board: Array(42).fill(null), turn: 'red', players: { red: null, yellow: null }, winner: null };
  }

  freshWordChainState() {
    return { chain: [], turn: null, players: { first: null, second: null } };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const username = (url.searchParams.get('username') || 'Anonymous').slice(0, 40);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.connections.set(server, username);

    this.broadcast({ type: 'system', text: `${username} joined the chat.` });
    this.broadcastPresence();
    // Bring a new connection up to speed on any games already in progress
    try { server.send(JSON.stringify({ type: 'ttt_state', state: this.tttState })); } catch (e) { /* ignore */ }
    try { server.send(JSON.stringify({ type: 'connect4_state', state: this.connect4State })); } catch (e) { /* ignore */ }
    try { server.send(JSON.stringify({ type: 'wordchain_state', state: this.wordChainState })); } catch (e) { /* ignore */ }

    server.addEventListener('message', (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch (e) { return; }

      if (data.type === 'chat' && typeof data.text === 'string' && data.text.trim()) {
        this.broadcast({
          type: 'chat',
          username,
          text: data.text.slice(0, 500),
          timestamp: Date.now(),
        });
      } else if (data.type === 'dm' && typeof data.text === 'string' && data.text.trim() && typeof data.to === 'string') {
        const payload = {
          type: 'dm',
          from: username,
          to: data.to,
          text: data.text.slice(0, 500),
          timestamp: Date.now(),
        };
        let delivered = false;
        this.connections.forEach((connUsername, ws) => {
          if (connUsername === data.to) {
            try { ws.send(JSON.stringify(payload)); delivered = true; } catch (e) { /* ignore */ }
          }
        });
        // Echo back to the sender too, so their own conversation view shows it (and knows if it landed)
        try { server.send(JSON.stringify({ ...payload, delivered })); } catch (e) { /* ignore */ }
      } else if (data.type === 'typing' || data.type === 'stopped_typing') {
        const context = data.to ? 'dm' : 'live';
        const payload = { type: data.type, from: username, context };
        this.connections.forEach((connUsername, ws) => {
          if (ws === server) return; // never echo typing back to yourself
          if (context === 'dm') {
            if (connUsername === data.to) {
              try { ws.send(JSON.stringify(payload)); } catch (e) { /* ignore */ }
            }
          } else {
            try { ws.send(JSON.stringify(payload)); } catch (e) { /* ignore */ }
          }
        });
      } else if (data.type === 'dm_read' && typeof data.to === 'string') {
        const payload = { type: 'dm_read', from: username };
        this.connections.forEach((connUsername, ws) => {
          if (connUsername === data.to) {
            try { ws.send(JSON.stringify(payload)); } catch (e) { /* ignore */ }
          }
        });
      } else if (data.type === 'cursor_move' && typeof data.x === 'number' && typeof data.y === 'number' && typeof data.page === 'string') {
        this.broadcastExcept(server, { type: 'cursor_move', from: username, x: data.x, y: data.y, page: data.page });
      } else if (data.type === 'ttt_join') {
        this.handleTttJoin(username);
      } else if (data.type === 'ttt_move' && typeof data.cell === 'number') {
        this.handleTttMove(username, data.cell);
      } else if (data.type === 'ttt_reset') {
        this.tttState = this.freshTttState();
        this.broadcast({ type: 'ttt_state', state: this.tttState });
      } else if (data.type === 'connect4_join') {
        this.handleConnect4Join(username);
      } else if (data.type === 'connect4_move' && typeof data.col === 'number') {
        this.handleConnect4Move(username, data.col);
      } else if (data.type === 'connect4_reset') {
        this.connect4State = this.freshConnect4State();
        this.broadcast({ type: 'connect4_state', state: this.connect4State });
      } else if (data.type === 'wordchain_join') {
        this.handleWordChainJoin(username);
      } else if (data.type === 'wordchain_move' && typeof data.word === 'string') {
        this.handleWordChainMove(username, data.word);
      } else if (data.type === 'wordchain_reset') {
        this.wordChainState = this.freshWordChainState();
        this.broadcast({ type: 'wordchain_state', state: this.wordChainState });
      } else if (data.type === 'whiteboard_draw' && data.stroke) {
        this.broadcastExcept(server, { type: 'whiteboard_draw', stroke: data.stroke });
      } else if (data.type === 'whiteboard_clear') {
        this.broadcast({ type: 'whiteboard_clear' });
      } else if (typeof data.type === 'string' && data.type.indexOf('voice_') === 0 && typeof data.to === 'string') {
        // Voice call signaling (offers, answers, ICE candidates, ring/end) — just relay to the intended recipient
        const payload = { ...data, from: username };
        this.connections.forEach((connUsername, ws) => {
          if (connUsername === data.to) {
            try { ws.send(JSON.stringify(payload)); } catch (e) { /* ignore */ }
          }
        });
      }
    });

    server.addEventListener('close', () => {
      this.connections.delete(server);
      this.broadcast({ type: 'system', text: `${username} left the chat.` });
      this.broadcastPresence();

      // A player leaving mid-game resets it, rather than leaving the other person stuck waiting forever
      if (this.tttState.players.X === username || this.tttState.players.O === username) {
        this.tttState = this.freshTttState();
        this.broadcast({ type: 'ttt_state', state: this.tttState });
      }
      if (this.connect4State.players.red === username || this.connect4State.players.yellow === username) {
        this.connect4State = this.freshConnect4State();
        this.broadcast({ type: 'connect4_state', state: this.connect4State });
      }
      if (this.wordChainState.players.first === username || this.wordChainState.players.second === username) {
        this.wordChainState = this.freshWordChainState();
        this.broadcast({ type: 'wordchain_state', state: this.wordChainState });
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(messageObj) {
    const payload = JSON.stringify(messageObj);
    this.connections.forEach((username, ws) => {
      try { ws.send(payload); } catch (e) { /* connection likely already closed */ }
    });
  }

  broadcastPresence() {
    const users = Array.from(new Set(Array.from(this.connections.values())));
    this.broadcast({ type: 'presence', count: this.connections.size, users });
  }

  broadcastExcept(excludeWs, messageObj) {
    const payload = JSON.stringify(messageObj);
    this.connections.forEach((username, ws) => {
      if (ws === excludeWs) return;
      try { ws.send(payload); } catch (e) { /* connection likely already closed */ }
    });
  }

  // ---- Live Tic-Tac-Toe: one shared game — first two distinct people to join take X and O, everyone else spectates ----
  handleTttJoin(username) {
    const s = this.tttState;
    if (!s.players.X) {
      s.players.X = username;
    } else if (!s.players.O && s.players.X !== username) {
      s.players.O = username;
    }
    this.broadcast({ type: 'ttt_state', state: s });
  }

  handleTttMove(username, cell) {
    const s = this.tttState;
    if (s.winner) return;
    const mySymbol = s.players.X === username ? 'X' : (s.players.O === username ? 'O' : null);
    if (!mySymbol || mySymbol !== s.turn) return;
    if (cell < 0 || cell > 8 || s.board[cell] !== null) return;

    s.board[cell] = mySymbol;
    const winner = this.checkTttWinner(s.board);
    if (winner) {
      s.winner = winner;
    } else {
      s.turn = s.turn === 'X' ? 'O' : 'X';
    }
    this.broadcast({ type: 'ttt_state', state: s });
  }

  checkTttWinner(board) {
    const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const [a, b, c] of lines) {
      if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    if (board.every(v => v)) return 'draw';
    return null;
  }

  // ---- Live Connect 4: same shared-game pattern, 7 columns x 6 rows, flat array (row*7+col) ----
  handleConnect4Join(username) {
    const s = this.connect4State;
    if (!s.players.red) {
      s.players.red = username;
    } else if (!s.players.yellow && s.players.red !== username) {
      s.players.yellow = username;
    }
    this.broadcast({ type: 'connect4_state', state: s });
  }

  handleConnect4Move(username, col) {
    const s = this.connect4State;
    if (s.winner) return;
    const myColor = s.players.red === username ? 'red' : (s.players.yellow === username ? 'yellow' : null);
    if (!myColor || myColor !== s.turn) return;
    if (col < 0 || col > 6) return;

    let targetRow = -1;
    for (let row = 5; row >= 0; row--) {
      if (s.board[row * 7 + col] === null) { targetRow = row; break; }
    }
    if (targetRow === -1) return; // column full

    s.board[targetRow * 7 + col] = myColor;
    const winner = this.checkConnect4Winner(s.board);
    if (winner) {
      s.winner = winner;
    } else if (s.board.every(v => v)) {
      s.winner = 'draw';
    } else {
      s.turn = s.turn === 'red' ? 'yellow' : 'red';
    }
    this.broadcast({ type: 'connect4_state', state: s });
  }

  checkConnect4Winner(board) {
    const rows = 6, cols = 7;
    const get = (r, c) => board[r * cols + c];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = get(r, c);
        if (!v) continue;
        if (c + 3 < cols && v === get(r, c+1) && v === get(r, c+2) && v === get(r, c+3)) return v;
        if (r + 3 < rows && v === get(r+1, c) && v === get(r+2, c) && v === get(r+3, c)) return v;
        if (r + 3 < rows && c + 3 < cols && v === get(r+1, c+1) && v === get(r+2, c+2) && v === get(r+3, c+3)) return v;
        if (r + 3 < rows && c - 3 >= 0 && v === get(r+1, c-1) && v === get(r+2, c-2) && v === get(r+3, c-3)) return v;
      }
    }
    return null;
  }

  // ---- Live Word Chain: same shared-game pattern, no AI — just two real people taking turns ----
  handleWordChainJoin(username) {
    const s = this.wordChainState;
    if (!s.players.first) {
      s.players.first = username;
      s.turn = username;
    } else if (!s.players.second && s.players.first !== username) {
      s.players.second = username;
    }
    this.broadcast({ type: 'wordchain_state', state: s });
  }

  handleWordChainMove(username, word) {
    const s = this.wordChainState;
    if (!s.players.first || !s.players.second) return; // needs both players present
    if (username !== s.turn) return;

    const trimmed = word.trim();
    if (!trimmed || /\s/.test(trimmed)) return; // one word only, no spaces
    const lower = trimmed.toLowerCase();
    if (s.chain.some(w => w.toLowerCase() === lower)) return; // no repeats

    s.chain.push(trimmed.slice(0, 40));
    s.turn = s.turn === s.players.first ? s.players.second : s.players.first;
    this.broadcast({ type: 'wordchain_state', state: s });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Browsers request this directly for the tab icon — needs to be fetchable
    // without logging in first, and there's nothing sensitive in it.
    if (url.pathname === '/favicon.ico') {
      return fetch(request);
    }

    // Email clients load this directly when rendering emails — they can't log in,
    // so it needs to be public too. Nothing sensitive in a logo image.
    if (url.pathname === '/email-logo.png') {
      return fetch(request);
    }

    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\nAllow: /signup\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (url.pathname === '/signup') {
      return handleSignup(request, env);
    }

    if (url.pathname === '/signup/verify' && request.method === 'POST') {
      return handleSignupVerify(request, env);
    }

    if (url.pathname === '/__chat_ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected a WebSocket connection', { status: 426 });
      }
      const id = env.CHAT_ROOM.idFromName('main-room');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === '/admin') {
      return handleAdmin(request, env);
    }

    if (url.pathname === '/admin/email') {
      return handleAdminEmail(request, env);
    }

    if (url.pathname === '/admin/confirm-password') {
      return handleConfirmPassword(request, env);
    }

    if (url.pathname === '/admin/confirm-panic') {
      return handleConfirmPanic(request, env);
    }

    if (url.pathname === '/__get_turn_credentials' && request.method === 'POST') {
      const origin = request.headers.get('Origin') || '';
      const allowedOrigins = ['https://shauryashub.dev', 'https://www.shauryashub.dev'];
      if (!allowedOrigins.includes(origin)) {
        return new Response(JSON.stringify({ ok: false, error: 'Not allowed.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      try {
        const response = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.TURN_KEY_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ttl: 3600 }), // an hour is plenty for one call
          }
        );
        const data = await response.json();
        if (!response.ok) {
          return new Response(JSON.stringify({ ok: false, error: 'Could not get call credentials.' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true, iceServers: data.iceServers }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'Could not get call credentials.' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/__create_time_capsule' && request.method === 'POST') {
      const origin = request.headers.get('Origin') || '';
      const allowedOrigins = ['https://shauryashub.dev', 'https://www.shauryashub.dev'];
      if (!allowedOrigins.includes(origin)) {
        return new Response(JSON.stringify({ ok: false, error: 'Not allowed.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const body = await request.json().catch(() => ({}));
      const email = (body.email || '').trim();
      const message = (body.message || '').trim();
      const day = body.day;
      const month = body.month;
      const year = body.year;

      if (!email || !message || !day || !month || !year) {
        return new Response(JSON.stringify({ ok: false, error: 'Fill in the email, message, and a full date first.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const deliverAt = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T09:00:00`;
      if (new Date(deliverAt).getTime() <= Date.now()) {
        return new Response(JSON.stringify({ ok: false, error: 'Pick a date in the future.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const id = crypto.randomUUID();
      await env.GUEST_KV.put(
        'capsule:' + id,
        JSON.stringify({ email, message, deliverAt, createdAt: new Date().toISOString() })
      );

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/__check_access') {
      const username = url.searchParams.get('u') || '';
      const raw = await env.GUEST_KV.get('guest:' + username);
      const guest = raw ? JSON.parse(raw) : null;
      const guestActive = guest ? !!guest.active && !isGuestExpired(guest) : false;

      const maintenanceRaw = await env.GUEST_KV.get('site:maintenance');
      const maintenanceOn = maintenanceRaw ? !!JSON.parse(maintenanceRaw).enabled : false;

      const active = guestActive && !maintenanceOn;
      return new Response(JSON.stringify({ active }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/__report_activity' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const username = body.username || '';
      const view = body.view || '';
      if (username) {
        // expirationTtl means a closed tab's presence naturally clears itself after a few minutes
        await env.GUEST_KV.put(
          'activity:' + username,
          JSON.stringify({ view, timestamp: Date.now() }),
          { expirationTtl: 300 }
        );
      }
      return new Response('ok', { status: 200 });
    }

    if (url.pathname === '/__ai_conv_list' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const key = aiHistoryKey(body.username);
      const raw = await env.GUEST_KV.get('ai_conv_index:' + key);
      const index = raw ? JSON.parse(raw) : [];
      index.sort((a, b) => b.updatedAt - a.updatedAt);
      return new Response(JSON.stringify({ conversations: index }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/__ai_conv_load' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const key = aiHistoryKey(body.username);
      const id = body.id || '';
      const raw = id ? await env.GUEST_KV.get('ai_conv:' + key + ':' + id) : null;
      const messages = raw ? JSON.parse(raw).messages : [];
      return new Response(JSON.stringify({ messages }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/__ai_conv_save' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const key = aiHistoryKey(body.username);
      const messages = Array.isArray(body.messages) ? body.messages.slice(-200) : [];
      const id = body.id || crypto.randomUUID();

      const firstUserMsg = messages.find(m => m.role === 'user');
      const title = firstUserMsg
        ? (firstUserMsg.content.length > 40 ? firstUserMsg.content.slice(0, 40) + '…' : firstUserMsg.content)
        : 'New chat';

      await env.GUEST_KV.put('ai_conv:' + key + ':' + id, JSON.stringify({ messages }));

      const indexRaw = await env.GUEST_KV.get('ai_conv_index:' + key);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      const existing = index.find(c => c.id === id);
      const updatedAt = Date.now();
      if (existing) {
        existing.title = title;
        existing.updatedAt = updatedAt;
      } else {
        index.push({ id, title, updatedAt });
      }
      await env.GUEST_KV.put('ai_conv_index:' + key, JSON.stringify(index));

      return new Response(JSON.stringify({ ok: true, id, title }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/__ai_conv_delete' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const key = aiHistoryKey(body.username);
      const id = body.id || '';
      if (id) {
        await env.GUEST_KV.delete('ai_conv:' + key + ':' + id);
        const indexRaw = await env.GUEST_KV.get('ai_conv_index:' + key);
        const index = indexRaw ? JSON.parse(indexRaw) : [];
        const filtered = index.filter(c => c.id !== id);
        await env.GUEST_KV.put('ai_conv_index:' + key, JSON.stringify(filtered));
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/__ai_memory_load' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const key = aiHistoryKey(body.username);
      const notes = await env.GUEST_KV.get('ai_memory:' + key);
      return new Response(JSON.stringify({ notes: notes || '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/__ai_memory_save' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const key = aiHistoryKey(body.username);
      const newNotes = (body.notes || '').trim();
      if (newNotes) {
        const existing = (await env.GUEST_KV.get('ai_memory:' + key)) || '';
        const combined = existing ? existing + '\n' + newNotes : newNotes;
        // Cap total length — keep the most recent notes, trim from the oldest end
        const capped = combined.length > 2000 ? combined.slice(combined.length - 2000) : combined;
        await env.GUEST_KV.put('ai_memory:' + key, capped);
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/__ai_memory_delete' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const key = aiHistoryKey(body.username);
      await env.GUEST_KV.delete('ai_memory:' + key);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/__admin_refresh' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const ownerUser = body.owner_username || '';
      const ownerPass = body.owner_password || '';
      if (!(await isOwner(env, ownerUser, ownerPass))) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const rowsHtml = await buildGuestRowsHtml(env, ownerUser, ownerPass);
      return new Response(JSON.stringify({ rowsHtml }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return handleMainSite(request, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(deliverDueCapsules(env));
  },
};

async function deliverDueCapsules(env) {
  const list = await env.GUEST_KV.list({ prefix: 'capsule:' });
  const now = Date.now();

  for (const key of list.keys) {
    const raw = await env.GUEST_KV.get(key.name);
    if (!raw) continue;

    const capsule = JSON.parse(raw);
    if (new Date(capsule.deliverAt).getTime() > now) continue; // not due yet

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `Time Capsule <access@${env.SEND_DOMAIN || 'shauryashub.dev'}>`,
          to: capsule.email,
          subject: 'A message from your past self has arrived',
          text: capsule.message,
          html: wrapEmailHtml(`<p>${escapeHtml(capsule.message).replace(/\n/g, '<br>')}</p>`),
        }),
      });
      if (response.ok) {
        await env.GUEST_KV.delete(key.name);
      }
      // if it failed, leave it in place — the next scheduled run will retry it
    } catch (e) {
      // leave it, will retry next scheduled run
    }
  }
}

async function handleMainSite(request, env) {
  const maintenanceRaw = await env.GUEST_KV.get('site:maintenance');
  const maintenance = maintenanceRaw ? JSON.parse(maintenanceRaw) : { enabled: false, message: '' };
  if (maintenance.enabled) {
    return new Response(maintenancePage(maintenance.message), {
      status: 503,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (request.method === 'POST') {
    const formData = await request.formData();
    const username = formData.get('username') || '';
    const password = formData.get('password') || '';

    // Owner credentials
    if (await isOwner(env, username, password)) {
      const previewAs = formData.get('preview_as');
      if (previewAs) {
        const previewRaw = await env.GUEST_KV.get('guest:' + previewAs);
        const previewGuest = previewRaw ? JSON.parse(previewRaw) : null;
        const allowedHubs = previewGuest ? (previewGuest.allowedHubs || []) : [];
        return serveSiteWithPoller(request, true, previewAs, allowedHubs, previewGuest?.firstName, previewGuest?.lastName);
      }
      return serveSiteWithPoller(request, false);
    }

    // Guest credentials
    const raw = await env.GUEST_KV.get('guest:' + username);
    if (raw) {
      const guest = JSON.parse(raw);
      if (guest.password === password) {
        if (!guest.active) {
          return new Response(loginPage('This access has been revoked.'), {
            status: 401,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        if (isGuestExpired(guest)) {
          return new Response(loginPage('This access has expired.'), {
            status: 401,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        guest.accessCount = (guest.accessCount || 0) + 1;
        guest.lastAccess = new Date().toISOString();
        await env.GUEST_KV.put('guest:' + username, JSON.stringify(guest));
        return serveSiteWithPoller(request, true, username, guest.allowedHubs, guest.firstName, guest.lastName);
      }
    }

    return new Response(loginPage('Incorrect username or password.'), {
      status: 401,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  return new Response(loginPage(), {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

async function serveSiteWithPoller(request, isGuest, username, allowedHubs, firstName, lastName) {
  const originResponse = await fetch(request.url, { headers: request.headers });

  // Owner never gets kicked, so just pass the page through unmodified.
  if (!isGuest) return originResponse;

  const contentType = originResponse.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) return originResponse;

  let html = await originResponse.text();
  const poller = `
<script>
  window.__GUEST_USERNAME__ = ${JSON.stringify(username)};
  window.__GUEST_ALLOWED_HUBS__ = ${JSON.stringify(allowedHubs && allowedHubs.length ? allowedHubs : null)};
  window.__GUEST_FIRST_NAME__ = ${JSON.stringify(firstName || null)};
  window.__GUEST_LAST_NAME__ = ${JSON.stringify(lastName || null)};
</script>
<script>
(function(){
  var checkUrl = '/__check_access?u=' + encodeURIComponent(${JSON.stringify(username)});
  setInterval(function(){
    fetch(checkUrl).then(function(r){ return r.json(); }).then(function(data){
      if(!data.active){ window.location.reload(); }
    }).catch(function(){});
  }, 5000);
})();
</script>`;

  html = html.includes('<head>') ? html.replace('<head>', '<head>' + poller) : poller + html;

  return new Response(html, {
    status: originResponse.status,
    headers: originResponse.headers,
  });
}

function isGuestExpired(guest) {
  return !!(guest.expiresAt && Date.now() > new Date(guest.expiresAt).getTime());
}

async function generateUniqueUsername(env, firstName, lastName) {
  // Strip anything that isn't a normal name character before it ever becomes
  // part of a username — defense in depth, not just relying on escaping at render time.
  const sanitize = (s) => s.trim().replace(/[^a-zA-Z0-9\s'-]/g, '').replace(/\s+/g, ' ');
  const first = sanitize(firstName) || 'Guest';
  const lastClean = sanitize(lastName);

  const firstCapitalized = first.charAt(0).toUpperCase() + first.slice(1);
  const lastInitial = lastClean ? lastClean.charAt(0).toUpperCase() : 'X';
  const base = `${firstCapitalized}.${lastInitial}`;

  let candidate = base;
  let suffix = 2;
  while (true) {
    const existingGuest = await env.GUEST_KV.get('guest:' + candidate);
    const existingRequest = await env.GUEST_KV.get('request:' + candidate);
    if (!existingGuest && !existingRequest) return candidate;
    candidate = base + suffix;
    suffix++;
  }
}

async function handleSignup(request, env) {
  if (request.method === 'POST') {
    const formData = await request.formData();
    const firstName = (formData.get('first_name') || '').trim();
    const lastName = (formData.get('last_name') || '').trim();
    const email = (formData.get('email') || '').trim();

    if (!firstName || !lastName) {
      return new Response(signupPage('Please enter both your first and last name.'), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }

    // No email given — nothing to verify, request goes through exactly like before.
    if (!email) {
      const username = await generateUniqueUsername(env, firstName, lastName);
      await env.GUEST_KV.put('request:' + username, JSON.stringify({
        firstName, lastName, username, email: null, requestedAt: new Date().toISOString(),
      }));
      return new Response(signupConfirmPage(username), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }

    // Email given — hold the request and verify they actually own that inbox first.
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const token = crypto.randomUUID();
    await env.GUEST_KV.put(
      'pending_signup:' + token,
      JSON.stringify({ firstName, lastName, email, otp, expiresAt: Date.now() + 15 * 60 * 1000 }),
      { expirationTtl: 900 }
    );

    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `Shaurya's Hub <access@${env.SEND_DOMAIN || 'shauryashub.dev'}>`,
          to: email,
          subject: 'Confirm your email — Shaurya\'s Hub',
          text: `Your verification code is: ${otp}\n\nThis code expires in 15 minutes. If you didn't request access to Shaurya's Hub, you can ignore this email.`,
          html: wrapEmailHtml(`<p>Your verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#E0AC3F;">${otp}</p><p>This code expires in 15 minutes. If you didn't request access to Shaurya's Hub, you can ignore this email.</p>`),
        }),
      });
    } catch (e) {
      // Even if the email fails to send, still show the entry page — the field-hint
      // and a resend option (implicit via going back and re-submitting) cover this.
    }

    return new Response(otpEntryPage(email, token), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  return new Response(signupPage(), {
    status: 200, headers: { 'Content-Type': 'text/html' },
  });
}

async function handleSignupVerify(request, env) {
  const formData = await request.formData();
  const token = formData.get('token') || '';
  const otpInput = (formData.get('otp') || '').trim();

  const raw = await env.GUEST_KV.get('pending_signup:' + token);
  if (!raw) {
    return new Response(signupPage('That verification link expired — please start again.'), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  const pending = JSON.parse(raw);
  if (Date.now() > pending.expiresAt) {
    await env.GUEST_KV.delete('pending_signup:' + token);
    return new Response(signupPage('That code expired — please start again.'), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  if (otpInput !== pending.otp) {
    return new Response(otpEntryPage(pending.email, token, 'That code didn\'t match — try again.'), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  const username = await generateUniqueUsername(env, pending.firstName, pending.lastName);
  await env.GUEST_KV.put('request:' + username, JSON.stringify({
    firstName: pending.firstName, lastName: pending.lastName, username,
    email: pending.email, requestedAt: new Date().toISOString(),
  }));
  await env.GUEST_KV.delete('pending_signup:' + token);

  return new Response(signupConfirmPage(username), {
    status: 200, headers: { 'Content-Type': 'text/html' },
  });
}

function signupPage(error) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Request Access — Shaurya's Hub</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0E1B3D;font-family:sans-serif;}
  .card{background:#16234F;border:1px solid #243466;border-radius:10px;padding:36px 32px;width:300px;}
  h1{color:#F5F1E8;font-size:20px;margin:0 0 8px 0;text-align:center;}
  .sub{color:#8B9BC4;font-size:12.5px;text-align:center;margin-bottom:20px;line-height:1.5;}
  input{width:100%;box-sizing:border-box;background:#0E1B3D;border:1px solid #243466;color:#F5F1E8;
    padding:10px 12px;border-radius:6px;margin-bottom:12px;font-size:14px;}
  button{width:100%;background:#E0AC3F;color:#0E1B3D;border:none;padding:10px;border-radius:6px;
    font-weight:600;cursor:pointer;font-size:14px;}
  .error{color:#D9584F;font-size:12px;margin-bottom:12px;text-align:center;}
  .field-hint{color:#6C7BA3;font-size:11px;margin-top:-8px;margin-bottom:12px;line-height:1.4;}
  .back-link{display:block;text-align:center;margin-top:16px;color:#8B9BC4;font-size:12px;text-decoration:none;}
  .back-link:hover{color:#E0AC3F;}
</style>
</head>
<body>
  <form class="card" method="POST">
    <h1>Request Access</h1>
    <div class="sub">Ask for access to Shaurya's Hub — tell me who you are and I'll take a look.</div>
    ${error ? `<div class="error">${error}</div>` : ''}
    <input type="text" name="first_name" placeholder="First name" autofocus required>
    <input type="text" name="last_name" placeholder="Last name" required>
    <input type="email" name="email" placeholder="Email (optional)">
    <div class="field-hint">If you leave your email, you'll get a note when your request is accepted or denied.</div>
    <button type="submit">Send Request</button>
    <a class="back-link" href="/">Back to sign in</a>
  </form>
</body>
</html>`;
}

function otpEntryPage(email, token, error) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm Your Email — Shaurya's Hub</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0E1B3D;font-family:sans-serif;}
  .card{background:#16234F;border:1px solid #243466;border-radius:10px;padding:36px 32px;width:300px;}
  h1{color:#F5F1E8;font-size:20px;margin:0 0 8px 0;text-align:center;}
  .sub{color:#8B9BC4;font-size:12.5px;text-align:center;margin-bottom:20px;line-height:1.5;}
  input{width:100%;box-sizing:border-box;background:#0E1B3D;border:1px solid #243466;color:#F5F1E8;
    padding:10px 12px;border-radius:6px;margin-bottom:12px;font-size:20px;text-align:center;letter-spacing:6px;}
  button{width:100%;background:#E0AC3F;color:#0E1B3D;border:none;padding:10px;border-radius:6px;
    font-weight:600;cursor:pointer;font-size:14px;}
  .error{color:#D9584F;font-size:12px;margin-bottom:12px;text-align:center;}
  .back-link{display:block;text-align:center;margin-top:16px;color:#8B9BC4;font-size:12px;text-decoration:none;}
  .back-link:hover{color:#E0AC3F;}
</style>
</head>
<body>
  <form class="card" method="POST" action="/signup/verify">
    <h1>Confirm Your Email</h1>
    <div class="sub">We sent a 6-digit code to <strong>${escapeHtml(email)}</strong> — enter it below.</div>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <input type="text" name="otp" placeholder="123456" inputmode="numeric" maxlength="6" autofocus required>
    <button type="submit">Confirm</button>
    <a class="back-link" href="/signup">Start over</a>
  </form>
</body>
</html>`;
}

function signupConfirmPage(username) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Request Sent — Shaurya's Hub</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0E1B3D;font-family:sans-serif;color:#F5F1E8;text-align:center;padding:20px;}
  .card{max-width:340px;}
  h1{font-size:20px;color:#6FE0A0;margin-bottom:10px;}
  p{color:#AEB9D4;font-size:14px;line-height:1.6;}
  .username{color:#E0AC3F;font-weight:700;}
</style>
</head>
<body>
  <div class="card">
    <h1>Request Sent</h1>
    <p>Your request has been sent. If it's approved, your username will be <span class="username">${escapeHtml(username)}</span> — check back or wait to hear from whoever you asked.</p>
  </div>
</body>
</html>`;
}

async function handleAdmin(request, env) {
  if (request.method === 'POST') {
    const formData = await request.formData();
    const ownerUser = formData.get('owner_username') || '';
    const ownerPass = formData.get('owner_password') || '';

    if (!(await isOwner(env, ownerUser, ownerPass))) {
      return new Response(adminLoginPage('Incorrect owner credentials.'), {
        status: 401,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const action = formData.get('action');
    let createError = null;
    let emailStatus = null;
    let panicStatus = null;
    let passwordChangeStatus = null;

    let justCreated = null;

    if (action === 'create') {
      const firstName = (formData.get('new_first_name') || '').trim();
      const lastName = (formData.get('new_last_name') || '').trim();
      if (!firstName || !lastName) {
        createError = 'Enter both a first and last name first.';
      } else {
        const username = await generateUniqueUsername(env, firstName, lastName);
        const password = Math.random().toString(36).slice(2, 10);

        const expDay = formData.get('expire_day');
        const expMonth = formData.get('expire_month');
        const expYear = formData.get('expire_year');
        let expiresAt = null;
        if (expDay && expMonth && expYear) {
          expiresAt = `${expYear}-${String(expMonth).padStart(2, '0')}-${String(expDay).padStart(2, '0')}T23:59:59`;
        }

        const allowedHubs = formData.getAll('allowed_hub'); // empty array = no restriction, full access
        const email = (formData.get('new_email') || '').trim();

        const record = {
          password, active: true, accessCount: 0, createdAt: new Date().toISOString(),
          expiresAt, allowedHubs: allowedHubs.length ? allowedHubs : null, email: email || null,
          firstName, lastName,
        };
        await env.GUEST_KV.put('guest:' + username, JSON.stringify(record));
        justCreated = { username, ...record };

        const sendDomain = env.SEND_DOMAIN || 'shauryashub.dev';
          await sendNotificationEmail(
            env, email,
            "You've been given access to Shaurya's Hub",
            `You've been given access to Shaurya's Hub.\n\nWebsite: https://${sendDomain}\nUsername: ${username}\nPassword: ${password}\n\nThis access can be revoked at any time.`,
            `<p>You've been given access to Shaurya's Hub.</p><p>Website: <a href="https://${sendDomain}">${sendDomain}</a><br>Username: <strong>${escapeHtml(username)}</strong><br>Password: <strong>${escapeHtml(password)}</strong></p><p>This access can be revoked at any time.</p>`
          );
      }
    } else if (action === 'toggle') {
      const target = formData.get('target');
      const raw = await env.GUEST_KV.get('guest:' + target);
      if (raw) {
        const guest = JSON.parse(raw);
        guest.active = !guest.active;
        await env.GUEST_KV.put('guest:' + target, JSON.stringify(guest));
        if (!guest.active) {
          await sendNotificationEmail(
            env, guest.email,
            'Your access to Shaurya\'s Hub has been revoked',
            'Your access has been revoked. If you think this was a mistake, feel free to reach out.',
            '<p>Your access has been revoked. If you think this was a mistake, feel free to reach out.</p>'
          );
        }
      }
    } else if (action === 'delete') {
      const target = formData.get('target');
      const raw = await env.GUEST_KV.get('guest:' + target);
      if (raw) {
        const guest = JSON.parse(raw);
        await sendNotificationEmail(
          env, guest.email,
          'Your account on Shaurya\'s Hub has been deleted',
          'Your account has been permanently deleted.',
          '<p>Your account has been permanently deleted.</p>'
        );
      }
      await env.GUEST_KV.delete('guest:' + target);
      await deleteAllAiConversations(env, target);
    } else if (action === 'toggle_maintenance') {
      const raw = await env.GUEST_KV.get('site:maintenance');
      const current = raw ? JSON.parse(raw) : { enabled: false, message: '' };
      const newEnabled = !current.enabled;
      const message = newEnabled ? (formData.get('maintenance_message') || '').trim() : current.message;
      await env.GUEST_KV.put('site:maintenance', JSON.stringify({ enabled: newEnabled, message }));
      if (newEnabled) {
        await notifyAllGuestsShutdown(env, message);
      }
    } else if (action === 'request_panic') {
      const token = crypto.randomUUID();
      await env.GUEST_KV.put(
        'panic:pending',
        JSON.stringify({ token, expiresAt: Date.now() + 30 * 60 * 1000 }),
        { expirationTtl: 1800 }
      );
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `Shaurya's Hub <access@${env.SEND_DOMAIN || 'shauryashub.dev'}>`,
            to: env.OWNER_EMAIL,
            subject: 'Confirm emergency lockdown',
            text: `A panic lockdown was requested for your admin panel.\n\nOpen this link to review and confirm: https://${env.SEND_DOMAIN || 'shauryashub.dev'}/admin/confirm-panic?token=${token}\n\nThis link expires in 30 minutes. If you didn't request this, ignore this email and nothing will change.`,
            html: wrapEmailHtml(`<p>A panic lockdown was requested for your admin panel.</p><p><a href="https://${env.SEND_DOMAIN || 'shauryashub.dev'}/admin/confirm-panic?token=${token}" style="color:#E0AC3F;">Click here to review and confirm</a></p><p>This link expires in 30 minutes. If you didn't request this, ignore this email and nothing will change.</p>`),
          }),
        });
        panicStatus = { ok: true, text: `Confirmation email sent to ${env.OWNER_EMAIL}. Open it to review and confirm — nothing happens until then.` };
      } catch (e) {
        panicStatus = { ok: false, text: 'Could not send the confirmation email — try again.' };
      }
    } else if (action === 'request_password_change') {
      const newPassword = formData.get('new_owner_password') || '';
      if (!newPassword || newPassword.length < 4) {
        passwordChangeStatus = { ok: false, text: 'Type a new password (at least 4 characters) first.' };
      } else {
        const token = crypto.randomUUID();
        await env.GUEST_KV.put(
          'owner:pending_change',
          JSON.stringify({ newPassword, token, expiresAt: Date.now() + 30 * 60 * 1000 }),
          { expirationTtl: 1800 }
        );
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: `Shaurya's Hub <access@${env.SEND_DOMAIN || 'shauryashub.dev'}>`,
              to: env.OWNER_EMAIL,
              subject: 'Confirm your password change',
              text: `Someone (hopefully you) requested a password change for your admin panel.\n\nClick to confirm: https://${env.SEND_DOMAIN || 'shauryashub.dev'}/admin/confirm-password?token=${token}\n\nThis link expires in 30 minutes. If you didn't request this, ignore this email and nothing will change.`,
              html: wrapEmailHtml(`<p>Someone (hopefully you) requested a password change for your admin panel.</p><p><a href="https://${env.SEND_DOMAIN || 'shauryashub.dev'}/admin/confirm-password?token=${token}" style="color:#E0AC3F;">Click here to confirm the change</a></p><p>This link expires in 30 minutes. If you didn't request this, ignore this email and nothing will change.</p>`),
            }),
          });
          passwordChangeStatus = { ok: true, text: `Confirmation email sent to ${env.OWNER_EMAIL}. Click the link there to finish the change.` };
        } catch (e) {
          passwordChangeStatus = { ok: false, text: 'Could not send the confirmation email — try again.' };
        }
      }
    } else if (action === 'accept_request') {
      const target = formData.get('target');
      const raw = await env.GUEST_KV.get('request:' + target);
      if (raw) {
        const req = JSON.parse(raw);
        const password = Math.random().toString(36).slice(2, 10);
        const record = {
          password, active: true, accessCount: 0, createdAt: new Date().toISOString(),
          expiresAt: null, allowedHubs: null, email: req.email || null,
          firstName: req.firstName || null, lastName: req.lastName || null,
        };
        await env.GUEST_KV.put('guest:' + target, JSON.stringify(record));
        await env.GUEST_KV.delete('request:' + target);
        justCreated = { username: target, ...record };

        const sendDomain = env.SEND_DOMAIN || 'shauryashub.dev';
        await sendNotificationEmail(
          env, req.email,
          "You've been granted access to Shaurya's Hub",
          `Good news — your access request was accepted.\n\nWebsite: https://${sendDomain}\nUsername: ${target}\nPassword: ${password}\n\nThis access can be revoked at any time.`,
          `<p>Good news — your access request was accepted.</p><p>Website: <a href="https://${sendDomain}">${sendDomain}</a><br>Username: <strong>${escapeHtml(target)}</strong><br>Password: <strong>${escapeHtml(password)}</strong></p><p>This access can be revoked at any time.</p>`
        );
      }
    } else if (action === 'deny_request') {
      const target = formData.get('target');
      const raw = await env.GUEST_KV.get('request:' + target);
      if (raw) {
        const req = JSON.parse(raw);
        await sendNotificationEmail(
          env, req.email,
          'Your access request was not approved',
          `Your request for access to Shaurya's Hub wasn't approved this time.`,
          `<p>Your request for access to Shaurya's Hub wasn't approved this time.</p>`
        );
      }
      await env.GUEST_KV.delete('request:' + target);
    }

    return new Response(await adminPanelPage(env, ownerUser, ownerPass, createError, justCreated, emailStatus, panicStatus, passwordChangeStatus), {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  return new Response(adminLoginPage(), {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

async function handleAdminEmail(request, env) {
  if (request.method !== 'POST') {
    return new Response(adminLoginPage(), { status: 200, headers: { 'Content-Type': 'text/html' } });
  }

  const formData = await request.formData();
  const ownerUser = formData.get('owner_username') || '';
  const ownerPass = formData.get('owner_password') || '';

  if (!(await isOwner(env, ownerUser, ownerPass))) {
    return new Response(adminLoginPage('Incorrect owner credentials.'), {
      status: 401,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const target = formData.get('target') || '';
  const stage = formData.get('stage');

  if (stage === 'send') {
    const to = (formData.get('compose_to') || '').trim();
    const fromChoice = formData.get('compose_from') || 'anonymous';
    const extraMessage = (formData.get('extra_message') || '').trim();

    const raw = await env.GUEST_KV.get('guest:' + target);
    if (!raw) {
      return new Response(emailComposePage(ownerUser, ownerPass, target, 'Could not find that guest login anymore.'), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }
    if (!to) {
      return new Response(emailComposePage(ownerUser, ownerPass, target, 'Type a recipient email address first.'), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }

    const guest = JSON.parse(raw);
    const sendDomain = env.SEND_DOMAIN || 'shauryashub.dev';
    const displayName = fromChoice === 'shaurya' ? 'Shaurya' : 'Anonymous';

    const baseText = `You've been given temporary access to Shaurya's Hub.\n\nWebsite: https://${sendDomain}\nUsername: ${target}\nPassword: ${guest.password}\n\nThis access can be revoked at any time.`;
    const fullText = extraMessage ? `${baseText}\n\n---\n${extraMessage}` : baseText;

    const baseHtml = `<p>You've been given temporary access to <strong>Shaurya's Hub</strong>.</p><p>Website: <a href="https://${sendDomain}">${sendDomain}</a><br>Username: <strong>${escapeHtml(target)}</strong><br>Password: <strong>${escapeHtml(guest.password)}</strong></p><p>This access can be revoked at any time.</p>`;
    const fullHtml = extraMessage
      ? `${baseHtml}<hr>${escapeHtml(extraMessage).replace(/\n/g, '<br>')}`
      : baseHtml;

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${displayName} <access@${sendDomain}>`,
          to,
          subject: "You've been given access to Shaurya's Hub",
          text: fullText,
          html: wrapEmailHtml(fullHtml),
        }),
      });
      const result = await response.json();
      if (response.ok) {
        return new Response(emailSentPage(ownerUser, ownerPass, to), {
          status: 200, headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response(emailComposePage(ownerUser, ownerPass, target, result.message || 'Resend rejected the email — check your API key.'), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    } catch (e) {
      return new Response(emailComposePage(ownerUser, ownerPass, target, 'Something went wrong sending the email.'), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }
  }

  return new Response(emailComposePage(ownerUser, ownerPass, target), {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

async function handleConfirmPassword(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';

  const raw = await env.GUEST_KV.get('owner:pending_change');
  if (!raw) {
    return new Response(confirmResultPage(false, 'This confirmation link is no longer valid — it may have already been used or expired.'), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  const pending = JSON.parse(raw);
  if (pending.token !== token) {
    return new Response(confirmResultPage(false, 'This confirmation link is invalid.'), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }
  if (Date.now() > pending.expiresAt) {
    await env.GUEST_KV.delete('owner:pending_change');
    return new Response(confirmResultPage(false, 'This confirmation link has expired — request a new password change from /admin.'), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  const currentCreds = await getOwnerCredentials(env);
  await env.GUEST_KV.put('owner:override', JSON.stringify({
    username: currentCreds.username,
    password: pending.newPassword,
  }));
  await env.GUEST_KV.delete('owner:pending_change');

  return new Response(confirmResultPage(true, 'Your password has been changed. Use it next time you log in.'), {
    status: 200, headers: { 'Content-Type': 'text/html' },
  });
}

function confirmResultPage(success, message, title) {
  const heading = title || (success ? 'Password Changed' : 'Something Went Wrong');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirmation — Admin</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0E1B3D;font-family:sans-serif;color:#F5F1E8;text-align:center;padding:20px;}
  .card{max-width:380px;}
  h1{font-size:20px;color:${success ? '#6FE0A0' : '#D9584F'};margin-bottom:10px;}
  p{color:#AEB9D4;font-size:14px;line-height:1.6;}
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

async function handleConfirmPanic(request, env) {
  const url = new URL(request.url);

  if (request.method === 'POST') {
    const formData = await request.formData();
    const token = formData.get('token') || '';
    const phrase = (formData.get('confirm_phrase') || '').trim();

    const raw = await env.GUEST_KV.get('panic:pending');
    if (!raw) {
      return new Response(confirmResultPage(false, 'This confirmation link is no longer valid — it may have already been used or expired.', 'Lockdown Not Confirmed'), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }

    const pending = JSON.parse(raw);
    if (pending.token !== token) {
      return new Response(confirmResultPage(false, 'This confirmation link is invalid.', 'Lockdown Not Confirmed'), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }
    if (Date.now() > pending.expiresAt) {
      await env.GUEST_KV.delete('panic:pending');
      return new Response(confirmResultPage(false, 'This confirmation link has expired — request a new lockdown from /admin if you still need it.', 'Lockdown Not Confirmed'), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }
    if (phrase !== 'LOCK IT DOWN') {
      return new Response(panicConfirmPage(token, "That phrase didn't match — type it exactly to confirm."), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }

    const list = await env.GUEST_KV.list({ prefix: 'guest:' });
    for (const key of list.keys) {
      const guestRaw = await env.GUEST_KV.get(key.name);
      if (!guestRaw) continue;
      const guest = JSON.parse(guestRaw);
      guest.active = false;
      await env.GUEST_KV.put(key.name, JSON.stringify(guest));
    }
    const lockdownMessage = 'Access has been temporarily locked down.';
    await env.GUEST_KV.put('site:maintenance', JSON.stringify({
      enabled: true,
      message: lockdownMessage,
    }));
    await notifyAllGuestsShutdown(env, lockdownMessage);
    await env.GUEST_KV.delete('panic:pending');

    return new Response(confirmResultPage(true, 'Every guest login has been revoked and the workspace is now closed.', 'Lockdown Confirmed'), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  // GET: show the confirmation page requiring the typed phrase
  const token = url.searchParams.get('token') || '';
  const raw = await env.GUEST_KV.get('panic:pending');
  if (!raw || JSON.parse(raw).token !== token) {
    return new Response(confirmResultPage(false, 'This confirmation link is invalid or has already been used.', 'Lockdown Not Confirmed'), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }
  if (Date.now() > JSON.parse(raw).expiresAt) {
    return new Response(confirmResultPage(false, 'This confirmation link has expired.', 'Lockdown Not Confirmed'), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  return new Response(panicConfirmPage(token), {
    status: 200, headers: { 'Content-Type': 'text/html' },
  });
}

function panicConfirmPage(token, error) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm Emergency Lockdown — Admin</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0E1B3D;font-family:sans-serif;color:#F5F1E8;padding:20px;}
  .card{background:#16234F;border:1px solid #D9584F;border-radius:10px;padding:32px;width:340px;box-sizing:border-box;}
  h1{font-size:18px;margin:0 0 12px 0;color:#D9584F;}
  p{color:#AEB9D4;font-size:13px;line-height:1.6;margin-bottom:16px;}
  input{width:100%;box-sizing:border-box;background:#0E1B3D;border:1px solid #243466;color:#F5F1E8;
    padding:10px 12px;border-radius:6px;margin-bottom:12px;font-size:14px;}
  button{width:100%;background:#D9584F;color:#0E1B3D;border:none;padding:10px;border-radius:6px;
    font-weight:600;cursor:pointer;font-size:14px;}
  .error{color:#D9584F;font-size:12px;margin-bottom:12px;}
</style>
</head>
<body>
  <form class="card" method="POST">
    <h1>Confirm Emergency Lockdown</h1>
    <p>This will instantly revoke every guest login and close the workspace to everyone. Type the phrase below exactly to confirm.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <input type="text" name="confirm_phrase" placeholder="Type: LOCK IT DOWN" autofocus required>
    <button type="submit">Confirm Lockdown</button>
  </form>
</body>
</html>`;
}

function emailComposePage(ownerUser, ownerPass, target, error) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Email ${escapeHtml(target)} — Admin</title>
<style>
  body{margin:0;min-height:100vh;background:#0E1B3D;font-family:sans-serif;color:#F5F1E8;padding:40px 20px;}
  .wrap{max-width:500px;margin:0 auto;}
  h1{font-size:20px;margin-bottom:6px;}
  .sub{color:#6C7BA3;font-size:13px;margin-bottom:24px;}
  .box{background:#16234F;border:1px solid #243466;border-radius:8px;padding:20px;}
  .field{background:#0E1B3D;border:1px solid #243466;color:#F5F1E8;
    padding:10px 12px;border-radius:6px;font-size:14px;width:100%;box-sizing:border-box;margin-bottom:12px;}
  .field:focus{outline:none;border-color:#E0AC3F;}
  select.field{margin-bottom:12px;}
  textarea.field{resize:vertical;font-family:sans-serif;}
  button.primary{background:#E0AC3F;color:#0E1B3D;border:none;padding:10px 20px;border-radius:6px;
    font-weight:600;cursor:pointer;font-size:14px;}
  .small-btn{background:#1D2C5C;border:1px solid #243466;color:#F5F1E8;padding:8px 14px;border-radius:5px;
    cursor:pointer;font-size:13px;}
  .small-btn:hover{border-color:#E0AC3F;}
  .error{color:#D9584F;font-size:12px;margin-bottom:12px;}
  .back-link{color:#6C7BA3;font-size:12px;text-decoration:none;display:inline-block;margin-top:16px;}
  .back-link:hover{color:#F5F1E8;}
  .preview{font-size:12px;color:#6C7BA3;background:#0E1B3D;border-radius:6px;padding:12px;margin-bottom:16px;line-height:1.6;}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Email guest login: ${escapeHtml(target)}</h1>
    <div class="sub">This email will automatically include this guest's username and password.</div>
    <div class="box">
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <div class="preview">Includes: website link, username <strong>${escapeHtml(target)}</strong>, and password — automatically.</div>
      <form method="POST" action="/admin/email">
        <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
        <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
        <input type="hidden" name="target" value="${escapeHtml(target)}">
        <input type="hidden" name="stage" value="send">

        <input type="email" name="compose_to" placeholder="To: recipient@email.com" class="field" required>
        <select name="compose_from" class="field">
          <option value="anonymous">From: Anonymous</option>
          <option value="shaurya">From: Shaurya</option>
        </select>

        <button type="button" id="revealMsgBtn" class="small-btn">Add Message</button>

        <div id="extraMessageArea" style="display:none;margin-top:12px;">
          <textarea name="extra_message" class="field" rows="5" placeholder="Optional extra message, added below the login details..."></textarea>
        </div>

        <div style="margin-top:14px;">
          <button type="submit" class="primary">Send Email</button>
        </div>
      </form>
    </div>
    <form method="POST" action="/admin" style="display:inline;">
      <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
      <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
      <button type="submit" class="back-link" style="background:none;border:none;cursor:pointer;padding:0;">&larr; Back to Admin</button>
    </form>
  </div>
  <script>
    (function(){
      var revealBtn = document.getElementById('revealMsgBtn');
      var msgArea = document.getElementById('extraMessageArea');
      revealBtn.addEventListener('click', function(){
        msgArea.style.display = 'block';
        revealBtn.style.display = 'none';
      });
    })();
  </script>
</body>
</html>`;
}

function emailSentPage(ownerUser, ownerPass, to) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Email Sent — Admin</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0E1B3D;font-family:sans-serif;color:#F5F1E8;text-align:center;}
  .card{max-width:360px;padding:20px;}
  h1{font-size:20px;color:#6FE0A0;margin-bottom:10px;}
  p{color:#AEB9D4;font-size:14px;margin-bottom:20px;}
  button{background:#E0AC3F;color:#0E1B3D;border:none;padding:10px 20px;border-radius:6px;
    font-weight:600;cursor:pointer;font-size:14px;}
</style>
</head>
<body>
  <div class="card">
    <h1>Email sent</h1>
    <p>Sent to ${escapeHtml(to)}.</p>
    <form method="POST" action="/admin">
      <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
      <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
      <button type="submit">Back to Admin</button>
    </form>
  </div>
</body>
</html>`;
}

async function buildRequestRowsHtml(env, ownerUser, ownerPass) {
  const list = await env.GUEST_KV.list({ prefix: 'request:' });
  if (list.keys.length === 0) {
    return `<tr><td colspan="4" style="color:#6C7BA3;">No pending requests.</td></tr>`;
  }

  const rows = await Promise.all(list.keys.map(async (key) => {
    const raw = await env.GUEST_KV.get(key.name);
    if (!raw) return '';
    const req = JSON.parse(raw);
    const requestedAgo = new Date(req.requestedAt).toLocaleString();

    return `
      <tr>
        <td>${escapeHtml(req.firstName)} ${escapeHtml(req.lastName)}</td>
        <td>${escapeHtml(req.username)}</td>
        <td>${escapeHtml(requestedAgo)}</td>
        <td>
          <form method="POST" style="display:inline;">
            <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
            <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
            <input type="hidden" name="action" value="accept_request">
            <input type="hidden" name="target" value="${escapeHtml(req.username)}">
            <button type="submit" class="small-btn">Accept</button>
          </form>
          <form method="POST" style="display:inline;">
            <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
            <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
            <input type="hidden" name="action" value="deny_request">
            <input type="hidden" name="target" value="${escapeHtml(req.username)}">
            <button type="submit" class="small-btn danger">Deny</button>
          </form>
        </td>
      </tr>
    `;
  }));

  return rows.join('');
}

async function buildGuestRowsHtml(env, ownerUser, ownerPass, justCreated) {
  const list = await env.GUEST_KV.list({ prefix: 'guest:' });
  let rows = '';
  const seenUsernames = new Set();

  function formatTimeAgo(diffMs){
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }

  async function buildRow(username, guest) {
    const activityRaw = await env.GUEST_KV.get('activity:' + username);
    let presenceHtml;
    if (activityRaw) {
      const activity = JSON.parse(activityRaw);
      const diff = Date.now() - activity.timestamp;
      presenceHtml = diff < 15000
        ? `<span style="color:#6FE0A0;">&#9679; Online &mdash; ${escapeHtml(activity.view || 'unknown page')}</span>`
        : `<span style="color:#6C7BA3;">Last seen ${formatTimeAgo(diff)}</span>`;
    } else if (guest.accessCount > 0) {
      // Their short-lived presence entry expired (5 min TTL), but they have
      // genuinely logged in before — "never accessed" would be misleading here.
      presenceHtml = '<span style="color:#6C7BA3;">Not currently online</span>';
    } else {
      presenceHtml = '<span style="color:#6C7BA3;">Never accessed</span>';
    }

    const expired = isGuestExpired(guest);
    let statusHtml;
    if (expired) statusHtml = '<span class="revoked">Expired</span>';
    else if (guest.active) statusHtml = '<span class="active">Active</span>';
    else statusHtml = '<span class="revoked">Revoked</span>';

    const expiresHtml = guest.expiresAt
      ? `<span style="color:${expired ? '#D9584F' : '#AEB9D4'};font-size:12px;">${new Date(guest.expiresAt).toLocaleDateString('en-GB')}</span>`
      : '<span style="color:#6C7BA3;font-size:12px;">Never</span>';

    const restrictedHtml = guest.allowedHubs && guest.allowedHubs.length
      ? `<span style="color:#5B8DEF;font-size:12px;">${guest.allowedHubs.map(id => escapeHtml((HUB_OPTIONS.find(h => h.id === id) || {}).label || id)).join(', ')}</span>`
      : '<span style="color:#6C7BA3;font-size:12px;">All</span>';

    return `
      <tr>
        <td>${escapeHtml(username)}</td>
        <td>${escapeHtml(guest.password)}</td>
        <td>${guest.accessCount || 0}</td>
        <td>${presenceHtml}</td>
        <td>${expiresHtml}</td>
        <td>${restrictedHtml}</td>
        <td>${statusHtml}</td>
        <td>
          <form method="POST" action="/admin" style="display:inline;">
            <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
            <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
            <input type="hidden" name="action" value="toggle">
            <input type="hidden" name="target" value="${escapeHtml(username)}">
            <button type="submit" class="small-btn">${guest.active ? 'Revoke' : 'Reactivate'}</button>
          </form>
          <form method="POST" action="/admin" style="display:inline;">
            <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
            <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
            <input type="hidden" name="action" value="delete">
            <input type="hidden" name="target" value="${escapeHtml(username)}">
            <button type="submit" class="small-btn danger">Delete</button>
          </form>
          <form method="POST" action="/admin/email" style="display:inline;">
            <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
            <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
            <input type="hidden" name="target" value="${escapeHtml(username)}">
            <button type="submit" class="small-btn">Email</button>
          </form>
          <form method="POST" action="/" target="_blank" style="display:inline;">
            <input type="hidden" name="username" value="${escapeHtml(ownerUser)}">
            <input type="hidden" name="password" value="${escapeHtml(ownerPass)}">
            <input type="hidden" name="preview_as" value="${escapeHtml(username)}">
            <button type="submit" class="small-btn">Preview</button>
          </form>
        </td>
      </tr>
    `;
  }

  for (const key of list.keys) {
    const raw = await env.GUEST_KV.get(key.name);
    if (!raw) continue; // list() can briefly show a key that was just deleted — skip it
    const guest = JSON.parse(raw);
    const username = key.name.replace('guest:', '');
    seenUsernames.add(username);
    rows += await buildRow(username, guest);
  }

  // KV's list() can lag a few seconds behind a write that just happened —
  // if the guest we just created isn't in the list yet, show it anyway.
  if (justCreated && !seenUsernames.has(justCreated.username)) {
    rows = (await buildRow(justCreated.username, justCreated)) + rows;
  }

  if (!rows) {
    rows = '<tr><td colspan="8" style="text-align:center;color:#6C7BA3;">No guest logins yet — create one below.</td></tr>';
  }

  return rows;
}

async function adminPanelPage(env, ownerUser, ownerPass, createError, justCreated, emailStatus, panicStatus, passwordChangeStatus) {
  const rows = await buildGuestRowsHtml(env, ownerUser, ownerPass, justCreated);
  const requestRows = await buildRequestRowsHtml(env, ownerUser, ownerPass);
  const maintenanceRaw = await env.GUEST_KV.get('site:maintenance');
  const maintenance = maintenanceRaw ? JSON.parse(maintenanceRaw) : { enabled: false, message: '' };

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guest Access — Admin</title>
<style>
  body{margin:0;min-height:100vh;background:#0E1B3D;font-family:sans-serif;color:#F5F1E8;padding:40px 20px;}
  .wrap{max-width:900px;margin:0 auto;}
  h1{font-size:22px;margin-bottom:6px;}
  .sub{color:#6C7BA3;font-size:13px;margin-bottom:28px;}
  table{width:100%;border-collapse:collapse;background:#16234F;border-radius:8px;overflow:hidden;margin-bottom:24px;}
  th, td{padding:10px 12px;text-align:left;font-size:13px;border-bottom:1px solid #243466;}
  th{color:#F0CE85;font-size:11px;text-transform:uppercase;letter-spacing:.05em;}
  .active{color:#6FE0A0;}
  .revoked{color:#D9584F;}
  .small-btn{background:#1D2C5C;border:1px solid #243466;color:#F5F1E8;padding:5px 10px;border-radius:5px;
    cursor:pointer;font-size:12px;margin-right:4px;}
  .small-btn.danger:hover{border-color:#D9584F;color:#D9584F;}
  .small-btn:hover{border-color:#E0AC3F;}
  form.create{background:#16234F;border-radius:8px;padding:20px;}
  form.create input[type="text"], form.create input[type="email"]{background:#0E1B3D;border:1px solid #243466;color:#F5F1E8;
    padding:10px 12px;border-radius:6px;font-size:14px;flex:1;min-width:160px;}
  form.create input[type="text"]:focus, form.create input[type="email"]:focus{outline:none;border-color:#E0AC3F;}
  .create-subsection-label{font-size:12px;color:#6C7BA3;margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em;}
  .compose-field-select{background:#0E1B3D;border:1px solid #243466;color:#F5F1E8;
    padding:8px 10px;border-radius:6px;font-size:13px;flex:1;}
  .compose-field-select:focus{outline:none;border-color:#E0AC3F;}
  .create-error{color:#D9584F;font-size:12px;margin-bottom:10px;}
  .email-status{font-size:12px;margin-bottom:14px;padding:8px 12px;border-radius:6px;}
  .email-status.ok{color:#6FE0A0;background:rgba(111,224,160,0.1);}
  .email-status.fail{color:#D9584F;background:rgba(217,88,79,0.1);}
  button.primary{background:#E0AC3F;color:#0E1B3D;border:none;padding:10px 20px;border-radius:6px;
    font-weight:600;cursor:pointer;font-size:14px;flex-shrink:0;}
  .section-title{font-size:15px;color:#F0CE85;margin:32px 0 12px 0;text-transform:uppercase;letter-spacing:.05em;}
  .maintenance-box{background:#16234F;border-radius:8px;padding:20px;border:1px solid #243466;}
  .maintenance-status{font-size:13px;margin-bottom:14px;}
  .maintenance-status.on{color:#D9584F;}
  .maintenance-status.off{color:#6FE0A0;}
  button.danger-primary{background:#D9584F;color:#0E1B3D;border:none;padding:10px 20px;border-radius:6px;
    font-weight:600;cursor:pointer;font-size:14px;}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Request Access</h1>
    <div class="sub">People who've asked for a login via /signup — accept to create their account, deny to dismiss.</div>
    <div style="overflow-x:auto;">
      <table>
        <thead><tr><th>Name</th><th>Username</th><th>Requested</th><th>Actions</th></tr></thead>
        <tbody id="requestRows">${requestRows}</tbody>
      </table>
    </div>

    <h1>Guest Access</h1>
    <div class="sub">Create temporary logins for friends, see how many times they've used it, revoke anytime.</div>
    <div style="overflow-x:auto;">
      <table>
        <thead><tr><th>Username</th><th>Password</th><th>Uses</th><th>Presence</th><th>Expires</th><th>Restricted To</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody id="guestRows">${rows}</tbody>
      </table>
    </div>
    ${emailStatus ? `<div class="email-status ${emailStatus.ok ? 'ok' : 'fail'}">${escapeHtml(emailStatus.text)}</div>` : ''}
    ${createError ? `<div class="create-error">${escapeHtml(createError)}</div>` : ''}
    <form method="POST" class="create">
      <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
      <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
      <input type="hidden" name="action" value="create">
      <input type="text" name="new_first_name" placeholder="First name" required style="width:100%;box-sizing:border-box;margin-bottom:14px;">
      <input type="text" name="new_last_name" placeholder="Last name" required style="width:100%;box-sizing:border-box;margin-bottom:14px;">
      <input type="email" name="new_email" placeholder="Email (optional)" style="width:100%;box-sizing:border-box;margin-bottom:6px;">
      <div style="color:#6C7BA3;font-size:11px;margin-bottom:14px;line-height:1.4;">If set, they'll get notified about access changes and hub shutdowns.</div>

      <div class="create-subsection-label">Auto-expire (optional — leave blank to never expire)</div>
      <div style="display:flex;gap:8px;margin-bottom:16px;">
        <select name="expire_day" class="compose-field-select">
          <option value="">Day</option>
          ${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}
        </select>
        <select name="expire_month" class="compose-field-select">
          <option value="">Month</option>
          ${['January','February','March','April','May','June','July','August','September','October','November','December']
            .map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}
        </select>
        <select name="expire_year" class="compose-field-select">
          <option value="">Year</option>
          ${Array.from({ length: 4 }, (_, i) => new Date().getFullYear() + i)
            .map(y => `<option value="${y}">${y}</option>`).join('')}
        </select>
      </div>

      <div class="create-subsection-label">Restrict to specific hubs (optional — leave all unchecked for full access)</div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
        ${HUB_OPTIONS.map(h => `
          <label style="font-size:13px;color:#AEB9D4;display:flex;align-items:center;gap:5px;">
            <input type="checkbox" name="allowed_hub" value="${h.id}"> ${h.label}
          </label>
        `).join('')}
      </div>

      <button type="submit" class="primary">+ Create Guest Login</button>
    </form>

    <div class="section-title">Maintenance Mode</div>
    <div class="maintenance-box">
      <div class="maintenance-status ${maintenance.enabled ? 'on' : 'off'}">
        ${maintenance.enabled ? 'Currently CLOSED to everyone, including you at the main site.' : 'Currently open as normal.'}
      </div>
      <form method="POST">
        <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
        <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
        <input type="hidden" name="action" value="toggle_maintenance">
        ${!maintenance.enabled ? `
          <input type="text" name="maintenance_message" placeholder="Message to show visitors (optional)"
            style="width:100%;box-sizing:border-box;background:#0E1B3D;border:1px solid #243466;color:#F5F1E8;
            padding:10px 12px;border-radius:6px;font-size:14px;margin-bottom:12px;">
          <button type="submit" class="danger-primary">Close the Workspace</button>
        ` : `
          <button type="submit" class="primary">Reopen the Workspace</button>
        `}
      </form>
    </div>

    <div class="section-title">Panic Button</div>
    <div class="maintenance-box" style="border-color:#D9584F;">
      <div style="font-size:13px;color:#AEB9D4;margin-bottom:14px;">Instantly revokes every guest login and closes the workspace. Uses your normal login, but requires confirming via an emailed link and typing a phrase before it actually happens — nothing changes until then.</div>
      ${panicStatus ? `<div class="email-status ${panicStatus.ok ? 'ok' : 'fail'}">${escapeHtml(panicStatus.text)}</div>` : ''}
      <form method="POST">
        <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
        <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
        <input type="hidden" name="action" value="request_panic">
        <button type="submit" class="danger-primary">Request Emergency Lockdown</button>
      </form>
    </div>

    <div class="section-title">Change Owner Password</div>
    <div class="maintenance-box">
      <div style="font-size:13px;color:#AEB9D4;margin-bottom:14px;">Requires confirming via a link sent to ${escapeHtml(env.OWNER_EMAIL || 'your owner email')} before it actually takes effect — nothing changes until you click that link.</div>
      ${passwordChangeStatus ? `<div class="email-status ${passwordChangeStatus.ok ? 'ok' : 'fail'}">${escapeHtml(passwordChangeStatus.text)}</div>` : ''}
      <form method="POST">
        <input type="hidden" name="owner_username" value="${escapeHtml(ownerUser)}">
        <input type="hidden" name="owner_password" value="${escapeHtml(ownerPass)}">
        <input type="hidden" name="action" value="request_password_change">
        <input type="password" name="new_owner_password" placeholder="New password" required
          style="width:100%;box-sizing:border-box;background:#0E1B3D;border:1px solid #243466;color:#F5F1E8;
          padding:10px 12px;border-radius:6px;font-size:14px;margin-bottom:12px;">
        <button type="submit" class="primary">Request Password Change</button>
      </form>
    </div>
  </div>
  <script>
    (function(){
      var ownerUsername = ${JSON.stringify(ownerUser)};
      var ownerPassword = ${JSON.stringify(ownerPass)};
      var guestRows = document.getElementById('guestRows');

      function refresh(){
        var active = document.activeElement;
        if(active && guestRows.contains(active)){
          return; // don't overwrite an in-progress email/username while you're typing it
        }
        fetch('/__admin_refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner_username: ownerUsername, owner_password: ownerPassword })
        }).then(function(r){ return r.json(); }).then(function(data){
          if(data.rowsHtml !== undefined){
            guestRows.innerHTML = data.rowsHtml;
          }
        }).catch(function(){});
      }
      setInterval(refresh, 3000);
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function maintenancePage(message) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shaurya's Hub — Temporarily Closed</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0E1B3D;font-family:sans-serif;text-align:center;padding:20px;}
  .card{max-width:400px;}
  h1{color:#F5F1E8;font-size:24px;margin:0 0 14px 0;}
  p{color:#AEB9D4;font-size:14px;line-height:1.6;margin:0;}
</style>
</head>
<body>
  <div class="card">
    <h1>Sorry, this workspace is temporarily closed.</h1>
    ${message ? `<p>${escapeHtml(message)}</p>` : ''}
  </div>
</body>
</html>`;
}

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shaurya's Hub — Sign In</title>
<meta name="description" content="Shaurya's Hub — a personal workspace with study tools, games, an AI assistant, and live multiplayer, built by Shaurya Kshitij.">
<meta property="og:title" content="Shaurya's Hub">
<meta property="og:description" content="A personal workspace with study tools, games, an AI assistant, and live multiplayer.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://shauryashub.dev">
<meta name="theme-color" content="#0E1B3D">
<link rel="icon" href="/favicon.ico" sizes="any">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0E1B3D;font-family:sans-serif;}
  .card{background:#16234F;border:1px solid #243466;border-radius:10px;padding:36px 32px;width:280px;}
  h1{color:#F5F1E8;font-size:20px;margin:0 0 18px 0;text-align:center;}
  input{width:100%;box-sizing:border-box;background:#0E1B3D;border:1px solid #243466;color:#F5F1E8;
    padding:10px 12px;border-radius:6px;margin-bottom:12px;font-size:14px;}
  button{width:100%;background:#E0AC3F;color:#0E1B3D;border:none;padding:10px;border-radius:6px;
    font-weight:600;cursor:pointer;font-size:14px;}
  .error{color:#D9584F;font-size:12px;margin-bottom:12px;text-align:center;}
  .request-link{display:block;text-align:center;margin-top:16px;color:#8B9BC4;font-size:12px;text-decoration:none;}
  .request-link:hover{color:#E0AC3F;}
</style>
</head>
<body>
  <form class="card" method="POST">
    <h1>Shaurya's Hub</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <input type="text" name="username" placeholder="Username" autofocus required>
    <input type="password" name="password" placeholder="Password" required>
    <button type="submit">Enter</button>
    <a class="request-link" href="/signup">Don't have access? Request it</a>
  </form>
</body>
</html>`;
}

function adminLoginPage(error) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guest Access — Owner Login</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0E1B3D;font-family:sans-serif;}
  .card{background:#16234F;border:1px solid #243466;border-radius:10px;padding:36px 32px;width:280px;}
  h1{color:#F5F1E8;font-size:18px;margin:0 0 18px 0;text-align:center;}
  input{width:100%;box-sizing:border-box;background:#0E1B3D;border:1px solid #243466;color:#F5F1E8;
    padding:10px 12px;border-radius:6px;margin-bottom:12px;font-size:14px;}
  button{width:100%;background:#E0AC3F;color:#0E1B3D;border:none;padding:10px;border-radius:6px;
    font-weight:600;cursor:pointer;font-size:14px;}
  .error{color:#D9584F;font-size:12px;margin-bottom:12px;text-align:center;}
</style>
</head>
<body>
  <form class="card" method="POST">
    <h1>Guest Access — Owner Only</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <input type="hidden" name="action" value="view">
    <input type="text" name="owner_username" placeholder="Owner username" autofocus required>
    <input type="password" name="owner_password" placeholder="Owner password" required>
    <button type="submit">Enter</button>
  </form>
</body>
</html>`;
}
