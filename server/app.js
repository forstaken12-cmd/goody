'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const { openDb } = require('./db');
const { creditFromPartner, ptsToUsd, usdToPts, money, isoNow } = require('./lib/money');
const ledger = require('./lib/ledger');
const { verifyAndParse, signGeneric } = require('./lib/postback');
const auth = require('./lib/auth');
const { createLimiter } = require('./lib/rateLimit');
const { listOffers, findOffer } = require('./demo/catalog');
const { createSimulator } = require('./demo/simulator');
const goals = require('./lib/goals');
const { createMailer, healthMail } = require('./lib/mail');
const payouts = require('./lib/payouts');
const oauth = require('./lib/oauth');

const PUBLIC = path.join(__dirname, '..', 'public');

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
  res.status(e.http || 400).json({ error: e.message });
}

async function createApp(opts) {
  opts = opts || {};
  const cfg = Object.assign({}, config, opts.config || {});
  if (opts.config) {
    cfg.partners = Object.assign({}, config.partners, (opts.config && opts.config.partners) || {});
    if (opts.config.partners && opts.config.partners.demo) {
      cfg.partners.demo = Object.assign({}, config.partners.demo, opts.config.partners.demo);
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
    const user = await auth.findByPublicId(db, result.fields.uid);
    if (!user) {
      throw Object.assign(new Error('unknown user'), { http: 400, code: 'NO_USER' });
    }
    const source = result.fields.sourceHint || 'offer';
    const applied = await ledger.applyPostback(db, {
      userId: user.id,
      partner: partnerKey,
      txId: result.fields.txid,
      offerId: result.fields.offerId,
      source,
      partnerUsd: result.fields.partnerUsd,
      status: result.fields.status,
      note: (query && query.note) || (result.body && result.body.note) || null,
      sharePct: cfg.sharePct,
      pointUsd: cfg.pointUsd
    });
    return { ok: true, ...applied, fields: result.fields };
  }

  const sim = createSimulator({ config: cfg, ingest, db });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
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
      oauth: oauth.providersStatus(cfg)
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
      minAge: 18,
      oauth: oauth.providersStatus(cfg)
    });
  });

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
      const agree = truthyFlag(q.agree);
      const age = truthyFlag(q.age);
      if (!agree || !age) {
        res.status(400).json({ error: 'Please confirm you are 18 or older and agree to the Terms and Privacy Policy.' });
        return;
      }
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
    const category = req.query.category || 'all';
    const sort = req.query.sort || 'highest';
    const list = listOffers({ category, sort }).map((o) => offerView(o, cfg.sharePct, cfg.pointUsd));
    res.json({ offers: list });
  });

  app.get('/api/offers/:id', requireUser, async (req, res) => {
    const o = findOffer(req.params.id);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    const prog = await db.get('SELECT * FROM offer_progress WHERE user_id = ? AND offer_id = ?', [req.user.id, o.id]);
    res.json({ offer: offerView(o, cfg.sharePct, cfg.pointUsd), progress: prog || null });
  });

  app.post('/api/offers/:id/start', requireUser, async (req, res) => {
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

  app.post('/api/offers/:id/play', requireUser, async (req, res) => {
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

  app.post('/api/cashout', requireUser, cashLimit, async (req, res) => {
    try {
      if (!req.user.email_verified_at) {
        return res.status(403).json({ error: 'Please confirm your email before you cash out.' });
      }
      const method = (req.body && req.body.method) || 'lightning';
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
      res.json({ ok: true, cashout: row, balance: await ledger.balanceOf(db, req.user.id) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get('/api/cashouts', requireUser, async (req, res) => {
    const rows = await db.all('SELECT * FROM cashouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json({ cashouts: rows });
  });

  async function handlePostback(req, res) {
    const key = String(req.params.partner || '').toLowerCase();
    try {
      const out = await ingest({ partnerKey: key, req, query: Object.assign({}, req.query, req.body) });
      const partnerCfg = cfg.partners[key];
      if (partnerCfg && partnerCfg.successBody === '1') {
        res.status(200).type('text/plain').send('1');
        return;
      }
      res.status(200).json({ ok: true, action: out.action, idempotent: out.idempotent });
    } catch (e) {
      const code = e.http || 400;
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
      cashouts: await db.all('SELECT * FROM cashouts ORDER BY id DESC LIMIT 200'),
      payouts: payoutStatus()
    });
  });

  app.post('/admin/api/cashouts/:id/approve', requireAdmin, async (req, res) => {
    try {
      const row = await db.get('SELECT * FROM cashouts WHERE id = ?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'requested') return res.status(400).json({ error: 'This cash out is already ' + row.status });
      const result = await payouts.trySend(row, cfg, opts.payoutSendFns);
      const now = isoNow();
      if (result.sent) {
        await db.run(
          `UPDATE cashouts SET status = ?, admin_note = ?, payout_provider = ?, payout_mode = ?, payout_ref = ?, payout_error = ?, updated_at = ? WHERE id = ?`,
          ['sent', result.note, result.provider, 'provider', result.ref || null, null, now, row.id]
        );
        if (row.ledger_id) await ledger.settleDebit(db, row.ledger_id, 'paid');
      } else {
        const note = (req.body && req.body.note) || result.note || payouts.MANUAL_NOTE;
        await db.run(
          `UPDATE cashouts SET status = ?, admin_note = ?, payout_provider = ?, payout_mode = ?, payout_ref = ?, payout_error = ?, updated_at = ? WHERE id = ?`,
          ['approved', note, result.provider, 'manual', null, result.error || null, now, row.id]
        );
      }
      const cashout = await db.get('SELECT * FROM cashouts WHERE id = ?', [row.id]);
      res.json({ ok: true, cashout, payout: result });
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

  app.use(express.static(PUBLIC));
    app.get('/.well-known/apple-developer-domain-association.txt', (_req, res) => {
    const body = cfg.appleDomainAssociation;
    if (!body) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.type('text/plain').send(body);
  });

app.get('/terms', (_req, res) => res.sendFile(path.join(PUBLIC, 'terms.html')));
  app.get('/privacy', (_req, res) => res.sendFile(path.join(PUBLIC, 'privacy.html')));
  app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/postback') || req.path.startsWith('/admin')) return next();
    res.sendFile(path.join(PUBLIC, 'index.html'));
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

module.exports = { createApp, offerView, methodMinUsd };
