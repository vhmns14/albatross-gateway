/**
 * Aegis AI Gateway - Console & Management API
 * Provides telemetry metrics, trace waterfalls, circuit breaker control, and key management.
 */

import { telemetry } from "../telemetry/logger";
import { circuitBreaker } from "../router/circuitBreaker";
import { semanticCache } from "../cache/semantic";
import { db } from "../db";
import { sanitizeInput } from "../guardrails/pii";

export async function handleConsoleApi(req: Request, path: string): Promise<Response> {
  const method = req.method;

  // 1. Telemetry Overview
  if (path === "/api/overview" && method === "GET") {
    const data = telemetry.getOverviewMetrics();
    const providers = circuitBreaker.getAllStatus();
    return Response.json({ ...data, providers });
  }

  // 2. Traces List
  if (path === "/api/traces" && method === "GET") {
    const traces = telemetry.getRecentTraces(50);
    return Response.json({ traces });
  }

  // 3. Trace Details (Waterfall)
  if (path.startsWith("/api/traces/") && method === "GET") {
    const traceId = path.replace("/api/traces/", "");
    const trace = telemetry.getTraceDetail(traceId);
    if (!trace) {
      return Response.json({ error: "Trace not found" }, { status: 404 });
    }
    return Response.json({ trace });
  }

  // 4. Circuit Breakers / Provider Status
  if (path === "/api/providers" && method === "GET") {
    const providers = circuitBreaker.getAllStatus();
    return Response.json({ providers });
  }

  if (path === "/api/providers/simulate-trip" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as any;
    const providerId = body.providerId;
    if (providerId) {
      circuitBreaker.forceTrip(providerId);
      return Response.json({ success: true, message: `Tripped ${providerId} circuit breaker into OPEN state.` });
    }
    return Response.json({ error: "Missing providerId" }, { status: 400 });
  }

  if (path === "/api/providers/reset" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as any;
    const providerId = body.providerId;
    if (providerId) {
      circuitBreaker.forceReset(providerId);
      return Response.json({ success: true, message: `Reset ${providerId} circuit breaker to CLOSED.` });
    }
    return Response.json({ error: "Missing providerId" }, { status: 400 });
  }

  // 5. Semantic Cache Management
  if (path === "/api/cache" && method === "GET") {
    const stats = semanticCache.getStats();
    return Response.json(stats);
  }

  if (path === "/api/cache/threshold" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as any;
    if (typeof body.threshold === "number") {
      semanticCache.setThreshold(body.threshold);
      return Response.json({ success: true, threshold: semanticCache.getThreshold() });
    }
    return Response.json({ error: "Invalid threshold value" }, { status: 400 });
  }

  if (path === "/api/cache/purge" && method === "POST") {
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
        rawSecret, // Shown ONLY once upon creation!
        prefix,
        spendLimitUsd: spendLimit,
        rateLimitRpm: rateLimit,
      },
    });
  }

  if (path.startsWith("/api/keys/") && method === "DELETE") {
    const keyId = path.replace("/api/keys/", "");
    db.query("UPDATE virtual_keys SET is_active = 0 WHERE id = ?").run(keyId);
    return Response.json({ success: true, message: "Virtual key revoked" });
  }

  // 7. Interactive Guardrail / PII Preview Tester
  if (path === "/api/simulate-pii" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as any;
    const text = body.text || "";
    const result = sanitizeInput(text);
    return Response.json(result);
  }

  return Response.json({ error: "Endpoint not found" }, { status: 404 });
}
