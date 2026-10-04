// Tunnel File Wizard signaling server.
//
// This process NEVER sees file contents. Its job is to relay the WebRTC
// handshake (SDP offers/answers + ICE candidates) between two browsers so
// they can open a direct RTCDataChannel to each other, and to gate room
// access with an optional password. Once the data channel is open, this
// server is no longer involved in the transfer at all.
//
// ACCOUNTS (v2): the server now also hosts an optional accounts system:
//   - First run shows a setup page that creates the admin account.
//   - The admin can flip "Login required": when ON, only signed-in users
//     can create/join transfers (this is the anti-abuse switch — anonymous
//     strangers can no longer use the service for bad things).
//   - When login is required, sign-up is either invite-only (admin creates
//     invite codes, optionally emailed via the admin's own SMTP server) or
//     open public sign-up — the admin picks with one toggle.
//   - The admin's own device can be "trusted", which silently restores the
//     admin session — the device that IS the service never has to log in.
//   - Users get a profile page (name, password) and a "my transfers" area;
//     admins get a panel (users, invites, SMTP, settings, transfer log).
// Data lives in one JSON file (see lib/store.js). No database to run.

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const http = require('http');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');

const store = require('./lib/store');
const mailer = require('./lib/mailer');

// Shown in the page footers so you can tell at a glance whether an
// upgrade actually took effect. Bump in package.json with each release.
const APP_VERSION = require('./package.json').version;

const app = express();
// This app is designed to run behind a reverse proxy (Cloudflare,
// Cloudflare Tunnel, Nginx Proxy Manager, etc). Trusting the first proxy
// hop means req.ip and req.secure reflect the real client / real scheme
// instead of the proxy's, which matters for rate limiting, secure cookies,
// and the links we put in emails.
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' })); // 1mb: logo uploads arrive as base64 data URLs

// --- tiny cookie helpers (no dependency) ------------------------------------
function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = ''; }
  });
  return out;
}

function cookieSecure(req) {
  const mode = String(process.env.COOKIE_SECURE || 'auto').toLowerCase();
  if (mode === '1' || mode === 'true') return true;
  if (mode === '0' || mode === 'false') return false;
  return !!req.secure; // 'auto': secure when the (proxied) scheme is https
}

function addCookie(res, name, value, opts) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  if (opts.expires) parts.push(`Expires=${opts.expires}`);
  const str = parts.join('; ');
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', str);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, str]);
  else res.setHeader('Set-Cookie', [prev, str]);
}

const SESSION_COOKIE = 'tfw_session';
const DEVICE_COOKIE = 'tfw_device';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const DEVICE_TTL_MS = 365 * 24 * 3600 * 1000;

// --- rate limiting (in-memory, per key) -------------------------------------
const rateBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (b.reset < now) rateBuckets.delete(k);
}, 60_000).unref();

function rateOk(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(key, b); }
  b.count += 1;
  return b.count <= max;
}

// --- auth core ---------------------------------------------------------------
function userFromCookies(cookies) {
  const db = store.load();
  const now = Date.now();
  let dirty = false;
  let user = null;

  const sessTok = cookies[SESSION_COOKIE];
  if (sessTok) {
    const h = store.tokenHash(sessTok);
    const s = db.sessions[h];
    if (s && s.expiresAt > now) {
      user = db.users.find((u) => u.id === s.userId && !u.disabled) || null;
      if (user) {
        // Sliding expiry: refresh when over half the TTL has burned.
        if (s.expiresAt - now < SESSION_TTL_MS / 2) { s.expiresAt = now + SESSION_TTL_MS; dirty = true; }
      } else { delete db.sessions[h]; dirty = true; }
    } else if (s) { delete db.sessions[h]; dirty = true; }
  }

  // Trusted device: the admin's device IS the service. A device cookie
  // silently counts as being signed in, so the admin never types a
  // password on their own hardware.
  if (!user) {
    const devTok = cookies[DEVICE_COOKIE];
    if (devTok) {
      const h = store.tokenHash(devTok);
      const d = db.devices[h];
      if (d) {
        user = db.users.find((u) => u.id === d.userId && !u.disabled) || null;
        if (user) {
          if (!d.lastUsedAt || now - d.lastUsedAt > 3600_000) { d.lastUsedAt = now; dirty = true; }
        } else { delete db.devices[h]; dirty = true; }
      }
    }
  }

  if (dirty) store.save();
  return user;
}

function createSession(userId) {
  const db = store.load();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.sessions[store.tokenHash(token)] = { userId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
  // Prune expired sessions while we're here.
  for (const [h, s] of Object.entries(db.sessions)) if (s.expiresAt <= now) delete db.sessions[h];
  store.save();
  return token;
}

function destroySession(req) {
  const cookies = parseCookies(req);
  const tok = cookies[SESSION_COOKIE];
  if (!tok) return;
  const db = store.load();
  delete db.sessions[store.tokenHash(tok)];
  store.save();
}

function setSessionCookie(res, req, token) {
  addCookie(res, SESSION_COOKIE, token, { maxAge: Math.floor(SESSION_TTL_MS / 1000), secure: cookieSecure(req) });
}

function clearSessionCookie(res) {
  addCookie(res, SESSION_COOKIE, '', { maxAge: 0, expires: 'Thu, 01 Jan 1970 00:00:00 GMT' });
}

function createDeviceToken(userId, name) {
  const db = store.load();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.devices[store.tokenHash(token)] = { userId, name: String(name || 'Unknown device').slice(0, 80), createdAt: now, lastUsedAt: now };
  store.save();
  return token;
}

function baseUrl(req) {
  const db = store.load();
  if (db.settings.siteUrl) return String(db.settings.siteUrl).replace(/\/+$/, '');
  const proto = req.secure ? 'https' : 'http';
  return `${proto}://${req.get('host')}`;
}

// --- middleware ---------------------------------------------------------------
app.use((req, res, next) => {
  // Cheap CSRF defense: mutating API calls must be JSON (a cross-site HTML
  // form can't produce application/json without a CORS preflight, which we
  // never approve since we send no CORS headers).
  if (req.path.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ ok: false, error: 'JSON requests only' });
    }
  }
  next();
});

// First-run setup gate: until an admin account exists, the only things that
// work are the setup page, its API, and the health check.
app.use((req, res, next) => {
  const db = store.load();
  if (db.users.length > 0) return next();
  if (req.path === '/api/bootstrap' || req.path === '/api/setup' || req.path === '/healthz') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, error: 'setup_required' });
  if (req.path === '/' || req.path === '/index.html') return res.redirect('/setup.html');
  return next(); // static assets (css/js) the setup page needs
});

// Attach req.user (public shape) for every request after this point.
app.use((req, res, next) => {
  const full = userFromCookies(parseCookies(req));
  req.user = store.publicUser(full);
  req.userFull = full || null;
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Sign in required.' });
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access only.' });
  next();
}

// Does this request carry a valid trusted-device cookie? (The cookie is
// HttpOnly, so the browser JS can't check it itself — the server reports it.)
function requestDeviceTrusted(req, db) {
  const tok = parseCookies(req)[DEVICE_COOKIE];
  if (!tok) return false;
  const d = db.devices[store.tokenHash(tok)];
  if (!d) return false;
  const user = db.users.find((u) => u.id === d.userId);
  return !!(user && !user.disabled);
}

// --- public API ---------------------------------------------------------------
app.get('/api/bootstrap', (req, res) => {
  const db = store.load();
  const branding = db.settings.branding || {};
  res.json({
    ok: true,
    version: APP_VERSION,
    setupDone: db.users.length > 0,
    loginRequired: !!db.settings.loginRequired,
    signupMode: db.settings.signupMode === 'public' ? 'public' : 'invite',
    siteName: db.settings.siteName,
    smtpConfigured: mailer.smtpConfigured(db.settings.smtp),
    branding: {
      showIcon: branding.showIcon !== false,
      showText: branding.showText !== false,
      hasDark: !!brandingFile('dark'),
      hasLight: !!brandingFile('light'),
    },
    user: req.user,
  });
});

// First-run: create the admin account. Only works when no users exist yet.
app.post('/api/setup', (req, res) => {
  if (!rateOk('setup:' + req.ip, 10, 600_000)) return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a bit and try again.' });
  const db = store.load();
  if (db.users.length > 0) return res.status(403).json({ ok: false, error: 'Setup is already complete.' });
  const name = String(req.body.name || '').trim().slice(0, 60);
  const email = store.normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!name) return res.status(400).json({ ok: false, error: 'Please enter your name.' });
  if (!store.validEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  const { salt, passwordHash } = store.hashNewPassword(password);
  const now = Date.now();
  const user = { id: store.newId('user'), name, email, salt, passwordHash, role: 'admin', disabled: false, createdAt: now };
  db.users.push(user);
  store.save();
  const token = createSession(user.id);
  setSessionCookie(res, req, token);
  res.json({ ok: true, user: store.publicUser(user) });
});

function findInvite(db, code) {
  const c = String(code || '').trim().toUpperCase();
  return db.invites.find((i) => i.code === c) || null;
}

function inviteUsable(invite) {
  if (!invite || invite.revoked) return 'This invite is no longer valid.';
  if (invite.expiresAt && invite.expiresAt < Date.now()) return 'This invite has expired.';
  if (invite.uses >= invite.maxUses) return 'This invite has already been used.';
  return null;
}

app.post('/api/signup', async (req, res) => {
  if (!rateOk('signup:' + req.ip, 10, 600_000)) return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a bit and try again.' });
  const db = store.load();
  if (db.users.length === 0) return res.status(403).json({ ok: false, error: 'setup_required' });
  const name = String(req.body.name || '').trim().slice(0, 60);
  const email = store.normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!name) return res.status(400).json({ ok: false, error: 'Please enter your name.' });
  if (!store.validEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  if (db.users.some((u) => u.email === email)) return res.status(400).json({ ok: false, error: 'An account with that email already exists. Try signing in.' });

  // Invite-only mode: a valid invite code is mandatory. Public mode (or login
  // not required at all): anyone may create an account.
  let invite = null;
  const mode = db.settings.signupMode === 'public' ? 'public' : 'invite';
  if (db.settings.loginRequired && mode === 'invite') {
    invite = findInvite(db, req.body.invite);
    const problem = inviteUsable(invite);
    if (problem) return res.status(400).json({ ok: false, error: problem });
    if (invite.email && invite.email !== email) {
      return res.status(400).json({ ok: false, error: 'This invite was issued for a different email address.' });
    }
  }

  const { salt, passwordHash } = store.hashNewPassword(password);
  const now = Date.now();
  const user = { id: store.newId('user'), name, email, salt, passwordHash, role: 'user', disabled: false, createdAt: now };
  db.users.push(user);
  if (invite) { invite.uses += 1; }
  store.save();

  // Welcome email is best-effort: a failed send never blocks the sign-up.
  if (mailer.smtpConfigured(db.settings.smtp)) {
    try {
      const tpl = mailer.welcomeEmail({ siteName: db.settings.siteName, siteUrl: baseUrl(req), name });
      await mailer.sendMail(db.settings.smtp, { to: email, subject: tpl.subject, text: tpl.text });
    } catch (err) { console.error('signup welcome email failed:', err.message); }
  }

  const token = createSession(user.id);
  setSessionCookie(res, req, token);
  res.json({ ok: true, user: store.publicUser(user) });
});

app.post('/api/login', (req, res) => {
  if (!rateOk('login:' + req.ip, 15, 600_000)) return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a bit and try again.' });
  const db = store.load();
  if (db.users.length === 0) return res.status(403).json({ ok: false, error: 'setup_required' });
  const email = store.normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = db.users.find((u) => u.email === email);
  if (!user || user.disabled || !store.verifyPassword(password, user)) {
    return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
  }
  const token = createSession(user.id);
  setSessionCookie(res, req, token);
  // "Trust this device": the admin's device IS the service — with this
  // cookie set, the device silently counts as signed in from now on.
  if (req.body.trustDevice) {
    const devToken = createDeviceToken(user.id, req.body.deviceName || req.get('user-agent') || 'Unknown device');
    addCookie(res, DEVICE_COOKIE, devToken, { maxAge: Math.floor(DEVICE_TTL_MS / 1000), secure: cookieSecure(req) });
  }
  res.json({ ok: true, user: store.publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  destroySession(req);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', requireLogin, (req, res) => {
  const db = store.load();
  res.json({ ok: true, user: req.user, deviceTrusted: requestDeviceTrusted(req, db) });
});

// Update own display name.
app.patch('/api/me', requireLogin, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ ok: false, error: 'Name cannot be empty.' });
  const db = store.load();
  const u = db.users.find((x) => x.id === req.user.id);
  if (!u) return res.status(404).json({ ok: false, error: 'Account not found.' });
  u.name = name;
  store.save();
  res.json({ ok: true, user: store.publicUser(u) });
});

// Change own password.
app.post('/api/me/password', requireLogin, (req, res) => {
  const db = store.load();
  const u = db.users.find((x) => x.id === req.user.id);
  if (!u) return res.status(404).json({ ok: false, error: 'Account not found.' });
  if (!store.verifyPassword(String(req.body.currentPassword || ''), u)) {
    return res.status(400).json({ ok: false, error: 'Your current password is not correct.' });
  }
  const next = String(req.body.newPassword || '');
  if (next.length < 8) return res.status(400).json({ ok: false, error: 'New password must be at least 8 characters.' });
  const { salt, passwordHash } = store.hashNewPassword(next);
  u.salt = salt; u.passwordHash = passwordHash;
  // Invalidate every OTHER session (a password change boots everyone else out).
  const myTok = store.tokenHash(parseCookies(req)[SESSION_COOKIE] || '');
  for (const [h, s] of Object.entries(db.sessions)) {
    if (s.userId === u.id && h !== myTok) delete db.sessions[h];
  }
  store.save();
  res.json({ ok: true });
});

// Trust THIS device from an existing session (no password re-entry needed).
app.post('/api/me/device/trust', requireLogin, (req, res) => {
  const token = createDeviceToken(req.user.id, String(req.body.name || req.get('user-agent') || 'Unknown device'));
  addCookie(res, DEVICE_COOKIE, token, { maxAge: Math.floor(DEVICE_TTL_MS / 1000), secure: cookieSecure(req) });
  res.json({ ok: true });
});

// Forget THIS trusted device (clears the device cookie + server record).
app.post('/api/me/device/forget', requireLogin, (req, res) => {
  const cookies = parseCookies(req);
  const tok = cookies[DEVICE_COOKIE];
  if (tok) {
    const db = store.load();
    delete db.devices[store.tokenHash(tok)];
    store.save();
  }
  addCookie(res, DEVICE_COOKIE, '', { maxAge: 0, expires: 'Thu, 01 Jan 1970 00:00:00 GMT' });
  res.json({ ok: true });
});

// Request a password-reset email. Always returns ok (no account enumeration).
app.post('/api/password/forgot', async (req, res) => {
  if (!rateOk('forgot:' + req.ip, 5, 600_000)) return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a bit and try again.' });
  const db = store.load();
  const email = store.normalizeEmail(req.body.email);
  const user = db.users.find((u) => u.email === email && !u.disabled);
  if (user && mailer.smtpConfigured(db.settings.smtp)) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.resets[store.tokenHash(token)] = { userId: user.id, createdAt: now, expiresAt: now + 3600_000 };
    for (const [h, r] of Object.entries(db.resets)) if (r.expiresAt <= now) delete db.resets[h];
    store.save();
    try {
      const tpl = mailer.resetEmail({ siteName: db.settings.siteName, resetLink: `${baseUrl(req)}/login.html?reset=${token}` });
      await mailer.sendMail(db.settings.smtp, { to: email, subject: tpl.subject, text: tpl.text });
    } catch (err) { console.error('password reset email failed:', err.message); }
  }
  res.json({ ok: true });
});

app.post('/api/password/reset', (req, res) => {
  if (!rateOk('reset:' + req.ip, 10, 600_000)) return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a bit and try again.' });
  const db = store.load();
  const h = store.tokenHash(String(req.body.token || ''));
  const r = db.resets[h];
  if (!r || r.expiresAt < Date.now()) return res.status(400).json({ ok: false, error: 'That reset link is invalid or has expired.' });
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  const user = db.users.find((u) => u.id === r.userId && !u.disabled);
  if (!user) return res.status(400).json({ ok: false, error: 'That reset link is invalid or has expired.' });
  const { salt, passwordHash } = store.hashNewPassword(password);
  user.salt = salt; user.passwordHash = passwordHash;
  delete db.resets[h];
  for (const [sh, s] of Object.entries(db.sessions)) if (s.userId === user.id) delete db.sessions[sh];
  store.save();
  res.json({ ok: true });
});

// My transfer history (metadata only — the server never sees file contents).
app.get('/api/my/transfers', requireLogin, (req, res) => {
  const db = store.load();
  const rows = db.transfers.filter((t) => t.userId === req.user.id).slice(-200).reverse();
  res.json({ ok: true, transfers: rows });
});

// --- admin API ----------------------------------------------------------------
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newInviteCode() {
  let s = '';
  for (let i = 0; i < 12; i++) s += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return s;
}

function adminCount(db) {
  return db.users.filter((u) => u.role === 'admin' && !u.disabled).length;
}

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const db = store.load();
  res.json({
    ok: true,
    users: db.users.map((u) => Object.assign(store.publicUser(u), { disabled: !!u.disabled })),
  });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const email = store.normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  if (!store.validEmail(email)) return res.status(400).json({ ok: false, error: 'Valid email is required.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  const db = store.load();
  if (db.users.some((u) => u.email === email)) return res.status(400).json({ ok: false, error: 'That email is already registered.' });
  const { salt, passwordHash } = store.hashNewPassword(password);
  const user = { id: store.newId('user'), name, email, salt, passwordHash, role, disabled: false, createdAt: Date.now() };
  db.users.push(user);
  store.save();
  res.json({ ok: true, user: Object.assign(store.publicUser(user), { disabled: false }) });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const db = store.load();
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ ok: false, error: 'User not found.' });
  const isSelf = u.id === req.user.id;

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 60);
    if (!name) return res.status(400).json({ ok: false, error: 'Name cannot be empty.' });
    u.name = name;
  }
  if (req.body.role !== undefined) {
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    if (isSelf && role !== 'admin') return res.status(400).json({ ok: false, error: 'You cannot remove your own admin role.' });
    if (u.role === 'admin' && role !== 'admin' && adminCount(db) <= 1) {
      return res.status(400).json({ ok: false, error: 'You cannot demote the last admin.' });
    }
    u.role = role;
  }
  if (req.body.disabled !== undefined) {
    const disabled = !!req.body.disabled;
    if (isSelf && disabled) return res.status(400).json({ ok: false, error: 'You cannot disable your own account.' });
    if (disabled && u.role === 'admin' && adminCount(db) <= 1) {
      return res.status(400).json({ ok: false, error: 'You cannot disable the last admin.' });
    }
    u.disabled = disabled;
    if (disabled) {
      for (const [h, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[h];
    }
  }
  if (req.body.password) {
    const pw = String(req.body.password);
    if (pw.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
    const { salt, passwordHash } = store.hashNewPassword(pw);
    u.salt = salt; u.passwordHash = passwordHash;
    for (const [h, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[h];
  }
  store.save();
  res.json({ ok: true, user: Object.assign(store.publicUser(u), { disabled: !!u.disabled }) });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const db = store.load();
  const idx = db.users.findIndex((x) => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'User not found.' });
  const u = db.users[idx];
  if (u.id === req.user.id) return res.status(400).json({ ok: false, error: 'You cannot delete your own account.' });
  if (u.role === 'admin' && adminCount(db) <= 1) return res.status(400).json({ ok: false, error: 'You cannot delete the last admin.' });
  db.users.splice(idx, 1);
  for (const [h, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[h];
  for (const [h, d] of Object.entries(db.devices)) if (d.userId === u.id) delete db.devices[h];
  store.save();
  res.json({ ok: true });
});

// Invites
app.get('/api/admin/invites', requireAdmin, (req, res) => {
  const db = store.load();
  res.json({
    ok: true,
    invites: db.invites.slice().reverse().map((i) => ({
      code: i.code, email: i.email, note: i.note, createdBy: i.createdBy,
      createdAt: i.createdAt, expiresAt: i.expiresAt, maxUses: i.maxUses,
      uses: i.uses, revoked: !!i.revoked,
      link: `${baseUrl(req)}/signup.html?invite=${i.code}`,
    })),
  });
});

app.post('/api/admin/invites', requireAdmin, (req, res) => {
  const db = store.load();
  const email = store.normalizeEmail(req.body.email);
  if (email && !store.validEmail(email)) return res.status(400).json({ ok: false, error: 'That email address is not valid.' });
  const maxUses = Math.min(1000, Math.max(1, parseInt(req.body.maxUses, 10) || 1));
  const days = Math.max(0, parseInt(req.body.expiresInDays, 10) || 0);
  const now = Date.now();
  let code = newInviteCode();
  while (db.invites.some((i) => i.code === code)) code = newInviteCode();
  const invite = {
    code, email: email || '', note: String(req.body.note || '').slice(0, 120),
    createdBy: req.user.email, createdAt: now,
    expiresAt: days > 0 ? now + days * 24 * 3600_000 : 0,
    maxUses, uses: 0, revoked: false,
  };
  db.invites.push(invite);
  store.save();
  res.json({ ok: true, code, link: `${baseUrl(req)}/signup.html?invite=${code}` });
});

app.post('/api/admin/invites/:code/revoke', requireAdmin, (req, res) => {
  const db = store.load();
  const invite = findInvite(db, req.params.code);
  if (!invite) return res.status(404).json({ ok: false, error: 'Invite not found.' });
  invite.revoked = true;
  store.save();
  res.json({ ok: true });
});

// Permanently delete all revoked invite codes (admin cleanup).
app.post('/api/admin/invites/clear-revoked', requireAdmin, (req, res) => {
  const db = store.load();
  const before = db.invites.length;
  db.invites = db.invites.filter((i) => !i.revoked);
  const cleared = before - db.invites.length;
  if (cleared) store.save();
  res.json({ ok: true, cleared });
});

app.post('/api/admin/invites/:code/send', requireAdmin, async (req, res) => {
  const db = store.load();
  const invite = findInvite(db, req.params.code);
  if (!invite) return res.status(404).json({ ok: false, error: 'Invite not found.' });
  const problem = inviteUsable(invite);
  if (problem) return res.status(400).json({ ok: false, error: problem });
  const email = store.normalizeEmail(req.body.email || invite.email);
  if (!store.validEmail(email)) return res.status(400).json({ ok: false, error: 'A valid recipient email is required.' });
  if (!mailer.smtpConfigured(db.settings.smtp)) {
    return res.status(400).json({ ok: false, error: 'SMTP is not configured yet. Set it up below first.' });
  }
  const link = `${baseUrl(req)}/signup.html?invite=${invite.code}`;
  const expiresText = invite.expiresAt
    ? 'expires on ' + new Date(invite.expiresAt).toLocaleDateString()
    : '';
  try {
    const tpl = mailer.inviteEmail({
      siteName: db.settings.siteName, siteUrl: baseUrl(req),
      inviteLink: link, invitedBy: req.user.name || req.user.email, expiresText,
    });
    await mailer.sendMail(db.settings.smtp, { to: email, subject: tpl.subject, text: tpl.text });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Could not send the email: ' + err.message });
  }
  if (!invite.email) { invite.email = email; store.save(); }
  res.json({ ok: true });
});

// Trusted devices
app.get('/api/admin/devices', requireAdmin, (req, res) => {
  const db = store.load();
  const byId = Object.fromEntries(db.users.map((u) => [u.id, u.email]));
  const myHash = store.tokenHash(parseCookies(req)[DEVICE_COOKIE] || '');
  res.json({
    ok: true,
    devices: Object.entries(db.devices).map(([h, d]) => ({
      id: h.slice(0, 16), email: byId[d.userId] || '(deleted user)',
      name: d.name, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt,
      current: h === myHash,
    })).sort((a, b) => b.lastUsedAt - a.lastUsedAt),
  });
});

app.delete('/api/admin/devices/:id', requireAdmin, (req, res) => {
  const db = store.load();
  const key = Object.keys(db.devices).find((h) => h.startsWith(req.params.id));
  if (!key) return res.status(404).json({ ok: false, error: 'Device not found.' });
  delete db.devices[key];
  store.save();
  res.json({ ok: true });
});

// Revoke ALL trusted devices (admin cleanup). Every device signs in again.
app.post('/api/admin/devices/clear', requireAdmin, (req, res) => {
  const db = store.load();
  const cleared = Object.keys(db.devices).length;
  db.devices = {};
  if (cleared) store.save();
  res.json({ ok: true, cleared });
});

// Settings (login-required toggle, signup mode, SMTP, site info)
function publicSettings(db) {
  const s = db.settings;
  const smtp = Object.assign({}, s.smtp);
  const hasPass = !!(smtp.pass && smtp.pass !== '__KEEP__');
  smtp.pass = hasPass ? '__KEEP__' : '';
  const branding = s.branding || {};
  return {
    loginRequired: !!s.loginRequired,
    signupMode: s.signupMode === 'public' ? 'public' : 'invite',
    siteName: s.siteName, siteUrl: s.siteUrl,
    branding: { showIcon: branding.showIcon !== false, showText: branding.showText !== false },
    smtp, smtpHasPass: hasPass,
    smtpConfigured: mailer.smtpConfigured(s.smtp),
  };
}

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ ok: true, settings: publicSettings(store.load()) });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const db = store.load();
  const b = req.body || {};
  if (b.loginRequired !== undefined) db.settings.loginRequired = !!b.loginRequired;
  if (b.signupMode === 'public' || b.signupMode === 'invite') db.settings.signupMode = b.signupMode;
  if (b.siteName !== undefined) db.settings.siteName = String(b.siteName).slice(0, 80) || 'Tunnel File Wizard';
  if (b.siteUrl !== undefined) db.settings.siteUrl = String(b.siteUrl).replace(/\/+$/, '').slice(0, 200);
  if (b.branding && typeof b.branding === 'object') {
    const cur = db.settings.branding || {};
    if (b.branding.showIcon !== undefined) cur.showIcon = !!b.branding.showIcon;
    if (b.branding.showText !== undefined) cur.showText = !!b.branding.showText;
    db.settings.branding = cur;
  }
  if (b.smtp && typeof b.smtp === 'object') {
    const s = db.settings.smtp;
    const inb = b.smtp;
    if (inb.host !== undefined) s.host = String(inb.host).slice(0, 200);
    if (inb.port !== undefined) s.port = Math.max(1, Math.min(65535, parseInt(inb.port, 10) || 587));
    if (['starttls', 'ssl', 'none'].includes(inb.encryption)) s.encryption = inb.encryption;
    if (inb.user !== undefined) s.user = String(inb.user).slice(0, 200);
    if (inb.pass !== undefined && inb.pass !== '__KEEP__') s.pass = String(inb.pass).slice(0, 500);
    if (inb.from !== undefined) s.from = String(inb.from).slice(0, 200);
    if (inb.tlsInsecure !== undefined) s.tlsInsecure = !!inb.tlsInsecure;
  }
  store.save();
  res.json({ ok: true, settings: publicSettings(db) });
});

app.post('/api/admin/smtp/test', requireAdmin, async (req, res) => {
  const db = store.load();
  const to = store.normalizeEmail(req.body.to);
  if (!store.validEmail(to)) return res.status(400).json({ ok: false, error: 'Enter a valid address to send the test to.' });
  if (!mailer.smtpConfigured(db.settings.smtp)) {
    return res.status(400).json({ ok: false, error: 'SMTP is not configured yet.' });
  }
  try {
    await mailer.verifySmtp(db.settings.smtp);
    await mailer.sendMail(db.settings.smtp, {
      to,
      subject: `Test email from ${db.settings.siteName}`,
      text: `This is a test email from ${db.settings.siteName}.\n\nIf you received this, your mail server settings are working — invite and password-reset emails will go out through it.`,
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'SMTP failed: ' + err.message });
  }
  res.json({ ok: true });
});

// Transfer log (metadata only)
app.get('/api/admin/transfers', requireAdmin, (req, res) => {
  const db = store.load();
  res.json({ ok: true, transfers: db.transfers.slice(-300).reverse() });
});

// Clear the transfer log (admin cleanup). This also clears the "my transfers"
// history shown to users, since both read the same log.
app.post('/api/admin/transfers/clear', requireAdmin, (req, res) => {
  const db = store.load();
  const cleared = db.transfers.length;
  db.transfers = [];
  if (cleared) store.save();
  res.json({ ok: true, cleared });
});

function logTransfer({ userId, email, roomId, protected: isProtected }) {
  const db = store.load();
  db.transfers.push({ at: Date.now(), userId: userId || null, email: email || 'anonymous', roomId, protected: !!isProtected });
  if (db.transfers.length > 2000) db.transfers = db.transfers.slice(-2000);
  store.save();
}

// --- branding: admin-uploaded logos (one per light/dark mode) -----------------
const BRANDING_DIR = path.join(store.DATA_DIR, 'branding');
const LOGO_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
};

function brandingFile(which) {
  if (which !== 'dark' && which !== 'light') return null;
  try {
    for (const ext of Object.keys(LOGO_MIME)) {
      const p = path.join(BRANDING_DIR, `logo-${which}.${ext}`);
      if (fs.existsSync(p)) return { path: p, mime: LOGO_MIME[ext] };
    }
  } catch { /* ignore */ }
  return null;
}

// Public: the header logo. 404 when the admin hasn't uploaded one (the UI
// then falls back to the default brand mark).
app.get('/branding/logo-:which', (req, res) => {
  const found = brandingFile(req.params.which);
  if (!found) {
    // Never cache the "no logo" answer: otherwise a browser that saw the
    // 404 before the admin uploaded a logo would keep hiding it afterwards.
    res.set('Cache-Control', 'no-store');
    return res.status(404).send('no logo');
  }
  res.set('Content-Type', found.mime);
  res.set('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(found.path).pipe(res);
});

// Upload a logo. The image arrives as a data URL in JSON (no extra upload
// dependency); max 500 KB, PNG/JPG/WebP/GIF/SVG.
app.post('/api/admin/branding', requireAdmin, (req, res) => {
  const which = req.body.which === 'light' ? 'light' : 'dark';
  const dataUrl = String(req.body.dataUrl || '');
  const m = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ ok: false, error: 'That file is not a supported image (PNG, JPG, WebP, GIF, SVG).' });
  const ext = m[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 500 * 1024) return res.status(400).json({ ok: false, error: 'Logo must be under 500 KB.' });
  try {
    fs.mkdirSync(BRANDING_DIR, { recursive: true });
    for (const e of Object.keys(LOGO_MIME)) {
      try { fs.unlinkSync(path.join(BRANDING_DIR, `logo-${which}.${e}`)); } catch { /* ignore */ }
    }
    fs.writeFileSync(path.join(BRANDING_DIR, `logo-${which}.${ext}`), buf);
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not save the logo.' });
  }
  res.json({ ok: true });
});

app.delete('/api/admin/branding/:which', requireAdmin, (req, res) => {
  const which = req.params.which === 'light' ? 'light' : 'dark';
  for (const e of Object.keys(LOGO_MIME)) {
    try { fs.unlinkSync(path.join(BRANDING_DIR, `logo-${which}.${e}`)); } catch { /* ignore */ }
  }
  res.json({ ok: true });
});

// --- original signaling routes (unchanged behavior) ---------------------------
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

const CUSTOM_CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64);
}

function passwordMatches(room, suppliedPassword) {
  if (!room.passwordHash) return true; // room has no password set
  if (!suppliedPassword) return false;
  const candidate = hashPassword(suppliedPassword, room.salt);
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

const LOGIN_REQUIRED_WS_ERROR = {
  type: 'error',
  code: 'LOGIN_REQUIRED',
  message: 'This server requires sign-in to send or receive files. Please sign in and try again.',
};

wss.on('connection', (ws, req) => {
  ws.roomId = null;
  ws.isAlive = true;
  // The browser sends its cookies on the WebSocket handshake (same origin),
  // so we know WHO is behind each socket — used for the login-required gate
  // and the transfer log. Anonymous sockets stay anonymous when the admin
  // allows it.
  let wsUser = null;
  try { wsUser = userFromCookies(parseCookies(req || { headers: {} })); } catch { wsUser = null; }
  ws.on('pong', () => { ws.isAlive = true; });

  // The admin's anti-abuse switch: when "Login required" is ON, anonymous
  // sockets can't create or join rooms at all.
  function gated() {
    if (store.load().settings.loginRequired && !wsUser) {
      ws.send(JSON.stringify(LOGIN_REQUIRED_WS_ERROR));
      return true;
    }
    return false;
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed input
    }

    switch (msg.type) {
      case 'create': {
        if (gated()) return;
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

        // Theme is an allowlist, not a free string: the receiver's page looks the
        // theme name up in a fixed object, and a crafted value like
        // "__proto__" would crash their page. Fail closed to the default.
        const THEME_KEYS = ['amber', 'midnight', 'forest', 'rosewood', 'mono'];
        const theme = THEME_KEYS.includes(msg.theme) ? msg.theme : 'amber';
        const senderName = typeof msg.senderName === 'string' ? msg.senderName.trim().slice(0, 60) : '';
        const senderMessage = typeof msg.message === 'string' ? msg.message.trim().slice(0, 300) : '';

        rooms.set(roomId, { peers: new Set([ws]), salt, passwordHash, theme, senderName, senderMessage });
        ws.roomId = roomId;
        // Audit trail (metadata only): who created which room, and when.
        logTransfer({ userId: wsUser ? wsUser.id : null, email: wsUser ? wsUser.email : 'anonymous', roomId, protected: !!passwordHash });
        ws.send(JSON.stringify({ type: 'created', roomId, protected: !!passwordHash }));
        break;
      }

      case 'join': {
        if (gated()) return;
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

const HEARTBEAT_INTERVAL_MS = 25_000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
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
