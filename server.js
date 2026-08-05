'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Keep the connection alive across brief mobile network hiccups.
  pingTimeout: 20000,
  pingInterval: 25000,
});

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------
// rooms: roomId -> { hostId: socketId|null, guestId: socketId|null, createdAt }
const rooms = new Map();

const ROOM_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no easily-confused chars

function generateRoomId(length = 6) {
  let id = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    id += ROOM_ID_ALPHABET[bytes[i] % ROOM_ID_ALPHABET.length];
  }
  // Extremely unlikely to collide, but guarantee uniqueness anyway.
  return rooms.has(id) ? generateRoomId(length) : id;
}

// ---------------------------------------------------------------------------
// Static files + routes
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
// Parse JSON bodies. The diagnose route carries base64 JPEG frames, so raise
// the default limit well above a single downscaled capture.
app.use(express.json({ limit: '15mb' }));

app.get('/', (req, res) => {
  res.redirect('/host');
});

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

// The guest link. roomId is read client-side from the path.
app.get('/join/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guest.html'));
});

// Lightweight endpoint the guest page can use to check a room is live.
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  res.json({
    exists: Boolean(room),
    hostConnected: Boolean(room && room.hostId),
  });
});

// ICE servers for NAT traversal. Always returns Google's free STUN server.
// If TURN_URLS is configured (from a provider like Cloudflare, Metered, Xirsys,
// or self-hosted coturn), a TURN relay is added as a fallback for restrictive
// networks where direct peer-to-peer fails. Kept server-side so credentials
// aren't hard-coded in the client and can be rotated without a redeploy.
async function buildIceServers() {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  // Preferred: Metered — fetch fresh TURN credentials with an API key.
  if (process.env.METERED_DOMAIN && process.env.METERED_API_KEY) {
    try {
      const url = `https://${process.env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(
        process.env.METERED_API_KEY
      )}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const list = await resp.json();
        if (Array.isArray(list)) {
          for (const s of list) {
            if (s && s.urls) iceServers.push(s);
          }
          return iceServers;
        }
      } else {
        console.error('[ice] Metered credentials fetch failed:', resp.status);
      }
    } catch (err) {
      console.error('[ice] Metered credentials error:', err.message);
    }
  }

  // Fallback: static TURN credentials from env vars.
  if (process.env.TURN_URLS) {
    const urls = process.env.TURN_URLS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length) {
      const entry = { urls };
      if (process.env.TURN_USERNAME) entry.username = process.env.TURN_USERNAME;
      if (process.env.TURN_CREDENTIAL) entry.credential = process.env.TURN_CREDENTIAL;
      iceServers.push(entry);
    }
  }

  return iceServers;
}

app.get('/api/ice-servers', async (req, res) => {
  // Don't let stale ICE config get cached by the browser.
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers: await buildIceServers() });
});

// ---------------------------------------------------------------------------
// AI copilot chat (host view only)
// ---------------------------------------------------------------------------
// A running chat with Claude, scoped to the WebRTC room. Each agent turn is
// text and/or an optional screen grab of the guest's TV. Attached JPEGs live on
// disk under /captures; the DB stores their paths + the transcript so nothing
// is lost on a server restart.
const capturesDir = path.join(__dirname, 'captures');
fs.mkdirSync(capturesDir, { recursive: true });

const db = new Database(path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = WAL');

// One row per turn: role 'user' (agent) or 'assistant' (Claude); user turns may
// carry an image, an assistant turn is text only.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomId TEXT,
    createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId INTEGER,
    role TEXT,
    text TEXT,
    imagePath TEXT,
    timestamp INTEGER
  );
`);

// Serve attached frames read-only for the history page thumbnails.
app.use('/captures', express.static(capturesDir));

// The Anthropic key never reaches the browser. If it's unset the chat still
// records messages; the reply is a "not configured" message instead.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const AI_MODEL = 'claude-sonnet-4-6';

// Re-read the prompt on every call so the file can be edited without a restart.
function loadSystemPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, 'systemPrompt.txt'), 'utf8');
  } catch (_) {
    return 'You are an AI copilot for a Channel D support agent helping dental practices install a TV signage app.';
  }
}

function getOrCreateSession(roomId) {
  let row = db
    .prepare('SELECT * FROM sessions WHERE roomId = ? ORDER BY id DESC LIMIT 1')
    .get(roomId);
  if (!row) {
    const info = db
      .prepare('INSERT INTO sessions (roomId, createdAt) VALUES (?, ?)')
      .run(roomId, Date.now());
    row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  }
  return row;
}

// Rebuild the Anthropic conversation for a session from the stored transcript.
function buildConversation(sessionId) {
  const rows = db
    .prepare('SELECT * FROM messages WHERE sessionId = ? ORDER BY id ASC')
    .all(sessionId);
  const messages = [];
  rows.forEach((m) => {
    if (m.role === 'assistant') {
      messages.push({ role: 'assistant', content: m.text || '(no response)' });
      return;
    }
    const content = [];
    if (m.imagePath) {
      try {
        const b64 = fs.readFileSync(m.imagePath).toString('base64');
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
        });
      } catch (_) {
        /* image file missing — send text alone rather than failing */
      }
    }
    // Always include a text block (the API requires non-empty content).
    content.push({ type: 'text', text: m.text || '(screenshot attached)' });
    messages.push({ role: 'user', content });
  });
  return messages;
}

// Generate an assistant reply for the current transcript, persist it, and
// return it. Shared by the send and retry paths.
async function generateReply(session, res) {
  if (!anthropic) {
    return res.json({ error: 'AI is not configured. Set ANTHROPIC_API_KEY on the server.' });
  }
  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      system: loadSystemPrompt(),
      messages: buildConversation(session.id),
    });
    const reply =
      (response.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim() || '(no response)';
    db.prepare(
      'INSERT INTO messages (sessionId, role, text, imagePath, timestamp) VALUES (?, ?, ?, NULL, ?)'
    ).run(session.id, 'assistant', reply, Date.now());
    res.json({ reply });
  } catch (err) {
    // Nothing persisted for this failed turn — the agent can retry, which
    // regenerates against the same trailing user turn.
    console.error('[chat] AI call failed:', err.message);
    res.json({ error: `AI request failed: ${err.message}` });
  }
}

app.post('/api/chat', async (req, res) => {
  const { roomId, text, image, retry } = req.body || {};
  if (!roomId) return res.status(400).json({ error: 'Missing roomId' });

  const session = getOrCreateSession(roomId);

  if (retry) {
    // Regenerate for the trailing agent turn without adding a new message.
    const last = db
      .prepare('SELECT * FROM messages WHERE sessionId = ? ORDER BY id DESC LIMIT 1')
      .get(session.id);
    if (!last || last.role !== 'user') {
      return res.status(400).json({ error: 'Nothing to retry' });
    }
    return generateReply(session, res);
  }

  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed && !image) {
    return res.status(400).json({ error: 'Message needs text or an attachment' });
  }

  // Persist the agent turn (+ optional screenshot).
  const info = db
    .prepare(
      'INSERT INTO messages (sessionId, role, text, imagePath, timestamp) VALUES (?, ?, ?, ?, ?)'
    )
    .run(session.id, 'user', trimmed, null, Date.now());
  const id = info.lastInsertRowid;

  if (image) {
    const base64 = String(image).replace(/^data:image\/\w+;base64,/, '');
    const filepath = path.join(capturesDir, `capture-${id}.jpg`);
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
    db.prepare('UPDATE messages SET imagePath = ? WHERE id = ?').run(filepath, id);
  }

  return generateReply(session, res);
});

// Read-only chat history.
app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/api/history', (req, res) => {
  const sessions = db
    .prepare(
      `SELECT s.id, s.roomId, s.createdAt,
              (SELECT COUNT(*) FROM messages m WHERE m.sessionId = s.id AND m.role = 'user') AS messageCount,
              (SELECT text FROM messages m
                 WHERE m.sessionId = s.id AND m.role = 'user' AND m.text != ''
                 ORDER BY m.id ASC LIMIT 1) AS preview
       FROM sessions s
       ORDER BY s.createdAt DESC`
    )
    .all();
  res.json({ sessions });
});

app.get('/api/history/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const messages = db
    .prepare('SELECT * FROM messages WHERE sessionId = ? ORDER BY id ASC')
    .all(session.id)
    .map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      imageUrl: m.imagePath ? '/captures/' + path.basename(m.imagePath) : null,
    }));
  res.json({ session, messages });
});

// ---------------------------------------------------------------------------
// Send the join link by SMS via TextBelt (pay-as-you-go, no monthly fee)
// ---------------------------------------------------------------------------
// Set TEXTBELT_API_KEY to your purchased key. Defaults to the shared "textbelt"
// test key, which allows 1 free SMS per day (fine for a first test).
app.post('/api/send-sms', async (req, res) => {
  const { phone, link } = req.body || {};
  if (!phone || !link) {
    return res.status(400).json({ ok: false, error: 'Missing phone number or link' });
  }
  const key = process.env.TEXTBELT_API_KEY || 'textbelt';
  const message = `Channel D video support — tap to join the call: ${link}`;
  try {
    const resp = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ phone, message, key }).toString(),
    });
    const data = await resp.json();
    if (data.success) {
      res.json({ ok: true, quotaRemaining: data.quotaRemaining });
    } else {
      res.json({ ok: false, error: data.error || 'SMS failed', quotaRemaining: data.quotaRemaining });
    }
  } catch (err) {
    console.error('[sms] TextBelt request failed:', err.message);
    res.json({ ok: false, error: 'SMS request failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Signaling
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // socket.data holds { roomId, role }
  console.log(`[socket] connected: ${socket.id}`);

  // --- Host creates a room ------------------------------------------------
  socket.on('create-room', (_payload, ack) => {
    const roomId = generateRoomId();
    rooms.set(roomId, {
      hostId: socket.id,
      guestId: null,
      createdAt: Date.now(),
    });

    socket.data.roomId = roomId;
    socket.data.role = 'host';
    socket.join(roomId);

    console.log(`[room] created ${roomId} by host ${socket.id}`);
    if (typeof ack === 'function') ack({ roomId });
  });

  // --- Host re-attaches to an existing room (e.g. page reload) -------------
  socket.on('host-rejoin', (roomId, ack) => {
    const room = rooms.get(roomId);
    if (!room) {
      // Recreate the room so an old link keeps working after a server restart.
      rooms.set(roomId, { hostId: socket.id, guestId: null, createdAt: Date.now() });
    } else {
      room.hostId = socket.id;
    }
    socket.data.roomId = roomId;
    socket.data.role = 'host';
    socket.join(roomId);

    const guestId = rooms.get(roomId).guestId;
    if (typeof ack === 'function') ack({ roomId, guestConnected: Boolean(guestId) });

    // If a guest is already waiting, kick off (re)negotiation.
    if (guestId) {
      io.to(guestId).emit('peer-rejoined', { role: 'host' });
      socket.emit('guest-ready');
    }
  });

  // --- Guest joins a room -------------------------------------------------
  socket.on('join-room', (roomId, ack) => {
    const room = rooms.get(roomId);

    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, reason: 'not-found' });
      return;
    }

    room.guestId = socket.id;
    socket.data.roomId = roomId;
    socket.data.role = 'guest';
    socket.join(roomId);

    console.log(`[room] guest ${socket.id} joined ${roomId}`);
    if (typeof ack === 'function') {
      ack({ ok: true, hostConnected: Boolean(room.hostId) });
    }

    // Tell the host to start the WebRTC offer. Host is the offerer.
    if (room.hostId) {
      io.to(room.hostId).emit('guest-ready');
    }
  });

  // --- Relay SDP + ICE between the two peers in a room --------------------
  socket.on('signal', (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    // A room only ever has host + guest, so broadcasting to the room
    // (excluding sender) reaches exactly the other peer.
    socket.to(roomId).emit('signal', payload);
  });

  // --- Explicit mute state relay (nice-to-have UI signal) -----------------
  socket.on('peer-state', (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('peer-state', payload);
  });

  // --- Disconnect handling ------------------------------------------------
  socket.on('disconnect', (reason) => {
    const { roomId, role } = socket.data;
    console.log(`[socket] disconnected: ${socket.id} (${reason})`);
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (role === 'host' && room.hostId === socket.id) {
      room.hostId = null;
    } else if (role === 'guest' && room.guestId === socket.id) {
      room.guestId = null;
    }

    // Let the remaining peer know so it can show a "disconnected" state.
    socket.to(roomId).emit('peer-disconnected', { role });

    // Clean up fully-empty rooms.
    if (!room.hostId && !room.guestId) {
      rooms.delete(roomId);
      console.log(`[room] removed empty room ${roomId}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Channel D Connect running on http://localhost:${PORT}`);
  console.log(`  Host view:  http://localhost:${PORT}/host`);
});
