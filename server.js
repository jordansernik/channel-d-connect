'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

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
