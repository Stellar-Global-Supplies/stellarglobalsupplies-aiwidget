export async function ensureSession(db, sessionId, firstUserMessage) {
  const existing = await db.prepare(`SELECT id FROM sessions WHERE id = ?`).bind(sessionId).first();
  if (existing) return sessionId;

  const title = (firstUserMessage || "New chat").slice(0, 60);
  await db.prepare(`INSERT INTO sessions (id, title) VALUES (?, ?)`).bind(sessionId, title).run();
  return sessionId;
}

export async function saveMessage(db, sessionId, role, content, extractedJson = null) {
  await db.prepare(
    `INSERT INTO messages (id, session_id, role, content, extracted_json) VALUES (?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), sessionId, role, content, extractedJson ? JSON.stringify(extractedJson) : null).run();

  await db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).bind(sessionId).run();
}

export async function getHistory(db, sessionId, limit = 30) {
  const { results } = await db.prepare(
    `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`
  ).bind(sessionId, limit).all();
  return results || [];
}

export async function deleteSession(db, sessionId) {
  await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
}
