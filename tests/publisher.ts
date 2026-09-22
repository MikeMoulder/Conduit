/**
 * The price publisher, against the deployed program.
 *
 * What is being proved here is not that a number can be written to an account.
 * It is that the account behaves like a price feed rather than like a mutable
 * variable, which is the only thing that makes it safe to settle against.
 *
 * A feed refuses to move backwards, refuses a timestamp far from the cluster's
 * own clock, and can be written by exactly one key. Take any of those away and
 * a settlement could be made to run at a price chosen after the fact, which
 * would defeat the whole arrangement more completely than having no oracle at
 * all.
 *
 * The trust model is stated plainly rather than tested, because it cannot be
 * tested: a published price is one key asserting a number. What these tests
 * cover is that nobody else can assert it, and that an old assertion cannot be
 * replayed into a current one.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

import type { Conduit } from "../app/src/lib/idl/conduit";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const idl = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), "target", "idl", "conduit.json"),
    "utf8",
  ),
) as Conduit;

const program = new Program<Conduit>(idl, provider);
const authority = provider.wallet;
const connection = provider.connection;

const [PUBLISHER] = PublicKey.findProgramAddressSync(
  [Buffer.from("publisher")],
  program.programId,
);

/** The same derivation the app and the publisher script use. */
function feedIdFor(symbol: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`conduit.publisher.v1:${symbol.toUpperCase()}`)
    .digest();
}

function priceAccountFor(feedId: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("price"), feedId],
    program.programId,
  )[0];
}

/** A symbol nothing else in the suite touches, so runs do not collide. */
function freshSymbol(): string {
  return `TEST${Math.floor(Math.random() * 1e9)}`;
}

const now = () => Math.floor(Date.now() / 1000);

async function publish(
  symbol: string,
  price: bigint,
  publishTime: number,
  options: { exponent?: number; source?: string; signer?: Keypair } = {},
): Promise<void> {
  const feedId = feedIdFor(symbol);
  const builder = program.methods
    .publishPrice(
      Array.from(feedId),
      new BN(price.toString()),
      options.exponent ?? -8,
      new BN(publishTime),
      options.source ?? "test",
    )
    .accountsStrict({
      publisher: PUBLISHER,
      price: priceAccountFor(feedId),
      authority: options.signer
        ? options.signer.publicKey
        : authority.publicKey,
      systemProgram: SystemProgram.programId,
    });

  if (options.signer) {
    await builder.signers([options.signer]).rpc();
  } else {
    await builder.rpc();
  }
}

describe("the price publisher", () => {
  before(async function () {
    this.timeout(60_000);

    const existing = await connection.getAccountInfo(PUBLISHER);
    if (!existing) {
      await program.methods
        .initializePublisher()
        .accountsStrict({
          publisher: PUBLISHER,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  it("names exactly one key that may write a price", async () => {
    const account = await program.account.publisher.fetch(PUBLISHER);
    assert.strictEqual(
      account.authority.toBase58(),
      authority.publicKey.toBase58(),
    );
  });

  it("writes a price and stores it where the feed id says", async () => {
    const symbol = freshSymbol();
    const at = now();

    // 339.55 at eight decimals, roughly what a tokenized AAPL trades at.
    await publish(symbol, 33_955_000_000n, at);

    const stored = await program.account.publishedPrice.fetch(
      priceAccountFor(feedIdFor(symbol)),
    );

    assert.strictEqual(stored.price.toString(), "33955000000");
    assert.strictEqual(stored.exponent, -8);
    assert.strictEqual(stored.publishTime.toNumber(), at);
    assert.strictEqual(stored.source, "test");
    assert.deepStrictEqual(
      Buffer.from(stored.feedId).toString("hex"),
      feedIdFor(symbol).toString("hex"),
    );
  });

  it("updates in place rather than creating a second account", async () => {
    const symbol = freshSymbol();
    const account = priceAccountFor(feedIdFor(symbol));

    await publish(symbol, 10_000_000_000n, now() - 60);
    await publish(symbol, 11_000_000_000n, now());

    const stored = await program.account.publishedPrice.fetch(account);
    assert.strictEqual(stored.price.toString(), "11000000000");
  });

  it("REFUSES a price that moves backwards in time", async () => {
    // The check that makes a replay useless. Without it, an old write could be
    // resubmitted later and would read as current.
    const symbol = freshSymbol();
    const at = now();

    await publish(symbol, 10_000_000_000n, at);

    try {
      await publish(symbol, 99_000_000_000n, at - 30);
      assert.fail("accepted a price older than the one already stored");
    } catch (error) {
      assert.include(String(error), "PriceNotNewer");
    }
  });

  it("REFUSES a price at the same instant as the stored one", async () => {
    // Strictly newer, not newer or equal. Two different prices sharing a
    // timestamp means one of them is wrong and there is no way to tell which.
    const symbol = freshSymbol();
    const at = now();

    await publish(symbol, 10_000_000_000n, at);

    try {
      await publish(symbol, 20_000_000_000n, at);
      assert.fail("accepted a second price at the same timestamp");
    } catch (error) {
      assert.include(String(error), "PriceNotNewer");
    }
  });

  it("REFUSES any signer that is not the publishing authority", async () => {
    // The property the whole design depends on. If another key could write
    // here, an agent holding it could choose the price its own settlement runs
    // at, and every mandate limit would become decorative.
    const stranger = Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(stranger.publicKey, 20_000_000),
      "confirmed",
    );

    try {
      await publish(freshSymbol(), 10_000_000_000n, now(), {
        signer: stranger,
      });
      assert.fail("accepted a price from a key that is not the authority");
    } catch (error) {
      assert.include(String(error), "UnauthorizedPublisher");
    }
  });

  it("REFUSES a price stamped far in the past", async () => {
    try {
      await publish(freshSymbol(), 10_000_000_000n, now() - 3600);
      assert.fail("accepted an hour old price");
    } catch (error) {
      assert.include(String(error), "PriceUnusable");
    }
  });

  it("REFUSES a price stamped in the future", async () => {
    try {
      await publish(freshSymbol(), 10_000_000_000n, now() + 3600);
      assert.fail("accepted a price stamped an hour ahead");
    } catch (error) {
      assert.include(String(error), "PriceUnusable");
    }
  });

  it("REFUSES a price of zero", async () => {
    try {
      await publish(freshSymbol(), 0n, now());
      assert.fail("accepted a price of zero");
    } catch (error) {
      assert.include(String(error), "PriceUnusable");
    }
  });

  it("REFUSES a positive exponent", async () => {
    // A positive exponent multiplies where it should divide, which would make
    // a price thousands of times too large rather than obviously wrong.
    try {
      await publish(freshSymbol(), 10_000_000_000n, now(), { exponent: 2 });
      assert.fail("accepted a positive exponent");
    } catch (error) {
      assert.include(String(error), "PriceUnusable");
    }
  });

  it("derives the same account the app and the script derive", async () => {
    // Three independent derivations of the same address: this file, the app,
    // and the publisher script. If they ever disagree the program reads an
    // account nobody is writing, and a settlement quietly runs on a stale
    // price instead of failing.
    const { publishedFeedId } = await import(
      "../app/src/lib/published-feeds"
    );

    for (const symbol of ["AAPL", "OPENAI", "SPACEX"]) {
      assert.strictEqual(
        publishedFeedId(symbol).toString("hex"),
        feedIdFor(symbol).toString("hex"),
        `feed id disagrees for ${symbol}`,
      );
    }
  });
});
