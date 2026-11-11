# Set up Google and Apple sign-in for Goody

This is a plain walkthrough so you can turn on **Continue with Google** and **Continue with Apple** on the live site.

The live site is `https://goody-dfi5.onrender.com`. Redirect URLs must match **exactly** (scheme, host, and path — no trailing slash).

Until these keys are set on Render, the buttons still appear but stay disabled and say **Coming soon**. The site will not break.

Do not put real keys in git. Add them in the Render Dashboard: your service → Environment → Add Environment Variable. After you save them, trigger a deploy (or wait for the next one) so the new values load.

Also set (or confirm):

```
PUBLIC_BASE_URL=https://goody-dfi5.onrender.com
```

The app uses this to build the redirect URLs it sends to Google and Apple. If it is wrong, sign-in will fail.

---

## 1. Google (free Google Cloud account)

You need a Google account. A paid Google Cloud billing account is not required just to create an OAuth client for sign-in, but Google may later ask you to verify the app if a lot of people use it.

### A. Create or pick a project

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. At the top, create a project (for example, “Goody”) or select one you already have.

### B. Fill in the OAuth consent screen

1. Go to **APIs & Services** → **OAuth consent screen**, or open [Google Auth Platform](https://console.cloud.google.com/auth/overview).
2. If you are prompted to register the app, do that. Choose **External** if you want anyone with a Google account to sign in.
3. App name: `Goody`.
4. User support email and developer contact email: your email.
5. App domain (optional for testing): `goody-dfi5.onrender.com`.
6. Authorized domain: `onrender.com` (Google often wants the root authorized domain).
7. Scopes: keep the default user info scopes (`openid`, `email`, `profile`). You do not need other Google APIs for sign-in.
8. Save. While the app is in **Testing**, only people you add as test users can sign in. Publish the app (or add testers) when you are ready for everyone.

Official guide: [Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server).

### C. Create a Web application client

1. Open **Google Auth Platform** → **Clients** (or **APIs & Services** → **Credentials**).
2. Click **Create Client**.
3. Application type: **Web application**.
4. Name: `Goody web`.
5. Authorized JavaScript origins (optional for this server flow, but harmless):
   - `https://goody-dfi5.onrender.com`
   - `http://localhost:3000` (local testing)
6. Authorized redirect URIs — add **both**:
   - `https://goody-dfi5.onrender.com/api/auth/google/callback`
   - `http://localhost:3000/api/auth/google/callback`
7. Click **Create**.
8. Copy the **Client ID** and **Client secret**.

### D. Put the values on Render

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
PUBLIC_BASE_URL=https://goody-dfi5.onrender.com
```

After a restart, **Continue with Google** becomes a live button. The “Coming soon” label on that button goes away.

---

## 2. Apple (paid Apple Developer account required)

**Sign in with Apple requires a paid Apple Developer Program membership.** As of this writing, enrollment is **$99 USD per year** (or the local equivalent in some regions). Confirm the current fee and terms here:

- [Apple Developer Program](https://developer.apple.com/programs/)
- [Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment/)

A free Apple ID is not enough. You cannot create a Services ID or a Sign in with Apple key without the paid membership.

### A. Enroll

1. Sign in at [developer.apple.com](https://developer.apple.com/) and enroll in the program if you have not already.
2. After you are enrolled, note your **Team ID**. It is a 10-character code on [Account → Membership details](https://developer.apple.com/account). That is `APPLE_TEAM_ID`.

### B. Create an App ID (if you do not have one)

Sign in with Apple for the web is tied to an App ID.

1. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list), go to **Identifiers**.
2. Click **+** and choose **App IDs**.
3. Type: **App**.
4. Description: `Goody`. Bundle ID: something you own, for example `com.yourname.goody`.
5. In **Capabilities**, enable **Sign In with Apple**. Save.

Official help: [Configure Sign in with Apple for the web](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/).

### C. Create a Services ID (this is your Apple client ID)

1. Identifiers → **+** → **Services IDs**.
2. Description: `Goody web`. Identifier: for example `com.yourname.goody.web`. This exact string is `APPLE_CLIENT_ID`.
3. Enable **Sign In with Apple** and click **Configure**.
4. Primary App ID: the App ID from step B.
5. Domains and Subdomains:
   - `goody-dfi5.onrender.com`
6. Return URLs — this must match **exactly**:
   - `https://goody-dfi5.onrender.com/api/auth/apple/callback`
7. If you also test locally, add `http://localhost:3000/api/auth/apple/callback` only if Apple will accept a localhost return URL on your account. Live sign-in uses the `https` URL above.
8. Save, then **Continue** and **Register**.

Apple may ask you to **verify the domain**. If they give you a verification file, you can either:

- paste the file contents into a Render env var named `APPLE_DOMAIN_ASSOCIATION` (the app will serve it at `https://goody-dfi5.onrender.com/.well-known/apple-developer-domain-association.txt`), or
- put the file in `public/.well-known/apple-developer-domain-association.txt` and deploy (do not commit if you would rather keep it out of git).

Then click **Verify** in Apple’s form.

### D. Create a Sign in with Apple private key

1. In Certificates, Identifiers & Profiles, go to **Keys**.
2. Click **+**. Name the key, for example `Goody Sign in with Apple`.
3. Enable **Sign In with Apple**, click **Configure**, and choose your primary App ID.
4. Register the key. **Download the `.p8` file immediately.** Apple will not let you download it again.
5. Note the **Key ID** (10 characters). That is `APPLE_KEY_ID`.

The `.p8` file looks like this (the middle lines are the secret):

```
-----BEGIN PRIVATE KEY-----
....
-----END PRIVATE KEY-----
```

### E. Put the values on Render

```
APPLE_CLIENT_ID=com.yourname.goody.web
APPLE_TEAM_ID=AB12CD34EF
APPLE_KEY_ID=XY98ZW76VU
APPLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n....\n-----END PRIVATE KEY-----
PUBLIC_BASE_URL=https://goody-dfi5.onrender.com
```

Render env vars are one line, so put the private key on a single line and write `\n` where each line break belongs. The app turns those `\n` sequences back into real line breaks. You can also paste a multi-line value if the dashboard lets you.

After a restart, **Continue with Apple** becomes a live button.

---

## 3. How accounts are linked

- If someone already has a Goody account with the same **verified** email, Google or Apple sign-in is attached to that account. They keep their points.
- A brand-new person who uses Google or Apple still has to tick **I am 18 or older** and **I agree to the Terms and Privacy Policy** before the button will start.
- Apple may hide the person’s email after the first sign-in, or use a private relay address. We store Apple’s stable user id, so they can still sign in later. Cash out still requires a confirmed email, so a person who never shares an email will need a way to add one later.
- Password sign-in still works for accounts that have a password.

---

## 4. Local testing

Copy `.env.example` to `.env` and fill in the same kinds of values. Keep:

```
PUBLIC_BASE_URL=http://localhost:3000
```

and add the localhost redirect URLs in Google (and Apple, if allowed). Then `npm start` and open `http://localhost:3000`.

---

## Redirect URLs (copy/paste)

| Provider | Redirect URL |
| --- | --- |
| Google, live | `https://goody-dfi5.onrender.com/api/auth/google/callback` |
| Google, local | `http://localhost:3000/api/auth/google/callback` |
| Apple, live | `https://goody-dfi5.onrender.com/api/auth/apple/callback` |
| Apple, local (if you add it) | `http://localhost:3000/api/auth/apple/callback` |
