/**
 * Aegis AI Gateway - Telemetry & Observability Engine
 * Tracks P50/P95/P99 latencies, token consumption, budget savings, and request traces.
 */

import { db } from "../db";
import { CONFIG } from "../config";

export interface LogTraceInput {
  traceId: string;
  keyId?: string;
  clientIp?: string;
  endpoint: string;
  modelRequested: string;
  providerUsed?: string;
  modelUsed?: string;
  statusCode: number;
  isCacheHit: boolean;
  cacheSimilarity: number;
  piiRedactedCount: number;
  piiTypesDetected?: any[];
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  timingBreakdown: {
    authMs: number;
    guardrailMs: number;
    cacheMs: number;
    upstreamMs: number;
  };
  errorMessage?: string;
}

export class TelemetryEngine {
  /**
   * Insert a completed trace record
   */
  public logTrace(data: LogTraceInput) {
    try {
      const id = `trc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      db.query(`
        INSERT INTO request_traces (
          id, trace_id, key_id, client_ip, endpoint, model_requested, provider_used, model_used,
          status_code, is_cache_hit, cache_similarity, pii_redacted_count, pii_types_detected,
          prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, timing_breakdown, error_message
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        id,
        data.traceId,
        data.keyId || null,
        data.clientIp || "127.0.0.1",
        data.endpoint,
        data.modelRequested,
        data.providerUsed || "none",
        data.modelUsed || "none",
        data.statusCode,
        data.isCacheHit ? 1 : 0,
        data.cacheSimilarity,
        data.piiRedactedCount,
        JSON.stringify(data.piiTypesDetected || []),
        data.promptTokens,
        data.completionTokens,
        data.promptTokens + data.completionTokens,
        data.costUsd,
        data.latencyMs,
        JSON.stringify(data.timingBreakdown),
        data.errorMessage || null
      );
    } catch (err) {
      console.error("[Albatross Telemetry] Failed to log trace:", err);
    }
  }

  /**
   * Get high-level overview metrics for console
   */
  public getOverviewMetrics() {
    const totalRequests = (
      db.query("SELECT COUNT(*) as count FROM request_traces").get() as any
    )?.count || 0;

    const cacheHits = (
      db.query("SELECT COUNT(*) as count FROM request_traces WHERE is_cache_hit = 1").get() as any
    )?.count || 0;

    const totalCostUsd = (
      db.query("SELECT SUM(cost_usd) as total FROM request_traces").get() as any
    )?.total || 0;

    const totalTokens = (
      db.query("SELECT SUM(total_tokens) as total FROM request_traces").get() as any
    )?.total || 0;

    const totalPiiBlocked = (
      db.query("SELECT SUM(pii_redacted_count) as total FROM request_traces").get() as any
    )?.total || 0;

    // Latency percentiles (P50, P95, P99) sampled over recent 1,000 requests to prevent unbounded memory growth
    const latencies = db
      .query(`
        SELECT latency_ms FROM (
          SELECT latency_ms FROM request_traces WHERE status_code = 200 ORDER BY created_at DESC LIMIT 1000
        ) ORDER BY latency_ms ASC
      `)
      .all()
      .map((r: any) => r.latency_ms);

    let p50 = 0;
    let p95 = 0;
    let p99 = 0;

    if (latencies.length > 0) {
      p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
      p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
      p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
    }

    // Estimated saved dollars from cache (assume average cost of $0.001 per request saved)
    const savedCostUsd = cacheHits * 0.0012;
    const savedCostIdr = savedCostUsd * CONFIG.USD_TO_IDR_RATE;

    const cacheHitRate = totalRequests > 0 ? (cacheHits / totalRequests) * 100 : 0;

    // Rolling latency recent 20 points
    const recentTraces = db
      .query("SELECT trace_id, latency_ms, is_cache_hit, status_code, created_at FROM request_traces ORDER BY created_at DESC LIMIT 25")
      .all()
      .reverse();

    return {
      totalRequests,
      cacheHits,
      cacheHitRate: Number(cacheHitRate.toFixed(1)),
      totalCostUsd: Number(totalCostUsd.toFixed(4)),
      totalCostIdr: Math.round(totalCostUsd * CONFIG.USD_TO_IDR_RATE),
      savedCostUsd: Number(savedCostUsd.toFixed(4)),
      savedCostIdr: Math.round(savedCostIdr),
      totalTokens,
      totalPiiBlocked,
      percentiles: {
        p50: Math.round(p50),
        p95: Math.round(p95),
        p99: Math.round(p99),
      },
      recentTraces,
    };
  }

  /**
   * Get list of recent request traces
   */
  public getRecentTraces(limit = 50) {
    return db
      .query(`
        SELECT 
          trace_id as traceId,
          endpoint,
          model_requested as modelRequested,
          provider_used as providerUsed,
          model_used as modelUsed,
          status_code as statusCode,
          is_cache_hit as isCacheHit,
          cache_similarity as cacheSimilarity,
          pii_redacted_count as piiRedactedCount,
          total_tokens as totalTokens,
          cost_usd as costUsd,
          latency_ms as latencyMs,
          created_at as createdAt,
          error_message as errorMessage
        FROM request_traces
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(limit);
  }

  /**
   * Get full details for a single trace
   */
  public getTraceDetail(traceId: string) {
    const trace = db
      .query(`SELECT * FROM request_traces WHERE trace_id = ? LIMIT 1`)
      .get(traceId) as any;

    if (!trace) return null;

    return {
      ...trace,
      is_cache_hit: Boolean(trace.is_cache_hit),
      pii_types_detected: JSON.parse(trace.pii_types_detected || "[]"),
      timing_breakdown: JSON.parse(trace.timing_breakdown || "{}"),
    };
  }
}

export const telemetry = new TelemetryEngine();
