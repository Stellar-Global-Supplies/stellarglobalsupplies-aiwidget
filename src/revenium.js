/**
 * Revenium AI metering
 *
 * Flow:
 * 1. Get model pricing from Revenium
 * 2. Cache pricing in Cloudflare KV
 * 3. Calculate cost locally
 * 4. Send tokens + calculated cost to Revenium
 */

const REVENIUM_METERING_URL =
  "https://api.revenium.ai/meter/v2/ai/completions";

const REVENIUM_RATES_URL =
  "https://api.revenium.ai/profitstream/v2/api/sources/ai/models/rates";

const REVENIUM_TEAM_ID = "5WJ6rl";

const ORGANIZATION_NAME = "Stellar Global Supplies";
const PRODUCT_NAME = "stellar-ai-widget";

const PRICING_TTL = 86400;


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
        "[revenium] failed to resolve API key:",
        err?.message || err
      );

      return null;
    }
  }

  return null;
}


/**
 * Detect provider and model source.
 */
function inferProviderAndSource(model) {
  const value = String(model || "").toLowerCase();

  /*
   * Cloudflare Workers AI
   */
  if (value.startsWith("@cf/")) {
    return {
      provider: "cloudflare",
      modelSource: "Cloudflare",
    };
  }

  /*
   * OpenAI
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
   * Anthropic
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
   * Google
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
   * DeepSeek
   */
  if (value.includes("deepseek")) {
    return {
      provider: "DeepSeek",
      modelSource: "DIRECT",
    };
  }

  /*
   * Mistral
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
   * Groq
   */
  if (
    value.includes("groq") ||
    value.includes("versatile") ||
    value.includes("compound")
  ) {
    return {
      provider: "Groq",
      modelSource: "DIRECT",
    };
  }

  /*
   * Meta / Llama
   */
  if (value.includes("llama")) {
    return {
      provider: "Meta",
      modelSource: "DIRECT",
    };
  }

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
      cacheCreationTokenCount: null,
      cacheReadTokenCount: null,
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

  return {
    inputTokenCount,
    outputTokenCount,
    totalTokenCount,

    reasoningTokenCount:
      usage.reasoning_tokens ??
      usage.reasoningTokenCount ??
      null,

    cacheCreationTokenCount:
      usage.cache_creation_input_tokens ??
      usage.cacheCreationTokenCount ??
      null,

    cacheReadTokenCount:
      usage.cache_read_input_tokens ??
      usage.cacheReadTokenCount ??
      null,
  };
}


/**
 * Normalize Revenium pricing response.
 */
function normalizeRate(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const model =
    item.model ??
    item.name ??
    item.modelName ??
    item.aiModel?.name;

  const inputPerMillion =
    Number(
      item.inputCostPerMillionTokens ??
      item.inputCostPer1M ??
      item.inputRatePerMillionTokens ??
      item.inputPricePerMillionTokens ??
      item.inputCostPerMillion ??
      item.inputCost ??
      0
    );

  const outputPerMillion =
    Number(
      item.outputCostPerMillionTokens ??
      item.outputCostPer1M ??
      item.outputRatePerMillionTokens ??
      item.outputPricePerMillionTokens ??
      item.outputCostPerMillion ??
      item.outputCost ??
      0
    );

  if (!model) {
    return null;
  }

  return {
    model: String(model),

    inputCostPerMillion:
      inputPerMillion,

    outputCostPerMillion:
      outputPerMillion,
  };
}


/**
 * Fetch model pricing from Revenium.
 */
async function fetchReveniumRates(apiKey) {
  const url =
    `${REVENIUM_RATES_URL}?teamId=${encodeURIComponent(REVENIUM_TEAM_ID)}`;

  console.log(
    "[revenium] fetching model pricing"
  );

  const response =
    await fetch(url, {
      method: "GET",

      headers: {
        Accept: "application/json",
        "x-api-key": apiKey,
      },
    });

  const body =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Revenium rates API ${response.status}: ${body}`
    );
  }

  let data;

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(
      "Revenium rates API returned invalid JSON"
    );
  }

  return data;
}


/**
 * Convert pricing response into a model map.
 */
function buildPricingMap(data) {
  const map = {};

  let items = [];

  if (Array.isArray(data)) {
    items = data;
  } else if (Array.isArray(data.content)) {
    items = data.content;
  } else if (Array.isArray(data.models)) {
    items = data.models;
  } else if (Array.isArray(data.data)) {
    items = data.data;
  } else if (Array.isArray(data.rates)) {
    items = data.rates;
  }

  for (const item of items) {
    const rate =
      normalizeRate(item);

    if (!rate) {
      continue;
    }

    map[rate.model] = {
      inputCostPerMillion:
        rate.inputCostPerMillion,

      outputCostPerMillion:
        rate.outputCostPerMillion,

      updatedAt:
        new Date().toISOString(),
    };
  }

  return map;
}


/**
 * Get model pricing.
 *
 * 1. Try KV
 * 2. If missing, query Revenium
 * 3. Cache the model price
 */
async function getModelPricing(
  env,
  apiKey,
  model
) {
  const cacheKey =
    `model:${model}`;

  /*
   * ----------------------------------------
   * KV lookup
   * ----------------------------------------
   */

  if (env.AI_PRICING) {
    try {
      const cached =
        await env.AI_PRICING.get(
          cacheKey,
          "json"
        );

      if (
        cached &&
        Number.isFinite(
          cached.inputCostPerMillion
        ) &&
        Number.isFinite(
          cached.outputCostPerMillion
        )
      ) {
        console.log(
          "[revenium] pricing cache hit:",
          model
        );

        return cached;
      }
    } catch (err) {
      console.warn(
        "[revenium] KV read failed:",
        err?.message || err
      );
    }
  }


  /*
   * ----------------------------------------
   * Revenium pricing API
   * ----------------------------------------
   */

  console.log(
    "[revenium] pricing cache miss:",
    model
  );

  const data =
    await fetchReveniumRates(apiKey);

  const pricingMap =
    buildPricingMap(data);

  const pricing =
    pricingMap[model];


  if (!pricing) {
    console.warn(
      "[revenium] model pricing not found:",
      model
    );

    return null;
  }


  /*
   * ----------------------------------------
   * Cache pricing
   * ----------------------------------------
   */

  if (env.AI_PRICING) {
    try {
      await env.AI_PRICING.put(
        cacheKey,
        JSON.stringify(pricing),
        {
          expirationTtl:
            PRICING_TTL,
        }
      );

      console.log(
        "[revenium] pricing cached:",
        model
      );

    } catch (err) {
      console.warn(
        "[revenium] KV write failed:",
        err?.message || err
      );
    }
  }


  return pricing;
}


/**
 * Calculate cost locally.
 *
 * Rates are assumed to be USD
 * per 1 million tokens.
 */
function calculateCost(
  inputTokenCount,
  outputTokenCount,
  pricing
) {
  if (!pricing) {
    return null;
  }

  const inputTokenCost =
    (
      inputTokenCount *
      pricing.inputCostPerMillion
    ) / 1000000;

  const outputTokenCost =
    (
      outputTokenCount *
      pricing.outputCostPerMillion
    ) / 1000000;

  const totalCost =
    inputTokenCost +
    outputTokenCost;

  return {
    inputTokenCost,
    outputTokenCost,
    totalCost,
  };
}


/**
 * Report usage to Revenium.
 */
export async function reportUsage(
  env,
  {
    model,
    sessionId,
    usage,

    operationType = "CHAT",

    requestStartTime,

    provider,
    modelSource,
  }
) {
  /*
   * ----------------------------------------
   * API key
   * ----------------------------------------
   */

  const apiKey =
    await getReveniumApiKey(env);


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
      "[revenium] REVENIUM_API_KEY not available"
    );

    return;
  }


  /*
   * ----------------------------------------
   * Token usage
   * ----------------------------------------
   */

  const {
    inputTokenCount,
    outputTokenCount,
    totalTokenCount,

    reasoningTokenCount,

    cacheCreationTokenCount,
    cacheReadTokenCount,

  } = normalizeUsage(usage);


  if (
    inputTokenCount === 0 &&
    outputTokenCount === 0 &&
    totalTokenCount === 0
  ) {
    console.warn(
      "[revenium] no token usage found"
    );

    return;
  }


  /*
   * ----------------------------------------
   * Provider
   * ----------------------------------------
   */

  const inferred =
    inferProviderAndSource(model);

  const resolvedProvider =
    provider ||
    inferred.provider;

  const resolvedModelSource =
    modelSource ||
    inferred.modelSource;


  /*
   * ----------------------------------------
   * Pricing
   * ----------------------------------------
   */

  let pricing = null;

  try {
    pricing =
      await getModelPricing(
        env,
        apiKey,
        model
      );
  } catch (err) {
    console.warn(
      "[revenium] pricing lookup failed:",
      err?.message || err
    );
  }


  /*
   * ----------------------------------------
   * Calculate cost
   * ----------------------------------------
   */

  const calculatedCost =
    calculateCost(
      inputTokenCount,
      outputTokenCount,
      pricing
    );


  if (calculatedCost) {
    console.log(
      "[revenium] calculated cost:",
      JSON.stringify({
        model,

        inputTokenCount,
        outputTokenCount,

        inputTokenCost:
          calculatedCost.inputTokenCost,

        outputTokenCost:
          calculatedCost.outputTokenCost,

        totalCost:
          calculatedCost.totalCost,
      })
    );
  } else {
    console.warn(
      "[revenium] cost could not be calculated:",
      model
    );
  }


  /*
   * ----------------------------------------
   * Timing
   * ----------------------------------------
   */

  const requestTime =
    requestStartTime
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
   * ----------------------------------------
   * Transaction ID
   * ----------------------------------------
   */

  const transactionId =
    crypto.randomUUID();


  /*
   * ----------------------------------------
   * Metering payload
   * ----------------------------------------
   */

  const payload = {
    transactionId,

    model:
      model || "unknown",

    provider:
      resolvedProvider,

    modelSource:
      resolvedModelSource,

    inputTokenCount,

    outputTokenCount,

    totalTokenCount,


    /*
     * Our calculated costs.
     */

    ...(calculatedCost
      ? {
          inputTokenCost:
            calculatedCost.inputTokenCost,

          outputTokenCost:
            calculatedCost.outputTokenCost,

          totalCost:
            calculatedCost.totalCost,
        }
      : {}),


    /*
     * Optional reasoning tokens.
     */

    ...(reasoningTokenCount != null
      ? {
          reasoningTokenCount:
            Number(
              reasoningTokenCount
            ),
        }
      : {}),


    /*
     * Optional cache tokens.
     */

    ...(cacheCreationTokenCount != null
      ? {
          cacheCreationTokenCount:
            Number(
              cacheCreationTokenCount
            ),
        }
      : {}),

    ...(cacheReadTokenCount != null
      ? {
          cacheReadTokenCount:
            Number(
              cacheReadTokenCount
            ),
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
     * Existing values.
     */

    organizationName:
      ORGANIZATION_NAME,

    productName:
      PRODUCT_NAME,

    operationType,

    subscriber: {
      id:
        sessionId ||
        "unknown-session",
    },
  };


  /*
   * ----------------------------------------
   * Send metering event
   * ----------------------------------------
   */

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

            calculatedCost,
          })
      );

      return;
    }


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

          calculatedCost,

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
