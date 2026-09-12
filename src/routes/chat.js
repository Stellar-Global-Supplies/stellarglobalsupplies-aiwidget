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

Always use the actual function-calling mechanism to invoke a tool. Never write out a
function call, tool name, or JSON arguments as plain text in your reply — the user should
only ever see a natural-language answer, never the mechanics of how you got it.
`.trim();

// Matches a handful of ways small/instruction-tuned models sometimes leak a tool call as
// plain text instead of using the real function-calling channel, e.g.:
//   <function=get_order_stats>{"status": "Order Received"}</function>
//   [get_order_stats(status="Order Received")]
//   get_order_stats({"status": "Order Received"})
const LEAKED_CALL_PATTERNS = [
  /<function=([a-zA-Z0-9_]+)>\s*(\{[\s\S]*?\})?\s*<\/function>/,
  /\[?([a-zA-Z0-9_]+)\((\{[\s\S]*?\}|[^)]*)\)\]?/,
];

function extractLeakedToolCall(text) {
  if (!text) return null;
  const knownNames = TOOL_DEFINITIONS.map(t => t.function.name);

  for (const pattern of LEAKED_CALL_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const name = match[1];
    if (!knownNames.includes(name)) continue;

    let args = {};
    const rawArgs = match[2] || "";
    if (rawArgs.trim().startsWith("{")) {
      try { args = JSON.parse(rawArgs); } catch { args = {}; }
    } else if (rawArgs.trim()) {
      // key="value", key2="value2" style
      for (const pair of rawArgs.split(",")) {
        const kv = pair.split("=");
        if (kv.length === 2) {
          args[kv[0].trim()] = kv[1].trim().replace(/^["']|["']$/g, "");
        }
      }
    }
    return { name, arguments: args };
  }
  return null;
}

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

  let conversation = [...messages];
  let aiResponse = await env.AI.run(MODEL, { messages: conversation, tools: TOOL_DEFINITIONS });

  // Handle up to a couple of rounds of tool calls (sufficient for count/lookup
  // style questions, with room for one follow-up call e.g. stats -> detail).
  const MAX_TOOL_ROUNDS = 3;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let calls = aiResponse?.tool_calls || [];

    // Fallback: some model responses leak the call as plain text in `.response`
    // instead of populating `.tool_calls`. Detect and treat it the same way.
    if (calls.length === 0) {
      const leaked = extractLeakedToolCall(aiResponse?.response);
      if (leaked) calls = [leaked];
    }

    if (calls.length === 0) {
      if (round === 0) {
        console.log("[chat] no tool_calls on first response; raw response was:", JSON.stringify(aiResponse?.response));
      }
      break;
    }

    console.log("[chat] tool call(s) requested:", JSON.stringify(calls));

    // Normalize into the strict OpenAI-style shape the Workers AI endpoint
    // requires on the *next* request (id, type, function.{name,arguments}).
    // The model's own tool_calls output only reliably includes name/arguments,
    // which is what caused the 400/500 "Field required" errors.
    const normalizedCalls = calls.map((call, i) => ({
      id: call.id || `call_${crypto.randomUUID().slice(0, 8)}_${i}`,
      type: "function",
      function: {
        name: call.name,
        arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments || {}),
      },
    }));

    const toolResults = [];
    for (const call of normalizedCalls) {
      const args = JSON.parse(call.function.arguments || "{}");
      const result = await executeTool(call.function.name, args, env);
      console.log(`[chat] executeTool(${call.function.name}, ${JSON.stringify(args)}) →`, JSON.stringify(result));
      toolResults.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }

    conversation = [
      ...conversation,
      { role: "assistant", content: aiResponse?.response || "", tool_calls: normalizedCalls },
      ...toolResults,
    ];

    aiResponse = await env.AI.run(MODEL, { messages: conversation, tools: TOOL_DEFINITIONS });
  }

  let reply = aiResponse?.response?.trim() || "Sorry, I couldn't process that.";

  // Safety net: never let a leaked function-call string reach the user, even
  // if it slipped through after the tool-call rounds above.
  if (extractLeakedToolCall(reply)) {
    reply = "Sorry, I ran into a problem answering that — could you rephrase the question?";
  }

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
