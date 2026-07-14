// api/leads-data.js — read the leads list.
//
// Imports lib/session.js (NOT lib/auth.js — that file was renamed because having both
// api/auth.js and lib/auth.js caused the two to be confused and the library overwritten).
// ESM `import`, matching the `export default` below — the old `require(...)` + `export
// default` mix was a CommonJS/ESM collision that crashed this function on import.

import { requireAuth } from "../lib/session.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: "Upstash not configured" });

  try {
    const r = await fetch(`${url}/get/backbone_leads`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await r.json();
    if (!json.result) return res.status(200).json({ leads: [] });

    let data = json.result;
    let attempts = 0;
    while (typeof data === "string" && attempts < 3) {
      data = JSON.parse(data);
      attempts++;
    }

    if (!data || !Array.isArray(data.leads)) {
      return res.status(200).json({ leads: [] });
    }

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(data);
  } catch (e) {
    console.error("leads-data error:", e);
    return res.status(500).json({ error: e.message });
  }
}
