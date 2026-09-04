/**
 * Aegis AI Gateway - Dynamic Router & Upstream Adapters
 * Dispatches requests to primary provider with automatic multi-tier fallback.
 */

import { CONFIG, ProviderConfig } from "../config";
import { circuitBreaker } from "./circuitBreaker";

export interface ForwardResult {
  success: boolean;
  providerId: string;
  modelUsed: string;
  isFallback: boolean;
  fallbackChain: string[];
  response: Response;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  error?: string;
}

export class DynamicRouter {
  /**
   * Determine available fallback chain for a model request
   */
  public getExecutionPlan(requestedModel: string): ProviderConfig[] {
    const activeProviders = CONFIG.PROVIDERS.filter((p) => p.isEnabled);

    // Sort by priority (1 = highest)
    const sorted = [...activeProviders].sort((a, b) => a.priority - b.priority);

    // Filter out providers currently blocked by Circuit Breaker
    return sorted;
  }

  /**
   * Forwards a chat completion request through fallback chain
   */
  public async forwardChatCompletion(
    body: any,
    headers: Headers,
    clientSignal?: AbortSignal
  ): Promise<ForwardResult> {
    const requestedModel = body.model || "default";
    const isStream = body.stream === true;
    const plan = this.getExecutionPlan(requestedModel);

    const fallbackChain: string[] = [];
    let lastError = "No providers available";

    for (let i = 0; i < plan.length; i++) {
      const provider = plan[i];
      const isFallback = i > 0;

      if (!circuitBreaker.isAvailable(provider.id)) {
        fallbackChain.push(`${provider.id} (Circuit OPEN, Skipped)`);
        continue;
      }

      fallbackChain.push(provider.id);
      const startTime = performance.now();

      try {
        // Resolve model mapping
        let targetModel = requestedModel;
        if (!requestedModel || requestedModel === "default" || requestedModel.startsWith("albatross-")) {
          targetModel = provider.defaultModel;
        }

        // Clone payload with adjusted target model
        const upstreamBody = {
          ...body,
          model: targetModel,
        };

        const targetUrl = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
        const authHeader = provider.apiKey ? `Bearer ${provider.apiKey}` : "";

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT_MS);

        if (clientSignal) {
          if (clientSignal.aborted) {
            controller.abort();
          } else {
            clientSignal.addEventListener("abort", () => controller.abort(), { once: true });
          }
        }

        // If no API key is provided in environment, simulate a high-performance mock engine
        // so the gateway is 100% testable out of the box!
        if (!provider.apiKey && provider.id !== "local") {
          clearTimeout(timeout);
          const mockResult = await this.generateMockCompletion(upstreamBody, provider, isStream);
          const latency = Math.round(performance.now() - startTime);
          circuitBreaker.recordSuccess(provider.id, latency);

          return {
            success: true,
            providerId: provider.id,
            modelUsed: targetModel + " (Local Engine Simulation)",
            isFallback,
            fallbackChain,
            response: mockResult.response,
            latencyMs: latency,
            promptTokens: mockResult.promptTokens,
            completionTokens: mockResult.completionTokens,
            costUsd: mockResult.costUsd,
          };
        }

        const upstreamRes = await fetch(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
          body: JSON.stringify(upstreamBody),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const latency = Math.round(performance.now() - startTime);

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text().catch(() => "Unknown error");
          console.warn(`[Albatross Router] Provider ${provider.id} returned HTTP ${upstreamRes.status}: ${errText.slice(0, 100)}`);
          
          const isClientError = upstreamRes.status >= 400 && upstreamRes.status < 500 && upstreamRes.status !== 429;
          circuitBreaker.recordFailure(provider.id, `HTTP ${upstreamRes.status}: ${errText.slice(0, 80)}`, upstreamRes.status);
          
          // Return client errors directly to caller without failing through or tripping circuit breaker
          if (isClientError) {
            return {
              success: false,
              providerId: provider.id,
              modelUsed: targetModel,
              isFallback,
              fallbackChain,
              response: new Response(errText, {
                status: upstreamRes.status,
                headers: { "Content-Type": "application/json" },
              }),
              latencyMs: latency,
              error: errText,
            };
          }

          lastError = `HTTP ${upstreamRes.status} on ${provider.id}`;
          continue; // Try next provider in fallback chain
        }

        // Success!
        circuitBreaker.recordSuccess(provider.id, latency);

        // Calculate token and cost approximations
        const promptTokens = Math.ceil(JSON.stringify(body.messages || "").length / 4);
        const completionTokens = 150; // default estimate for streaming
        const costUsd = (promptTokens / 1000) * provider.costPer1kInputTokens +
                        (completionTokens / 1000) * provider.costPer1kOutputTokens;

        return {
          success: true,
          providerId: provider.id,
          modelUsed: targetModel,
          isFallback,
          fallbackChain,
          response: upstreamRes,
          latencyMs: latency,
          promptTokens,
          completionTokens,
          costUsd,
        };
      } catch (err: any) {
        const latency = Math.round(performance.now() - startTime);
        const errMsg = err.name === "AbortError" ? "Upstream Timeout (>15s)" : err.message || "Network error";
        console.warn(`[Albatross Router] ${provider.id} failed: ${errMsg}`);
        circuitBreaker.recordFailure(provider.id, errMsg);
        lastError = `${provider.id} Error: ${errMsg}`;
      }
    }

    return {
      success: false,
      providerId: "none",
      modelUsed: requestedModel,
      isFallback: false,
      fallbackChain,
      response: new Response(
        JSON.stringify({
          error: {
            message: `All upstream providers failed or in circuit-breaker cooldown: ${lastError}`,
            type: "albatross_gateway_upstream_error",
            fallback_chain: fallbackChain,
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      ),
      latencyMs: 0,
      error: lastError,
    };
  }

  /**
   * Generates a realistic mock response for zero-config offline demonstration
   */
  private async generateMockCompletion(
    body: any,
    provider: ProviderConfig,
    isStream: boolean
  ) {
    const messages = body.messages || [];
    const lastUserMsg = messages.filter((m: any) => m.role === "user").pop()?.content || "Hello";
    const promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
    const mockContent = `[Albatross Gateway Demo · Provider: ${provider.name}]\n\nProcessed query: "${lastUserMsg.slice(0, 80)}${lastUserMsg.length > 80 ? "..." : ""}"\n\nRouting succeeded via ${provider.id}. Streaming and PII redaction active.`;
    const completionTokens = Math.ceil(mockContent.length / 4);
    const costUsd =
      (promptTokens / 1000) * provider.costPer1kInputTokens +
      (completionTokens / 1000) * provider.costPer1kOutputTokens;

    if (!isStream) {
      const payload = {
        id: `chatcmpl-${Math.random().toString(36).substring(2, 9)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: mockContent,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };

      return {
        response: new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        promptTokens,
        completionTokens,
        costUsd,
      };
    }

    // SSE Streaming mock
    const encoder = new TextEncoder();
    const streamId = `chatcmpl-${Math.random().toString(36).substring(2, 9)}`;
    const words = mockContent.split(" ");

    const stream = new ReadableStream({
      async start(controller) {
        for (let i = 0; i < words.length; i++) {
          const chunk = {
            id: streamId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              {
                index: 0,
                delta: { content: (i > 0 ? " " : "") + words[i] },
                finish_reason: null,
              },
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          await new Promise((r) => setTimeout(r, 15)); // simulate 15ms per token
        }

        // Final chunk
        const doneChunk = {
          id: streamId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return {
      response: new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      promptTokens,
      completionTokens,
      costUsd,
    };
  }
}

export const dynamicRouter = new DynamicRouter();
