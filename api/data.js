export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: "Upstash not configured" });

  // Shared chunked/multi-encoded Upstash value decoder (same pattern as backbone_data).
  function decodeKv(result) {
    if (!result) return null;
    let data = result;
    let attempts = 0;
    while (typeof data === "string" && attempts < 3) {
      try { data = JSON.parse(data); } catch (e) { break; }
      attempts++;
    }
    if (data && typeof data === "object" && !Array.isArray(data) &&
        data.synced === undefined && data["0"] !== undefined) {
      try {
        data = JSON.parse(
          Object.keys(data).sort((a, b) => Number(a) - Number(b)).map((k) => data[k]).join("")
        );
      } catch (e) {}
    }
    return data;
  }

  // ?ops=1 returns the Printavo operational slice (outstanding, quotes-this-week,
  // art declines, AM workload, sales-by-month) written by printavo-sync?mode=ops.
  // Kept on a separate key so the roster payload stays lean for callers that
  // don't need it.
  if (req.query.ops === "1" || req.query.ops === "true") {
    try {
      const r = await fetch(`${url}/get/backbone_printavo_ops`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await r.json();
      const data = decodeKv(json.result);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=60");
      if (!data) {
        return res.status(200).json({ available: false });
      }
      return res.status(200).json(Object.assign({ available: true }, data));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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
