import { describe, it } from "node:test";
import { expect } from "chai";
import { Keypair, SystemProgram } from "@solana/web3.js";

import {
  createAssociatedTokenAccountIdempotent,
  topUpAmount,
  transferTokens,
} from "../src/lib/faucet";

/**
 * Tests for the devnet faucet's arithmetic and its hand built instructions.
 *
 * The instructions get the attention. They are assembled byte by byte rather
 * than taken from @solana/spl-token, which keeps the dependency out of the app
 * and moves the burden of being right onto these tests. A wrong tag byte or a
 * swapped account does not fail loudly: it either calls a different
 * instruction or moves tokens somewhere unintended, and the chain would carry
 * it out.
 *
 * The expected layouts come from the SPL programs themselves: the associated
 * token program's CreateIdempotent is tag 1 with six accounts, and the token
 * program's Transfer is tag 3 followed by a little endian u64.
 */

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const key = () => Keypair.generate().publicKey;

describe("topping up", () => {
  it("sends the difference to reach the target", () => {
    expect(topUpAmount(BigInt(2_500), BigInt(10_000))).to.equal(BigInt(7_500));
  });

  it("sends nothing once the target is reached", () => {
    // What makes pressing the button twice harmless.
    expect(topUpAmount(BigInt(10_000), BigInt(10_000))).to.equal(BigInt(0));
  });

  it("sends nothing to a portfolio already above the target", () => {
    // A portfolio that settled into gains is not topped down, and is not sent
    // a negative amount, which as a u64 would be an enormous one.
    expect(topUpAmount(BigInt(50_000), BigInt(10_000))).to.equal(BigInt(0));
  });

  it("fills an empty portfolio completely", () => {
    expect(topUpAmount(BigInt(0), BigInt(10_000))).to.equal(BigInt(10_000));
  });
});

describe("creating a token account", () => {
  it("calls CreateIdempotent on the associated token program", () => {
    const ix = createAssociatedTokenAccountIdempotent(key(), key(), key(), key());
    expect(ix.programId.toBase58()).to.equal(ATA);
    // Tag 1 is the idempotent variant. Tag 0 would fail on the second press,
    // because the account would already exist.
    expect([...ix.data]).to.deep.equal([1]);
  });

  it("orders its accounts as the program expects", () => {
    const payer = key();
    const ata = key();
    const owner = key();
    const mint = key();
    const ix = createAssociatedTokenAccountIdempotent(payer, ata, owner, mint);

    expect(ix.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([
      payer.toBase58(),
      ata.toBase58(),
      owner.toBase58(),
      mint.toBase58(),
      SystemProgram.programId.toBase58(),
      TOKEN,
    ]);
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).to.deep.equal([
      [true, true],
      [false, true],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
  });
});

describe("transferring cash", () => {
  it("encodes Transfer as tag 3 and a little endian amount", () => {
    const ix = transferTokens(key(), key(), key(), BigInt(10_000_000_000));
    expect(ix.programId.toBase58()).to.equal(TOKEN);
    expect(ix.data.length).to.equal(9);
    expect(ix.data[0]).to.equal(3);
    expect(ix.data.readBigUInt64LE(1)).to.equal(BigInt(10_000_000_000));
  });

  it("moves from the source to the destination, signed by the owner", () => {
    // Source and destination swapped would pay the faucet out of the
    // portfolio. The order is the whole of the safety here.
    const source = key();
    const destination = key();
    const owner = key();
    const ix = transferTokens(source, destination, owner, BigInt(1));

    expect(ix.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([
      source.toBase58(),
      destination.toBase58(),
      owner.toBase58(),
    ]);
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).to.deep.equal([
      [false, true],
      [false, true],
      [true, false],
    ]);
  });

  it("builds without Buffer's BigInt methods, as in the browser", () => {
    // The browser's Buffer polyfill has no writeBigUInt64LE. The deposit card
    // threw "data.writeBigUInt64LE is not a function" in Chrome while every
    // test here passed, because Node's Buffer has it. Removing it reproduces
    // the browser.
    const proto = Buffer.prototype as unknown as Record<string, unknown>;
    const saved = proto.writeBigUInt64LE;
    delete proto.writeBigUInt64LE;
    try {
      const ix = transferTokens(key(), key(), key(), BigInt(1_000_000_000));
      expect(ix.data[0]).to.equal(3);
      expect(new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true)).to.equal(
        BigInt(1_000_000_000),
      );
    } finally {
      proto.writeBigUInt64LE = saved;
    }
  });

  it("carries amounts past what a JavaScript number holds exactly", () => {
    const big = BigInt("18000000000000000000");
    const ix = transferTokens(key(), key(), key(), big);
    expect(ix.data.readBigUInt64LE(1)).to.equal(big);
  });
});
