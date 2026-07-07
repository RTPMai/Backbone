// api/leads-data.js
// Mirrors the pattern of your existing api/data.js, but for the Leads module.
// Uses its own Upstash key (backbone_leads) so it can't collide with the customer
// roster's synced/enrichment data.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

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
    return res.status(500).json({ error: e.message });
  }
}
