# LinkedIn Credentials Setup — Step by Step

This guide explains how to get the LinkedIn credentials needed for LinkedIn Posting Studio.

You need two main values:

```env
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
```

You also need to configure the correct redirect URL:

```env
LINKEDIN_REDIRECT_URI=https://your-domain.com/auth/linkedin/callback
```

---

## 1. Open LinkedIn Developer Portal

Go to:

```text
https://www.linkedin.com/developers/
```

Sign in with your LinkedIn account.

---

## 2. Create a LinkedIn App

1. Click **Create app**.
2. Fill in:
   - App name
   - LinkedIn Page/company
   - Privacy policy URL
   - App logo
3. Submit the app.

If LinkedIn requires a company/page, use your own LinkedIn company page.

---

## 3. Add Required Products

Open your app in LinkedIn Developer Portal.

Go to the **Products** tab.

For personal profile posting, add/request:

```text
Share on LinkedIn
```

For sign-in, add/request:

```text
Sign In with LinkedIn using OpenID Connect
```

For future company/page posting, request later:

```text
Community Management API
```

Important:

- `Share on LinkedIn` gives access to personal-profile posting using `w_member_social`.
- Company/page posting needs different scopes like `w_organization_social`, which may require approval.

---

## 4. Check OAuth Scopes

Go to the **Auth** tab.

You should see scopes similar to:

```text
openid
profile
email
w_member_social
```

Required for this app:

```text
openid profile email w_member_social
```

Meaning:

| Scope | Purpose |
|---|---|
| `openid` | LinkedIn sign-in identity |
| `profile` | Read basic profile info |
| `email` | Read account email |
| `w_member_social` | Post to personal LinkedIn profile |

If `w_member_social` is missing, make sure **Share on LinkedIn** is added/approved.

---

## 5. Set Redirect URL

In the **Auth** tab, find **Authorized redirect URLs**.

Add your app callback URL.

For local development:

```text
http://localhost:3000/auth/linkedin/callback
```

For VPS/domain/tunnel:

```text
https://your-domain.com/auth/linkedin/callback
```

Example with Cloudflare tunnel:

```text
https://example-name.trycloudflare.com/auth/linkedin/callback
```

Important rules:

- Must match exactly.
- Same `http` or `https`.
- Same domain.
- Same path.
- No extra trailing slash unless your `.env` also has it.

If it does not match exactly, LinkedIn OAuth will fail.

---

## 6. Copy Client ID and Client Secret

In LinkedIn Developer Portal → your app → **Auth** tab:

Copy:

```text
Client ID
Client Secret
```

Do not share the Client Secret publicly.

Do not commit it to GitHub.

---

## 7. Add Credentials to `.env`

In the project, copy the example env file:

```bash
cp .env.example .env
```

Edit `.env`:

```env
LINKEDIN_CLIENT_ID=your_real_client_id
LINKEDIN_CLIENT_SECRET=your_real_client_secret
LINKEDIN_REDIRECT_URI=https://your-domain.com/auth/linkedin/callback
LINKEDIN_SCOPES=openid profile email w_member_social
```

If you cannot edit `.env` directly, put values in `secrets.txt` like this:

```text
client id: YOUR_CLIENT_ID
client secret: YOUR_CLIENT_SECRET
```

Then copy those values into `.env` on the server.

---

## 8. Start the App

Run:

```bash
npm start
```

Open your app URL.

Click:

```text
Continue with LinkedIn
```

LinkedIn will show the consent screen.

Approve permissions.

The app will save your OAuth token in runtime storage.

---

## 9. Confirm It Worked

After successful login, the dashboard should show:

```text
Connected: <your LinkedIn name>
```

The token is saved locally under runtime data, for example:

```text
data/tokens/<linkedin_user_id>.json
```

This file is ignored by Git and should not be committed.

---

## 10. Common Errors

### `redirect_uri does not match`

Cause:

- Redirect URL in LinkedIn Developer Portal is different from `.env`.

Fix:

- Copy the exact `.env` value into LinkedIn Developer Portal.

---

### `invalid_client`

Cause:

- Client ID or Client Secret is wrong.
- Secret was regenerated.
- Secret was copied with extra/missing characters.

Fix:

- Copy Client ID/Secret again from LinkedIn Developer Portal.
- Update `.env`.
- Restart the app.

---

### Missing `w_member_social`

Cause:

- `Share on LinkedIn` product not added/approved.
- OAuth scopes in `.env` do not include `w_member_social`.

Fix:

```env
LINKEDIN_SCOPES=openid profile email w_member_social
```

Then reconnect LinkedIn.

---

### Token expired/revoked

Cause:

- LinkedIn token expired or was revoked.

Fix:

- Click **Continue with LinkedIn** again.
- Approve permissions again.

---

## 11. GitHub Safety

Make sure these files are ignored:

```gitignore
.env
secrets.txt
tunnel-access.txt
/data/*
/uploads/*
```

Only commit:

```text
.env.example
source code
docs
README
```

Never commit:

```text
Client Secret
OAuth tokens
Discord bot token
uploaded media
runtime posts.json
```

---

## 12. Quick Checklist

Before using the app:

- [ ] LinkedIn app created
- [ ] `Share on LinkedIn` added
- [ ] `Sign In with LinkedIn using OpenID Connect` added
- [ ] `w_member_social` scope visible
- [ ] Redirect URL added exactly
- [ ] Client ID copied into `.env`
- [ ] Client Secret copied into `.env`
- [ ] `LINKEDIN_SCOPES` includes `w_member_social`
- [ ] App restarted
- [ ] LinkedIn sign-in works
- [ ] Dashboard shows connected status

---

## Final Summary

To use LinkedIn Posting Studio, create a LinkedIn Developer App, enable `Share on LinkedIn` and OpenID sign-in, copy the Client ID/Secret into `.env`, set the exact redirect URL, and sign in through the app. Once connected, the app can create, schedule, and publish posts using LinkedIn’s official API.
