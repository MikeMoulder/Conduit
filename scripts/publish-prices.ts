/**
 * Writes prices on chain for everything no oracle will price.
 *
 * What this is
 * ------------
 * A price publisher. It reads the tokenized equities from Jupiter and the pre
 * IPO names from PreStocks, and writes each one into an account the program
 * reads when it settles.
 *
 * Why it has to exist
 * -------------------
 * The program refuses to value an asset it cannot price on chain, which is
 * correct and which left most of this universe unsettleable. Pyth serves crypto
 * and gates equities behind a commercial grant. Switchboard is shutting down.
 * RedStone carries the equities but reaches Solana by a path there is no time
 * to build.
 *
 * And for the pre IPO names no procurement would have helped. OPENAI and SPACEX
 * have no public market, so there is nothing for an oracle to observe. Their
 * tokens trade on PreStocks, and that traded price is what gets published.
 *
 * What it does not claim
 * ----------------------
 * This is weaker than an oracle network, and the weakness should be stated
 * plainly rather than dressed up. An oracle means many parties independently
 * agreed. This means one key asserted a number, and a settlement priced this
 * way is only as good as whoever holds that key.
 *
 * It does preserve the property the architecture rests on. This key is not the
 * agent key, the agent cannot reach the publish instruction, and a settlement
 * is valued from accounts the agent does not write. An agent able to choose its
 * own marks could satisfy any mandate while doing anything at all.
 *
 * Usage
 * -----
 *   npm run publish:prices              publish once and exit
 *   npm run publish:prices -- --watch   republish every four minutes
 *   npm run publish:prices -- --init    create the publisher account first
 *
 * The program refuses a price older than ten minutes, so --watch stays well
 * inside that. A price that fails to fetch is skipped rather than guessed at:
 * a stale account is refused by the program, which is the correct outcome, and
 * far better than publishing a number nobody stands behind.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import type { Conduit } from "../app/src/lib/idl/conduit";
import { publishedFeedId } from "../app/src/lib/published-feeds";

/** How far apart republished prices are, well inside the program's limit. */
const WATCH_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Pause between writes, because the public devnet RPC rate limits hard.
 *
 * Eighteen prices sent as fast as the client will send them earns a 429 partway
 * through, which leaves half the universe priced and half not. Slower and
 * complete beats fast and partial, and the whole round still finishes inside
 * the ten minute window the program allows.
 */
const PACE_MS = 2_500;

/** How many times a single price is retried before it is given up on. */
const ATTEMPTS = 3;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Exponent every published price uses.
 *
 * Fixed rather than derived from each source, because a price is a decimal
 * string from an HTTP response and choosing a scale per asset invites one to
 * differ. Eight decimals is far more precision than any of these instruments
 * quote and stays comfortably inside u64 for prices up to ninety billion.
 */
const EXPONENT = -8;

const REGISTRY = path.resolve(process.cwd(), "app/src/lib/registry.devnet.json");

const JUPITER = "https://lite-api.jup.ag/price/v3";
const PRESTOCKS = "https://prestocks.com/api/prestocks";
const COINBASE = "https://api.coinbase.com/v2/prices";

interface RegistryAsset {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  assetClass: string;
  mainnetMint?: string;
}

interface Quote {
  symbol: string;
  /** Whole dollars, as the source reported it. */
  price: number;
  source: string;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

/** Scales a decimal price to the fixed exponent, refusing anything unusable. */
function toFixedPoint(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`unusable price ${price}`);
  }
  const scaled = Math.round(price * 10 ** -EXPONENT);
  if (!Number.isSafeInteger(scaled)) {
    throw new Error(`price ${price} does not fit the fixed point scale`);
  }
  return BigInt(scaled);
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Prices the tokenized equities from Jupiter.
 *
 * Jupiter is asked about the mainnet mint because that is where the token
 * actually trades. The devnet mint in this registry is a stand in with no
 * liquidity, so asking about it would return nothing.
 *
 * `stockData.price` is the underlying share and `usdPrice` is the token. The
 * token is what a portfolio would hold, so the token is what is published.
 */
async function fromJupiter(assets: RegistryAsset[]): Promise<Quote[]> {
  const priced = assets.filter((a) => a.mainnetMint);
  if (priced.length === 0) return [];

  const ids = priced.map((a) => a.mainnetMint!).join(",");
  const response = await fetch(`${JUPITER}?ids=${ids}`);

  if (!response.ok) {
    console.error(`  jupiter responded http ${response.status}, skipping`);
    return [];
  }

  const body = (await response.json()) as Record<
    string,
    { usdPrice?: number } | undefined
  >;

  const quotes: Quote[] = [];
  for (const asset of priced) {
    const usd = body[asset.mainnetMint!]?.usdPrice;
    if (typeof usd !== "number") {
      console.error(`  ${asset.symbol.padEnd(10)} no price from jupiter`);
      continue;
    }
    quotes.push({ symbol: asset.symbol, price: usd, source: "jupiter" });
  }
  return quotes;
}

/**
 * Prices the pre IPO names from PreStocks.
 *
 * `tokenPrice`, the price the token trades for, rather than `markPrice`.
 *
 * This was the mark until the autopilot began trading the gap between the two.
 * Settlement is a fill: it is the price at which a portfolio buys or sells, and
 * a fill at the mark describes a trade nobody could make. With SpaceX's token 21%
 * below its mark, filling at the mark charged a buyer the price the strategy
 * exists to avoid paying, and with OpenAI's 31% above it, sold at a price no
 * buyer would pay. The mark is still what the strategy reads the token against,
 * from the same response, but it is a reference and not a price anyone deals at.
 *
 * The cost is noise: an illiquid token can move a long way on little volume,
 * so a portfolio valued this way moves more than one valued at the mark. That
 * is the honest version of the number.
 */
async function fromPreStocks(assets: RegistryAsset[]): Promise<Quote[]> {
  if (assets.length === 0) return [];

  const response = await fetch(PRESTOCKS);
  if (!response.ok) {
    console.error(`  prestocks responded http ${response.status}, skipping`);
    return [];
  }

  const body = (await response.json()) as {
    symbol?: string;
    tokenPrice?: number;
  }[];

  const bySymbol = new Map(
    body.filter((e) => e.symbol).map((e) => [e.symbol!.toUpperCase(), e]),
  );

  const quotes: Quote[] = [];
  for (const asset of assets) {
    const traded = bySymbol.get(asset.symbol.toUpperCase())?.tokenPrice;
    if (typeof traded !== "number" || !Number.isFinite(traded) || traded <= 0) {
      console.error(`  ${asset.symbol.padEnd(10)} no token price from prestocks`);
      continue;
    }
    quotes.push({ symbol: asset.symbol, price: traded, source: "prestocks" });
  }
  return quotes;
}

/**
 * Prices the crypto sleeve by symbol.
 *
 * Jupiter cannot help here. Its price API is keyed by mint and these three have
 * no mainnet mint recorded, because unlike the equities they are not wrappers
 * around something trading elsewhere: the devnet mints stand in for BTC, ETH
 * and SOL themselves.
 *
 * Coinbase because it needs no key, quotes the spot pairs directly, and is a
 * venue rather than an aggregator, so the number means something specific.
 * These exist as a fallback for when the devnet Pyth accounts are not being
 * maintained by whoever has been maintaining them, which is most of the time.
 */
async function fromCoinbase(assets: RegistryAsset[]): Promise<Quote[]> {
  const quotes: Quote[] = [];

  for (const asset of assets) {
    try {
      const response = await fetch(`${COINBASE}/${asset.symbol}-USD/spot`);
      if (!response.ok) {
        console.error(
          `  ${asset.symbol.padEnd(10)} coinbase responded http ${response.status}`,
        );
        continue;
      }

      const body = (await response.json()) as { data?: { amount?: string } };
      const amount = Number(body.data?.amount);

      if (!Number.isFinite(amount)) {
        console.error(`  ${asset.symbol.padEnd(10)} no price from coinbase`);
        continue;
      }

      quotes.push({ symbol: asset.symbol, price: amount, source: "coinbase" });
    } catch (error) {
      console.error(
        `  ${asset.symbol.padEnd(10)} coinbase failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  return quotes;
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const base = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(base.connection, base.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "target/idl/conduit.json"), "utf8"),
  ) as Conduit;
  const program = new Program<Conduit>(idl, provider);

  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8")) as {
    assets: RegistryAsset[];
  };

  // Everything Jupiter can quote by mint, which is the equities and, now, the
  // crypto sleeve as well. Crypto is included because the devnet Pyth accounts
  // are maintained by somebody else and went stale mid build, taking every
  // crypto settlement with them. Publishing them costs little and removes a
  // dependency on a stranger's uptime.
  const equities = registry.assets.filter((a) => a.assetClass === "equity");
  const preipo = registry.assets.filter((a) => a.assetClass === "preipo");
  const crypto = registry.assets.filter((a) => a.assetClass === "crypto");

  const [publisher] = PublicKey.findProgramAddressSync(
    [Buffer.from("publisher")],
    program.programId,
  );

  const authority = provider.wallet.publicKey;

  if (has("--init")) {
    const existing = await provider.connection.getAccountInfo(publisher);
    if (existing) {
      console.log(`publisher exists ${publisher.toBase58()}`);
    } else {
      await program.methods
        .initializePublisher()
        .accountsStrict({
          publisher,
          authority,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`publisher created ${publisher.toBase58()}`);
    }
  }

  const account = await program.account.publisher.fetchNullable(publisher);
  if (!account) {
    console.error(
      `no publisher account at ${publisher.toBase58()}. Run once with --init.`,
    );
    process.exit(1);
  }

  if (!account.authority.equals(authority)) {
    console.error(
      `this wallet is not the publishing authority.\n` +
        `  authority ${account.authority.toBase58()}\n` +
        `  wallet    ${authority.toBase58()}`,
    );
    process.exit(1);
  }

  async function round(): Promise<void> {
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(`\n[${stamp}] fetching`);

    const [jup, pre, cb] = await Promise.all([
      fromJupiter(equities),
      fromPreStocks(preipo),
      fromCoinbase(crypto),
    ]);
    const quotes = [...jup, ...pre, ...cb];

    if (quotes.length === 0) {
      console.error("  nothing to publish this round");
      return;
    }

    // One transaction per price. They could be batched, but a batch fails
    // whole: one source glitching would stop every other price from being
    // written, and a price that lands is worth more than a tidy transaction.
    let written = 0;
    for (const quote of quotes) {
      const feedId = publishedFeedId(quote.symbol);
      const [priceAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("price"), feedId],
        program.programId,
      );

      // Retried rather than abandoned. The public devnet RPC returns 429 under
      // no particular load, and a price that fails to land leaves the program
      // valuing that asset on a stale account, which it will refuse. Giving a
      // transient limit three chances costs seconds and saves the round.
      let landed = false;

      for (let attempt = 1; attempt <= ATTEMPTS && !landed; attempt += 1) {
        try {
          const value = toFixedPoint(quote.price);

          await program.methods
            .publishPrice(
              Array.from(feedId),
              new BN(value.toString()),
              EXPONENT,
              new BN(Math.floor(Date.now() / 1000)),
              quote.source,
            )
            .accountsStrict({
              publisher,
              price: priceAccount,
              authority,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          console.log(
            `  ${quote.symbol.padEnd(10)} ${quote.price.toFixed(4).padStart(12)}  ${quote.source.padEnd(9)} ${priceAccount.toBase58()}`,
          );
          written += 1;
          landed = true;
        } catch (error) {
          const detail =
            error instanceof Error
              ? error.message.split("\n")[0]
              : String(error);

          if (attempt === ATTEMPTS) {
            console.error(`  ${quote.symbol.padEnd(10)} FAILED  ${detail}`);
          } else {
            await pause(PACE_MS * attempt * 2);
          }
        }
      }

      await pause(PACE_MS);
    }

    console.log(`  ${written} of ${quotes.length} published`);
  }

  await round();

  if (has("--watch")) {
    console.log(
      `\nwatching, republishing every ${WATCH_INTERVAL_MS / 60000} minutes`,
    );
    setInterval(() => {
      void round().catch((e) => console.error("round failed:", e));
    }, WATCH_INTERVAL_MS);
  }
}

// The RPC client rejects from its own websocket and retry paths, outside any
// await this code owns. Without this a single 429 from the public endpoint
// takes down a watch loop that was otherwise healthy.
process.on("unhandledRejection", (reason) => {
  console.error(
    "  ignored background rejection:",
    reason instanceof Error ? reason.message.split("\n")[0] : reason,
  );
});

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
