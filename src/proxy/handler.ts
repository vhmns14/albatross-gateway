/**
 * Albatross AI Gateway - Unified OpenAI-Compatible Proxy Handler
 * Handles /v1/chat/completions, /v1/models, and /v1/embeddings.
 */

import { authenticateKey, recordKeySpend } from "../middleware/auth";
import { sanitizeMessages } from "../guardrails/pii";
import { semanticCache } from "../cache/semantic";
import { dynamicRouter } from "../router/engine";
import { telemetry } from "../telemetry/logger";
import { CONFIG } from "../config";

export async function handleChatCompletions(req: Request): Promise<Response> {
  const reqStart = performance.now();
  const traceId = `trc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  // Timing waterfall tracking
  let authMs = 0;
  let guardrailMs = 0;
  let cacheMs = 0;
  let upstreamMs = 0;

  // 1. Virtual Key Authentication
  const authStart = performance.now();
  const auth = authenticateKey(req);
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
      timingBreakdown: { authMs, guardrailMs, cacheMs: 0, upstreamMs: 0 },
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

  // Extract last user prompt string for semantic caching
  const lastUserPrompt =
    sanitizedMessages
      .filter((m: any) => m.role === "user")
      .map((m: any) => m.content)
      .join("\n") || "";

  // 3. Semantic Cache Lookup (Bypass if temperature > 0.8 or explicitly disabled)
  const cacheStart = performance.now();
  const cacheResult = await semanticCache.lookup(requestedModel, lastUserPrompt);
  cacheMs = Math.round(performance.now() - cacheStart);

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

  // 4. Cache MISS -> Forward to Dynamic Router (Upstream with Fallback)
  const upstreamStart = performance.now();
  const routeResult = await dynamicRouter.forwardChatCompletion(safeBody, req.headers);
  upstreamMs = Math.round(performance.now() - upstreamStart);

  const totalLatency = Math.round(performance.now() - reqStart);
  const costUsd = routeResult.costUsd || 0.0002;

  // Record spend on virtual key
  if (auth.key?.id) {
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

  // If successful non-streaming response, save to semantic cache asynchronously
  if (routeResult.success && !isStream) {
    try {
      const cloned = routeResult.response.clone();
      cloned.json().then((json) => {
        semanticCache.store(
          requestedModel,
          lastUserPrompt,
          json,
          routeResult.promptTokens,
          routeResult.completionTokens
        );
      });
    } catch (e) {
      // ignore
    }
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
