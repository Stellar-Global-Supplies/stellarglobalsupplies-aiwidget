/**
 * Revenium AI Metering
 *
 * Flow:
 *
 * Worker
 *   ↓
 * Token usage
 *   ↓
 * Cloudflare KV pricing cache
 *   ↓
 * Cache miss
 *   ↓
 * Revenium paginated AI Model Catalog
 *   ↓
 * Find exact model
 *   ↓
 * Get inputCostPerToken / outputCostPerToken
 *   ↓
 * Calculate cost locally
 *   ↓
 * POST metering event to Revenium
 */

const REVENIUM_METERING_URL =
  "https://api.revenium.ai/meter/v2/ai/completions";

const REVENIUM_MODELS_URL =
  "https://api.revenium.ai/profitstream/v2/api/sources/ai/models";

const REVENIUM_TEAM_ID = "5WJ6rl";

const ORGANIZATION_NAME =
  "Stellar Global Supplies";

const PRODUCT_NAME =
  "stellar-ai-widget";

/*
 * Pricing cache lifetime:
 * 24 hours
 */
const PRICING_TTL = 86400;

/*
 * Number of models requested per page.
 */
const PRICING_PAGE_SIZE = 100;

/*
 * Safety limit so a broken pagination response
 * cannot cause an endless Worker loop.
 */
const MAX_PRICING_PAGES = 50;


/**
 * ---------------------------------------------------------
 * Resolve Revenium API key
 * ---------------------------------------------------------
 */
async function getReveniumApiKey(env) {
  const binding =
    env.REVENIUM_API_KEY;

  if (!binding) {
    return null;
  }

  if (typeof binding === "string") {
    return binding.trim();
  }

  if (
    typeof binding.get === "function"
  ) {
    try {
      const value =
        await binding.get();

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
 * ---------------------------------------------------------
 * Detect provider and model source dynamically
 * ---------------------------------------------------------
 */
function inferProviderAndSource(model) {
  const value =
    String(model || "").toLowerCase();

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
  if (
    value.includes("deepseek")
  ) {
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
  if (
    value.includes("llama")
  ) {
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
 * ---------------------------------------------------------
 * Normalize token usage
 * ---------------------------------------------------------
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
      usage.promptTokens ??
      0
    );

  const outputTokenCount =
    Number(
      usage.completion_tokens ??
      usage.output_tokens ??
      usage.outputTokenCount ??
      usage.completionTokens ??
      0
    );

  const totalTokenCount =
    Number(
      usage.total_tokens ??
      usage.totalTokenCount ??
      usage.totalTokens ??
      (
        inputTokenCount +
        outputTokenCount
      )
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
 * ---------------------------------------------------------
 * Extract model records from different response formats
 * ---------------------------------------------------------
 *
 * Revenium uses a paginated response.
 *
 * Depending on content type / API representation,
 * records may appear under:
 *
 *   content
 *   data
 *   models
 *   _embedded
 *
 */
function extractModelItems(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (
    Array.isArray(data?.content)
  ) {
    return data.content;
  }

  if (
    Array.isArray(data?.data)
  ) {
    return data.data;
  }

  if (
    Array.isArray(data?.models)
  ) {
    return data.models;
  }

  /*
   * HAL style response
   */
  if (
    data?._embedded &&
    typeof data._embedded === "object"
  ) {
    const embedded =
      data._embedded;

    for (
      const key of Object.keys(embedded)
    ) {
      if (
        Array.isArray(
          embedded[key]
        )
      ) {
        return embedded[key];
      }
    }
  }

  return [];
}


/**
 * ---------------------------------------------------------
 * Determine pagination state
 * ---------------------------------------------------------
 */
function getPaginationInfo(
  data,
  currentPage,
  receivedCount
) {
  const totalPages =
    Number(
      data?.totalPages ??
      data?.page?.totalPages ??
      NaN
    );

  const totalElements =
    Number(
      data?.totalElements ??
      data?.page?.totalElements ??
      NaN
    );

  const pageNumber =
    Number(
      data?.number ??
      data?.page?.number ??
      currentPage
    );

  const pageSize =
    Number(
      data?.size ??
      data?.page?.size ??
      PRICING_PAGE_SIZE
    );

  /*
   * Explicit "last" flag.
   */
  if (
    data?.last === true ||
    data?.page?.last === true
  ) {
    return {
      hasNext: false,
      totalPages,
      totalElements,
    };
  }

  /*
   * Explicit total pages.
   */
  if (
    Number.isFinite(totalPages)
  ) {
    return {
      hasNext:
        currentPage + 1 <
        totalPages,

      totalPages,
      totalElements,
    };
  }

  /*
   * HAL next link.
   */
  const nextLink =
    data?._links?.next?.href;

  if (nextLink) {
    return {
      hasNext: true,
      totalPages,
      totalElements,
    };
  }

  /*
   * If the page returned fewer records
   * than requested, assume this is the last page.
   */
  if (
    receivedCount <
    pageSize
  ) {
    return {
      hasNext: false,
      totalPages,
      totalElements,
    };
  }

  /*
   * Otherwise continue.
   */
  return {
    hasNext: true,
    totalPages,
    totalElements,
  };
}


/**
 * ---------------------------------------------------------
 * Fetch ONE Revenium model page
 * ---------------------------------------------------------
 */
async function fetchModelPage(
  apiKey,
  model,
  page
) {
  const params =
    new URLSearchParams();

  params.set(
    "teamId",
    REVENIUM_TEAM_ID
  );

  /*
   * Search specifically for the model.
   *
   * This dramatically reduces the number
   * of pages we need to inspect.
   */
  params.set(
    "query",
    model
  );

  params.set(
    "page",
    String(page)
  );

  params.set(
    "size",
    String(PRICING_PAGE_SIZE)
  );

  const url =
    `${REVENIUM_MODELS_URL}?${params.toString()}`;

  console.log(
    "[revenium] model catalog request:",
    JSON.stringify({
      page,
      size:
        PRICING_PAGE_SIZE,
      model,
    })
  );

  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          Accept:
            "application/json",

          "x-api-key":
            apiKey,
        },
      }
    );

  const body =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Revenium model API ${response.status}: ${body}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(body);

  } catch {
    throw new Error(
      "Revenium model API returned invalid JSON"
    );
  }

  return data;
}


/**
 * ---------------------------------------------------------
 * Extract pricing from a model record
 * ---------------------------------------------------------
 */
function extractModelPricing(item) {
  if (
    !item ||
    typeof item !== "object"
  ) {
    return null;
  }

  /*
   * Model name
   */
  const modelName =
    item.name ??
    item.model ??
    item.modelName ??
    item.aiModel?.name;


  if (!modelName) {
    return null;
  }


  /*
   * Revenium model catalog uses
   *
   * inputCostPerToken
   * outputCostPerToken
   *
   * These are USD per token.
   */
  const inputCostPerToken =
    Number(
      item.inputCostPerToken ??
      item.aiModel?.inputCostPerToken ??
      NaN
    );

  const outputCostPerToken =
    Number(
      item.outputCostPerToken ??
      item.aiModel?.outputCostPerToken ??
      NaN
    );


  if (
    !Number.isFinite(
      inputCostPerToken
    ) ||
    !Number.isFinite(
      outputCostPerToken
    )
  ) {
    return null;
  }


  return {
    model:
      String(modelName),

    provider:
      item.provider ??
      item.aiModel?.provider ??
      null,

    mode:
      item.mode ??
      item.aiModel?.mode ??
      null,

    inputCostPerToken,

    outputCostPerToken,

    /*
     * Optional cache pricing
     */
    cacheCreationCostPerInputToken:
      Number(
        item.cacheCreationCostPerInputToken ??
        item.aiModel?.cacheCreationCostPerInputToken ??
        0
      ),

    cacheReadCostPerInputToken:
      Number(
        item.cacheReadCostPerInputToken ??
        item.aiModel?.cacheReadCostPerInputToken ??
        0
      ),

    updatedAt:
      new Date().toISOString(),
  };
}


/**
 * ---------------------------------------------------------
 * Find exact model using PAGINATION
 * ---------------------------------------------------------
 */
async function fetchModelPricingFromRevenium(
  apiKey,
  model
) {
  let page = 0;

  while (
    page <
    MAX_PRICING_PAGES
  ) {
    const data =
      await fetchModelPage(
        apiKey,
        model,
        page
      );

    const items =
      extractModelItems(
        data
      );


    console.log(
      "[revenium] model page:",
      JSON.stringify({
        page,
        records:
          items.length,
      })
    );


    /*
     * First look for exact match.
     */
    for (
      const item of items
    ) {
      const itemName =
        String(
          item.name ??
          item.model ??
          item.modelName ??
          item.aiModel?.name ??
          ""
        );

      if (
        itemName === model
      ) {
        const pricing =
          extractModelPricing(
            item
          );

        if (pricing) {
          console.log(
            "[revenium] EXACT MODEL FOUND:",
            JSON.stringify({
              model:
                pricing.model,

              provider:
                pricing.provider,

              inputCostPerToken:
                pricing.inputCostPerToken,

              outputCostPerToken:
                pricing.outputCostPerToken,
            })
          );

          return pricing;
        }
      }
    }


    /*
     * Check pagination.
     */
    const pagination =
      getPaginationInfo(
        data,
        page,
        items.length
      );


    console.log(
      "[revenium] pagination:",
      JSON.stringify({
        page,
        hasNext:
          pagination.hasNext,

        totalPages:
          pagination.totalPages,

        totalElements:
          pagination.totalElements,
      })
    );


    if (
      !pagination.hasNext
    ) {
      break;
    }


    page++;
  }


  console.warn(
    "[revenium] exact model not found:",
    model
  );

  return null;
}


/**
 * ---------------------------------------------------------
 * Get model pricing
 *
 * 1. KV
 * 2. Revenium API
 * 3. KV write
 * ---------------------------------------------------------
 */
async function getModelPricing(
  env,
  apiKey,
  model
) {
  const cacheKey =
    `model:${model}`;


  /*
   * -------------------------------------------------------
   * KV CACHE
   * -------------------------------------------------------
   */
  if (
    env.AI_PRICING
  ) {
    try {
      const cached =
        await env.AI_PRICING.get(
          cacheKey,
          "json"
        );


      if (
        cached &&
        Number.isFinite(
          Number(
            cached.inputCostPerToken
          )
        ) &&
        Number.isFinite(
          Number(
            cached.outputCostPerToken
          )
        )
      ) {
        console.log(
          "[revenium] pricing cache HIT:",
          model
        );

        console.log(
          "[revenium] cached pricing:",
          JSON.stringify(
            cached
          )
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
   * -------------------------------------------------------
   * REVENIUM MODEL CATALOG
   * -------------------------------------------------------
   */
  console.log(
    "[revenium] pricing cache MISS:",
    model
  );


  const pricing =
    await fetchModelPricingFromRevenium(
      apiKey,
      model
    );


  if (!pricing) {
    return null;
  }


  /*
   * -------------------------------------------------------
   * CACHE
   * -------------------------------------------------------
   */
  if (
    env.AI_PRICING
  ) {
    try {
      await env.AI_PRICING.put(
        cacheKey,
        JSON.stringify(
          pricing
        ),
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
 * ---------------------------------------------------------
 * Calculate cost
 *
 * Revenium gives price PER TOKEN.
 * ---------------------------------------------------------
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
      pricing.inputCostPerToken
    );

  const outputRate =
    Number(
      pricing.outputCostPerToken
    );


  if (
    !Number.isFinite(
      inputRate
    ) ||
    !Number.isFinite(
      outputRate
    )
  ) {
    return null;
  }


  const inputTokenCost =
    Number(inputTokenCount) *
    inputRate;


  const outputTokenCost =
    Number(outputTokenCount) *
    outputRate;


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
 * ---------------------------------------------------------
 * Report usage to Revenium
 * ---------------------------------------------------------
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
   * -------------------------------------------------------
   * API KEY
   * -------------------------------------------------------
   */
  const apiKey =
    await getReveniumApiKey(
      env
    );


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
   * -------------------------------------------------------
   * TOKEN USAGE
   * -------------------------------------------------------
   */
  const {
    inputTokenCount,
    outputTokenCount,
    totalTokenCount,

    reasoningTokenCount,

    cacheCreationTokenCount,
    cacheReadTokenCount,

  } = normalizeUsage(
    usage
  );


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


  /*
   * -------------------------------------------------------
   * PROVIDER
   * -------------------------------------------------------
   */
  const inferred =
    inferProviderAndSource(
      model
    );


  const resolvedProvider =
    provider ||
    inferred.provider;


  const resolvedModelSource =
    modelSource ||
    inferred.modelSource;


  /*
   * -------------------------------------------------------
   * PRICING
   * -------------------------------------------------------
   */
  let pricing =
    null;


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


  /*
   * -------------------------------------------------------
   * CALCULATE COST
   * -------------------------------------------------------
   */
  const calculatedCost =
    calculateCost(
      inputTokenCount,
      outputTokenCount,
      pricing
    );


  /*
   * -------------------------------------------------------
   * DEBUG PRICING
   * -------------------------------------------------------
   */
  console.log(
    "[revenium] FINAL PRICING:",
    JSON.stringify(
      pricing
    )
  );


  /*
   * -------------------------------------------------------
   * DEBUG COST
   * -------------------------------------------------------
   */
  console.log(
    "[revenium] FINAL COST:",
    JSON.stringify(
      calculatedCost
    )
  );


  if (
    calculatedCost
  ) {

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
          calculatedCost.inputTokenCost.toFixed(
            12
          ),

        outputTokenCostFixed:
          calculatedCost.outputTokenCost.toFixed(
            12
          ),

        totalCostFixed:
          calculatedCost.totalCost.toFixed(
            12
          ),
      })
    );

  } else {

    console.warn(
      "[revenium] cost could not be calculated:",
      model
    );

  }


  /*
   * -------------------------------------------------------
   * TIMING
   * -------------------------------------------------------
   */
  const requestTime =
    requestStartTime
      ? new Date(
          requestStartTime
        )
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
   * -------------------------------------------------------
   * TRANSACTION ID
   * -------------------------------------------------------
   */
  const transactionId =
    crypto.randomUUID();


  /*
   * -------------------------------------------------------
   * PAYLOAD
   * -------------------------------------------------------
   */
  const payload = {
    transactionId,

    model:
      model ||
      "unknown",

    provider:
      resolvedProvider,

    modelSource:
      resolvedModelSource,


    /*
     * Tokens
     */
    inputTokenCount,

    outputTokenCount,

    totalTokenCount,


    /*
     * Calculated costs
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
     * Reasoning
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
     * Cache creation
     */
    ...(cacheCreationTokenCount != null
      ? {
          cacheCreationTokenCount:
            Number(
              cacheCreationTokenCount
            ),
        }
      : {}),


    /*
     * Cache read
     */
    ...(cacheReadTokenCount != null
      ? {
          cacheReadTokenCount:
            Number(
              cacheReadTokenCount
            ),
        }
      : {}),


    /*
     * Timing
     */
    requestTime:
      requestTime.toISOString(),

    completionStartTime:
      completionStartTime.toISOString(),

    responseTime:
      responseTime.toISOString(),

    requestDuration,


    /*
     * Status
     */
    stopReason:
      "STOP",


    /*
     * Existing organization/product
     */
    organizationName:
      ORGANIZATION_NAME,

    productName:
      PRODUCT_NAME,

    operationType,


    /*
     * Subscriber
     */
    subscriber: {
      id:
        sessionId ||
        "unknown-session",
    },
  };


  /*
   * -------------------------------------------------------
   * FINAL PAYLOAD DEBUG
   * -------------------------------------------------------
   */
  console.log(
    "[revenium] FINAL COST PAYLOAD:",
    JSON.stringify({
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
        payload.inputTokenCost,

      outputTokenCost:
        payload.outputTokenCost,

      totalCost:
        payload.totalCost,
    })
  );


  /*
   * -------------------------------------------------------
   * SEND METERING EVENT
   * -------------------------------------------------------
   */
  try {

    const response =
      await fetch(
        REVENIUM_METERING_URL,
        {
          method:
            "POST",

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
     * FAILED
     */
    if (
      !response.ok
    ) {

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


    /*
     * SUCCESS
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
