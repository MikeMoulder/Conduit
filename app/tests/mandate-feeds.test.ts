import { describe, it } from "node:test";
import { expect } from "chai";

import { desk } from "../src/lib/holdings";
import { toAllowedAssets } from "../src/lib/mandate";
import { publishedFeedIdHex } from "../src/lib/published-feeds";

/**
 * Tests for the feed a new mandate binds each asset to.
 *
 * Written after every mandate created from the chat failed to settle with
 * PriceFeedMismatch: they recorded the registry's Pyth feed ids, while the
 * desk's price accounts carry the ids this project publishes under. `settle`
 * compares the two and refuses on any difference, so the autopilot proposed,
 * the program accepted the targets, and nothing was ever bought. What is
 * protected: a mandate made in the app binds exactly what the desk prices.
 */

const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");

describe("feeds a new mandate binds", () => {
  it("binds every stocked asset to its desk price account's feed", () => {
    for (const asset of desk.settleable) {
      const [arg] = toAllowedAssets([asset.symbol]);
      expect(arg.mint.toBase58(), asset.symbol).to.equal(asset.mint);
      expect(hex(arg.feedId), asset.symbol).to.equal(asset.feedId);
    }
  });

  it("binds the published feed for published assets, so settlement reads the publisher's account", () => {
    for (const asset of desk.settleable.filter((a) => a.source === "published")) {
      expect(hex(toAllowedAssets([asset.symbol])[0].feedId), asset.symbol).to.equal(publishedFeedIdHex(asset.symbol));
    }
  });

  it("keeps the order the person gave", () => {
    const symbols = ["TSLA", "AAPL", "OPENAI"];
    expect(toAllowedAssets(symbols).map((a) => desk.settleable.find((d) => d.mint === a.mint.toBase58())?.symbol)).to.deep.equal(symbols);
  });

  it("still refuses a symbol the registry does not know", () => {
    expect(() => toAllowedAssets(["NOPE"])).to.throw(/no registry entry/);
  });
});
