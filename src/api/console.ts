/**
 * Albatross AI Gateway - Console & Management API
 * Provides telemetry metrics, trace waterfalls, circuit breaker control, and key management.
 */

import { telemetry } from "../telemetry/logger";
import { circuitBreaker } from "../router/circuitBreaker";
import { semanticCache } from "../cache/semantic";
import { db } from "../db";
import { sanitizeInput } from "../guardrails/pii";
import { CONFIG } from "../config";
import { safeCompare, getClientIp, checkRateLimit } from "../middleware/auth";
import { handleChatCompletions } from "../proxy/handler";

const adminLockouts = new Map<string, { failedAttempts: number; lockedUntil: number }>();

export function verifyAdmin(req: Request): boolean {
  const adminKey = req.headers.get("x-admin-key") || "";
  return safeCompare(adminKey, CONFIG.ADMIN_PASSWORD);
}

export async function handleConsoleApi(req: Request, path: string): Promise<Response> {
  const method = req.method;

  // 0. Admin Verification Endpoint with Brute-Force Lockout Protection
  if (path === "/api/admin/verify" && method === "POST") {
    const clientIp = getClientIp(req);
    const now = Date.now();
    const lockout = adminLockouts.get(clientIp);

    if (lockout && lockout.lockedUntil > now) {
      const waitSecs = Math.ceil((lockout.lockedUntil - now) / 1000);
      return Response.json(
        { success: false, error: `Too many failed admin login attempts. Locked out for ${waitSecs}s.` },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as any;
    const password = body.password || req.headers.get("x-admin-key") || "";

    if (safeCompare(password, CONFIG.ADMIN_PASSWORD)) {
      adminLockouts.delete(clientIp);
      return Response.json({ success: true, isAdmin: true });
    }

    const attempts = (lockout?.failedAttempts || 0) + 1;
    if (attempts >= 5) {
      adminLockouts.set(clientIp, { failedAttempts: attempts, lockedUntil: now + 5 * 60_000 });
      return Response.json(
        { success: false, error: "Too many failed attempts. Account locked out for 5 minutes." },
        { status: 429 }
      );
    } else {
      adminLockouts.set(clientIp, { failedAttempts: attempts, lockedUntil: 0 });
    }

    return Response.json(
      { success: false, error: `Invalid admin password. (${5 - attempts} attempts remaining)` },
      { status: 401 }
    );
  }

  // 1. Telemetry Overview (Public Read-Only)
  if (path === "/api/overview" && method === "GET") {
    const data = telemetry.getOverviewMetrics();
    const providers = circuitBreaker.getAllStatus();
    return Response.json({ ...data, providers });
  }

  // 2. Traces List (Public Read-Only)
  if (path === "/api/traces" && method === "GET") {
    const traces = telemetry.getRecentTraces(50);
    return Response.json({ traces });
  }

  // 3. Trace Details (Public Read-Only with Sensitive Data Masking for Non-Admins)
  if (path.startsWith("/api/traces/") && method === "GET") {
    const traceId = path.replace("/api/traces/", "");
    const trace = telemetry.getTraceDetail(traceId);
    if (!trace) {
      return Response.json({ error: "Trace not found" }, { status: 404 });
    }
    const isAdmin = verifyAdmin(req);
    if (!isAdmin) {
      return Response.json({
        trace: {
          ...trace,
          client_ip: trace.client_ip ? trace.client_ip.split(".").slice(0, 2).join(".") + ".x.x" : "x.x.x.x",
          key_id: trace.key_id ? trace.key_id.slice(0, 7) + "..." : null,
        },
      });
    }
    return Response.json({ trace });
  }

  // 4. Circuit Breakers / Provider Status
  if (path === "/api/providers" && method === "GET") {
    const providers = circuitBreaker.getAllStatus();
    return Response.json({ providers });
  }

  if (path === "/api/providers/simulate-trip" && method === "POST") {
    if (!verifyAdmin(req)) {
      return Response.json({ error: "Unauthorized: Action requires admin privileges." }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as any;
    const providerId = body.providerId;
    if (providerId) {
      circuitBreaker.forceTrip(providerId);
      return Response.json({ success: true, message: `Tripped ${providerId} circuit breaker into OPEN state.` });
    }
    return Response.json({ error: "Missing providerId" }, { status: 400 });
  }

  if (path === "/api/providers/reset" && method === "POST") {
    if (!verifyAdmin(req)) {
      return Response.json({ error: "Unauthorized: Action requires admin privileges." }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as any;
    const providerId = body.providerId;
    if (providerId) {
      circuitBreaker.forceReset(providerId);
      return Response.json({ success: true, message: `Reset ${providerId} circuit breaker to CLOSED.` });
    }
    return Response.json({ error: "Missing providerId" }, { status: 400 });
  }

  // 5. Semantic Cache Management (Safe against prompt leakage)
  if (path === "/api/cache" && method === "GET") {
    const isAdmin = verifyAdmin(req);
    const stats = semanticCache.getStats(isAdmin);
    return Response.json(stats);
  }

  if (path === "/api/cache/threshold" && method === "POST") {
    if (!verifyAdmin(req)) {
      return Response.json({ error: "Unauthorized: Modifying cache threshold requires admin privileges." }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as any;
    if (typeof body.threshold === "number") {
      semanticCache.setThreshold(body.threshold);
      return Response.json({ success: true, threshold: semanticCache.getThreshold() });
    }
    return Response.json({ error: "Invalid threshold value" }, { status: 400 });
  }

  if (path === "/api/cache/purge" && method === "POST") {
    if (!verifyAdmin(req)) {
      return Response.json({ error: "Unauthorized: Purging cache requires admin privileges." }, { status: 403 });
    }
    const changes = semanticCache.purge();
    return Response.json({ success: true, purgedCount: changes });
  }

  // 6. Virtual Keys Management
  if (path === "/api/keys" && method === "GET") {
    const keys = db
      .query(`
        SELECT id, name, prefix, spend_limit_usd as spendLimitUsd, current_spend_usd as currentSpendUsd, rate_limit_rpm as rateLimitRpm, is_active as isActive, created_at as createdAt
        FROM virtual_keys
        ORDER BY created_at DESC
      `)
      .all();
    return Response.json({ keys });
  }

  if (path === "/api/keys" && method === "POST") {
    if (!verifyAdmin(req)) {
      return Response.json(
        { error: "Forbidden: Generating virtual API keys is locked to administrators to protect upstream quota." },
        { status: 403 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as any;
    const name = body.name || "New API Key";
    const spendLimit = Number(body.spendLimitUsd) || 50.0;
    const rateLimit = Number(body.rateLimitRpm) || 300;

    const rawSecret = `sk-albatross-${Math.random().toString(36).substring(2, 10)}-${Date.now().toString(36)}`;
    const prefix = rawSecret.substring(0, 14) + "...";

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(rawSecret);
    const keyHash = hasher.digest("hex");
    const keyId = `key_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    db.query(`
      INSERT INTO virtual_keys (id, name, key_hash, prefix, spend_limit_usd, current_spend_usd, rate_limit_rpm, is_active)
      VALUES (?, ?, ?, ?, ?, 0.0, ?, 1)
    `).run(keyId, name, keyHash, prefix, spendLimit, rateLimit);

    return Response.json({
      success: true,
      key: {
        id: keyId,
        name,
        rawSecret,
        prefix,
        spendLimitUsd: spendLimit,
        rateLimitRpm: rateLimit,
      },
    });
  }

  if (path.startsWith("/api/keys/") && method === "DELETE") {
    if (!verifyAdmin(req)) {
      return Response.json({ error: "Unauthorized: Revoking keys requires admin privileges." }, { status: 403 });
    }
    const keyId = path.replace("/api/keys/", "");
    db.query("UPDATE virtual_keys SET is_active = 0 WHERE id = ?").run(keyId);
    return Response.json({ success: true, message: "Virtual key revoked" });
  }

  // 7. Interactive Guardrail / PII Preview Tester (Rate limited & bounded)
  if (path === "/api/simulate-pii" && method === "POST") {
    const clientIp = getClientIp(req);
    const rateCheck = checkRateLimit(clientIp, verifyAdmin(req));
    if (!rateCheck.allowed) {
      return Response.json({ error: rateCheck.error }, { status: 429 });
    }
    const body = (await req.json().catch(() => ({}))) as any;
    const text = typeof body.text === "string" ? body.text.slice(0, 10_000) : "";
    const result = sanitizeInput(text);
    return Response.json(result);
  }

  // 8. Public Playground Chat Execution (Safe Sandbox, No Client Key Needed)
  if (path === "/api/playground/chat" && method === "POST") {
    return handleChatCompletions(req, { isPlayground: true });
  }

  return Response.json({ error: "Endpoint not found" }, { status: 404 });
}
