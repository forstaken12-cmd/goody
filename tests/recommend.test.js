'use strict';

// Recommended surveys on the home screen + postback log lines.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { md5, theoremHash } = require('../server/lib/postback');
const { rankSurveys, createRecommender } = require('../server/lib/recommend');
const fs = require('fs');
const path = require('path');

const CPX_SECRET = 'cpx-rec-secret';
const AYET_KEY = 'ayet-rec-key';
const RR_KEY = 'rr-rec-key';
const RR_SECRET = 'rr-rec-secret';
const TR_SECRET = 'tr-rec-secret';

let app, server, base, cookie, publicId;
const calls = [];
let mode = 'ok';

function jsonRes(obj, status) {
  return { ok: (status || 200) < 400, status: status || 200, json: async () => obj };
}
async function fakeFetch(url, init) {
  calls.push({ url: String(url), init: init || {} });
  if (mode === 'fail') throw Object.assign(new Error('boom'), { name: 'TimeoutError' });
  if (mode === 'empty') {
    if (String(url).includes('rapidoreach')) return jsonRes({ ErrorCode: 'NOT_FOUND', Data: [] });
    return jsonRes({ status: 'success', surveys: [] });
  }
  if (String(url).startsWith('https://live-api.cpx-research.com/')) {
    return jsonRes({ status: 'success', surveys: [
      { id: '1', loi: '10', payout_publisher_usd: '1.00', top: 0, href: 'https://click.cpx-research.com/?k=a' },
      { id: '2', loi: '4', payout_publisher_usd: '0.80', top: 1, href: 'https://click.cpx-research.com/?k=b' },
      { id: '3', loi: '5', payout_publisher_usd: '0.50', href: 'javascript:alert(1)' }
    ] });
  }
  if (String(url).startsWith('https://www.ayetstudios.com/surveys/surveywall_api/31452')) {
    return jsonRes({ status: 'success', surveys: [{ id: 9, loi: 2, cpi: 150.6, category: 'technology', is_new: true, url: 'https://ayet.example/s/9' }] });
  }
  if (String(url) === 'https://www.rapidoreach.com/getallsurveys-api') {
    return jsonRes({ ErrorCode: 'SUCCESS', Data: [{ SurveyNumber: 'R1', SurveyUrl: 'https://www.rapidoreach.com/ofw/api-surveys/?x=1', Reward: 280, LOI: 20, CPI: 0.4, Survey: { SurveyName: 'Shopping habits' } }] });
  }
  return jsonRes({}, 404);
}

function listen(a) {
  return new Promise((resolve) => { const s = a.listen(0, '127.0.0.1', () => resolve(s)); });
}
async function get(url, headers) {
  const res = await fetch(base + url, { headers: Object.assign({ cookie: 'goody_session=' + cookie }, headers || {}) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

before(async () => {
  app = await createApp({
    memory: true,
    surveyFetch: fakeFetch,
    config: {
      demoPartner: false, sharePct: 0.7, pointUsd: 0.001, adminPassword: 'x',
      partners: {
        cpx: { name: 'CPX Research', secret: CPX_SECRET, appId: '38062', style: 'cpx', source: 'survey', enabled: true, allowedIps: [] },
        ayet: { name: 'ayeT-Studios', secret: AYET_KEY, style: 'ayet', surveySlot: '31452', offerSlot: '31454', enabled: true, allowedIps: [] },
        theoremreach: { name: 'TheoremReach', secret: TR_SECRET, apiKey: 'k', style: 'theoremreach', enabled: true, callbackBases: ['https://goody.day'], allowedIps: [] },
        rapidoreach: { name: 'RapidoReach', secret: RR_SECRET, appKey: RR_KEY, appId: 'YqyrVnOaFtt', style: 'rapidoreach', successBody: '1', enabled: true, allowedIps: [] }
      }
    }
  });
  server = await listen(app);
  base = 'http://127.0.0.1:' + server.address().port;
  const res = await fetch(base + '/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'rec@example.com', password: 'password12', agreeTerms: true, ageConfirm: true })
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  cookie = (res.headers.getSetCookie().join(';').match(/goody_session=([^;]+)/) || [])[1];
  publicId = data.user.publicId;
});
after(async () => {
  if (app && app.close) await app.close();
  if (server) await new Promise((r) => server.close(r));
});

test('rankSurveys sorts by points per minute, drops bad links, caps at 6, marks one top pick', () => {
  const items = [];
  for (let i = 0; i < 9; i++) items.push({ id: 'x' + i, partner: 'cpx', minutes: 10, points: 100 + i * 10, url: 'https://a/' + i });
  items.push({ id: 'bad', partner: 'cpx', minutes: 1, points: 999, url: '' });
  items.push({ id: 'zero', partner: 'cpx', minutes: 1, points: 0, url: 'https://a/z' });
  const out = rankSurveys(items);
  assert.equal(out.length, 6);
  assert.equal(out[0].id, 'x8');
  assert.equal(out[0].topPick, true);
  assert.equal(out.filter((s) => s.topPick).length, 1);
  assert.ok(out.every((s, i) => i === 0 || out[i - 1].ppm >= s.ppm));
});

test('unauthenticated request is refused', async () => {
  const res = await fetch(base + '/api/surveys/recommended');
  assert.equal(res.status, 401);
});

test('signed-in user gets merged survey list; CPX, ayeT and RapidoReach called with the documented params', async () => {
  calls.length = 0;
  const r = await get('/api/surveys/recommended', { 'cf-connecting-ip': '203.0.113.7', 'cf-ipcity': 'Boise', 'cf-ipcountry': 'US', 'user-agent': 'UA-test' });
  assert.equal(r.status, 200, r.text);
  const s = r.data.surveys;
  // ayeT 150 pts / 2 min = 75 ppm; CPX #2 560 / 4 = 140; CPX #1 700 / 10 = 70; RR 280 / 20 = 14
  assert.deepEqual(s.map((x) => x.id), ['cpx-2', 'ayet-9', 'cpx-1', 'rr-R1']);
  assert.equal(s[0].points, 560);
  assert.equal(s[0].topPick, true);
  assert.equal(s[1].points, 150);
  assert.equal(s[1].title, 'Technology survey');
  assert.equal(s[3].title, 'Shopping habits');
  assert.equal(s[3].points, 280);
  assert.ok(!s.some((x) => x.url.startsWith('javascript')));
  // Only TheoremReach (no list API used) comes back as a wall card.
  assert.deepEqual(r.data.walls, ['theoremreach']);

  const cpx = new URL(calls.find((c) => c.url.includes('cpx-research')).url);
  assert.equal(cpx.searchParams.get('ext_user_id'), publicId);
  assert.equal(cpx.searchParams.get('output_method'), 'api');
  assert.equal(cpx.searchParams.get('ip_user'), '203.0.113.7');
  assert.equal(cpx.searchParams.get('secure_hash'), md5(publicId + '-' + CPX_SECRET));
  const ay = new URL(calls.find((c) => c.url.includes('ayetstudios')).url);
  assert.equal(ay.searchParams.get('external_identifier'), publicId);
  assert.equal(ay.searchParams.get('ip'), '203.0.113.7');
  const rr = calls.find((c) => c.url.includes('rapidoreach'));
  assert.equal(rr.init.method, 'POST');
  assert.equal(rr.init.headers['X-RapidoReach-Api-Key'], RR_KEY);
  const body = JSON.parse(rr.init.body);
  assert.deepEqual([body.UserId, body.City, body.CountryLanguageCode, body.IpAddress], [publicId, 'Boise', 'ENG-US', '203.0.113.7']);
  // The secret never reaches the browser.
  assert.ok(!r.text.includes(CPX_SECRET) && !r.text.includes(RR_KEY));
});

test('results are cached per user for a few minutes', async () => {
  calls.length = 0;
  const r = await get('/api/surveys/recommended');
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0);
});

test('partner timeouts fail quietly and fall back to wall cards', async () => {
  mode = 'fail';
  const logs = [];
  const rec = createRecommender(app.locals.config, { fetchFn: fakeFetch, log: (m) => logs.push(m) });
  const out = await rec.forUser({ public_id: 'u_t' }, { ip: '1.2.3.4' }, { cpx: true, ayet_surveys: true, ayet_offers: true, theoremreach: true, rapidoreach: true });
  assert.deepEqual(out.surveys, []);
  assert.deepEqual(out.walls.sort(), ['ayet_surveys', 'cpx', 'rapidoreach', 'theoremreach']);
  assert.ok(logs.some((l) => l.includes('partner=cpx') && l.includes('timeout')));
  mode = 'empty';
  const out2 = await createRecommender(app.locals.config, { fetchFn: fakeFetch }).forUser({ public_id: 'u_e' }, { ip: '1.2.3.4' }, { cpx: true, theoremreach: true });
  assert.deepEqual(out2.surveys, []);
  assert.deepEqual(out2.walls.sort(), ['cpx', 'theoremreach']);
  mode = 'ok';
});

test('RapidoReach list is skipped without a city (wall card instead)', async () => {
  calls.length = 0;
  const out = await createRecommender(app.locals.config, { fetchFn: fakeFetch }).forUser({ public_id: 'u_nc' }, { ip: '1.2.3.4' }, { cpx: true, rapidoreach: true });
  assert.ok(!calls.some((c) => c.url.includes('rapidoreach')));
  assert.ok(out.walls.includes('rapidoreach'));
});

test('postbacks log partner, code, outcome and tx id, but never hashes or query strings', async () => {
  const lines = [];
  const ol = console.log, ow = console.warn;
  console.log = (m) => lines.push(String(m));
  console.warn = (m) => lines.push(String(m));
  try {
    const path = '/postback/theoremreach?' + new URLSearchParams({ user_id: publicId, tx_id: 'log-1', reward: '70', currency: '0.10' });
    const h = theoremHash(TR_SECRET, 'https://goody.day' + path);
    await fetch(base + path + '&hash=' + h);
    await fetch(base + path + '&hash=wrong');
    const tx = 'log-rr';
    await fetch(base + '/postback/rapidoreach?' + new URLSearchParams({ transactionId: tx, endUserId: publicId, status: 'C', amt: '0.1', txnHash: md5(tx + RR_SECRET) }));
  } finally {
    console.log = ol; console.warn = ow;
  }
  const pb = lines.filter((l) => l.startsWith('Postback |'));
  assert.ok(pb.some((l) => l.includes('partner=theoremreach') && l.includes('http=200') && l.includes('action=paid') && l.includes('tx=log-1')), pb.join('\n'));
  assert.ok(pb.some((l) => l.includes('partner=theoremreach') && l.includes('http=403') && l.includes('reason=bad hash')));
  assert.ok(pb.some((l) => l.includes('partner=rapidoreach') && l.includes('http=200') && l.includes('tx=log-rr')));
  for (const l of pb) {
    assert.ok(!/hash=|txnHash|\?/.test(l), l);
    assert.ok(!l.includes(TR_SECRET) && !l.includes(RR_SECRET), l);
  }
});

test('home HTML is not cached and points at versioned app.js and styles.css', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('cache-control') || ''), /no-store/i);
  const html = await res.text();
  assert.match(html, /src="\/app\.js\?v=[0-9]+-[0-9]+"/);
  assert.match(html, /href="\/styles\.css\?v=[0-9]+-[0-9]+"/);
  const jsRes = await fetch(base + '/app.js');
  assert.equal(jsRes.status, 200);
  assert.match(String(jsRes.headers.get('cache-control') || ''), /max-age=31536000/);
});

test('a hung recommender times out, logs the failure, and still returns wall cards', async () => {
  const logs = [];
  const ow = console.warn;
  console.warn = (m) => logs.push(String(m));
  let hungApp, hungServer;
  try {
    hungApp = await createApp({
      memory: true,
      recommendTimeoutMs: 40,
      recommender: { forUser: () => new Promise(() => {}) },
      config: {
        demoPartner: false, sharePct: 0.7, pointUsd: 0.001, adminPassword: 'x',
        partners: {
          cpx: { name: 'CPX Research', secret: CPX_SECRET, appId: '38062', style: 'cpx', source: 'survey', enabled: true, allowedIps: [] },
          ayet: { name: 'ayeT-Studios', secret: AYET_KEY, style: 'ayet', surveySlot: '31452', offerSlot: '31454', enabled: true, allowedIps: [] },
          theoremreach: { name: 'TheoremReach', secret: TR_SECRET, apiKey: 'k', style: 'theoremreach', enabled: true, callbackBases: ['https://goody.day'], allowedIps: [] },
          rapidoreach: { name: 'RapidoReach', secret: RR_SECRET, appKey: RR_KEY, appId: 'YqyrVnOaFtt', style: 'rapidoreach', successBody: '1', enabled: true, allowedIps: [] }
        }
      }
    });
    hungServer = await listen(hungApp);
    const hungBase = 'http://127.0.0.1:' + hungServer.address().port;
    const res = await fetch(hungBase + '/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'hang@example.com', password: 'password12', agreeTerms: true, ageConfirm: true })
    });
    assert.equal(res.status, 200);
    const ck = (res.headers.getSetCookie().join(';').match(/goody_session=([^;]+)/) || [])[1];
    const t0 = Date.now();
    const r = await fetch(hungBase + '/api/surveys/recommended', { headers: { cookie: 'goody_session=' + ck } });
    const data = await r.json();
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(r.status, 200);
    assert.deepEqual(data.surveys, []);
    assert.deepEqual(data.walls.sort(), ['ayet_surveys', 'cpx', 'rapidoreach', 'theoremreach']);
    assert.ok(logs.some((l) => l.includes('Recommended surveys failed') && l.includes('TimeoutError')));
    assert.ok(logs.every((l) => !l.includes(CPX_SECRET) && !l.includes(AYET_KEY) && !l.includes(RR_SECRET)));
  } finally {
    console.warn = ow;
    if (hungApp && hungApp.close) await hungApp.close();
    if (hungServer) await new Promise((r) => hungServer.close(r));
  }
});

test('client always starts the zone after sign-in, with a timeout and wall-card fallback', () => {
  const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const after = js.slice(js.indexOf('async function afterSignIn()'), js.indexOf('async function refresh()'));
  assert.match(after, /loadRecommended\(\)\.catch/);
  assert.ok(after.indexOf('loadRecommended') < after.indexOf('await loadOffers'), 'zone must not wait on loadOffers');
  assert.match(js, /api\('\/api\/surveys\/recommended', \{ timeoutMs: 8000 \}/);
  const load = js.slice(js.indexOf('async function loadRecommended()'), js.indexOf("$('rec-list').addEventListener"));
  assert.match(load, /zone\.hidden = false/);
  assert.ok(!/zone\.hidden = !html/.test(load) && !/zone\.hidden = !walls/.test(load), 'zone must stay visible when walls are on');
  assert.match(load, /paintRecWalls\(\)/);
});
