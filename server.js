// Tunnel File Wizard signaling server.
//
// This process NEVER sees file contents. Its job is to relay the WebRTC
// handshake (SDP offers/answers + ICE candidates) between two browsers so
// they can open a direct RTCDataChannel to each other, and to gate room
// access with an optional password. Once the data channel is open, this
// server is no longer involved in the transfer at all.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
// This app is designed to run behind a reverse proxy (Cloudflare,
// Cloudflare Tunnel, Nginx Proxy Manager, etc). Trusting the first proxy
// hop means req.ip and req.secure reflect the real client / real scheme
// instead of the proxy's, which matters if you add IP-based rate
// limiting or logging later.
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

// Tells the client which ICE servers to use. STUN is free/public and
// handles most NAT traversal. TURN is optional — only configure it if
// you're willing to accept that TURN relays traffic through a server
// you control (a deliberate exception to "never touches a server",
// used only when direct P2P negotiation fails).
app.get('/ice-config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }

  res.json({ iceServers });
});

// Renders a QR code (PNG) for whatever text/URL is passed in — used to
// let a receiver scan the room's share link instead of typing a code.
// Generated entirely server-side so nothing is sent to a third party.
app.get('/api/qr', async (req, res) => {
  const text = req.query.text;
  if (!text || typeof text !== 'string' || text.length > 2000) {
    return res.status(400).send('Missing or invalid "text" query param.');
  }
  try {
    const buffer = await QRCode.toBuffer(text, {
      type: 'png',
      margin: 1,
      width: 220,
      color: { dark: '#12151a', light: '#00000000' },
    });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Failed to generate QR code.');
  }
});

app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// roomId -> { peers: Set<ws>, salt: Buffer|null, passwordHash: Buffer|null,
//             theme: string, senderName: string, senderMessage: string }
const rooms = new Map();

function generateRoomCode() {
  // 6-digit human-typeable code, easy to read aloud or type on a phone
  return crypto.randomInt(100000, 999999).toString();
}

// A custom link name (in place of the random 6-digit code): 3-32 chars,
// lowercase letters/numbers/hyphens, no leading/trailing hyphen. Kept
// deliberately simple/URL-safe since it ends up as both the WebSocket
// room key and part of the share link.
const CUSTOM_CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64);
}

function passwordMatches(room, suppliedPassword) {
  if (!room.passwordHash) return true; // room has no password set
  if (!suppliedPassword) return false;
  const candidate = hashPassword(suppliedPassword, room.salt);
  // lengths always match (scrypt output is fixed-size), but guard anyway
  if (candidate.length !== room.passwordHash.length) return false;
  return crypto.timingSafeEqual(candidate, room.passwordHash);
}

function broadcastToRoom(roomId, senderWs, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const peer of room.peers) {
    if (peer !== senderWs && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify(payload));
    }
  }
}

function cleanupRoom(roomId, ws) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.peers.delete(ws);
  broadcastToRoom(roomId, ws, { type: 'peer-left' });
  if (room.peers.size === 0) rooms.delete(roomId);
}

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed input
    }

    switch (msg.type) {
      case 'create': {
        const requestedCustom = typeof msg.customCode === 'string' ? msg.customCode.trim().toLowerCase() : '';

        let roomId;
        if (requestedCustom) {
          if (!CUSTOM_CODE_RE.test(requestedCustom)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Custom link names must be 3-32 characters: lowercase letters, numbers, and hyphens (no leading/trailing hyphen).',
              code: 'BAD_CUSTOM_CODE',
            }));
            return;
          }
          if (rooms.has(requestedCustom)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'That link name is already taken. Try another.',
              code: 'NAME_TAKEN',
            }));
            return;
          }
          roomId = requestedCustom;
        } else {
          do {
            roomId = generateRoomCode();
          } while (rooms.has(roomId));
        }

        const password = typeof msg.password === 'string' ? msg.password.trim() : '';
        let salt = null;
        let passwordHash = null;
        if (password) {
          salt = crypto.randomBytes(16);
          passwordHash = hashPassword(password, salt);
        }

        // The sender's chosen theme is just a short label (e.g. "midnight")
        // — cosmetic metadata, not file content — so it's fine to pass
        // through the signaling server same as the room code.
        const theme = typeof msg.theme === 'string' ? msg.theme.slice(0, 32) : 'amber';

        // Sender's display name and an optional message are likewise just
        // cosmetic metadata shown to the receiver before/while the file
        // transfers — never file content, and length-capped generously.
        const senderName = typeof msg.senderName === 'string' ? msg.senderName.trim().slice(0, 60) : '';
        const senderMessage = typeof msg.message === 'string' ? msg.message.trim().slice(0, 300) : '';

        rooms.set(roomId, { peers: new Set([ws]), salt, passwordHash, theme, senderName, senderMessage });
        ws.roomId = roomId;
        ws.send(JSON.stringify({ type: 'created', roomId, protected: !!passwordHash }));
        break;
      }

      case 'join': {
        const roomId = String(msg.roomId || '').trim().toLowerCase();
        const room = rooms.get(roomId);
        if (!room || room.peers.size >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'That code is invalid, expired, or already in use.' }));
          return;
        }
        if (!passwordMatches(room, msg.password)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Incorrect password.', code: 'BAD_PASSWORD' }));
          return;
        }
        room.peers.add(ws);
        ws.roomId = roomId;
        broadcastToRoom(roomId, ws, { type: 'peer-joined' });
        ws.send(JSON.stringify({
          type: 'joined',
          roomId,
          theme: room.theme || 'amber',
          senderName: room.senderName || '',
          message: room.senderMessage || '',
        }));
        break;
      }

      // Opaque relay: server does not inspect the SDP/ICE payload,
      // it just forwards it to the other peer in the room.
      case 'signal': {
        if (!ws.roomId) return;
        broadcastToRoom(ws.roomId, ws, { type: 'signal', data: msg.data });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (ws.roomId) cleanupRoom(ws.roomId, ws);
  });
});

// Heartbeat: ping every connected client periodically. Two reasons this
// matters when this server sits behind Cloudflare, Nginx Proxy Manager,
// or any other reverse proxy:
//  1. Most proxies (and Cloudflare itself) close a WebSocket connection
//     after some idle period (commonly 60-100s). A sender who created a
//     room and is waiting for a receiver to join could otherwise get
//     silently disconnected before anything even happens. Pinging every
//     25s keeps the connection active well under any of those timeouts.
//  2. It also detects genuinely dead connections (e.g. a laptop that
//     lost network without a clean TCP close) faster than the OS-level
//     timeout would, so room cleanup and "peer disconnected" happen
//     promptly instead of leaving a stale half-open room.
const HEARTBEAT_INTERVAL_MS = 25_000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate(); // triggers 'close' -> cleanupRoom
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tunnel File Wizard signaling server listening on port ${PORT}`);
});
