import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "chai";

import { generateWithTools, resetModelAvailability } from "../src/lib/gemini";

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
      return new Response(JSON.stringify(REPLY), { status: 200 });
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
        : new Response(JSON.stringify(REPLY), { status: 200 });
    }) as typeof fetch;

    const result = await generateWithTools(request);
    expect(calls).to.equal(4);
    expect(result.parts[0].text).to.equal("answered");
  });
});
