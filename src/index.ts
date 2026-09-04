/**
 * Albatross AI Gateway - Main Server Entrypoint
 * High-performance, single-binary Bun HTTP server.
 */

import { handleChatCompletions, handleListModels } from "./proxy/handler";
import { handleConsoleApi } from "./api/console";
import { generateLocalEmbedding } from "./cache/semantic";
import { authenticateKey, verifyAdminSession } from "./middleware/auth";
import { CONFIG } from "./config";
import { readFileSync } from "fs";
import { join } from "path";

const PORT = CONFIG.PORT;

// In-memory bundle & HTML cache for zero-latency UI loading
let cachedBundle: string | null = null;
let lastBuildTime = 0;
let cachedIndexHtml: string | null = null;
let cachedTailwindJs: string | null = null;

function getIndexHtml(): string {
  if (!cachedIndexHtml || CONFIG.ENV === "development") {
    cachedIndexHtml = readFileSync(join(process.cwd(), "src/frontend/index.html"), "utf-8");
  }
  return cachedIndexHtml;
}

function getTailwindJs(): string {
  if (!cachedTailwindJs || CONFIG.ENV === "development") {
    cachedTailwindJs = readFileSync(join(process.cwd(), "src/frontend/tailwind.js"), "utf-8");
  }
  return cachedTailwindJs;
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

// Global Security & CORS injection helper (OWASP Hardened)
function withSecurityHeaders(res: Response): Response {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, User-Agent, X-Albatross-Key, x-admin-key"
  );
  res.headers.set(
    "Access-Control-Expose-Headers",
    "X-Albatross-Trace-Id, X-Albatross-Cache, X-Albatross-Cache-Score, X-Albatross-Provider, X-Albatross-Model, X-Albatross-Latency-Ms, X-Albatross-Cost-USD, X-Albatross-PII-Redacted"
  );

  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:;"
  );

  return res;
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
          "Access-Control-Max-Age": "86400",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // 1. Static Frontend Assets
    if (url.pathname === "/tailwind.js") {
      try {
        const tw = getTailwindJs();
        return withSecurityHeaders(
          new Response(tw, {
            headers: {
              "Content-Type": "application/javascript; charset=utf-8",
              "Cache-Control": "public, max-age=86400",
            },
          })
        );
      } catch (e) {
        return withSecurityHeaders(new Response("Tailwind script not found", { status: 404 }));
      }
    }

    if (url.pathname === "/app.js") {
      try {
        const bundle = await getFrontendBundle();
        return withSecurityHeaders(
          new Response(bundle, {
            headers: {
              "Content-Type": "application/javascript; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          })
        );
      } catch (err: any) {
        return withSecurityHeaders(
          new Response(`console.error(${JSON.stringify(err.message)})`, {
            status: 500,
            headers: { "Content-Type": "application/javascript" },
          })
        );
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = getIndexHtml();
        return withSecurityHeaders(
          new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        );
      } catch (e) {
        return withSecurityHeaders(new Response("Index HTML not found", { status: 404 }));
      }
    }

    // 2. Health & Telemetry Ping (Footprinting protected)
    if (url.pathname === "/health") {
      const isAdmin = verifyAdminSession(req);

      // Only reveal uptime, memory breakdown, and version to authenticated admin
      if (isAdmin) {
        const memoryUsage = process.memoryUsage();
        return withSecurityHeaders(
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

      // Anonymous public probe (zero reconnaissance information)
      return withSecurityHeaders(
        Response.json({
          status: "healthy",
        })
      );
    }

    // 3. OpenAI-Compatible Core Endpoints
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const res = await handleChatCompletions(req);
      return withSecurityHeaders(res);
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      const res = handleListModels();
      return withSecurityHeaders(res);
    }

    if (url.pathname === "/v1/embeddings" && req.method === "POST") {
      const auth = authenticateKey(req);
      if (!auth.authorized) {
        return withSecurityHeaders(
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

        return withSecurityHeaders(
          Response.json({
            object: "list",
            data,
            model: body.model || "albatross-embed-local",
            usage: { prompt_tokens: texts.join(" ").length / 4, total_tokens: texts.join(" ").length / 4 },
          })
        );
      } catch (err: any) {
        return withSecurityHeaders(Response.json({ error: { message: err.message } }, { status: 400 }));
      }
    }

    // 4. Console Management API
    if (url.pathname.startsWith("/api/")) {
      const res = await handleConsoleApi(req, url.pathname);
      return withSecurityHeaders(res);
    }

    return withSecurityHeaders(
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
