import { beforeEach, describe, it } from "node:test";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  brakeEntry,
  dueEntries,
  getEntry,
  getScore,
  listDecisions,
  listEntries,
  markRun,
  recordDecision,
  saveScore,
  upsertEntry,
  type AutopilotEntry,
  type Decision,
} from "../src/lib/autopilot/state";
import { formatDecision } from "../src/lib/autopilot/notify";
import { startScore, summarise } from "../src/lib/autopilot/scorecard";
import { AUTOPILOT_TOOLS } from "../src/lib/copilot/autopilot-tools";

/**
 * Tests for the autopilot's bookkeeping.
 *
 * The cycle itself is exercised against the deployed program through the
 * running app. These cover what decides when a cycle runs and what a person is
 * told afterwards, which is where a mistake would be quiet: a mandate that is
 * never due, one that runs every tick, or a message that hides what happened.
 *
 * State is written to a temporary file, never the app's own.
 */

let dir: string;

beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(path.join(tmpdir(), "autopilot-"));
  process.env.KV_FILE = path.join(dir, "kv.json");
});

const MINUTE = 60_000;

function entry(overrides: Partial<AutopilotEntry> = {}): AutopilotEntry {
  return {
    mandate: "Mandate1111111111111111111111111111111111",
    owner: "Owner11111111111111111111111111111111111111",
    mandateId: 0,
    objective: "grow steadily",
    everyMinutes: 30,
    enabled: true,
    createdAt: 0,
    lastRunAt: null,
    ...overrides,
  };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    mandate: "Mandate1111111111111111111111111111111111",
    owner: "Owner11111111111111111111111111111111111111",
    at: Date.now(),
    outcome: "rebalanced",
    summary: "Rebalanced to AAPL 40%, cash 60%, then settled into real tokens.",
    reasoning: "Quality at a fair price.",
    positions: [{ symbol: "AAPL", targetBps: 4000 }],
    signatures: [],
    ...overrides,
  };
}

describe("when a mandate is due", () => {
  it("runs a newly switched on mandate straight away", async () => {
    await upsertEntry(entry());
    expect(await dueEntries(Date.now())).to.have.length(1);
  });

  it("waits a full interval after a run", async () => {
    const now = Date.now();
    await upsertEntry(entry({ lastRunAt: now }));
    expect(await dueEntries(now + 29 * MINUTE)).to.have.length(0);
    expect(await dueEntries(now + 30 * MINUTE)).to.have.length(1);
  });

  it("never runs a mandate that is switched off", async () => {
    await upsertEntry(entry({ enabled: false }));
    expect(await dueEntries(Date.now() + 1_000 * MINUTE)).to.have.length(0);
  });

  it("records a run so the next tick does not repeat it", async () => {
    const now = Date.now();
    await upsertEntry(entry());
    await markRun(entry().mandate, now);
    expect(await dueEntries(now + MINUTE)).to.have.length(0);
  });

  it("keeps one entry per mandate when switched on twice", async () => {
    await upsertEntry(entry({ everyMinutes: 30 }));
    await upsertEntry(entry({ everyMinutes: 10 }));
    const all = await listEntries();
    expect(all).to.have.length(1);
    expect(all[0].everyMinutes).to.equal(10);
  });
});

describe("the decision log", () => {
  it("lists the newest decision first", async () => {
    await recordDecision(decision({ at: 1, summary: "first" }));
    await recordDecision(decision({ at: 2, summary: "second" }));
    expect((await listDecisions({})).map((d) => d.summary)).to.deep.equal(["second", "first"]);
  });

  it("only shows a person their own decisions", async () => {
    await recordDecision(decision({ owner: "someone else" }));
    await recordDecision(decision());
    expect(await listDecisions({ owner: entry().owner })).to.have.length(1);
  });

  it("stays bounded however long it runs", async () => {
    for (let i = 0; i < 230; i += 1) await recordDecision(decision({ at: i }));
    expect(await listDecisions({}, 1_000)).to.have.length(200);
  });
});

describe("keeping the score", () => {
  const start = startScore({ at: 0, cash: 2_000, amounts: {}, prices: {}, spyPrice: 500 });

  it("keeps a score between cycles", async () => {
    await saveScore("Mandate1111111111111111111111111111111111", start);
    expect(await getScore("Mandate1111111111111111111111111111111111")).to.deep.equal(start);
    expect(await getScore("SomeOtherMandate")).to.equal(null);
  });

  it("does not lose entries or decisions when a score is saved", async () => {
    await upsertEntry(entry());
    await recordDecision(decision());
    await saveScore("Mandate1111111111111111111111111111111111", start);
    expect(await listEntries()).to.have.length(1);
    expect(await listDecisions({})).to.have.length(1);
  });

  it("does not lose scores when entries or decisions are written", async () => {
    await saveScore("Mandate1111111111111111111111111111111111", start);
    await upsertEntry(entry());
    await recordDecision(decision());
    await markRun("Mandate1111111111111111111111111111111111", Date.now());
    expect(await getScore("Mandate1111111111111111111111111111111111")).to.not.equal(null);
  });

  it("reads an entry saved before the brake and cap existed", async () => {
    // Entries written by older code have neither field; they must still load
    // and run, with the defaults filled in where they are used.
    const old = entry();
    delete old.brakeBps;
    delete old.preIpoCapBps;
    await upsertEntry(old);
    expect((await getEntry("Mandate1111111111111111111111111111111111"))?.enabled).to.equal(true);
    expect(await getScore("Mandate1111111111111111111111111111111111")).to.equal(null);
  });

  it("keeps a setting and a recorded run made at the same moment", async () => {
    // The site switching a mandate's interval and the worker recording a run
    // must not undo each other.
    await upsertEntry(entry());
    await Promise.all([
      upsertEntry(entry({ everyMinutes: 60 })),
      markRun("Mandate1111111111111111111111111111111111", 123),
    ]);
    const saved = await getEntry("Mandate1111111111111111111111111111111111");
    expect(saved?.everyMinutes).to.equal(60);
  });

  it("puts the score in the message", async () => {
    const text = formatDecision(decision({ score: summarise(start) }), entry());
    expect(text).to.include("Scorecard: Since 1 Jan 00:00 UTC: flat against SPY flat, level with SPY.");
  });
});

describe("the safety brake in the log", () => {
  it("switches the autopilot off and records when", async () => {
    await upsertEntry(entry());
    await brakeEntry("Mandate1111111111111111111111111111111111", 1_234);
    const [braked] = await listEntries();
    expect(braked.enabled).to.equal(false);
    expect(braked.brakedAt).to.equal(1_234);
  });

  it("stops a braked mandate from being due again", async () => {
    await upsertEntry(entry());
    await brakeEntry("Mandate1111111111111111111111111111111111", Date.now());
    expect(await dueEntries(Date.now() + 24 * 60 * MINUTE)).to.have.length(0);
  });

  it("leaves other mandates running", async () => {
    await upsertEntry(entry());
    await upsertEntry(entry({ mandate: "Mandate2222222222222222222222222222222222" }));
    await brakeEntry("Mandate1111111111111111111111111111111111", Date.now());
    expect((await dueEntries(Date.now())).map((e) => e.mandate)).to.deep.equal([
      "Mandate2222222222222222222222222222222222",
    ]);
  });

  it("says so plainly in the message", async () => {
    const text = formatDecision(
      decision({ outcome: "braked", summary: "Safety brake: the mandate fell 10.40% from its best point." }),
      entry(),
    );
    expect(text).to.include("Stopped: Safety brake: the mandate fell 10.40%");
  });
});

describe("what the person is told", () => {
  it("says what happened, why, and links the proof", async () => {
    const text = formatDecision(
      decision({ signatures: ["5sig111111111111111111111111111111111111111111"] }),
      entry(),
    );
    expect(text).to.include("mandate 0");
    expect(text).to.include("Rebalanced:");
    expect(text).to.include("Why: Quality at a fair price.");
    expect(text).to.include("5sig111111111111111111111111111111111111111111");
  });

  it("reports holding back as plainly as trading", async () => {
    const text = formatDecision(
      decision({ outcome: "skipped", summary: "The mandate would refuse it. Nothing was sent." }),
      entry(),
    );
    expect(text).to.include("Skipped: The mandate would refuse it. Nothing was sent.");
  });

  it("lists what the pre IPO rules saw and did", async () => {
    const text = formatDecision(
      decision({
        preIpo: [
          "SPACEX trades 21% below its mark: holding 6%.",
          "OPENAI trades 31% above its mark, so it was not bought.",
        ],
      }),
      entry(),
    );
    expect(text).to.include("Pre-IPO:\n- SPACEX trades 21% below its mark: holding 6%.\n- OPENAI");
  });

  it("says nothing about pre IPO when the rules had nothing to say", async () => {
    expect(formatDecision(decision({}), entry())).to.not.include("Pre-IPO");
  });

  it("shortens long reasoning rather than flooding a phone", async () => {
    const text = formatDecision(decision({ reasoning: "x".repeat(2_000) }), entry());
    expect(text.length).to.be.below(700);
  });
});

describe("autopilot tools with nobody connected", () => {
  for (const [name, args] of [
    ["set_autopilot", { on: true }],
    ["get_autopilot", {}],
    ["run_autopilot_now", {}],
  ] as const) {
    it(`${name} asks for a wallet rather than acting for nobody`, async () => {
      try {
        await AUTOPILOT_TOOLS[name].run(args, { owner: null });
        expect.fail(`${name} ran with no owner`);
      } catch (error) {
        expect(String(error)).to.include("wallet");
      }
    });
  }
});
