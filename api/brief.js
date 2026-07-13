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
const BUILD = "brief-v4";

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
  const opp = q.apparel_opportunity || {};
  const growth = q.growth_signals || {};
  const flags = (q.red_flags && q.red_flags.red_flags_detected) || [];
  const assumptions = Array.isArray(q.assumptions_flagged) ? q.assumptions_flagged : [];
  const contacts = Array.isArray(q.key_contacts) ? q.key_contacts : [];

  const score = qs.total_score;
  const scoreNum = typeof score === "number" ? score : null;
  const tier = qs.qualification_tier || "Unscored";
  const tc = tierColor(tier);
  const pct = scoreNum == null ? 0 : Math.max(0, Math.min(100, (scoreNum / 50) * 100));

  const action = next.recommended_action || exec.next_action || "";
  const urgency = next.urgency || exec.urgency || routing.follow_up_speed || "";
  const uc = urgencyColor(urgency);

  // Contact cards — the single most important thing on the page, so it goes high
  // and loud. A missing email is called out in amber, not silently blank.
  const contactHtml = contacts.length ? contacts.map(function(c) {
    const b = contactBits(c);
    return '<div class="contact">' +
      '<div class="c-hd">' +
        '<div class="c-name">' + dash(c.name || "Name not public") +
          (clean(c.title) ? '<span class="c-title"> &middot; ' + esc(c.title) + '</span>' : '') +
        '</div>' +
        (clean(c.confidence) ? '<span class="c-conf">' + esc(c.confidence) + '</span>' : '') +
      '</div>' +
      (clean(c.relevance) ? '<div class="c-rel">' + esc(c.relevance) + '</div>' : '') +
      '<div class="c-lines">' +
        (b.email
          ? '<a class="c-link" href="mailto:' + esc(b.email) + '">' + esc(b.email) + '</a>'
          : '<span class="c-missing">No email found &mdash; needs manual lookup</span>') +
        (b.phone ? '<a class="c-link" href="tel:' + esc(b.phone.replace(/[^\d+]/g, "")) + '">' + esc(b.phone) + '</a>' : '') +
      '</div>' +
    '</div>';
  }).join("") : '<div class="c-missing" style="padding:10px 0">No contacts captured on this lead yet.</div>';

  function kvBlock(obj) {
    const keys = Object.keys(obj || {});
    if (!keys.length) return '<div class="muted">&mdash;</div>';
    return keys.map(function(k) {
      return '<div class="kv"><span class="kv-k">' + esc(k.replace(/_/g, " ")) + '</span>' +
        '<span class="kv-v">' + dash(obj[k]) + '</span></div>';
    }).join("");
  }

  const company = lead.company_name || co.company_name || "Lead";
  const website = clean(lead.website) || clean(co.website);
  const industry = clean(co.industry_classification) || clean(lead.industry);

  return '<!doctype html><html lang="en"><head>' +
'<meta charset="utf-8"/>' +
'<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
'<title>' + esc(company) + ' — Lead Brief | BackBone</title>' +
'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:Inter,-apple-system,system-ui,sans-serif;background:#F4F6F8;color:#111827;' +
  '-webkit-font-smoothing:antialiased;padding:28px 18px 60px;line-height:1.5}' +
'.sheet{max-width:780px;margin:0 auto}' +
'.card{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(16,24,40,.07);' +
  'padding:22px 24px;margin-bottom:14px}' +
'.brand{display:flex;align-items:center;gap:9px;margin-bottom:16px}' +
'.badge{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#3D9A5C,#2F7D48);' +
  'display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:13px}' +
'.brand-t{font-weight:700;font-size:13px;letter-spacing:.02em}' +
'.brand-s{font-size:11px;color:#9CA3AF;margin-left:auto}' +

/* hero */
'.hero{display:flex;gap:22px;align-items:center;flex-wrap:wrap}' +
'.hero-l{flex:1 1 260px;min-width:0}' +
'.co{font-size:27px;font-weight:800;letter-spacing:-.02em;line-height:1.2}' +
'.meta{font-size:13px;color:#6B7280;margin-top:5px}' +
'.meta a{color:#3D9A5C;text-decoration:none;font-weight:600}' +
'.dial{flex:0 0 auto;text-align:center;min-width:132px}' +
'.dial-n{font-size:42px;font-weight:800;letter-spacing:-.03em;line-height:1;color:' + tc.bar + '}' +
'.dial-n small{font-size:15px;font-weight:500;color:#9CA3AF}' +
'.dial-bar{height:6px;border-radius:99px;background:#EEF1F4;margin:9px 0 8px;overflow:hidden}' +
'.dial-fill{height:100%;border-radius:99px;background:' + tc.bar + ';width:' + pct + '%}' +
'.tier{display:inline-block;padding:4px 11px;border-radius:99px;font-size:11px;font-weight:700;' +
  'background:' + tc.bg + ';color:' + tc.fg + '}' +

/* action strip */
'.act{border-left:4px solid ' + uc + ';background:#fff;border-radius:12px;padding:16px 20px;margin-bottom:14px;' +
  'box-shadow:0 1px 3px rgba(16,24,40,.07)}' +
'.act-l{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:' + uc + '}' +
'.act-b{font-size:16px;font-weight:600;margin-top:5px;line-height:1.45}' +
'.act-m{font-size:12.5px;color:#6B7280;margin-top:7px}' +
'.act-m b{color:#111827;font-weight:600}' +

'h2{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9CA3AF;' +
  'margin-bottom:11px}' +
'.sum{font-size:14.5px;line-height:1.65}' +

/* two-up */
'.two{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}' +
'.pill{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;' +
  'padding:3px 9px;border-radius:99px;display:inline-block;margin-bottom:9px}' +
'.p-opp{background:#EAF5EE;color:#1F6B3D}.p-risk{background:#FEE2E2;color:#991B1B}' +
'.two p{font-size:13.5px;line-height:1.6}' +

/* contacts */
'.contact{border:1px solid #EEF1F4;border-radius:10px;padding:12px 14px;margin-bottom:9px;background:#FBFCFD}' +
'.contact:last-child{margin-bottom:0}' +
'.c-hd{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}' +
'.c-name{font-weight:700;font-size:14px}' +
'.c-title{font-weight:500;color:#6B7280;font-size:13px}' +
'.c-conf{flex:0 0 auto;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;' +
  'padding:2px 8px;border-radius:99px;background:#F3F4F6;color:#6B7280;white-space:nowrap}' +
'.c-rel{font-size:12.5px;color:#6B7280;margin-top:3px}' +
'.c-lines{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px}' +
'.c-link{font-size:13.5px;font-weight:600;color:#3D9A5C;text-decoration:none}' +
'.c-missing{font-size:12.5px;font-weight:600;color:#B45309}' +

/* kv */
'.kv{display:flex;gap:14px;padding:7px 0;border-bottom:1px solid #F4F6F8;font-size:13px}' +
'.kv:last-child{border-bottom:none}' +
'.kv-k{flex:0 0 168px;color:#9CA3AF;text-transform:capitalize;font-size:12px;padding-top:1px}' +
'.kv-v{flex:1;min-width:0}' +
'.muted{font-size:12.5px;color:#9CA3AF}' +

'.flags li{font-size:13px;margin-left:17px;padding:3px 0;color:#991B1B}' +
'.assume{font-size:12px;color:#9CA3AF;line-height:1.6}' +
'.foot{text-align:center;font-size:11px;color:#B7BEC7;margin-top:20px}' +

'@media(max-width:640px){.two{grid-template-columns:1fr}.kv{flex-direction:column;gap:2px}' +
  '.kv-k{flex:none}body{padding:16px 12px 40px}.co{font-size:22px}}' +
'@media print{body{background:#fff;padding:0}.card,.act{box-shadow:none;border:1px solid #E5E7EB;' +
  'break-inside:avoid;page-break-inside:avoid}.brand-s{display:none}}' +
'</style></head><body><div class="sheet">' +

'<div class="brand">' +
  '<div class="badge">B</div><div class="brand-t">BackBone &middot; Lead Brief</div>' +
  '<div class="brand-s">Prepared for ' + esc(am || "the account team") + ' &middot; ' +
    esc(new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })) + '</div>' +
'</div>' +

// hero
'<div class="card"><div class="hero">' +
  '<div class="hero-l">' +
    '<div class="co">' + esc(company) + '</div>' +
    '<div class="meta">' +
      (industry ? esc(industry) : "Industry not set") +
      (website ? ' &middot; <a href="' + esc(website) + '">' + esc(website.replace(/^https?:\/\//, "")) + '</a>' : "") +
    '</div>' +
  '</div>' +
  '<div class="dial">' +
    '<div class="dial-n">' + (scoreNum == null ? "&mdash;" : scoreNum) + '<small>/50</small></div>' +
    '<div class="dial-bar"><div class="dial-fill"></div></div>' +
    '<span class="tier">' + esc(tier) + '</span>' +
  '</div>' +
'</div></div>' +

// action
'<div class="act">' +
  '<div class="act-l">Do this next</div>' +
  '<div class="act-b">' + dash(action) + '</div>' +
  '<div class="act-m">' +
    (clean(next.who_to_contact) ? esc(next.who_to_contact) + ' &nbsp;&middot;&nbsp; ' : '') +
    'Urgency: <b>' + dash(urgency) + '</b>' +
    (clean(routing.follow_up_speed) ? ' &nbsp;&middot;&nbsp; Follow-up: <b>' + esc(routing.follow_up_speed) + '</b>' : '') +
  '</div>' +
'</div>' +

// contacts
'<div class="card"><h2>Who to call</h2>' + contactHtml + '</div>' +

// summary
(clean(glance.summary) ? '<div class="card"><h2>At a glance</h2><div class="sum">' +
  esc(glance.summary) + '</div></div>' : '') +

// opp / risk
((clean(glance.top_opportunity) || clean(glance.top_risk))
  ? '<div class="two">' +
    '<div class="card"><span class="pill p-opp">Top opportunity</span><p>' + dash(glance.top_opportunity) + '</p></div>' +
    '<div class="card"><span class="pill p-risk">Top risk</span><p>' + dash(glance.top_risk) + '</p></div>' +
  '</div>' : '') +

// detail
'<div class="card"><h2>Company overview</h2>' + kvBlock(co) + '</div>' +
'<div class="card"><h2>Apparel opportunity</h2>' + kvBlock(opp) + '</div>' +
'<div class="card"><h2>Growth signals</h2>' + kvBlock(growth) + '</div>' +

(flags.length ? '<div class="card"><h2>Red flags</h2><ul class="flags">' +
  flags.map(function(f) { return '<li>' + esc(f) + '</li>'; }).join("") + '</ul></div>' : '') +

(assumptions.length ? '<div class="card"><h2>Assumptions flagged</h2>' +
  '<div class="assume">' + assumptions.map(esc).join(" &middot; ") + '</div></div>' : '') +

'<div class="foot">Generated by BackBone &middot; P&amp;M Apparel &middot; Print this page to save as PDF</div>' +
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
    const blob = await put("briefs/" + slug + "-" + lead.lead_id + ".html", html, {
      access: "public",
      contentType: "text/html; charset=utf-8",
      addRandomSuffix: true
    });

    return res.status(200).json({ url: blob.url, lead_id: lead.lead_id, build: BUILD });
  } catch (e) {
    console.error("brief error:", e);
    // Pass the SDK's own error straight through. Do not reinterpret it.
    return res.status(500).json({
      error: e.message || "Failed to generate brief",
      diag: diag
    });
  }
}
