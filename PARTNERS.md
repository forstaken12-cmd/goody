# Partner guide

This is a plain-English guide to offerwall and survey partners you can apply to, what they tend to ask for, and how to plug each one into Goody. I only list facts I checked on their public pages in November 2026. Where I could not confirm a signature or a requirement, it is marked as a TODO.

Goody’s live postback path is always:

```
https://goody-dfi5.onrender.com/postback/<partner>
```

Replace `<partner>` with `bitlabs`, `cpx`, `adgem`, `ayet`, `torox`, `lootably`, or `theoremreach`. Put that URL (plus any macros the partner asks for) in their dashboard. Then set the matching secret on the Render service. Do not put secrets in this repo.

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
- How to plug into Goody: in the publisher dashboard, under Apps → your app → Integration → Reward Callback, set the host to `https://goody-dfi5.onrender.com` and the path to `/postback/bitlabs`. Include at least `UID`, `TX`, `VAL`, and `RAW`, and `TYPE` if you use surveys ([callback docs](https://developer.bitlabs.ai/docs/general-reward-callbacks), [parameter list](https://bitlabs.ai/integrations/server-to-server-callback)). Set `BITLABS_SECRET` to the app secret. Goody verifies the HMAC-SHA1 of the full callback URL, excluding `&hash=`, as their docs describe.
- TODO: confirm the official reversal / reconciliation `TYPE` value with BitLabs before launch.

## CPX Research

- What it is: survey wall run by Make Opinion GmbH. Publisher sign-up: [publisher.cpx-research.com](https://publisher.cpx-research.com/index.php?advertiser_id=42&page=register). Integration notes: [cpx-research.com/main/en/doc.php](https://cpx-research.com/main/en/doc.php). Terms: [publisher terms](https://cpx-research.com/main/en/terms.php).
- How to apply: use the publisher sign-up, not the consumer survey site. The sign-up page says this is for mobile and web business owners only.
- What they require (from the sign-up form I reviewed): you should own a live public app or website with users, or be developing one and tell them about the project. You confirm you will put fraud prevention in place before launch (they list options such as email or phone verification, VPN detection, device fingerprinting, manual payout review, and rate limits).
- How to plug into Goody: in the Postback Settings tab, set the postback URL to `https://goody-dfi5.onrender.com/postback/cpx` with the parameters from your dashboard (`user_id`, `trans_id`, `amount_usd`, `status`, `secure_hash`). Set `CPX_SECURE_HASH` to the app secure hash. Goody checks `md5(trans_id + "-" + secret)` and treats `status=2` as a cancel / reversal, following publisher examples. Re-check the live dashboard docs at launch.

## AdGem

- What it is: offerwall for web and apps. Docs: [Quickstart](https://docs.adgem.com/docs/get-started/quickstart), [Web Offerwall](https://docs.adgem.com/docs/integrate/offer-delivery/pre-built/web-offerwall), [Postbacks v3](https://docs.adgem.com/docs/integrate/reward-mechanism/postbacks-v3).
- How to apply: create a publisher account, then add an App Property (name, platform, category, store URL if you have one).
- What they require: an active publisher account and an added app. **Offers are not available until the initial integration is done and the app is approved.** Contact your Publisher Support Advocate with questions about approval ([web offerwall](https://docs.adgem.com/docs/integrate/offer-delivery/pre-built/web-offerwall)). Production sites should be HTTPS and have a server postback endpoint. The `player_id` you send must be a stable, unique id for each user (lowercase letters, numbers, hyphens, underscores; max 255 characters).
- How to plug into Goody: in the property’s Postback Options, choose Server Postback and set the URL to `https://goody-dfi5.onrender.com/postback/adgem`. Save the Postback Key (their docs say it is shown only once) as `ADGEM_POSTBACK_KEY`. Goody verifies the v3 `Signature` header as HMAC-SHA256 of the raw JSON body, and also accepts the older v2 `verifier` query style.

## ayeT-Studios (Ayet)

- What it is: offerwall and surveywall. Account docs: [Creating an Account](https://docs.ayetstudios.com/v/product-docs/dashboard-setup/account/creating-an-account). Register: [ayetstudios.com/account/login/register-publisher](https://ayetstudios.com/account/login/register-publisher). Callbacks: [Offerwall Callbacks](https://docs.ayetstudios.com/v/product-docs/callbacks-and-testing/callbacks/offerwall-callbacks), [Publisher API](https://www.ayetstudios.com/openapi/publisher-doc).
- How to apply: open the dashboard, choose Create Account, select Publisher (monetize your apps), say whether you are a business or a person, and fill in name, address, country, and email. You must agree to their Publisher Terms and Privacy Policy.
- What they require: I did not find a separate public “approval checklist” beyond creating the publisher account and a placement. Confirm any extra review steps with Ayet after you sign up.
- How to plug into Goody: under Placements / Apps, set the Callback URL to something like:

  `https://goody-dfi5.onrender.com/postback/ayet?uid={external_identifier}&txid={transaction_id}&payout={payout_usd}&status={callback_type}`

  Your server must reply with HTTP 200 or they will retry up to 12 times in an hour. Enable reversal callbacks in the placement if you want chargebacks (`callback_type=chargeback`, `is_chargeback=1`, `transaction_id` prefixed with `r-`, negative amounts — from their publisher API docs).
- **TODO:** I did not find an official signature / hash scheme on the public callback pages I checked. Goody’s `ayet` entry still uses a generic HMAC placeholder. Do not turn this on in production until Ayet confirms how to verify a postback. Set `AYET_SECRET` only after that is known, and update `server/config.js` / `server/lib/postback.js` to match.

## Lootably

- What it is: offerwall. Sign up: [dashboard.lootably.com/authentication/signup](https://dashboard.lootably.com/authentication/signup). Docs: [Getting Started](https://documentation.lootably.com/docs/getting-started-1), [Postbacks](https://documentation.lootably.com/docs/postbacks), [Configuring your Placement](https://documentation.lootably.com/docs/configuring-your-placement).
- How to apply: submit website URL, full name, email, and password, then “alert your Lootably contact for approval” ([getting started](https://documentation.lootably.com/docs/getting-started-1)).
- How to plug into Goody: after approval, create a placement and open the postback tab. A working URL looks like:

  `https://goody-dfi5.onrender.com/postback/lootably?userID={userID}&transactionID={transactionID}&ip={ip}&revenue={revenue}&currencyReward={currencyReward}&offerID={offerID}&status={status}&hash={hash}`

  Set `LOOTABLY_POSTBACK_SECRET` to the placement’s Postback Secret. Goody checks `sha256(userID + ip + revenue + currencyReward + secret)` as [their docs](https://documentation.lootably.com/docs/postbacks) describe, and credits `{revenue}` (publisher USD). **Their system only treats a response body of `1` as success.** Goody returns `1` for this partner. Their docs also note that chargeback `status=0` is described but “today, postbacks are only sent with a `1` status.”

## TheoremReach

- What it is: survey (and offer) monetization. Publisher docs hub: [docs.theoremreach.com/publisher](https://docs.theoremreach.com/publisher). Go-live FAQ: [Publisher Go Live Checklist & FAQs](https://info.theoremreach.com/publisher-faqs/).
- How to apply / go live: they review every app before it is set live. Questions: publishers@theoremreach.com. Go-live requests are “generally” answered within 3 business days.
- What they require (from the go-live checklist): a properly working app or website (brand-new properties need extra vetting); a GDPR/CCPA-compliant privacy policy; **active consent** to the privacy policy and terms on the sign-up form (a checkbox the user must click — a line like “by clicking sign up you agree” is not enough, per that FAQ); a clear contact point on those pages; users must create an account to take surveys; a captcha or similar on sign-in / sign-up; and an in-app currency plus the ability to reward users. They also recommend (but do not require) phone or address checks.
- How to plug into Goody: they have an Offerwall Integration Guide that covers entry URLs, callback configuration, and HMAC security ([publisher docs](https://docs.theoremreach.com/publisher)). Their FAQ says reward callbacks do **not** include reversals; reversals and bans go through an Event Webhook described at [theoremreach.com/docs/reporting](https://theoremreach.com/docs/reporting).
- **TODO:** I could not open a public page that listed the exact callback parameter names or the HMAC formula. Goody’s `theoremreach` entry is a placeholder. Confirm the official callback URL, parameters, and signature in your publisher dashboard, then update the handler before enabling `THEOREMREACH_SECRET`. Planned URL shape: `https://goody-dfi5.onrender.com/postback/theoremreach`.

## Torox

- What it is: offerwall and offer API (formerly related to OfferToro). Register: [torox.io/register](https://torox.io/register/). Guide: [Publisher Integration Guide](https://torox.io/publisher-integration-guide/).
- How to apply: register and choose that you want to monetize an app or website. The guide describes a business onboarding stage (account, agreement, contract) and then an in-dashboard app placement.
- What they require (from the guide): an app or website URL, a currency setup, and a postback URL. Billing later goes through Tipalti. They also describe a go-live step (test, get approval, then switch from staging to production).
- How to plug into Goody: during app placement setup, enter:

  `https://goody-dfi5.onrender.com/postback/torox`

  Set `TOROX_SECRET` to the app placement key. Goody checks `md5(oid + "-" + user_id + "-" + key)` as the guide describes. **They expect a plain `1` on success and `0` on failure.** Goody returns that. They say postbacks come from IP `44.212.211.226` and that you may whitelist it. Reversal postbacks are off by default; if you turn them on, they use a **new** conversion id and a negative payout — Goody will record a rejected row, but it will not automatically tie that row to the original credit. Plan for that before you enable reversals.

## After you are approved

1. Set the postback URL and secret on Render (never in git).
2. Set `PUBLIC_BASE_URL=https://goody-dfi5.onrender.com` so URL-based signatures (BitLabs) hash the same host the partner calls.
3. Use each partner’s test / sandbox postback tool first.
4. Watch the ledger in `/admin` and confirm a test user is paid, then reversed, correctly.
5. Turn off any partner “test mode” before real users arrive.
