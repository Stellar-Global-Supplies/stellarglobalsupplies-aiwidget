/**
 * Revenium AI metering — fire-and-forget usage reporting.
 *
 * Sends token counts (no cost data) for every Workers AI call to Revenium's
 * metering API so spend/usage shows up in the Revenium dashboard. This never
 * blocks or fails the actual chat request: call sites use ctx.waitUntil() and
 * every failure here is swallowed (logged only).
 *
 * Requires a Cloudflare Secrets Store binding named REVENIUM_API_KEY (see
 * [[secrets_store_secrets]] in wrangler.toml) — an account-level secret,
 * shared across Workers/products, resolved at runtime via .get().
 * Shared across products — productId is passed in per-call, not hardcoded here.
 */

// Resolves the Revenium API key from a Cloudflare Secrets Store binding.
// Secrets Store bindings are objects with an async .get() — NOT a plain
// string like a classic `wrangler secret put` value — so this must be
// awaited. Falls back to a plain string too, in case env.REVENIUM_API_KEY
// is ever set the old way (e.g. local .dev.vars during early testing).
async function getReveniumApiKey(env) {
    const binding = env.REVENIUM_API_KEY;
    if (!binding) return null;
    if (typeof binding === "string") return binding; // plain secret/var fallback
    if (typeof binding.get === "function") {
      try {
        return await binding.get();
      } catch (err) {
        console.warn("[revenium] failed to resolve Secrets Store binding:", err.message);
        return null;
      }
    }
    return null;
  }
  
  const REVENIUM_METERING_URL = "https://api.revenium.io/meter/v2/ai/completions";
  
  const ORGANIZATION_ID = "Stellar Global Supplies";
  const PRODUCT_ID = "stellar-ai-widget";
  const PROVIDER = "Cloudflare";
  
  /**
   * Report one AI call to Revenium. Safe to call without awaiting the result
   * directly — wrap the call in ctx.waitUntil(reportUsage(...)) at the call site.
   *
   * @param {object} env - Worker env (needs REVENIUM_API_KEY)
   * @param {object} opts
   * @param {string} opts.model - model id, e.g. "@cf/meta/llama-4-scout-17b-16e-instruct"
   * @param {string} opts.sessionId - chat session id, used as the subscriber id
   * @param {object} opts.usage - token usage, whatever shape Workers AI returned
   * @param {string} [opts.operationType] - "CHAT" (default) or similar
   * @param {number} [opts.requestStartTime] - Date.now() captured before the AI call
   */
  export async function reportUsage(env, { model, sessionId, usage, operationType = "CHAT", requestStartTime }) {
    const apiKey = await getReveniumApiKey(env);
    if (!apiKey) {
      console.warn("[revenium] REVENIUM_API_KEY not available — skipping usage report");
      return;
    }
  
    const { inputTokenCount, outputTokenCount, totalTokenCount } = normalizeUsage(usage);
  
    // Nothing usable to report (e.g. model returned no usage block) — skip silently.
    if (inputTokenCount === 0 && outputTokenCount === 0 && totalTokenCount === 0) {
      return;
    }
  
    const now = new Date();
    const requestTime = requestStartTime ? new Date(requestStartTime) : now;
  
    const payload = {
      provider: PROVIDER,
      model,
      operationType,
      organizationId: ORGANIZATION_ID,
      productId: PRODUCT_ID,
      subscriber: { id: sessionId || "unknown-session" },
      inputTokenCount,
      outputTokenCount,
      totalTokenCount,
      requestTime: requestTime.toISOString(),
      responseTime: now.toISOString(),
      requestDuration: now.getTime() - requestTime.getTime(),
      transactionId: crypto.randomUUID(),
    };
  
    try {
      const res = await fetch(REVENIUM_METERING_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(payload),
      });
  
      if (!res.ok) {
        console.warn(`[revenium] metering call failed: ${res.status} ${await res.text().catch(() => "")}`);
      }
    } catch (err) {
      // Fire-and-forget: never let a Revenium outage affect the chat response.
      console.warn("[revenium] metering call errored:", err.message);
    }
  }
  
  // Workers AI's usage block isn't perfectly consistent across models/versions
  // (prompt_tokens/completion_tokens vs input/output naming), so normalize here
  // rather than at every call site.
  function normalizeUsage(usage) {
    if (!usage) return { inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0 };
  
    const inputTokenCount =
      usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokenCount ?? 0;
    const outputTokenCount =
      usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokenCount ?? 0;
    const totalTokenCount =
      usage.total_tokens ?? usage.totalTokenCount ?? (inputTokenCount + outputTokenCount);
  
    return { inputTokenCount, outputTokenCount, totalTokenCount };
  }