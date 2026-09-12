import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/**
 * Dashboard identity — multi-user auth so the same server can be reached over a
 * token-protected remote binding without changing Luvish's localhost UX (the
 * localAdminBypass branch lives in server.ts; this module only supplies the
 * primitives). Henry is a personal chief-of-staff + PM agent, so the dashboard is
 * admin-only: there is exactly one role.
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

export type Role = "admin";
export type SessionUser = {
  userId: string;
  username: string;
  role: Role;
};

/** Session cookie name (server.ts reads request cookies by this name). */
export const SESSION_COOKIE = "henry_sess";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, slid forward on every authenticated read
const ROLES: readonly Role[] = ["admin"];
const TOKEN_BYTES = 32;
const SALT_BYTES = 16;
const KEY_LENGTH = 64;
// 128 * N * r = 16MB of scratch; node's default maxmem is 32MB, so state it explicitly
// rather than sitting one parameter bump away from an ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const HEX_64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Mirrors config.ts's dataDir resolution (HENRY_DATA_DIR / legacy LAVU_DATA_DIR,
 * else <repo>/data) without importing the runtime — the frozen contract gives
 * these functions no config parameter, and root-anchoring keeps `henry` correct
 * when launched from any cwd (same lesson as config.ts's dotenv anchoring).
 */
function dashboardDbPath(): string {
  const configured = process.env.HENRY_DATA_DIR || process.env.LAVU_DATA_DIR || "data";
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
      role TEXT NOT NULL CHECK (role IN ('admin')),
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
 * another localhost app planting its own `henry_sess`), and the caller must not assume the
 * first one is Henry's. */
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
 * Verifies every `henry_sess` candidate in the header — first valid wins — instead of
 * trusting only the first one present. A junk cookie planted by another localhost app (or a
 * stale duplicate left behind by a cookie-path change) can easily sort before Henry's real
 * cookie in the Cookie header; trusting only the first candidate would then lock a
 * legitimately logged-in user out even though their real, validly-signed cookie is sitting
 * right there later in the same header. Shape-checking + HMAC verification per candidate is
 * cheap (dashboardSecret() is memoized after the first call), so trying all of them costs
 * nothing that matters for any realistic cookie count.
 */
function firstVerifiedToken(cookieHeader: string | undefined): string | undefined {
  for (const candidate of cookieValues(cookieHeader, SESSION_COOKIE)) {
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

/** Mints a session row and returns the Set-Cookie value for it. */
export function issueSession(user: SessionUser): { cookie: string } {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const now = Date.now();
  db().prepare("INSERT INTO sessions (tokenHash, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)").run(
    hashToken(token),
    user.userId,
    new Date(now + SESSION_TTL_MS).toISOString(),
    new Date(now).toISOString(),
  );
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return { cookie: `${SESSION_COOKIE}=${token}.${signToken(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` };
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

// --- logout helpers (additive: the contract names GET /logout but no primitive) ---

/** Deletes the caller's own session row. Silent no-op for a missing/forged cookie. */
export function endSession(cookieHeader: string | undefined): void {
  const token = firstVerifiedToken(cookieHeader);
  if (!token) return;
  db().prepare("DELETE FROM sessions WHERE tokenHash = ?").run(hashToken(token));
}

/** Set-Cookie value that expires the session cookie in the browser. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
