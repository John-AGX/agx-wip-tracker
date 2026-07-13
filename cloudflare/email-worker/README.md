# Project 86 — Cloudflare Email Worker (inbound dropbox)

Free inbound-email path for the assistant's Email Dropbox. Cloudflare
Email Routing receives redirected/forwarded mail on `project86.net` and
runs this Worker, which parses the full MIME and POSTs clean JSON to the
app (`/api/email-inbox/inbound-cf`). No Resend Pro, no metadata-only
webhook — the Worker holds the entire message.

## One-time setup

Prereqs: `project86.net` is already on Cloudflare (it is), and you're
logged into `wrangler` (`npx wrangler login`).

1. **Pick the shared secret** (any long random string). Use the SAME
   value in two places — the Worker and the app:
   ```bash
   # generate one
   openssl rand -hex 32
   ```

2. **Deploy the Worker** (from this directory):
   ```bash
   npm install
   npx wrangler secret put P86_INBOUND_SECRET   # paste the secret from step 1
   npm run deploy
   ```

3. **App env (Railway)** — set both, then redeploy the app:
   - `INBOUND_CF_SECRET` = the same secret from step 1
   - `INBOUND_EMAIL_DOMAIN` = `project86.net`

4. **Enable Cloudflare Email Routing** (Cloudflare dashboard →
   `project86.net` → Email → Email Routing):
   - Turn Email Routing ON (it adds the MX + SPF records automatically).
   - Under **Routing rules → Catch-all address**, set the action to
     **Send to a Worker** → `p86-email-inbound`. (A catch-all is simplest
     since `project86.net` carries no other mail; every `*@project86.net`
     address routes to the Worker, and the app matches the dropbox key.)

5. **Forward your mail in** — in the app, My Account → Email Dropbox
   shows your address (`<key>@project86.net`). In Outlook: Rules → new
   rule → *Apply to all messages* → **Redirect to** that address.
   Redirect preserves the real sender + threading and leaves your inbox
   untouched/unread.

## Test

Email yourself (or have someone email a client address you forward), or
send straight to your `<key>@project86.net` address. Within seconds it
should appear in the app's **Email** tab. If nothing arrives, check the
Worker logs: `npx wrangler tail`.

## How failures behave

On a transient app error the Worker throws, so Cloudflare tells the
sending server the delivery failed and it retries — mail is never
silently dropped. A persistent misconfig (wrong secret, app down) shows
up as delayed bounces to the redirecting mailbox, which is visible.
