// api/leads-save.js — write the leads list.
//
// Same two fixes as leads-data.js: import from lib/session.js, and use ESM `import`
// rather than `require` so it doesn't collide with `export default`.

import { requireAuth } from "../lib/session.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const sess = requireAuth(req, res);
  if (!sess) return;

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: "Upstash not configured" });

  const { leads } = req.body || {};
  if (!Array.isArray(leads)) {
    return res.status(400).json({ error: "Expected { leads: [...] }" });
  }

  try {
    const payload = { leads: leads, savedAt: new Date().toISOString() };
    const r = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", "backbone_leads", JSON.stringify(payload)]]),
    });
    // The old version never checked this. A failed Upstash write returned {ok:true} and
    // the browser believed the leads were saved when they weren't.
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error("Upstash write failed: " + r.status + " " + t.slice(0, 120));
    }
    return res.status(200).json({ ok: true, count: leads.length });
  } catch (e) {
    console.error("leads-save error:", e);
    return res.status(500).json({ error: e.message });
  }
}
