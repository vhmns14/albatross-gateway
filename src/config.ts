/**
 * Albatross AI Gateway - Configuration
 */

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  costPer1kInputTokens: number;  // USD
  costPer1kOutputTokens: number; // USD
  priority: number;              // 1 = primary, 2 = secondary, 3 = tertiary
  isEnabled: boolean;
}

export const CONFIG = {
  PORT: Number(process.env.PORT) || 8788,
  HOST: process.env.HOST || "0.0.0.0",
  ENV: process.env.NODE_ENV || "development",
  
  // Security & Admin Credentials
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "albatross-admin-2026",
  PUBLIC_IP_RPM_LIMIT: Number(process.env.PUBLIC_IP_RPM_LIMIT) || 5, // max 5 req/min per IP
  MAX_PUBLIC_TOKENS: 250, // prevent huge token drains from public visitors
  
  // Semantic Cache Configuration
  CACHE_ENABLED: process.env.ALBATROSS_CACHE_ENABLED !== "false",
  SIMILARITY_THRESHOLD: Number(process.env.ALBATROSS_SIMILARITY_THRESHOLD) || 0.90,
  CACHE_TTL_SECONDS: Number(process.env.ALBATROSS_CACHE_TTL) || 86400 * 7, // 7 days default
  
  // Guardrails Configuration
  GUARDRAILS_ENABLED: process.env.ALBATROSS_GUARDRAILS_ENABLED !== "false",
  BLOCK_ON_INJECTION: process.env.ALBATROSS_BLOCK_INJECTION === "true", // false = sanitize & warn
  
  // Circuit Breaker Settings
  MAX_CONSECUTIVE_ERRORS: 3,
  COOLDOWN_PERIOD_MS: 30_000, // 30 seconds
  UPSTREAM_TIMEOUT_MS: 30_000, // 30 seconds (accommodate reasoning/thinking models)
  
  // Upstream Providers (Prioritized Fallback Chain)
  PROVIDERS: [
    {
      id: "justwoker",
      name: "JustWoker Frontier API (Claude Opus 5)",
      baseUrl: process.env.UPSTREAM_BASE_URL || "https://api.justwoker.icu/v1",
      apiKey: process.env.UPSTREAM_API_KEY || "sk-51CwkIEk5K8v19LjPealL57XFJFSRTRYNSecZNfbjMNqJw7h",
      defaultModel: process.env.UPSTREAM_MODEL || "claude-opus-5",
      costPer1kInputTokens: 0.003,
      costPer1kOutputTokens: 0.015,
      priority: 1,
      isEnabled: true,
    },
    {
      id: "groq",
      name: "Groq LPU (Ultra-Low Latency)",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY || "",
      defaultModel: "llama-3.3-70b-versatile",
      costPer1kInputTokens: 0.00059,
      costPer1kOutputTokens: 0.00079,
      priority: 2,
      isEnabled: true,
    },
    {
      id: "gemini",
      name: "Google Gemini Flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GEMINI_API_KEY || "",
      defaultModel: "gemini-2.0-flash",
      costPer1kInputTokens: 0.00010,
      costPer1kOutputTokens: 0.00040,
      priority: 3,
      isEnabled: true,
    },
    {
      id: "openai",
      name: "OpenAI GPT-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY || "",
      defaultModel: "gpt-4o-mini",
      costPer1kInputTokens: 0.00015,
      costPer1kOutputTokens: 0.00060,
      priority: 4,
      isEnabled: true,
    },
    {
      id: "local",
      name: "Local vLLM / Ollama (Zero Cost)",
      baseUrl: process.env.LOCAL_LLM_URL || "http://localhost:11434/v1",
      apiKey: "local-dev-key",
      defaultModel: "llama3.2:3b",
      costPer1kInputTokens: 0.0,
      costPer1kOutputTokens: 0.0,
      priority: 5,
      isEnabled: false,
    }
  ] as ProviderConfig[],

  // USD to IDR estimation for local telemetry
  USD_TO_IDR_RATE: 16200,
};
