// BackBone — Inquiry Intake endpoint
// GET  /api/intake        -> { submissions: [...] }   (AUTH REQUIRED — internal Inbox only)
// POST /api/intake        -> body: { submission: {...} }  (PUBLIC — the customer form posts here)
// POST /api/intake?mode=update -> body: { submissions: [...] } (AUTH REQUIRED — internal Inbox
//                                 status/conversion updates. Never called by the public form.)
//
// Storage: Upstash key "backbone_intake" — same shared Redis instance as backbone_data / backbone_leads.
// IMPORTANT: uses the /pipeline + SET pattern (the same one api/save.js uses). Do NOT switch to the
// /set/key URL pattern — that path double-JSON-stringifies and fails silently (learned the hard way
// on leads-save.js v1).
//
// AUTH MODEL: the public form must be able to POST a new submission without logging in,
// so a bare POST (append one submission) stays open. Everything that READS or BULK-WRITES
// submissions (GET, and POST ?mode=update) requires a valid session.

const { requireAuth } = require("../lib/auth.js");

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
  // No wildcard CORS on the authenticated paths — cookies must stay same-origin.
  // The public POST is same-origin too (the form lives on this domain), so we
  // don't need permissive CORS here at all.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      // Reading submissions is internal-only.
      const sess = requireAuth(req, res);
      if (!sess) return;
      const submissions = await loadAll();
      return res.status(200).json({ submissions: submissions, count: submissions.length });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

      // Internal inbox: full overwrite (status changes, conversions) — AUTH REQUIRED.
      if (req.query && req.query.mode === "update") {
        const sess = requireAuth(req, res);
        if (!sess) return;
        if (!Array.isArray(body.submissions)) return res.status(400).json({ error: "submissions array required" });
        await saveAll(body.submissions);
        return res.status(200).json({ ok: true, count: body.submissions.length });
      }

      // Public form: append one submission — NO AUTH (customers aren't logged in).
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
