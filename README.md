# Goody

A rewards app: people finish little tasks (install an app, play for a while, or take a survey). The offer partner pays us, and we pass most of that on as points. People can then ask to cash out.

This is the real project (a Node server + a phone-sized web app). The built-in **demo partner** lets you try the whole path without real partner accounts. No real money is sent until you connect payout providers and approve requests.

The live site is [https://goody-dfi5.onrender.com](https://goody-dfi5.onrender.com). It auto-deploys from the `main` branch of this repo.

Setup for Google and Apple sign-in is in [AUTH-SETUP.md](AUTH-SETUP.md).

## How to run

You need Node.js 20 or later.

```bash
cd goody
npm install
cp .env.example .env    # optional; defaults work for a local demo
npm start
```

Then open [http://localhost:3000](http://localhost:3000) on your phone or in a narrow browser window.

- App: http://localhost:3000
- Admin: http://localhost:3000/admin (password from `ADMIN_PASSWORD`, default `change-me-admin`)
- Terms: http://localhost:3000/terms
- Privacy: http://localhost:3000/privacy

Run the automated tests:

```bash
npm test
```

Stop the server with Ctrl+C.

## How it works

1. People can sign in with Google or Apple when those keys are set, or with email and password. They agree to the Terms and confirm they are 18 or older. Passwords are hashed. Sign-in uses an httpOnly session cookie. Google and Apple accounts are linked when the email is verified. See AUTH-SETUP.md.
2. We send an email to confirm the address when an email provider is configured. If it is not, the server logs the link and the app shows a friendly note. Password reset works the same way.
3. Offers come from partners. In demo mode, the app serves a fake catalog and **signs postbacks** the same way a real partner would.
4. When a task is finished, the partner calls `GET` or `POST /postback/:partner` with a user id, a transaction id, an amount in USD, a status, and a signature.
5. The server checks the signature, applies the **user share** (default 70%), and writes an append-only **ledger** row. Status starts as `pending` (checking) and becomes `paid` or `rejected`. A reversal marks that credit rejected. The same transaction id will not be paid twice.
6. The balance is **only** the sum of paid credits minus paid (or held) debits. The server never invents points.
7. Cash out is a **request**. Email must be confirmed first. Points are held immediately. An admin approves or rejects it. If PayPal, Tremendous, or ZBD/ZEBEDEE keys are not set, approval is marked **“Approved, send manually.”** If keys are set, the matching adapter can send the payout. There is no automatic sending until those keys are present.
8. The **first** cash out can be smaller (default **$0.50**). After that, the usual minimums apply.
9. Daily check-in, streaks, and daily goals also go through the demo partner as signed postbacks, so those gifts still come from a “partner payment,” not from thin air.

### Database

- If `DATABASE_URL` is a real `postgres://` or `postgresql://` URL and the server can connect, Goody uses Postgres.
- Otherwise it uses a local [sql.js](https://github.com/sql-js/sql.js) file (`data/goody.sqlite` by default) and logs a clear warning. The app will not crash because of a missing, placeholder, or broken `DATABASE_URL`.
- Tables are created on startup. Extra columns are added if they are missing.

A free Render Postgres instance named `goody-db` was set up for this app. **Render’s free Postgres expires on 2026-12-11.** After that you will need a paid database or another host, or the app will fall back to sql.js (which does not keep data across deploys on Render).

### Postbacks

Generic demo signature (HMAC-SHA256 of `uid|txid|payout|status`) is used by the built-in simulator.

See **PARTNERS.md** for who to apply to, what they usually ask for, and the exact live postback URLs on goody-dfi5.onrender.com.

## What’s real today vs still TODO before launch

**Works now:**

- Email + password accounts, session cookies, email confirmation and password reset (pluggable mail)
- Continue with Google and Continue with Apple (real server-side OAuth / OpenID Connect). Buttons stay on “Coming soon” until the keys below are set. Setup steps are in AUTH-SETUP.md
- Postgres when `DATABASE_URL` is valid, sql.js fallback otherwise
- Terms of Service and Privacy Policy (templates — have a lawyer review them)
- 18+ age rule, agreement required at signup
- Points ledger, pending → paid → rejected, playtime milestones, filters, history, streaks, first $0.50 cash out
- Admin page, including payout status and “Approved, send manually” when providers are not connected
- Payout adapters ready for PayPal Payouts, Tremendous, and ZBD / ZEBEDEE (not called unless keys are set)
- Signed, idempotent postbacks and reversals, including Lootably and Torox verifiers from their public docs
- Basic rate limits and a device-fingerprint note

**Still needed before a real launch:**

- A valid `DATABASE_URL` pointing at Postgres, and a plan for when free Render Postgres expires on 2026-12-11
- `PUBLIC_BASE_URL=https://goody-dfi5.onrender.com` if it is not already picked up from Render
- An email provider (`MAIL_FROM` plus `BREVO_API_KEY`, which is preferred on Render because the free plan blocks outbound SMTP; or `SMTP_URL` / `SENDGRID_API_KEY`) so confirmation and reset links are actually sent
- Real partner accounts and secrets (see PARTNERS.md). Confirm leftover official details for ayeT-Studios and TheoremReach.
- Real payout provider keys (PayPal, Tremendous, and/or ZBD). For Lightning, also set `BTC_USD` so the amount can be converted. Admin “mark sent” or “Approved, send manually” does not move money by itself.
- Stronger anti-abuse (captcha, phone checks, VPN tools). TheoremReach in particular asks for a captcha or similar on signup.
- A lawyer review of the Terms and Privacy Policy, and tax / identity handling for payouts
- App store wrapping if you want iOS/Android listings
- Hosting upgrades (Render’s free web service can spin down when idle), backups, and monitoring
- Change default secrets before exposing any new environment

## Env vars the operator still needs to supply

Never put real secrets in git. Set these in the Render dashboard (or your `.env` locally):

- `DATABASE_URL` — a real `postgres://` or `postgresql://` connection string (if this is a placeholder, the app falls back to sql.js)
- `PUBLIC_BASE_URL` — `https://goody-dfi5.onrender.com` (recommended; required for Google/Apple redirect URLs)
- `CONTACT_EMAIL` — shown on Terms, Privacy, and in the app (defaults to `forstaken12@gmail.com`)
- Google sign-in: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (see AUTH-SETUP.md)
- Apple sign-in: `APPLE_CLIENT_ID` (Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`. Sign in with Apple needs a paid Apple Developer Program membership ($99 USD/year; confirm on Apple’s site). Optional domain-verify file: `APPLE_DOMAIN_ASSOCIATION`
- `MAIL_FROM` and `BREVO_API_KEY` (preferred on Render; HTTP API). SMTP (`SMTP_URL` or `SMTP_HOST`+`SMTP_USER`+`SMTP_PASS`) and `SENDGRID_API_KEY` also work where outbound SMTP is allowed. If more than one is set, Brevo is used first.
- Payout keys, when you are ready: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`; `TREMENDOUS_API_KEY`, `TREMENDOUS_CAMPAIGN_ID`, `TREMENDOUS_ENV`; `ZBD_API_KEY` or `ZEBEDEE_API_KEY`, plus `BTC_USD`
- Partner secrets, when you are approved: `BITLABS_SECRET`, `ADGEM_POSTBACK_KEY`, `CPX_SECURE_HASH`, `TOROX_SECRET`, `LOOTABLY_POSTBACK_SECRET`, and later `AYET_SECRET` / `THEOREMREACH_SECRET` after you confirm official docs

`ADMIN_PASSWORD` and `DEMO_PARTNER_SECRET` should already be set on the live service.
