/**
 * Aegis AI Gateway - Circuit Breaker & Provider Health Manager
 * Prevents cascading failures and enables zero-downtime provider fallback.
 */

import { db } from "../db";
import { CONFIG, ProviderConfig } from "../config";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface ProviderHealthStatus {
  providerId: string;
  name: string;
  state: CircuitState;
  consecutiveErrors: number;
  lastError: string | null;
  lastErrorAt: string | null;
  cooldownUntil: string | null;
  totalRequests: number;
  totalErrors: number;
  avgLatencyMs: number;
}

export class CircuitBreakerManager {
  private memoryStates: Map<
    string,
    {
      state: CircuitState;
      consecutiveErrors: number;
      cooldownUntil: number;
      recentLatencies: number[];
    }
  > = new Map();

  constructor() {
    this.initProviders();
  }

  private initProviders() {
    for (const p of CONFIG.PROVIDERS) {
      this.memoryStates.set(p.id, {
        state: "CLOSED",
        consecutiveErrors: 0,
        cooldownUntil: 0,
        recentLatencies: [],
      });

      // Upsert into DB for persistent analytics
      db.query(`
        INSERT INTO provider_health (provider_id, name, state, consecutive_errors)
        VALUES (?, ?, 'CLOSED', 0)
        ON CONFLICT(provider_id) DO NOTHING;
      `).run(p.id, p.name);
    }
  }

  /**
   * Check if a provider is eligible to receive traffic
   */
  public isAvailable(providerId: string): boolean {
    const mem = this.memoryStates.get(providerId);
    if (!mem) return false;

    const now = Date.now();

    if (mem.state === "OPEN") {
      if (now >= mem.cooldownUntil) {
        // Transition from OPEN to HALF_OPEN to probe
        mem.state = "HALF_OPEN";
        this.updateDbState(providerId, "HALF_OPEN");
        return true;
      }
      return false;
    }

    return true; // CLOSED or HALF_OPEN
  }

  /**
   * Record a successful request
   */
  public recordSuccess(providerId: string, latencyMs: number) {
    const mem = this.memoryStates.get(providerId);
    if (!mem) return;

    mem.consecutiveErrors = 0;
    if (mem.state === "HALF_OPEN") {
      mem.state = "CLOSED"; // Fully recovered
    }

    mem.recentLatencies.push(latencyMs);
    if (mem.recentLatencies.length > 20) mem.recentLatencies.shift();

    const avg =
      mem.recentLatencies.reduce((a, b) => a + b, 0) / mem.recentLatencies.length;

    db.query(`
      UPDATE provider_health 
      SET state = ?, consecutive_errors = 0, total_requests = total_requests + 1, avg_latency_ms = ?
      WHERE provider_id = ?
    `).run(mem.state, Number(avg.toFixed(2)), providerId);
  }

  /**
   * Record a failed request (HTTP 429, 5xx, or network timeout)
   */
  public recordFailure(providerId: string, errorMsg: string, statusCode?: number) {
    const mem = this.memoryStates.get(providerId);
    if (!mem) return;

    mem.consecutiveErrors += 1;
    const now = Date.now();

    if (
      mem.consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS ||
      statusCode === 429
    ) {
      mem.state = "OPEN";
      mem.cooldownUntil = now + CONFIG.COOLDOWN_PERIOD_MS;
    }

    const cooldownDate = mem.cooldownUntil > 0 ? new Date(mem.cooldownUntil).toISOString() : null;

    db.query(`
      UPDATE provider_health 
      SET state = ?, 
          consecutive_errors = ?, 
          last_error = ?, 
          last_error_at = CURRENT_TIMESTAMP, 
          cooldown_until = ?, 
          total_requests = total_requests + 1, 
          total_errors = total_errors + 1
      WHERE provider_id = ?
    `).run(mem.state, mem.consecutiveErrors, errorMsg, cooldownDate, providerId);
  }

  /**
   * Force trip a provider (for demonstration & testing)
   */
  public forceTrip(providerId: string, durationMs = 45_000) {
    const mem = this.memoryStates.get(providerId);
    if (!mem) return;

    mem.state = "OPEN";
    mem.consecutiveErrors = 3;
    mem.cooldownUntil = Date.now() + durationMs;

    const cooldownDate = new Date(mem.cooldownUntil).toISOString();
    db.query(`
      UPDATE provider_health 
      SET state = 'OPEN', consecutive_errors = 3, last_error = 'Simulated Circuit Break via Console', last_error_at = CURRENT_TIMESTAMP, cooldown_until = ?
      WHERE provider_id = ?
    `).run(cooldownDate, providerId);
  }

  /**
   * Force reset a provider
   */
  public forceReset(providerId: string) {
    const mem = this.memoryStates.get(providerId);
    if (!mem) return;

    mem.state = "CLOSED";
    mem.consecutiveErrors = 0;
    mem.cooldownUntil = 0;

    db.query(`
      UPDATE provider_health 
      SET state = 'CLOSED', consecutive_errors = 0, cooldown_until = NULL
      WHERE provider_id = ?
    `).run(providerId);
  }

  private updateDbState(providerId: string, state: CircuitState) {
    db.query("UPDATE provider_health SET state = ? WHERE provider_id = ?").run(
      state,
      providerId
    );
  }

  /**
   * Get all provider health stats
   */
  public getAllStatus(): ProviderHealthStatus[] {
    const rows = db.query(`
      SELECT 
        provider_id as providerId,
        name,
        state,
        consecutive_errors as consecutiveErrors,
        last_error as lastError,
        last_error_at as lastErrorAt,
        cooldown_until as cooldownUntil,
        total_requests as totalRequests,
        total_errors as totalErrors,
        avg_latency_ms as avgLatencyMs
      FROM provider_health
    `).all() as any[];

    // Sync memory state
    return rows.map((r) => {
      const mem = this.memoryStates.get(r.providerId);
      return {
        ...r,
        state: mem ? mem.state : r.state,
      };
    });
  }
}

export const circuitBreaker = new CircuitBreakerManager();
