#!/usr/bin/env node
'use strict';
// Local only. Sends one valid and one badly signed callback per partner to a running Goody server.
//   USER_ID=u_... BASE=http://localhost:3000 AYET_API_KEY=... THEOREMREACH_SECRET=... \
//   RAPIDOREACH_APP_KEY=... RAPIDOREACH_APP_SECRET=... node scripts/simulate-partner-postbacks.js
// Use the same test secrets you started the local server with. Never point this at goody.day with real secrets.
const { md5, signAyet, theoremHash } = require('../server/lib/postback');

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const USER = process.env.USER_ID;
if (!USER) { console.error('Set USER_ID to a Goody public id (u_...).'); process.exit(1); }
if (/goody\.day|onrender\.com/.test(BASE)) { console.error('Refusing to send test credits to the live site.'); process.exit(1); }
const stamp = Date.now().toString(36);

async function hit(name, url, headers) {
  const res = await fetch(url, { headers: headers || {} });
  const body = (await res.text()).slice(0, 120);
  console.log(name.padEnd(28), res.status, body);
}

(async () => {
  const ayKey = process.env.AYET_API_KEY;
  if (ayKey) {
    const p = { external_identifier: USER, transaction_id: 'sim-ay-' + stamp, payout_usd: '0.50', currency_amount: '350', is_chargeback: '0' };
    const url = BASE + '/postback/ayet?' + new URLSearchParams(p);
    await hit('ayet valid', url, { 'X-Ayetstudios-Security-Hash': signAyet(p, ayKey) });
    await hit('ayet bad signature', url, { 'X-Ayetstudios-Security-Hash': signAyet(p, 'wrong') });
  }
  const trSecret = process.env.THEOREMREACH_SECRET;
  if (trSecret) {
    const path = '/postback/theoremreach?' + new URLSearchParams({ reward: '350', currency: '0.50', user_id: USER, tx_id: 'sim-tr-' + stamp });
    await hit('theoremreach valid', BASE + path + '&hash=' + theoremHash(trSecret, BASE + path));
    await hit('theoremreach bad hash', BASE + path + '&hash=' + theoremHash('wrong', BASE + path));
  }
  const rrKey = process.env.RAPIDOREACH_APP_KEY;
  const rrSecret = process.env.RAPIDOREACH_APP_SECRET;
  if (rrKey && rrSecret) {
    const tx = 'sim-rr-' + stamp;
    const q = (s) => BASE + '/postback/rapidoreach?' + new URLSearchParams({ transactionId: tx, endUserId: USER, status: 'C', cmd: 'C', amt: '0.50', currencyAmt: '350', offerHash: md5(tx + rrKey), txnHash: md5(tx + s) });
    await hit('rapidoreach valid', q(rrSecret));
    await hit('rapidoreach bad txnHash', q('wrong'));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
