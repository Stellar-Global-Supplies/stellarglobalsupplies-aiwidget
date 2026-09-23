/**
 * Revenium AI Metering
 *
 * Flow:
 * Worker
 *   ↓
 * Get token usage
 *   ↓
 * Get model pricing from Revenium
 *   ↓
 * Cache pricing in KV
 *   ↓
 * Calculate cost locally
 *   ↓
 * Send tokens + calculated cost to Revenium
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
 * Get Revenium API key
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
 * Detect provider + model source dynamically
 */
function inferProviderAndSource(model) {
  const value = String(model || "").toLowerCase();

  if (value.startsWith("@cf/")) {
    return {
      provider: "cloudflare",
      modelSource: "Cloudflare",
    };
  }

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

  if (
    value.includes("claude") ||
    value.includes("anthropic")
  ) {
    return {
      provider: "Anthropic",
      modelSource: "DIRECT",
    };
  }

  if (
    value.includes("gemini") ||
    value.includes("gemma")
  ) {
    return {
      provider: "Google",
      modelSource: "DIRECT",
    };
  }

  if (value.includes("deepseek")) {
    return {
      provider: "DeepSeek",
      modelSource: "DIRECT",
    };
  }

  if (
    value.includes("mistral") ||
    value.includes("mixtral")
  ) {
    return {
      provider: "Mistral",
      modelSource: "DIRECT",
    };
  }

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
 * Normalize token usage
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
 * Normalize Revenium pricing response
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

  const inputPerMillion = Number(
    item.inputCostPerMillionTokens ??
    item.inputCostPer1M ??
    item.inputRatePerMillionTokens ??
    item.inputPricePerMillionTokens ??
    item.inputCostPerMillion ??
    item.inputCost ??
    0
  );

  const outputPerMillion = Number(
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
 * Fetch pricing from Revenium
 */
async function fetchReveniumRates(apiKey) {
  const url =
    `${REVENIUM_RATES_URL}?teamId=${encodeURIComponent(REVENIUM_TEAM_ID)}`;

  console.log(
    "[revenium] fetching pricing:",
    url
  );

  const response = await fetch(url, {
    method: "GET",

    headers: {
      Accept: "application/json",
      "x-api-key": apiKey,
    },
  });

  const body = await response.text();

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
 * Build pricing map
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

  console.log(
    "[revenium] pricing records received:",
    items.length
  );

  for (const item of items) {
    const rate = normalizeRate(item);

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
 * Get pricing
 *
 * KV first
 * Revenium second
 */
async function getModelPricing(
  env,
  apiKey,
  model
) {
  const cacheKey = `model:${model}`;

  /**
   * KV
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
          Number(cached.inputCostPerMillion)
        ) &&
        Number.isFinite(
          Number(cached.outputCostPerMillion)
        )
      ) {
        console.log(
          "[revenium] pricing cache HIT:",
          model
        );

        console.log(
          "[revenium] cached pricing:",
          JSON.stringify(cached)
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


  /**
   * Revenium
   */
  console.log(
    "[revenium] pricing cache MISS:",
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
      "[revenium] MODEL PRICING NOT FOUND:",
      model
    );

    console.log(
      "[revenium] available pricing models:",
      Object.keys(pricingMap).slice(0, 30)
    );

    return null;
  }


  console.log(
    "[revenium] pricing FOUND:",
    JSON.stringify({
      model,
      inputCostPerMillion:
        pricing.inputCostPerMillion,
      outputCostPerMillion:
        pricing.outputCostPerMillion,
    })
  );


  /**
   * KV cache
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
 * Calculate cost locally
 *
 * Pricing is USD per 1M tokens
 */
function calculateCost(
  inputTokenCount,
  outputTokenCount,
  pricing
) {
  if (!pricing) {
    return null;
  }

  const inputRate =
    Number(
      pricing.inputCostPerMillion
    );

  const outputRate =
    Number(
      pricing.outputCostPerMillion
    );


  const inputTokenCost =
    (
      Number(inputTokenCount) *
      inputRate
    ) / 1000000;


  const outputTokenCost =
    (
      Number(outputTokenCount) *
      outputRate
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
 * Report usage to Revenium
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

  /**
   * API key
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


  /**
   * Tokens
   */
  const {
    inputTokenCount,
    outputTokenCount,
    totalTokenCount,

    reasoningTokenCount,

    cacheCreationTokenCount,
    cacheReadTokenCount,

  } = normalizeUsage(usage);


  console.log(
    "[revenium] TOKEN USAGE:",
    JSON.stringify({
      model,
      inputTokenCount,
      outputTokenCount,
      totalTokenCount,
    })
  );


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


  /**
   * Provider
   */
  const inferred =
    inferProviderAndSource(model);

  const resolvedProvider =
    provider ||
    inferred.provider;

  const resolvedModelSource =
    modelSource ||
    inferred.modelSource;


  /**
   * Pricing
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
      "[revenium] pricing lookup FAILED:",
      err?.message || err
    );
  }


  /**
   * Local cost calculation
   */
  const calculatedCost =
    calculateCost(
      inputTokenCount,
      outputTokenCount,
      pricing
    );


  /**
   * IMPORTANT DEBUG LOG
   *
   * This tells us exactly what Worker calculated.
   */
  console.log(
    "[revenium] FINAL PRICING:",
    JSON.stringify(
      pricing
    )
  );


  console.log(
    "[revenium] FINAL COST:",
    JSON.stringify(
      calculatedCost
    )
  );


  if (calculatedCost) {

    console.log(
      "[revenium] COST VALUES:",
      JSON.stringify({
        inputTokenCost:
          calculatedCost.inputTokenCost,

        outputTokenCost:
          calculatedCost.outputTokenCost,

        totalCost:
          calculatedCost.totalCost,

        inputTokenCostFixed:
          calculatedCost.inputTokenCost.toFixed(12),

        outputTokenCostFixed:
          calculatedCost.outputTokenCost.toFixed(12),

        totalCostFixed:
          calculatedCost.totalCost.toFixed(12),
      })
    );

  } else {

    console.warn(
      "[revenium] COST NOT CALCULATED"
    );

  }


  /**
   * Timing
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


  /**
   * Transaction ID
   */
  const transactionId =
    crypto.randomUUID();


  /**
   * Payload
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


    /**
     * Explicit cost values
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


    /**
     * Reasoning tokens
     */
    ...(reasoningTokenCount != null
      ? {
          reasoningTokenCount:
            Number(
              reasoningTokenCount
            ),
        }
      : {}),


    /**
     * Cache tokens
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


    /**
     * Timing
     */
    requestTime:
      requestTime.toISOString(),

    completionStartTime:
      completionStartTime.toISOString(),

    responseTime:
      responseTime.toISOString(),

    requestDuration,


    /**
     * Status
     */
    stopReason:
      "STOP",


    /**
     * Existing values
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


  /**
   * DEBUG:
   * Show exactly what is being sent.
   */
  console.log(
    "[revenium] FINAL COST PAYLOAD:",
    JSON.stringify({
      model:
        payload.model,

      inputTokenCount:
        payload.inputTokenCount,

      outputTokenCount:
        payload.outputTokenCount,

      totalTokenCount:
        payload.totalTokenCount,

      inputTokenCost:
        payload.inputTokenCost,

      outputTokenCost:
        payload.outputTokenCost,

      totalCost:
        payload.totalCost,
    })
  );


  /**
   * Metering request
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
        "[revenium] metering call FAILED:",
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

          inputTokenCost:
            calculatedCost?.inputTokenCost,

          outputTokenCost:
            calculatedCost?.outputTokenCost,

          totalCost:
            calculatedCost?.totalCost,
        })
      );

      return;
    }


    /**
     * Success
     */
    console.log(
      "[revenium] metering call SUCCESS:",
      JSON.stringify({
        status:
          response.status,

        body,

        model,

        provider:
          resolvedProvider,

        modelSource:
          resolvedModelSource,

        inputTokenCount,

        outputTokenCount,

        totalTokenCount,

        inputTokenCost:
          calculatedCost?.inputTokenCost,

        outputTokenCost:
          calculatedCost?.outputTokenCost,

        totalCost:
          calculatedCost?.totalCost,

        transactionId,
      })
    );

  } catch (err) {

    console.warn(
      "[revenium] metering call ERROR:",
      err?.message || err
    );

  }
}
