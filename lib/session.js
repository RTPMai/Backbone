// lib/session.js — signed session cookies.
//
// RENAMED from lib/auth.js on purpose. Having both `api/auth.js` (a route) and
// `lib/auth.js` (this library) was a trap: the two got mixed up, the API handler was
// pasted over the library, and the library's contents were lost. Different names now,
// so a mix-up is impossible:
//     lib/session.js  -> cookies, signing, guards   (THIS FILE)
//     lib/users.js    -> user accounts and roles
//     api/auth.js     -> the HTTP route that uses both
//
// ESM, matching the rest of the project (api/data.js used `export default`). Do not
// convert this to module.exports — mixing module systems is what produced
// "setSessionCookie is not a function".
//
// Sessions are HMAC-SHA256 signed, HttpOnly, and last 12 hours.

import crypto from "crypto";

const COOKIE_NAME = "backbone_session";
const MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set — generate one with: openssl rand -base64 32");
  return s;
}

// Constant-time string compare. A plain === leaks timing information about how many
// leading characters matched, which is enough to brute-force a secret byte by byte.
export function safeEqual(a, b) {
  const A = Buffer.from(String(a == null ? "" : a));
  const B = Buffer.from(String(b == null ? "" : b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadB64) {
  return b64url(crypto.createHmac("sha256", secret()).update(payloadB64).digest());
}

// ---- cookie plumbing --------------------------------------------------------

function parseCookies(req) {
  const raw = (req.headers && req.headers.cookie) || "";
  const out = {};
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function setSessionCookie(res, session) {
  const data = Object.assign({}, session, {
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  });
  const payload = b64url(JSON.stringify(data));
  const token = payload + "." + sign(payload);

  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",              // JS in the page can't read it, so XSS can't steal it
    "SameSite=Lax",          // not sent on cross-site POSTs — blunts CSRF
    "Secure",                // HTTPS only
    `Max-Age=${MAX_AGE_SECONDS}`,
  ].join("; "));
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    "Max-Age=0",
  ].join("; "));
}

// Returns the session object, or null if absent / tampered / expired.
export function getSession(req) {
  try {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;

    const dot = token.lastIndexOf(".");
    if (dot === -1) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    // Verify BEFORE parsing. An unverified payload is attacker-controlled input, and
    // trusting it would let anyone mint themselves a role:"admin" cookie.
    if (!safeEqual(sig, sign(payload))) return null;

    const data = JSON.parse(unb64url(payload).toString("utf8"));
    if (!data || typeof data !== "object") return null;
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;

    return data;
  } catch (e) {
    return null;
  }
}

// Guard for API routes. Sends the 401/403 itself and returns null, so callers just do:
//     const sess = requireAuth(req, res);
//     if (!sess) return;
export function requireAuth(req, res, requiredRole) {
  const sess = getSession(req);
  if (!sess) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  if (requiredRole && sess.role !== requiredRole) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return sess;
}
