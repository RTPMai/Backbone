// lib/auth.js — shared auth + session helpers for BackBone
// Written as CommonJS (module.exports) so it can be consumed by both your
// `export default` files (Vercel transpiles ESM) and your `module.exports`
// files (intake.js) without ESM/CJS friction.
//
// Cookie-based sessions signed with SESSION_SECRET. No external deps.
//
// Env vars required (set in Vercel, then REDEPLOY):
//   APP_PASSWORD     — general viewer password (gets into the app)
//   ADMIN_PASSWORD   — admin password (unlocks the Settings tab)
//   SESSION_SECRET   — long random string used to sign cookies
//   KV_REST_API_URL / KV_REST_API_TOKEN — existing Upstash creds
//
// A session cookie encodes: { role: "viewer" | "admin", iat } signed with
// HMAC-SHA256 so it can't be forged client-side.

const crypto = require("crypto");

const COOKIE_NAME = "bb_session";
const MAX_AGE = 60 * 60 * 12; // 12 hours

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not configured");
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64").toString();
}

// Constant-time compare to avoid timing attacks on passwords.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // keep timing flat
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret()).update(body).digest());
  return body + "." + sig;
}

function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const parts = token.split(".");
  const body = parts[0];
  const sig = parts[1];
  const expected = b64url(crypto.createHmac("sha256", secret()).update(body).digest());
  const sb = Buffer.from(sig || "");
  const eb = Buffer.from(expected);
  if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch (e) { return null; }
  if (!payload.iat || Date.now() / 1000 - payload.iat > MAX_AGE) return null;
  return payload;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach(function (pair) {
    const idx = pair.indexOf("=");
    if (idx > -1) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, payload) {
  const token = signSession(payload);
  res.setHeader("Set-Cookie",
    COOKIE_NAME + "=" + encodeURIComponent(token) + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=" + MAX_AGE);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie",
    COOKIE_NAME + "=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
}

// Guard for data endpoints. Returns the session if authorized, or null after
// writing a 401/403 (caller should `return` immediately when null).
//   const sess = requireAuth(req, res);            // any logged-in user
//   const sess = requireAuth(req, res, "admin");   // admin only
function requireAuth(req, res, role) {
  const sess = getSession(req);
  if (!sess) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  if (role === "admin" && sess.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return null;
  }
  return sess;
}

// ── Tab-visibility settings, stored server-side in Upstash ──────────────
// Key: backbone_settings. Shape: { tabs: { inbox:true, leads:true, ... } }
const SETTINGS_KEY = "backbone_settings";
const DEFAULT_TABS = { inbox: true, leads: true, roster: true, scorecard: true, dashboard: true };

function kv() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Upstash not configured");
  return { url: url, token: token };
}

async function getAppSettings() {
  const conf = kv();
  const r = await fetch(conf.url + "/get/" + SETTINGS_KEY, { headers: { Authorization: "Bearer " + conf.token } });
  const j = await r.json();
  let val = j.result;
  for (let i = 0; i < 3 && typeof val === "string"; i++) {
    try { val = JSON.parse(val); } catch (e) { break; }
  }
  const tabs = Object.assign({}, DEFAULT_TABS, (val && val.tabs) ? val.tabs : {});
  return { tabs: tabs };
}

async function saveAppSettings(settings) {
  const conf = kv();
  const clean = { tabs: Object.assign({}, DEFAULT_TABS, (settings && settings.tabs) ? settings.tabs : {}) };
  // /pipeline + SET pattern (matches api/save.js — avoids double-stringify bug)
  await fetch(conf.url + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + conf.token, "Content-Type": "application/json" },
    body: JSON.stringify([["SET", SETTINGS_KEY, JSON.stringify(clean)]]),
  });
  return clean;
}

module.exports = {
  safeEqual: safeEqual,
  signSession: signSession,
  verifySession: verifySession,
  getSession: getSession,
  setSessionCookie: setSessionCookie,
  clearSessionCookie: clearSessionCookie,
  requireAuth: requireAuth,
  getAppSettings: getAppSettings,
  saveAppSettings: saveAppSettings,
};
