# Partner guide

This is a plain-English guide to offerwall and survey partners you can apply to, what they tend to ask for, and how to plug each one into Goody. I only list facts I checked on their public pages in November 2026. Where I could not confirm a signature or a requirement, it is marked as a TODO.

Goody’s live postback path is always:

```
https://goody.day/postback/<partner>
```

The old address `https://goody-dfi5.onrender.com/postback/<partner>` still works (postbacks are never redirected), but use `goody.day` for anything new.

Replace `<partner>` with `bitlabs`, `cpx`, `adgem`, `ayet`, `torox`, `lootably`, `theoremreach`, or `rapidoreach`. Put that URL (plus any macros the partner asks for) in their dashboard. Then set the matching secret on the Render service. Do not put secrets in this repo.

## Revenue share (important)

Goody applies a **user share** on the server (default **70%** of the partner’s payout in USD). The remaining 30% stays with the app.

Some partners also let you set a “user split” or “currency rate” in *their* dashboard (Lootably and Torox both describe this). If you set 70% there *and* leave Goody at 70%, people will only get about 49%.

Pick one place to take the cut:

- Easiest with Goody: set the partner dashboard so the USD postback is the **full publisher payout**, and let Goody apply the 70% share; or
- Set the split only in the partner dashboard, and set Goody’s `USER_SHARE=1`.

Always credit from the partner’s **publisher USD** field (BitLabs `RAW` / `VALUE:USD`, Lootably `{revenue}`, Torox `payout`, AdGem `payout`), not from a “user currency” number they also send.

## BitLabs

- What it is: surveys and offers. Docs: [Welcome to BitLabs](https://developer.bitlabs.ai/docs/getting-started), [Getting verified](https://developer.bitlabs.ai/docs/getting-verified), [Reward callbacks](https://developer.bitlabs.ai/docs/general-reward-callbacks).
- How to apply: create a dashboard account; their sales team may contact you to help set it up ([getting started](https://developer.bitlabs.ai/docs/getting-started)). After you make a workspace, you must get it **verified** by contacting their team with the details they ask for ([getting verified](https://developer.bitlabs.ai/docs/getting-verified)).
- What they require (from their verification page): a site or app that meets their quality and traffic standards, enough information on the application, an audience that fits their offers, and no signs of suspicious or non-organic activity. Verification “typically takes up to 3 business days.” Payment details must be completed before you can receive earnings. Their page also says there is currently no way to reapply if you are denied.
- How to plug into Goody: in the publisher dashboard, under Apps → your app → Integration → Reward Callback, set the host to `https://goody.day` and the path to `/postback/bitlabs`. Include at least `UID`, `TX`, `VAL`, and `RAW`, and `TYPE` if you use surveys ([callback docs](https://developer.bitlabs.ai/docs/general-reward-callbacks), [parameter list](https://bitlabs.ai/integrations/server-to-server-callback)). Set `BITLABS_SECRET` to the app secret. Goody verifies the HMAC-SHA1 of the full callback URL, excluding `&hash=`, as their docs describe.
- TODO: confirm the official reversal / reconciliation `TYPE` value with BitLabs before launch.

## CPX Research

- What it is: survey wall run by Make Opinion GmbH. Publisher sign-up: [publisher.cpx-research.com](https://publisher.cpx-research.com/index.php?advertiser_id=42&page=register). Integration notes: [cpx-research.com/main/en/doc.php](https://cpx-research.com/main/en/doc.php). Terms: [publisher terms](https://cpx-research.com/main/en/terms.php).
- How to apply: use the publisher sign-up, not the consumer survey site. The sign-up page says this is for mobile and web business owners only.
- What they require (from the sign-up form I reviewed): you should own a live public app or website with users, or be developing one and tell them about the project. You confirm you will put fraud prevention in place before launch (they list options such as email or phone verification, VPN detection, device fingerprinting, manual payout review, and rate limits).
- Status: **approved (November 2026), App ID `38062`.** Goody shows the CPX survey wall to signed-in users (a "Survey wall" card on Home and Offers that opens `https://offers.cpx-research.com/index.php?app_id=38062&ext_user_id=<Goody public id>&secure_hash=md5(ext_user_id + "-" + security hash)`, built on the server by `GET /api/walls/cpx`). We do not send email or username, to match our privacy policy; CPX may ask the user for an email itself.
- Render env: `CPX_APP_ID` (default `38062`) and `CPX_SECURITY_HASH` (the app security hash; the old name `CPX_SECURE_HASH` also works). The wall stays hidden until the hash is set. Optional: `CPX_POSTBACK_IPS` (comma-separated) to only accept postbacks from those IPs; CPX's public docs do not list fixed IPs, so leave it empty unless CPX gives you a list.
- Postback URL to paste in CPX → your app → Postback Settings:

  `https://goody.day/postback/cpx?status={status}&trans_id={trans_id}&user_id={user_id}&amount_usd={amount_usd}&amount_local={amount_local}&offer_ID={offer_ID}&ip_click={ip_click}&hash={secure_hash}`

  Goody checks `hash == md5(trans_id + "-" + security hash)`, credits `status=1`, and treats `status=2` as a cancel / chargeback that takes the points back (the balance can go below zero, which blocks cash-outs). Each `trans_id` is credited once; replays get HTTP 200 with `"idempotent": true`, and a late `status=1` after a reversal is ignored. Bad hash = HTTP 403, unknown user or status = HTTP 400. Goody credits from `{amount_usd}` (publisher USD) at the normal 70% user share, so $1.00 = 700 points. To make CPX's own wall show the same numbers, set the app currency in the CPX dashboard to "Points" at 700 per $1 (amount_local is not used for crediting).

## AdGem

- What it is: offerwall for web and apps. Docs: [Quickstart](https://docs.adgem.com/docs/get-started/quickstart), [Web Offerwall](https://docs.adgem.com/docs/integrate/offer-delivery/pre-built/web-offerwall), [Postbacks v3](https://docs.adgem.com/docs/integrate/reward-mechanism/postbacks-v3).
- How to apply: create a publisher account, then add an App Property (name, platform, category, store URL if you have one).
- What they require: an active publisher account and an added app. **Offers are not available until the initial integration is done and the app is approved.** Contact your Publisher Support Advocate with questions about approval ([web offerwall](https://docs.adgem.com/docs/integrate/offer-delivery/pre-built/web-offerwall)). Production sites should be HTTPS and have a server postback endpoint. The `player_id` you send must be a stable, unique id for each user (lowercase letters, numbers, hyphens, underscores; max 255 characters).
- How to plug into Goody: in the property’s Postback Options, choose Server Postback and set the URL to `https://goody.day/postback/adgem`. Save the Postback Key (their docs say it is shown only once) as `ADGEM_POSTBACK_KEY`. Goody verifies the v3 `Signature` header as HMAC-SHA256 of the raw JSON body, and also accepts the older v2 `verifier` query style.

## ayeT-Studios (Ayet)

- What it is: offerwall and surveywall. Account docs: [Creating an Account](https://docs.ayetstudios.com/v/product-docs/dashboard-setup/account/creating-an-account). Register: [ayetstudios.com/account/login/register-publisher](https://ayetstudios.com/account/login/register-publisher). Callbacks: [Offerwall Callbacks](https://docs.ayetstudios.com/v/product-docs/callbacks-and-testing/callbacks/offerwall-callbacks), [Publisher API](https://www.ayetstudios.com/openapi/publisher-doc).
- How to apply: open the dashboard, choose Create Account, select Publisher (monetize your apps), say whether you are a business or a person, and fill in name, address, country, and email. You must agree to their Publisher Terms and Privacy Policy.
- What they require: I did not find a separate public “approval checklist” beyond creating the publisher account and a placement. Confirm any extra review steps with Ayet after you sign up.
- Status: publisher account 4096523, placement 26403 `goody_web`, Web Surveywall ad slot 31452 and Web Offerwall ad slot 31454 (700 points per $1), placement under review.
- Goody shows two cards on Offers once `AYET_API_KEY` is set: **Survey picks** (`https://surveys.ayet.io/surveys?adSlot=31452&external_identifier=<Goody public id>`) and **Offer wall** (`https://offerwall.ayet.io/offers?adSlot=31454&externalIdentifier=<Goody public id>`), built by `GET /api/walls/ayet_surveys` and `/api/walls/ayet_offers`.
- Render env: `AYET_API_KEY` = the publisher API key from ayeT dashboard → Settings (the old name `AYET_SECRET` also works). Optional: `AYET_SURVEYWALL_SLOT` (31452), `AYET_OFFERWALL_SLOT` (31454), `AYET_PLACEMENT_ID` (26403, for reference), `AYET_POSTBACK_IPS`.
- Callback URL (Placements / Apps → edit placement 26403 → Callback URL), with Reversal Callbacks on:

  `https://goody.day/postback/ayet?external_identifier={external_identifier}&transaction_id={transaction_id}&payout_usd={payout_usd}&currency_amount={currency_amount}&is_chargeback={is_chargeback}&offer_id={offer_id}&adslot_id={adslot_id}&is_survey={is_survey}`

  Goody checks the `X-Ayetstudios-Security-Hash` header = HMAC-SHA256 of all query parameters sorted by name and URL-encoded (PHP `http_build_query` style, space as `+`; the URLSearchParams style also accepted), keyed with the API key. Missing or wrong header = HTTP 403. Goody credits `{payout_usd}` (publisher USD) at the 70% share, so $1 = 700 points; `{currency_amount}` is only logged. Chargebacks (`is_chargeback=1`, id `r-<original>`, negative amounts) take the points back from the original transaction. Each transaction is credited once; replays get HTTP 200 with `"idempotent": true`.

## Lootably

- What it is: offerwall. Sign up: [dashboard.lootably.com/authentication/signup](https://dashboard.lootably.com/authentication/signup). Docs: [Getting Started](https://documentation.lootably.com/docs/getting-started-1), [Postbacks](https://documentation.lootably.com/docs/postbacks), [Configuring your Placement](https://documentation.lootably.com/docs/configuring-your-placement).
- How to apply: submit website URL, full name, email, and password, then “alert your Lootably contact for approval” ([getting started](https://documentation.lootably.com/docs/getting-started-1)).
- How to plug into Goody: after approval, create a placement and open the postback tab. A working URL looks like:

  `https://goody.day/postback/lootably?userID={userID}&transactionID={transactionID}&ip={ip}&revenue={revenue}&currencyReward={currencyReward}&offerID={offerID}&status={status}&hash={hash}`

  Set `LOOTABLY_POSTBACK_SECRET` to the placement’s Postback Secret. Goody checks `sha256(userID + ip + revenue + currencyReward + secret)` as [their docs](https://documentation.lootably.com/docs/postbacks) describe, and credits `{revenue}` (publisher USD). **Their system only treats a response body of `1` as success.** Goody returns `1` for this partner. Their docs also note that chargeback `status=0` is described but “today, postbacks are only sent with a `1` status.”

## TheoremReach

- What it is: survey (and offer) monetization. Publisher docs hub: [docs.theoremreach.com/publisher](https://docs.theoremreach.com/publisher). Go-live FAQ: [Publisher Go Live Checklist & FAQs](https://info.theoremreach.com/publisher-faqs/).
- How to apply / go live: they review every app before it is set live. Questions: publishers@theoremreach.com. Go-live requests are “generally” answered within 3 business days.
- What they require (from the go-live checklist): a properly working app or website (brand-new properties need extra vetting); a GDPR/CCPA-compliant privacy policy; **active consent** to the privacy policy and terms on the sign-up form (a checkbox the user must click — a line like “by clicking sign up you agree” is not enough, per that FAQ); a clear contact point on those pages; users must create an account to take surveys; a captcha or similar on sign-in / sign-up; and an in-app currency plus the ability to reward users. They also recommend (but do not require) phone or address checks.
- Status: app 26008 created (not live yet), reversals in reward callback turned on.
- Goody shows a **More surveys** card once `THEOREMREACH_SECRET` is set. It opens `https://theoremreach.com/respondent_entry/direct?api_key=<API key>&user_id=<Goody public id>&transaction_id=<new id per open>&hash=<signature>` (built by `GET /api/walls/theoremreach`; the hash is base64url HMAC-SHA1 of the link with the secret key, as their docs describe for signed entry links).
- Render env: `THEOREMREACH_SECRET` = the app's secret key (Publisher dashboard → app details). `THEOREMREACH_API_KEY` is public and defaults to app 26008's key. Optional `THEOREMREACH_CALLBACK_BASE` (default `https://goody.day`), `THEOREMREACH_POSTBACK_IPS`.
- Reward callback URL (app → Reward Callback). TheoremReach appends `hash` itself, plus `reversal=true` / `debug=true` when needed:

  `https://goody.day/postback/theoremreach?user_id={user_id}&tx_id={tx_id}&reward={reward}&currency={reward_amount_in_dollars}`

  Goody checks `hash == base64url(HMAC-SHA1(secret, "https://goody.day" + path and query exactly as received, up to "&hash="))` (also tries PUBLIC_BASE_URL and the request host). Bad or missing hash = HTTP 403. `debug=true` returns 200 and credits nothing. Goody credits the USD amount (`currency` / `reward_amount_in_dollars`) at the 70% share, so $1 = 700 points; set the app exchange rate to 700 so their wall shows the same numbers. `reversal=true` (same `tx_id`, negative amounts) takes the points back. `hash` must stay the last parameter.

## RapidoReach

- Status: app `YqyrVnOaFtt` created (pending approval).
- Goody shows a **Survey hub** card once `RAPIDOREACH_APP_KEY` and `RAPIDOREACH_APP_SECRET` are set. It opens `https://www.rapidoreach.com/ofw/?userId=<uid>` where uid = `<Goody public id>-<App ID>-md5(<Goody public id>-<App ID>-<App Key>)`, built on the server by `GET /api/walls/rapidoreach`.
- Render env: `RAPIDOREACH_APP_KEY` (App Key), `RAPIDOREACH_APP_SECRET` (App Secret, also called Transaction Key), optional `RAPIDOREACH_APP_ID` (default `YqyrVnOaFtt`) and `RAPIDOREACH_POSTBACK_IPS` (their dashboard lists 161.97.78.55, 173.212.227.149, 75.119.139.250, 75.119.139.251).
- Callback URL (Apps → your app → Callback): `https://goody.day/postback/rapidoreach` (RapidoReach appends `transactionId`, `endUserId`, `status`/`cmd`, `amt`, `currencyAmt`, `offerHash`, `txnHash`, …).
- Goody checks `txnHash == md5(transactionId + App Secret)` (required) and `offerHash == md5(transactionId + App Key)` (when sent). Bad hash = HTTP 403. `C` credits `amt` (publisher USD) at the 70% share ($1 = 700 points); `F`/`P` credit only if they carry a payout; `R` takes the points back. Success replies HTTP 200 with body `1`; failures reply non-200.

## Torox

- What it is: offerwall and offer API (formerly related to OfferToro). Register: [torox.io/register](https://torox.io/register/). Guide: [Publisher Integration Guide](https://torox.io/publisher-integration-guide/).
- How to apply: register and choose that you want to monetize an app or website. The guide describes a business onboarding stage (account, agreement, contract) and then an in-dashboard app placement.
- What they require (from the guide): an app or website URL, a currency setup, and a postback URL. Billing later goes through Tipalti. They also describe a go-live step (test, get approval, then switch from staging to production).
- How to plug into Goody: during app placement setup, enter:

  `https://goody.day/postback/torox`

  Set `TOROX_SECRET` to the app placement key. Goody checks `md5(oid + "-" + user_id + "-" + key)` as the guide describes. **They expect a plain `1` on success and `0` on failure.** Goody returns that. They say postbacks come from IP `44.212.211.226` and that you may whitelist it. Reversal postbacks are off by default; if you turn them on, they use a **new** conversion id and a negative payout — Goody will record a rejected row, but it will not automatically tie that row to the original credit. Plan for that before you enable reversals.

## Demo partner (local only)

Goody ships with a fake offer catalog and signed demo postbacks so you can try the full path on your machine. It is **off unless** you set `DEMO_PARTNER=1`. Do not set that on the live Render service: practice offers would let anyone earn points that can be cashed out as real gift cards. Daily check-in and goal bonuses also go through this partner, so they stay off when it is off. The CPX Research survey wall (and any other real partner you enable) still works with the demo partner off.

## After you are approved

1. Set the postback URL and secret on Render (never in git).
2. Set `PUBLIC_BASE_URL=https://goody.day` so URL-based signatures (BitLabs) hash the same host the partner calls. If a BitLabs callback still points at the old `goody-dfi5.onrender.com` host, switch it to `goody.day`, or its signature will not match.
3. Use each partner’s test / sandbox postback tool first.
4. Watch the ledger in `/admin` and confirm a test user is paid, then reversed, correctly.
5. Turn off any partner “test mode” before real users arrive.
