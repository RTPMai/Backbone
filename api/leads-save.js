// api/leads-save.js
// Mirrors api/save.js, scoped to the Leads module's own key.

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: "Upstash not configured" });

  const { leads } = req.body || {};
  if (!Array.isArray(leads)) {
    return res.status(400).json({ error: "Expected { leads: [...] }" });
  }

  try {
    const payload = JSON.stringify({ leads: leads, savedAt: new Date().toISOString() });
    const r = await fetch(`${url}/set/backbone_leads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (j.error) return res.status(500).json({ error: j.error });
    return res.status(200).json({ ok: true, count: leads.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
