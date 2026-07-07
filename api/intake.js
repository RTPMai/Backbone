// BackBone — Inquiry Intake endpoint
// GET  /api/intake        -> { submissions: [...] }
// POST /api/intake        -> body: { submission: {...} }  (appends, server assigns id + timestamp + status)
// POST /api/intake?mode=update -> body: { submissions: [...] } (full overwrite — used by the internal Inbox
//                                 to update statuses / mark converted. Never called by the public form.)
//
// Storage: Upstash key "backbone_intake" — same shared Redis instance as backbone_data / backbone_leads.
// IMPORTANT: uses the /pipeline + SET pattern (the same one api/save.js uses). Do NOT switch to the
// /set/key URL pattern — that path double-JSON-stringifies and fails silently (learned the hard way
// on leads-save.js v1).

const KEY = "backbone_intake";

async function redisPipeline(commands) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    // Guard fires BEFORE any Upstash call — if you see this on every endpoint at once,
    // check env vars on the CORRECT Vercel project, then Redeploy (env edits are not retroactive).
    throw new Error("not_configured");
  }
  const res = await fetch(url + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error("upstash_" + res.status);
  return res.json();
}

async function loadAll() {
  const out = await redisPipeline([["GET", KEY]]);
  const raw = out && out[0] && out[0].result;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function saveAll(submissions) {
  await redisPipeline([["SET", KEY, JSON.stringify(submissions)]]);
}

function newId() {
  return "INQ-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      const submissions = await loadAll();
      return res.status(200).json({ submissions: submissions, count: submissions.length });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

      // Internal inbox: full overwrite (status changes, conversions)
      if (req.query && req.query.mode === "update") {
        if (!Array.isArray(body.submissions)) return res.status(400).json({ error: "submissions array required" });
        await saveAll(body.submissions);
        return res.status(200).json({ ok: true, count: body.submissions.length });
      }

      // Public form: append one submission
      const sub = body.submission;
      if (!sub || typeof sub !== "object") return res.status(400).json({ error: "submission object required" });

      const record = Object.assign({}, sub, {
        id: newId(),
        schema: "intake_v1",
        submitted_at: new Date().toISOString(),
        status: "new",            // new -> reviewed -> attached_to_client | converted_lead | dismissed
        links: { customer_id: null, lead_id: null }
      });

      const all = await loadAll();
      all.push(record);
      await saveAll(all);
      return res.status(200).json({ ok: true, id: record.id });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    if (e.message === "not_configured") {
      return res.status(500).json({ error: "Storage not configured. Check KV_REST_API_URL / KV_REST_API_TOKEN on this Vercel project, then Redeploy." });
    }
    return res.status(500).json({ error: e.message || "server error" });
  }
};
