// Tunnel File Wizard — SMTP mailer (nodemailer).
//
// Sends invite emails, welcome emails, and password-reset emails through the
// admin's own mail server. All SMTP settings live in the DB (editable in the
// admin panel) and are seeded from SMTP_* env vars on first run only.
//
// Encryption modes:
//   'starttls' — port 587, plain connect then STARTTLS (most common)
//   'ssl'      — port 465, implicit TLS from the start
//   'none'     — port 25, no encryption (LAN relays / testing only)

const nodemailer = require('nodemailer');

function smtpConfigured(smtp) {
  return !!(smtp && smtp.host && smtp.from);
}

function buildTransport(smtp) {
  if (!smtp || !smtp.host) throw new Error('SMTP is not configured yet.');
  const port = parseInt(smtp.port, 10) || 587;
  const encryption = smtp.encryption || 'starttls';
  const opts = {
    host: smtp.host,
    port,
    secure: encryption === 'ssl', // implicit TLS
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass || '' } : undefined,
    // Timeouts so a dead mail server fails fast instead of hanging the request.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  };
  if (encryption === 'starttls') {
    opts.requireTLS = true; // refuse to send credentials over plaintext
  } else if (encryption === 'none') {
    opts.ignoreTLS = true;
    opts.requireTLS = false;
  }
  // LAN escape hatch: the admin's own mail server on a LAN IP/name whose
  // certificate doesn't match what we're connecting to (or is self-signed).
  // Only ever enable this for a server you run yourself on your own network.
  if (smtp.tlsInsecure) {
    opts.tls = { rejectUnauthorized: false };
  }
  return nodemailer.createTransport(opts);
}

async function sendMail(smtp, { to, subject, text, html }) {
  const transporter = buildTransport(smtp);
  const info = await transporter.sendMail({
    from: smtp.from,
    to,
    subject,
    text,
    // The plain-text body may contain user input (e.g. the account's display
    // name), so escape it before turning it into HTML — otherwise a crafted
    // name like "<img src=x onerror=...>" would run in the recipient's
    // mail client.
    html: html || escapeHtml(text).replace(/\n/g, '<br>'),
  });
  try { transporter.close(); } catch { /* ignore */ }
  return info;
}

// Verify the connection/login without sending anything (used by the
// admin panel's "Send test email" — that one DOES send, this one doesn't).
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function verifySmtp(smtp) {
  const transporter = buildTransport(smtp);
  try {
    await transporter.verify();
  } finally {
    try { transporter.close(); } catch { /* ignore */ }
  }
  return true;
}

// ---- email templates -------------------------------------------------------

function inviteEmail({ siteName, siteUrl, inviteLink, invitedBy, expiresText }) {
  const subject = `You're invited to ${siteName}`;
  const text =
`Hi,

${invitedBy} invited you to use ${siteName} — private, peer-to-peer file transfer.

Create your account here:
${inviteLink}
${expiresText ? `\nThis invite ${expiresText}.` : ''}

The link is single-purpose: it just creates your login. Files you send later travel directly between browsers — the server never sees them.`;
  return { subject, text };
}

function welcomeEmail({ siteName, siteUrl, name }) {
  const subject = `Welcome to ${siteName}`;
  const text =
`Hi ${name || 'there'},

Your ${siteName} account is ready. Sign in here:
${siteUrl || '(your server address)'}

A reminder of how it works: when you send a file, it travels directly from your browser to the receiver's browser over an encrypted WebRTC connection. The server only introduces the two browsers — it never sees, stores, or proxies the file itself.`;
  return { subject, text };
}

function resetEmail({ siteName, resetLink }) {
  const subject = `Reset your ${siteName} password`;
  const text =
`Hi,

Someone requested a password reset for your ${siteName} account. If that was you, set a new password here (valid for 1 hour):
${resetLink}

If you didn't ask for this, just ignore this email — your password stays as it is.`;
  return { subject, text };
}

module.exports = { smtpConfigured, buildTransport, sendMail, verifySmtp, inviteEmail, welcomeEmail, resetEmail };
