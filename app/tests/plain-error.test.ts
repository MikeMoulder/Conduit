import { describe, it } from "node:test";
import { expect } from "chai";

import { plainChainError, tidySummary } from "../src/lib/plain-error";

/**
 * Tests for how a failed send reads to a person.
 *
 * Written after the autopilot's history showed a settle that ran out of
 * compute as forty lines of program ids and compute counts, copied from the
 * simulation log into the decision. What is protected: a known failure reads
 * as one sentence, an unknown one loses its log, words a person wrote are
 * kept, and decisions stored before the fix read the same way.
 */

const LOG =
  'Simulation failed. Message: Transaction simulation failed: Error processing Instruction 0: Program failed to complete. Logs: [ "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 76 of 38427 compute units", "Program 6X7wfnLHQvW94CHPVFdguraojh5uEN3Y1gjfi2pkxVu consumed 200000 of 200000 compute units", "Program 6X7wfnLHQvW94CHPVFdguraojh5uEN3Y1gjfi2pkxVu failed: exceeded CUs meter at BPF instruction" ]. Catch the `SendTransactionError` and call `getLogs()` on it for full details.';

describe("plainChainError", () => {
  it("reads a compute failure as one sentence", () => {
    expect(plainChainError(LOG)).to.equal("Solana ran out of compute for the transaction, so nothing moved.");
  });

  it("keeps no program id or compute count", () => {
    const out = plainChainError(LOG);
    expect(out).to.not.match(/Program|compute units|getLogs|\[/);
  });

  it("names the instruction's reason when the failure is not a known one", () => {
    const raw =
      'Simulation failed. Message: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1. Logs: [ "Program log: nope" ].';
    expect(plainChainError(raw)).to.equal("Solana refused it: custom program error: 0x1.");
  });

  it("falls back to a plain refusal when the log has no reason", () => {
    expect(plainChainError('Logs: [ "Program log: x" ]')).to.equal("Solana refused the transaction, so nothing moved.");
  });

  it("drops a library prefix ending in a colon", () => {
    expect(plainChainError("failed to send transaction: Transaction simulation failed: Blockhash not found")).to.equal(
      "The transaction expired before Solana picked it up, so nothing moved. Trying again usually works.",
    );
  });

  it("reads a fee shortfall plainly", () => {
    expect(plainChainError("Attempt to debit an account but found no record of a prior credit.")).to.match(/enough SOL/);
  });

  it("leaves a plain sentence alone", () => {
    expect(plainChainError("It holds no cash. Move money in from the main wallet.")).to.equal(
      "It holds no cash. Move money in from the main wallet.",
    );
  });

  it("clips a long plain message at a word", () => {
    const out = plainChainError("word ".repeat(80));
    expect(out.length).to.be.at.most(203);
    expect(out.endsWith("...")).to.equal(true);
  });

  it("returns nothing for nothing", () => {
    expect(plainChainError(undefined)).to.equal("");
    expect(plainChainError("")).to.equal("");
  });
});

describe("tidySummary", () => {
  it("keeps what happened and replaces the log", () => {
    const stored = `The new targets were accepted, but the settlement did not go through. ${LOG}`;
    expect(tidySummary(stored)).to.equal(
      "The new targets were accepted, but the settlement did not go through. Solana ran out of compute for the transaction, so nothing moved.",
    );
  });

  it("closes a sentence left open by a bracket", () => {
    const stored = `Safety brake: the mandate fell 10% from its best point. The settlement did not go through (${LOG}). Ask for a settlement.`;
    expect(tidySummary(stored)).to.equal(
      "Safety brake: the mandate fell 10% from its best point. The settlement did not go through. Solana ran out of compute for the transaction, so nothing moved.",
    );
  });

  it("leaves a summary with no log untouched", () => {
    const plain = "Rebalanced to 30% NVDA, 30% AAPL, 30% MSFT, 10% cash, then settled into real tokens.";
    expect(tidySummary(plain)).to.equal(plain);
  });
});
