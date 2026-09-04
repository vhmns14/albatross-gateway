/**
 * Albatross AI Gateway - SQLite Database Layer
 * Uses Bun:sqlite for zero-daemon, sub-millisecond local queries.
 * Database files (*.db) are strictly excluded from Git.
 */

import { Database } from "bun:sqlite";
import { join } from "path";

// DB Path inside project directory
const DB_PATH = join(process.cwd(), "albatross.db");
export const db = new Database(DB_PATH);

// Enable WAL mode for high concurrency
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");

export function initDatabase() {
  // 1. Virtual API Keys Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS virtual_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      prefix TEXT NOT NULL,
      spend_limit_usd REAL DEFAULT 100.0,
      current_spend_usd REAL DEFAULT 0.0,
      rate_limit_rpm INTEGER DEFAULT 600,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Request Traces / Telemetry Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_traces (
      id TEXT PRIMARY KEY,
      trace_id TEXT UNIQUE NOT NULL,
      key_id TEXT,
      client_ip TEXT,
      endpoint TEXT NOT NULL,
      model_requested TEXT NOT NULL,
      provider_used TEXT,
      model_used TEXT,
      status_code INTEGER NOT NULL,
      is_cache_hit INTEGER DEFAULT 0,
      cache_similarity REAL DEFAULT 0.0,
      pii_redacted_count INTEGER DEFAULT 0,
      pii_types_detected TEXT, -- JSON array
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0.0,
      latency_ms REAL NOT NULL,
      timing_breakdown TEXT, -- JSON { auth_ms, guardrail_ms, cache_ms, upstream_ms }
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_traces_created ON request_traces(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON request_traces(trace_id);
  `);

  // 3. Semantic Cache Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_cache (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      prompt_raw TEXT NOT NULL,
      embedding_vector TEXT NOT NULL, -- JSON array of floats
      response_payload TEXT NOT NULL, -- JSON cached completion
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      hit_count INTEGER DEFAULT 0,
      last_hit_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cache_model ON semantic_cache(model);
    CREATE INDEX IF NOT EXISTS idx_cache_hash ON semantic_cache(prompt_hash);
  `);

  // 4. Circuit Breaker Provider Health Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_health (
      provider_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'CLOSED', -- 'CLOSED' (UP), 'OPEN' (DOWN), 'HALF_OPEN'
      consecutive_errors INTEGER DEFAULT 0,
      last_error TEXT,
      last_error_at DATETIME,
      cooldown_until DATETIME,
      total_requests INTEGER DEFAULT 0,
      total_errors INTEGER DEFAULT 0,
      avg_latency_ms REAL DEFAULT 0.0
    );
  `);

  // Insert default root virtual key if none exists
  const existingKey = db.query("SELECT id FROM virtual_keys LIMIT 1").get();
  if (!existingKey) {
    const defaultRawKey = "sk-albatross-root-master-key";
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(defaultRawKey);
    const keyHash = hasher.digest("hex");

    db.query(`
      INSERT INTO virtual_keys (id, name, key_hash, prefix, spend_limit_usd, current_spend_usd, rate_limit_rpm, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "key_root_01",
      "Production Root Gateway Key",
      keyHash,
      "sk-albatross-root",
      500.0,
      0.0,
      1200,
      1
    );
    console.log("[Albatross DB] Initialized default key: sk-albatross-root-master-key");
  }
}

// Ensure database tables exist on module load
initDatabase();
