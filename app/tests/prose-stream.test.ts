import { describe, it } from "node:test";
import { expect } from "chai";

import type { CopilotEvent } from "../src/lib/copilot/events";
import { ProseStream } from "../src/lib/copilot/prose-stream";
import { houseStyle } from "../src/lib/copilot/style";

/**
 * Tests for prose shown while the model is still writing it.
 *
 * What is protected is that streaming changes when words appear and nothing
 * else: what the person ends up reading is exactly the styled whole, every
 * piece sent extends what came before, and prose that was not the answer is
 * taken back to precisely where it started.
 */

function run(chunks: string[], keep = 0) {
  const events: CopilotEvent[] = [];
  const stream = new ProseStream((e) => events.push(e), keep);
  return { events, stream, push: () => chunks.forEach((c) => stream.push(c)) };
}

/** What a browser would show after applying the events in order. */
function shown(events: CopilotEvent[], start = ""): string {
  let text = start;
  for (const e of events) {
    if (e.type === "text") text += e.delta;
    if (e.type === "text_discard") text = text.slice(0, e.keep);
  }
  return text;
}

const texts = (events: CopilotEvent[]) =>
  events.filter((e): e is Extract<CopilotEvent, { type: "text" }> => e.type === "text").map((e) => e.delta);

describe("prose shown as it is written", () => {
  it("sends words before the turn ends", () => {
    const { events, push } = run(["NVIDIA is down ", "0.5% today, ", "near the day's low."]);
    push();
    expect(texts(events).length).to.be.greaterThan(1);
    expect(shown(events)).to.equal("NVIDIA is down 0.5% today, near the day's low".slice(0, shown(events).length));
  });

  it("ends with exactly the styled whole, however it was cut", () => {
    const whole = "Prices move fast — NVDA ran 9–12% this week.\n\n1. 1. Buy $50\n2. Set an alert";
    for (let size = 1; size <= 7; size += 1) {
      const pieces = whole.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))!;
      const { events, stream, push } = run(pieces);
      push();
      stream.finish(whole);
      expect(shown(events), `cut every ${size}`).to.equal(houseStyle(whole));
      expect(events.some((e) => e.type === "text_discard"), `cut every ${size}`).to.equal(false);
    }
  });

  it("never sends a dash, even when it arrives split from its words", () => {
    const { events, stream, push } = run(["Up today ", "—", " on news"]);
    push();
    stream.finish("Up today — on news");
    expect(texts(events).join("")).to.equal("Up today, on news");
    expect(texts(events).join("")).to.not.match(/[–—]/);
  });

  it("writes a split number range as words", () => {
    const { events, stream, push } = run(["between 9 ", "–", " 5 percent"]);
    push();
    stream.finish("between 9 – 5 percent");
    expect(shown(events)).to.equal("between 9 to 5 percent");
  });

  it("holds back what could still change and sends it at the end", () => {
    const { events, stream, push } = run(["It costs 12"]);
    push();
    expect(shown(events)).to.equal("It costs");
    stream.finish("It costs 12");
    expect(shown(events)).to.equal("It costs 12");
  });
});

describe("taking prose back", () => {
  it("cuts the reply back to where this turn began", () => {
    const { events, stream, push } = run(["Let me check that ", "for you."], 42);
    push();
    stream.discard();
    const last = events[events.length - 1];
    expect(last).to.deep.equal({ type: "text_discard", keep: 42 });
    expect(shown(events, "x".repeat(42))).to.equal("x".repeat(42));
  });

  it("says nothing when nothing was shown", () => {
    const { events, stream } = run([]);
    stream.discard();
    expect(events).to.deep.equal([]);
  });

  it("starts clean after a take back, for the model that tries next", () => {
    const { events, stream, push } = run(["Half an ans"]);
    push();
    stream.discard();
    stream.push("A whole answer.");
    stream.finish("A whole answer.");
    expect(shown(events)).to.equal("A whole answer.");
  });
});
