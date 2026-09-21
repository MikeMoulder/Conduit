/**
 * Issues the devnet SPL mints for the STOCKPILOT asset registry.
 *
 * Why this exists
 * ---------------
 * A tokenized equity is an SPL mint issued by a regulated party: Backed issues
 * the xStock series (AAPLX), Ondo issues its own (AAPLON). Those mints exist on
 * mainnet only. No issuer publishes a devnet counterpart, so on devnet there is
 * nothing to hold.
 *
 * This script issues the devnet entries of the registry. They are ordinary SPL
 * mints with real supply, real token accounts and real transfers, created by the
 * same instructions any issuer uses. The only thing that differs from mainnet is
 * who signed the mint authority.
 *
 * That difference is confined to this file and the registry it writes. The
 * program stores a mint address and a Pyth feed id per permitted asset and has
 * no opinion about provenance, so pointing the system at mainnet is a registry
 * swap rather than a code change.
 *
 * Prices are never invented here. Valuation reads the Pyth feeds recorded
 * alongside each mint, which carry the real instrument's price.
 *
 * Usage
 * -----
 *   npx ts-node scripts/create-devnet-assets.ts [--force]
 *
 * Idempotent by default: if the registry already names a live mint for an asset,
 * that asset is left alone. Pass --force to issue fresh mints for everything.
 */

import * as fs from "fs";
import * as path from "path";

import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { createMint, getMint } from "@solana/spl-token";

/** One instrument in the registry. */
interface RegisteredAsset {
  symbol: string;
  name: string;
  /** SPL mint address on this cluster. */
  mint: string;
  /**
   * Token decimals. On devnet this is set by us. When the registry points at a
   * mainnet issuer mint, it carries that issuer's actual value instead.
   */
  decimals: number;
  /** Who issued the mint on this cluster. */
  issuer: string;
  /** Broad class, used for grouping and for risk treatment. */
  assetClass: "equity" | "crypto";
  feeds: {
    /**
     * The feed that prices what is actually held.
     *
     * For a tokenized equity this is the token's own feed, not the listed
     * share's, because the token is the thing in the portfolio and it does not
     * always trade at parity.
     */
    primary: string;
    /**
     * The underlying listed instrument, where one exists.
     *
     * Only tokenized equities have this. Its purpose is the spread against
     * `primary`, which is a tradable signal and a liquidity warning. Crypto has
     * no underlying listing, so the field is absent rather than duplicated.
     */
    reference?: string;
    /** A second tokenized representation where one exists, the Ondo series. */
    alternate?: string;
  };
}

interface Registry {
  cluster: string;
  generatedAt: string;
  mintAuthority: string;
  assets: RegisteredAsset[];
}

/**
 * The instrument universe.
 *
 * Every feed id below was read from the Pyth Hermes metadata endpoint rather
 * than transcribed from documentation, because a wrong feed id silently prices
 * the wrong instrument instead of failing loudly.
 *
 * Crypto entries sit alongside the equities deliberately. A portfolio that can
 * only hold one asset class cannot diversify, and Pyth's brief explicitly invites
 * combining equities with other asset classes. They also serve a practical
 * purpose: crypto feeds are entitled on every tier, so the price pipeline stays
 * demonstrably live even while equity entitlements are pending.
 */
const UNIVERSE: Omit<RegisteredAsset, "mint" | "issuer">[] = [
  {
    symbol: "AAPL",
    name: "Apple",
    assetClass: "equity",
    decimals: 8,
    feeds: {
      primary: "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675",
      reference: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
      alternate: "e6734de88a83d9d2fb33072adab319004700aefd069653aba30ba9e3cac056f2",
    },
  },
  {
    symbol: "NVDA",
    name: "NVIDIA",
    assetClass: "equity",
    decimals: 8,
    feeds: {
      primary: "4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f",
      reference: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
      alternate: "207ddea2a443d30b7e13a7c88a9e3f106765deb97049afc65a18cede50fffc82",
    },
  },
  {
    symbol: "MSFT",
    name: "Microsoft",
    assetClass: "equity",
    decimals: 8,
    feeds: {
      primary: "bb723a70af731ab56b9a650eb7e8ac22b7bc07ea77f8670bd1fa9a37bf6df3f5",
      reference: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
      alternate: "29b228e9fd72bbd306bcca3b10c165d8dba5d535ef8d5aab6c6e4bc18912d150",
    },
  },
  {
    symbol: "TSLA",
    name: "Tesla",
    assetClass: "equity",
    decimals: 8,
    feeds: {
      primary: "47a156470288850a440df3a6ce85a55917b813a19bb5b31128a33a986566a362",
      reference: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
      alternate: "c09ef687ed07091c047da444f1499f2da52cdc1c085104643ec565a9eb1af514",
    },
  },
  {
    symbol: "GOOGL",
    name: "Alphabet",
    assetClass: "equity",
    decimals: 8,
    feeds: {
      primary: "b911b0329028cd0283e4259c33809d62942bd2716a58084e5f31d64c00b5424e",
      reference: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
      alternate: "ad79b3487bef87ff8f8ab31c0b779ad08d931fdfa5436f7e92a234bb82bff7e4",
    },
  },
  {
    symbol: "AMZN",
    name: "Amazon",
    assetClass: "equity",
    decimals: 8,
    feeds: {
      primary: "7148fbe6e493ff2580305c92a8d7f8628c9943b11b9b253aebc24863fec290e8",
      reference: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
    },
  },
  {
    symbol: "SPY",
    name: "S&P 500 ETF",
    assetClass: "equity",
    decimals: 8,
    feeds: {
      primary: "2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14",
      reference: "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5",
    },
  },
  {
    symbol: "BTC",
    name: "Bitcoin",
    assetClass: "crypto",
    decimals: 8,
    feeds: {
      primary: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    },
  },
  {
    symbol: "ETH",
    name: "Ether",
    assetClass: "crypto",
    decimals: 8,
    feeds: {
      primary: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    },
  },
  {
    symbol: "SOL",
    name: "Solana",
    assetClass: "crypto",
    decimals: 8,
    feeds: {
      primary: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    },
  },
];

const REGISTRY_PATH = path.resolve(
  process.cwd(),
  "app",
  "src",
  "lib",
  "registry.devnet.json",
);

function loadWallet(): Keypair {
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(process.env.HOME ?? "", ".config", "solana", "id.json");

  const secret = JSON.parse(fs.readFileSync(walletPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function loadExistingRegistry(): Registry | null {
  if (!fs.existsSync(REGISTRY_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as Registry;
  } catch {
    return null;
  }
}

/** True when the address is a mint account this cluster actually knows about. */
async function mintExists(
  connection: Connection,
  address: string,
): Promise<boolean> {
  try {
    await getMint(connection, new PublicKey(address));
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const rpc = process.env.ANCHOR_PROVIDER_URL ?? clusterApiUrl("devnet");
  const connection = new Connection(rpc, "confirmed");
  const payer = loadWallet();

  // RPC URLs commonly carry an API key in the query string, so only the origin
  // is logged. A build log is not a safe place for a credential.
  const rpcOrigin = (() => {
    try {
      return new URL(rpc).origin;
    } catch {
      return "unparseable rpc url";
    }
  })();

  console.log(`cluster   : ${rpcOrigin}`);
  console.log(`authority : ${payer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`balance   : ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.1e9) {
    throw new Error("wallet holds under 0.1 SOL, which will not cover mint rent");
  }

  const existing = loadExistingRegistry();
  const bySymbol = new Map<string, RegisteredAsset>(
    existing?.assets.map((a) => [a.symbol, a]) ?? [],
  );

  const assets: RegisteredAsset[] = [];

  for (const spec of UNIVERSE) {
    const prior = bySymbol.get(spec.symbol);

    if (!force && prior && (await mintExists(connection, prior.mint))) {
      console.log(`${spec.symbol.padEnd(6)} reusing ${prior.mint}`);
      // Only the mint address is carried forward. Everything else comes from
      // the spec above, so corrections to feed ids, decimals or classification
      // take effect on the next run instead of being pinned to whatever shape
      // the registry happened to have when the mint was first issued.
      assets.push({ ...spec, mint: prior.mint, issuer: prior.issuer });
      continue;
    }

    const mint = await createMint(
      connection,
      payer,
      payer.publicKey, // mint authority
      payer.publicKey, // freeze authority
      spec.decimals,
    );

    console.log(`${spec.symbol.padEnd(6)} issued  ${mint.toBase58()}`);

    assets.push({
      ...spec,
      mint: mint.toBase58(),
      issuer: "stockpilot-devnet",
    });
  }

  const registry: Registry = {
    cluster: "devnet",
    generatedAt: new Date().toISOString(),
    mintAuthority: payer.publicKey.toBase58(),
    assets,
  };

  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);

  console.log(`\nregistry written: ${REGISTRY_PATH}`);
  console.log(`assets: ${assets.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
