// Tunnel File Wizard — tiny JSON data store.
//
// Everything the accounts system needs (users, invites, settings, sessions,
// trusted devices, transfer log, password-reset tokens) lives in ONE JSON
// file under DATA_DIR, written atomically (tmp file + rename) so a crash
// mid-write never corrupts it. No database server to install or maintain —
// this matches the project's "simple self-hosted tool" spirit, and the
// data volume is tiny (a few KB per hundred users).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'tunnel-file-wizard.json');

function defaultDb() {
  return {
    version: 1,
    users: [],        // {id, name, email, salt, passwordHash, role, disabled, createdAt}
    invites: [],      // {code, email, note, createdBy, createdAt, expiresAt, maxUses, uses, revoked}
    sessions: {},     // tokenHash -> {userId, createdAt, expiresAt}
    devices: {},      // tokenHash -> {userId, name, createdAt, lastUsedAt}
    resets: {},       // tokenHash -> {userId, createdAt, expiresAt}
    transfers: [],    // {at, userId, email, roomId, protected} — metadata only, never file contents
    settings: {
      loginRequired: false,   // when true, Send/Receive need a signed-in user
      signupMode: 'invite',   // 'invite' | 'public' — only matters when loginRequired is true
      siteName: 'Tunnel File Wizard',
      siteUrl: '',            // e.g. https://files.example.com — used for links in emails
      branding: { showIcon: true, showText: true }, // header: default icon + site name text (logo uploads are separate)
      smtp: { host: '', port: 587, encryption: 'starttls', user: '', pass: '', from: '', tlsInsecure: false },
    },
  };
}

// Seed from environment on FIRST RUN ONLY (when a key is still at its
// default). After that the DB is the source of truth and the admin panel
// owns these values — env vars never silently override an admin's choice.
function seedFromEnv(db) {
  const s = db.settings;
  const firstRun = db.users.length === 0 && !db._envSeeded;
  if (!firstRun) return;
  if (process.env.LOGIN_REQUIRED === '1' || process.env.LOGIN_REQUIRED === 'true') s.loginRequired = true;
  if (process.env.SIGNUP_MODE === 'public' || process.env.SIGNUP_MODE === 'invite') s.signupMode = process.env.SIGNUP_MODE;
  if (process.env.SITE_NAME) s.siteName = String(process.env.SITE_NAME).slice(0, 80);
  if (process.env.SITE_URL) s.siteUrl = String(process.env.SITE_URL).replace(/\/+$/, '').slice(0, 200);
  const smtp = s.smtp;
  if (process.env.SMTP_HOST) smtp.host = process.env.SMTP_HOST;
  if (process.env.SMTP_PORT) smtp.port = parseInt(process.env.SMTP_PORT, 10) || 587;
  if (['starttls', 'ssl', 'none'].includes(process.env.SMTP_ENCRYPTION)) smtp.encryption = process.env.SMTP_ENCRYPTION;
  if (process.env.SMTP_USER) smtp.user = process.env.SMTP_USER;
  if (process.env.SMTP_PASS) smtp.pass = process.env.SMTP_PASS;
  if (process.env.SMTP_FROM) smtp.from = process.env.SMTP_FROM;
  if (process.env.SMTP_TLS_INSECURE === '1' || process.env.SMTP_TLS_INSECURE === 'true') smtp.tlsInsecure = true;
  db._envSeeded = true;
}

let db = null;

function load() {
  if (db) return db;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* ignore */ }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = Object.assign(defaultDb(), JSON.parse(raw));
    db.settings = Object.assign(defaultDb().settings, db.settings || {});
    db.settings.smtp = Object.assign(defaultDb().settings.smtp, (db.settings || {}).smtp || {});
  } catch {
    db = defaultDb();
  }
  seedFromEnv(db);
  save(); // persist any seeding/defaults immediately
  return db;
}

function save() {
  if (!db) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('store: failed to save DB:', err.message);
  }
}

// ---- helpers ---------------------------------------------------------------

function newId(prefix) {
  return (prefix || 'id') + '_' + crypto.randomBytes(8).toString('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function hashNewPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, passwordHash: scryptHash(password, salt) };
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.passwordHash) return false;
  const candidate = scryptHash(password, user.salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  // Length cap (RFC 5321: 254 max) as well as shape — keeps pathological
  // inputs away from the mail library's address parser.
  const e = email || '';
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}

module.exports = {
  load,
  save,
  newId,
  tokenHash,
  hashNewPassword,
  verifyPassword,
  normalizeEmail,
  validEmail,
  publicUser,
  DB_FILE,
  DATA_DIR,
};
