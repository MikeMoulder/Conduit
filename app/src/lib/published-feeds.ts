import { createHash } from "crypto";

/**
 * Feed identifiers for prices this project publishes itself.
 *
 * Deliberately a separate namespace from Pyth. A Pyth feed id means many
 * independent publishers observed a market and agreed on a number. One of these
 * means a single key asserted one. Reusing a Pyth id for the second would make
 * a settlement look Pyth priced when it is not, and the difference between
 * those two claims is the only thing that matters about this file.
 *
 * Derived rather than allocated, so the same symbol always produces the same
 * account and nothing has to be written down and kept in sync. The string is
 * versioned because a change to how these are derived would silently point at
 * different accounts, and that should be a visible break rather than a quiet
 * one.
 */

const NAMESPACE = "conduit.publisher.v1";

/** Which of the two price sources an asset is valued from. */
export type PriceSource = "pyth" | "published";

/**
 * The 32 byte feed id for a symbol this project prices.
 *
 * SHA-256 of a canonical string, truncated to nothing because the digest is
 * already exactly 32 bytes. Collisions between distinct symbols would mean two
 * instruments sharing a price account, which SHA-256 makes not worth worrying
 * about.
 */
export function publishedFeedId(symbol: string): Buffer {
  return createHash("sha256")
    .update(`${NAMESPACE}:${symbol.toUpperCase()}`)
    .digest();
}

export function publishedFeedIdHex(symbol: string): string {
  return publishedFeedId(symbol).toString("hex");
}

/**
 * Where a symbol's price comes from.
 *
 * Only crypto is a question. The equities have Pyth feed ids recorded in the
 * registry and Pyth refuses to serve them without a commercial grant, so a
 * recorded id is not an available price. The pre IPO names have no feed
 * anywhere. Both are published by this project or they do not settle.
 *
 * Crypto could go either way, and the default is not the one you would expect.
 * Pyth on Solana is a pull oracle: nothing is on chain until somebody pays to
 * put it there, and the devnet BTC, ETH and SOL accounts were being kept fresh
 * by a party unrelated to this project. Mid build they went from eight seconds
 * old to thirteen minutes, past the limit the program enforces, and every
 * crypto settlement began failing for reasons nothing here could fix.
 *
 * So the default is the source this project controls. Passing `preferPyth`
 * switches crypto back, which is worth doing whenever those accounts are being
 * maintained, because a Pyth price carries a genuinely stronger claim than one
 * of ours. The program reads both and has always read both. This only decides
 * which account the desk points at.
 */
export function priceSourceFor(
  assetClass: string,
  preferPyth = false,
): PriceSource {
  return assetClass === "crypto" && preferPyth ? "pyth" : "published";
}
