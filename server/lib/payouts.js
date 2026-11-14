'use strict';

/**
 * Payout provider interface.
 * Adapters are ready to plug in when env keys are set. They are not called
 * unless an admin approves a cash out AND the matching keys are present.
 * This file does not sign up for any service.
 *
 * PayPal Payouts: https://developer.paypal.com/api/payments.payouts-batch/v1/
 * Tremendous:     https://developers.tremendous.com/docs/authentication
 * ZBD (ZEBEDEE):  https://docs.zbdpay.com/bitcoin/lightning-address/send
 * Reloadly:       https://docs.reloadly.com/gift-cards/
 */

const MANUAL_NOTE = 'Approved, send manually.';

function flag(...names) {
  return names.some((n) => {
    const v = process.env[n];
    return v != null && String(v).trim() !== '';
  });
}

function statusFromEnv(overrides) {
  const o = overrides || {};
  return {
    paypal: !!(o.paypalClientId && o.paypalClientSecret) || (flag('PAYPAL_CLIENT_ID') && flag('PAYPAL_CLIENT_SECRET')),
    tremendous: !!(o.tremendousApiKey) || flag('TREMENDOUS_API_KEY'),
    zebedee: !!(o.zbdApiKey) || flag('ZBD_API_KEY', 'ZEBEDEE_API_KEY'),
    reloadly: reloadlyEnabled(o)
  };
}

function providerForMethod(method, connected) {
  if (method === 'paypal') return connected.paypal ? 'paypal' : null;
  if (method === 'gift') {
    if (connected.reloadly) return 'reloadly';
    return connected.tremendous ? 'tremendous' : null;
  }
  if (method === 'lightning') return connected.zebedee ? 'zebedee' : null;
  return null;
}

/* ---------------- Reloadly gift cards ---------------- */

const RELOADLY_AUTH_URL = 'https://auth.reloadly.com/oauth/token';
const RELOADLY_TIMEOUT_MS = 15000;
const RELOADLY_CATALOG_TTL_MS = 3 * 60 * 60 * 1000;
const RELOADLY_V1 = 'application/com.reloadly.giftcards-v1+json';
const RELOADLY_V2 = 'application/com.reloadly.giftcards-v2+json';

function reloadlyCreds(cfg) {
  const c = cfg || {};
  return {
    id: String(c.reloadlyClientId || process.env.RELOADLY_CLIENT_ID || '').trim(),
    secret: String(c.reloadlyClientSecret || process.env.RELOADLY_CLIENT_SECRET || '').trim()
  };
}

function reloadlyEnabled(cfg) {
  const k = reloadlyCreds(cfg);
  return !!(k.id && k.secret);
}

/** 'live' only when RELOADLY_ENV says so; anything else is the sandbox. */
function reloadlyEnv(cfg) {
  const v = String((cfg && cfg.reloadlyEnv) || process.env.RELOADLY_ENV || 'sandbox').trim().toLowerCase();
  return v === 'live' || v === 'production' || v === 'prod' ? 'live' : 'sandbox';
}

function reloadlyBase(env) {
  return env === 'live' ? 'https://giftcards.reloadly.com' : 'https://giftcards-sandbox.reloadly.com';
}

class ReloadlyError extends Error {
  /**
   * kind: config | auth | timeout | network | server | balance | rejected | failed
   * refund: true only when we know no card was bought, so points can go back.
   */
  constructor(message, { kind, refund, status, code } = {}) {
    super(message);
    this.name = 'ReloadlyError';
    this.kind = kind || 'unknown';
    this.refund = !!refund;
    this.status = status || null;
    this.code = code || null;
  }
}

// Short, safe text for logs and admin notes. Never includes tokens or codes.
function reloadlyErrText(data) {
  if (!data || typeof data !== 'object') return '';
  const code = data.errorCode ? String(data.errorCode).slice(0, 60) : '';
  const msg = data.message ? String(data.message).replace(/[\r\n]+/g, ' ').slice(0, 160) : '';
  return [code, msg].filter(Boolean).join(': ');
}

/* Curated, popular US brands. Only ones that exist in the live catalog show up. */
const GIFT_BRANDS = [
  { key: 'amazon', label: 'Amazon', match: /^amazon(\.com)? us$/i, note: 'Amazon US cards start at $5 (since July 2026).' },
  { key: 'target', label: 'Target', match: /^target us$/i },
  { key: 'walmart', label: 'Walmart', match: /^walmart( usa)? us$/i },
  // Names differ between sandbox and live, e.g. "Visa Prepaid US $1 to $150",
  // "Mastercard (Virtual) 1$ to $100 US", "Mastercard® eReward Virtual Account, 6-Month Expiration ... US".
  { key: 'visa', label: 'Visa prepaid', match: /^visa\b.*\b(prepaid|virtual|e?reward)\b.*\bUS\b/i },
  { key: 'mastercard', label: 'Mastercard prepaid', match: /^mastercard\b.*\b(prepaid|virtual|e?reward)\b.*\bUS\b/i },
  { key: 'googleplay', label: 'Google Play', match: /^google play us$/i },
  { key: 'apple', label: 'Apple', match: /^(apple|app store (&|and) itunes) us$/i },
  { key: 'roblox', label: 'Roblox', match: /^roblox us$/i },
  { key: 'starbucks', label: 'Starbucks', match: /^starbucks us$/i }
];
const RANGE_STEPS = [1, 2, 5, 10, 15, 20, 25, 50, 100];

function curateBrands(products) {
  const list = Array.isArray(products) ? products : [];
  const out = [];
  for (const b of GIFT_BRANDS) {
    const p = list.find((x) => x && b.match.test(String(x.productName || '').trim()) &&
      String(x.recipientCurrencyCode || 'USD') === 'USD' &&
      (!x.status || x.status === 'ACTIVE'));
    if (!p) continue;
    const fixed = String(p.denominationType) === 'FIXED';
    const values = fixed
      ? (p.fixedRecipientDenominations || []).map(Number).filter((v) => v > 0).sort((a, z) => a - z)
      : RANGE_STEPS.filter((v) => v >= Number(p.minRecipientDenomination) && v <= Number(p.maxRecipientDenomination));
    if (!values.length) continue;
    const logo = (Array.isArray(p.logoUrls) && p.logoUrls[0]) || (p.brand && p.brand.logoUrl) || '';
    out.push({
      key: b.key,
      name: b.label,
      productId: Number(p.productId),
      productName: String(p.productName),
      logo: String(logo).trim(),
      type: fixed ? 'FIXED' : 'RANGE',
      min: fixed ? values[0] : Number(p.minRecipientDenomination),
      max: fixed ? values[values.length - 1] : Number(p.maxRecipientDenomination),
      values,
      note: b.note || (/6-month/i.test(String(p.productName)) ? 'Works like a card you can use online. Expires after 6 months.' : null)
    });
  }
  return out;
}

/** Is `value` a price this product accepts? */
function validGiftValue(product, value) {
  const v = Number(value);
  if (!product || !Number.isFinite(v) || v <= 0) return false;
  if (Math.round(v * 100) !== v * 100) return false;
  if (String(product.denominationType) === 'FIXED') {
    return (product.fixedRecipientDenominations || []).map(Number).includes(v);
  }
  return v >= Number(product.minRecipientDenomination) && v <= Number(product.maxRecipientDenomination);
}

/**
 * One Reloadly client per app. Keeps the token until it expires and the US
 * catalog for a few hours. `fetchFn` is injected in tests.
 */
function createReloadly(cfg, opts) {
  const o = opts || {};
  const fetchFn = o.fetchFn || ((...a) => fetch(...a));
  const nowFn = o.now || Date.now;
  const timeoutMs = o.timeoutMs || RELOADLY_TIMEOUT_MS;
  const env = reloadlyEnv(cfg);
  const base = reloadlyBase(env);
  let token = null;
  let tokenExp = 0;
  let catalog = null;
  let catalogAt = 0;
  let pendingToken = null;

  async function call(url, init) {
    let res;
    try {
      res = await fetchFn(url, Object.assign({ signal: AbortSignal.timeout(timeoutMs) }, init));
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new ReloadlyError(timedOut ? 'Reloadly took too long to answer.' : 'Could not reach Reloadly.', {
        kind: timedOut ? 'timeout' : 'network'
      });
    }
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function getToken() {
    if (!reloadlyEnabled(cfg)) throw new ReloadlyError('Reloadly keys are not set.', { kind: 'config' });
    if (token && nowFn() < tokenExp) return token;
    if (pendingToken) return pendingToken;
    pendingToken = (async () => {
      const k = reloadlyCreds(cfg);
      const { res, data } = await call(RELOADLY_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: k.id,
          client_secret: k.secret,
          grant_type: 'client_credentials',
          audience: base
        })
      });
      if (!res.ok || !data.access_token) {
        const why = reloadlyErrText(data);
        const mismatch = /ENVIRONMENT_MISMATCH/i.test(why);
        throw new ReloadlyError(
          mismatch
            ? 'Reloadly keys do not match RELOADLY_ENV=' + env + '.'
            : 'Reloadly could not sign in (' + res.status + (why ? ', ' + why : '') + ').',
          { kind: 'auth', status: res.status, code: data && data.errorCode }
        );
      }
      const ttl = Math.max(60, Number(data.expires_in) || 3600);
      token = data.access_token;
      tokenExp = nowFn() + (ttl - 60) * 1000; // refresh a minute early
      return token;
    })();
    try {
      return await pendingToken;
    } finally {
      pendingToken = null;
    }
  }

  async function api(path, { method, body, accept } = {}) {
    const t = await getToken();
    const headers = { Authorization: 'Bearer ' + t, Accept: accept || RELOADLY_V1 };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const out = await call(base + path, {
      method: method || 'GET',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (out.res.status === 401) {
      token = null; // try a fresh token next time
    }
    return out;
  }

  async function products({ force } = {}) {
    if (!force && catalog && nowFn() - catalogAt < RELOADLY_CATALOG_TTL_MS) return catalog;
    const { res, data } = await api('/countries/US/products');
    if (!res.ok) {
      throw new ReloadlyError('Could not load gift cards (' + res.status + ').', { kind: res.status >= 500 ? 'server' : 'rejected', status: res.status });
    }
    const list = Array.isArray(data) ? data : (Array.isArray(data.content) ? data.content : []);
    catalog = list;
    catalogAt = nowFn();
    return catalog;
  }

  async function brands(opts2) {
    return curateBrands(await products(opts2));
  }

  async function findProduct(productId) {
    const id = Number(productId);
    const list = await products();
    return list.find((p) => Number(p.productId) === id) || null;
  }

  async function findByCustomIdentifier(customIdentifier) {
    const q = new URLSearchParams({ customIdentifier, size: '5', page: '1' });
    const { res, data } = await api('/reports/transactions?' + q.toString());
    if (!res.ok) return null;
    const list = Array.isArray(data) ? data : (Array.isArray(data.content) ? data.content : []);
    return list.find((t) => t && String(t.customIdentifier) === String(customIdentifier)) || null;
  }

  async function transaction(transactionId) {
    const { res, data } = await api('/reports/transactions/' + encodeURIComponent(transactionId));
    if (!res.ok) return null;
    return data;
  }

  /**
   * Buy one card. customIdentifier makes this safe to retry: Reloadly refuses
   * a second order with the same identifier, and then we look up the first.
   */
  async function placeOrder({ productId, unitPrice, customIdentifier }) {
    const { res, data } = await api('/orders', {
      method: 'POST',
      body: {
        productId: Number(productId),
        countryCode: 'US',
        quantity: 1,
        unitPrice: Number(unitPrice),
        customIdentifier: String(customIdentifier),
        senderName: 'Goody',
        preOrder: false
      }
    });
    if (res.ok && data && data.transactionId != null) {
      const st = String(data.status || '').toUpperCase();
      if (st === 'FAILED' || st === 'REFUNDED') {
        throw new ReloadlyError('Reloadly could not buy that card (' + st.toLowerCase() + ').', { kind: 'failed', refund: true, code: st });
      }
      return { transactionId: String(data.transactionId), status: st || 'SUCCESSFUL' };
    }
    const why = reloadlyErrText(data);
    if (res.status === 401 || res.status === 403) {
      throw new ReloadlyError('Reloadly said no to our keys (' + res.status + ').', { kind: 'auth', status: res.status });
    }
    if (res.status >= 500 || res.status === 429) {
      // We do not know if it went through. Hold the points; retrying is safe.
      throw new ReloadlyError('Reloadly had a problem (' + res.status + (why ? ', ' + why : '') + ').', { kind: 'server', status: res.status });
    }
    if (/DUPLICATE|ALREADY|EXISTS/i.test(why)) {
      const prev = await findByCustomIdentifier(customIdentifier).catch(() => null);
      if (prev && prev.transactionId != null) {
        const st = String(prev.status || '').toUpperCase();
        if (st === 'FAILED' || st === 'REFUNDED') {
          throw new ReloadlyError('Reloadly could not buy that card (' + st.toLowerCase() + ').', { kind: 'failed', refund: true, code: st });
        }
        return { transactionId: String(prev.transactionId), status: st || 'SUCCESSFUL', reused: true };
      }
      throw new ReloadlyError('Reloadly says this order already exists. Check the Reloadly dashboard before trying again.', { kind: 'server', status: res.status, code: data && data.errorCode });
    }
    if (/INSUFFICIENT|BALANCE|FUND/i.test(why)) {
      throw new ReloadlyError('The Reloadly wallet needs more money. Add funds, then approve again.', { kind: 'balance', status: res.status, code: data && data.errorCode });
    }
    // A clear "no" (bad product, amount, etc.). Nothing was bought.
    throw new ReloadlyError('Reloadly could not buy that card (' + res.status + (why ? ', ' + why : '') + ').', {
      kind: 'rejected', refund: true, status: res.status, code: data && data.errorCode
    });
  }

  /** Returns [{ cardNumber, pinCode, redemptionUrl }] or throws. Never logs codes. */
  async function redeemCode(transactionId) {
    const { res, data } = await api('/orders/transactions/' + encodeURIComponent(transactionId) + '/cards', { accept: RELOADLY_V2 });
    if (!res.ok) {
      throw new ReloadlyError('The gift code is not ready yet (' + res.status + ').', { kind: res.status >= 500 ? 'server' : 'rejected', status: res.status });
    }
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.content) ? data.content : [data]);
    const cards = list.filter(Boolean).map((c) => ({
      cardNumber: c.cardNumber != null ? String(c.cardNumber) : null,
      pinCode: c.pinCode != null ? String(c.pinCode) : null,
      redemptionUrl: c.redemptionUrl ? String(c.redemptionUrl) : null
    })).filter((c) => c.cardNumber || c.pinCode || c.redemptionUrl);
    if (!cards.length) throw new ReloadlyError('The gift code is not ready yet.', { kind: 'server' });
    return cards;
  }

  return { env, base, getToken, products, brands, findProduct, placeOrder, redeemCode, transaction, findByCustomIdentifier };
}

function reloadlyCustomId(cashout, cfg) {
  const prefix = String((cfg && cfg.reloadlyIdPrefix) || process.env.RELOADLY_ID_PREFIX || 'goody').replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'goody';
  return prefix + '-cashout-' + cashout.id;
}

async function sendReloadly(cashout, cfg, ctx) {
  const client = ctx && ctx.reloadly;
  if (!client) throw new ReloadlyError('Reloadly is not set up.', { kind: 'config' });
  if (!cashout.gift_product_id || !cashout.gift_value) {
    throw new ReloadlyError('This gift card request has no card picked. Send it manually.', { kind: 'config' });
  }
  const order = await client.placeOrder({
    productId: cashout.gift_product_id,
    unitPrice: cashout.gift_value,
    customIdentifier: reloadlyCustomId(cashout, cfg)
  });
  let cards = null;
  if (order.status === 'SUCCESSFUL') {
    // The code can lag a little behind the order; the account page fetches it later if needed.
    cards = await client.redeemCode(order.transactionId).catch(() => null);
  }
  return { ref: order.transactionId, giftTxnId: order.transactionId, cards, pending: !cards };
}

async function sendPaypal(cashout, cfg) {
  const env = (cfg.paypalEnv || process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
  const base = env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const id = cfg.paypalClientId || process.env.PAYPAL_CLIENT_ID;
  const secret = cfg.paypalClientSecret || process.env.PAYPAL_CLIENT_SECRET;
  const basic = Buffer.from(id + ':' + secret).toString('base64');
  const tokRes = await fetch(base + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!tokRes.ok) throw new Error('PayPal could not sign in (' + tokRes.status + ')');
  const tok = await tokRes.json();
  const body = {
    sender_batch_header: {
      sender_batch_id: 'goody-' + cashout.id + '-' + Date.now(),
      email_subject: 'You have a payment from Goody'
    },
    items: [{
      recipient_type: 'EMAIL',
      amount: { value: Number(cashout.usd).toFixed(2), currency: 'USD' },
      receiver: cashout.destination,
      note: 'Goody cash out',
      sender_item_id: 'cashout-' + cashout.id
    }]
  };
  const res = await fetch(base + '/v1/payments/payouts', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('PayPal payout failed (' + res.status + ')');
  return { ref: (data.batch_header && data.batch_header.payout_batch_id) || 'paypal', raw: data };
}

async function sendTremendous(cashout, cfg) {
  const key = cfg.tremendousApiKey || process.env.TREMENDOUS_API_KEY;
  const campaign = cfg.tremendousCampaignId || process.env.TREMENDOUS_CAMPAIGN_ID;
  const funding = cfg.tremendousFunding || process.env.TREMENDOUS_FUNDING_SOURCE_ID || 'BALANCE';
  const env = (cfg.tremendousEnv || process.env.TREMENDOUS_ENV || 'testflight').toLowerCase();
  const base = env === 'production' || env === 'live'
    ? 'https://api.tremendous.com'
    : 'https://testflight.tremendous.com';
  const reward = {
    value: { denomination: Number(cashout.usd), currency_code: 'USD' },
    delivery: { method: 'EMAIL' },
    recipient: { email: cashout.destination, name: 'Goody member' }
  };
  if (campaign) reward.campaign_id = campaign;
  const res = await fetch(base + '/api/v2/orders', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment: { funding_source_id: funding }, reward })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Tremendous order failed (' + res.status + ')');
  return { ref: (data.order && data.order.id) || data.id || 'tremendous', raw: data };
}

async function sendZebedee(cashout, cfg) {
  const key = cfg.zbdApiKey || process.env.ZBD_API_KEY || process.env.ZEBEDEE_API_KEY;
  // amount is millisatoshis; $ conversion is not performed here — this adapter
  // currently supports Lightning Address destinations and expects usd * 100000000
  // sats only when a BTC rate is supplied. Without a rate, we refuse rather than guess.
  const rate = Number(cfg.btcUsd || process.env.BTC_USD || 0);
  if (!rate) {
    throw new Error('ZBD/ZEBEDEE is connected, but BTC_USD is not set, so the amount cannot be converted. Send this one manually.');
  }
  const btc = Number(cashout.usd) / rate;
  const msats = String(Math.round(btc * 1e8 * 1000)); // satoshis * 1000
  const res = await fetch('https://api.zbdpay.com/v0/ln-address/send-payment', {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lnAddress: cashout.destination,
      amount: msats,
      comment: 'Goody cash out #' + cashout.id
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('ZBD payout failed (' + res.status + ')');
  return { ref: (data.data && (data.data.id || data.data.transactionId)) || data.id || 'zbd', raw: data };
}

/**
 * Try to pay a cash out through a connected provider.
 * If the matching keys are missing, returns a manual-approval result and does not call any network API.
 * `sendFns` can be injected in tests so we never hit a real payment API.
 */
async function trySend(cashout, cfg, sendFns, ctx) {
  const connected = statusFromEnv(cfg);
  let name = providerForMethod(cashout.method, connected);
  // Older gift requests (an email, no card picked) cannot go through Reloadly.
  if (name === 'reloadly' && !cashout.gift_product_id) name = connected.tremendous ? 'tremendous' : null;
  if (!name) {
    return {
      ok: true,
      mode: 'manual',
      provider: null,
      note: MANUAL_NOTE,
      sent: false
    };
  }
  const fns = Object.assign({ paypal: sendPaypal, tremendous: sendTremendous, zebedee: sendZebedee, reloadly: sendReloadly }, sendFns || {});
  const fn = fns[name];
  if (!fn) {
    return { ok: true, mode: 'manual', provider: name, note: MANUAL_NOTE, sent: false };
  }
  try {
    const out = await fn(cashout, cfg || {}, ctx || {});
    return {
      ok: true,
      mode: 'provider',
      provider: name,
      ref: out.ref,
      note: 'Sent with ' + name + '.',
      sent: true,
      giftTxnId: out.giftTxnId || null,
      cards: out.cards || null,
      pending: !!out.pending
    };
  } catch (e) {
    return {
      ok: false,
      mode: 'manual',
      provider: name,
      error: e.message,
      kind: e.kind || null,
      refund: !!e.refund,
      note: MANUAL_NOTE + ' ' + e.message,
      sent: false
    };
  }
}

module.exports = {
  MANUAL_NOTE,
  statusFromEnv,
  providerForMethod,
  trySend,
  sendPaypal,
  sendTremendous,
  sendZebedee,
  sendReloadly,
  createReloadly,
  curateBrands,
  validGiftValue,
  reloadlyEnabled,
  reloadlyEnv,
  reloadlyCustomId,
  ReloadlyError,
  GIFT_BRANDS
};
