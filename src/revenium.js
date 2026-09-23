/**
 * Revenium AI metering + LiteLLM pricing
 *
 * Flow:
 *   AI response
 *      ↓
 *   normalize token usage
 *      ↓
 *   KV pricing cache
 *      ↓ cache miss
 *   LiteLLM Model Catalog
 *      ↓
 *   calculate input/output/total cost locally
 *      ↓
 *   Revenium metering
 *
 * Required:
 *   REVENIUM_API_KEY
 *
 * Optional:
 *   REVENIUM_PRICING_CACHE  -> Cloudflare KV binding
 *
 * Existing values intentionally preserved:
 *   Organization: Stellar Global Supplies
 *   Product: stellar-ai-widget
 */

const REVENIUM_METERING_URL =
  "https://api.revenium.ai/meter/v2/ai/completions";

const LITELLM_CATALOG_URL =
  "https://api.litellm.ai/model_catalog";

const ORGANIZATION_ID = "Stellar Global Supplies";
const PRODUCT_ID = "stellar-ai-widget";

const PRICING_CACHE_TTL = 86400; // 24 hours
const LITELLM_PAGE_SIZE = 500;
const MAX_PRICING_PAGES = 10;

/**
 * Resolve Revenium API key.
 * Supports Cloudflare Secrets Store and normal string secrets.
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
      return value ? String(value).trim() : null;
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
 * Infer provider + model source.
 *
 * Explicit provider/modelSource passed by the caller always wins.
 *
 * Examples:
 *
 * @cf/meta/llama...       -> Cloudflare / Cloudflare
 * @cf/deepseek/...        -> Cloudflare / Cloudflare
 * amazon/...              -> Amazon / Amazon Bedrock
 * anthropic/...            -> Anthropic / DIRECT
 * claude-*                -> Anthropic / DIRECT
 * gpt-*                   -> OpenAI / DIRECT
 * gemini-*                -> Google / DIRECT
 * groq/...                -> Groq / Groq
 */
function inferProviderAndSource(model) {
  const value = String(model || "").trim();
  const lower = value.toLowerCase();

  // Cloudflare Workers AI
  if (lower.startsWith("@cf/")) {
    return {
      provider: "Cloudflare",
      modelSource: "Cloudflare",
      litellmProvider: "cloudflare",
    };
  }

  // Groq
  if (lower.startsWith("groq/") || lower.includes("groq")) {
    return {
      provider: "Groq",
      modelSource: "Groq",
      litellmProvider: "groq",
    };
  }

  // AWS Bedrock
  if (
    lower.startsWith("bedrock/") ||
    lower.startsWith("us.") ||
    lower.startsWith("eu.") ||
    lower.startsWith("ap.") ||
    lower.includes("anthropic.claude") ||
    lower.includes("amazon.") ||
    lower.includes("meta.llama") ||
    lower.includes("mistral.")
  ) {
    let provider = "Amazon Bedrock";

    if (lower.includes("anthropic.claude")) {
      provider = "Anthropic";
    } else if (lower.includes("amazon.")) {
      provider = "Amazon";
    } else if (lower.includes("meta.llama")) {
      provider = "Meta";
    } else if (lower.includes("mistral.")) {
      provider = "Mistral";
    }

    return {
      provider,
      modelSource: "Amazon Bedrock",
      litellmProvider: "bedrock",
    };
  }

  // OpenAI
  if (
    lower.includes("gpt-") ||
    lower.startsWith("openai/") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  ) {
    return {
      provider: "OpenAI",
      modelSource: "DIRECT",
      litellmProvider: "openai",
    };
  }

  // Anthropic
  if (
    lower.includes("claude") ||
    lower.startsWith("anthropic/")
  ) {
    return {
      provider: "Anthropic",
      modelSource: "DIRECT",
      litellmProvider: "anthropic",
    };
  }

  // Google
  if (
    lower.includes("gemini") ||
    lower.startsWith("google/")
  ) {
    return {
      provider: "Google",
      modelSource: "DIRECT",
      litellmProvider: "gemini",
    };
  }

  // Mistral
  if (
    lower.includes("mistral") ||
    lower.includes("mixtral")
  ) {
    return {
      provider: "Mistral",
      modelSource: "DIRECT",
      litellmProvider: "mistral",
    };
  }

  // DeepSeek
  if (
    lower.includes("deepseek")
  ) {
    return {
      provider: "DeepSeek",
      modelSource: "DIRECT",
      litellmProvider: "deepseek",
    };
  }

  // Qwen
  if (
    lower.includes("qwen")
  ) {
    return {
      provider: "Qwen",
      modelSource: "DIRECT",
      litellmProvider: "qwen",
    };
  }

  return {
    provider: "Unknown",
    modelSource: "DIRECT",
    litellmProvider: null,
  };
}

/**
 * Normalize a model name for matching.
 */
function normalizeModelName(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^cloudflare\//, "")
    .replace(/^cloudflare-workers-ai\//, "");
}

/**
 * Create stable KV cache key.
 */
function pricingCacheKey(provider, model) {
  return `revenium:pricing:${String(provider || "unknown").toLowerCase()}:${normalizeModelName(model)}`;
}

/**
 * Find the exact model inside LiteLLM catalog results.
 */
function findExactModel(data, requestedModel) {
  if (!Array.isArray(data)) {
    return null;
  }

  const requested = normalizeModelName(requestedModel);

  // First: exact ID
  let match = data.find(
    (item) =>
      normalizeModelName(item?.id) === requested
  );

  if (match) {
    return match;
  }

  // Second: provider/model combinations
  match = data.find((item) => {
    const id = normalizeModelName(item?.id);
    const modelName = normalizeModelName(item?.model_name);
    const baseModel = normalizeModelName(item?.base_model);

    return (
      id === requested ||
      modelName === requested ||
      baseModel === requested
    );
  });

  if (match) {
    return match;
  }

  // Third: exact suffix match
  match = data.find((item) => {
    const id = normalizeModelName(item?.id);

    return (
      id.endsWith(`/${requested}`) ||
      requested.endsWith(`/${id}`)
    );
  });

  return match || null;
}

/**
 * Fetch pricing from LiteLLM.
 *
 * Uses:
 *   provider
 *   model
 *   pagination
 *
 * The first request normally finds the model immediately.
 * Pagination is still implemented as a fallback.
 */
async function fetchLiteLLMPricing(model, litellmProvider) {
  const provider = litellmProvider || null;

  for (
    let page = 1;
    page <= MAX_PRICING_PAGES;
    page++
  ) {
    const url = new URL(LITELLM_CATALOG_URL);

    if (provider) {
      url.searchParams.set("provider", provider);
    }

    // Ask LiteLLM to filter by model.
    url.searchParams.set("model", model);

    url.searchParams.set(
      "page",
      String(page)
    );

    url.searchParams.set(
      "page_size",
      String(LITELLM_PAGE_SIZE)
    );

    console.log(
      "[pricing] LiteLLM request:",
      JSON.stringify({
        provider,
        model,
        page,
        pageSize: LITELLM_PAGE_SIZE,
      })
    );

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");

      throw new Error(
        `LiteLLM catalog ${response.status}: ${body}`
      );
    }

    const result = await response.json();

    const data = Array.isArray(result?.data)
      ? result.data
      : [];

    const match = findExactModel(
      data,
      model
    );

    if (match) {
      const inputCost =
        Number(match.input_cost_per_token);

      const outputCost =
        Number(match.output_cost_per_token);

      if (
        Number.isFinite(inputCost) &&
        Number.isFinite(outputCost)
      ) {
        return {
          model: match.id || model,
          provider:
            match.provider || provider || null,

          inputCostPerToken: inputCost,
          outputCostPerToken: outputCost,

          cacheReadCostPerToken:
            Number.isFinite(
              Number(match.cache_read_input_token_cost)
            )
              ? Number(match.cache_read_input_token_cost)
              : null,

          cacheCreationCostPerToken:
            Number.isFinite(
              Number(match.cache_creation_input_token_cost)
            )
              ? Number(match.cache_creation_input_token_cost)
              : null,

          source: "litellm",
          fetchedAt: new Date().toISOString(),
        };
      }
    }

    const hasMore = result?.has_more === true;

    if (!hasMore) {
      break;
    }
  }

  return null;
}

/**
 * Get pricing from KV first.
 *
 * KV is optional. If KV is not configured, the Worker
 * simply calls LiteLLM directly.
 */
async function getModelPricing(
  env,
  model,
  litellmProvider
) {
  const cache = env.REVENIUM_PRICING_CACHE;

  const cacheKey = pricingCacheKey(
    litellmProvider,
    model
  );

  // ------------------------------------------
  // 1. KV CACHE
  // ------------------------------------------
  if (cache) {
    try {
      const cached =
        await cache.get(cacheKey, "json");

      if (
        cached &&
        Number.isFinite(
          Number(cached.inputCostPerToken)
        ) &&
        Number.isFinite(
          Number(cached.outputCostPerToken)
        )
      ) {
        console.log(
          "[pricing] cache HIT:",
          model
        );

        return cached;
      }

      console.log(
        "[pricing] cache MISS:",
        model
      );
    } catch (err) {
      console.warn(
        "[pricing] KV read failed:",
        err?.message || err
      );
    }
  } else {
    console.warn(
      "[pricing] REVENIUM_PRICING_CACHE not configured — using LiteLLM directly"
    );
  }

  // ------------------------------------------
  // 2. LITELLM
  // ------------------------------------------
  try {
    const pricing =
      await fetchLiteLLMPricing(
        model,
        litellmProvider
      );

    if (!pricing) {
      console.warn(
        "[pricing] LiteLLM pricing not found:",
        model
      );

      return null;
    }

    console.log(
      "[pricing] LiteLLM pricing FOUND:",
      JSON.stringify({
        model,
        provider: litellmProvider,
        inputCostPerToken:
          pricing.inputCostPerToken,
        outputCostPerToken:
          pricing.outputCostPerToken,
      })
    );

    // ------------------------------------------
    // 3. CACHE FOR 24 HOURS
    // ------------------------------------------
    if (cache) {
      try {
        await cache.put(
          cacheKey,
          JSON.stringify(pricing),
          {
            expirationTtl:
              PRICING_CACHE_TTL,
          }
        );

        console.log(
          "[pricing] cached for 24h:",
          model
        );
      } catch (err) {
        console.warn(
          "[pricing] KV write failed:",
          err?.message || err
        );
      }
    }

    return pricing;
  } catch (err) {
    console.warn(
      "[pricing] LiteLLM lookup FAILED:",
      err?.message || err
    );

    return null;
  }
}

/**
 * Calculate AI cost locally.
 *
 * DO NOT round to cents here.
 *
 * Revenium accepts decimal USD values and we want
 * to preserve very small AI costs.
 */
function calculateCost(
  inputTokenCount,
  outputTokenCount,
  pricing
) {
  if (!pricing) {
    return null;
  }

  const inputCost =
    Number(inputTokenCount || 0) *
    Number(pricing.inputCostPerToken || 0);

  const outputCost =
    Number(outputTokenCount || 0) *
    Number(pricing.outputCostPerToken || 0);

  const totalCost =
    inputCost + outputCost;

  return {
    inputTokenCost: inputCost,
    outputTokenCost: outputCost,
    totalCost,
  };
}

/**
 * Report one AI call to Revenium.
 *
 * Existing callers continue to work:
 *
 * reportUsage(env, {
 *   model,
 *   sessionId,
 *   usage,
 *   operationType,
 *   requestStartTime
 * })
 *
 * Optional:
 *
 * provider
 * modelSource
 */
export async function reportUsage(
  env,
  {
    model,
    sessionId,
    usage,
    operationType = "CHAT",
    requestStartTime,

    // Optional explicit values.
    provider,
    modelSource,
  }
) {
  const apiKey =
    await getReveniumApiKey(env);

  if (!apiKey) {
    console.warn(
      "[revenium] REVENIUM_API_KEY not available — skipping usage report"
    );
    return;
  }

  // ------------------------------------------
  // TOKEN USAGE
  // ------------------------------------------
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
      "[revenium] no token usage found — skipping usage report"
    );
    return;
  }

  // ------------------------------------------
  // PROVIDER + MODEL SOURCE
  // ------------------------------------------
  const inferred =
    inferProviderAndSource(model);

  const resolvedProvider =
    provider || inferred.provider;

  const resolvedModelSource =
    modelSource || inferred.modelSource;

  const litellmProvider =
    inferred.litellmProvider;

  // ------------------------------------------
  // PRICING
  // ------------------------------------------
  const pricing =
    await getModelPricing(
      env,
      model,
      litellmProvider
    );

  const cost =
    calculateCost(
      inputTokenCount,
      outputTokenCount,
      pricing
    );

  if (cost) {
    console.log(
      "[pricing] CALCULATED COST:",
      JSON.stringify({
        model,
        provider: resolvedProvider,
        modelSource: resolvedModelSource,

        inputTokenCount,
        outputTokenCount,

        inputCostPerToken:
          pricing.inputCostPerToken,

        outputCostPerToken:
          pricing.outputCostPerToken,

        inputTokenCost:
          cost.inputTokenCost,

        outputTokenCost:
          cost.outputTokenCost,

        totalCost:
          cost.totalCost,
      })
    );
  } else {
    console.warn(
      "[pricing] cost could not be calculated:",
      model
    );
  }

  // ------------------------------------------
  // TIMING
  // ------------------------------------------
  const now = new Date();

  const requestTime =
    requestStartTime
      ? new Date(requestStartTime)
      : now;

  const responseTime = now;

  const requestDuration =
    Math.max(
      1,
      responseTime.getTime() -
        requestTime.getTime()
    );

  const transactionId =
    crypto.randomUUID();

  // ------------------------------------------
  // REVENIUM PAYLOAD
  // ------------------------------------------
  const payload = {
    transactionId,

    model: model || "unknown",

    provider:
      resolvedProvider,

    modelSource:
      resolvedModelSource,

    inputTokenCount,

    outputTokenCount,

    totalTokenCount,

    ...(reasoningTokenCount != null
      ? {
          reasoningTokenCount,
        }
      : {}),

    ...(cacheCreationTokenCount != null
      ? {
          cacheCreationTokenCount,
        }
      : {}),

    ...(cacheReadTokenCount != null
      ? {
          cacheReadTokenCount,
        }
      : {}),

    // ----------------------------------------
    // OUR CALCULATED COST
    // ----------------------------------------
    ...(cost
      ? {
          inputTokenCost:
            cost.inputTokenCost,

          outputTokenCost:
            cost.outputTokenCost,

          totalCost:
            cost.totalCost,

          costType: "AI",
        }
      : {}),

    requestTime:
      requestTime.toISOString(),

    completionStartTime:
      responseTime.toISOString(),

    responseTime:
      responseTime.toISOString(),

    requestDuration,

    stopReason: "STOP",

    organizationName:
      ORGANIZATION_ID,

    productName:
      PRODUCT_ID,

    operationType,

    subscriber: {
      id:
        sessionId ||
        "unknown-session",
    },
  };

  console.log(
    "[revenium] FINAL COST PAYLOAD:",
    JSON.stringify({
      model: payload.model,
      provider: payload.provider,
      modelSource: payload.modelSource,

      inputTokenCount:
        payload.inputTokenCount,

      outputTokenCount:
        payload.outputTokenCount,

      totalTokenCount:
        payload.totalTokenCount,

      inputTokenCost:
        payload.inputTokenCost ?? null,

      outputTokenCost:
        payload.outputTokenCost ?? null,

      totalCost:
        payload.totalCost ?? null,
    })
  );

  // ------------------------------------------
  // REVENIUM METERING
  // ------------------------------------------
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
            JSON.stringify(payload),
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

          model:
            payload.model,

          provider:
            payload.provider,

          modelSource:
            payload.modelSource,

          inputTokenCount:
            payload.inputTokenCount,

          outputTokenCount:
            payload.outputTokenCount,

          totalTokenCount:
            payload.totalTokenCount,

          totalCost:
            payload.totalCost ?? null,
        })
      );

      return;
    }

    console.log(
      "[revenium] metering call SUCCESS:",
      JSON.stringify({
        status:
          response.status,

        model:
          payload.model,

        provider:
          payload.provider,

        modelSource:
          payload.modelSource,

        inputTokenCount:
          payload.inputTokenCount,

        outputTokenCount:
          payload.outputTokenCount,

        totalTokenCount:
          payload.totalTokenCount,

        inputTokenCost:
          payload.inputTokenCost ?? null,

        outputTokenCost:
          payload.outputTokenCost ?? null,

        totalCost:
          payload.totalCost ?? null,

        transactionId,
      })
    );
  } catch (err) {
    // Never allow Revenium/LiteLLM/KV issues
    // to break the actual AI request.
    console.warn(
      "[revenium] metering call errored:",
      err?.message || err
    );
  }
}

/**
 * Normalize Workers AI / provider usage.
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

  const inputTokenCount =
    Number(
      usage.prompt_tokens ??
        usage.input_tokens ??
        usage.inputTokenCount ??
        0
    );

  const outputTokenCount =
    Number(
      usage.completion_tokens ??
        usage.output_tokens ??
        usage.outputTokenCount ??
        0
    );

  const totalTokenCount =
    Number(
      usage.total_tokens ??
        usage.totalTokenCount ??
        (inputTokenCount +
          outputTokenCount)
    );

  const reasoningTokenCount =
    usage.reasoning_tokens ??
    usage.reasoningTokenCount ??
    null;

  const cacheCreationTokenCount =
    usage.cache_creation_input_tokens ??
    usage.cacheCreationTokenCount ??
    null;

  const cacheReadTokenCount =
    usage.cache_read_input_tokens ??
    usage.cacheReadTokenCount ??
    null;

  return {
    inputTokenCount,
    outputTokenCount,
    totalTokenCount,
    reasoningTokenCount:
      reasoningTokenCount != null
        ? Number(reasoningTokenCount)
        : null,

    cacheCreationTokenCount:
      cacheCreationTokenCount != null
        ? Number(cacheCreationTokenCount)
        : null,

    cacheReadTokenCount:
      cacheReadTokenCount != null
        ? Number(cacheReadTokenCount)
        : null,
  };
}
