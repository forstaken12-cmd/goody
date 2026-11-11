'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createMailer,
  parseFromAddress,
  chooseProvider,
  healthMail,
  MAIL_TIMEOUT_MS,
  BREVO_URL
} = require('../server/lib/mail');
const { createApp } = require('../server/app');

function listen(a) {
  return new Promise((resolve) => {
    const s = a.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('parseFromAddress reads Name <email> and a bare address', () => {
  assert.deepEqual(parseFromAddress('Goody <forstaken12@gmail.com>'), {
    name: 'Goody',
    email: 'forstaken12@gmail.com'
  });
  assert.deepEqual(parseFromAddress('"Goody Rewards" <noreply@example.com>'), {
    name: 'Goody Rewards',
    email: 'noreply@example.com'
  });
  assert.deepEqual(parseFromAddress('solo@example.com'), {
    name: 'Goody',
    email: 'solo@example.com'
  });
});

test('BREVO_API_KEY is chosen over SMTP, and no key stays on the log provider', () => {
  assert.equal(chooseProvider({ brevoApiKey: 'b', smtpUrl: 'smtp://user:pass@smtp.example.com:587' }), 'brevo');
  assert.equal(chooseProvider({ sendgridKey: 's', smtpHost: 'smtp.example.com' }), 'sendgrid');
  assert.equal(chooseProvider({ smtpUrl: 'smtp://user:pass@smtp.example.com:587' }), 'smtp');
  assert.equal(chooseProvider({}), 'log');
  const log = createMailer({});
  assert.equal(log.provider, 'log');
  assert.equal(log.enabled, false);
  const brevo = createMailer({ brevoApiKey: 'test-brevo-key', smtpUrl: 'smtp://user:pass@localhost:587' });
  assert.equal(brevo.provider, 'brevo');
  assert.equal(brevo.enabled, true);
});

test('Brevo 201 is success and posts the official HTTP body', async () => {
  const calls = [];
  const mailer = createMailer({
    mailFrom: 'Goody <forstaken12@gmail.com>',
    brevoApiKey: 'test-brevo-key',
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return { status: 201, ok: true, text: async () => '' };
    }
  });
  const r = await mailer.send({
    to: 'player@example.com',
    subject: 'Confirm your Goody email',
    text: 'Please confirm',
    html: '<p>Please confirm</p>',
    link: 'http://127.0.0.1/verify?token=abc'
  });
  assert.equal(r.delivered, true);
  assert.equal(r.provider, 'brevo');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BREVO_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['api-key'], 'test-brevo-key');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.ok(calls[0].init.signal, 'HTTP send must use an abort signal');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.sender, { name: 'Goody', email: 'forstaken12@gmail.com' });
  assert.deepEqual(body.to, [{ email: 'player@example.com' }]);
  assert.equal(body.subject, 'Confirm your Goody email');
  assert.equal(body.textContent, 'Please confirm');
  assert.equal(body.htmlContent, '<p>Please confirm</p>');
});

test('Brevo error includes the status and never the API key', async () => {
  const mailer = createMailer({
    mailFrom: 'Goody <noreply@example.com>',
    brevoApiKey: 'super-secret-brevo-key',
    fetchFn: async () => ({
      status: 401,
      ok: false,
      text: async () => 'invalid api-key super-secret-brevo-key'
    })
  });
  const r = await mailer.send({
    to: 'player@example.com',
    subject: 'Hello',
    text: 'Hi',
    link: 'http://127.0.0.1/verify?token=abc'
  });
  assert.equal(r.delivered, false);
  assert.equal(r.provider, 'brevo');
  assert.match(r.error, /401/);
  assert.doesNotMatch(r.error, /super-secret-brevo-key/);
  assert.match(r.note, /server log/i);
});

test('a hanging Brevo request times out and does not block for minutes', async () => {
  const mailer = createMailer({
    brevoApiKey: 'test-brevo-key',
    mailTimeoutMs: 50,
    fetchFn: async (_url, init) => {
      const signal = init && init.signal;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ status: 201, ok: true, text: async () => '' }), 30_000);
        if (signal) {
          const onAbort = () => {
            clearTimeout(t);
            const e = new Error('The operation was aborted');
            e.name = 'TimeoutError';
            reject(e);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  });
  const start = Date.now();
  const r = await mailer.send({
    to: 'player@example.com',
    subject: 'Hello',
    text: 'Hi',
    link: 'http://127.0.0.1/verify?token=abc'
  });
  const elapsed = Date.now() - start;
  assert.equal(r.delivered, false);
  assert.ok(elapsed < 2000, 'mail send should fail in well under a few seconds, got ' + elapsed + 'ms');
  assert.match(String(r.error), /timed out|aborted/i);
});

test('SMTP transport is created with ~10s connection, greeting, and socket timeouts', async () => {
  let opts;
  const mailer = createMailer({
    smtpUrl: 'smtp://user:pass@smtp.example.com:587',
    createTransport: (o) => {
      opts = o;
      return {
        sendMail: async () => ({ messageId: '1' }),
        close() {}
      };
    }
  });
  const r = await mailer.send({ to: 'a@example.com', subject: 'Hi', text: 'Hi' });
  assert.equal(r.delivered, true);
  assert.equal(opts.url, 'smtp://user:pass@smtp.example.com:587');
  assert.equal(opts.connectionTimeout, MAIL_TIMEOUT_MS);
  assert.equal(opts.greetingTimeout, MAIL_TIMEOUT_MS);
  assert.equal(opts.socketTimeout, MAIL_TIMEOUT_MS);
  assert.equal(MAIL_TIMEOUT_MS, 10_000);
});

test('/api/health mail is false or the provider name, and never a secret', async () => {
  const offApp = await createApp({ memory: true, mailer: createMailer({}) });
  const offServer = await listen(offApp);
  try {
    const res = await fetch('http://127.0.0.1:' + offServer.address().port + '/api/health');
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.mail, false);
    assert.equal(healthMail(createMailer({})), false);
  } finally {
    offServer.close();
  }

  const key = 'test-brevo-key-should-never-appear';
  const onApp = await createApp({
    memory: true,
    mailer: createMailer({
      brevoApiKey: key,
      fetchFn: async () => ({ status: 201, ok: true, text: async () => '' })
    })
  });
  const onServer = await listen(onApp);
  try {
    const res = await fetch('http://127.0.0.1:' + onServer.address().port + '/api/health');
    const raw = await res.text();
    const data = JSON.parse(raw);
    assert.equal(res.status, 200);
    assert.equal(data.mail, 'brevo');
    assert.doesNotMatch(raw, new RegExp(key));
    assert.equal(healthMail(createMailer({ brevoApiKey: key })), 'brevo');
  } finally {
    onServer.close();
  }
});
