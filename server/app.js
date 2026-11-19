'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const { openDb } = require('./db');
const { creditFromPartner, ptsToUsd, usdToPts, money, isoNow } = require('./lib/money');
const ledger = require('./lib/ledger');
const { createRecommender } = require('./lib/recommend');
const { verifyAndParse, signGeneric, cpxWallUrl, ayetWallUrl, theoremreachWallUrl, rapidoreachWallUrl } = require('./lib/postback');
const auth = require('./lib/auth');
const { createLimiter } = require('./lib/rateLimit');
const { listOffers, findOffer } = require('./demo/catalog');
const { createSimulator } = require('./demo/simulator');
const goals = require('./lib/goals');
const { createMailer, healthMail } = require('./lib/mail');
const payouts = require('./lib/payouts');
const secretBox = require('./lib/secretBox');
const oauth = require('./lib/oauth');
const turnstile = require('./lib/turnstile');
const policy = require('./lib/policy');
const { canonicalHostMiddleware } = require('./lib/canonicalHost');

const PUBLIC = path.join(__dirname, '..', 'public');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function contactAddress(cfg) {
  return config.resolveContactEmail(cfg && cfg.contactEmail);
}

function injectContact(html, email) {
  const safe = escapeHtml(email);
  return String(html).split('{{CONTACT_EMAIL}}').join(safe);
}

function sendLegalPage(res, filename, cfg) {
  const html = fs.readFileSync(path.join(PUBLIC, filename), 'utf8');
  const withAge = String(html).split('{{MIN_AGE}}').join(String(policy.MIN_AGE));
  res.type('html').send(injectContact(withAge, contactAddress(cfg)));
}

// Bust /app.js and /styles.css so a cached copy cannot hide a new Home-screen zone.
// Version is the files' mtimes, so a deploy changes the query without a manual bump.
function assetVersion() {
  return ['app.js', 'styles.css'].map((f) => {
    try { return String(Math.floor(fs.statSync(path.join(PUBLIC, f)).mtimeMs)); } catch { return '0'; }
  }).join('-');
}
function bustAssets(html) {
  const v = encodeURIComponent(assetVersion());
  return String(html).replace(/(href|src)="\/(styles\.css|app\.js)"/g, '$1="/$2?v=' + v + '"');
}
function sendAppPage(res, filename) {
  const html = fs.readFileSync(path.join(PUBLIC, filename), 'utf8');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(bustAssets(html));
}


function offerView(o, sharePct, pointUsd) {
  const parts = creditFromPartner(o.partnerUsd, sharePct, pointUsd);
  const view = {
    id: o.id,
    name: o.name,
    task: o.task,
    category: o.category,
    type: o.type,
    minutes: o.minutes,
    difficulty: o.difficulty,
    badge: o.badge || null,
    steps: o.steps || null,
    questions: o.questions || null,
    createdAt: o.createdAt,
    partnerUsd: o.partnerUsd,
    points: parts.points,
    usd: parts.userUsd
  };
  if (o.milestones) {
    view.milestones = o.milestones.map((m) => {
      const p = creditFromPartner(m.partnerUsd, sharePct, pointUsd);
      return { id: m.id, minutes: m.minutes, points: p.points, usd: p.userUsd, partnerUsd: m.partnerUsd };
    });
  }
  return view;
}

function methodMinUsd(cfg, method, isFirst) {
  if (isFirst) return cfg.firstCashoutUsd;
  return cfg.mins[method] || cfg.mins.lightning;
}

function validDestination(method, dest) {
  if (!dest || typeof dest !== 'string') return false;
  const s = dest.trim();
  if (method === 'lightning') {
    if (/^ln(bc|tb|bcrt|url)?[0-9a-z]+$/i.test(s) && s.length > 10) return true;
    return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(s);
  }
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(s);
}

function sendError(res, e) {
  const body = { error: e.message };
  if (e.code && /^[A-Z_]+$/.test(String(e.code))) body.code = e.code;
  res.status(e.http || 400).json(body);
}

async function createApp(opts) {
  opts = opts || {};
  const cfg = Object.assign({}, config, opts.config || {});
  if (opts.config) {
    cfg.partners = Object.assign({}, config.partners, (opts.config && opts.config.partners) || {});
    if (opts.config.partners && opts.config.partners.demo) {
      cfg.partners.demo = Object.assign({}, config.partners.demo, opts.config.partners.demo);
    }
    // Keep the demo partner flag and its postback entry in sync when tests or callers override it.
    if (Object.prototype.hasOwnProperty.call(opts.config, 'demoPartner')) {
      cfg.partners.demo = Object.assign({}, cfg.partners.demo, { enabled: !!cfg.demoPartner });
    }
  }
  const mailer = opts.mailer || createMailer(cfg);
  const db = opts.db || (await openDb({
    path: opts.dbPath || cfg.dbPath,
    memory: opts.memory,
    forceSqlite: opts.forceSqlite,
    databaseUrl: Object.prototype.hasOwnProperty.call(opts, 'databaseUrl') ? opts.databaseUrl : undefined
  }));

  async function ingest({ partnerKey, req, query }) {
    const partnerCfg = cfg.partners[partnerKey];
    if (!partnerCfg) {
      throw Object.assign(new Error('Unknown partner'), { http: 404 });
    }
    const fakeReq = req || {
      query: query || {},
      body: {},
      originalUrl: '/postback/' + partnerKey + '?' + new URLSearchParams(query || {}).toString(),
      protocol: 'http',
      get(h) { return h.toLowerCase() === 'host' ? 'localhost' : undefined; },
      headers: {}
    };
    if (!req && query) fakeReq.query = query;
    const result = verifyAndParse(fakeReq, partnerCfg, cfg.publicBaseUrl);
    if (!result.ok) {
      throw Object.assign(new Error(result.reason || 'bad postback'), { http: result.http || 403, detail: result });
    }
    if (result.fields.status === 'ignore') {
      // Signed but nothing to credit (TheoremReach debug=true, unpaid RapidoReach screenouts).
      return { ok: true, action: 'ignored', idempotent: false, fields: result.fields };
    }
    const user = await auth.findByPublicId(db, result.fields.uid);
    if (!user) {
      throw Object.assign(new Error('unknown user'), { http: 400, code: 'NO_USER' });
    }
    const source = partnerCfg.source || result.fields.sourceHint || 'offer';
    const applied = await ledger.applyPostback(db, {
      userId: user.id,
      partner: partnerKey,
      txId: result.fields.txid,
      offerId: result.fields.offerId,
      source,
      partnerUsd: result.fields.partnerUsd,
      status: result.fields.status,
      note: partnerCfg.label || (query && query.note) || (result.body && result.body.note) || null,
      sharePct: cfg.sharePct,
      pointUsd: cfg.pointUsd
    });
    return { ok: true, ...applied, fields: result.fields };
  }

  const sim = createSimulator({ config: cfg, ingest, db });
  const reloadly = payouts.createReloadly(cfg, { fetchFn: opts.reloadlyFetch, timeoutMs: opts.reloadlyTimeoutMs });

  function giftKey() {
    return cfg.giftCodeKey || cfg.reloadlyClientSecret || process.env.RELOADLY_CLIENT_SECRET || '';
  }
  // What a user (or the admin list) may see about a cash out. Never the code.
  function cashoutView(row) {
    if (!row) return row;
    const out = Object.assign({}, row);
    delete out.gift_code_enc;
    out.has_code = !!row.gift_code_enc;
    return out;
  }
  async function refundCashout(row, note) {
    await db.run('UPDATE cashouts SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?', ['failed', note, isoNow(), row.id]);
    if (row.ledger_id) await ledger.settleDebit(db, row.ledger_id, 'rejected');
  }
  async function saveCards(rowId, cards) {
    if (!cards || !cards.length) return false;
    const key = giftKey();
    if (!key) return false;
    await db.run('UPDATE cashouts SET gift_code_enc = ?, updated_at = ? WHERE id = ?', [secretBox.seal(JSON.stringify(cards), key), isoNow(), rowId]);
    return true;
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // 301 other hosts (old onrender.com, www.) to PUBLIC_BASE_URL for page loads.
  app.use(canonicalHostMiddleware(cfg));
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; }
  }));
  app.use(express.urlencoded({ extended: false, verify: (req, _res, buf) => { req.rawBody = buf; } }));

  const apiLimit = createLimiter({ windowMs: 60_000, max: 180, keyFn: (r) => r.ip + ':' + (auth.sessionTokenFromReq(r) || '') });
  const cashLimit = createLimiter({ windowMs: 60_000, max: 8, keyFn: (r) => r.ip + ':' + (auth.sessionTokenFromReq(r) || '') });
  const sessionLimit = createLimiter({ windowMs: 60_000, max: 30, keyFn: (r) => r.ip });
  const signupLimit = createLimiter({ windowMs: 60 * 60_000, max: 8, keyFn: (r) => r.ip });
  const loginLimit = createLimiter({ windowMs: 15 * 60_000, max: 20, keyFn: (r) => r.ip });
  const forgotLimit = createLimiter({ windowMs: 60 * 60_000, max: 5, keyFn: (r) => r.ip });
  const postbackLimit = createLimiter({ windowMs: 60_000, max: 600, keyFn: (r) => r.ip });

  app.use('/api', apiLimit);

  function payoutStatus() {
    return payouts.statusFromEnv(cfg);
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      demo: cfg.demoPartner,
      db: db.dialect === 'pg' ? 'postgres' : 'sqlite',
      mail: healthMail(mailer),
      payouts: payoutStatus(),
      oauth: oauth.providersStatus(cfg),
      turnstile: turnstile.turnstileEnabled(cfg)
    });
  });

  app.get('/api/auth/status', async (req, res) => {
    const token = auth.sessionTokenFromReq(req);
    const ses = await auth.findSession(db, token);
    if (!ses) return res.json({ signedIn: false });
    const user = await auth.findById(db, ses.user_id);
    if (!user) return res.json({ signedIn: false });
    res.json({ signedIn: true, user: auth.publicUser(user) });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      demo: cfg.demoPartner,
      sharePct: cfg.sharePct,
      pointUsd: cfg.pointUsd,
      firstCashoutUsd: cfg.firstCashoutUsd,
      mins: cfg.mins,
      tz: cfg.tz,
      mailEnabled: mailer.enabled,
      minAge: policy.MIN_AGE,
      termsVersion: policy.TERMS_VERSION,
      contactEmail: contactAddress(cfg),
      oauth: oauth.providersStatus(cfg),
      turnstileSiteKey: turnstile.turnstileEnabled(cfg) ? cfg.turnstileSiteKey : null,
      walls: wallsStatus()
    });
  });


  async function captchaOk(req, res, opts2) {
    if (!turnstile.turnstileEnabled(cfg)) return true;
    const r = await turnstile.verifyTurnstile(cfg, turnstile.tokenFrom(req), {
      remoteip: req.ip,
      fetchFn: opts.turnstileFetch
    });
    if (r.ok) return true;
    console.warn('Turnstile check failed | route=' + req.path + ' | codes=' + (r.codes || []).join(','));
    if (opts2 && opts2.redirect) {
      oauthFail(res, turnstile.CHECK_MESSAGE);
    } else {
      res.status(400).json({ error: turnstile.CHECK_MESSAGE, code: 'CAPTCHA' });
    }
    return false;
  }

  function truthyFlag(v) {
    return v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === 'yes';
  }

  function oauthFail(res, message, err, meta) {
    const publicMsg = oauth.publicOauthError(message || (err && err.message) || '');
    if (err || (meta && meta.stage)) {
      oauth.logOauthFailure((meta && meta.stage) || 'oauth', err || new Error(message || publicMsg), {
        provider: meta && meta.provider,
        hint: meta && meta.hint
      });
    }
    const q = new URLSearchParams({ authError: publicMsg });
    res.redirect(302, '/?' + q.toString());
  }

  async function startOauth(req, res, provider) {
    try {
      const enabled = provider === 'google' ? oauth.googleEnabled(cfg) : oauth.appleEnabled(cfg);
      if (!enabled) {
        res.status(503).json({ error: 'That sign-in method is not set up yet.' });
        return;
      }
      const q = req.query || {};
      // The boxes are optional here: returning people already agreed. New
      // accounts are refused at the callback unless agree=1 and age=1 came along.
      const agree = truthyFlag(q.agree) && truthyFlag(q.age);
      const age = agree;
      // Google sign-in skips the bot check (Google already checks people).
      // Apple keeps it.
      if (provider !== 'google' && !(await captchaOk(req, res, { redirect: true }))) return;
      const { state, nonce } = await oauth.createOauthState(db, {
        provider,
        agree,
        age,
        fingerprint: q.fingerprint || ''
      });
      const url = provider === 'google'
        ? oauth.buildGoogleAuthUrl(cfg, { state, nonce })
        : oauth.buildAppleAuthUrl(cfg, { state, nonce });
      res.redirect(302, url);
    } catch (e) {
      oauth.logOauthFailure('start', e, { provider, hint: 'could_not_start' });
      sendError(res, e);
    }
  }

  async function finishOauth(req, res, provider, params) {
    const src = params || {};
    const meta = (stage, hint) => ({ provider, stage, hint });
    if (src.error) {
      oauthFail(res, 'Sign-in was cancelled.', null, meta('provider_error', String(src.error).slice(0, 80)));
      return;
    }
    try {
      const row = await oauth.takeOauthState(db, src.state, provider);
      if (!row) {
        oauthFail(res, 'That sign-in link expired. Please try again.', null, meta('state', 'missing_or_expired_state'));
        return;
      }
      if (!src.code && !src.id_token) {
        oauthFail(res, 'Sign-in could not be finished. Please try again.', null, meta('callback', 'missing_code_and_id_token'));
        return;
      }
      let payload;
      if (provider === 'google') {
        const tokens = await oauth.exchangeGoogleCode(cfg, src.code, { fetchFn: opts.oauthFetch });
        payload = await oauth.verifyGoogleIdToken(tokens.id_token, {
          audience: cfg.googleClientId,
          nonce: row.nonce,
          jwks: opts.oauthGoogleJwks
        });
      } else {
        let token = src.id_token;
        if (src.code) {
          const tokens = await oauth.exchangeAppleCode(cfg, src.code, {
            fetchFn: opts.oauthFetch,
            clientSecret: opts.oauthAppleClientSecret
          });
          token = tokens.id_token || token;
        }
        if (!token) {
          oauthFail(res, 'Sign-in could not be finished. Please try again.', null, meta('apple_token', 'missing_id_token'));
          return;
        }
        payload = await oauth.verifyAppleIdToken(token, {
          audience: cfg.appleClientId,
          nonce: row.nonce,
          jwks: opts.oauthAppleJwks
        });
      }
      const claims = oauth.claimsFromPayload(provider, payload);
      const { session } = await auth.loginWithOauth(db, {
        ...claims,
        agreeTerms: !!Number(row.agree),
        ageConfirm: !!Number(row.age),
        fingerprint: row.fingerprint
      }, req);
      auth.setSessionCookie(res, session, cfg);
      console.log('OAuth sign-in ok | provider=' + provider);
      res.redirect(302, '/');
    } catch (e) {
      oauthFail(res, e.message, e, meta('finish'));
    }
  }

  app.get('/api/auth/providers', (_req, res) => {
    res.json(oauth.providersStatus(cfg));
  });

  app.get('/api/auth/google/start', loginLimit, (req, res) => startOauth(req, res, 'google'));
  app.get('/api/auth/apple/start', loginLimit, (req, res) => startOauth(req, res, 'apple'));
  app.get('/api/auth/google/callback', loginLimit, (req, res) => finishOauth(req, res, 'google', req.query || {}));
  app.post('/api/auth/apple/callback', loginLimit, (req, res) => {
    const body = req.body || {};
    finishOauth(req, res, 'apple', {
      code: body.code,
      id_token: body.id_token,
      state: body.state,
      error: body.error
    });
  });
  // Some Apple setups can be switched to a query callback in tests.
  app.get('/api/auth/apple/callback', loginLimit, (req, res) => finishOauth(req, res, 'apple', req.query || {}));

  function verifyLink(raw) {
    return cfg.publicBaseUrl.replace(/\/$/, '') + '/verify?token=' + encodeURIComponent(raw);
  }
  function resetLink(raw) {
    return cfg.publicBaseUrl.replace(/\/$/, '') + '/reset?token=' + encodeURIComponent(raw);
  }

  async function sendVerify(user, raw) {
    return mailer.send(mailer.verifyEmailMessage({ to: user.email, link: verifyLink(raw) }));
  }

  app.post('/api/auth/signup', signupLimit, async (req, res) => {
    try {
      if (!(await captchaOk(req, res))) return;
      const body = req.body || {};
      const { user, session, verifyToken } = await auth.signup(db, {
        email: body.email,
        password: body.password,
        agreeTerms: !!(body.agreeTerms || body.agree),
        ageConfirm: !!(body.ageConfirm || body.age),
        fingerprint: body.fingerprint
      }, req);
      auth.setSessionCookie(res, session, cfg);
      const mail = await sendVerify(user, verifyToken);
      res.json({
        ok: true,
        user: auth.publicUser(user),
        needsVerification: true,
        mailEnabled: mailer.enabled,
        mailNote: mail.delivered ? null : (mail.note || mailer.linkNote())
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/auth/login', loginLimit, async (req, res) => {
    try {
      if (!(await captchaOk(req, res))) return;
      const body = req.body || {};
      const { user, session } = await auth.login(db, {
        email: body.email,
        password: body.password,
        fingerprint: body.fingerprint
      }, req);
      auth.setSessionCookie(res, session, cfg);
      res.json({ ok: true, user: auth.publicUser(user) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/auth/logout', sessionLimit, async (req, res) => {
    const token = auth.sessionTokenFromReq(req);
    await auth.destroySession(db, token);
    auth.clearSessionCookie(res, cfg);
    res.json({ ok: true });
  });

  app.post('/api/auth/verify', sessionLimit, async (req, res) => {
    try {
      const raw = (req.body && req.body.token) || req.query.token;
      const row = await auth.consumeEmailToken(db, raw, 'verify');
      if (!row) return res.status(400).json({ error: 'This link is old or already used. You can ask for a new one.' });
      const user = await auth.markVerified(db, row.user_id);
      res.json({ ok: true, user: auth.publicUser(user) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/auth/verify', sessionLimit, async (req, res) => {
    try {
      const row = await auth.consumeEmailToken(db, req.query.token, 'verify');
      if (!row) return res.status(400).json({ error: 'This link is old or already used. You can ask for a new one.' });
      await auth.markVerified(db, row.user_id);
      res.redirect('/?verified=1');
    } catch (e) {
      res.redirect('/?verified=0');
    }
  });

  app.post('/api/auth/resend', loginLimit, auth.requireUser(db), async (req, res) => {
    try {
      if (req.user.email_verified_at) return res.json({ ok: true, already: true });
      const raw = await auth.issueEmailToken(db, req.user.id, 'verify', auth.VERIFY_HOURS);
      const mail = await sendVerify(req.user, raw);
      res.json({
        ok: true,
        mailEnabled: mailer.enabled,
        mailNote: mail.delivered ? null : (mail.note || mailer.linkNote())
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/auth/forgot', forgotLimit, async (req, res) => {
    if (!(await captchaOk(req, res))) return;
    // Always the same reply so we don't reveal whether the email exists.
    const generic = { ok: true, message: 'If that email has an account, we will send a reset link.' };
    try {
      const email = auth.normalizeEmail(req.body && req.body.email);
      const user = await auth.findByEmail(db, email);
      if (user) {
        const raw = await auth.issueEmailToken(db, user.id, 'reset', auth.RESET_HOURS);
        const mail = await mailer.send(mailer.resetEmailMessage({ to: user.email, link: resetLink(raw) }));
        if (!mail.delivered) generic.mailNote = mail.note || mailer.linkNote();
        generic.mailEnabled = mailer.enabled;
      } else {
        generic.mailEnabled = mailer.enabled;
        if (!mailer.enabled) generic.mailNote = mailer.linkNote();
      }
      res.json(generic);
    } catch (e) {
      res.json(generic);
    }
  });

  app.post('/api/auth/reset', loginLimit, async (req, res) => {
    try {
      const raw = req.body && req.body.token;
      const password = req.body && req.body.password;
      const row = await auth.consumeEmailToken(db, raw, 'reset');
      if (!row) return res.status(400).json({ error: 'This reset link is old or already used.' });
      await auth.changePassword(db, row.user_id, password);
      res.json({ ok: true, message: 'Your password is updated. You can sign in now.' });
    } catch (e) {
      sendError(res, e);
    }
  });

  const requireUser = auth.requireUser(db);

  // Earning and cashing out need a saved agreement for the current Terms.
  // Old accounts (or a TERMS_VERSION bump) tick the boxes once via /api/auth/agree.
  function requireTerms(req, res, next) {
    if (policy.termsCurrent(req.user)) return next();
    res.status(403).json({ error: policy.agreeMessage(), code: 'NEED_AGREE' });
  }

  // ----- survey / offer walls -----
  // Each wall only switches on once its partner's secret env vars are set. Secrets stay on the
  // server; the browser only gets the finished, signed link for the signed-in user.
  function partnerOn(key) {
    const c = cfg.partners && cfg.partners[key];
    return !!(c && c.enabled && c.secret);
  }
  const WALLS = {
    cpx: {
      ready: () => partnerOn('cpx'),
      build: (u) => cpxWallUrl({ appId: cfg.partners.cpx.appId || '38062', secret: cfg.partners.cpx.secret, extUserId: u.public_id })
    },
    ayet_surveys: {
      ready: () => partnerOn('ayet') && !!cfg.partners.ayet.surveySlot,
      build: (u) => ayetWallUrl({ kind: 'surveys', adSlot: cfg.partners.ayet.surveySlot, extUserId: u.public_id })
    },
    ayet_offers: {
      ready: () => partnerOn('ayet') && !!cfg.partners.ayet.offerSlot,
      build: (u) => ayetWallUrl({ kind: 'offers', adSlot: cfg.partners.ayet.offerSlot, extUserId: u.public_id })
    },
    theoremreach: {
      ready: () => partnerOn('theoremreach') && !!cfg.partners.theoremreach.apiKey,
      build: (u) => theoremreachWallUrl({
        apiKey: cfg.partners.theoremreach.apiKey,
        secret: cfg.partners.theoremreach.secret,
        userId: u.public_id,
        transactionId: 'g' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex')
      })
    },
    rapidoreach: {
      ready: () => partnerOn('rapidoreach') && !!cfg.partners.rapidoreach.appKey && !!cfg.partners.rapidoreach.appId,
      build: (u) => rapidoreachWallUrl({ userId: u.public_id, appId: cfg.partners.rapidoreach.appId, appKey: cfg.partners.rapidoreach.appKey })
    }
  };
  function wallsStatus() {
    const out = {};
    for (const k of Object.keys(WALLS)) out[k] = WALLS[k].ready();
    return out;
  }
  app.get('/api/walls/:wall', requireUser, requireTerms, (req, res) => {
    const key = String(req.params.wall || '').toLowerCase();
    const w = Object.prototype.hasOwnProperty.call(WALLS, key) ? WALLS[key] : null;
    if (!w) return res.status(404).json({ error: 'Unknown wall.' });
    if (!w.ready()) return res.status(503).json({ error: 'This wall is not switched on yet.' });
    const partner = key.split('_')[0];
    res.set('Cache-Control', 'no-store');
    res.json({ partner: key, name: (cfg.partners[partner] && cfg.partners[partner].name) || partner, url: w.build(req.user) });
  });

  // ----- recommended surveys (home screen) -----
  const recommender = opts.recommender || createRecommender(cfg, { fetchFn: opts.surveyFetch, timeoutMs: opts.surveyTimeoutMs });
  function visitorInfo(req) {
    const h = (n) => String(req.get(n) || '').trim();
    const ip = (h('cf-connecting-ip') || String(req.ip || '')).replace(/^::ffff:/, '');
    const country = h('cf-ipcountry').toUpperCase();
    return {
      ip: /^[0-9a-f.:]+$/i.test(ip) && ip.length <= 45 ? ip : '',
      userAgent: h('user-agent').slice(0, 400),
      language: h('accept-language').slice(0, 100),
      city: h('cf-ipcity').slice(0, 80),
      country: /^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1' ? country : ''
    };
  }
  app.get('/api/surveys/recommended', requireUser, requireTerms, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const fallbackWalls = () => Object.keys(wallsStatus()).filter((k) => wallsStatus()[k] && k !== 'ayet_offers');
    const budget = opts.recommendTimeoutMs || (opts.surveyTimeoutMs || 3500) + 1500;
    let timer;
    try {
      const out = await Promise.race([
        recommender.forUser(req.user, visitorInfo(req), wallsStatus()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), budget);
        })
      ]);
      res.json({ surveys: out.surveys, walls: out.walls });
    } catch (e) {
      console.warn('Recommended surveys failed | ' + (e && e.name));
      res.json({ surveys: [], walls: fallbackWalls() });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  app.post('/api/auth/agree', sessionLimit, requireUser, async (req, res) => {
    try {
      const body = req.body || {};
      if (!truthyFlag(body.agree) || !truthyFlag(body.age)) {
        return res.status(400).json({ error: policy.agreeMessage(), code: 'NEED_AGREE' });
      }
      const user = await auth.recordAgreement(db, req.user.id);
      res.json({ ok: true, user: auth.publicUser(user) });
    } catch (e) {
      sendError(res, e);
    }
  });

  async function mePayload(user) {
    const bal = await ledger.balanceOf(db, user.id);
    const streak = await goals.getStreak(db, user.id, cfg.tz);
    const daily = await goals.computeGoals(db, user.id, cfg.tz);
    return {
      publicId: user.public_id,
      email: user.email,
      emailVerified: !!user.email_verified_at,
      firstCashoutDone: !!user.first_cashout_at,
      googleLinked: !!user.google_id,
      appleLinked: !!user.apple_id,
      termsOk: policy.termsCurrent(user),
      firstCashoutUsd: cfg.firstCashoutUsd,
      balance: bal,
      availableUsd: ptsToUsd(bal.available, cfg.pointUsd),
      pendingUsd: ptsToUsd(bal.pending, cfg.pointUsd),
      streak,
      goals: daily,
      demo: cfg.demoPartner,
      sharePct: cfg.sharePct,
      pointUsd: cfg.pointUsd,
      mins: cfg.mins,
      mailEnabled: mailer.enabled
    };
  }

  app.get('/api/me', requireUser, async (req, res) => {
    try {
      res.json(await mePayload(req.user));
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/offers', requireUser, (req, res) => {
    if (!cfg.demoPartner) return res.json({ offers: [] });
    const category = req.query.category || 'all';
    const sort = req.query.sort || 'highest';
    const list = listOffers({ category, sort }).map((o) => offerView(o, cfg.sharePct, cfg.pointUsd));
    res.json({ offers: list });
  });

  app.get('/api/offers/:id', requireUser, async (req, res) => {
    if (!cfg.demoPartner) return res.status(404).json({ error: 'Offer not found' });
    const o = findOffer(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    const prog = await db.get('SELECT * FROM offer_progress WHERE user_id = ? AND offer_id = ?', [req.user.id, o.id]);
    res.json({ offer: offerView(o, cfg.sharePct, cfg.pointUsd), progress: prog || null });
  });

  app.post('/api/offers/:id/start', requireUser, requireTerms, async (req, res) => {
    if (!cfg.demoPartner) return res.status(403).json({ error: 'Demo partner is off. Real offerwalls will start from their own pages.' });
    const o = findOffer(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    try {
      if (o.type === 'playtime') {
        const r = await sim.play(req.user, o, 0);
        return res.json({ ok: true, type: 'playtime', ...r, offer: offerView(o, cfg.sharePct, cfg.pointUsd) });
      }
      const outcome = req.body && req.body.outcome;
      const r = await sim.startInstall(req.user, o, { outcome: outcome || undefined });
      res.json({ ok: true, type: o.type, ...r });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/offers/:id/play', requireUser, requireTerms, async (req, res) => {
    if (!cfg.demoPartner) return res.status(403).json({ error: 'Demo partner is off.' });
    const o = findOffer(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    try {
      const minutes = Number((req.body && req.body.minutes) || 0);
      const r = await sim.play(req.user, o, minutes);
      res.json({ ok: true, ...r, offer: offerView(o, cfg.sharePct, cfg.pointUsd) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/history', requireUser, async (req, res) => {
    const status = req.query.status || 'all';
    const rows = (await ledger.history(db, req.user.id, status)).map((r) => ({
      id: r.id,
      type: r.entry_type,
      status: r.status,
      source: r.source,
      partner: r.partner,
      offerId: r.offer_id,
      points: r.points,
      usd: r.user_usd,
      note: r.note,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
    res.json({ entries: rows, balance: await ledger.balanceOf(db, req.user.id) });
  });

  app.post('/api/checkin', requireUser, async (req, res) => {
    try {
      const result = await goals.applyCheckin(db, req.user, {
        tz: cfg.tz,
        fireBonus: cfg.demoPartner ? (info) => sim.bonus(info) : null
      });
      if (cfg.demoPartner) await goals.maybeGoalBonus(db, req.user, { tz: cfg.tz, fireBonus: (info) => sim.bonus(info) });
      res.json({ ok: true, ...result, me: await mePayload(req.user) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/goals', requireUser, async (req, res) => {
    try {
      if (cfg.demoPartner) await goals.maybeGoalBonus(db, req.user, { tz: cfg.tz, fireBonus: (info) => sim.bonus(info) });
      res.json({
        streak: await goals.getStreak(db, req.user.id, cfg.tz),
        goals: await goals.computeGoals(db, req.user.id, cfg.tz)
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  // A picked Reloadly card: the price is the card's value, no email needed.
  async function giftCashout(req, res) {
    if (!payouts.reloadlyEnabled(cfg)) return res.status(400).json({ error: 'Gift cards are not ready yet.' });
    let brands, product;
    try {
      brands = await reloadly.brands();
      product = await reloadly.findProduct(req.body.productId);
    } catch (e) {
      console.warn('Reloadly catalog failed | kind=' + (e.kind || 'unknown') + ' | ' + e.message);
      return res.status(503).json({ error: 'Gift cards are taking a short nap. Try again later.' });
    }
    const brand = brands.find((b) => b.productId === Number(req.body.productId));
    if (!brand || !product) return res.status(400).json({ error: 'Pick a card from the list.' });
    const value = Number(req.body.value);
    if (!payouts.validGiftValue(product, value) || !brand.values.includes(value)) {
      return res.status(400).json({ error: 'Pick one of the amounts shown for ' + brand.name + '.' });
    }
    const pts = usdToPts(value, cfg.pointUsd);
    const bal = await ledger.balanceOf(db, req.user.id);
    if (pts > bal.available) {
      return res.status(400).json({ error: 'You need ' + pts + ' points for this card.' });
    }
    const usd = ptsToUsd(pts, cfg.pointUsd);
    const label = brand.name + ' $' + (Number.isInteger(value) ? value : value.toFixed(2));
    const isFirst = !req.user.first_cashout_at;
    const debit = await ledger.holdDebit(db, { userId: req.user.id, source: 'cashout', points: pts, usd, note: 'gift · ' + label });
    const now = isoNow();
    const r = await db.run(
      `INSERT INTO cashouts (user_id, method, destination, points, usd, is_first, status, ledger_id, gift_product_id, gift_brand, gift_value, gift_logo, created_at, updated_at)
       VALUES (?, 'gift', ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, label, pts, usd, isFirst ? 1 : 0, debit.id, brand.productId, brand.name, value, brand.logo || null, now, now]
    );
    if (isFirst) {
      await db.run('UPDATE users SET first_cashout_at = ? WHERE id = ? AND first_cashout_at IS NULL', [now, req.user.id]);
    }
    const row = await db.get('SELECT * FROM cashouts WHERE id = ?', [r.lastInsertRowid]);
    res.json({ ok: true, cashout: cashoutView(row), balance: await ledger.balanceOf(db, req.user.id) });
  }

  app.post('/api/cashout', requireUser, requireTerms, cashLimit, async (req, res) => {
    try {
      if (!req.user.email_verified_at) {
        return res.status(403).json({ error: 'Please confirm your email before you cash out.' });
      }
      const method = (req.body && req.body.method) || 'lightning';
      if (method === 'gift' && req.body && req.body.productId != null) {
        return await giftCashout(req, res);
      }
      const dest = ((req.body && req.body.destination) || '').trim();
      if (!['lightning', 'paypal', 'gift'].includes(method)) {
        return res.status(400).json({ error: 'Pick Bitcoin, PayPal, or a gift card.' });
      }
      if (!validDestination(method, dest)) {
        return res.status(400).json({ error: 'Enter a real-looking address or email.' });
      }
      const bal = await ledger.balanceOf(db, req.user.id);
      const isFirst = !req.user.first_cashout_at;
      const minUsd = methodMinUsd(cfg, method, isFirst);
      const minPts = usdToPts(minUsd, cfg.pointUsd);
      let amt = Math.floor(Number((req.body && req.body.points) != null ? req.body.points : bal.available));
      if (!Number.isFinite(amt) || amt <= 0) amt = bal.available;
      if (amt > bal.available) {
        return res.status(400).json({ error: 'You do not have that many points.' });
      }
      if (amt < minPts) {
        return res.status(400).json({
          error: isFirst
            ? `Your first cash out needs ${minPts} points ($${minUsd.toFixed(2)}).`
            : `This way needs ${minPts} points.`
        });
      }
      const usd = ptsToUsd(amt, cfg.pointUsd);
      const debit = await ledger.holdDebit(db, {
        userId: req.user.id,
        source: 'cashout',
        points: amt,
        usd,
        note: method + ' · ' + dest
      });
      const now = isoNow();
      const r = await db.run(
        `INSERT INTO cashouts (user_id, method, destination, points, usd, is_first, status, ledger_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
        [req.user.id, method, dest, amt, usd, isFirst ? 1 : 0, debit.id, now, now]
      );
      if (isFirst) {
        await db.run('UPDATE users SET first_cashout_at = ? WHERE id = ? AND first_cashout_at IS NULL', [now, req.user.id]);
      }
      const row = await db.get('SELECT * FROM cashouts WHERE id = ?', [r.lastInsertRowid]);
      res.json({ ok: true, cashout: cashoutView(row), balance: await ledger.balanceOf(db, req.user.id) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/cashouts', requireUser, async (req, res) => {
    const rows = await db.all('SELECT * FROM cashouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json({ cashouts: rows.map(cashoutView) });
  });

  // Gift cards a user can pick. Off (enabled:false) until Reloadly works.
  app.get('/api/giftcards', requireUser, async (_req, res) => {
    if (!payouts.reloadlyEnabled(cfg)) return res.json({ enabled: false });
    try {
      const brands = await reloadly.brands();
      res.json({ enabled: brands.length > 0, env: reloadly.env, brands });
    } catch (e) {
      console.warn('Reloadly catalog failed | kind=' + (e.kind || 'unknown') + ' | ' + e.message);
      res.json({ enabled: false, note: 'Gift cards are taking a short nap. Try again later.' });
    }
  });

  // Show a gift card code to its owner. Fetches it from Reloadly if it was not ready before.
  app.get('/api/cashouts/:id/code', requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const row = await db.get('SELECT * FROM cashouts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
      if (!row || !row.gift_product_id) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'sent') return res.status(400).json({ error: 'This gift card is not ready yet.' });
      if (!row.gift_code_enc && row.gift_txn_id && payouts.reloadlyEnabled(cfg)) {
        try {
          const cards = await reloadly.redeemCode(row.gift_txn_id);
          await saveCards(row.id, cards);
        } catch (e) {
          const tx = await reloadly.transaction(row.gift_txn_id).catch(() => null);
          const st = String((tx && tx.status) || '').toUpperCase();
          if (st === 'FAILED' || st === 'REFUNDED') {
            await refundCashout(row, 'The gift card did not go through, so your points came back.');
            return res.json({ ready: false, failed: true, message: 'This gift card did not go through, so your points came back.' });
          }
          return res.json({ ready: false, message: 'Your code is almost ready. Try again in a minute.' });
        }
      }
      const fresh = await db.get('SELECT gift_code_enc, gift_brand, gift_value FROM cashouts WHERE id = ?', [row.id]);
      if (!fresh.gift_code_enc) return res.json({ ready: false, message: 'Your code is almost ready. Try again in a minute.' });
      const cards = JSON.parse(secretBox.open(fresh.gift_code_enc, giftKey()));
      res.json({ ready: true, brand: fresh.gift_brand, value: fresh.gift_value, cards });
    } catch (e) {
      console.warn('Gift code view failed | cashout=' + req.params.id + ' | ' + (e && e.name));
      res.status(500).json({ error: 'Could not open this code. Please contact us.' });
    }
  });

  function postbackIpAllowed(partnerCfg, req) {
    const list = partnerCfg && Array.isArray(partnerCfg.allowedIps) ? partnerCfg.allowedIps : [];
    if (!list.length) return true;
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    return list.includes(ip);
  }

  // One log line per partner postback: partner, HTTP code, outcome or reason, transaction id.
  // Never the query string, hashes or secrets.
  function logPostback(key, code, what, query) {
    const q = query || {};
    const raw = q.transactionId || q.tx_id || q.trans_id || q.transaction_id || q.txid || q.tx || q.offerInvitationId || '';
    const tx = String(raw).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64) || '-';
    const k = String(key).replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || '-';
    const msg = 'Postback | partner=' + k + ' | http=' + code + ' | ' + String(what || '').slice(0, 80) + ' | tx=' + tx;
    if (code >= 400) console.warn(msg); else console.log(msg);
  }

  async function handlePostback(req, res) {
    const key = String(req.params.partner || '').toLowerCase();
    const query = Object.assign({}, req.query, req.body);
    try {
      if (!postbackIpAllowed(cfg.partners[key], req)) {
        throw Object.assign(new Error('ip not allowed'), { http: 403 });
      }
      const out = await ingest({ partnerKey: key, req, query });
      logPostback(key, 200, 'action=' + out.action + (out.idempotent ? ' (repeat)' : ''), query);
      const partnerCfg = cfg.partners[key];
      if (partnerCfg && partnerCfg.successBody === '1') {
        res.status(200).type('text/plain').send('1');
        return;
      }
      res.status(200).json({ ok: true, action: out.action, idempotent: out.idempotent });
    } catch (e) {
      const code = e.http || 400;
      logPostback(key, code, 'reason=' + (e && e.message), query);
      const partnerCfg = cfg.partners[key];
      if (partnerCfg && partnerCfg.successBody === '1' && code !== 403 && code !== 404) {
        // Still tell partners it failed clearly; they retry unless they get "1".
        res.status(code).type('text/plain').send('0');
        return;
      }
      res.status(code).json({ ok: false, error: e.message });
    }
  }
  app.get('/postback/:partner', postbackLimit, handlePostback);
  app.post('/postback/:partner', postbackLimit, handlePostback);

  // ----- admin -----
  const adminSessions = new Map();
  function adminOk(req) {
    const tok = (req.get('x-admin-token') || req.query.adminToken || (req.body && req.body.adminToken) || '');
    const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('goody_admin='));
    const cv = cookie ? decodeURIComponent(cookie.split('=')[1]) : '';
    const token = tok || cv;
    if (!token) return false;
    if (adminSessions.has(token)) return true;
    return false;
  }

  app.post('/admin/login', sessionLimit, async (req, res) => {
    const pw = (req.body && req.body.password) || '';
    if (!cfg.adminPassword || pw !== cfg.adminPassword) {
      return res.status(401).json({ error: 'Wrong password' });
    }
    const token = require('crypto').randomBytes(24).toString('hex');
    adminSessions.set(token, Date.now());
    await db.run('INSERT INTO admin_sessions (token, created_at) VALUES (?, ?)', [token, isoNow()]);
    res.cookie('goody_admin', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!cfg.secureCookies,
      path: '/'
    });
    res.json({ ok: true, token });
  });

  async function requireAdmin(req, res, next) {
    if (adminOk(req)) return next();
    const tok = (req.get('x-admin-token') || '');
    if (tok) {
      const row = await db.get('SELECT * FROM admin_sessions WHERE token = ?', [tok]);
      if (row) {
        adminSessions.set(tok, Date.now());
        return next();
      }
    }
    const cookie = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('goody_admin='));
    const cv = cookie ? decodeURIComponent(cookie.split('=')[1]) : '';
    if (cv) {
      const row = await db.get('SELECT * FROM admin_sessions WHERE token = ?', [cv]);
      if (row) {
        adminSessions.set(cv, Date.now());
        return next();
      }
    }
    return res.status(401).json({ error: 'Admin sign-in required' });
  }

  app.get('/admin/api/status', requireAdmin, (_req, res) => {
    res.json({
      db: db.dialect === 'pg' ? 'postgres' : 'sqlite',
      mail: healthMail(mailer),
      payouts: payoutStatus(),
      reloadlyEnv: payouts.reloadlyEnabled(cfg) ? payouts.reloadlyEnv(cfg) : null,
      demo: cfg.demoPartner
    });
  });

  app.get('/admin/api/users', requireAdmin, async (_req, res) => {
    const users = await db.all(
      'SELECT id, public_id, email, email_verified_at, device_fingerprint, device_note, created_at, first_cashout_at, last_seen_at FROM users ORDER BY id DESC LIMIT 200'
    );
    const out = [];
    for (const u of users) {
      out.push({ ...u, balance: await ledger.balanceOf(db, u.id) });
    }
    res.json({ users: out });
  });

  app.get('/admin/api/ledger', requireAdmin, async (req, res) => {
    const userId = req.query.userId;
    const rows = userId
      ? await db.all('SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 300', [userId])
      : await db.all('SELECT * FROM ledger ORDER BY id DESC LIMIT 300');
    res.json({ entries: rows });
  });

  app.get('/admin/api/cashouts', requireAdmin, async (_req, res) => {
    res.json({
      cashouts: (await db.all('SELECT * FROM cashouts ORDER BY id DESC LIMIT 200')).map(cashoutView),
      payouts: payoutStatus()
    });
  });

  app.post('/admin/api/cashouts/:id/approve', requireAdmin, async (req, res) => {
    try {
      const row = await db.get('SELECT * FROM cashouts WHERE id = ?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'requested') return res.status(400).json({ error: 'This cash out is already ' + row.status });
      const result = await payouts.trySend(row, cfg, opts.payoutSendFns, { reloadly });
      const now = isoNow();
      if (result.sent) {
        await db.run(
          `UPDATE cashouts SET status = ?, admin_note = ?, payout_provider = ?, payout_mode = ?, payout_ref = ?, payout_error = ?, gift_txn_id = COALESCE(?, gift_txn_id), updated_at = ? WHERE id = ?`,
          ['sent', result.note, result.provider, 'provider', result.ref || null, null, result.giftTxnId || null, now, row.id]
        );
        if (row.ledger_id) await ledger.settleDebit(db, row.ledger_id, 'paid');
        if (result.cards) await saveCards(row.id, result.cards);
      } else if (result.provider === 'reloadly' && result.refund) {
        // Reloadly clearly said no, so no card was bought: give the points back.
        console.warn('Reloadly order failed | cashout=' + row.id + ' | kind=' + result.kind + ' | ' + result.error);
        await db.run('UPDATE cashouts SET payout_provider = ?, payout_mode = ?, payout_error = ? WHERE id = ?', ['reloadly', 'provider', result.error, row.id]);
        await refundCashout(row, 'The gift card did not go through, so your points came back.');
      } else if (result.provider === 'reloadly') {
        // Not sure it went through (timeout, sign-in, empty wallet). Keep the
        // points held and leave it "requested" so Approve can be pressed again;
        // the same customIdentifier stops a double order.
        console.warn('Reloadly order not finished | cashout=' + row.id + ' | kind=' + result.kind + ' | ' + result.error);
        await db.run('UPDATE cashouts SET payout_provider = ?, payout_mode = ?, payout_error = ?, updated_at = ? WHERE id = ?', ['reloadly', 'provider', result.error, now, row.id]);
      } else {
        const note = (req.body && req.body.note) || result.note || payouts.MANUAL_NOTE;
        await db.run(
          `UPDATE cashouts SET status = ?, admin_note = ?, payout_provider = ?, payout_mode = ?, payout_ref = ?, payout_error = ?, updated_at = ? WHERE id = ?`,
          ['approved', note, result.provider, 'manual', null, result.error || null, now, row.id]
        );
      }
      const cashout = cashoutView(await db.get('SELECT * FROM cashouts WHERE id = ?', [row.id]));
      const payout = Object.assign({}, result);
      delete payout.cards;
      res.json({ ok: true, cashout, payout });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/admin/api/cashouts/:id/sent', requireAdmin, async (req, res) => {
    const row = await db.get('SELECT * FROM cashouts WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'approved' && row.status !== 'requested') {
      return res.status(400).json({ error: 'This cash out is already ' + row.status });
    }
    await db.run('UPDATE cashouts SET status = ?, updated_at = ? WHERE id = ?', ['sent', isoNow(), row.id]);
    if (row.ledger_id) await ledger.settleDebit(db, row.ledger_id, 'paid');
    res.json({ ok: true, cashout: await db.get('SELECT * FROM cashouts WHERE id = ?', [row.id]) });
  });

  app.post('/admin/api/cashouts/:id/reject', requireAdmin, async (req, res) => {
    const row = await db.get('SELECT * FROM cashouts WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status === 'sent') return res.status(400).json({ error: 'Already sent' });
    await db.run('UPDATE cashouts SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?', [
      'rejected', (req.body && req.body.note) || 'rejected', isoNow(), row.id
    ]);
    if (row.ledger_id) await ledger.settleDebit(db, row.ledger_id, 'rejected');
    res.json({ ok: true, cashout: await db.get('SELECT * FROM cashouts WHERE id = ?', [row.id]) });
  });

  app.get('/.well-known/apple-developer-domain-association.txt', (_req, res) => {
    const body = cfg.appleDomainAssociation;
    if (!body) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.type('text/plain').send(body);
  });

  app.get(['/terms', '/terms.html'], (_req, res) => sendLegalPage(res, 'terms.html', cfg));
  app.get(['/privacy', '/privacy.html'], (_req, res) => sendLegalPage(res, 'privacy.html', cfg));
  app.get(['/', '/index.html'], (_req, res) => sendAppPage(res, 'index.html'));
  app.get('/admin', (_req, res) => sendAppPage(res, 'admin.html'));
  app.use(express.static(PUBLIC, {
    setHeaders(res, filePath) {
      if (/\.html$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
      else if (/\.(js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/postback') || req.path.startsWith('/admin')) return next();
    sendAppPage(res, 'index.html');
  });

  app.locals.db = db;
  app.locals.config = cfg;
  app.locals.ingest = ingest;
  app.locals.sim = sim;
  app.locals.ledger = ledger;
  app.locals.mailer = mailer;
  app.close = async () => {
    sim.close();
    if (db.saveNow) db.saveNow();
    if (db.close) await db.close();
  };
  return app;
}

module.exports = { createApp, offerView, methodMinUsd, contactAddress, injectContact, escapeHtml, bustAssets, assetVersion };
