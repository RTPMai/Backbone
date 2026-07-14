// api/data.js — roster + enrichment, filtered to what the caller is allowed to see.
//
// SECURITY NOTE. The previous version of this file had NO authentication and sent
// `Access-Control-Allow-Origin: *`. That meant the entire client roster — company names,
// revenue, invoice counts, contacts, scores — was readable by anyone who knew the URL,
// from any origin, without logging in. Both problems are fixed here:
//   1. requireAuth() — no session, no data.
//   2. Same-origin only — the wildcard CORS header is gone.
//
// Filtering happens SERVER-SIDE, before the response is built. If an AM is scoped to
// their own accounts, the other accounts never leave the server. Hiding rows in the
// browser would leave the full payload sitting in DevTools.

const { requireAuth, getUser, getRole } = require("../lib/auth.js");

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result || null;
}

// Upstash hands back whatever string we stored. Historic writes were double-encoded and
// some were chunked into numeric keys, so unwrap defensively rather than assume one shape.
function unwrap(raw) {
  let data = raw;
  let attempts = 0;
  while (typeof data === "string" && attempts < 3) {
    data = JSON.parse(data);
    attempts++;
  }
  if (typeof data === "object" && data && !data.synced && data["0"] !== undefined) {
    const rebuilt = Object.keys(data)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => data[k])
      .join("");
    data = JSON.parse(rebuilt);
  }
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // GUARD. Everything below this line requires a valid session.
  const sess = requireAuth(req, res);
  if (!sess) return; // 401 already sent

  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({ error: "Upstash not configured" });
  }

  try {
    const raw = await kvGet("backbone_data");
    if (!raw) {
      return res.status(200).json({ synced: [], enrichment: {}, lastSynced: null });
    }

    const data = unwrap(raw);
    let synced = data.synced || [];
    const enrichment = data.enrichment || {};

    // ---- Permission filtering ----------------------------------------------
    // Resolve the caller to a user record and its role. Legacy shared-password
    // sessions have no username; treat those as their existing role with full
    // visibility, so this change doesn't lock anyone out mid-session.
    const user = sess.username ? await getUser(sess.username) : null;
    const role = await getRole(user ? user.role : sess.role);

    // scope: "all" (default) or "own" — own means only rows assigned to this user's AM.
    const scope = (role && role.data_scope) || "all";

    if (scope === "own") {
      // Which AM is this user? Explicit link on the user record wins; fall back to
      // matching on display name so a user created without an am_name still works.
      const amName = (user && (user.am_name || user.name)) || "";
      if (!amName) {
        // Scoped to "own" but we can't tell who they are — fail CLOSED. Returning
        // everything here would silently defeat the restriction.
        return res.status(200).json({
          synced: [], enrichment: {}, lastSynced: data.lastSynced || null,
          scoped: true, scope_error: "No AM linked to this user — ask an admin to set one.",
        });
      }

      const mine = String(amName).trim().toLowerCase();
      synced = synced.filter((c) => {
        const enr = enrichment[c.customer_id] || {};
        const am = String(enr.account_manager || "").trim().toLowerCase();
        return am === mine;
      });

      // Enrichment is keyed by customer_id — strip the entries whose rows we just
      // removed, or the payload would still carry every client's scoring data.
      const keep = new Set(synced.map((c) => String(c.customer_id)));
      const scopedEnrichment = {};
      Object.keys(enrichment).forEach((k) => {
        if (keep.has(String(k))) scopedEnrichment[k] = enrichment[k];
      });

      return res.status(200).json({
        synced,
        enrichment: scopedEnrichment,
        lastSynced: data.lastSynced || null,
        scoped: true,
      });
    }

    return res.status(200).json({
      synced,
      enrichment,
      lastSynced: data.lastSynced || null,
      scoped: false,
    });
  } catch (e) {
    console.error("data error:", e);
    return res.status(500).json({ error: e.message });
  }
};
