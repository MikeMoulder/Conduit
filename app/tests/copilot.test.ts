/**
 * Tests for the copilot engine.
 *
 * Deliberately offline. Everything below runs without a model, an API key or a
 * cluster, because none of it is about what the model says. It is about what
 * the loop does with whatever the model says: which budgets it enforces, how it
 * reports a tool that failed, and when it decides an answer is finished. Those
 * are decisions this codebase makes, and a test for them should not be able to
 * fail because a rate limit was hit.
 *
 * The stream reader gets the most attention. It is the piece most likely to
 * break in a way nothing catches, because chunk boundaries fall wherever the
 * network puts them and a local connection almost always delivers a whole event
 * at a time. Code that parses eagerly works perfectly in development and drops
 * events in production, so the tests here split the stream in the least
 * convenient places on purpose.
 *
 * Run by Node's own test runner rather than by the mocha suite in the repository
 * root. That suite compiles with a tsconfig of its own and against the root
 * dependencies, which include neither zod nor the fetch types Next augments, so
 * the app's server code does not typecheck there. These are app modules with app
 * dependencies and they belong in the app.
 *
 * Run by Node's own test runner with tsx as the loader, which is enough to
 * execute TypeScript that imports its neighbours without file extensions.
 * Typechecking stays with `npm run typecheck`, where Next's own configuration
 * applies.
 *
 * The `--conditions=react-server` flag in the npm script is what makes this
 * possible at all: it resolves `server-only` to the empty module that package
 * ships for this case, rather than the stub that throws on import. Without it,
 * every module that guards itself against the browser fails at load, which is
 * the guard working correctly in the wrong place.
 */

import { describe, it } from "node:test";
import { assert } from "chai";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * A throwaway agent, set before anything reads the environment.
 *
 * `prepare_mandate` refuses to draft a mandate with no agent to delegate to,
 * which is correct: a mandate names an agent and there would be nothing to put
 * in the field. The tests need one to exist without needing a real deployment,
 * and this key signs nothing.
 */
process.env.AGENT_SECRET_KEY = bs58.encode(Keypair.generate().secretKey);

const OWNER = "3CtgQtLeQ3zGWmvkgVDAtGMn97nARXjksatf2u6tyMTP";

import { readCopilotStream } from "../src/lib/copilot/stream";
import {
  MAX_TOOL_CALLS,
  MAX_TURNS,
  runCopilot,
  type TurnGenerator,
} from "../src/lib/copilot/loop";
import { TOOLS, TOOL_DECLARATIONS } from "../src/lib/copilot/tools";
import type { CopilotEvent } from "../src/lib/copilot/events";
import type { GeminiPart, ToolTurnResult } from "../src/lib/gemini";
import { PublicKey } from "@solana/web3.js";

/* -------------------------------------------------------------------------- */
/* The stream reader                                                          */
/* -------------------------------------------------------------------------- */

function sse(events: CopilotEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

/** A response whose body arrives in exactly the pieces given. */
function responseFrom(pieces: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(stream);
}

/** Cuts a string into fixed size pieces, boundaries falling where they fall. */
function slice(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    pieces.push(text.slice(i, i + size));
  }
  return pieces;
}

const SAMPLE: CopilotEvent[] = [
  { type: "status", label: "Reading the question" },
  { type: "tool_start", id: "t1", name: "get_portfolio", label: "Reading the portfolio" },
  {
    type: "tool_end",
    id: "t1",
    name: "get_portfolio",
    ok: true,
    durationMs: 412,
    summary: "4 positions, 6000 bps cash",
  },
  { type: "text", delta: "You hold four positions." },
  { type: "done", model: "test", totalMs: 900, toolCalls: 1, totalTokens: 100 },
];

async function collect(pieces: string[]): Promise<CopilotEvent[]> {
  const seen: CopilotEvent[] = [];
  await readCopilotStream(responseFrom(pieces), (e) => seen.push(e));
  return seen;
}

describe("reading the copilot stream", () => {
  it("reads events delivered whole", async () => {
    const seen = await collect([sse(SAMPLE)]);
    assert.deepEqual(seen, SAMPLE);
  });

  it("reads events delivered one at a time", async () => {
    const seen = await collect(SAMPLE.map((e) => sse([e])));
    assert.deepEqual(seen, SAMPLE);
  });

  it("survives chunk boundaries falling anywhere in the payload", async () => {
    const whole = sse(SAMPLE);

    // Every size from one byte upward exercises a different set of split
    // points, including inside a JSON string, inside the `data: ` prefix and
    // between the two newlines that end an event.
    for (const size of [1, 2, 3, 7, 13, 29, 64, 137]) {
      const seen = await collect(slice(whole, size));
      assert.deepEqual(
        seen,
        SAMPLE,
        `lost or corrupted events when the stream arrived in ${size} byte pieces`,
      );
    }
  });

  it("holds back a partial event rather than parsing it", async () => {
    const whole = sse(SAMPLE);
    const cut = Math.floor(whole.length / 2);

    const seen: CopilotEvent[] = [];
    await readCopilotStream(
      responseFrom([whole.slice(0, cut), whole.slice(cut)]),
      (e) => seen.push(e),
    );

    assert.deepEqual(seen, SAMPLE);
  });

  it("drops a malformed event and keeps the ones after it", async () => {
    const seen = await collect([
      "data: {not json at all}\n\n",
      sse([{ type: "text", delta: "still here" }]),
    ]);

    assert.lengthOf(seen, 1);
    assert.deepEqual(seen[0], { type: "text", delta: "still here" });
  });

  it("ignores a trailing fragment that never completes", async () => {
    const seen = await collect([sse(SAMPLE), 'data: {"type":"text","del']);
    assert.deepEqual(seen, SAMPLE, "an unterminated tail should not be parsed");
  });

  it("refuses a response with no body", async () => {
    try {
      await readCopilotStream(new Response(null), () => {});
      assert.fail("a bodyless response should not be readable");
    } catch (error) {
      assert.include(String(error), "no stream");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

const text = (t: string): GeminiPart[] => [{ text: t }];
const call = (name: string, args: Record<string, unknown> = {}): GeminiPart => ({
  functionCall: { name, args },
});

function turn(parts: GeminiPart[]): ToolTurnResult {
  return { parts, model: "stub", totalTokens: 10, finishReason: "STOP" };
}

/** Replays scripted turns, and records what the loop fed back each time. */
function scripted(turns: ToolTurnResult[]) {
  const seenContents: unknown[][] = [];
  let index = 0;

  const generate: TurnGenerator = async (request) => {
    seenContents.push(request.contents as unknown[]);
    const next = turns[Math.min(index, turns.length - 1)];
    index += 1;
    return next;
  };

  return { generate, seenContents, calls: () => index };
}

async function run(
  turns: ToolTurnResult[],
  owner: string | null = null,
): Promise<{ events: CopilotEvent[]; generatorCalls: number; contents: unknown[][] }> {
  const events: CopilotEvent[] = [];
  const script = scripted(turns);

  await runCopilot(
    { messages: [{ role: "user", content: "hello" }], owner },
    (e) => events.push(e),
    undefined,
    script.generate,
  );

  return {
    events,
    generatorCalls: script.calls(),
    contents: script.seenContents,
  };
}

describe("the copilot loop", () => {
  it("answers without tools when the model just talks", async () => {
    const { events, generatorCalls } = await run([turn(text("Basis points are hundredths of a percent."))]);

    assert.equal(generatorCalls, 1, "one turn should have been enough");
    const said = events.filter((e) => e.type === "text");
    assert.lengthOf(said, 1);
    assert.include((said[0] as { delta: string }).delta, "hundredths");

    const done = events.find((e) => e.type === "done");
    assert.isDefined(done);
    assert.equal((done as { toolCalls: number }).toolCalls, 0);
  });

  it("runs a tool and reports it starting and finishing", async () => {
    const { events } = await run([
      turn([call("list_universe")]),
      turn(text("Eighteen assets.")),
    ]);

    const started = events.find((e) => e.type === "tool_start");
    assert.isDefined(started);
    assert.equal((started as { name: string }).name, "list_universe");

    const ended = events.find((e) => e.type === "tool_end");
    assert.isDefined(ended);
    assert.isTrue((ended as { ok: boolean }).ok);
    assert.equal((ended as { card?: { kind: string } }).card?.kind, "universe");
  });

  it("drops prose the model emits alongside its tool calls", async () => {
    // That prose is the model narrating what it is about to do, which the step
    // list already says. Showing both reads as a stutter.
    const { events } = await run([
      turn([{ text: "Let me check that for you." }, call("list_universe")]),
      turn(text("Eighteen assets.")),
    ]);

    const said = events.filter((e) => e.type === "text");
    assert.lengthOf(said, 1);
    assert.equal((said[0] as { delta: string }).delta, "Eighteen assets.");
  });

  it("tells the model when a tool failed instead of ending the turn", async () => {
    const { events, contents } = await run([
      turn([call("get_prices", { symbols: ["NOTREAL"] })]),
      turn(text("That symbol is not in the registry.")),
    ]);

    const ended = events.find((e) => e.type === "tool_end") as
      | { ok: boolean; error?: string }
      | undefined;
    assert.isDefined(ended);
    assert.isFalse(ended!.ok);
    assert.include(ended!.error ?? "", "NOTREAL");

    // The failure has to reach the model, or it cannot correct itself.
    const fedBack = JSON.stringify(contents[contents.length - 1]);
    assert.include(fedBack, "NOTREAL");
    assert.include(fedBack, "registry");

    // And the answer still arrives.
    assert.isTrue(events.some((e) => e.type === "text"));
  });

  it("reports a tool it does not have without crashing", async () => {
    const { events, contents } = await run([
      turn([call("delete_everything")]),
      turn(text("I cannot do that.")),
    ]);

    assert.isUndefined(
      events.find((e) => e.type === "tool_start"),
      "an unknown tool should never look like it started",
    );
    assert.include(JSON.stringify(contents[contents.length - 1]), "no tool called");
  });

  it("stops calling tools once the per question budget is spent", async () => {
    // A model that never stops asking. Each turn requests two more tools.
    const greedy = turn([call("list_universe"), call("list_universe")]);
    const { events } = await run([greedy]);

    const started = events.filter((e) => e.type === "tool_start");
    assert.isAtMost(
      started.length,
      MAX_TOOL_CALLS,
      "more tools ran than the budget allows",
    );
  });

  it("gives up after the turn budget rather than looping forever", async () => {
    const greedy = turn([call("list_universe")]);
    const { events, generatorCalls } = await run([greedy]);

    assert.isAtMost(generatorCalls, MAX_TURNS, "the loop exceeded its turn budget");

    // It should still say something rather than simply stopping.
    const said = events.filter((e) => e.type === "text");
    assert.isNotEmpty(said);
    assert.include(
      (said[said.length - 1] as { delta: string }).delta.toLowerCase(),
      "narrower",
    );
    assert.isTrue(events.some((e) => e.type === "done"));
  });

  it("emits a pending action rather than performing it", async () => {
    const { events } = await run(
      [
        turn([
          call("prepare_mandate", {
            maxPositionBps: 2500,
            minCashBps: 1000,
            maxTurnoverBps: 4000,
            maxAssets: 6,
            symbols: ["BTC", "ETH", "SOL"],
          }),
        ]),
        turn(text("Ready for you to sign.")),
      ],
      OWNER,
    );

    const action = events.find((e) => e.type === "action") as
      | { action: { kind: string; draft: { symbols: string[] } } }
      | undefined;

    assert.isDefined(action, "preparing a mandate should surface an action");
    assert.equal(action!.action.kind, "create-mandate");
    assert.deepEqual(action!.action.draft.symbols, ["BTC", "ETH", "SOL"]);

    assert.isUndefined(
      events.find((e) => e.type === "submission" as never),
      "nothing should have been submitted",
    );
  });

  it("refuses an invalid wallet address before doing any work", async () => {
    const events: CopilotEvent[] = [];
    await runCopilot(
      { messages: [{ role: "user", content: "hi" }], owner: "not-an-address" },
      (e) => events.push(e),
      undefined,
      async () => {
        assert.fail("the model should never have been called");
      },
    );

    assert.lengthOf(events, 1);
    assert.equal(events[0].type, "error");
  });

  it("stops when the request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const events: CopilotEvent[] = [];
    await runCopilot(
      { messages: [{ role: "user", content: "hi" }], owner: null },
      (e) => events.push(e),
      controller.signal,
      async () => {
        assert.fail("an aborted request should not reach the model");
      },
    );

    assert.isUndefined(events.find((e) => e.type === "done"));
  });
});

/* -------------------------------------------------------------------------- */
/* The tools                                                                  */
/* -------------------------------------------------------------------------- */

describe("the tools the copilot is given", () => {
  it("declares every tool it can run, and runs every tool it declares", () => {
    const declared = TOOL_DECLARATIONS.map((d) => d.name).sort();
    const runnable = Object.keys(TOOLS).sort();
    assert.deepEqual(declared, runnable);
  });

  it("describes each tool well enough for a model to choose it", () => {
    for (const declaration of TOOL_DECLARATIONS) {
      assert.isAtLeast(
        declaration.description.length,
        60,
        `${declaration.name} needs a description a model can act on`,
      );
      assert.equal(declaration.parameters.type, "OBJECT");
    }
  });

  it("never lets the model choose whose data to read", () => {
    // The owner comes from the connected wallet on the request. If it were ever
    // an argument, a sentence in a conversation could point the copilot at
    // somebody else.
    for (const declaration of TOOL_DECLARATIONS) {
      const names = Object.keys(declaration.parameters.properties ?? {});
      assert.notInclude(
        names,
        "owner",
        `${declaration.name} must not take an owner`,
      );
      assert.notInclude(
        names,
        "wallet",
        `${declaration.name} must not take a wallet`,
      );
    }
  });

  it("asks for a wallet rather than guessing when none is connected", async () => {
    for (const name of ["get_mandate", "get_portfolio", "get_history"]) {
      try {
        await TOOLS[name].run({}, { owner: null });
        assert.fail(`${name} should not have run without an owner`);
      } catch (error) {
        assert.include(
          String(error),
          "wallet",
          `${name} should say a wallet is needed`,
        );
      }
    }
  });

  it("rejects a symbol that is not in the registry", async () => {
    try {
      await TOOLS.get_prices.run({ symbols: ["TOTALLYMADEUP"] }, { owner: null });
      assert.fail("an unknown symbol should not reach a price provider");
    } catch (error) {
      assert.include(String(error), "TOTALLYMADEUP");
    }
  });

  it("rejects mandate limits the program would refuse, and says which clause", async () => {
    try {
      await TOOLS.prepare_mandate.run(
        {
          // One position of at most 20 percent, against no cash floor, strands
          // most of the portfolio.
          maxPositionBps: 2000,
          minCashBps: 0,
          maxTurnoverBps: 4000,
          maxAssets: 1,
          symbols: ["BTC"],
        },
        { owner: new PublicKey(OWNER) },
      );
      assert.fail("incoherent limits should not become a pending action");
    } catch (error) {
      assert.include(String(error), "ContradictoryConstraints");
    }
  });

  it("asks for a wallet before complaining about the limits", async () => {
    // Deliberate ordering. A model told to fix its limits would fix them and
    // still be blocked on the wallet, so the precondition is reported first and
    // the correctable mistake second.
    try {
      await TOOLS.prepare_mandate.run(
        {
          maxPositionBps: 2000,
          minCashBps: 0,
          maxTurnoverBps: 4000,
          maxAssets: 1,
          symbols: ["BTC"],
        },
        { owner: null },
      );
      assert.fail("no wallet should stop this before anything else");
    } catch (error) {
      assert.include(String(error), "wallet");
    }
  });

  it("rejects a malformed weight before it can reach a transaction", async () => {
    try {
      await TOOLS.check_proposal.run(
        { positions: [{ symbol: "BTC", targetBps: 99_999 }] },
        { owner: null },
      );
      assert.fail("a weight above the denominator should not be accepted");
    } catch (error) {
      assert.isTrue(
        /10000|less than or equal|too_big/i.test(String(error)),
        `expected a schema complaint, got: ${String(error)}`,
      );
    }
  });
});
