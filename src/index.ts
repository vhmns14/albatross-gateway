/**
 * Aegis AI Gateway - Main Server Entrypoint
 * High-performance, single-binary Bun HTTP server.
 */

import { handleChatCompletions, handleListModels } from "./proxy/handler";
import { handleConsoleApi } from "./api/console";
import { generateLocalEmbedding } from "./cache/semantic";
import { CONFIG } from "./config";
import { readFileSync } from "fs";
import { join } from "path";

const PORT = CONFIG.PORT;

// In-memory bundle cache for zero-latency UI loading
let cachedBundle: string | null = null;
let lastBuildTime = 0;

async function getFrontendBundle(): Promise<string> {
  const now = Date.now();
  // In development, rebuild if older than 2 seconds
  if (!cachedBundle || now - lastBuildTime > 2000) {
    const buildResult = await Bun.build({
      entrypoints: ["src/frontend/main.tsx"],
      target: "browser",
      minify: CONFIG.ENV === "production",
    });

    if (!buildResult.success) {
      console.error("[Aegis] Bundle build failed:", buildResult.logs);
      throw new Error("Failed to bundle frontend");
    }

    cachedBundle = await buildResult.outputs[0].text();
    lastBuildTime = now;
  }
  return cachedBundle;
}

const server = Bun.serve({
  port: PORT,
  hostname: CONFIG.HOST,
  async fetch(req) {
    const url = new URL(req.url);

    // Global CORS Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-Requested-With, User-Agent, X-Aegis-Key",
        },
      });
    }

    // 1. Static Frontend Assets
    if (url.pathname === "/app.js") {
      try {
        const bundle = await getFrontendBundle();
        return new Response(bundle, {
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      } catch (err: any) {
        return new Response(`console.error(${JSON.stringify(err.message)})`, {
          status: 500,
          headers: { "Content-Type": "application/javascript" },
        });
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = readFileSync(join(process.cwd(), "src/frontend/index.html"), "utf-8");
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } catch (e) {
        return new Response("Index HTML not found", { status: 404 });
      }
    }

    // 2. Health & Telemetry Ping
    if (url.pathname === "/health") {
      const memoryUsage = process.memoryUsage();
      return Response.json({
        status: "healthy",
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMb: {
          rss: Math.round(memoryUsage.rss / 1024 / 1024),
          heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        },
        version: "1.0.0",
      });
    }

    // 3. OpenAI-Compatible Core Endpoints
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      return handleChatCompletions(req);
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      return handleListModels();
    }

    if (url.pathname === "/v1/embeddings" && req.method === "POST") {
      try {
        const body = (await req.json()) as any;
        const input = body.input || "";
        const texts = Array.isArray(input) ? input : [input];
        const data = texts.map((t: string, idx: number) => ({
          object: "embedding",
          embedding: generateLocalEmbedding(t),
          index: idx,
        }));

        return Response.json({
          object: "list",
          data,
          model: body.model || "aegis-embed-local",
          usage: { prompt_tokens: texts.join(" ").length / 4, total_tokens: texts.join(" ").length / 4 },
        });
      } catch (err: any) {
        return Response.json({ error: { message: err.message } }, { status: 400 });
      }
    }

    // 4. Console Management API
    if (url.pathname.startsWith("/api/")) {
      return handleConsoleApi(req, url.pathname);
    }

    return new Response(JSON.stringify({ error: "Endpoint not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(`
🛡️  Aegis AI Gateway Online
──────────────────────────────────────────────────────────
 • Console UI:    http://localhost:${PORT}/
 • Core Proxy:    http://localhost:${PORT}/v1/chat/completions
 • Models API:    http://localhost:${PORT}/v1/models
 • Health Ping:   http://localhost:${PORT}/health
 • Memory Used:   ~${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RAM
──────────────────────────────────────────────────────────
`);
