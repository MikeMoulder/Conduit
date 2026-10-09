import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "chai";

import { z } from "zod";

import {
  generateStructured,
  generateWithTools,
  resetModelAvailability,
  setFirstWordsTimeout,
} from "../src/lib/gemini";

/**
 * Tests for what happens when the model provider misbehaves.
 *
 * Both failures here were seen in the browser on the same day. A turn sat on
 * "Reading the question" indefinitely because one request was accepted and
 * never answered, and blank replies came from every model on the ladder being
 * rate limited at once. Neither can be produced on demand against the real
 * provider, so fetch is replaced with one that misbehaves in exactly those
 * ways, and the assertion is about what the ladder does next.
 */

// Placeholders only, so the environment check passes. The environment is read
// on the first call rather than at import, and nothing is sent: fetch is
// replaced before any call.
process.env.GEMINI_API_KEY ??= "test-key-not-real-0000000000000000";
process.env.SOLANA_RPC_URL ??= "https://api.devnet.solana.com";
process.env.PYTH_API_KEY ??= "test";

const realFetch = globalThis.fetch;

const REPLY = {
  candidates: [{ content: { parts: [{ text: "answered" }] }, finishReason: "STOP" }],
  usageMetadata: { totalTokenCount: 1 },
};

const request = {
  systemInstruction: "test",
  contents: [{ role: "user" as const, parts: [{ text: "hello" }] }],
  tools: [],
};

function modelOf(url: string): string {
  return url.split("/").pop()!.split(":")[0];
}

/** A streamed reply as the provider sends it: one event per chunk, CRLF between events. */
function sse(...chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}

`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A streamed reply that sends its chunks and then never finishes, until aborted. */
function stalled(signal: AbortSignal | undefined, ...chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}

`));
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  });
  return new Response(body, { status: 200 });
}

const chunk = (parts: unknown[], finishReason?: string) => ({
  candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }],
});

describe("the model ladder under a misbehaving provider", () => {
  beforeEach(() => resetModelAvailability());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("moves past a model that never answers instead of waiting for good", async () => {
    const asked: string[] = [];
    let first = true;

    globalThis.fetch = (async (url: string) => {
      asked.push(modelOf(String(url)));
      if (first) {
        first = false;
        // What AbortSignal.timeout raises when the limit passes.
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return sse(REPLY);
    }) as typeof fetch;

    const result = await generateWithTools(request);

    expect(asked.length).to.equal(2);
    expect(result.model).to.equal(asked[1]);
    expect(result.model).to.not.equal(asked[0]);
  });

  it("does not wait and retry a model that timed out", async () => {
    // Retrying hung models round after round would multiply a thirty second
    // wait by the length of the ladder. One pass, then a clear failure.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const error = new Error("timeout");
      error.name = "TimeoutError";
      throw error;
    }) as typeof fetch;

    const began = Date.now();
    try {
      await generateWithTools(request);
      expect.fail("answered with every model timing out");
    } catch (error) {
      expect(String(error)).to.include("no model answered");
    }
    expect(calls).to.equal(3);
    expect(Date.now() - began).to.be.below(1_000);
  });

  it("waits and tries again when every model is only rate limited", async () => {
    // The blank replies. A per minute limit clears in seconds, so a short wait
    // turns a failure into a slower answer.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls <= 3
        ? new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })
        : sse(REPLY);
    }) as typeof fetch;

    const result = await generateWithTools(request);
    expect(calls).to.equal(4);
    expect(result.parts[0].text).to.equal("answered");
  });

  it("waits out a rate limit in an analysis stage too", async () => {
    // The first autonomous cycle stopped at the bull stage: five stages fired
    // back to back found every model rate limited, and the structured path had
    // no wait. It shares the tool turn's policy now.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls <= 3
        ? new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })
        : new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: '{"verdict":"bullish"}' }] }, finishReason: "STOP" }],
            }),
            { status: 200 },
          );
    }) as typeof fetch;

    const result = await generateStructured({
      stage: "bull",
      systemInstruction: "test",
      prompt: "test",
      schema: { type: "OBJECT", properties: { verdict: { type: "STRING" } } } as never,
      validator: z.object({ verdict: z.string() }),
    });

    expect(calls).to.equal(4);
    expect(result.value.verdict).to.equal("bullish");
  });

  it("tries another pass after a mix of busy models and a malformed reply", async () => {
    // The pattern behind the timed cycle that stopped at the bull stage: one
    // model answered in the wrong shape, the others were rate limited, and the
    // old rule only retried when every failure was a busy model.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json at all" }] }, finishReason: "STOP" }] }),
          { status: 200 },
        );
      }
      if (calls <= 4) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      }
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"verdict":"bearish"}' }] }, finishReason: "STOP" }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await generateStructured({
      stage: "bear",
      systemInstruction: "test",
      prompt: "test",
      schema: { type: "OBJECT", properties: { verdict: { type: "STRING" } } } as never,
      validator: z.object({ verdict: z.string() }),
    });

    expect(result.value.verdict).to.equal("bearish");
  });

  it("does not wait on a model that does not exist", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    }) as typeof fetch;

    const began = Date.now();
    try {
      await generateWithTools(request);
      expect.fail("answered with every model missing");
    } catch (error) {
      expect(String(error)).to.include("no model answered");
    }
    expect(calls).to.equal(3);
    expect(Date.now() - began).to.be.below(1_000);
  });
});

describe("a streamed tool turn", () => {
  beforeEach(() => resetModelAvailability());
  afterEach(() => {
    globalThis.fetch = realFetch;
    setFirstWordsTimeout(10_000);
  });

  it("passes prose on as it arrives and joins it back into one part", async () => {
    globalThis.fetch = (async () =>
      sse(chunk([{ text: "Hey, " }]), chunk([{ text: "NVDA is " }]), chunk([{ text: "up." }], "STOP"))) as typeof fetch;

    const heard: string[] = [];
    const result = await generateWithTools({ ...request, onText: (d) => heard.push(d) });

    expect(heard).to.deep.equal(["Hey, ", "NVDA is ", "up."]);
    expect(result.parts).to.deep.equal([{ text: "Hey, NVDA is up." }]);
    expect(result.finishReason).to.equal("STOP");
  });

  it("keeps a tool call whole, with the signature the model expects back", async () => {
    // The newer models attach a thought signature to a turn and refuse the
    // next one if the history comes back without it.
    const call = { functionCall: { name: "get_prices", args: { symbols: ["NVDA"] } }, thoughtSignature: "sig-123" };
    globalThis.fetch = (async () => sse(chunk([call], "STOP"))) as typeof fetch;

    const heard: string[] = [];
    const result = await generateWithTools({ ...request, onText: (d) => heard.push(d) });

    expect(heard).to.deep.equal([]);
    expect(result.parts).to.deep.equal([call]);
  });

  it("never passes the model's thinking on as the answer", async () => {
    globalThis.fetch = (async () =>
      sse(chunk([{ text: "Let me weigh this", thought: true }]), chunk([{ text: "Anytime." }], "STOP"))) as typeof fetch;

    const heard: string[] = [];
    const result = await generateWithTools({ ...request, onText: (d) => heard.push(d) });

    expect(heard).to.deep.equal(["Anytime."]);
    expect(result.parts).to.deep.equal([{ text: "Anytime." }]);
  });

  it("asks for minimal thinking from the models that accept it, and not from one that refuses it", async () => {
    const thinking: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const model = modelOf(String(url));
      thinking[model] = JSON.parse(String(init?.body)).generationConfig.thinkingConfig ?? null;
      // Every model fails, so the whole ladder is asked once.
      return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    }) as typeof fetch;

    await generateWithTools(request).catch(() => null);

    expect(thinking["gemini-3.1-flash-lite"]).to.deep.equal({ thinkingLevel: "minimal" });
    expect(thinking["gemini-3.5-flash"]).to.deep.equal({ thinkingLevel: "minimal" });
    expect(thinking["gemini-flash-latest"]).to.equal(null);
  });

  it("moves on from a model that accepts the request and never starts answering", async () => {
    setFirstWordsTimeout(50);
    const asked: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      asked.push(modelOf(String(url)));
      return asked.length === 1 ? stalled(init?.signal ?? undefined) : sse(REPLY);
    }) as typeof fetch;

    const began = Date.now();
    const result = await generateWithTools(request);

    expect(asked).to.have.length(2);
    expect(result.model).to.equal(asked[1]);
    expect(result.attempts?.map((a) => a.outcome)).to.deep.equal(["timeout", "ok"]);
    expect(Date.now() - began).to.be.below(2_000);
  });

  it("takes back prose from a model that fails part way, before the next one starts", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? sse(chunk([{ text: "Half an ans" }]), { error: { message: "overloaded" } })
        : sse(chunk([{ text: "A whole answer." }], "STOP"));
    }) as typeof fetch;

    const events: string[] = [];
    const result = await generateWithTools({
      ...request,
      onText: (d) => events.push(`text:${d}`),
      onReset: () => events.push("reset"),
    });

    expect(events).to.deep.equal(["text:Half an ans", "reset", "text:A whole answer."]);
    expect(result.parts).to.deep.equal([{ text: "A whole answer." }]);
  });

  it("stops at once when the person stops the answer", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      setTimeout(() => controller.abort(), 10);
      return stalled(init?.signal ?? undefined, chunk([{ text: "Starting" }]));
    }) as typeof fetch;

    let stopped = false;
    await generateWithTools({ ...request, signal: controller.signal }).catch(() => {
      stopped = true;
    });

    expect(stopped).to.equal(true);
    expect(calls).to.equal(1);
  });
});
