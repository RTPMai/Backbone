// lib/users.js — user accounts and configurable roles.
//
// This file deliberately does NOT modify lib/auth.js. That file already handles cookie
// signing, session read/write and safeEqual, and it works. Rewriting it blind would risk
// breaking login for everyone. Instead this sits alongside it and adds:
//   - a user store       (backbone_users)
//   - a role store       (backbone_roles)  <- roles are DATA, editable in Settings
//   - password hashing   (scrypt, salted per user)
//
// Roles are configurable rather than hardcoded, so adding "Sales Lead who sees the
// dashboard but not Settings" is a Settings change, not a deploy.

const crypto = require("crypto");

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// ---- Upstash ---------------------------------------------------------------
async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.result) return null;
  let v = j.result;
  let n = 0;
  while (typeof v === "string" && n < 3) {
    try { v = JSON.parse(v); } catch (e) { break; }
    n++;
  }
  return v;
}

// Writes MUST use /pipeline + SET. The /set/<key> form double-JSON-stringifies the value
// and fails silently — a trap this project has already been caught by once.
async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([["SET", key, JSON.stringify(value)]]),
  });
  if (!r.ok) throw new Error("Upstash write failed: " + r.status);
  return true;
}

// ---- Passwords -------------------------------------------------------------
// scrypt via node's crypto — no external dependency, and deliberately slow, so a leaked
// user table can't be brute-forced the way a plain SHA-256 table could.
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), s, 64).toString("hex");
  return s + ":" + derived;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string" || stored.indexOf(":") === -1) return false;
  const parts = stored.split(":");
  const salt = parts[0];
  const expected = parts[1];
  const actual = crypto.scryptSync(String(password), salt, 64).toString("hex");
  // Constant-time compare — a plain === leaks timing information about the hash.
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- Roles -----------------------------------------------------------------
// Shipped defaults. Admins can edit these and add their own in Settings; only "admin"
// is protected from deletion, because an app with no admin role can never be fixed.
const DEFAULT_ROLES = {
  admin: {
    name: "admin",
    label: "Administrator",
    protected: true,
    tabs: ["dashboard", "roster", "scorecard", "leads", "inbox", "settings"],
    cards: ["concentration", "revtrend", "dormant", "cadence", "tiermove", "leaderboard", "amload", "alerts"],
    data_scope: "all",     // "all" | "own"
    can_edit: true,
    can_export: true,
  },
  manager: {
    name: "manager",
    label: "Manager",
    protected: false,
    tabs: ["dashboard", "roster", "scorecard", "leads", "inbox"],
    cards: ["concentration", "revtrend", "dormant", "cadence", "tiermove", "leaderboard", "amload", "alerts"],
    data_scope: "all",
    can_edit: true,
    can_export: true,
  },
  am: {
    name: "am",
    label: "Account Manager",
    protected: false,
    tabs: ["dashboard", "roster", "leads"],
    // No leaderboard or AM workload by default — an AM doesn't need to see how they
    // rank against colleagues unless you decide they should. Editable in Settings.
    cards: ["dormant", "cadence", "revtrend"],
    data_scope: "own",
    can_edit: true,
    can_export: false,
  },
  viewer: {
    name: "viewer",
    label: "Viewer (read-only)",
    protected: false,
    tabs: ["dashboard", "roster"],
    cards: ["concentration", "revtrend"],
    data_scope: "all",
    can_edit: false,
    can_export: false,
  },
};

async function getRoles() {
  const stored = await kvGet("backbone_roles");
  if (!stored || typeof stored !== "object") return Object.assign({}, DEFAULT_ROLES);
  // Merge over defaults so a role added in a future release appears without a migration,
  // while anything the admin has customised wins.
  return Object.assign({}, DEFAULT_ROLES, stored);
}

async function saveRoles(roles) {
  if (!roles || typeof roles !== "object") throw new Error("Invalid roles payload");
  if (!roles.admin) throw new Error("Cannot delete the admin role");
  // Force admin to keep full access. Now that roles are the ONLY thing gating tabs, an
  // admin who unticked "settings" on their own role would be permanently locked out of
  // the only screen that could undo it — the fix would be editing Upstash by hand.
  // So the admin role's tabs/scope/edit rights are non-negotiable, whatever gets POSTed.
  roles.admin = Object.assign({}, roles.admin, {
    protected: true,
    data_scope: "all",
    can_edit: true,
    tabs: ["dashboard", "roster", "scorecard", "leads", "inbox", "settings"],
    cards: ["concentration", "revtrend", "dormant", "cadence", "tiermove",
            "leaderboard", "amload", "alerts"],
  });

  // Every other role must keep at least one tab, or its users log in to a blank app with
  // no way to navigate anywhere.
  Object.keys(roles).forEach(function (k) {
    if (k === "admin") return;
    if (!Array.isArray(roles[k].tabs) || roles[k].tabs.length === 0) {
      throw new Error("Role '" + k + "' has no tabs — its users would log in to a blank screen.");
    }
  });
  await kvSet("backbone_roles", roles);
  return roles;
}

async function getRole(name) {
  const roles = await getRoles();
  return roles[name] || roles.viewer || DEFAULT_ROLES.viewer;
}

// ---- Users -----------------------------------------------------------------
async function getUsers() {
  const stored = await kvGet("backbone_users");
  return (stored && typeof stored === "object") ? stored : {};
}

async function getUser(username) {
  if (!username) return null;
  const users = await getUsers();
  return users[String(username).toLowerCase()] || null;
}

// Never let a password hash out of this module.
function publicUser(u) {
  if (!u) return null;
  return {
    username: u.username,
    name: u.name || "",
    role: u.role,
    am_name: u.am_name || "",
    created: u.created || null,
    last_login: u.last_login || null,
  };
}

async function listUsers() {
  const users = await getUsers();
  return Object.keys(users).map((k) => publicUser(users[k]));
}

async function createUser({ username, password, name, role, am_name }) {
  const u = String(username || "").trim().toLowerCase();
  if (!u || !/^[a-z0-9._-]{3,32}$/.test(u)) {
    throw new Error("Username must be 3-32 chars, letters/numbers/._- only");
  }
  if (!password || String(password).length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const roles = await getRoles();
  if (!roles[role]) throw new Error("Unknown role: " + role);

  const users = await getUsers();
  if (users[u]) throw new Error("That username already exists");

  users[u] = {
    username: u,
    name: name || u,
    role: role,
    am_name: am_name || "",
    hash: hashPassword(password),
    created: new Date().toISOString(),
    last_login: null,
  };
  await kvSet("backbone_users", users);
  return publicUser(users[u]);
}

async function updateUser(username, patch) {
  const u = String(username || "").trim().toLowerCase();
  const users = await getUsers();
  if (!users[u]) throw new Error("No such user");

  if (patch.role) {
    const roles = await getRoles();
    if (!roles[patch.role]) throw new Error("Unknown role: " + patch.role);
    users[u].role = patch.role;
  }
  if (patch.name !== undefined) users[u].name = patch.name;
  if (patch.am_name !== undefined) users[u].am_name = patch.am_name;
  if (patch.password) {
    if (String(patch.password).length < 8) throw new Error("Password must be at least 8 characters");
    users[u].hash = hashPassword(patch.password);
  }
  await kvSet("backbone_users", users);
  return publicUser(users[u]);
}

async function deleteUser(username) {
  const u = String(username || "").trim().toLowerCase();
  const users = await getUsers();
  if (!users[u]) throw new Error("No such user");

  // Refuse to delete the last admin. Otherwise the app becomes unadministrable and the
  // only fix is editing Upstash by hand.
  const admins = Object.keys(users).filter((k) => users[k].role === "admin");
  if (users[u].role === "admin" && admins.length <= 1) {
    throw new Error("Cannot delete the last admin account");
  }
  delete users[u];
  await kvSet("backbone_users", users);
  return true;
}

// Returns the public user on success, null on failure. Callers must not distinguish
// "no such user" from "wrong password" in what they send back to the client.
async function authenticate(username, password) {
  const u = String(username || "").trim().toLowerCase();
  const users = await getUsers();
  const rec = users[u];
  if (!rec) {
    // Burn roughly the same time as a real verify would, so response timing doesn't
    // reveal whether the username exists.
    hashPassword(String(password || ""), "0".repeat(32));
    return null;
  }
  if (!verifyPassword(password, rec.hash)) return null;

  rec.last_login = new Date().toISOString();
  users[u] = rec;
  kvSet("backbone_users", users).catch(() => {});
  return publicUser(rec);
}

module.exports = {
  hashPassword, verifyPassword,
  getRoles, saveRoles, getRole, DEFAULT_ROLES,
  getUsers, getUser, listUsers, createUser, updateUser, deleteUser,
  authenticate, publicUser,
};
