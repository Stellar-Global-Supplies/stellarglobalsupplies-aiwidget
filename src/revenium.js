/**
 * Revenium AI metering for Cloudflare Workers
 *
 * Current endpoint:
 * POST https://api.revenium.ai/meter/v2/ai/completions
 *
 * Authentication:
 * x-api-key: <Revenium API key>
 */

const REVENIUM_METERING_URL =
  "https://api.revenium.ai/meter/v2/ai/completions";

const ORGANIZATION_NAME = "Stellar Global Supplies";
const PRODUCT_NAME = "stellar-ai-widget";
const PROVIDER = "Cloudflare";

/**
 * Resolve Revenium API key from:
 * - normal Worker env variable / Wrangler secret
 * - Cloudflare Secrets Store binding
 */
async function getReveniumApiKey(env) {
  const binding = env.REVENIUM_API_KEY;

  if (!binding) {
    return null;
  }

  // Normal Wrangler secret / environment variable
  if (typeof binding === "string") {
    return binding.trim();
  }

  // Cloudflare Secrets Store
  if (typeof binding.get === "function") {
    try {
      const value = await binding.get();

      if (!value) {
        return null;
      }

      return String(value).trim();
    } catch (err) {
      console.warn(
        "[revenium] failed to resolve Secrets Store binding:",
        err?.message || err
      );

      return null;
    }
  }

  return null;
}

/**
 * Normalize Workers AI usage into Revenium's expected token fields.
 */
function normalizeUsage(usage) {
  if (!usage) {
    return {
      inputTokenCount: 0,
      outputTokenCount: 0,
      totalTokenCount: 0,
    };
  }

  const inputTokenCount = Number(
    usage.prompt_tokens ??
      usage.input_tokens ??
      usage.inputTokenCount ??
      0
  );

  const outputTokenCount = Number(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.outputTokenCount ??
      0
  );

  const totalTokenCount = Number(
    usage.total_tokens ??
      usage.totalTokenCount ??
      inputTokenCount + outputTokenCount
  );

  return {
    inputTokenCount,
    outputTokenCount,
    totalTokenCount,
  };
}

/**
 * Send a minimal test request to Revenium.
 *
 * This is intentionally separate from normal usage reporting.
 * It helps determine whether a 403 is authentication/scope related
 * or whether the normal payload is invalid.
 */
export async function testRevenium(env) {
  const apiKey = await getReveniumApiKey(env);

  console.log(
    "[revenium-test] key resolved:",
    !!apiKey
  );

  console.log(
    "[revenium-test] key prefix:",
    apiKey ? apiKey.slice(0, 4) : "none"
  );

  console.log(
    "[revenium-test] key length:",
    apiKey?.length ?? 0
  );

  if (!apiKey) {
    return {
      success: false,
      status: 0,
      body: "REVENIUM_API_KEY not available",
    };
  }

  const now = new Date();
  const timestamp = now.toISOString();

  const payload = {
    model: "test-model",

    inputTokenCount: 1,
    outputTokenCount: 1,
    totalTokenCount: 2,

    requestTime: timestamp,
    completionStartTime: timestamp,
    responseTime: timestamp,

    requestDuration: 1,

    provider: "test",
    stopReason: "STOP",
  };

  try {
    const response = await fetch(
      REVENIUM_METERING_URL,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-api-key": apiKey,
        },

        body: JSON.stringify(payload),
      }
    );

    const body = await response.text();

    console.log(
      "[revenium-test]",
      JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        body,
        endpoint: REVENIUM_METERING_URL,
      })
    );

    return {
      success: response.ok,
      status: response.status,
      body,
    };
  } catch (err) {
    console.warn(
      "[revenium-test] request error:",
      err?.message || err
    );

    return {
      success: false,
      status: 0,
      body: err?.message || String(err),
    };
  }
}

/**
 * Report one real AI request to Revenium.
 *
 * Call this using ctx.waitUntil(reportUsage(...))
 * so Revenium never blocks your chat response.
 */
export async function reportUsage(
  env,
  {
    model,
    sessionId,
    usage,
    operationType = "CHAT",
    requestStartTime,
  }
) {
  const apiKey = await getReveniumApiKey(env);

  // Safe diagnostics — NEVER log the actual API key.
  console.log(
    "[revenium] key resolved:",
    !!apiKey
  );

  console.log(
    "[revenium] key prefix:",
    apiKey ? apiKey.slice(0, 4) : "none"
  );

  console.log(
    "[revenium] key length:",
    apiKey?.length ?? 0
  );

  if (!apiKey) {
    console.warn(
      "[revenium] REVENIUM_API_KEY not available — skipping usage report"
    );

    return;
  }

  const normalized = normalizeUsage(usage);

  const {
    inputTokenCount,
    outputTokenCount,
    totalTokenCount,
  } = normalized;

  if (
    inputTokenCount === 0 &&
    outputTokenCount === 0 &&
    totalTokenCount === 0
  ) {
    console.warn(
      "[revenium] no token usage found — skipping usage report"
    );

    return;
  }

  const requestTime = requestStartTime
    ? new Date(requestStartTime)
    : new Date();

  const completionStartTime = new Date();

  const responseTime = new Date();

  const requestDuration = Math.max(
    1,
    responseTime.getTime() -
      requestTime.getTime()
  );

  const payload = {
    model: model || "unknown",

    inputTokenCount,
    outputTokenCount,
    totalTokenCount,

    requestTime: requestTime.toISOString(),

    completionStartTime:
      completionStartTime.toISOString(),

    responseTime:
      responseTime.toISOString(),

    requestDuration,

    provider: PROVIDER,

    stopReason: "STOP",

    operationType,

    organizationName:
      ORGANIZATION_NAME,

    productName:
      PRODUCT_NAME,

    subscriber: {
      id: sessionId || "unknown-session",
    },

    transactionId: crypto.randomUUID(),
  };

  try {
    const response = await fetch(
      REVENIUM_METERING_URL,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",

          // Revenium authentication
          "x-api-key": apiKey,
        },

        body: JSON.stringify(payload),
      }
    );

    const body = await response.text();

    if (!response.ok) {
      console.warn(
        "[revenium] metering call failed: " +
          JSON.stringify({
            status: response.status,
            statusText: response.statusText,
            body,
            endpoint: REVENIUM_METERING_URL,
            hasApiKey: !!apiKey,
            apiKeyPrefix: apiKey.slice(0, 4),
            apiKeyLength: apiKey.length,
          })
      );

      return;
    }

    console.log(
      "[revenium] metering call successful:",
      JSON.stringify({
        status: response.status,
        body,
        model,
        inputTokenCount,
        outputTokenCount,
        totalTokenCount,
      })
    );
  } catch (err) {
    console.warn(
      "[revenium] metering call errored:",
      err?.message || err
    );
  }
}