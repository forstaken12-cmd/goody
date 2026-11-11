'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const config = require('../server/config');

const servers = [];

function listen(a) {
  return new Promise((resolve) => {
    const s = a.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function start(opts) {
  const app = await createApp(Object.assign({ memory: true }, opts || {}));
  const server = await listen(app);
  servers.push(server);
  return { app, base: 'http://127.0.0.1:' + server.address().port };
}

after(() => {
  for (const s of servers) s.close();
});

test('CONTACT_EMAIL defaults to forstaken12@gmail.com and rejects a bad value', () => {
  assert.equal(config.DEFAULT_CONTACT_EMAIL, 'forstaken12@gmail.com');
  assert.equal(config.resolveContactEmail(''), 'forstaken12@gmail.com');
  assert.equal(config.resolveContactEmail('not-an-email'), 'forstaken12@gmail.com');
  assert.equal(config.resolveContactEmail('help@example.com'), 'help@example.com');
});

test('Terms and Privacy show a Contact us section and a mailto link', async () => {
  const { base } = await start();
  for (const path of ['/terms', '/privacy', '/terms.html', '/privacy.html']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.match(html, /<h2>Contact us<\/h2>/);
    assert.match(html, /mailto:forstaken12@gmail.com/);
    assert.match(html, />forstaken12@gmail.com</);
    assert.doesNotMatch(html, /\{\{CONTACT_EMAIL\}\}/);
    assert.doesNotMatch(html, /should add a real contact email/i);
  }
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.contactEmail, 'forstaken12@gmail.com');
});

test('a custom CONTACT_EMAIL is injected into the legal pages', async () => {
  const { base } = await start({ config: { contactEmail: 'hello@example.com' } });
  const terms = await (await fetch(base + '/terms')).text();
  const privacy = await (await fetch(base + '/privacy')).text();
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.contactEmail, 'hello@example.com');
  for (const html of [terms, privacy]) {
    assert.match(html, /<h2>Contact us<\/h2>/);
    assert.match(html, /mailto:hello@example.com/);
    assert.doesNotMatch(html, /mailto:forstaken12@gmail.com/);
    assert.doesNotMatch(html, /\{\{CONTACT_EMAIL\}\}/);
  }
});
