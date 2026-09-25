# Stellar AI — Gmail Add-on Deployment Guide

## What's in this package

```
worker-src/
  index.js            ← replaces src/index.js (adds /email route; comment updated)
  revenium.js          ← unmodified — already has productName override + AI_PRICING KV
  wrangler.toml         ← unmodified — already has ADDON_SHARED_SECRET Secrets Store block
  routes/
    email.js            ← replaces src/routes/email.js — adds summarize/explain/digest/
                           explain_sender actions on top of write/rewrite/improve

gmail-addon/
  Code.gs               ← full add-on: compose toolbar + open-email card + homepage
  appsscript.json        ← manifest: adds homepage + contextual triggers, gmail.readonly scope
```

## What's new since the last build

Three surfaces now, not one:

1. **Compose toolbar** (unchanged) — Write / Rewrite / Improve.
2. **Reading an email** (new) — a Stellar AI card appears while an email is open, with
   Summarize / Explain buttons. Fully automatic — no pasting, unlike compose.
3. **Add-on homepage** (new) — click the ✨ icon in Gmail's right-hand rail with no email
   open:
   - Paste-box: Summarize/Explain any pasted text (no new permission)
   - Inbox digest: one AI call, one-line take on your last 5 inbox emails
   - "Who is this?": AI context on a sender, built from their last 5 emails with you
   - Quick stats: unread / stale-unread (>1 day) / starred counts — no AI call at all

### ⚠️ Permission change you should know about before deploying

Surfaces 2 and 3's digest/sender-lookup/stats features need `gmail.readonly` — a real,
broad "read your entire mailbox" scope, well beyond what compose/open-email reading
needed. When you (or anyone) authorizes this add-on, Google's consent screen will show
this scope by name. This is unavoidable for those specific features — Apps Script's
`GmailApp.getInboxThreads()` / `GmailApp.search()` require it.

**If you'd rather not grant that scope:** open `gmail-addon/Code.gs`, and in
`buildHomepageCard()` remove the calls to `buildDigestSection_()`, `buildSenderSection_()`,
and `buildStatsSection_()` — the paste-box section still works fine alone. Then remove
`gmail.readonly` from `appsscript.json`'s `oauthScopes`. Everything else in this package
is unaffected either way.

---

## Part 1 — Cloudflare Worker

### 1.1 Copy files into your repo

- Copy `worker-src/index.js` over your existing `src/index.js`
- Copy `worker-src/routes/email.js` over your existing `src/routes/email.js`
- `worker-src/revenium.js` and `worker-src/wrangler.toml` are included for reference only
  — they match what's already in your repo, no changes needed there.

### 1.2 Set the Gmail Add-on shared secret (Cloudflare Secrets Store)

This is the only secret the add-on needs, separate from your existing `REVENIUM_API_KEY`.
It authenticates Apps Script → your Worker, since your Worker's usual CORS-based
protection doesn't apply to server-to-server calls. It uses the same Cloudflare Secrets
Store mechanism as `REVENIUM_API_KEY` (account-level store, accessed via
`env.ADDON_SHARED_SECRET.get()` — not a plain `wrangler secret`).

```bash
# Generate a strong random secret and keep it somewhere safe — you'll paste it
# into Apps Script in Part 2.
openssl rand -hex 32

# If you don't already have a Secrets Store, create one first (skip if you
# already set up REVENIUM_API_KEY this way):
wrangler secrets-store store create default --remote

# Find your store ID if you need it:
wrangler secrets-store store list --remote

# Create the secret in that store:
wrangler secrets-store secret create <STORE_ID> \
  --name ADDON_SHARED_SECRET --scopes workers --remote
# paste the generated value when prompted
```

`wrangler.toml`'s `[[secrets_store_secrets]]` block for `ADDON_SHARED_SECRET` is already
in your repo — just confirm its `store_id` matches the store you created above.

### 1.3 Deploy

```bash
wrangler deploy
```

### 1.4 Verify the new actions work

```bash
curl -s -X POST https://sgs-ai-widget.workwithprasadbhavsar.workers.dev/email \
  -H "Content-Type: application/json" \
  -H "X-Stellar-Addon-Key: <the secret you generated>" \
  -d '{"action":"summarize","draftText":"Subject: Q3 delivery delay\n\nHi, we need to push the shipment back two weeks due to a supplier issue. Let us know if that works."}'
```

Expected: `{"body": "..."}` with a short summary. Repeat with `"action":"explain"` and the
same `draftText`, and with `"action":"digest"` / `"action":"explain_sender"` using an
`items` array instead of `draftText` (see `email.js` for the exact shape each action expects).

---

## Part 2 — Gmail Add-on (Google Apps Script)

### 2.1 Update the Apps Script project

1. Go to [script.google.com](https://script.google.com) and open your existing "Stellar AI
   Gmail Add-on" project (or create a new one if starting fresh — see the earlier version
   of this guide for that flow).
2. Replace `Code.gs`'s content with the `Code.gs` from this package.
3. Replace `appsscript.json`'s content with the `appsscript.json` from this package.

If `STELLAR_WORKER_URL` / `STELLAR_ADDON_KEY` are already set in Script Properties from a
previous deploy, you can skip `setup_ONETIME()` — those values carry over.

### 2.2 Re-authorize (required — new scopes were added)

Because `appsscript.json` now requests `gmail.addons.current.message.readonly` and
`gmail.readonly` in addition to the original scopes, Google will require the add-on to be
re-authorized:

1. **Deploy → Test deployments → Install** again.
2. Open Gmail. If prompted to review new permissions, read through them (this is where
   you'll see the `gmail.readonly` consent line) and accept.
3. If Gmail doesn't prompt automatically, go to your Google Account's
   [connected apps page](https://myaccount.google.com/connections), find this add-on,
   remove access, then reinstall from Test deployments to force a fresh consent screen.

### 2.3 Test each surface

- **Compose:** unchanged from before — Write / Rewrite / Improve.
- **Open an email → ✨ Stellar AI card appears** → try Summarize and Explain.
- **Click the ✨ icon in the right-hand rail with no email open** (this is the "homepage"):
  - Paste any text into the top box → try Summarize / Explain
  - Click "Digest my last 5 emails"
  - Type a sender's email into "Who is this?" → click Explain this sender
  - Click "Show quick stats"

### 2.4 Roll out to your organization

Same as before — Google Admin console domain-wide install, or a public Marketplace
listing if this needs to be installed outside your org. See the earlier version of this
guide for details; nothing about rollout mechanics changed.

---

## Part 3 — Confirm Revenium is tracking correctly

All `/email` actions (compose + open-email + homepage) report under the same
`stellar-ai-gmail` product — check your Revenium dashboard after a few test calls across
different actions (write, summarize, digest, etc.) to confirm they're all landing there,
separate from `stellar-ai-widget`.

---

## Notes / known limitations

- **Compose Rewrite/Improve still require pasting the draft.** This is a genuine Gmail
  platform limitation (compose-trigger events don't expose draft body) — does not apply
  to the new open-email or homepage features, which read real content automatically.
- **Digest is capped at 5 emails** and **sender lookup at 5 messages** per call, to keep
  a single click's latency/cost bounded. Change `DIGEST_THREAD_COUNT` in `Code.gs` if you
  want more (Worker's `items` field is capped at 15 server-side regardless).
- **Quick stats are heuristic, not AI-generated** — "stale unread" is a simple
  `older_than:1d` search, not a judgment call about importance.
- **Model:** `@cf/openai/gpt-oss-20b` for all actions, `max_tokens: 4096`.
- **Result display:** open-email and homepage results show in a read-only card (nothing
  to write into, unlike compose) — the user copies what they need manually.