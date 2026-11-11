'use strict';

/**
 * Pluggable mailer.
 * - No provider configured: log the link on the server and tell the user a friendly note.
 * - SMTP_URL or SMTP_HOST: send with nodemailer.
 * - SENDGRID_API_KEY: send with the SendGrid HTTP API.
 * Never logs the recipient's password or a raw dump of env secrets.
 */

function linkNote() {
  return 'We could not send email yet. The person who runs Goody can find your link in the server log.';
}

function createMailer(cfg) {
  const from = (cfg && cfg.mailFrom) || process.env.MAIL_FROM || 'Goody <noreply@localhost>';
  const smtpUrl = (cfg && cfg.smtpUrl) || process.env.SMTP_URL || '';
  const smtpHost = (cfg && cfg.smtpHost) || process.env.SMTP_HOST || '';
  const sendgridKey = (cfg && cfg.sendgridKey) || process.env.SENDGRID_API_KEY || '';
  const last = { to: null, subject: null, text: null, link: null, at: null };
  let provider = 'log';
  if (sendgridKey) provider = 'sendgrid';
  else if (smtpUrl || smtpHost) provider = 'smtp';

  function record(msg) {
    last.to = msg.to;
    last.subject = msg.subject;
    last.text = msg.text;
    last.link = msg.link || null;
    last.at = new Date().toISOString();
  }

  async function sendSmtp(msg) {
    const nodemailer = require('nodemailer');
    let transport;
    if (smtpUrl) {
      transport = nodemailer.createTransport(smtpUrl);
    } else {
      transport = nodemailer.createTransport({
        host: smtpHost,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === '1',
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
          : undefined
      });
    }
    await transport.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html || undefined
    });
    return { delivered: true, provider: 'smtp' };
  }

  async function sendSendgrid(msg) {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + sendgridKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: from.replace(/^.*<|>$/g, '') || 'noreply@localhost', name: 'Goody' },
        subject: msg.subject,
        content: [{ type: 'text/plain', value: msg.text }]
      })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('SendGrid did not accept the message (' + res.status + ')');
    }
    return { delivered: true, provider: 'sendgrid' };
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
      if (provider === 'smtp') return await sendSmtp(msg);
      if (provider === 'sendgrid') return await sendSendgrid(msg);
    } catch (e) {
      console.warn('[mail] send failed, logging the link instead:', e.message);
      if (msg.link) console.log('[mail] link:', msg.link);
      return { delivered: false, provider, note: linkNote(), error: e.message };
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
    linkNote
  };
}

module.exports = { createMailer, linkNote };
