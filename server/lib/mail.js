'use strict';

/**
 * Pluggable mailer.
 * - No provider configured: log the link on the server and tell the user a friendly note.
 * - BREVO_API_KEY: send with the Brevo HTTP API (preferred on Render; SMTP is often blocked).
 * - SENDGRID_API_KEY: send with the SendGrid HTTP API.
 * - SMTP_URL or SMTP_HOST: send with nodemailer.
 * Never logs the recipient's password or a raw dump of env secrets.
 * HTTP and SMTP calls time out after about 10 seconds so a request cannot hang.
 */

const MAIL_TIMEOUT_MS = 10_000;
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';

function linkNote() {
  return 'We could not send email yet. The person who runs Goody can find your link in the server log.';
}

function parseFromAddress(from) {
  const s = String(from || '').trim();
  const m = s.match(/^(.*)<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].trim().replace(/^["']|["']$/g, '');
    return { name: name || 'Goody', email: m[2].trim() };
  }
  if (/@/.test(s)) return { name: 'Goody', email: s };
  return { name: 'Goody', email: 'noreply@localhost' };
}

function chooseProvider(cfg) {
  const brevoKey = (cfg && cfg.brevoApiKey) || process.env.BREVO_API_KEY || '';
  const sendgridKey = (cfg && cfg.sendgridKey) || process.env.SENDGRID_API_KEY || '';
  const smtpUrl = (cfg && cfg.smtpUrl) || process.env.SMTP_URL || '';
  const smtpHost = (cfg && cfg.smtpHost) || process.env.SMTP_HOST || '';
  if (String(brevoKey).trim()) return 'brevo';
  if (String(sendgridKey).trim()) return 'sendgrid';
  if (String(smtpUrl).trim() || String(smtpHost).trim()) return 'smtp';
  return 'log';
}

function scrubSecret(text, secret) {
  let s = String(text == null ? '' : text);
  if (secret) {
    const key = String(secret);
    if (key) s = s.split(key).join('[redacted]');
  }
  return s;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('Mail send timed out');
      e.code = 'ETIMEDOUT';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createMailer(cfg) {
  cfg = cfg || {};
  const from = cfg.mailFrom || process.env.MAIL_FROM || 'Goody <noreply@localhost>';
  const sender = parseFromAddress(from);
  const smtpUrl = cfg.smtpUrl || process.env.SMTP_URL || '';
  const smtpHost = cfg.smtpHost || process.env.SMTP_HOST || '';
  const sendgridKey = cfg.sendgridKey || process.env.SENDGRID_API_KEY || '';
  const brevoKey = cfg.brevoApiKey || process.env.BREVO_API_KEY || '';
  const timeoutMs = Number(cfg.mailTimeoutMs) > 0 ? Number(cfg.mailTimeoutMs) : MAIL_TIMEOUT_MS;
  const fetchFn = cfg.fetchFn || fetch;
  const last = { to: null, subject: null, text: null, link: null, at: null };
  const provider = chooseProvider(cfg);

  function record(msg) {
    last.to = msg.to;
    last.subject = msg.subject;
    last.text = msg.text;
    last.link = msg.link || null;
    last.at = new Date().toISOString();
  }

  function abortSignal() {
    return (AbortSignal && typeof AbortSignal.timeout === 'function')
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  }

  async function sendSmtp(msg) {
    const nodemailer = require('nodemailer');
    const timeouts = {
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs
    };
    const createTransport = cfg.createTransport || ((opts) => nodemailer.createTransport(opts));
    const transport = smtpUrl
      ? createTransport(Object.assign({ url: smtpUrl }, timeouts))
      : createTransport(Object.assign({
        host: smtpHost,
        port: Number(process.env.SMTP_PORT || (cfg.smtpPort != null ? cfg.smtpPort : 587)),
        secure: process.env.SMTP_SECURE === '1' || cfg.smtpSecure === true,
        auth: (cfg.smtpUser || process.env.SMTP_USER)
          ? { user: cfg.smtpUser || process.env.SMTP_USER, pass: cfg.smtpPass || process.env.SMTP_PASS || '' }
          : undefined
      }, timeouts));
    try {
      await withTimeout(transport.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html || undefined
      }), timeoutMs);
      return { delivered: true, provider: 'smtp' };
    } finally {
      if (transport && typeof transport.close === 'function') {
        try { transport.close(); } catch (e) { /* ignore */ }
      }
    }
  }

  async function sendSendgrid(msg) {
    const res = await fetchFn(SENDGRID_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + sendgridKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: sender.email, name: sender.name },
        subject: msg.subject,
        content: [{ type: 'text/plain', value: msg.text }]
      }),
      signal: abortSignal()
    });
    if (!res.ok) {
      throw new Error('SendGrid did not accept the message (' + res.status + ')');
    }
    return { delivered: true, provider: 'sendgrid' };
  }

  async function sendBrevo(msg) {
    const body = {
      sender: { name: sender.name, email: sender.email },
      to: [{ email: msg.to }],
      subject: msg.subject,
      textContent: msg.text
    };
    if (msg.html) body.htmlContent = msg.html;
    const res = await fetchFn(BREVO_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': brevoKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: abortSignal()
    });
    if (res.status !== 201) {
      throw new Error('Brevo did not accept the message (' + res.status + ')');
    }
    return { delivered: true, provider: 'brevo' };
  }

  async function send(msg) {
    record(msg);
    if (provider === 'log') {
      console.log('[mail] (not sent — no email provider is configured)');
      console.log('[mail] to:', msg.to);
      console.log('[mail] subject:', msg.subject);
      if (msg.link) console.log('[mail] link:', msg.link);
      else console.log('[mail] text:', msg.text);
      return { delivered: false, provider: 'log', note: linkNote() };
    }
    try {
      if (provider === 'brevo') return await sendBrevo(msg);
      if (provider === 'sendgrid') return await sendSendgrid(msg);
      if (provider === 'smtp') return await sendSmtp(msg);
    } catch (e) {
      const raw = (e && e.name === 'TimeoutError') ? 'Mail send timed out' : (e && e.message) || String(e);
      const safe = scrubSecret(raw, brevoKey || sendgridKey);
      console.warn('[mail] send failed, logging the link instead:', safe);
      if (msg.link) console.log('[mail] link:', msg.link);
      return { delivered: false, provider, note: linkNote(), error: safe };
    }
    return { delivered: false, provider: 'log', note: linkNote() };
  }

  function verifyEmailMessage({ to, link }) {
    return {
      to,
      subject: 'Confirm your Goody email',
      link,
      text:
        'Welcome to Goody.\n\n' +
        'Please confirm this email by opening this link:\n' +
        link +
        '\n\nIf you did not make an account, you can ignore this.'
    };
  }

  function resetEmailMessage({ to, link }) {
    return {
      to,
      subject: 'Reset your Goody password',
      link,
      text:
        'Someone asked to reset the Goody password for this email.\n\n' +
        'If it was you, open this link (it expires in one hour):\n' +
        link +
        '\n\nIf it was not you, you can ignore this.'
    };
  }

  return {
    provider,
    enabled: provider !== 'log',
    last,
    send,
    verifyEmailMessage,
    resetEmailMessage,
    linkNote,
    timeoutMs,
    sender
  };
}

function healthMail(mailer) {
  if (!mailer || !mailer.enabled) return false;
  return mailer.provider || true;
}

module.exports = {
  createMailer,
  linkNote,
  parseFromAddress,
  chooseProvider,
  healthMail,
  MAIL_TIMEOUT_MS,
  BREVO_URL
};
