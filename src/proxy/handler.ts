/**
 * Albatross AI Gateway - Unified OpenAI-Compatible Proxy Handler
 * Handles /v1/chat/completions, /v1/models, and /v1/embeddings.
 */

import { authenticateKey, recordKeySpend, getClientIp, safeCompare, checkRateLimit } from "../middleware/auth";
import { sanitizeMessages } from "../guardrails/pii";
import { semanticCache } from "../cache/semantic";
import { dynamicRouter } from "../router/engine";
import { telemetry } from "../telemetry/logger";
import { CONFIG } from "../config";

export async function handleChatCompletions(
  req: Request,
  options: { isPlayground?: boolean } = {}
): Promise<Response> {
  const reqStart = performance.now();
  const traceId = `trc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  // Timing waterfall tracking
  let authMs = 0;
  let guardrailMs = 0;
  let cacheMs = 0;
  let upstreamMs = 0;

  // Check body size limit (prevent DoS)
  const contentLength = Number(req.headers.get("content-length") || "0");
  if (contentLength > CONFIG.MAX_BODY_BYTES) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Payload too large. Maximum size is ${CONFIG.MAX_BODY_BYTES / 1024 / 1024}MB.`,
          type: "invalid_request_error",
        },
      }),
      { status: 413, headers: { "Content-Type": "application/json", "X-Albatross-Trace-Id": traceId } }
    );
  }

  // 1. Authentication
  const authStart = performance.now();
  let auth: any;
  if (options.isPlayground) {
    const clientIp = getClientIp(req);
    const adminKey = req.headers.get("x-admin-key") || "";
    const isAdmin = safeCompare(adminKey, CONFIG.ADMIN_PASSWORD);
    const rateCheck = checkRateLimit(clientIp, isAdmin);

    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ error: { message: rateCheck.error, type: "rate_limit_error" } }),
        { status: 429, headers: { "Content-Type": "application/json", "X-Albatross-Trace-Id": traceId } }
      );
    }

    auth = {
      authorized: true,
      key: { id: "playground_public", name: "Public Playground Demo", prefix: "demo" },
      clientIp,
      isAdmin,
    };
  } else {
    auth = authenticateKey(req);
  }
  authMs = Math.round(performance.now() - authStart);

  if (!auth.authorized) {
    const totalLatency = Math.round(performance.now() - reqStart);
    telemetry.logTrace({
      traceId,
      endpoint: "/v1/chat/completions",
      modelRequested: "unknown",
      statusCode: auth.statusCode || 401,
      isCacheHit: false,
      cacheSimilarity: 0,
      piiRedactedCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      latencyMs: totalLatency,
      timingBreakdown: { authMs, guardrailMs: 0, cacheMs: 0, upstreamMs: 0 },
      errorMessage: auth.error,
    });

    return new Response(
      JSON.stringify({ error: { message: auth.error, type: "authentication_error" } }),
      {
        status: auth.statusCode || 401,
        headers: { "Content-Type": "application/json", "X-Albatross-Trace-Id": traceId },
      }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const requestedModel = body.model || "albatross-auto";
  const messages = body.messages || [];
  const isStream = body.stream === true;

  // Enforce token generation ceiling for public requests to prevent quota draining
  if (!auth.isAdmin && (!body.max_tokens || body.max_tokens > CONFIG.MAX_PUBLIC_TOKENS)) {
    body.max_tokens = CONFIG.MAX_PUBLIC_TOKENS;
  }

  // 2. In-Flight Guardrails & PII Sanitizer
  const guardStart = performance.now();
  const { sanitizedMessages, totalRedacted, allEntities, isInjectionRisk, injectionFlags } =
    sanitizeMessages(messages);
  guardrailMs = Math.round(performance.now() - guardStart);

  // If strict block on injection is active
  if (isInjectionRisk && CONFIG.BLOCK_ON_INJECTION) {
    const totalLatency = Math.round(performance.now() - reqStart);
    telemetry.logTrace({
      traceId,
      keyId: auth.key?.id,
      endpoint: "/v1/chat/completions",
      modelRequested: requestedModel,
      statusCode: 422,
      isCacheHit: false,
      cacheSimilarity: 0,
      piiRedactedCount: totalRedacted,
      piiTypesDetected: allEntities,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      latencyMs: totalLatency,
      timingBreakdown: { authMs, guardrailMs: 0, cacheMs: 0, upstreamMs: 0 },
      errorMessage: `Safety Policy Violation: Prompt injection patterns detected (${injectionFlags.join(", ")})`,
    });

    return new Response(
      JSON.stringify({
        error: {
          message: "Request blocked by Albatross Guardrails: Potential prompt injection or policy breach.",
          type: "guardrails_violation",
          flags: injectionFlags,
        },
      }),
      { status: 422, headers: { "Content-Type": "application/json", "X-Albatross-Trace-Id": traceId } }
    );
  }

  // Sanitized body
  const safeBody = {
    ...body,
    messages: sanitizedMessages,
  };

  // Extract last user prompt string (supporting multimodal array or text)
  const lastUserPrompt =
    sanitizedMessages
      .filter((m: any) => m.role === "user")
      .map((m: any) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .filter((p: any) => p && typeof p.text === "string")
            .map((p: any) => p.text)
            .join(" ");
        }
        return "";
      })
      .join("\n") || "";

  // Extract system prompt persona to namespace cache (prevents cross-persona cache poisoning)
  const systemPrompt = sanitizedMessages
    .filter((m: any) => m.role === "system")
    .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  const contextHash = systemPrompt
    ? new Bun.CryptoHasher("sha256").update(systemPrompt.trim()).digest("hex").slice(0, 16)
    : "global";

  // Temperature bypass: skip cache if temperature > 0.5 (user requested creative / diverse generation)
  const isHighTemperature = typeof body.temperature === "number" && body.temperature > 0.5;

  // 3. Semantic Cache Lookup
  let cacheResult = { hit: false, similarity: 0.0, cachedResponse: undefined as any };
  if (!isHighTemperature) {
    const cacheStart = performance.now();
    cacheResult = await semanticCache.lookup(requestedModel, lastUserPrompt, contextHash);
    cacheMs = Math.round(performance.now() - cacheStart);
  }

  if (cacheResult.hit && cacheResult.cachedResponse) {
    const totalLatency = Math.round(performance.now() - reqStart);

    telemetry.logTrace({
      traceId,
      keyId: auth.key?.id,
      endpoint: "/v1/chat/completions",
      modelRequested: requestedModel,
      providerUsed: "semantic_cache",
      modelUsed: "semantic_cache",
      statusCode: 200,
      isCacheHit: true,
      cacheSimilarity: cacheResult.similarity,
      piiRedactedCount: totalRedacted,
      piiTypesDetected: allEntities,
      promptTokens: cacheResult.cachedResponse.usage?.prompt_tokens || 10,
      completionTokens: cacheResult.cachedResponse.usage?.completion_tokens || 50,
      costUsd: 0.0, // Cache Hit = $0 spend!
      latencyMs: totalLatency,
      timingBreakdown: { authMs, guardrailMs, cacheMs, upstreamMs: 0 },
    });

    if (isStream) {
      // Simulate rapid stream for cached response
      const encoder = new TextEncoder();
      const cachedContent =
        cacheResult.cachedResponse.choices?.[0]?.message?.content || "";
      const stream = new ReadableStream({
        start(controller) {
          const chunk = {
            id: `chatcmpl-cache-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [{ index: 0, delta: { content: cachedContent }, finish_reason: "stop" }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Albatross-Trace-Id": traceId,
          "X-Albatross-Cache": "HIT",
          "X-Albatross-Cache-Score": cacheResult.similarity.toString(),
          "X-Albatross-Latency-Ms": totalLatency.toString(),
          "X-Albatross-Cost-USD": "0.0000",
        },
      });
    }

    return new Response(JSON.stringify(cacheResult.cachedResponse), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Albatross-Trace-Id": traceId,
        "X-Albatross-Cache": "HIT",
        "X-Albatross-Cache-Score": cacheResult.similarity.toString(),
        "X-Albatross-Latency-Ms": totalLatency.toString(),
        "X-Albatross-Cost-USD": "0.0000",
      },
    });
  }

  // 4. Cache MISS -> Forward to Dynamic Router (Upstream with Fallback & Client Abort Signal)
  const upstreamStart = performance.now();
  const routeResult = await dynamicRouter.forwardChatCompletion(safeBody, req.headers, req.signal);
  upstreamMs = Math.round(performance.now() - upstreamStart);

  const totalLatency = Math.round(performance.now() - reqStart);
  const costUsd = routeResult.costUsd || 0.0002;

  // Record spend on virtual key
  if (auth.key?.id && auth.key.id !== "playground_public") {
    recordKeySpend(auth.key.id, costUsd);
  }

  // Log Trace
  telemetry.logTrace({
    traceId,
    keyId: auth.key?.id,
    endpoint: "/v1/chat/completions",
    modelRequested: requestedModel,
    providerUsed: routeResult.providerId,
    modelUsed: routeResult.modelUsed,
    statusCode: routeResult.response.status,
    isCacheHit: false,
    cacheSimilarity: cacheResult.similarity,
    piiRedactedCount: totalRedacted,
    piiTypesDetected: allEntities,
    promptTokens: routeResult.promptTokens || 0,
    completionTokens: routeResult.completionTokens || 0,
    costUsd,
    latencyMs: totalLatency,
    timingBreakdown: { authMs, guardrailMs, cacheMs, upstreamMs },
    errorMessage: routeResult.error,
  });

  // Prepare response headers
  const resHeaders = new Headers(routeResult.response.headers);
  resHeaders.set("X-Albatross-Trace-Id", traceId);
  resHeaders.set("X-Albatross-Cache", "MISS");
  resHeaders.set("X-Albatross-Provider", routeResult.providerId);
  resHeaders.set("X-Albatross-Model", routeResult.modelUsed);
  resHeaders.set("X-Albatross-Latency-Ms", totalLatency.toString());
  resHeaders.set("X-Albatross-Cost-USD", costUsd.toFixed(6));
  resHeaders.set("X-Albatross-PII-Redacted", totalRedacted.toString());

  // If successful non-streaming response, save to semantic cache
  if (routeResult.success && !isHighTemperature && !isStream) {
    try {
      const cloned = routeResult.response.clone();
      cloned.json().then((json) => {
        semanticCache.store(
          requestedModel,
          lastUserPrompt,
          json,
          routeResult.promptTokens,
          routeResult.completionTokens,
          contextHash
        );
      });
    } catch (e) {
      // ignore
    }
  }

  // If successful streaming response, tee stream to asynchronously capture & cache
  if (routeResult.success && !isHighTemperature && isStream && routeResult.response.body) {
    const [clientStream, cacheStream] = routeResult.response.body.tee();

    (async () => {
      try {
        const reader = cacheStream.getReader();
        const decoder = new TextDecoder();
        let fullAssistantContent = "";
        let doneReading = false;

        while (!doneReading) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkText = decoder.decode(value, { stream: true });
          const lines = chunkText.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ") && !line.includes("[DONE]")) {
              try {
                const parsed = JSON.parse(line.slice(6));
                const delta = parsed.choices?.[0]?.delta?.content || "";
                fullAssistantContent += delta;
              } catch (err) {}
            }
          }
        }

        if (fullAssistantContent) {
          const payload = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: fullAssistantContent },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: routeResult.promptTokens || 10,
              completion_tokens: Math.ceil(fullAssistantContent.length / 4),
              total_tokens: (routeResult.promptTokens || 10) + Math.ceil(fullAssistantContent.length / 4),
            },
          };
          semanticCache.store(
            requestedModel,
            lastUserPrompt,
            payload,
            routeResult.promptTokens,
            Math.ceil(fullAssistantContent.length / 4),
            contextHash
          );
        }
      } catch (e) {
        // Stream read aborted or closed
      }
    })();

    return new Response(clientStream, {
      status: routeResult.response.status,
      headers: resHeaders,
    });
  }

  return new Response(routeResult.response.body, {
    status: routeResult.response.status,
    headers: resHeaders,
  });
}

export function handleListModels(): Response {
  const models = [
    { id: "albatross-auto", object: "model", created: 1700000000, owned_by: "albatross-gateway" },
    { id: "claude-opus-5", object: "model", created: 1700000000, owned_by: "anthropic" },
    { id: "claude-opus-5-thinking", object: "model", created: 1700000000, owned_by: "anthropic" },
    { id: "llama-3.3-70b-versatile", object: "model", created: 1700000000, owned_by: "groq" },
    { id: "gemini-2.0-flash", object: "model", created: 1700000000, owned_by: "google" },
    { id: "gpt-4o-mini", object: "model", created: 1700000000, owned_by: "openai" },
    { id: "text-embedding-3-small", object: "model", created: 1700000000, owned_by: "openai" },
  ];

  return new Response(JSON.stringify({ object: "list", data: models }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
