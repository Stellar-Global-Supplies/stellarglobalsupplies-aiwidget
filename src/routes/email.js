/**
 * Gmail Add-on endpoint — write / rewrite / improve an email.
 *
 * Reuses the SAME Workers AI binding, model, and Revenium metering as
 * /chat. No separate AI backend, no new API keys shipped to the client.
 *
 * Auth: this Worker is otherwise intentionally unauthenticated (embedded
 * on internal, staff-only pages, protected only by CORS origin). That
 * protection does NOT apply here — Apps Script calls this endpoint
 * server-to-server from Google's infrastructure, with no Origin header
 * for CORS to check. So /email is gated by a separate shared-secret
 * header instead. The secret lives only in:
 *   - Cloudflare Secrets Store (ADDON_SHARED_SECRET binding — same
 *     account-level store pattern as REVENIUM_API_KEY, resolved via
 *     env.ADDON_SHARED_SECRET.get())
 *   - the Apps Script project's Script Properties (server-side, never
 *     rendered into the add-on's UI/HTML, never visible to the Gmail user)
 * It is never sent to, or readable from, the Gmail client itself.
 */

import { jsonResponse } from "../cors.js";
import { reportUsage } from "../revenium.js";

// gpt-oss-20b: OpenAI's smaller open-weight reasoning model on Workers AI.
// Same `messages` + `max_tokens` interface as chat.js's llama-4-scout, so
// this is a drop-in swap — no other code here changes. Better reasoning/
// instruction-following than scout, cheaper and faster than gpt-oss-120b.
// $0.20/$0.30 per 1M input/output tokens (Workers AI pricing) vs.
// gpt-oss-120b's $0.35/$0.75.
const MODEL = "@cf/openai/gpt-oss-20b";

const MAX_INPUT_CHARS = 12000; // guard against pasting an entire thread

const SYSTEM_PROMPTS = {
  write: `
You are an email-writing assistant embedded in Gmail via a "Stellar AI" add-on.
The user gives you a short instruction describing an email they want. Write a
complete, ready-to-send email body based on it.

Rules:
- Output the email BODY only — no subject line, no "Subject:" prefix, no
  markdown code fences, no commentary before or after.
- Match a professional-but-natural tone unless the user's instruction implies
  otherwise (e.g. "casual note to a friend").
- Do not invent specific facts (dates, prices, names) the user didn't give you
  — use reasonable placeholders like [date] or [amount] instead.
- Keep it as concise as the content allows; don't pad with filler.
`.trim(),

  rewrite: `
You are an email-rewriting assistant embedded in Gmail via a "Stellar AI" add-on.
The user pastes their current draft. Rewrite it as a clearer, better-structured
version that preserves the same core message and intent, but you may change
wording, structure, and tone freely to improve it.

Rules:
- Output the rewritten email BODY only — no subject line, no commentary, no
  markdown code fences.
- Preserve any concrete facts already in the draft (names, dates, numbers) —
  do not invent or drop them.
- If the draft is empty or nonsensical, say so plainly in one short sentence
  instead of fabricating an email.
`.trim(),

  improve: `
You are an email-editing assistant embedded in Gmail via a "Stellar AI" add-on.
The user pastes their current draft. Make light-touch improvements: fix
grammar, tighten wording, smooth tone — WITHOUT restructuring the email or
changing its meaning, length, or intent significantly.

Rules:
- Output the improved email BODY only — no subject line, no commentary, no
  markdown code fences.
- Stay close to the original phrasing where it already works; this is a polish
  pass, not a rewrite.
- If the draft is empty or nonsensical, say so plainly in one short sentence
  instead of fabricating an email.
`.trim(),
};

// Resolves the add-on's shared secret. Supports both a Secrets Store
// binding (env.ADDON_SHARED_SECRET.get(), same pattern as REVENIUM_API_KEY
// in revenium.js) and a plain `wrangler secret` string, so this works
// however you choose to store it.
async function getAddonSharedSecret(env) {
  const binding = env.ADDON_SHARED_SECRET;

  if (!binding) return null;

  if (typeof binding === "string") {
    return binding.trim();
  }

  if (typeof binding.get === "function") {
    try {
      const value = await binding.get();
      return value ? String(value).trim() : null;
    } catch (err) {
      console.warn("[email] failed to resolve ADDON_SHARED_SECRET:", err?.message || err);
      return null;
    }
  }

  return null;
}

async function isAuthorized(request, env) {
  const expected = await getAddonSharedSecret(env);
  if (!expected) return false; // fail closed if the secret isn't configured/resolvable
  const got = request.headers.get("x-stellar-addon-key") || "";
  return got.length > 0 && got === expected;
}

export async function handleEmail(request, env, ctx) {
  if (!(await isAuthorized(request, env))) {
    return jsonResponse({ message: "Unauthorized" }, 401, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ message: "Invalid JSON body" }, 400, env);
  }

  const action = body.action;
  const prompt = (body.prompt || "").toString().slice(0, MAX_INPUT_CHARS);
  const draftText = (body.draftText || "").toString().slice(0, MAX_INPUT_CHARS);

  if (!["write", "rewrite", "improve"].includes(action)) {
    return jsonResponse({ message: "action must be one of: write, rewrite, improve" }, 400, env);
  }

  const userContent = action === "write" ? prompt : draftText;
  if (!userContent.trim()) {
    return jsonResponse(
      { message: action === "write" ? "prompt is required" : "draftText is required" },
      400,
      env,
    );
  }

  const start = Date.now();
  const aiResponse = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPTS[action] },
      { role: "user", content: userContent },
    ],
    // gpt-oss is a reasoning model: its hidden chain-of-thought is drawn
    // from this SAME max_tokens budget before it writes the visible email
    // body. 1024 was fine for llama-4-scout (no hidden reasoning step) but
    // would risk truncating — or entirely eating into — the actual email
    // output here. 4096 leaves generous headroom for reasoning + a long
    // email body without raising cost meaningfully (you pay per token
    // actually generated, not for the ceiling itself).
    max_tokens: 4096,
  });

  ctx?.waitUntil(reportUsage(env, {
    model: MODEL,
    sessionId: `gmail-addon-${crypto.randomUUID()}`,
    usage: aiResponse?.usage,
    operationType: "EMAIL_ADDON",
    requestStartTime: start,
    productName: "stellar-ai-gmail",
  }));

  const resultBody = (aiResponse?.response || "").trim();
  if (!resultBody) {
    return jsonResponse({ message: "AI did not return a result" }, 502, env);
  }

  return jsonResponse({ body: resultBody }, 200, env);
}
