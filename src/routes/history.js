import { deleteSession } from "../db.js";
import { jsonResponse }  from "../cors.js";

export async function getSessionHistory(request, env, sessionId) {
  const { results } = await env.DB.prepare(
    `SELECT role, content, extracted_json, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC`
  ).bind(sessionId).all();

  const messages = (results || []).map(m => ({
    role: m.role,
    content: m.content,
    extracted: m.extracted_json ? JSON.parse(m.extracted_json) : null,
    createdAt: m.created_at,
  }));

  return jsonResponse({ sessionId, messages }, 200, env);
}

export async function clearSession(request, env, sessionId) {
  await deleteSession(env.DB, sessionId);
  return jsonResponse({ deleted: true }, 200, env);
}
