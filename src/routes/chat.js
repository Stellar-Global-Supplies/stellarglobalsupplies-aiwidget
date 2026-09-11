import { extractFromFile }              from "../extract.js";
import { TOOL_DEFINITIONS, executeTool } from "../tools.js";
import { ensureSession, saveMessage, getHistory } from "../db.js";
import { jsonResponse } from "../cors.js";

// Single model for chat, extraction, and tool-calling (multimodal + function calling)
const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

// Must mirror NewOrderPage.jsx's form/product field names exactly, so the
// frontend can drop the result straight into its existing state.
const EXTRACTION_SYSTEM_PROMPT = `
You are an assistant embedded in an order management system. The user has attached
a purchase order document. Extract the order details and respond with a short,
friendly confirmation message summarizing what you found, followed by a fenced
JSON code block with this EXACT shape (omit fields you truly cannot find, use null):

\`\`\`json
{
  "form": {
    "customer_name": "",
    "phone": "",
    "email": "",
    "payment_status": "Pending",
    "delivery_timeline": null
  },
  "products": [
    {
      "product_type": "",
      "material": "",
      "quantity": 0,
      "unit": "Pieces",
      "unit_cost": 0,
      "sale_cost": 0,
      "cgst": 0,
      "sgst": 0,
      "description": ""
    }
  ]
}
\`\`\`

Ask the user to confirm before anything is filled into the form. Never claim you created
or submitted an order — you only extract and prefill; the user submits it themselves.
`.trim();

const QUERY_SYSTEM_PROMPT = `
You are an assistant embedded in an order management dashboard. Answer questions about
orders using the provided tools when the question needs data beyond what's already in
the conversation (counts, totals, filters by status/date/vendor). Be concise and precise
with numbers. If a tool call fails, say so plainly rather than guessing.
`.trim();

export async function handleChat(request, env) {
  const contentType = request.headers.get("content-type") || "";
  let message = "", sessionId = "", files = [];

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    message   = form.get("message") || "";
    sessionId = form.get("sessionId") || crypto.randomUUID();
    files     = form.getAll("attachments").filter(f => f && f.size > 0);
  } else {
    const body = await request.json();
    message   = body.message || "";
    sessionId = body.sessionId || crypto.randomUUID();
  }

  await ensureSession(env.DB, sessionId, message || (files[0]?.name ?? "New chat"));

  // ── Attachment path: extraction mode ─────────────────────────────────────
  if (files.length > 0) {
    const parts = [];
    const warnings = [];
    for (const file of files) {
      const { text, warning } = await extractFromFile(file, env);
      if (warning) warnings.push(warning);
      if (text) parts.push(`--- Content of ${file.name} ---\n${text}`);
    }

    if (parts.length === 0) {
      const reply = warnings.join("\n") || "I couldn't read any of the attached files.";
      await saveMessage(env.DB, sessionId, "user", message || "[attachment]");
      await saveMessage(env.DB, sessionId, "assistant", reply);
      return jsonResponse({ sessionId, reply, extracted: null }, 200, env);
    }

    const userContent = [
      message ? `User note: ${message}` : "",
      ...parts,
    ].filter(Boolean).join("\n\n");

    const aiResponse = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });

    const raw = aiResponse?.response || "";
    const extracted = parseExtractedJson(raw);
    const replyText  = stripJsonBlock(raw) + (warnings.length ? `\n\n_Note: ${warnings.join(" ")}_` : "");

    await saveMessage(env.DB, sessionId, "user", message || `[attached: ${files.map(f => f.name).join(", ")}]`);
    await saveMessage(env.DB, sessionId, "assistant", replyText, extracted);

    return jsonResponse({ sessionId, reply: replyText, extracted }, 200, env);
  }

  // ── No attachment: general chat / order-query mode with tool calling ────
  const history = await getHistory(env.DB, sessionId);
  const messages = [
    { role: "system", content: QUERY_SYSTEM_PROMPT },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: message },
  ];

  let aiResponse = await env.AI.run(MODEL, { messages, tools: TOOL_DEFINITIONS });

  // Handle one round of tool calls (sufficient for count/lookup style questions)
  if (aiResponse?.tool_calls?.length) {
    const toolResults = [];
    for (const call of aiResponse.tool_calls) {
      const args = typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
      const result = await executeTool(call.name, args || {}, env);
      toolResults.push({ role: "tool", name: call.name, content: JSON.stringify(result) });
    }
    aiResponse = await env.AI.run(MODEL, {
      messages: [...messages, { role: "assistant", content: "", tool_calls: aiResponse.tool_calls }, ...toolResults],
      tools: TOOL_DEFINITIONS,
    });
  }

  const reply = aiResponse?.response?.trim() || "Sorry, I couldn't process that.";

  await saveMessage(env.DB, sessionId, "user", message);
  await saveMessage(env.DB, sessionId, "assistant", reply);

  return jsonResponse({ sessionId, reply, extracted: null }, 200, env);
}

function parseExtractedJson(raw) {
  const match = raw.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function stripJsonBlock(raw) {
  return raw.replace(/```json\s*[\s\S]*?```/, "").trim();
}
