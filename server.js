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
function buildIceServers() {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

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

app.get('/api/ice-servers', (req, res) => {
  // Don't let stale ICE config get cached by the browser.
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers: buildIceServers() });
});

// ---------------------------------------------------------------------------
// AI diagnosis assistant (host view only)
// ---------------------------------------------------------------------------
// Captured JPEGs live on disk under /captures; the DB stores their paths plus
// the running conversation so nothing is lost on a server restart.
const capturesDir = path.join(__dirname, 'captures');
fs.mkdirSync(capturesDir, { recursive: true });

const db = new Database(path.join(__dirname, 'diagnosis.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roomId TEXT,
    caseDescription TEXT,
    createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId INTEGER,
    role TEXT,
    note TEXT,
    imagePath TEXT,
    aiReply TEXT,
    timestamp INTEGER
  );
`);

// Serve captured frames read-only for the history page thumbnails.
app.use('/captures', express.static(capturesDir));

// The Anthropic key never reaches the browser. If it's unset the panel still
// works for capturing; diagnose just returns a "not configured" message.
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const AI_MODEL = 'claude-sonnet-4-6';

// Re-read the prompt on every call so the file can be edited without a restart.
function loadSystemPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, 'systemPrompt.txt'), 'utf8');
  } catch (_) {
    return 'You are a support copilot for Channel D, a TV signage app for dental practices.';
  }
}

function getOrCreateSession(roomId) {
  let row = db
    .prepare('SELECT * FROM sessions WHERE roomId = ? ORDER BY id DESC LIMIT 1')
    .get(roomId);
  if (!row) {
    const info = db
      .prepare('INSERT INTO sessions (roomId, caseDescription, createdAt) VALUES (?, ?, ?)')
      .run(roomId, '', Date.now());
    row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  }
  return row;
}

// Rebuild the full Anthropic conversation for a session from disk: case
// description + every capture (image + note) + every prior AI reply. The latest
// capture (aiReply still null) becomes the final user turn we want answered.
function buildConversation(session) {
  const rows = db
    .prepare('SELECT * FROM messages WHERE sessionId = ? ORDER BY id ASC')
    .all(session.id);
  const messages = [];
  rows.forEach((m, idx) => {
    const content = [];
    try {
      const b64 = fs.readFileSync(m.imagePath).toString('base64');
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
      });
    } catch (_) {
      /* image file missing — send the note alone rather than failing */
    }
    let text = '';
    if (idx === 0) {
      text += `Case description: ${session.caseDescription || '(none provided)'}\n\n`;
    }
    text += m.note ? `Agent note: ${m.note}` : 'Agent note: (none)';
    content.push({ type: 'text', text });
    messages.push({ role: 'user', content });
    if (m.aiReply) messages.push({ role: 'assistant', content: m.aiReply });
  });
  return messages;
}

app.post('/api/diagnose', async (req, res) => {
  const { roomId, caseDescription, note, image, captureId } = req.body || {};
  if (!roomId) return res.status(400).json({ error: 'Missing roomId' });

  const session = getOrCreateSession(roomId);
  // Case description is editable any time and sent with every request.
  db.prepare('UPDATE sessions SET caseDescription = ? WHERE id = ?').run(
    caseDescription || '',
    session.id
  );
  session.caseDescription = caseDescription || '';

  let messageRow;
  if (captureId) {
    // Retry of an existing capture — reuse its saved image, no re-capture.
    messageRow = db
      .prepare('SELECT * FROM messages WHERE id = ? AND sessionId = ?')
      .get(captureId, session.id);
    if (!messageRow) return res.status(404).json({ error: 'Capture not found for retry' });
    if (typeof note === 'string') {
      db.prepare('UPDATE messages SET note = ? WHERE id = ?').run(note, messageRow.id);
      messageRow.note = note;
    }
  } else {
    if (!image) return res.status(400).json({ error: 'Missing image' });
    const base64 = String(image).replace(/^data:image\/\w+;base64,/, '');
    const info = db
      .prepare(
        'INSERT INTO messages (sessionId, role, note, imagePath, aiReply, timestamp) VALUES (?, ?, ?, ?, NULL, ?)'
      )
      .run(session.id, 'capture', note || '', '', Date.now());
    const id = info.lastInsertRowid;
    const filepath = path.join(capturesDir, `capture-${id}.jpg`);
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
    db.prepare('UPDATE messages SET imagePath = ? WHERE id = ?').run(filepath, id);
    messageRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  if (!anthropic) {
    return res.json({
      captureId: messageRow.id,
      error: 'AI is not configured. Set ANTHROPIC_API_KEY on the server.',
    });
  }

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      system: loadSystemPrompt(),
      messages: buildConversation(session),
    });
    const reply =
      (response.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim() || '(no response)';
    db.prepare('UPDATE messages SET aiReply = ? WHERE id = ?').run(reply, messageRow.id);
    res.json({ captureId: messageRow.id, aiReply: reply });
  } catch (err) {
    // Leave aiReply null so the agent can retry the same capture.
    console.error('[diagnose] AI call failed:', err.message);
    res.json({ captureId: messageRow.id, error: `AI request failed: ${err.message}` });
  }
});

// Read-only case history.
app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/api/history', (req, res) => {
  const sessions = db
    .prepare(
      `SELECT s.id, s.roomId, s.caseDescription, s.createdAt,
              COUNT(m.id) AS messageCount
       FROM sessions s
       LEFT JOIN messages m ON m.sessionId = s.id
       GROUP BY s.id
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
      note: m.note,
      aiReply: m.aiReply,
      timestamp: m.timestamp,
      imageUrl: m.imagePath ? '/captures/' + path.basename(m.imagePath) : null,
    }));
  res.json({ session, messages });
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
