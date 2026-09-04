/**
 * Albatross AI Gateway - Main Server Entrypoint
 * High-performance, single-binary Bun HTTP server.
 */

import { handleChatCompletions, handleListModels } from "./proxy/handler";
import { handleConsoleApi } from "./api/console";
import { generateLocalEmbedding } from "./cache/semantic";
import { authenticateKey } from "./middleware/auth";
import { CONFIG } from "./config";
import { readFileSync } from "fs";
import { join } from "path";

const PORT = CONFIG.PORT;

// In-memory bundle & HTML cache for zero-latency UI loading
let cachedBundle: string | null = null;
let lastBuildTime = 0;
let cachedIndexHtml: string | null = null;

function getIndexHtml(): string {
  if (!cachedIndexHtml || CONFIG.ENV === "development") {
    cachedIndexHtml = readFileSync(join(process.cwd(), "src/frontend/index.html"), "utf-8");
  }
  return cachedIndexHtml;
}

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
      console.error("[Albatross] Bundle build failed:", buildResult.logs);
      throw new Error("Failed to bundle frontend");
    }

    cachedBundle = await buildResult.outputs[0].text();
    lastBuildTime = now;
  }
  return cachedBundle;
}

// Global CORS injection helper
function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, User-Agent, X-Albatross-Key, x-admin-key"
  );
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
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
            "Content-Type, Authorization, X-Requested-With, User-Agent, X-Albatross-Key, x-admin-key",
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
        const html = getIndexHtml();
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
      return withCors(
        Response.json({
          status: "healthy",
          uptimeSeconds: Math.floor(process.uptime()),
          memoryMb: {
            rss: Math.round(memoryUsage.rss / 1024 / 1024),
            heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          },
          version: "1.0.0",
        })
      );
    }

    // 3. OpenAI-Compatible Core Endpoints
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const res = await handleChatCompletions(req);
      return withCors(res);
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      const res = handleListModels();
      return withCors(res);
    }

    if (url.pathname === "/v1/embeddings" && req.method === "POST") {
      const auth = authenticateKey(req);
      if (!auth.authorized) {
        return withCors(
          new Response(
            JSON.stringify({ error: { message: auth.error, type: "authentication_error" } }),
            { status: auth.statusCode || 401, headers: { "Content-Type": "application/json" } }
          )
        );
      }

      try {
        const body = (await req.json()) as any;
        const input = body.input || "";
        const texts = (Array.isArray(input) ? input : [input]).slice(0, 100); // bound to 100 texts max
        const data = texts.map((t: string, idx: number) => ({
          object: "embedding",
          embedding: generateLocalEmbedding(t),
          index: idx,
        }));

        return withCors(
          Response.json({
            object: "list",
            data,
            model: body.model || "albatross-embed-local",
            usage: { prompt_tokens: texts.join(" ").length / 4, total_tokens: texts.join(" ").length / 4 },
          })
        );
      } catch (err: any) {
        return withCors(Response.json({ error: { message: err.message } }, { status: 400 }));
      }
    }

    // 4. Console Management API
    if (url.pathname.startsWith("/api/")) {
      const res = await handleConsoleApi(req, url.pathname);
      return withCors(res);
    }

    return withCors(
      new Response(JSON.stringify({ error: "Endpoint not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    );
  },
});

console.log(`
🪶  Albatross AI Gateway Online
──────────────────────────────────────────────────────────
 • Console UI:    http://localhost:${PORT}/
 • Core Proxy:    http://localhost:${PORT}/v1/chat/completions
 • Models API:    http://localhost:${PORT}/v1/models
 • Health Ping:   http://localhost:${PORT}/health
 • Memory Used:   ~${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RAM
──────────────────────────────────────────────────────────
`);
