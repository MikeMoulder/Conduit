import { describe, it } from "node:test";
import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";

import {
  associatedTokenAddress,
  desk,
  isSettleable,
  settleableAsset,
  valueHoldings,
  type PortfolioHoldings,
} from "../src/lib/holdings";
import type { MandateView } from "../src/lib/accounts";

/**
 * Tests for the difference between a target and a holding.
 *
 * That difference is the whole reason this module exists, and it was wrong in
 * the interface for a long time: a set of weights the program enforces was
 * being shown under the heading "Held now", which claimed custody that did not
 * exist. These tests hold the corrected version in place.
 *
 * Offline on purpose. Nothing here talks to a cluster, because none of it is
 * about what a particular account contains. It is about the decisions this
 * module makes around whatever the balances turn out to be: which mandates can
 * settle at all, what an address derives to, and what a set of balances is
 * worth once priced.
 *
 * `fetchHoldings` itself is left to the integration tests, where a real
 * settlement is run and the balances either side of it are asserted on. Mocking
 * an RPC here would test the mock.
 */

/** A mandate is mostly irrelevant to this module, so only the parts it reads. */
function mandateOver(mints: string[]): MandateView {
  return {
    owner: "11111111111111111111111111111111",
    agent: "11111111111111111111111111111111",
    status: "active",
    allowedAssets: mints.map((mint) => ({ mint, feedId: "00".repeat(32) })),
    constraints: {
      maxPositionBps: 4000,
      minCashBps: 1000,
      maxTurnoverBps: 3000,
      maxAssets: 5,
    },
    createdAt: 0,
    updatedAt: 0,
    bump: 255,
  } as unknown as MandateView;
}

const [btc, eth] = desk.settleable;

/** A mint the desk does not carry, so it cannot be priced on chain. */
const UNSETTLEABLE = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcDp5hLxnk4qNBz";

describe("which mandates can settle", () => {
  it("accepts one whose every asset the desk can price", () => {
    expect(isSettleable(mandateOver([btc.mint, eth.mint]))).to.equal(true);
  });

  it("refuses one carrying a single asset it cannot price", () => {
    // All or nothing, and not for tidiness. Settlement values the whole
    // portfolio to work out what any one weight is a share of, so one asset
    // without a price makes the arithmetic for every other asset wrong.
    expect(isSettleable(mandateOver([btc.mint, UNSETTLEABLE]))).to.equal(false);
  });

  it("refuses an empty mandate rather than calling it trivially settleable", () => {
    // Vacuous truth would say yes here. There is nothing to settle, which is a
    // different answer from yes and a more useful one.
    expect(isSettleable(mandateOver([]))).to.equal(false);
  });

  it("finds the desk entry by mint, and nothing for a stranger", () => {
    expect(settleableAsset(btc.mint)?.symbol).to.equal(btc.symbol);
    expect(settleableAsset(UNSETTLEABLE)).to.equal(undefined);
  });
});

describe("deriving the token account", () => {
  it("matches the canonical associated token address", () => {
    // Derived here rather than by pulling @solana/spl-token into the browser
    // bundle, so this test is what stands behind that decision. The expected
    // value comes from the spl-token implementation of the same derivation.
    const owner = new PublicKey("GwXgM9gmJ7kX9qGfkCkPYdbyuw7syzMu4Zynzq992bNo");
    const mint = new PublicKey(desk.cashMint);

    const expected = PublicKey.findProgramAddressSync(
      [
        owner.toBuffer(),
        new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(),
        mint.toBuffer(),
      ],
      new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    )[0];

    expect(associatedTokenAddress(owner, mint).toBase58()).to.equal(
      expected.toBase58(),
    );
  });

  it("gives a different account per mint for the same owner", () => {
    const owner = new PublicKey("GwXgM9gmJ7kX9qGfkCkPYdbyuw7syzMu4Zynzq992bNo");
    const a = associatedTokenAddress(owner, new PublicKey(btc.mint));
    const b = associatedTokenAddress(owner, new PublicKey(eth.mint));
    expect(a.toBase58()).to.not.equal(b.toBase58());
  });
});

function holding(symbol: string, mint: string, uiAmount: number) {
  return {
    symbol,
    mint,
    decimals: 6,
    amount: String(Math.round(uiAmount * 1e6)),
    uiAmount,
    exists: true,
  };
}

function holdingsOf(cash: number, assets: [string, string, number][]): PortfolioHoldings {
  return {
    settleable: true,
    cash: holding("CASH", desk.cashMint, cash),
    assets: assets.map(([s, m, a]) => holding(s, m, a)),
    funded: true,
  };
}

describe("valuing what is held", () => {
  it("weights each holding by its share of the total", () => {
    const valued = valueHoldings(
      holdingsOf(2500, [
        ["BTC", btc.mint, 0.05],
        ["ETH", eth.mint, 1],
      ]),
      (symbol) => (symbol === "BTC" ? 100_000 : symbol === "ETH" ? 2500 : null),
    );

    // 5000 in BTC, 2500 in ETH, 2500 in cash, so 10000 total.
    expect(valued?.total).to.equal(10_000);
    expect(valued?.assets[0].weightBps).to.equal(5000);
    expect(valued?.assets[1].weightBps).to.equal(2500);
    expect(valued?.cashWeightBps).to.equal(2500);
  });

  it("leaves an unpriced holding null rather than counting it as nothing", () => {
    // Zero would be a claim, and the wrong one. A holding without a price is
    // worth something unknown, and every other weight here is a share of a
    // total that does not include it.
    const valued = valueHoldings(
      holdingsOf(1000, [
        ["BTC", btc.mint, 0.01],
        ["ETH", eth.mint, 1],
      ]),
      (symbol) => (symbol === "BTC" ? 100_000 : null),
    );

    expect(valued?.assets[0].value).to.equal(1000);
    expect(valued?.assets[1].value).to.equal(null);
    expect(valued?.assets[1].weightBps).to.equal(null);
    expect(valued?.total).to.equal(2000);
  });

  it("returns nothing for a mandate that cannot settle", () => {
    // Not an empty valuation. A portfolio holding nothing and a portfolio where
    // holding is not a concept are different, and null says the second.
    const valued = valueHoldings(
      { settleable: false, cash: null, assets: [], funded: false },
      () => 1,
    );
    expect(valued).to.equal(null);
  });

  it("does not divide by an empty portfolio", () => {
    const valued = valueHoldings(holdingsOf(0, [["BTC", btc.mint, 0]]), () => 100);
    expect(valued?.total).to.equal(0);
    expect(valued?.cashWeightBps).to.equal(0);
    expect(Number.isNaN(valued?.assets[0].weightBps ?? 0)).to.equal(false);
  });
});
