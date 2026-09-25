/**
 * Gmail Add-on endpoint — write / rewrite / improve / summarize / explain /
 * digest / explain_sender.
 *
 * Reuses the SAME Workers AI binding, model, and Revenium metering as
 * /chat. No separate AI backend, no new API keys shipped to the client.
 *
 * Auth: this Worker is otherwise intentionally unauthenticated (embedded
 * on internal, staff-only pages, protected only by CORS origin). That
 * protection does NOT apply here — Apps Script calls this endpoint
 * server-to-server from Google's infrastructure, with no Origin header
 * for CORS to check. So /email is gated by a separate shared-secret
 * header instead.
 */

import { jsonResponse } from "../cors.js";
import { reportUsage } from "../revenium.js";

// gpt-oss-20b
const MODEL = "@cf/openai/gpt-oss-20b";

const MAX_INPUT_CHARS = 12000;

const SYSTEM_PROMPTS = {
  write: `
You are an email-writing assistant embedded in Gmail via a "Stellar AI" add-on.
The user gives you a short instruction describing an email they want. Write a
complete, ready-to-send email body based only on that instruction.

Rules:
- Output the email BODY only.
- Do not include a subject line or "Subject:" prefix.
- Do not use markdown code fences.
- Do not include commentary, explanations, or notes before or after the email.
- Use plain text.
- Use proper paragraph breaks. Separate distinct thoughts into separate
  paragraphs with a blank line.
- Do not return the entire email as one continuous paragraph.
- Do not automatically add a signature, name, company, job title, phone number,
  or other signature details unless the user explicitly asks for them.
- Match a professional, natural tone unless the user's instruction implies
  otherwise.
- Keep the email concise and avoid unnecessary filler.
- Follow the user's requested tone, style, and purpose.
- Do not invent specific facts, dates, prices, names, commitments, or other
  details that the user did not provide.
- If an important detail is missing and a placeholder is necessary, use a simple
  placeholder such as [Name], [Date], [Amount], or [Order Number].
- Make the result complete and ready to send with minimal editing.
`.trim(),

  rewrite: `
You are an email-rewriting assistant embedded in Gmail via a "Stellar AI" add-on.
The user provides an existing email draft. Rewrite it to make it clearer,
better-structured, and more natural while preserving its original meaning,
intent, and important information.

Rules:
- Output the rewritten email BODY only.
- Do not include a subject line or "Subject:" prefix.
- Do not use markdown code fences.
- Do not include commentary, explanations, or notes before or after the email.
- Use plain text.
- Preserve proper paragraph breaks and use a blank line between distinct
  paragraphs.
- Do not automatically add a signature, name, company, job title, phone number,
  or other signature details unless they already exist in the draft or the user
  explicitly asks for them.
- Preserve concrete facts already present in the draft, including names, dates,
  numbers, and commitments.
- Do not invent new facts or information.
- Improve clarity, grammar, flow, and wording while keeping the original intent.
- Match the original tone unless the user explicitly requests a different tone.
- Keep the rewritten email concise and natural.
- If the draft is empty or nonsensical, say so plainly in one short sentence
  instead of fabricating an email.
`.trim(),

  improve: `
You are an email-editing assistant embedded in Gmail via a "Stellar AI" add-on.
The user provides an existing email draft. Make light-touch improvements to
grammar, spelling, clarity, punctuation, and wording while keeping the original
message and intent essentially unchanged.

Rules:
- Output the improved email BODY only.
- Do not include a subject line or "Subject:" prefix.
- Do not use markdown code fences.
- Do not include commentary, explanations, or notes before or after the email.
- Use plain text.
- Preserve the existing paragraph structure and use proper paragraph breaks.
- Do not automatically add a signature, name, company, job title, phone number,
  or other signature details unless they already exist in the draft or the user
  explicitly asks for them.
- Preserve all concrete facts, names, dates, numbers, and commitments.
- Do not invent new information.
- Stay close to the original wording where it already works.
- Do not significantly restructure, expand, shorten, or change the intent of
  the email.
- Keep the result natural and ready to send.
- If the draft is empty or nonsensical, say so plainly in one short sentence
  instead of fabricating an email.
`.trim(),

  summarize: `
You are an email-summarizing assistant embedded in Gmail via a "Stellar AI" add-on.
You're given the text of an email (sometimes with quoted thread history below
the newest message). Summarize it.

Rules:
- Lead with a 1-2 sentence summary of what the email is about and what (if
  anything) it's asking the reader to do.
- Add a short bulleted list of key points ONLY if the email has more than one
  distinct point worth separating out — for a short/simple email, the 1-2
  sentence summary alone is enough.
- If the email is clearly asking for a decision, reply, or action, call that
  out explicitly (e.g. "Action needed: ...").
- Focus on the newest message; only pull from quoted/forwarded history below
  it if needed to make the summary make sense.
- Plain text only. No markdown headers, no "Here's a summary:" preamble.
`.trim(),

  explain: `
You are an email-explaining assistant embedded in Gmail via a "Stellar AI" add-on.
You're given the text of an email (or a snippet of one) that the user doesn't
fully understand or wants more context on. Explain it in plain language.

Rules:
- Explain what the email is actually saying, including any jargon, technical
  terms, unusual phrasing, or implied context — spell out what it means in
  practice, not just what it literally says.
- If something is ambiguous or could be read more than one way, say so and
  give the likely interpretations rather than picking one silently.
- If the email implies a deadline, obligation, or consequence, call it out
  explicitly even if it wasn't stated directly.
- Keep it conversational and clear — write for someone who wants to
  understand quickly, not a formal report.
- Plain text only. No markdown headers.
`.trim(),

  digest: `
You are an inbox-digest assistant embedded in Gmail via a "Stellar AI" add-on.
You're given a numbered list of recent emails, each with its sender and
subject and a short snippet of the body. For EACH numbered email, write one
short line capturing what it's about and whether it looks like it needs a
reply/action from the user.

Rules:
- Output one line per email, in the SAME numbered order as given — do not
  skip, merge, or reorder any.
- Format each line as: "N. <one-line take, plain language>" — do not repeat
  the sender or subject back, the user already sees those separately.
- If an email clearly needs a reply/decision, end that line with
  " — needs reply" or " — action needed" as appropriate; otherwise leave it
  off entirely (don't write "no action needed" every time — only flag the
  ones that need something).
- Keep each line under ~20 words.
- Plain text only, no markdown, no preamble, no summary paragraph before or
  after the numbered list.
`.trim(),

  explain_sender: `
You are an assistant embedded in Gmail via a "Stellar AI" add-on that helps
the user quickly understand who they're corresponding with. You're given an
email address/name and a short set of recent email snippets (subject + a bit
of body) from or to that person.

Rules:
- In 2-4 sentences, describe who this person appears to be and what you
  two have been discussing, based ONLY on the snippets given — do not guess
  at their job title, company, or relationship beyond what's evident in the
  text.
- If there's a clear open item, pending question, or something awaiting a
  reply from either side, mention it.
- If the snippets are too thin or unrelated to say anything meaningful,
  say that plainly instead of fabricating a profile.
- Plain text only, conversational tone, no markdown headers, no preamble.
`.trim(),
};

const VALID_ACTIONS = Object.keys(SYSTEM_PROMPTS);

// Resolves the add-on's shared secret.
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
      console.warn(
        "[email] failed to resolve ADDON_SHARED_SECRET:",
        err?.message || err
      );

      return null;
    }
  }

  return null;
}

async function isAuthorized(request, env) {
  const expected = await getAddonSharedSecret(env);

  if (!expected) return false;

  const got = request.headers.get("x-stellar-addon-key") || "";

  return got.length > 0 && got === expected;
}

// digest/explain_sender send an array of short strings (one per email) that
// we join into one block of text for the model, each numbered so the model
// can echo the same numbering back in its reply.
function joinNumberedItems(items) {
  return items
    .map((item, i) => `${i + 1}. ${String(item || "").slice(0, 1500)}`)
    .join("\n\n");
}

export async function handleEmail(request, env, ctx) {
  // ------------------------------------------
  // AUTH
  // ------------------------------------------

  if (!(await isAuthorized(request, env))) {
    return jsonResponse(
      { message: "Unauthorized" },
      401,
      env
    );
  }

  // ------------------------------------------
  // REQUEST BODY
  // ------------------------------------------

  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { message: "Invalid JSON body" },
      400,
      env
    );
  }

  const action = body.action;

  if (!VALID_ACTIONS.includes(action)) {
    return jsonResponse(
      {
        message: `action must be one of: ${VALID_ACTIONS.join(", ")}`,
      },
      400,
      env
    );
  }

  const prompt = (body.prompt || "")
    .toString()
    .slice(0, MAX_INPUT_CHARS);

  const draftText = (body.draftText || "")
    .toString()
    .slice(0, MAX_INPUT_CHARS);

  // digest / explain_sender: an array of short per-email strings instead of
  // one blob of text. Capped at 15 items regardless of what's sent — keeps
  // a single AI call's cost/latency bounded even if the caller sends more.
  const items = Array.isArray(body.items) ? body.items.slice(0, 15) : [];

  const senderLabel = (body.senderLabel || "").toString().slice(0, 200);

  let userContent;

  if (action === "write") {
    userContent = prompt;
  } else if (action === "digest") {
    userContent = joinNumberedItems(items);
  } else if (action === "explain_sender") {
    userContent =
      (senderLabel ? `Sender: ${senderLabel}\n\n` : "") +
      joinNumberedItems(items);
  } else {
    // rewrite, improve, summarize, explain
    userContent = draftText;
  }

  if (!userContent.trim()) {
    const fieldHint =
      action === "write"
        ? "prompt is required"
        : action === "digest" || action === "explain_sender"
        ? "items is required (non-empty array)"
        : "draftText is required";

    return jsonResponse(
      { message: fieldHint },
      400,
      env
    );
  }

  // ------------------------------------------
  // AI REQUEST
  // ------------------------------------------

  const start = Date.now();

  let aiResponse;

  try {
    aiResponse = await env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPTS[action],
        },
        {
          role: "user",
          content: userContent,
        },
      ],

      // gpt-oss is a reasoning model.
      max_tokens: 4096,
    });
  } catch (err) {
    console.error(
      "[email] Workers AI ERROR:",
      err?.message || err
    );

    return jsonResponse(
      {
        message: "AI request failed",
      },
      502,
      env
    );
  }

  // ------------------------------------------
  // DEBUG AI RESPONSE
  // ------------------------------------------

  console.log(
    "[email] AI RESPONSE:",
    JSON.stringify(aiResponse)
  );

  // ------------------------------------------
  // REVENIUM
  // ------------------------------------------

  ctx?.waitUntil(
    reportUsage(env, {
      model: MODEL,

      sessionId:
        `gmail-addon-${crypto.randomUUID()}`,

      usage: aiResponse?.usage,

      // Revenium-supported operation type.
      operationType: "TOOL_CALL",

      requestStartTime: start,

      productName: "stellar-ai-gmail",
    })
  );

  // ------------------------------------------
  // EXTRACT AI RESULT
  // ------------------------------------------

  const resultBody = aiResponse?.choices?.[0]?.message?.content?.trim() || "";

  // ------------------------------------------
  // AI RETURNED NOTHING
  // ------------------------------------------

  if (!resultBody) {
    console.error(
      "[email] AI returned no usable response"
    );

    return jsonResponse(
      {
        message:
          "AI did not return a usable result",
      },
      502,
      env
    );
  }

  // ------------------------------------------
  // SUCCESS
  // ------------------------------------------

  console.log(
    "[email] SUCCESS:",
    JSON.stringify({
      action,
      responseLength: resultBody.length,
    })
  );

  return jsonResponse(
    {
      body: resultBody,
    },
    200,
    env
  );
}