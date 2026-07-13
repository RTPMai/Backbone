// api/brief.js
// Renders a lead brief as a standalone HTML page, uploads it to Vercel Blob,
// and returns the public URL. The URL goes in the AM's email body — mailto: has
// no attachment mechanism, so a hosted link is the only one-click path.
//
// The brief is print-clean: Ctrl+P / "Share > Print" in any browser produces a
// proper PDF, so AMs who want a file still get one.
//
// Setup:
//   1. npm i @vercel/blob  (add to package.json dependencies)
//   2. Vercel > Storage > Create Database > Blob
//      -> set access to PUBLIC (the dialog defaults to Private; private blob URLs
//         are NOT openable by link, which defeats the whole point of emailing one)
//   3. Store > Projects tab > Connect to Project -> pick this project
//      This injects VERCEL_OIDC_TOKEN + BLOB_STORE_ID, which the SDK uses to auth.
//      BLOB_READ_WRITE_TOKEN is NOT needed when connected this way.
//   4. REDEPLOY. Env vars only apply to deployments built after they were added.

import { put } from "@vercel/blob";
import { requireAuth } from "../lib/auth.js";

// Bump this whenever brief.js changes. It's echoed in every error so we can tell at a
// glance whether the deployed file is the one we think it is — several rounds of this
// debug were spent diagnosing a build that had never actually shipped.
const BUILD = "brief-v7";

// ---- helpers ---------------------------------------------------------------

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function dash(v) {
  const t = String(v == null ? "" : v).trim();
  return t ? esc(t) : "&mdash;";
}

// Same bands the app uses.
function tierColor(tier) {
  const t = String(tier || "");
  if (t === "Strategic Account") return { bg: "#EAF5EE", fg: "#1F6B3D", bar: "#3D9A5C" };
  if (t === "High-Value Growth Account") return { bg: "#DBEAFE", fg: "#1D4ED8", bar: "#2563EB" };
  if (t === "Standard Account") return { bg: "#FEF3C7", fg: "#92400E", bar: "#D97706" };
  if (t === "Transactional Account") return { bg: "#F3F4F6", fg: "#4B5563", bar: "#6B7280" };
  return { bg: "#FEE2E2", fg: "#991B1B", bar: "#DC2626" };
}

function urgencyColor(u) {
  const t = String(u || "").toLowerCase();
  if (/immediate|urgent|today|24|high/.test(t)) return "#DC2626";
  if (/week|soon|medium/.test(t)) return "#D97706";
  return "#6B7280";
}

// Pull the best email/phone out of a contact, handling the legacy contact_info string.
const PLACEHOLDER = /^(not\s*found|none|n\/?a|null|unknown|unavailable|not\s*(listed|available|provided|public|disclosed)|tbd|-{1,}|\u2014)$/i;
function clean(v) {
  const t = String(v == null ? "" : v).trim();
  return (!t || PLACEHOLDER.test(t)) ? "" : t;
}
function contactBits(c) {
  let email = clean(c.email);
  let phone = clean(c.phone);
  const info = String(c.contact_info || "");
  if (!email) { const m = info.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i); if (m) email = m[0]; }
  if (!phone) { const m = info.match(/(\+?\d[\d\-().\s]{7,}\d)/); if (m) phone = m[1].trim(); }
  return { email: email, phone: phone };
}

// ---- the brief -------------------------------------------------------------

function renderBrief(lead, am) {
  const q = lead.qualification || {};
  const qs = q.qualification_scoring || {};
  const glance = q.at_a_glance || {};
  const next = q.next_steps || {};
  const exec = q.executive_summary || {};
  const co = q.company_overview || {};
  const routing = q.routing || {};
  const flags = (q.red_flags && q.red_flags.red_flags_detected) || [];
  const contacts = Array.isArray(q.key_contacts) ? q.key_contacts : [];

  const score = qs.total_score;
  const scoreNum = typeof score === "number" ? score : null;
  const tier = qs.qualification_tier || "Unscored";
  const tc = tierColor(tier);
  const pct = scoreNum == null ? 0 : Math.max(0, Math.min(100, (scoreNum / 50) * 100));

  const action = next.recommended_action || exec.next_action || "";
  const urgency = next.urgency || exec.urgency || routing.follow_up_speed || "";
  const uc = urgencyColor(urgency);

  // Rank out of 5 from the /50 score. An AM reads this before any words.
  const stars = scoreNum == null ? 0 : Math.max(1, Math.round(scoreNum / 10));

  const company = lead.company_name || co.company_name || "Lead";
  const website = clean(lead.website) || clean(co.website);
  const industry = clean(co.industry_classification) || clean(lead.industry);

  // THE CALL. This is the whole point of the page, so it gets the most weight.
  // Only the primary contact — a list of five names is a research doc, not a handoff.
  // Extra contacts get named at the bottom, without detail.
  let primary = null;
  for (let i = 0; i < contacts.length; i++) {
    const b = contactBits(contacts[i]);
    if (b.email || b.phone) { primary = { c: contacts[i], b: b }; break; }
  }
  if (!primary && contacts.length) primary = { c: contacts[0], b: contactBits(contacts[0]) };

  let callHtml;
  if (primary) {
    const c = primary.c, b = primary.b;
    callHtml =
      '<div class="call-name">' + dash(c.name || "Name not public") + '</div>' +
      (clean(c.title) ? '<div class="call-title">' + esc(c.title) + '</div>' : '') +
      '<div class="call-acts">' +
        (b.phone
          ? '<a class="act act-call" href="tel:' + esc(b.phone.replace(/[^\d+]/g, "")) + '">' +
              '<span class="act-i">\u2706</span> Call ' + esc(b.phone) + '</a>'
          : '') +
        (b.email
          ? '<a class="act act-mail" href="mailto:' + esc(b.email) + '">' +
              '<span class="act-i">\u2709</span> ' + esc(b.email) + '</a>'
          : '<div class="act act-none">No email found \u2014 needs manual lookup</div>') +
      '</div>';
  } else {
    callHtml = '<div class="act act-none">No contact captured yet \u2014 needs manual lookup</div>';
  }

  // Everyone else, names only.
  const others = contacts.filter(function(c) { return !primary || c !== primary.c; });
  const othersHtml = others.length
    ? '<div class="others"><span>Also at ' + esc(company) + ':</span> ' +
        others.map(function(c) {
          return esc(c.name || "?") + (clean(c.title) ? " (" + esc(c.title) + ")" : "");
        }).join(", ") +
      '</div>'
    : '';

  return '<!doctype html><html lang="en"><head>' +
'<meta charset="utf-8"/>' +
'<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
'<title>' + esc(company) + ' \u2014 Lead Brief</title>' +
'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:Inter,-apple-system,system-ui,sans-serif;background:#F4F6F8;color:#111827;' +
  '-webkit-font-smoothing:antialiased;padding:20px 14px 44px;line-height:1.5}' +
'.sheet{max-width:520px;margin:0 auto}' +
'.card{background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(16,24,40,.07);' +
  'padding:20px;margin-bottom:12px}' +

'.top{display:flex;align-items:center;gap:8px;margin-bottom:14px}' +
'.badge{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#3D9A5C,#2F7D48);' +
  'display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:12px}' +
'.top-t{font-weight:700;font-size:12px;letter-spacing:.02em;color:#6B7280}' +
'.top-am{margin-left:auto;font-size:11px;color:#B7BEC7}' +

/* hero: score is the headline */
'.hero{text-align:center;padding:22px 20px 20px}' +
'.stars{font-size:19px;letter-spacing:3px;color:' + tc.bar + ';margin-bottom:10px}' +
'.stars .off{color:#E5E9ED}' +
'.co{font-size:25px;font-weight:800;letter-spacing:-.02em;line-height:1.2}' +
'.ind{font-size:13px;color:#9CA3AF;margin-top:4px}' +
'.ind a{color:#3D9A5C;text-decoration:none;font-weight:600}' +
'.dial{margin-top:16px}' +
'.dial-n{font-size:40px;font-weight:800;letter-spacing:-.03em;line-height:1;color:' + tc.bar + '}' +
'.dial-n small{font-size:14px;font-weight:500;color:#B7BEC7}' +
'.dial-bar{height:7px;border-radius:99px;background:#EEF1F4;margin:11px auto 10px;max-width:220px;overflow:hidden}' +
'.dial-fill{height:100%;border-radius:99px;background:' + tc.bar + ';width:' + pct + '%}' +
'.tier{display:inline-block;padding:5px 13px;border-radius:99px;font-size:11.5px;font-weight:700;' +
  'background:' + tc.bg + ';color:' + tc.fg + '}' +

/* one-liner */
'.sum{font-size:15px;line-height:1.6;text-align:center;color:#374151}' +

/* the call — loudest thing on the page */
'.call{background:#fff;border-radius:16px;padding:20px;margin-bottom:12px;' +
  'box-shadow:0 2px 10px rgba(16,24,40,.10);border:2px solid ' + tc.bar + '}' +
'.call-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;' +
  'color:' + tc.bar + ';margin-bottom:9px}' +
'.call-name{font-size:20px;font-weight:800;letter-spacing:-.01em}' +
'.call-title{font-size:13.5px;color:#6B7280;margin-top:1px}' +
'.call-acts{margin-top:14px;display:flex;flex-direction:column;gap:8px}' +
'.act{display:flex;align-items:center;gap:9px;padding:13px 15px;border-radius:11px;' +
  'font-size:14.5px;font-weight:600;text-decoration:none}' +
'.act-i{font-size:15px;opacity:.85}' +
'.act-call{background:' + tc.bar + ';color:#fff}' +
'.act-mail{background:#F4F6F8;color:#111827}' +
'.act-none{background:#FEF3C7;color:#92400E;font-size:13px;font-weight:600}' +

/* the pitch */
'.say-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;' +
  'color:' + uc + ';margin-bottom:8px}' +
'.say{font-size:15.5px;font-weight:600;line-height:1.55}' +
'.say-m{font-size:12.5px;color:#9CA3AF;margin-top:10px}' +
'.say-m b{color:#374151}' +

'.warn{background:#FEF2F2;border-radius:12px;padding:13px 16px;margin-bottom:12px}' +
'.warn-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;' +
  'color:#B91C1C;margin-bottom:5px}' +
'.warn p{font-size:13px;color:#7F1D1D;line-height:1.5}' +

'.others{font-size:12px;color:#9CA3AF;text-align:center;line-height:1.6;padding:0 8px}' +
'.others span{font-weight:600;color:#6B7280}' +
'.foot{text-align:center;font-size:11px;color:#C3C9D0;margin-top:16px}' +
'@media print{body{background:#fff}.card,.call{box-shadow:none;border:1px solid #E5E7EB}}' +
'</style></head><body><div class="sheet">' +

'<div class="top">' +
  '<div class="badge">B</div><div class="top-t">LEAD BRIEF</div>' +
  '<div class="top-am">' + esc(am || "") + '</div>' +
'</div>' +

// hero
'<div class="card hero">' +
  '<div class="stars">' +
    "\u2605".repeat(stars) + '<span class="off">' + "\u2605".repeat(5 - stars) + '</span>' +
  '</div>' +
  '<div class="co">' + esc(company) + '</div>' +
  '<div class="ind">' +
    (industry ? esc(industry) : "Industry not set") +
    (website ? ' \u00b7 <a href="' + esc(website) + '">website</a>' : "") +
  '</div>' +
  '<div class="dial">' +
    '<div class="dial-n">' + (scoreNum == null ? "\u2014" : scoreNum) + '<small>/50</small></div>' +
    '<div class="dial-bar"><div class="dial-fill"></div></div>' +
    '<span class="tier">' + esc(tier) + '</span>' +
  '</div>' +
'</div>' +

// one-liner
(clean(glance.summary) ? '<div class="card"><div class="sum">' + esc(glance.summary) + '</div></div>' : '') +

// THE CALL
'<div class="call">' +
  '<div class="call-l">Who to call</div>' +
  callHtml +
'</div>' +

// what to say
'<div class="card">' +
  '<div class="say-l">What to say</div>' +
  '<div class="say">' + dash(action) + '</div>' +
  '<div class="say-m">' +
    'Urgency: <b>' + dash(urgency) + '</b>' +
    (clean(glance.top_opportunity) ? '<br/>Angle: <b>' + esc(glance.top_opportunity) + '</b>' : '') +
  '</div>' +
'</div>' +

// one risk, only if it exists
((clean(glance.top_risk) || flags.length)
  ? '<div class="warn"><div class="warn-l">Watch out</div><p>' +
      (clean(glance.top_risk) ? esc(glance.top_risk) : esc(flags[0])) +
    '</p></div>'
  : '') +

othersHtml +

'<div class="foot">BackBone \u00b7 P&amp;M Apparel</div>' +
'</div></body></html>';
}


// ---- handler ---------------------------------------------------------------

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // No credential precheck here. Guessing which env vars "should" be present and
  // refusing to run has already produced two wrong diagnoses in this project — the
  // SDK resolves credentials in its own order (explicit token > OIDC pair > static
  // token) and knows better than I do. Just attempt the upload and report exactly
  // what comes back, with the credential state attached.
  const diag = {
    oidc: !!process.env.VERCEL_OIDC_TOKEN,
    storeId: !!process.env.BLOB_STORE_ID,
    rwToken: !!process.env.BLOB_READ_WRITE_TOKEN,
    build: BUILD
  };

  // Previous guess at the token format didn't match, so stop assuming and just report
  // what's actually there. Never print the secret — only the prefix, length, and the
  // underscore-delimited segment count, which is enough to identify the format and to
  // spot the common failure (a whole `.env.local` LINE pasted in, quotes and all,
  // instead of just the value).
  const rw = process.env.BLOB_READ_WRITE_TOKEN || "";
  diag.tokenLen = rw.length;
  diag.tokenHead = rw.slice(0, 22);          // e.g. "vercel_blob_rw_ABC123..."
  diag.tokenSegs = rw.split("_").length;
  diag.tokenDirty = /["'\s=]/.test(rw) || /BLOB_READ_WRITE_TOKEN/i.test(rw);
  diag.storeIdVal = (process.env.BLOB_STORE_ID || "").slice(0, 24);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const lead = body.lead;
    const am = body.am || "";
    if (!lead || !lead.lead_id) return res.status(400).json({ error: "Missing lead" });

    const html = renderBrief(lead, am);

    // Random suffix keeps the URL unguessable — these hold contact data and the
    // Blob store is public-read. Regenerating a brief creates a fresh URL rather
    // than overwriting, so an already-sent link never silently changes.
    const slug = String(lead.company_name || "lead")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "lead";

    // The STORE decides public vs private; `access` must match how the store was
    // created or the upload is rejected. This store is Public, so the URL below is
    // openable by anyone who has it — which is the point, since it goes in an email
    // to an AM who won't be logged into BackBone on their phone.
    //
    // addRandomSuffix makes the URL unguessable. It also means a regenerated brief
    // gets a NEW url rather than overwriting the old one, so a link already sitting
    // in someone's inbox never silently changes underneath them.
    // Defensive: strip quotes/whitespace off the token. Pasting a whole `.env.local`
    // line (BLOB_READ_WRITE_TOKEN="vercel_blob_rw_...") instead of just the value is
    // an extremely common slip, and it produces exactly this "access denied" error
    // because the quotes travel with the credential.
    let token = (process.env.BLOB_READ_WRITE_TOKEN || "").trim();
    token = token.replace(/^BLOB_READ_WRITE_TOKEN\s*=\s*/i, "").replace(/^["']|["']$/g, "").trim();

    const opts = {
      access: "public",
      contentType: "text/html; charset=utf-8",
      addRandomSuffix: true
    };
    // Pass the token explicitly — an explicit token beats every other resolution tier,
    // so this removes any ambiguity about which credential the SDK picked up.
    if (token) opts.token = token;

    const blob = await put("briefs/" + slug + "-" + lead.lead_id + ".html", html, opts);

    // ---- Short link -------------------------------------------------------------
    // The raw Blob URL is long AND downloads instead of rendering (Vercel stamps
    // Content-Disposition: attachment on every blob). /api/b?c=<code> solves both:
    // short enough for a plain-text email, and it re-serves the HTML with headers
    // that make the browser render it. See api/b.js.
    //
    // If this write fails we still return the raw blob URL — a link that downloads is
    // worse than one that renders, but far better than no brief at all.
    let shortUrl = null;
    try {
      if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
        // 8 chars of base36 ~ 2.8e12 combinations. Unguessable, and short.
        const code = Array.from({ length: 8 }, function() {
          return "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)];
        }).join("");

        // Upstash writes must use /pipeline + SET. The /set/key form double-JSON-
        // stringifies the value and fails silently.
        const kv = await fetch(process.env.KV_REST_API_URL + "/pipeline", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + process.env.KV_REST_API_TOKEN,
            "Content-Type": "application/json"
          },
          body: JSON.stringify([["SET", "backbone_brief:" + code, blob.url]])
        });
        if (kv.ok) {
          const proto = (req.headers["x-forwarded-proto"] || "https");
          const host = req.headers["x-forwarded-host"] || req.headers.host;
          shortUrl = proto + "://" + host + "/api/b?c=" + code;
        }
      }
    } catch (e) {
      console.warn("short link failed, falling back to blob url:", e.message);
    }

    return res.status(200).json({
      url: shortUrl || blob.url,
      blobUrl: blob.url,
      shortened: !!shortUrl,
      lead_id: lead.lead_id,
      build: BUILD
    });
  } catch (e) {
    console.error("brief error:", e);
    // Pass the SDK's own error straight through. Do not reinterpret it.
    return res.status(500).json({
      error: e.message || "Failed to generate brief",
      diag: diag
    });
  }
}
