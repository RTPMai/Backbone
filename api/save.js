const { requireAuth } = require("../lib/auth.js");

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const sess = requireAuth(req, res);
  if (!sess) return;

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: "Upstash not configured" });

  async function kvGet(key) {
    const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!j.result) return null;
    let val = j.result;
    for (let i = 0; i < 3; i++) {
      if (typeof val === "string") {
        try {
          val = JSON.parse(val);
        } catch (e) {
          break;
        }
      } else break;
    }
    return val;
  }

  async function kvSet(key, value) {
    await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", key, JSON.stringify(value)]]),
    });
  }

  try {
    const body = req.body || {};
    const existing = (await kvGet("backbone_data")) || { synced: [], enrichment: {}, lastSynced: null };

    // Only touch the fields the caller actually sent. This is what keeps a
    // synced-data refresh from ever clobbering manually entered enrichment
    // fields, and vice versa.
    const next = {
      synced: body.synced !== undefined ? body.synced : existing.synced,
      enrichment: body.enrichment !== undefined ? body.enrichment : existing.enrichment,
      lastSynced: body.synced !== undefined ? new Date().toISOString() : existing.lastSynced,
    };

    await kvSet("backbone_data", next);
    return res.status(200).json({ ok: true, ...next });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
