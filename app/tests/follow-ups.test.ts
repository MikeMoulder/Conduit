import { beforeEach, describe, it } from "node:test";
import { expect } from "chai";

import type { Card, PendingAction } from "../src/lib/copilot/events";
import { followUps } from "../src/lib/copilot/follow-ups";
import {
  beginTurn,
  currentConversation,
  dropLastExchange,
  finishTurn,
  newConversation,
  patchTurn,
  type Turn,
} from "../src/lib/copilot/store";

/**
 * Tests for the chat's next step offers and for asking again.
 *
 * Suggestions are picked by rules, so what is protected is that each one is
 * something the copilot can do with what just happened, that none is offered
 * while a card or an error is the next step, and that the question just
 * asked is never offered back. Asking again must never offer an action a
 * second time on top of one that already happened.
 */

const user = (text: string, event = false): Turn => ({
  id: `u-${text}`,
  role: "user",
  event,
  text,
  steps: [],
  cards: [],
  actions: [],
  sources: [],
  streaming: false,
});

const reply = (parts: Partial<Turn> = {}): Turn => ({
  id: `a-${Math.random()}`,
  role: "assistant",
  text: "Here you go.",
  steps: [],
  cards: [],
  actions: [],
  sources: [],
  streaming: false,
  ...parts,
});

const brief = (symbol: string, held: number | null): Card => ({
  kind: "stock-brief",
  brief: {
    symbol,
    name: symbol,
    logo: null,
    assetClass: "equity",
    price: 100,
    reference: null,
    day: null,
    points: [],
    valuation: null,
    held,
    headlines: [],
  },
});

const result = (headline: string, ok = true): Card => ({
  kind: "wallet-result",
  result: { ok, headline, detail: null, signature: null, lines: [] },
});

describe("what to say next", () => {
  it("offers to buy, alert or analyse after a brief on a stock not held", () => {
    const turns = [user("how's nvidia doing?"), reply({ cards: [brief("NVDA", 0)] })];
    expect(followUps(turns)).to.deep.equal(["Buy $50 of NVDA", "Ping me if NVDA drops 3%", "Run a full analysis on NVDA"]);
  });

  it("offers to add to or sell a stock already held", () => {
    const turns = [user("how's tesla?"), reply({ cards: [brief("TSLA", 0.4)] })];
    expect(followUps(turns)).to.include("Sell all my TSLA");
  });

  it("follows a trade with how it is doing and an alert, from the reply before the card result", () => {
    const turns = [
      user("buy $50 of apple"),
      reply({ outcomes: [result("Bought AAPL")] }),
      user("[Card result] Buy $50 of AAPL: done.", true),
      reply({ text: "Done, you've got 0.15 AAPL." }),
    ];
    expect(followUps(turns)).to.deep.equal(["How's AAPL doing?", "Ping me if AAPL drops 5%", "Show my wallet"]);
  });

  it("offers the deposit when the main wallet has no cash but the person's own wallet does", () => {
    const wallet: Card = {
      kind: "wallet",
      wallet: { opened: true, address: "x", cash: 0, holdings: [], total: 0, ownCash: 5000 },
    };
    expect(followUps([user("my wallet"), reply({ cards: [wallet] })])).to.deep.equal(["Deposit $1,000"]);
  });

  it("offers to open the main wallet when there is none", () => {
    const wallet: Card = {
      kind: "wallet",
      wallet: { opened: false, address: null, cash: 0, holdings: [], total: 0, ownCash: 0 },
    };
    expect(followUps([user("my wallet"), reply({ cards: [wallet] })])[0]).to.equal("Open my main wallet");
  });

  it("offers nothing while a card is waiting, since the card is the next step", () => {
    const action = { kind: "demo-cash", owner: "x", summary: "" } as PendingAction;
    expect(followUps([user("give me demo cash"), reply({ actions: [action] })])).to.deep.equal([]);
  });

  it("offers nothing after an error or while the reply is still arriving", () => {
    expect(followUps([user("hi"), reply({ error: { message: "busy" } })])).to.deep.equal([]);
    expect(followUps([user("hi"), reply({ streaming: true })])).to.deep.equal([]);
  });

  it("never offers back the question just asked", () => {
    const turns = [user("How's NVIDIA doing today?"), reply({ text: "No cards here." })];
    expect(followUps(turns)).to.not.include("How's NVIDIA doing today?");
    expect(followUps(turns).length).to.be.at.most(3);
  });

  it("skips a failed result and uses the card before it", () => {
    const turns = [user("x"), reply({ cards: [brief("MSFT", 0)], outcomes: [result("The trade did not go through", false)] })];
    expect(followUps(turns)[0]).to.equal("Buy $50 of MSFT");
  });
});

describe("asking again", () => {
  beforeEach(() => newConversation());

  it("takes the last question and its reply off, and hands the question back", () => {
    const { turnId } = beginTurn("how's nvidia doing?");
    finishTurn(turnId);
    expect(dropLastExchange()).to.deep.equal({ question: "how's nvidia doing?", event: false });
    expect(currentConversation()!.turns).to.have.length(0);
  });

  it("refuses while the answer is still arriving", () => {
    const { turnId } = beginTurn("hi");
    expect(dropLastExchange()).to.equal(null);
    finishTurn(turnId);
  });

  it("refuses once a card on the reply was used, so nothing is offered twice", () => {
    const { turnId } = beginTurn("buy $50 of apple");
    patchTurn(turnId, (t) => ({ ...t, outcomes: [result("Bought AAPL")] }));
    finishTurn(turnId);
    expect(dropLastExchange()).to.equal(null);
    expect(currentConversation()!.turns).to.have.length(2);
  });

  it("asks a card result again as a card result, not as something the person typed", () => {
    const first = beginTurn("give me demo cash");
    finishTurn(first.turnId);
    const second = beginTurn("[Card result] Get test money: done.", { event: true });
    finishTurn(second.turnId);
    expect(dropLastExchange()).to.deep.equal({ question: "[Card result] Get test money: done.", event: true });
    expect(currentConversation()!.turns).to.have.length(2);
  });
});
