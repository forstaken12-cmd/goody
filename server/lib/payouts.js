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
    zebedee: !!(o.zbdApiKey) || flag('ZBD_API_KEY', 'ZEBEDEE_API_KEY')
  };
}

function providerForMethod(method, connected) {
  if (method === 'paypal') return connected.paypal ? 'paypal' : null;
  if (method === 'gift') return connected.tremendous ? 'tremendous' : null;
  if (method === 'lightning') return connected.zebedee ? 'zebedee' : null;
  return null;
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
async function trySend(cashout, cfg, sendFns) {
  const connected = statusFromEnv(cfg);
  const name = providerForMethod(cashout.method, connected);
  if (!name) {
    return {
      ok: true,
      mode: 'manual',
      provider: null,
      note: MANUAL_NOTE,
      sent: false
    };
  }
  const fns = sendFns || { paypal: sendPaypal, tremendous: sendTremendous, zebedee: sendZebedee };
  const fn = fns[name];
  if (!fn) {
    return { ok: true, mode: 'manual', provider: name, note: MANUAL_NOTE, sent: false };
  }
  try {
    const out = await fn(cashout, cfg || {});
    return {
      ok: true,
      mode: 'provider',
      provider: name,
      ref: out.ref,
      note: 'Sent with ' + name + '.',
      sent: true
    };
  } catch (e) {
    return {
      ok: false,
      mode: 'manual',
      provider: name,
      error: e.message,
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
  sendZebedee
};
