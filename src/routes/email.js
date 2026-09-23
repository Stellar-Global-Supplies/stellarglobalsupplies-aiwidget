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
};


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

  const prompt = (body.prompt || "")
    .toString()
    .slice(0, MAX_INPUT_CHARS);

  const draftText = (body.draftText || "")
    .toString()
    .slice(0, MAX_INPUT_CHARS);

  if (!["write", "rewrite", "improve"].includes(action)) {
    return jsonResponse(
      {
        message:
          "action must be one of: write, rewrite, improve",
      },
      400,
      env
    );
  }

  const userContent =
    action === "write"
      ? prompt
      : draftText;

  if (!userContent.trim()) {
    return jsonResponse(
      {
        message:
          action === "write"
            ? "prompt is required"
            : "draftText is required",
      },
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

  console.log(
    "[email] AI RESPONSE SUMMARY:",
    JSON.stringify({
      responseType: typeof aiResponse?.response,

      responseLength:
        typeof aiResponse?.response === "string"
          ? aiResponse.response.length
          : null,

      hasResponse:
        typeof aiResponse?.response === "string" &&
        aiResponse.response.length > 0,

      hasUsage: !!aiResponse?.usage,

      usage: aiResponse?.usage || null,
    })
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