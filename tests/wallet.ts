/**
 * The main wallet and mandate wallets, against the deployed program.
 *
 * The design lets the agent act without a wallet prompt, so these tests are
 * mostly about what it still cannot do. A convenience that let a stolen agent
 * key move money anywhere would be worse than no convenience at all, and every
 * refusal below is one way that could otherwise happen.
 *
 * The happy path is here too, with balances asserted either side, because a
 * trade that moved the wrong amount would pass every refusal test.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

import type { Conduit } from "../app/src/lib/idl/conduit";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const idl = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "target", "idl", "conduit.json"), "utf8"),
) as Conduit;
const program = new Program<Conduit>(idl, provider);
const payer = provider.wallet;
const connection = provider.connection;

interface DeskAssetConfig {
  symbol: string;
  mint: string;
  decimals: number;
  feedId: string;
  priceAccount: string;
  deskTokenAccount: string;
}

const desk = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "app/src/lib/desk.devnet.json"), "utf8"),
) as {
  cashMint: string;
  cashDecimals: number;
  desk: string;
  deskCash: string;
  settleable: DeskAssetConfig[];
};

const CASH = new PublicKey(desk.cashMint);
const DESK = new PublicKey(desk.desk);
const DESK_CASH = new PublicKey(desk.deskCash);
const NVDA = desk.settleable.find((a) => a.symbol === "NVDA")!;
const AAPL = desk.settleable.find((a) => a.symbol === "AAPL")!;

const cashUnits = (n: number) => BigInt(n) * BigInt(10) ** BigInt(desk.cashDecimals);

const pda = (seeds: Buffer[]) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];

const walletPda = (owner: PublicKey) => pda([Buffer.from("wallet"), owner.toBuffer()]);
const deskAssetPda = (mint: PublicKey) => pda([Buffer.from("desk_asset"), mint.toBuffer()]);

const ata = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true);

async function balance(account: PublicKey): Promise<bigint> {
  return (await getAccount(connection, account)).amount;
}

async function ensureAtas(pairs: [PublicKey, PublicKey][]): Promise<void> {
  await provider.sendAndConfirm(
    new Transaction().add(
      ...pairs.map(([mint, owner]) =>
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          ata(mint, owner),
          owner,
          mint,
        ),
      ),
    ),
  );
}

async function expectRefusal(call: Promise<unknown>, name: string): Promise<void> {
  try {
    await call;
    assert.fail(`expected ${name}, but it went through`);
  } catch (error) {
    assert.include(String(error), name);
  }
}

describe("main wallet and mandate wallets", () => {
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const stranger = Keypair.generate();
  const wallet = walletPda(owner.publicKey);
  const nvdaMint = new PublicKey(NVDA.mint);
  const aaplMint = new PublicKey(AAPL.mint);

  const trade = (buying: boolean, amount: bigint, signer: Keypair, price = NVDA.priceAccount) =>
    program.methods
      .trade(buying, new BN(amount.toString()))
      .accountsStrict({
        wallet,
        signer: signer.publicKey,
        desk: DESK,
        deskAsset: deskAssetPda(nvdaMint),
        price: new PublicKey(price),
        mint: nvdaMint,
        cashMint: CASH,
        walletCash: ata(CASH, wallet),
        walletAsset: ata(nvdaMint, wallet),
        deskCash: DESK_CASH,
        deskHolding: new PublicKey(NVDA.deskTokenAccount),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();

  // A mandate owned by the same person, for the moving tests.
  let mandate: PublicKey;
  let portfolio: PublicKey;

  before(async function () {
    this.timeout(180_000);

    // Rent for the owner, and a little for the stranger so its refusals are
    // refused by the program rather than by an empty fee account.
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: owner.publicKey, lamports: 60_000_000 }),
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger.publicKey, lamports: 10_000_000 }),
      ),
    );

    // The desk states how it prices NVDA and AAPL, once.
    for (const asset of [NVDA, AAPL]) {
      const mint = new PublicKey(asset.mint);
      if (!(await connection.getAccountInfo(deskAssetPda(mint)))) {
        await program.methods
          .registerDeskAsset(Array.from(Buffer.from(asset.feedId, "hex")))
          .accountsStrict({
            desk: DESK,
            deskAsset: deskAssetPda(mint),
            mint,
            authority: payer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }
    }

    // The owner holds cash in their own wallet, as they would after buying it.
    await ensureAtas([
      [CASH, owner.publicKey],
      [nvdaMint, owner.publicKey],
      [CASH, agent.publicKey],
    ]);
    await provider.sendAndConfirm(
      new Transaction().add(
        createMintToInstruction(CASH, ata(CASH, owner.publicKey), payer.publicKey, cashUnits(20_000)),
      ),
    );

    // A mandate over NVDA and AAPL for the same owner, with its cash account.
    const id = new BN(Date.now() % 1_000_000_000);
    mandate = pda([Buffer.from("mandate"), owner.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)]);
    portfolio = pda([Buffer.from("portfolio"), mandate.toBuffer()]);

    await program.methods
      .initializeMandate(
        id,
        { maxPositionBps: 5000, minCashBps: 1000, maxTurnoverBps: 9000, maxAssets: 2 },
        [NVDA, AAPL].map((a) => ({
          mint: new PublicKey(a.mint),
          feedId: Array.from(Buffer.from(a.feedId, "hex")),
        })),
        agent.publicKey,
      )
      .accountsStrict({ mandate, owner: owner.publicKey, systemProgram: SystemProgram.programId })
      .postInstructions([
        await program.methods
          .initializePortfolio()
          .accountsStrict({ mandate, portfolio, owner: owner.publicKey, systemProgram: SystemProgram.programId })
          .instruction(),
      ])
      .signers([owner])
      .rpc();

    await ensureAtas([[CASH, portfolio]]);
  });

  it("opens a wallet bound to its owner, naming the agent", async () => {
    await program.methods
      .openWallet(agent.publicKey)
      .accountsStrict({ wallet, owner: owner.publicKey, systemProgram: SystemProgram.programId })
      .signers([owner])
      .rpc();

    const account = await program.account.mainWallet.fetch(wallet);
    assert.strictEqual(account.owner.toBase58(), owner.publicKey.toBase58());
    assert.strictEqual(account.agent.toBase58(), agent.publicKey.toBase58());

    await ensureAtas([
      [CASH, wallet],
      [nvdaMint, wallet],
      [aaplMint, wallet],
    ]);
  });

  it("refuses to open a second wallet for the same owner", async () => {
    // One per person, because the address is derived from the owner alone.
    try {
      await program.methods
        .openWallet(stranger.publicKey)
        .accountsStrict({ wallet, owner: owner.publicKey, systemProgram: SystemProgram.programId })
        .signers([owner])
        .rpc();
      assert.fail("opened a second wallet over the first");
    } catch (error) {
      assert.match(String(error), /already in use|custom program error: 0x0/);
    }
  });

  it("takes a deposit as an ordinary transfer from the owner", async () => {
    await provider.sendAndConfirm(
      new Transaction().add(
        createTransferInstruction(ata(CASH, owner.publicKey), ata(CASH, wallet), owner.publicKey, cashUnits(10_000)),
      ),
      [owner],
    );
    assert.strictEqual(await balance(ata(CASH, wallet)), cashUnits(10_000));
  });

  it("lets the agent buy with no signature from the owner", async () => {
    const cashBefore = await balance(ata(CASH, wallet));

    await trade(true, cashUnits(3_000), agent);

    const cashAfter = await balance(ata(CASH, wallet));
    const held = await balance(ata(nvdaMint, wallet));

    assert.strictEqual(cashBefore - cashAfter, cashUnits(3_000));
    assert.isTrue(held > BigInt(0), "bought nothing");

    // Worth what was paid, to within a unit of rounding against the wallet.
    const price = await program.account.publishedPrice.fetch(new PublicKey(NVDA.priceAccount));
    const dollars =
      (Number(held) / 10 ** NVDA.decimals) * Number(price.price.toString()) * 10 ** price.exponent;
    assert.closeTo(dollars, 3_000, 0.01);
    assert.isAtMost(dollars, 3_000);
  });

  it("lets the agent sell, never paying out more than the units were worth", async () => {
    const cashBefore = await balance(ata(CASH, wallet));
    const heldBefore = await balance(ata(nvdaMint, wallet));

    await trade(false, cashUnits(1_000), agent);

    const raised = (await balance(ata(CASH, wallet))) - cashBefore;
    const sold = heldBefore - (await balance(ata(nvdaMint, wallet)));

    assert.isTrue(sold > BigInt(0));
    assert.isTrue(raised > BigInt(0) && raised <= cashUnits(1_000));
  });

  it("REFUSES a trade signed by anyone but the owner or agent", async () => {
    await expectRefusal(trade(true, cashUnits(100), stranger), "UnauthorizedWalletSigner");
  });

  it("REFUSES NVDA at another asset's price", async () => {
    // The desk bound NVDA to its own feed. Without the binding a caller could
    // buy it at the price of something cheaper.
    await expectRefusal(
      trade(true, cashUnits(100), agent, AAPL.priceAccount),
      "PriceFeedMismatch",
    );
  });

  it("REFUSES a buy larger than the cash", async () => {
    await expectRefusal(trade(true, cashUnits(1_000_000), agent), "InsufficientBalance");
  });

  it("lets the agent move cash into the owner's mandate", async () => {
    await program.methods
      .moveToMandate(new BN(cashUnits(2_000).toString()))
      .accountsStrict({
        wallet,
        signer: agent.publicKey,
        portfolio,
        from: ata(CASH, wallet),
        to: ata(CASH, portfolio),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agent])
      .rpc();

    assert.strictEqual(await balance(ata(CASH, portfolio)), cashUnits(2_000));
  });

  it("REFUSES moving cash into somebody else's mandate", async () => {
    // A mandate belonging to a different person, created here. Money may only
    // move between one person's own wallets.
    const other = Keypair.generate();
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other.publicKey, lamports: 30_000_000 }),
      ),
    );
    const id = new BN(1);
    const otherMandate = pda([Buffer.from("mandate"), other.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)]);
    const otherPortfolio = pda([Buffer.from("portfolio"), otherMandate.toBuffer()]);
    await program.methods
      .initializeMandate(
        id,
        // One asset at up to 90 percent plus a 10 percent floor adds up to the
        // whole book. 50 percent here was refused as ContradictoryConstraints,
        // correctly: it could never be more than 60 percent invested.
        { maxPositionBps: 9000, minCashBps: 1000, maxTurnoverBps: 9000, maxAssets: 1 },
        [{ mint: nvdaMint, feedId: Array.from(Buffer.from(NVDA.feedId, "hex")) }],
        agent.publicKey,
      )
      .accountsStrict({ mandate: otherMandate, owner: other.publicKey, systemProgram: SystemProgram.programId })
      .postInstructions([
        await program.methods
          .initializePortfolio()
          .accountsStrict({ mandate: otherMandate, portfolio: otherPortfolio, owner: other.publicKey, systemProgram: SystemProgram.programId })
          .instruction(),
      ])
      .signers([other])
      .rpc();
    await ensureAtas([[CASH, otherPortfolio]]);

    await expectRefusal(
      program.methods
        .moveToMandate(new BN(cashUnits(100).toString()))
        .accountsStrict({
          wallet,
          signer: agent.publicKey,
          portfolio: otherPortfolio,
          from: ata(CASH, wallet),
          to: ata(CASH, otherPortfolio),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc(),
      "WalletOwnerMismatch",
    );
  });

  const moveFromMandate = (signer: Keypair, amount: bigint) =>
    program.methods
      .moveFromMandate(new BN(amount.toString()))
      .accountsStrict({
        wallet,
        owner: signer.publicKey,
        portfolio,
        from: ata(CASH, portfolio),
        to: ata(CASH, wallet),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();

  it("REFUSES the agent pulling money out of a mandate into the main wallet", async () => {
    // The one place the agent is refused where the owner is not. The main
    // wallet has no limits, so this would be a way around every rule the
    // mandate sets.
    await expectRefusal(moveFromMandate(agent, cashUnits(100)), "OwnerOnly");
  });

  it("lets the owner pull money out of a mandate", async () => {
    const before = await balance(ata(CASH, wallet));
    await moveFromMandate(owner, cashUnits(500));
    assert.strictEqual((await balance(ata(CASH, wallet))) - before, cashUnits(500));
  });

  const withdraw = (signer: Keypair, destination: PublicKey, amount: bigint) =>
    program.methods
      .withdraw(new BN(amount.toString()))
      .accountsStrict({
        wallet,
        signer: signer.publicKey,
        from: ata(CASH, wallet),
        destination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();

  it("lets the agent return money to the owner", async () => {
    const before = await balance(ata(CASH, owner.publicKey));
    await withdraw(agent, ata(CASH, owner.publicKey), cashUnits(1_000));
    assert.strictEqual((await balance(ata(CASH, owner.publicKey))) - before, cashUnits(1_000));
  });

  it("REFUSES a withdrawal anywhere but the owner", async () => {
    // What makes it safe to let the agent withdraw at all. A stolen agent key
    // can send the owner their own money and nothing else.
    await expectRefusal(
      withdraw(agent, ata(CASH, agent.publicKey), cashUnits(100)),
      "DestinationNotOwner",
    );
  });

  const withdrawFromMandate = (signer: Keypair, destination: PublicKey, amount: bigint) =>
    program.methods
      .withdrawFromMandate(new BN(amount.toString()))
      .accountsStrict({
        mandate,
        portfolio,
        signer: signer.publicKey,
        from: ata(CASH, portfolio),
        destination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();

  it("lets the agent send mandate money straight back to the owner", async () => {
    const before = await balance(ata(CASH, owner.publicKey));
    await withdrawFromMandate(agent, ata(CASH, owner.publicKey), cashUnits(500));
    assert.strictEqual((await balance(ata(CASH, owner.publicKey))) - before, cashUnits(500));
  });

  it("REFUSES mandate money sent anywhere but the owner", async () => {
    await expectRefusal(
      withdrawFromMandate(agent, ata(CASH, agent.publicKey), cashUnits(100)),
      "DestinationNotOwner",
    );
  });
});
