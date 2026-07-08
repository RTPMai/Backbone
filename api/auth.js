// api/auth.js — login / logout / session / settings
//
// POST /api/auth  { action: "login",  password }   → sets viewer session (or admin if it's the admin pw)
// POST /api/auth  { action: "admin",  password }   → elevates current session to admin
// POST /api/auth  { action: "logout" }             → clears session
// GET  /api/auth  (action=session)                 → { authenticated, role, tabs }
// GET  /api/auth?action=settings                   → { tabs }   (any logged-in user; used to render nav)
// POST /api/auth  { action: "settings", tabs }     → admin only; saves tab visibility

const {
  safeEqual, setSessionCookie, clearSessionCookie, getSession,
  requireAuth, getAppSettings, saveAppSettings,
} = require("../lib/auth.js");

module.exports = async function handler(req, res) {
  // Same-origin only — no wildcard CORS, so cookies stay trustworthy.
  res.setHeader("Cache-Control", "no-store");

  const appPw = process.env.APP_PASSWORD;
  const adminPw = process.env.ADMIN_PASSWORD;

  try {
    if (req.method === "GET") {
      const action = (req.query && req.query.action) || "session";
      const sess = getSession(req);

      if (action === "settings") {
        if (!sess) return res.status(401).json({ error: "Not authenticated" });
        const settings = await getAppSettings();
        return res.status(200).json(settings);
      }

      // default: session check
      if (!sess) return res.status(200).json({ authenticated: false });
      const settings = await getAppSettings();
      return res.status(200).json({ authenticated: true, role: sess.role, tabs: settings.tabs });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const action = body.action;

      if (action === "logout") {
        clearSessionCookie(res);
        return res.status(200).json({ ok: true });
      }

      if (action === "login") {
        if (!appPw && !adminPw) return res.status(500).json({ error: "Passwords not configured" });
        // Admin password logs you straight in as admin; app password = viewer.
        if (adminPw && safeEqual(body.password, adminPw)) {
          setSessionCookie(res, { role: "admin", iat: Math.floor(Date.now() / 1000) });
          return res.status(200).json({ ok: true, role: "admin" });
        }
        if (appPw && safeEqual(body.password, appPw)) {
          setSessionCookie(res, { role: "viewer", iat: Math.floor(Date.now() / 1000) });
          return res.status(200).json({ ok: true, role: "viewer" });
        }
        return res.status(401).json({ error: "Incorrect password" });
      }

      if (action === "admin") {
        // Elevate an existing viewer session to admin (unlocks Settings).
        const sess = getSession(req);
        if (!sess) return res.status(401).json({ error: "Not authenticated" });
        if (!adminPw) return res.status(500).json({ error: "Admin password not configured" });
        if (!safeEqual(body.password, adminPw)) return res.status(401).json({ error: "Incorrect admin password" });
        setSessionCookie(res, { role: "admin", iat: Math.floor(Date.now() / 1000) });
        return res.status(200).json({ ok: true, role: "admin" });
      }

      if (action === "settings") {
        const sess = requireAuth(req, res, "admin");
        if (!sess) return; // 401/403 already sent
        const saved = await saveAppSettings({ tabs: body.tabs });
        return res.status(200).json(saved);
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
