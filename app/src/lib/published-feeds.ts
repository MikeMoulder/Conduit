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
 * Crypto is the only class with a Pyth feed this project can actually read. The
 * equities have Pyth feed ids recorded in the registry and Pyth refuses to
 * serve them without a commercial grant, so a recorded id is not the same as an
 * available price. The pre IPO names have no feed anywhere.
 */
export function priceSourceFor(assetClass: string): PriceSource {
  return assetClass === "crypto" ? "pyth" : "published";
}
