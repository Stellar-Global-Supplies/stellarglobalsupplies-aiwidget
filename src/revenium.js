/**
 * Revenium AI metering for Cloudflare Workers
 *
 * Provider + modelSource are automatically detected from the model name.
 */

const REVENIUM_METERING_URL =
  "https://api.revenium.ai/meter/v2/ai/completions";

const ORGANIZATION_NAME = "Stellar Global Supplies";
const PRODUCT_NAME = "stellar-ai-widget";

/**
 * Resolve Revenium API key.
 */
async function getReveniumApiKey(env) {
  const binding = env.REVENIUM_API_KEY;

  if (!binding) {
    return null;
  }

  if (typeof binding === "string") {
    return binding.trim();
  }

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
 * Dynamically determine provider and model source.
 *
 * Cloudflare:
 *
 * @cf/meta/llama-4-scout...
 *   provider    = cloudflare
 *   modelSource = Cloudflare
 *
 * @cf/mistral/...
 *   provider    = cloudflare
 *   modelSource = Cloudflare
 *
 * @cf/deepseek/...
 *   provider    = cloudflare
 *   modelSource = Cloudflare
 *
 * Other direct providers are detected from model name.
 */
function inferProviderAndSource(model) {
  const value = String(model || "").toLowerCase();

  /*
   * ----------------------------------------
   * Cloudflare Workers AI
   * ----------------------------------------
   *
   * IMPORTANT:
   * Revenium's pricing catalog for your
   * @cf/... model is registered under
   * provider = cloudflare.
   */

  if (value.startsWith("@cf/")) {
    return {
      provider: "cloudflare",
      modelSource: "Cloudflare",
    };
  }

  /*
   * ----------------------------------------
   * OpenAI
   * ----------------------------------------
   */

  if (
    value.includes("gpt-") ||
    value.includes("o1") ||
    value.includes("o3") ||
    value.includes("o4")
  ) {
    return {
      provider: "OpenAI",
      modelSource: "DIRECT",
    };
  }

  /*
   * ----------------------------------------
   * Anthropic
   * ----------------------------------------
   */

  if (
    value.includes("claude") ||
    value.includes("anthropic")
  ) {
    return {
      provider: "Anthropic",
      modelSource: "DIRECT",
    };
  }

  /*
   * ----------------------------------------
   * Google
   * ----------------------------------------
   */

  if (
    value.includes("gemini") ||
    value.includes("gemma")
  ) {
    return {
      provider: "Google",
      modelSource: "DIRECT",
    };
  }

  /*
   * ----------------------------------------
   * Mistral
   * ----------------------------------------
   */

  if (
    value.includes("mistral") ||
    value.includes("mixtral")
  ) {
    return {
      provider: "Mistral",
      modelSource: "DIRECT",
    };
  }

  /*
   * ----------------------------------------
   * DeepSeek
   * ----------------------------------------
   */

  if (value.includes("deepseek")) {
    return {
      provider: "DeepSeek",
      modelSource: "DIRECT",
    };
  }

  /*
   * ----------------------------------------
   * Meta / Llama
   * ----------------------------------------
   */

  if (value.includes("llama")) {
    return {
      provider: "Meta",
      modelSource: "DIRECT",
    };
  }

  /*
   * ----------------------------------------
   * Cohere
   * ----------------------------------------
   */

  if (
    value.includes("command-r") ||
    value.includes("cohere")
  ) {
    return {
      provider: "Cohere",
      modelSource: "DIRECT",
    };
  }

  /*
   * ----------------------------------------
   * Unknown provider
   * ----------------------------------------
   */

  return {
    provider: "Unknown",
    modelSource: "DIRECT",
  };
}

/**
 * Normalize token usage.
 */
function normalizeUsage(usage) {
  if (!usage) {
    return {
      inputTokenCount: 0,
      outputTokenCount: 0,
      totalTokenCount: 0,
      reasoningTokenCount: null,
    };
  }

  const inputTokenCount = Number(
    usage.prompt_tokens ??
      usage.input_tokens ??
      usage.inputTokenCount ??
      usage.promptTokens ??
      0
  );

  const outputTokenCount = Number(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.outputTokenCount ??
      usage.completionTokens ??
      0
  );

  const totalTokenCount = Number(
    usage.total_tokens ??
      usage.totalTokenCount ??
      usage.totalTokens ??
      inputTokenCount + outputTokenCount
  );

  const reasoningTokenCount =
    usage.reasoning_tokens ??
    usage.reasoningTokenCount ??
    usage.reasoningTokens ??
    null;

  return {
    inputTokenCount,
    outputTokenCount,
    totalTokenCount,

    reasoningTokenCount:
      reasoningTokenCount == null
        ? null
        : Number(reasoningTokenCount),
  };
}

/**
 * Report AI usage to Revenium.
 *
 * provider and modelSource are optional.
 *
 * If not supplied:
 *   -> automatically inferred from model
 *
 * If supplied:
 *   -> explicit values are used
 */
export async function reportUsage(
  env,
  {
    model,
    sessionId,
    usage,
    operationType = "CHAT",
    requestStartTime,

    // Optional overrides
    provider,
    modelSource,
  }
) {
  const apiKey = await getReveniumApiKey(env);

  /*
   * Safe diagnostics.
   * Never print the actual API key.
   */

  console.log(
    "[revenium] key resolved:",
    !!apiKey
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

  /*
   * Normalize token usage.
   */

  const {
    inputTokenCount,
    outputTokenCount,
    totalTokenCount,
    reasoningTokenCount,
  } = normalizeUsage(usage);

  /*
   * Don't send empty usage events.
   */

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

  /*
   * Automatically determine provider/source.
   */

  const inferred =
    inferProviderAndSource(model);

  const resolvedProvider =
    provider || inferred.provider;

  const resolvedModelSource =
    modelSource || inferred.modelSource;

  /*
   * Timing.
   */

  const requestTime = requestStartTime
    ? new Date(requestStartTime)
    : new Date();

  const completionStartTime =
    new Date();

  const responseTime =
    new Date();

  const requestDuration =
    Math.max(
      1,
      responseTime.getTime() -
        requestTime.getTime()
    );

  /*
   * Transaction ID.
   */

  const transactionId =
    crypto.randomUUID();

  /*
   * Revenium payload.
   */

  const payload = {
    transactionId,

    model:
      model || "unknown",

    /*
     * Dynamic provider/source.
     */
    provider:
      resolvedProvider,

    modelSource:
      resolvedModelSource,

    /*
     * Token counts.
     */
    inputTokenCount,

    outputTokenCount,

    totalTokenCount,

    /*
     * Optional reasoning tokens.
     */
    ...(reasoningTokenCount != null
      ? {
          reasoningTokenCount,
        }
      : {}),

    /*
     * Timing.
     */
    requestTime:
      requestTime.toISOString(),

    completionStartTime:
      completionStartTime.toISOString(),

    responseTime:
      responseTime.toISOString(),

    requestDuration,

    /*
     * Completion status.
     */
    stopReason:
      "STOP",

    /*
     * KEEPING YOUR ORIGINAL VALUES.
     */
    organizationName:
      ORGANIZATION_NAME,

    productName:
      PRODUCT_NAME,

    /*
     * Existing operation/session information.
     */
    operationType,

    subscriber: {
      id:
        sessionId ||
        "unknown-session",
    },
  };

  try {
    const response =
      await fetch(
        REVENIUM_METERING_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Accept:
              "application/json",

            "x-api-key":
              apiKey,

            "Idempotency-Key":
              transactionId,
          },

          body:
            JSON.stringify(
              payload
            ),
        }
      );

    const body =
      await response.text();

    /*
     * Failed request.
     */

    if (!response.ok) {
      console.warn(
        "[revenium] metering call failed: " +
          JSON.stringify({
            status:
              response.status,

            statusText:
              response.statusText,

            body,

            model,

            provider:
              resolvedProvider,

            modelSource:
              resolvedModelSource,

            inputTokenCount,

            outputTokenCount,

            totalTokenCount,
          })
      );

      return;
    }

    /*
     * Successful request.
     */

    console.log(
      "[revenium] metering call successful: " +
        JSON.stringify({
          status:
            response.status,

          model,

          provider:
            resolvedProvider,

          modelSource:
            resolvedModelSource,

          inputTokenCount,

          outputTokenCount,

          totalTokenCount,

          transactionId,
        })
    );
  } catch (err) {
    console.warn(
      "[revenium] metering call errored:",
      err?.message || err
    );
  }
}
