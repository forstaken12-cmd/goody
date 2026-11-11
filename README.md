# Goody

A rewards app: people finish little tasks (install an app, play for a while, or take a survey). The offer partner pays us, and we pass most of that on as points. People can then ask to cash out.

This is the real project shape (a Node server + a phone-sized web app). The built-in **demo partner** lets you try the whole path without real partner accounts. No real money is sent yet.

## How to run

You need Node.js 20 or later.

```bash
cd /workspace/goody
npm install
cp .env.example .env    # optional; defaults work for a local demo
npm start
```

Then open [http://localhost:3000](http://localhost:3000) on your phone or in a narrow browser window.

- App: http://localhost:3000
- Admin: http://localhost:3000/admin (password from `ADMIN_PASSWORD`, default `change-me-admin`)

Run the automated tests:

```bash
npm test
```

The database is a SQLite file at `data/goody.sqlite` (created on first run). We use [sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly) so you don’t need a native build toolchain. You can point `DB_PATH` at another file.

Stop the server with Ctrl+C.

## How it works

1. The first time someone opens the app, the server makes a simple **device account** (one account per device id). Real sign-in and email checks are not built yet.
2. Offers come from partners. In demo mode, the app itself serves a fake catalog and **signs postbacks** the same way a real partner would.
3. When a task is finished, the partner calls `GET` or `POST /postback/:partner` with a user id, a transaction id, an amount in USD, a status, and a signature.
4. The server checks the signature, applies the **user share** (default 70%), and writes an append-only **ledger** row. Status starts as `pending` (checking) and becomes `paid` or `rejected`.
5. The balance is **only** the sum of paid credits minus paid (or held) debits. The server never invents points.
6. A reversal / chargeback with the same transaction id marks that credit `rejected`, even if it was already paid.
7. The same transaction id will not be paid twice (idempotent).
8. Cash out is a **request**. Points are held immediately. An admin approves or rejects it, then marks it sent. There is no Lightning, PayPal, or gift-card payout hooked up yet.
9. The **first** cash out can be smaller (default **$0.50**). After that, the usual minimums apply (Bitcoin $0.80, PayPal $1.20, gift card $2.00).
10. Daily check-in, streaks, and daily goals also go through the demo partner as signed postbacks, so those gifts still come from a “partner payment,” not from thin air.

### Postbacks

Generic demo signature (HMAC-SHA256 of `uid|txid|payout|status`) is used by the built-in simulator.

Configs for real networks live in `server/config.js`:

- **BitLabs** — HMAC-SHA1 of the full callback URL, excluding `&hash=` (from their public docs).
- **AdGem** — v3 POST: `Signature` header is HMAC-SHA256 of the raw body (from their public docs). v2 GET `verifier` is also accepted.
- **CPX Research** — `md5(trans_id + "-" + app secure hash)` and `status=2` for a cancel (from publisher docs/examples; re-check the live dashboard at launch).
- **Ayet Studios** and **Torox** — placeholders only. Confirm official parameter names and signatures before turning them on.

Set the matching secret in the environment and point the partner’s dashboard at:

```
https://your-host/postback/bitlabs
https://your-host/postback/adgem
https://your-host/postback/cpx
```

## What’s real today vs still TODO before launch

**Works now (with the demo partner):**

- Device accounts, points ledger, pending → paid → rejected
- Offer list with filters (Games / Apps / Surveys) and sort (highest pay, quickest, newest)
- Playtime offers paid in milestones
- Streaks and daily goals
- First cash out at $0.50, then normal minimums, checked on the server
- History screen
- Admin page to review users, the ledger, and cash-out requests
- Signed, idempotent postbacks and reversals
- Basic rate limits and one account per device

**Still needed before a real launch:**

- Real partner accounts (BitLabs, AdGem, Ayet Studios, Torox, CPX Research, or others) and a production postback URL with HTTPS
- Confirm any leftover official parameter names (especially Ayet, Torox, and BitLabs reversal/chargeback types)
- Real payout providers (Lightning, PayPal, gift cards) — admin “mark sent” does not move money
- Real sign-in (email / phone / Apple / Google) and email or phone verification; replace the anonymous device account
- Hosting, backups, monitoring, and a proper process for the SQLite file (or a hosted database)
- App store wrapping (Capacitor, React Native, or a store webview) if you want iOS/Android listings
- Legal: terms, privacy policy, age gates, and how you handle tax and identity for payouts
- Stronger anti-abuse (device/IP farms, VPN checks, offer completion timing, partner-side fraud tools)
- A password and secrets manager — change `ADMIN_PASSWORD` and `DEMO_PARTNER_SECRET` before exposing the server
- Accessibility and localization polish on a real device

The older single-file prototypes are not this app. This project in `/workspace/goody` is the starting point for the real service.
