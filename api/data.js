export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: "Upstash not configured" });

  try {
    const r = await fetch(`${url}/get/backbone_data`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await r.json();

    // No data saved yet — return an empty shape rather than erroring, so a
    // fresh deploy shows an empty roster instead of a broken page.
    if (!json.result) {
      return res.status(200).json({ synced: [], enrichment: {}, lastSynced: null });
    }

    // Upstash returns the value as-is; we stored a JSON string, so parse
    // until we have an object. Same pattern DecoBoard's api/data.js uses.
    let data = json.result;
    let attempts = 0;
    while (typeof data === "string" && attempts < 3) {
      data = JSON.parse(data);
      attempts++;
    }

    if (typeof data === "object" && !data.synced && data["0"] !== undefined) {
      const rebuilt = Object.keys(data)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => data[k])
        .join("");
      data = JSON.parse(rebuilt);
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
    return res.status(200).json({
      synced: data.synced || [],
      enrichment: data.enrichment || {},
      lastSynced: data.lastSynced || null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
