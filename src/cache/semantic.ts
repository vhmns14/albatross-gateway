/**
 * Aegis AI Gateway - Semantic Caching Engine
 * Sub-millisecond vector similarity caching with zero external daemon overhead.
 */

import { db } from "../db";
import { CONFIG } from "../config";

export interface CacheLookupResult {
  hit: boolean;
  similarity: number;
  cachedResponse?: any;
  cacheId?: string;
}

// 128-dimensional dense vector generator using character/word n-gram hashing
// Provides high-speed semantic proximity without downloading 500MB PyTorch weights.
export function generateLocalEmbedding(text: string, dimensions = 128): number[] {
  const vector = new Array(dimensions).fill(0);
  const normalized = text.toLowerCase().trim().replace(/[\r\n\t]+/g, " ");
  
  // Word tokens
  const words = normalized.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;

    // Word hash
    let hash = 0;
    for (let c = 0; c < word.length; c++) {
      hash = (hash << 5) - hash + word.charCodeAt(c);
      hash |= 0;
    }
    const idx = Math.abs(hash) % dimensions;
    vector[idx] += 1.5;

    // Word bigram hash
    if (i < words.length - 1) {
      const bigram = `${word}_${words[i + 1]}`;
      let bHash = 0;
      for (let c = 0; c < bigram.length; c++) {
        bHash = (bHash << 5) - bHash + bigram.charCodeAt(c);
        bHash |= 0;
      }
      vector[Math.abs(bHash) % dimensions] += 2.0;
    }

    // Character 3-grams for typo resilience
    for (let j = 0; j < word.length - 2; j++) {
      const trigram = word.substring(j, j + 3);
      let tHash = 0;
      for (let c = 0; c < trigram.length; c++) {
        tHash = (tHash << 5) - tHash + trigram.charCodeAt(c);
        tHash |= 0;
      }
      vector[Math.abs(tHash) % dimensions] += 0.5;
    }
  }

  // L2 Normalization so dot-product equals cosine similarity
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] = vector[i] / norm;
    }
  }

  return vector;
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  return Math.min(1.0, Math.max(0.0, dotProduct));
}

export class SemanticCache {
  private threshold: number;

  constructor(threshold = CONFIG.SIMILARITY_THRESHOLD) {
    this.threshold = threshold;
  }

  public setThreshold(val: number) {
    this.threshold = Math.max(0.5, Math.min(1.0, val));
  }

  public getThreshold(): number {
    return this.threshold;
  }

  /**
   * Look up prompt in cache with optional context/system prompt namespace
   */
  public async lookup(
    model: string,
    promptText: string,
    contextHash = "global"
  ): Promise<CacheLookupResult> {
    if (!CONFIG.CACHE_ENABLED || !promptText) {
      return { hit: false, similarity: 0.0 };
    }

    const cacheKeyModel = `${model}:${contextHash}`;

    // 1. Check exact SHA-256 hash first (<1ms)
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(promptText.trim());
    const promptHash = hasher.digest("hex");

    const exactMatch = db
      .query(
        "SELECT id, response_payload, hit_count FROM semantic_cache WHERE model = ? AND prompt_hash = ? LIMIT 1"
      )
      .get(cacheKeyModel, promptHash) as any;

    if (exactMatch) {
      // Update hit counter
      db.query(
        "UPDATE semantic_cache SET hit_count = hit_count + 1, last_hit_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(exactMatch.id);

      try {
        const payload = JSON.parse(exactMatch.response_payload);
        return {
          hit: true,
          similarity: 1.0,
          cachedResponse: payload,
          cacheId: exactMatch.id,
        };
      } catch (e) {
        // Corrupted JSON fallback
      }
    }

    // 2. Compute vector embedding
    const queryVector = generateLocalEmbedding(promptText);

    // 3. Scan recent candidate vectors (Only fetch embedding_vector to minimize RAM footprint)
    const candidates = db
      .query(
        "SELECT id, embedding_vector FROM semantic_cache WHERE model = ? ORDER BY last_hit_at DESC LIMIT 200"
      )
      .all(cacheKeyModel) as any[];

    let bestSimilarity = 0.0;
    let bestMatchId: string | null = null;

    for (const cand of candidates) {
      try {
        const candVector = JSON.parse(cand.embedding_vector);
        const sim = cosineSimilarity(queryVector, candVector);
        if (sim > bestSimilarity) {
          bestSimilarity = sim;
          bestMatchId = cand.id;
        }
      } catch (err) {
        continue;
      }
    }

    if (bestMatchId && bestSimilarity >= this.threshold) {
      db.query(
        "UPDATE semantic_cache SET hit_count = hit_count + 1, last_hit_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(bestMatchId);

      const matchedRow = db
        .query("SELECT response_payload FROM semantic_cache WHERE id = ? LIMIT 1")
        .get(bestMatchId) as any;

      if (matchedRow) {
        try {
          const payload = JSON.parse(matchedRow.response_payload);
          return {
            hit: true,
            similarity: Number(bestSimilarity.toFixed(4)),
            cachedResponse: payload,
            cacheId: bestMatchId,
          };
        } catch (e) {
          // continue
        }
      }
    }

    return {
      hit: false,
      similarity: Number(bestSimilarity.toFixed(4)),
    };
  }

  /**
   * Save successful completion into semantic cache
   */
  public async store(
    model: string,
    promptText: string,
    responsePayload: any,
    promptTokens = 0,
    completionTokens = 0,
    contextHash = "global"
  ): Promise<string> {
    if (!CONFIG.CACHE_ENABLED || !promptText) return "";

    const cacheKeyModel = `${model}:${contextHash}`;
    const id = `cache_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(promptText.trim());
    const promptHash = hasher.digest("hex");

    const vector = generateLocalEmbedding(promptText);

    db.query(`
      INSERT OR REPLACE INTO semantic_cache (
        id, model, prompt_hash, prompt_raw, embedding_vector, response_payload, prompt_tokens, completion_tokens, hit_count, last_hit_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    `).run(
      id,
      cacheKeyModel,
      promptHash,
      promptText.slice(0, 500), // store bounded snippet
      JSON.stringify(vector),
      JSON.stringify(responsePayload),
      promptTokens,
      completionTokens
    );

    return id;
  }

  /**
   * Purge cache entries
   */
  public purge(model?: string): number {
    if (model) {
      const res = db.query("DELETE FROM semantic_cache WHERE model LIKE ?").run(`${model}%`);
      return res.changes;
    }
    const res = db.query("DELETE FROM semantic_cache").run();
    return res.changes;
  }

  /**
   * Retrieve statistics
   */
  public getStats(isAdmin = false) {
    const totalEntries = (
      db.query("SELECT COUNT(*) as count FROM semantic_cache").get() as any
    )?.count || 0;
    const totalHits = (
      db.query("SELECT SUM(hit_count) as total FROM semantic_cache").get() as any
    )?.total || 0;
    const topQueries = db
      .query(
        "SELECT id, model, prompt_raw, hit_count, last_hit_at FROM semantic_cache ORDER BY hit_count DESC LIMIT 10"
      )
      .all() as any[];

    // Strip prompt_raw completely if not authenticated admin to prevent user prompt exposure
    const safeTopQueries = topQueries.map((q) => ({
      id: q.id,
      model: q.model,
      hit_count: q.hit_count,
      last_hit_at: q.last_hit_at,
      prompt_preview: isAdmin ? q.prompt_raw : "[Protected by Albatross Guardrails]",
      ...(isAdmin ? { prompt_raw: q.prompt_raw } : {}),
    }));

    return {
      totalEntries,
      totalHits,
      threshold: this.threshold,
      topQueries: safeTopQueries,
    };
  }
}

export const semanticCache = new SemanticCache();
