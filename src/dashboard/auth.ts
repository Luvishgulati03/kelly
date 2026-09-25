import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getActiveProfile } from "../profile.ts";

/**
 * Dashboard identity — multi-user auth so the same server can be reached over a
 * token-protected remote binding without changing the owner's localhost UX (the
 * localAdminBypass branch lives in server.ts; this module only supplies the
 * primitives). Two roles: `admin` (the owner, full mission control) and `counter`
 * (the shop tablet — chat and counter voice only; server.ts owns exactly what a
 * counter session can reach).
 *
 * Storage is `data/dashboard/dashboard.db`, a database this module owns end to end:
 * it creates ONLY `users` and `sessions` (IF NOT EXISTS) and never touches a table
 * it did not create.
 *
 * Secrets discipline: passwords are stored as scrypt(N=16384) hashes with a
 * 16-byte per-user salt and compared with crypto.timingSafeEqual; session rows are
 * keyed by the SHA-256 of the token, so a database leak yields no usable cookie.
 * The cookie itself is `<token>.<hmac>` — the HMAC is verified before any DB work,
 * which keeps forged cookies off the database entirely. Nothing here logs a
 * password, a token, or a cookie.
 */

export type Role = "admin" | "counter";
export type SessionUser = {
  userId: string;
  username: string;
  role: Role;
};

/**
 * Session cookie name, per profile: `kelly_sess` under Kelly, `henry_sess` under Henry.
 * Resolved at call time so the launcher's setActiveProfile() always wins. Renaming the Kelly
 * cookie (it used to be `henry_sess`) means an existing Kelly browser session has to log in
 * once more; the old cookie is deliberately not accepted, so logout stays a single cookie.
 */
export function sessionCookieName(): string {
  return `${getActiveProfile().id}_sess`;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, slid forward on every authenticated read
const ROLES: readonly Role[] = ["admin", "counter"];
const TOKEN_BYTES = 32;
const SALT_BYTES = 16;
const KEY_LENGTH = 64;
// 128 * N * r = 16MB of scratch; node's default maxmem is 32MB, so state it explicitly
// rather than sitting one parameter bump away from an ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const HEX_64 = /^[0-9a-f]{64}$/;
const MIN_PASSWORD_LENGTH = 10;

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Mirrors config.ts's dataDir resolution without importing the runtime: the active
 * profile's own variable first (KELLY_DATA_DIR for Kelly, HENRY_DATA_DIR for Henry),
 * then HENRY_DATA_DIR / legacy LAVU_DATA_DIR, else <repo>/data. Reading only
 * HENRY_DATA_DIR made a Kelly started with KELLY_DATA_DIR (every demo) check logins
 * against the repo's default database instead of its own. Root-anchoring keeps it
 * correct when launched from any cwd (same lesson as config.ts's dotenv anchoring).
 */
function dashboardDbPath(): string {
  const profileVar = `${getActiveProfile().envPrefix}DATA_DIR`;
  const configured = process.env[profileVar] || process.env.HENRY_DATA_DIR || process.env.LAVU_DATA_DIR || "data";
  const dataDir = path.isAbsolute(configured) ? configured : path.resolve(REPO_ROOT, configured);
  return path.join(dataDir, "dashboard", "dashboard.db");
}

// Cached by path, not just cached: tests (and a re-pointed HENRY_DATA_DIR) must get
// a fresh handle rather than keep writing to the previous database.
let handle: { path: string; db: Database.Database } | null = null;

function db(): Database.Database {
  const target = dashboardDbPath();
  if (handle) {
    if (handle.path === target) return handle.db;
    handle.db.close();
    handle = null;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const database = new Database(target);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      userId TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'counter')),
      passwordHash TEXT NOT NULL,
      passwordSalt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      tokenHash TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);
  `);
  handle = { path: target, db: database };
  return database;
}

interface UserRow {
  userId: string;
  username: string;
  role: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
}

function toSessionUser(row: UserRow): SessionUser {
  const role = ROLES.includes(row.role as Role) ? (row.role as Role) : "admin";
  return {
    userId: row.userId,
    username: row.username,
    role,
  };
}

// ---------------------------------------------------------------------------
// password hashing
// ---------------------------------------------------------------------------

function scryptHash(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
}

/** Constant-time comparison of two hex strings; a length mismatch is rejected before timingSafeEqual (which throws on unequal lengths). */
function hexEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function passwordMatches(password: string, row: UserRow): boolean {
  let salt: Buffer;
  try { salt = Buffer.from(row.passwordSalt, "hex"); } catch { return false; }
  if (salt.length === 0) return false;
  return hexEquals(scryptHash(password, salt).toString("hex"), row.passwordHash);
}

// ---------------------------------------------------------------------------
// cookie signing
// ---------------------------------------------------------------------------

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));

/**
 * HMAC secret for the session cookie. Auto-generated on first use and appended to
 * the repo-root .env, so sessions survive a restart. A
 * read-only checkout still works — the generated secret stays in process.env and
 * outstanding cookies simply die with the process.
 */
function dashboardSecret(): string {
  const existing = process.env.HENRY_DASH_SECRET?.trim();
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    let separator = "";
    try {
      const current = fs.readFileSync(ENV_PATH, "utf8");
      if (current.length > 0 && !current.endsWith("\n")) separator = "\n";
    } catch { /* no .env yet — appendFileSync creates it 0600 below */ }
    fs.appendFileSync(ENV_PATH, `${separator}HENRY_DASH_SECRET=${generated}\n`, { mode: 0o600 });
  } catch { /* not writable; keep the in-process secret */ }
  process.env.HENRY_DASH_SECRET = generated;
  return generated;
}

function signToken(token: string): string {
  return crypto.createHmac("sha256", dashboardSecret()).update(token).digest("hex");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Splits `<token>.<hmac>` and verifies the signature. Returns the token only when it is genuinely ours. */
function verifiedToken(cookieValue: string): string | undefined {
  const separator = cookieValue.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const token = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  // Shape-check before touching the secret: a junk cookie must not be able to
  // trigger secret generation (and the .env append that comes with it).
  if (!HEX_64.test(token) || !HEX_64.test(signature)) return undefined;
  return hexEquals(signToken(token), signature) ? token : undefined;
}

/** Every candidate value for `name` in the header, in the order they appear — a Cookie
 * header MAY legally repeat a name (a stale duplicate from a cookie-path/domain change, or
 * another localhost app planting its own session cookie), and the caller must not assume the
 * first one is ours. */
function cookieValues(cookieHeader: string | undefined, name: string): string[] {
  if (!cookieHeader) return [];
  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    values.push(part.slice(equals + 1).trim());
  }
  return values;
}

/**
 * Verifies every session-cookie candidate in the header — first valid wins — instead of
 * trusting only the first one present. A junk cookie planted by another localhost app (or a
 * stale duplicate left behind by a cookie-path change) can easily sort before Henry's real
 * cookie in the Cookie header; trusting only the first candidate would then lock a
 * legitimately logged-in user out even though their real, validly-signed cookie is sitting
 * right there later in the same header. Shape-checking + HMAC verification per candidate is
 * cheap (dashboardSecret() is memoized after the first call), so trying all of them costs
 * nothing that matters for any realistic cookie count.
 */
function firstVerifiedToken(cookieHeader: string | undefined): string | undefined {
  for (const candidate of cookieValues(cookieHeader, sessionCookieName())) {
    const token = verifiedToken(candidate);
    if (token) return token;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// contract surface
// ---------------------------------------------------------------------------

export function createUser(u: { username: string; password: string; role: Role }): void {
  const username = u.username.trim();
  if (!username) throw new Error("username is required");
  if (!u.password) throw new Error("password is required");
  if (u.password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (!ROLES.includes(u.role)) throw new Error(`unknown role: ${String(u.role)}`);
  const database = db();
  const existing = database.prepare("SELECT userId FROM users WHERE username = ?").get(username);
  if (existing) throw new Error(`user already exists: ${username}`);
  const userId = `usr_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();
  const salt = crypto.randomBytes(SALT_BYTES);
  const passwordHash = scryptHash(u.password, salt).toString("hex");
  database.prepare(`
    INSERT INTO users (userId, username, role, passwordHash, passwordSalt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, username, u.role, passwordHash, salt.toString("hex"), now);
}

/** Every account, newest first, with no hash or salt in the result — safe to print or log. */
export function listUsers(): Array<{ username: string; role: Role; createdAt: string }> {
  const rows = db().prepare("SELECT username, role, createdAt FROM users ORDER BY createdAt DESC").all() as Array<{ username: string; role: string; createdAt: string }>;
  return rows.map((row) => ({ username: row.username, role: ROLES.includes(row.role as Role) ? (row.role as Role) : "admin", createdAt: row.createdAt }));
}

/** Deletes the account and every session it holds. Returns false for an unknown username. */
export function deleteUser(username: string): boolean {
  const database = db();
  const row = database.prepare("SELECT userId FROM users WHERE username = ?").get(username.trim()) as { userId: string } | undefined;
  if (!row) return false;
  database.prepare("DELETE FROM sessions WHERE userId = ?").run(row.userId);
  database.prepare("DELETE FROM users WHERE userId = ?").run(row.userId);
  return true;
}

/** Re-salts and re-hashes an existing account's password. Returns false for an unknown username. */
export function setPassword(username: string, password: string): boolean {
  if (!password) throw new Error("password is required");
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const database = db();
  const row = database.prepare("SELECT userId FROM users WHERE username = ?").get(username.trim()) as { userId: string } | undefined;
  if (!row) return false;
  const salt = crypto.randomBytes(SALT_BYTES);
  const passwordHash = scryptHash(password, salt).toString("hex");
  database.prepare("UPDATE users SET passwordHash = ?, passwordSalt = ? WHERE userId = ?").run(passwordHash, salt.toString("hex"), row.userId);
  return true;
}

export function verifyLogin(username: string, password: string): SessionUser | undefined {
  const row = db().prepare("SELECT * FROM users WHERE username = ?").get(username.trim()) as UserRow | undefined;
  if (!row) {
    // Hash anyway so an unknown username costs the same as a wrong password —
    // otherwise the response time enumerates who has an account.
    scryptHash(password, Buffer.alloc(SALT_BYTES));
    return undefined;
  }
  return passwordMatches(password, row) ? toSessionUser(row) : undefined;
}

/**
 * Mints a session row and returns the Set-Cookie value for it. `secure` (default false) adds
 * the `Secure` attribute — server.ts sets it true only when the login actually arrived over
 * the tunnel's public https origin, so the cookie is never sent back over plain http from the
 * public side; local http://127.0.0.1 access keeps getting a non-Secure cookie, since Secure
 * would otherwise make the browser drop it there.
 */
export function issueSession(user: SessionUser, opts: { secure?: boolean } = {}): { cookie: string } {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const now = Date.now();
  db().prepare("INSERT INTO sessions (tokenHash, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)").run(
    hashToken(token),
    user.userId,
    new Date(now + SESSION_TTL_MS).toISOString(),
    new Date(now).toISOString(),
  );
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = opts.secure ? "; Secure" : "";
  return { cookie: `${sessionCookieName()}=${token}.${signToken(token)}; HttpOnly; SameSite=Lax${secure}; Path=/; Max-Age=${maxAge}` };
}

/** Resolves the caller from their cookie: HMAC first, then the database. Expired rows are purged on the way past, and a live session slides forward 7 days. */
export function readSession(cookieHeader: string | undefined): SessionUser | undefined {
  const token = firstVerifiedToken(cookieHeader);
  if (!token) return undefined; // no candidate verified — forged, tampered, or absent; never reaches SQLite
  const database = db();
  const now = new Date();
  database.prepare("DELETE FROM sessions WHERE expiresAt <= ?").run(now.toISOString());
  const tokenHash = hashToken(token);
  const row = database.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.userId = sessions.userId WHERE sessions.tokenHash = ?
  `).get(tokenHash) as UserRow | undefined;
  if (!row) return undefined;
  database.prepare("UPDATE sessions SET expiresAt = ? WHERE tokenHash = ?")
    .run(new Date(now.getTime() + SESSION_TTL_MS).toISOString(), tokenHash);
  return toSessionUser(row);
}

export function requireRole(user: SessionUser | undefined, ...roles: Role[]): boolean {
  if (!user) return false;
  return roles.length === 0 || roles.includes(user.role);
}

/**
 * True when the dashboard's own user database already has at least one account with
 * `role`. Used by the remote-access tunnel (src/remote/tunnel.ts) as a fail-closed
 * precondition: Kelly refuses to open a tunnel until an admin account exists, since the
 * loopback admin bypass is meant to disappear once a tunnel is up.
 */
export function hasUserWithRole(role: "admin"): boolean {
  const row = db().prepare("SELECT userId FROM users WHERE role = ? LIMIT 1").get(role);
  return Boolean(row);
}

// --- logout helpers (additive: the contract names GET /logout but no primitive) ---

/** Deletes the caller's own session row. Silent no-op for a missing/forged cookie. */
export function endSession(cookieHeader: string | undefined): void {
  const token = firstVerifiedToken(cookieHeader);
  if (!token) return;
  db().prepare("DELETE FROM sessions WHERE tokenHash = ?").run(hashToken(token));
}

/** Set-Cookie value that expires the session cookie in the browser. Same `secure` contract as issueSession above. */
export function clearedSessionCookie(opts: { secure?: boolean } = {}): string {
  const secure = opts.secure ? "; Secure" : "";
  return `${sessionCookieName()}=; HttpOnly; SameSite=Lax${secure}; Path=/; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// login throttling
// ---------------------------------------------------------------------------

/**
 * In-memory only, keyed by lower-cased username — a tablet or a script hammering /login
 * must not be able to brute-force a password, but this is a per-process guard, not a
 * persisted ban list: a restart clears it, same as every other in-memory rate limit in
 * this codebase. Five failures inside a 15-minute window lock the account for 15 minutes;
 * a successful login (or the lock itself expiring) clears the slate.
 */
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;

interface LoginThrottleState {
  failures: number[];
  lockedUntil?: number;
}

const loginThrottle = new Map<string, LoginThrottleState>();

/**
 * The throttle is keyed by username alone, whatever the client address. Behind a tunnel every
 * request's socket peer is 127.0.0.1, and the forwarded client IP (X-Forwarded-For) can be set
 * by the client itself, so neither may take part in the key: a per-IP key would let anyone try
 * unlimited passwords by rotating a fake header. The cost is that five bad attempts lock that
 * one account for the window, never any other account.
 */
function throttleKey(username: string): string {
  return username.trim().toLowerCase();
}

/** Records one bad password attempt. The 5th failure inside the window locks the account. */
export function recordLoginFailure(username: string): void {
  const key = throttleKey(username);
  if (!username.trim()) return;
  const now = Date.now();
  const state = loginThrottle.get(key) ?? { failures: [] };
  state.failures = state.failures.filter((at) => now - at < LOGIN_FAILURE_WINDOW_MS);
  state.failures.push(now);
  if (state.failures.length >= LOGIN_FAILURE_LIMIT) {
    state.lockedUntil = now + LOGIN_LOCK_MS;
    state.failures = [];
  }
  loginThrottle.set(key, state);
}

/** Called on a successful login — a real login clears the failure count for that username. */
export function clearLoginFailures(username: string): void {
  if (!username.trim()) return;
  loginThrottle.delete(throttleKey(username));
}

/** Seconds remaining on an active lock, or 0 when the account is not locked (or the lock has expired). */
export function loginLockedFor(username: string): number {
  if (!username.trim()) return 0;
  const key = throttleKey(username);
  const state = loginThrottle.get(key);
  if (!state?.lockedUntil) return 0;
  const remainingMs = state.lockedUntil - Date.now();
  if (remainingMs <= 0) { loginThrottle.delete(key); return 0; }
  return Math.ceil(remainingMs / 1000);
}

/** Test-only escape hatch: clears every tracked failure/lock so tests stay isolated from each other. */
export function resetLoginThrottleForTests(): void {
  loginThrottle.clear();
}
