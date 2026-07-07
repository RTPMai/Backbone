export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: "Upstash not configured" });

  const { leads } = req.body || {};
  if (!Array.isArray(leads)) {
    return res.status(400).json({ error: "Expected { leads: [...] }" });
  }

  try {
    const payload = { leads: leads, savedAt: new Date().toISOString() };
    await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", "backbone_leads", JSON.stringify(payload)]]),
    });
    return res.status(200).json({ ok: true, count: leads.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
