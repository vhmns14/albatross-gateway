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

export function getClientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
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
  const adminKey = req.headers.get("x-admin-key");
  const isAdmin = adminKey === CONFIG.ADMIN_PASSWORD;

  // 1. IP-Based Abuse Protection (Enforced for non-admins)
  if (!isAdmin) {
    const now = Date.now();
    const ipTimestamps = ipRateLimitBuckets.get(clientIp) || [];
    const validIpTimestamps = ipTimestamps.filter((t) => now - t < 60_000);

    if (validIpTimestamps.length >= CONFIG.PUBLIC_IP_RPM_LIMIT) {
      return {
        authorized: false,
        clientIp,
        error: `Public demo rate limit exceeded (${CONFIG.PUBLIC_IP_RPM_LIMIT} requests/min per IP) to protect upstream budget. Please wait 1 minute.`,
        statusCode: 429,
      };
    }

    validIpTimestamps.push(now);
    ipRateLimitBuckets.set(clientIp, validIpTimestamps);
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
