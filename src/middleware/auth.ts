/**
 * Albatross AI Gateway - Virtual Key Authentication & Rate Limiting
 */

import { db } from "../db";
import { CONFIG } from "../config";

export interface VirtualKeyInfo {
  id: string;
  name: string;
  prefix: string;
  spendLimitUsd: number;
  currentSpendUsd: number;
  rateLimitRpm: number;
  isActive: boolean;
}

// In-memory rate limiting counters (keyId -> timestamps)
const rateLimitBuckets = new Map<string, number[]>();

// In-memory IP rate limiting counters for public demo protection (IP -> timestamps)
const ipRateLimitBuckets = new Map<string, number[]>();

// In-memory active administrator sessions (token -> session)
export interface AdminSession {
  token: string;
  createdAt: number;
  expiresAt: number;
  clientIp: string;
}
const adminSessions = new Map<string, AdminSession>();

// Constant-time string comparison to prevent timing attacks
export function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const hashA = new Bun.CryptoHasher("sha256").update(a).digest();
  const hashB = new Bun.CryptoHasher("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Admin Session Management
export function createAdminSession(clientIp: string): string {
  const token = `adm_sess_${crypto.randomUUID().replace(/-/g, "")}_${Date.now().toString(36)}`;
  const now = Date.now();
  const maxAgeMs = 2 * 60 * 60 * 1000; // 2 hours validity
  adminSessions.set(token, {
    token,
    createdAt: now,
    expiresAt: now + maxAgeMs,
    clientIp,
  });
  return token;
}

export function revokeAdminSession(token: string): boolean {
  return adminSessions.delete(token);
}

export function isValidAdminSession(token: string): boolean {
  if (!token) return false;
  const session = adminSessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [name, ...rest] = pair.trim().split("=");
    if (name && rest.length > 0) {
      cookies[name] = decodeURIComponent(rest.join("="));
    }
  }
  return cookies;
}

export function createSessionCookie(token: string, req?: Request): string {
  const isSecure =
    CONFIG.ENV === "production" ||
    req?.headers.get("x-forwarded-proto") === "https" ||
    req?.headers.get("cf-visitor")?.includes('"scheme":"https"') ||
    req?.url.startsWith("https:");

  const parts = [
    `albatross_session=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=7200",
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return "albatross_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
}

export function verifyAdminSession(req: Request): boolean {
  // 1. Check HttpOnly cookie first (primary browser vector)
  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    const sessionToken = cookies["albatross_session"];
    if (sessionToken && isValidAdminSession(sessionToken)) {
      return true;
    }
  }

  // 2. Fallback to x-admin-key header (curl, CLI, automated tests)
  const adminKey = req.headers.get("x-admin-key") || "";
  if (adminKey && safeCompare(adminKey, CONFIG.ADMIN_PASSWORD)) {
    return true;
  }

  return false;
}

// Memory leak guard: sweep expired timestamps and stale sessions every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of ipRateLimitBuckets.entries()) {
    const valid = timestamps.filter((t) => now - t < 60_000);
    if (valid.length === 0) {
      ipRateLimitBuckets.delete(ip);
    } else {
      ipRateLimitBuckets.set(ip, valid);
    }
  }
  for (const [keyId, timestamps] of rateLimitBuckets.entries()) {
    const valid = timestamps.filter((t) => now - t < 60_000);
    if (valid.length === 0) {
      rateLimitBuckets.delete(keyId);
    } else {
      rateLimitBuckets.set(keyId, valid);
    }
  }
  for (const [token, sess] of adminSessions.entries()) {
    if (now > sess.expiresAt) {
      adminSessions.delete(token);
    }
  }
}, 120_000);

export function getClientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

export function checkRateLimit(clientIp: string, isAdmin = false): { allowed: boolean; error?: string } {
  if (isAdmin) return { allowed: true };
  const now = Date.now();
  const ipTimestamps = ipRateLimitBuckets.get(clientIp) || [];
  const validIpTimestamps = ipTimestamps.filter((t) => now - t < 60_000);

  if (validIpTimestamps.length >= CONFIG.PUBLIC_IP_RPM_LIMIT) {
    return {
      allowed: false,
      error: `Public rate limit exceeded (${CONFIG.PUBLIC_IP_RPM_LIMIT} requests/min per IP) to protect upstream budget. Please wait 1 minute.`,
    };
  }

  validIpTimestamps.push(now);
  ipRateLimitBuckets.set(clientIp, validIpTimestamps);
  return { allowed: true };
}

export function authenticateKey(req: Request): {
  authorized: boolean;
  key?: VirtualKeyInfo;
  clientIp?: string;
  isAdmin?: boolean;
  error?: string;
  statusCode?: number;
} {
  const clientIp = getClientIp(req);
  const isAdmin = verifyAdminSession(req);

  // 1. IP-Based Abuse Protection (Enforced for non-admins)
  const rateLimitCheck = checkRateLimit(clientIp, isAdmin);
  if (!rateLimitCheck.allowed) {
    return {
      authorized: false,
      clientIp,
      error: rateLimitCheck.error,
      statusCode: 429,
    };
  }

  // 2. Authorization Header Check
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      authorized: false,
      clientIp,
      error: "Missing or invalid Authorization header. Expected Bearer sk-albatross-...",
      statusCode: 401,
    };
  }

  const rawKey = authHeader.replace("Bearer ", "").trim();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(rawKey);
  const keyHash = hasher.digest("hex");

  const row = db
    .query(
      `SELECT id, name, prefix, spend_limit_usd as spendLimitUsd, current_spend_usd as currentSpendUsd, rate_limit_rpm as rateLimitRpm, is_active as isActive
       FROM virtual_keys WHERE key_hash = ? LIMIT 1`
    )
    .get(keyHash) as any;

  if (!row) {
    return {
      authorized: false,
      clientIp,
      error: "Invalid API key provided",
      statusCode: 401,
    };
  }

  if (!row.isActive) {
    return {
      authorized: false,
      clientIp,
      error: "This virtual API key has been revoked or disabled",
      statusCode: 403,
    };
  }

  if (row.currentSpendUsd >= row.spendLimitUsd) {
    return {
      authorized: false,
      clientIp,
      error: `Virtual key monthly spend limit reached ($${row.currentSpendUsd.toFixed(2)} / $${row.spendLimitUsd.toFixed(2)})`,
      statusCode: 429,
    };
  }

  // Rate limit check per virtual key
  const now = Date.now();
  const timestamps = rateLimitBuckets.get(row.id) || [];
  const validTimestamps = timestamps.filter((t) => now - t < 60_000);

  if (validTimestamps.length >= row.rateLimitRpm) {
    return {
      authorized: false,
      clientIp,
      error: `Rate limit exceeded. Maximum ${row.rateLimitRpm} requests per minute for this key.`,
      statusCode: 429,
    };
  }

  validTimestamps.push(now);
  rateLimitBuckets.set(row.id, validTimestamps);

  return {
    authorized: true,
    key: row,
    clientIp,
    isAdmin,
  };
}

export function recordKeySpend(keyId: string, costUsd: number) {
  if (!keyId || costUsd <= 0) return;
  db.query(`
    UPDATE virtual_keys
    SET current_spend_usd = current_spend_usd + ?
    WHERE id = ?
  `).run(costUsd, keyId);
}
