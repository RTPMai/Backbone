// api/b.js  —  short-link brief viewer.
//
// Serves /api/b?c=<code>. Two jobs:
//
//  1. SHORT URL. The raw Blob URL is ~100 chars of noise in a plain-text email.
//     This is ~40 and readable.
//
//  2. FIXES THE DOWNLOAD. This is the important one. Vercel Blob sets
//     `Content-Disposition: attachment; filename="..."` on every blob it stores,
//     regardless of contentType. So hitting a Blob URL directly DOWNLOADS the file
//     instead of rendering it — useless for an AM tapping a link on their phone.
//     We can't change that header at put() time, so this endpoint fetches the blob
//     server-side and re-serves the bytes with `Content-Type: text/html` and NO
//     attachment disposition. Now it renders.
//
//     This is why it must PROXY, not 302-redirect. A redirect would just send the
//     browser to the Blob URL and it'd download again.
//
// PUBLIC BY DESIGN: no auth. The AM opening this from Outlook on their phone is not
// logged into BackBone. The short code is random and unguessable, which is the same
// protection model the raw Blob URL had.

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const r = await fetch(KV_URL + "/get/" + encodeURIComponent(key), {
    headers: { Authorization: "Bearer " + KV_TOKEN }
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.result || null;
}

function page(title, msg) {
  return '<!doctype html><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<title>' + title + '</title>' +
    '<style>body{font-family:Inter,-apple-system,system-ui,sans-serif;background:#F4F6F8;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}' +
    'div{background:#fff;border-radius:14px;padding:28px 32px;max-width:420px;text-align:center;' +
    'box-shadow:0 1px 3px rgba(16,24,40,.07)}h1{font-size:17px;margin:0 0 8px}' +
    'p{font-size:14px;color:#6B7280;line-height:1.55;margin:0}</style>' +
    '<div><h1>' + title + '</h1><p>' + msg + '</p></div>';
}

export default async function handler(req, res) {
  const code = String((req.query && req.query.c) || "").replace(/[^A-Za-z0-9]/g, "");

  if (!code) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(page("Missing link code", "This brief link looks incomplete."));
  }

  try {
    const url = await kvGet("backbone_brief:" + code);
    if (!url) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(404).send(page("Brief not found",
        "This link may have expired, or the lead was removed. Ask for a fresh one from BackBone."));
    }

    // Pull the stored HTML and hand it back with headers that make a browser RENDER it.
    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(502).send(page("Couldn't load brief",
        "The brief exists but couldn't be fetched right now. Try again in a moment."));
    }
    const html = await upstream.text();

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Explicitly inline. Without this the browser may inherit the attachment behaviour.
    res.setHeader("Content-Disposition", "inline");
    // Briefs are immutable (each regeneration mints a new code), so cache hard.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return res.status(200).send(html);
  } catch (e) {
    console.error("brief view error:", e);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(500).send(page("Something went wrong", "Couldn't load this brief."));
  }
}
