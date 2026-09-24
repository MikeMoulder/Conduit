import { describe, it } from "node:test";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";

import { assetUnits, cashUnits } from "../src/lib/agent-actions";
import { PROGRAM_ID } from "../src/lib/chain";
import { deskAssetAddress, walletAddress } from "../src/lib/main-wallet";
import { WALLET_TOOLS } from "../src/lib/copilot/wallet-tools";

/**
 * Tests for the app's side of the main wallet.
 *
 * The program's own suite proves what the chain allows. These cover what the
 * app has to get right for that to matter: deriving the same addresses the
 * program derives, converting dollars to base units without ever rounding up,
 * and refusing to act for nobody.
 */

describe("main wallet addresses", () => {
  it("derives the wallet from the owner exactly as the program does", () => {
    const owner = Keypair.generate().publicKey;
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), owner.toBuffer()],
      PROGRAM_ID,
    );
    expect(walletAddress(owner).toBase58()).to.equal(expected.toBase58());
  });

  it("gives every owner a different wallet", () => {
    const a = walletAddress(Keypair.generate().publicKey);
    const b = walletAddress(Keypair.generate().publicKey);
    expect(a.toBase58()).to.not.equal(b.toBase58());
  });

  it("derives the desk's price binding for a mint as the program does", () => {
    const mint = Keypair.generate().publicKey;
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("desk_asset"), mint.toBuffer()],
      PROGRAM_ID,
    );
    expect(deskAssetAddress(mint).toBase58()).to.equal(expected.toBase58());
  });
});

describe("dollars to base units", () => {
  it("converts whole dollars exactly at six decimals", () => {
    expect(cashUnits(3_000)).to.equal(BigInt(3_000_000_000));
  });

  it("rounds down, never up", () => {
    // Rounding up would ask the program to move a unit the wallet may not
    // have, and the trade would fail on a fraction nobody asked for.
    expect(cashUnits(0.0000009)).to.equal(BigInt(0));
    expect(cashUnits(1.9999999)).to.equal(BigInt(1_999_999));
  });

  it("converts whole tokens at the asset's own decimals", () => {
    expect(assetUnits(13.5, 8)).to.equal(BigInt(1_350_000_000));
    expect(assetUnits(0.000000009, 8)).to.equal(BigInt(0));
  });
});

describe("wallet tools with nobody connected", () => {
  // Valid arguments for each, so the refusal comes from the missing owner and
  // not from a malformed request.
  const calls: [string, Record<string, unknown>][] = [
    ["get_wallet", {}],
    ["open_wallet", {}],
    ["get_demo_cash", {}],
    ["deposit", { dollars: 100 }],
    ["place_order", { side: "BUY", symbol: "NVDA", dollars: 100 }],
    ["fund_mandate", { dollars: 100 }],
    ["withdraw", { amount: 100 }],
  ];

  for (const [name, args] of calls) {
    it(`${name} asks for a wallet rather than acting for nobody`, async () => {
      try {
        await WALLET_TOOLS[name].run(args, { owner: null });
        expect.fail(`${name} ran with no owner`);
      } catch (error) {
        expect(String(error)).to.include("wallet");
      }
    });
  }
});
