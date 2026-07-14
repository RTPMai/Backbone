// api/auth.js — login / logout / session / settings / users / roles
//
// Per-user accounts are added WITHOUT removing the shared-password path. Legacy
// APP_PASSWORD / ADMIN_PASSWORD logins still work, so nobody is locked out the moment
// this deploys — you can create the real accounts first, then retire the shared
// passwords by deleting the env vars.
//
// POST { action:"login", username, password }  → per-user login (preferred)
// POST { action:"login", password }            → legacy shared-password login
// POST { action:"logout" }
// GET  ?action=session                         → { authenticated, role, tabs, perms, user }
// GET  ?action=users        (admin)            → { users, roles, ams }
// POST { action:"user_create"|"user_update"|"user_delete" }  (admin)
// POST { action:"roles_save", roles }          (admin)

const {
  safeEqual, setSessionCookie, clearSessionCookie, getSession, requireAuth,
} = require("../lib/auth.js");

const {
  authenticate, listUsers, createUser, updateUser, deleteUser,
  getRoles, saveRoles, getRole, getUser,
} = require("../lib/users.js");

const ACCOUNT_MANAGERS = [
  "Alexis Davis", "Abby Penton", "Hannah Posey",
  "Jacob Whitman", "Ryan Toney", "Megan Griffith",
];

// What the browser is allowed to know about itself. The client uses this to hide tabs
// and cards — but that is COSMETIC. Every endpoint still enforces its own rules, because
// anything sent to the browser can be edited in the browser.
async function permsFor(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return {
    role: role.name,
    label: role.label,
    tabs: role.tabs || [],
    cards: role.cards || [],
    data_scope: role.data_scope || "all",
    can_edit: role.can_edit !== false,
    can_export: !!role.can_export,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const appPw = process.env.APP_PASSWORD;
  const adminPw = process.env.ADMIN_PASSWORD;

  try {
    // ---------------- GET ----------------
    if (req.method === "GET") {
      const action = (req.query && req.query.action) || "session";
      const sess = getSession(req);

      if (action === "users") {
        const s = requireAuth(req, res, "admin");
        if (!s) return;
        return res.status(200).json({
          users: await listUsers(),
          roles: await getRoles(),
          ams: ACCOUNT_MANAGERS,
        });
      }

      if (!sess) return res.status(200).json({ authenticated: false });

      const perms = await permsFor(sess);
      const user = sess.username ? await getUser(sess.username) : null;

      // No global `tabs` any more. Visibility is decided solely by the role — two
      // systems gating the same thing was confusing, and the global toggles were
      // silently overriding role restrictions on the client.
      return res.status(200).json({
        authenticated: true,
        role: perms.role,
        perms: perms,
        user: user ? { username: user.username, name: user.name, am_name: user.am_name } : null,
      });
    }

    // ---------------- POST ----------------
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const action = body.action;

      if (action === "logout") {
        clearSessionCookie(res);
        return res.status(200).json({ ok: true });
      }

      if (action === "login") {
        // Per-user login takes precedence when a username is supplied.
        if (body.username) {
          const u = await authenticate(body.username, body.password);
          // Deliberately vague: never reveal whether the USERNAME was the wrong part.
          if (!u) return res.status(401).json({ error: "Incorrect username or password" });
          setSessionCookie(res, {
            role: u.role,
            username: u.username,
            iat: Math.floor(Date.now() / 1000),
          });
          return res.status(200).json({ ok: true, role: u.role });
        }

        // Legacy shared-password path — kept so this deploy doesn't lock anyone out.
        if (!appPw && !adminPw) return res.status(500).json({ error: "Passwords not configured" });
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
        const sess = getSession(req);
        if (!sess) return res.status(401).json({ error: "Not authenticated" });
        if (!adminPw) return res.status(500).json({ error: "Admin password not configured" });
        if (!safeEqual(body.password, adminPw)) return res.status(401).json({ error: "Incorrect admin password" });
        setSessionCookie(res, Object.assign({}, sess, { role: "admin" }));
        return res.status(200).json({ ok: true, role: "admin" });
      }

      // ---- user management (admin only) ----
      if (action === "user_create") {
        const sess = requireAuth(req, res, "admin");
        if (!sess) return;
        const u = await createUser({
          username: body.username, password: body.password,
          name: body.name, role: body.role, am_name: body.am_name,
        });
        return res.status(200).json({ ok: true, user: u });
      }

      if (action === "user_update") {
        const sess = requireAuth(req, res, "admin");
        if (!sess) return;
        const u = await updateUser(body.username, {
          name: body.name, role: body.role,
          am_name: body.am_name, password: body.password,
        });
        return res.status(200).json({ ok: true, user: u });
      }

      if (action === "user_delete") {
        const sess = requireAuth(req, res, "admin");
        if (!sess) return;
        await deleteUser(body.username);
        return res.status(200).json({ ok: true });
      }

      if (action === "roles_save") {
        const sess = requireAuth(req, res, "admin");
        if (!sess) return;
        const saved = await saveRoles(body.roles);
        return res.status(200).json({ ok: true, roles: saved });
      }

      return res.status(400).json({ error: "Unknown action" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
