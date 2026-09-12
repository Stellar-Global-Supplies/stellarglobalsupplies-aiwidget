/**
 * Fixed, narrow set of read-only tools the LLM may call to answer questions
 * like "how many orders today" or "orders for Vendor X this month".
 * Each tool maps to a real orders-backend endpoint — the LLM never sees or
 * writes raw SQL, and can't touch anything outside these definitions.
 */

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_order_stats",
      description:
        "Get order counts and totals, optionally filtered by status and/or date range and/or customer name.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["Order Received", "Processing", "Ready to Dispatch", "Delivered"],
            description: "Filter by order status. Omit for all statuses.",
          },
          date_from: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive. Omit for no lower bound." },
          date_to:   { type: "string", description: "ISO date (YYYY-MM-DD), inclusive. Omit for no upper bound." },
          customer_name: { type: "string", description: "Filter by customer name (partial match). Omit for all customers." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_by_id",
      description: "Get full details (products, quantities, totals, status) for a single order by its ID.",
      parameters: {
        type: "object",
        properties: { order_id: { type: "string", description: "The order's UUID." } },
        required: ["order_id"],
      },
    },
  },
];

export async function executeTool(name, args, env) {
  // Service binding to the orders-backend worker (see wrangler.toml `[[services]]`).
  // A plain fetch() to the backend's *.workers.dev URL is blocked by Cloudflare
  // at the network level (error 1042: Workers can't fetch another Worker's
  // workers.dev hostname over the public network). The binding calls it
  // directly over Cloudflare's internal network instead, which is both the
  // fix for that error and the recommended way to do Worker-to-Worker calls.
  const backend = env.ORDERS_API;
  // Path/host here just need to be well-formed — the binding routes to the
  // bound service regardless of hostname, but keep it consistent with the
  // backend's real routes for clarity and in case of local `wrangler dev`.
  const origin = env.ORDERS_API_BASE || "https://sgs-orders-worker.internal";

  if (name === "get_order_stats") {
    const params = new URLSearchParams();
    if (args.status)        params.set("status", args.status);
    if (args.date_from)     params.set("date_from", args.date_from);
    if (args.date_to)       params.set("date_to", args.date_to);
    if (args.customer_name) params.set("customer_name", args.customer_name);

    const qs  = params.toString();
    const url = `${origin}/orders/stats${qs ? `?${qs}` : ""}`;
    console.log("[tools] get_order_stats fetching via service binding:", url);
    const res = await backend.fetch(url);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "<unreadable>");
      console.log("[tools] get_order_stats failed body:", bodyText.slice(0, 300));
      return { error: `orders-backend returned ${res.status}`, url, body: bodyText.slice(0, 300) };
    }
    return await res.json();
  }

  if (name === "get_order_by_id") {
    const url = `${origin}/orders/${encodeURIComponent(args.order_id)}/summary`;
    console.log("[tools] get_order_by_id fetching via service binding:", url);
    const res = await backend.fetch(url);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "<unreadable>");
      return { error: `orders-backend returned ${res.status}`, url, body: bodyText.slice(0, 300) };
    }
    return await res.json();
  }

  return { error: `Unknown tool: ${name}` };
}
