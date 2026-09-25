import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { buildProofMessage, verifyProof, PROOF_MAX_AGE_MS } from "../src/lib/wallet-proof";
import {
  CODE_TTL_MS,
  chatFor,
  getOffset,
  issueCode,
  redeemCode,
  spendProof,
  unlinkChat,
} from "../src/lib/telegram/state";
import { deliver, handleText, pollOnce, sendToOwner } from "../src/lib/telegram/bot";
import { notify } from "../src/lib/autopilot/notify";
import { AUTOPILOT_TOOLS } from "../src/lib/copilot/autopilot-tools";
import type { AutopilotEntry, Decision } from "../src/lib/autopilot/state";

/**
 * Tests for linking each person's own Telegram chat to their own wallet.
 *
 * What is being protected is where one person's autopilot decisions are sent.
 * So most of these are refusals: a signature for the wrong purpose, the wrong
 * wallet, too old, or already spent; a link code used twice or late; and a
 * decision for one owner that must never reach another owner's chat.
 */

let dir: string;
beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(path.join(tmpdir(), "telegram-"));
  process.env.TELEGRAM_STATE_FILE = path.join(dir, "telegram.json");
});

/** Signs like a wallet: ed25519 over the UTF-8 bytes of the message. */
function sign(message: string, keypair: Keypair): string {
  return bs58.encode(ed25519.sign(new TextEncoder().encode(message), keypair.secretKey.slice(0, 32)));
}

describe("proving a wallet by signed message", () => {
  const wallet = Keypair.generate();
  const owner = wallet.publicKey.toBase58();

  it("accepts a fresh message signed by the wallet it names", () => {
    const message = buildProofMessage("link-telegram", owner);
    expect(verifyProof("link-telegram", owner, message, sign(message, wallet))).to.deep.equal({ ok: true });
  });

  it("refuses a signature from a different wallet", () => {
    // The attack this exists to stop: claiming someone else's address.
    const message = buildProofMessage("link-telegram", owner);
    const check = verifyProof("link-telegram", owner, message, sign(message, Keypair.generate()));
    expect(check.ok).to.equal(false);
  });

  it("refuses a message naming a different wallet", () => {
    const other = Keypair.generate();
    const message = buildProofMessage("link-telegram", other.publicKey.toBase58());
    const check = verifyProof("link-telegram", owner, message, sign(message, other));
    expect(check).to.deep.equal({ ok: false, reason: "The message names a different wallet." });
  });

  it("refuses a signature made for another purpose", () => {
    const message = buildProofMessage("unlink-telegram", owner);
    const check = verifyProof("link-telegram", owner, message, sign(message, wallet));
    expect(check.ok).to.equal(false);
  });

  it("refuses an old signature", () => {
    const issued = new Date(Date.now() - PROOF_MAX_AGE_MS - 1_000);
    const message = buildProofMessage("link-telegram", owner, issued);
    const check = verifyProof("link-telegram", owner, message, sign(message, wallet));
    expect(check).to.deep.equal({ ok: false, reason: "The signature has expired. Sign again." });
  });

  it("refuses a message altered after signing", () => {
    const message = buildProofMessage("link-telegram", owner);
    const signature = sign(message, wallet);
    const altered = message.replace("Nothing moves.", "Nothing moves!");
    expect(verifyProof("link-telegram", owner, altered, signature).ok).to.equal(false);
  });

  it("lets each signature be spent once", () => {
    expect(spendProof("sig-a", Date.now() + 60_000)).to.equal(true);
    expect(spendProof("sig-a", Date.now() + 60_000)).to.equal(false);
  });
});

describe("linking a chat with a one time code", () => {
  it("binds the chat that redeems the code to the wallet it was issued to", () => {
    const code = issueCode("wallet-a");
    expect(redeemCode(code, 1001, "alice")).to.equal("wallet-a");
    expect(chatFor("wallet-a")).to.equal(1001);
  });

  it("refuses a code used twice", () => {
    const code = issueCode("wallet-a");
    redeemCode(code, 1001, null);
    expect(redeemCode(code, 2002, null)).to.equal(null);
    expect(chatFor("wallet-a")).to.equal(1001);
  });

  it("refuses a code after it expires", () => {
    const issuedAt = Date.now();
    const code = issueCode("wallet-a", issuedAt);
    expect(redeemCode(code, 1001, null, issuedAt + CODE_TTL_MS + 1)).to.equal(null);
  });

  it("voids an earlier code when a new one is issued", () => {
    const first = issueCode("wallet-a");
    issueCode("wallet-a");
    expect(redeemCode(first, 1001, null)).to.equal(null);
  });

  it("keeps one chat per wallet and one wallet per chat", () => {
    redeemCode(issueCode("wallet-a"), 1001, null);
    redeemCode(issueCode("wallet-a"), 3003, null);
    expect(chatFor("wallet-a")).to.equal(3003);

    redeemCode(issueCode("wallet-b"), 3003, null);
    expect(chatFor("wallet-b")).to.equal(3003);
    expect(chatFor("wallet-a")).to.equal(null);
  });
});

describe("what the bot says", () => {
  it("links on /start with a code and says which wallet", () => {
    const code = issueCode("Wa11etAddressAAAAAAAAAAAAAAAAAAAAAAAAAAzz1");
    // First four and last four characters: the owner can recognise their
    // wallet without the bot printing the whole address into a chat.
    expect(handleText(`/start ${code}`, 1001, "alice")).to.include("Linked to wallet Wa11..Azz1");
    expect(chatFor("Wa11etAddressAAAAAAAAAAAAAAAAAAAAAAAAAAzz1")).to.equal(1001);
  });

  it("explains itself on /start with no code", () => {
    expect(handleText("/start", 1001, null)).to.include("connect Telegram");
  });

  it("unlinks on /stop", () => {
    redeemCode(issueCode("wallet-a"), 1001, null);
    expect(handleText("/stop", 1001, null)).to.include("Unlinked");
    expect(chatFor("wallet-a")).to.equal(null);
    expect(unlinkChat(1001)).to.equal(null);
  });

  it("answers anything else with what the chat is for, instead of silence", () => {
    expect(handleText("hello", 1001, null)).to.include("ask Conduit's chat to connect Telegram");
    redeemCode(issueCode("Wa11etAddressAAAAAAAAAAAAAAAAAAAAAAAAAAzz1"), 1001, null);
    const help = handleText("/help", 1001, null);
    expect(help).to.include("linked to wallet Wa11..Azz1");
    expect(help).to.include("/stop");
  });
});

describe("sending reliably", () => {
  const realFetch = globalThis.fetch;
  let answers: object[];
  let calls: number;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token-not-real";
    calls = 0;
    globalThis.fetch = (async () => {
      const body = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("sends once when Telegram accepts", async () => {
    answers = [{ ok: true, result: {} }];
    expect(await deliver(1001, "hi")).to.equal("sent");
    expect(calls).to.equal(1);
  });

  it("waits and retries once when rate limited", async () => {
    answers = [{ ok: false, error_code: 429, parameters: { retry_after: 0 } }, { ok: true, result: {} }];
    expect(await deliver(1001, "hi")).to.equal("sent");
    expect(calls).to.equal(2);
  });

  it("gives up after one retry rather than looping", async () => {
    answers = [{ ok: false, error_code: 429, parameters: { retry_after: 0 } }];
    expect(await deliver(1001, "hi")).to.equal("failed");
    expect(calls).to.equal(2);
  });

  it("does not retry a request Telegram calls malformed", async () => {
    answers = [{ ok: false, error_code: 400 }];
    expect(await deliver(1001, "hi")).to.equal("failed");
    expect(calls).to.equal(1);
  });

  it("unlinks an owner who blocked the bot, so nothing more is sent into the void", async () => {
    redeemCode(issueCode("wallet-a"), 1001, null);
    answers = [{ ok: false, error_code: 403 }];
    expect(await sendToOwner("wallet-a", "hi")).to.equal("blocked");
    expect(chatFor("wallet-a")).to.equal(null);
  });

  it("reports an owner with no chat as not linked, without calling Telegram", async () => {
    answers = [{ ok: true, result: {} }];
    expect(await sendToOwner("wallet-nobody", "hi")).to.equal("not-linked");
    expect(calls).to.equal(0);
  });
});

describe("the listener", () => {
  const realFetch = globalThis.fetch;
  let sent: { chat_id: number; text: string }[];
  let updates: unknown;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token-not-real";
    sent = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/getUpdates")) {
        return updates === "down"
          ? Promise.reject(new Error("unreachable"))
          : new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 });
      }
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("answers what arrived and moves past it", async () => {
    const code = issueCode("wallet-a");
    updates = [{ update_id: 500, message: { text: `/start ${code}`, chat: { id: 1001 } } }];
    expect(await pollOnce(0)).to.equal(true);
    expect(chatFor("wallet-a")).to.equal(1001);
    expect(sent[0].text).to.include("Linked to wallet");
    expect(getOffset()).to.equal(501);
  });

  it("reports Telegram being unreachable instead of throwing", async () => {
    updates = "down";
    expect(await pollOnce(0)).to.equal(false);
  });
});

describe("where decisions are sent", () => {
  const realFetch = globalThis.fetch;
  let sent: { chat_id: number; text: string }[];

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token-not-real";
    sent = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  const entry = (owner: string): AutopilotEntry => ({
    mandate: "M", owner, mandateId: 0, objective: "x", everyMinutes: 30,
    enabled: true, createdAt: 0, lastRunAt: null,
  });
  const decision = (owner: string): Decision => ({
    mandate: "M", owner, at: Date.now(), outcome: "held",
    summary: "Kept the allocation.", reasoning: null, positions: [], signatures: [],
  });

  it("sends a decision to the chat its owner linked", async () => {
    redeemCode(issueCode("wallet-a"), 1001, null);
    await notify(decision("wallet-a"), entry("wallet-a"));
    expect(sent).to.have.length(1);
    expect(sent[0].chat_id).to.equal(1001);
  });

  it("never sends one owner's decision to another owner's chat", async () => {
    redeemCode(issueCode("wallet-a"), 1001, null);
    await notify(decision("wallet-b"), entry("wallet-b"));
    expect(sent).to.have.length(0);
  });

  it("sends nothing without a bot token", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    redeemCode(issueCode("wallet-a"), 1001, null);
    await notify(decision("wallet-a"), entry("wallet-a"));
    expect(sent).to.have.length(0);
  });
});

describe("Telegram tools with nobody connected", () => {
  for (const name of ["link_telegram", "unlink_telegram"]) {
    it(`${name} asks for a wallet`, async () => {
      try {
        await AUTOPILOT_TOOLS[name].run({}, { owner: null });
        expect.fail(`${name} ran with no owner`);
      } catch (error) {
        expect(String(error)).to.include("wallet");
      }
    });
  }
});
