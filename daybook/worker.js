// Daybook sync — Cloudflare Worker
// Needs two settings on the Worker:
//   DB       → a D1 database binding
//   SYNC_KEY → a secret (the sync key shown on your Daybook page)
// Routes:
//   GET /changes?since=<ms>   → everything saved after that time
//   PUT /doc/<id>             → save one record (a day, habits or settings)

let tableReady = false;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") return json({ ok: true, app: "daybook-sync" });

    if (!env.SYNC_KEY || env.SYNC_KEY.length < 24) return json({ error: "SYNC_KEY secret is missing or too short" }, 500);
    if (!env.DB) return json({ error: "D1 binding named DB is missing" }, 500);
    if (!sameText(request.headers.get("Authorization") || "", "Bearer " + env.SYNC_KEY)) return json({ error: "unauthorized" }, 401);

    if (!tableReady) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)").run();
      tableReady = true;
    }

    if (url.pathname === "/changes" && request.method === "GET") {
      const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
      const now = Date.now();
      const { results } = await env.DB.prepare("SELECT id, data, updated FROM docs WHERE updated > ? ORDER BY updated LIMIT 5000").bind(since).all();
      return json({ now, docs: results.map(r => ({ id: r.id, updated: r.updated, data: JSON.parse(r.data) })) });
    }

    const m = url.pathname.match(/^\/doc\/([A-Za-z0-9_.:-]{1,64})$/);
    if (m && request.method === "PUT") {
      const text = await request.text();
      if (text.length > 256 * 1024) return json({ error: "too large" }, 413);
      let data;
      try { data = JSON.parse(text); } catch { return json({ error: "not JSON" }, 400); }
      if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "must be an object" }, 400);
      const updated = Date.now();
      await env.DB.prepare("INSERT INTO docs (id, data, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated")
        .bind(m[1], JSON.stringify(data), updated).run();
      return json({ ok: true, updated });
    }

    return json({ error: "not found" }, 404);
  },
};
