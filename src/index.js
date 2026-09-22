/**
 * SGS Order AI Widget — Cloudflare Worker
 * Intentionally no auth: this widget is embedded on already-internal,
 * already-staff-only pages of orders-frontend. Sessions are scoped by a
 * client-generated UUID (localStorage), not a real identity.
 *
 * Routes:
 *   POST   /chat                → send a message (+ optional attachments), get a reply
 *   GET    /history/:sessionId  → fetch a session's message history
 *   DELETE /history/:sessionId  → clear a session ("new chat")
 */

import { handleChat }                          from "./routes/chat.js";
import { getSessionHistory, clearSession }     from "./routes/history.js";
import { preflightResponse, jsonResponse }     from "./cors.js";

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return preflightResponse(env);

    try {
      if (path === "/chat" && method === "POST") return await handleChat(request, env, ctx);

      const historyMatch = path.match(/^\/history\/([^/]+)$/);
      if (historyMatch) {
        if (method === "GET")    return await getSessionHistory(request, env, historyMatch[1]);
        if (method === "DELETE") return await clearSession(request, env, historyMatch[1]);
      }

      if (path === "/health" && method === "GET") {
        return jsonResponse({ status: "ok", service: "sgs-order-ai-widget" }, 200, env);
      }

      return jsonResponse({ message: "Not found" }, 404, env);
    } catch (err) {
      console.error("Widget worker error:", err.message, err.stack);
      return jsonResponse({ message: "Internal error", detail: err.message }, 500, env);
    }
  },

  // Daily cleanup, same pattern as stellarai — keep 6 months of history
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await env.DB.prepare(`DELETE FROM messages WHERE created_at < datetime('now', '-6 months')`).run();
      await env.DB.prepare(`DELETE FROM sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM messages)`).run();
    })());
  },
};