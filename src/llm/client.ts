// Thin, swappable LLM provider wrapper. Exactly two mandatory calls use
// this (extract, recalibrate) plus one optional templated call
// (draftOutreach). Nothing else in the pipeline calls an LLM — see
// CLAUDE.md. Swapping providers means editing only this file.

const PROVIDER = process.env.LLM_PROVIDER ?? "anthropic";

/** Bump when an LLM prompt or its expected output contract changes. */
export const LLM_CASSETTE_VERSION = "v1";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface LlmCompletion {
  text: string;
  usage: LlmUsage | null;
}

/**
 * Approximate list pricing (USD per million tokens), for demo cost
 * visibility only — NOT billing-accurate. Provider pricing pages change
 * independently of this file; verify against them before treating
 * llm_cost_dollars as authoritative. Token counts themselves (llm_input_tokens
 * /llm_output_tokens on CostLedger) ARE the real, provider-reported numbers —
 * only the dollar conversion below is an estimate.
 */
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "gemini-flash-latest": { input: 0.075, output: 0.3 },
};

export function estimateCostDollars(usage: LlmUsage): number | null {
  const pricing = PRICING_PER_MILLION_TOKENS[usage.model];
  if (!pricing) return null;
  return (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) / 1_000_000;
}

class RetryableLlmError extends Error {}

function apiKey(): string {
  const key = process.env.LLM_PROVIDER_API_KEY;
  if (!key) {
    throw new Error("LLM_PROVIDER_API_KEY is not set. Put a key for LLM_PROVIDER in .env.");
  }
  return key;
}

async function completeOnce(prompt: string, opts: { maxTokens?: number }): Promise<LlmCompletion> {
  switch (PROVIDER) {
    case "anthropic": {
      const model = "claude-haiku-4-5-20251001";
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey(),
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 300,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        const msg = `Anthropic API call failed: HTTP ${res.status}`;
        if (res.status === 429 || res.status >= 500) throw new RetryableLlmError(msg);
        throw new Error(msg);
      }
      const data = (await res.json()) as {
        content: { type: string; text?: string }[];
        usage?: { input_tokens: number; output_tokens: number };
      };
      const text = data.content.find((block) => block.type === "text")?.text;
      if (!text) throw new Error("Anthropic response contained no text block.");
      const usage = data.usage
        ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens, model }
        : null;
      return { text, usage };
    }
    case "gemini": {
      // Model alias, not a pinned version — always resolves to the current
      // GA flash model, so this doesn't go stale as Gemini ships new models.
      const model = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
      // The current flash-tier models are "thinking" models: internal
      // reasoning tokens are drawn from the SAME maxOutputTokens budget as
      // the visible answer. gemini-3.6-flash rejects thinkingConfig with a
      // 400 (INVALID_ARGUMENT) if asked to disable thinking outright, so
      // instead of fighting that, we just pad maxOutputTokens well past the
      // caller's ask to leave room for both the reasoning and the (short)
      // visible answer these calls actually need.
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey()}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: Math.max(opts.maxTokens ?? 300, 2048),
            },
          }),
        },
      );
      if (!res.ok) {
        const errBody = await res.text();
        const msg = `Gemini API call failed: HTTP ${res.status} — ${errBody.slice(0, 500)}`;
        if (res.status === 429 || res.status >= 500) throw new RetryableLlmError(msg);
        throw new Error(msg);
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      // Skip any "thought" parts — the real answer is the first non-thought
      // text part (thinking models may emit both in one response).
      const text = parts.find((p) => p.text && !p.thought)?.text;
      if (!text) {
        throw new Error(
          `Gemini response contained no usable text part (finishReason=${data.candidates?.[0]?.finishReason}): ` +
            JSON.stringify(data).slice(0, 500),
        );
      }
      const usage = data.usageMetadata
        ? {
            inputTokens: data.usageMetadata.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
            model,
          }
        : null;
      return { text, usage };
    }
    default:
      throw new Error(
        `LLM_PROVIDER="${PROVIDER}" is not wired up in src/llm/client.ts. ` +
          `Add a case for it, or set LLM_PROVIDER=anthropic.`,
      );
  }
}

/**
 * Send one prompt, expect one JSON or plain-text completion back, plus
 * usage (token counts + model) when the provider reports it. Callers are
 * responsible for parsing/validating `.text` against their own schema —
 * this wrapper does not assume a shape. Retries once on a transient
 * upstream failure (429/5xx) — both providers' APIs return these under
 * normal load spikes, not just outages.
 */
export async function complete(prompt: string, opts: { maxTokens?: number } = {}): Promise<LlmCompletion> {
  try {
    return await completeOnce(prompt, opts);
  } catch (err) {
    if (!(err instanceof RetryableLlmError)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return completeOnce(prompt, opts);
  }
}
