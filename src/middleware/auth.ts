/**
 * Aegis AI Gateway - Virtual Key Authentication & Rate Limiting
 */

import { db } from "../db";

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

export function authenticateKey(req: Request): {
  authorized: boolean;
  key?: VirtualKeyInfo;
  error?: string;
  statusCode?: number;
} {
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      authorized: false,
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
      error: "Invalid API key provided",
      statusCode: 401,
    };
  }

  if (!row.isActive) {
    return {
      authorized: false,
      error: "This virtual API key has been revoked or disabled",
      statusCode: 403,
    };
  }

  if (row.currentSpendUsd >= row.spendLimitUsd) {
    return {
      authorized: false,
      error: `Virtual key monthly spend limit reached ($${row.currentSpendUsd.toFixed(2)} / $${row.spendLimitUsd.toFixed(2)})`,
      statusCode: 429,
    };
  }

  // Rate limit check
  const now = Date.now();
  const timestamps = rateLimitBuckets.get(row.id) || [];
  const validTimestamps = timestamps.filter((t) => now - t < 60_000);

  if (validTimestamps.length >= row.rateLimitRpm) {
    return {
      authorized: false,
      error: `Rate limit exceeded. Maximum ${row.rateLimitRpm} requests per minute.`,
      statusCode: 429,
    };
  }

  validTimestamps.push(now);
  rateLimitBuckets.set(row.id, validTimestamps);

  return {
    authorized: true,
    key: row,
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
