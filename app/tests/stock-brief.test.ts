import { describe, it } from "node:test";
import { expect } from "chai";

import { dayStats, describeRange, plausibleLine } from "../src/lib/day-stats";
import { feedUrl, parseRss, pickHeadlines, termsFor, type Headline } from "../src/lib/news";

/**
 * Tests for the stock brief: the headlines a person is shown about an asset,
 * and the numbers describing its day.
 *
 * What is protected is that a brief says only what its sources said. A
 * headline must keep its source and date, must be about the company where
 * possible, and must not appear twice. A day must be measured from the same
 * points the market card draws, and a line that disagrees with the live price
 * must not be used at all.
 */

const NOW = Date.parse("2026-09-25T10:00:00Z");

const yahoo = `<?xml version="1.0"?><rss><channel>
<item><title>Nvidia Raised Its Dividend 2,400%, but a $10,000 Investment Still Pays Just $44 a Year</title>
<link>https://www.fool.com/investing/2026/09/25/nvidia-raised/</link>
<pubDate>Fri, 25 Sep 2026 08:24:00 +0000</pubDate></item>
<item><title>The eVTOL Trade Has Been Deflating for Months</title>
<link>https://www.fool.com/investing/2026/09/25/evtol/</link>
<pubDate>Fri, 25 Sep 2026 09:20:00 +0000</pubDate></item>
<item><title>Elon Musk Aims to Double Colossus 2&#8217;s Nvidia Chips by Year-End</title>
<link>https://finance.yahoo.com/technology/ai/articles/elon-musk</link>
<pubDate>Fri, 25 Sep 2026 06:04:47 +0000</pubDate></item>
<item><title>Nvidia Raised Its Dividend 2,400%, but a $10,000 Investment Still Pays Just $44 a Year</title>
<link>https://syndicated.example.com/copy</link>
<pubDate>Fri, 25 Sep 2026 08:30:00 +0000</pubDate></item>
<item><title>No date on this one</title><link>https://example.com/x</link></item>
<item><title>Old Nvidia story</title><link>https://example.com/old</link>
<pubDate>Mon, 14 Sep 2026 08:00:00 +0000</pubDate></item>
</channel></rss>`;

const google = `<rss><channel><item>
<title>SpaceX IPO&#39;d at $1.8 Trillion, Crashed 32% - Yahoo Finance</title>
<link>https://news.google.com/rss/articles/abc</link>
<pubDate>Mon, 21 Sep 2026 19:00:58 GMT</pubDate>
<source url="https://finance.yahoo.com">Yahoo Finance</source>
</item></channel></rss>`;

describe("reading a news feed", () => {
  it("keeps the title, link, date and source, newest first", () => {
    const all = parseRss(yahoo);
    expect(all[0].title).to.equal("The eVTOL Trade Has Been Deflating for Months");
    expect(all[0].source).to.equal("fool.com");
    expect(all.map((h) => h.publishedAt)).to.deep.equal([...all.map((h) => h.publishedAt)].sort((a, b) => b - a));
  });

  it("decodes entities in titles", () => {
    expect(parseRss(yahoo).some((h) => h.title === "Elon Musk Aims to Double Colossus 2’s Nvidia Chips by Year-End")).to.equal(true);
  });

  it("drops an item without a date rather than showing it undated", () => {
    expect(parseRss(yahoo).some((h) => h.title === "No date on this one")).to.equal(false);
  });

  it("takes the publisher from Google News and removes it from the title", () => {
    const [h] = parseRss(google);
    expect(h.source).to.equal("Yahoo Finance");
    expect(h.title).to.equal("SpaceX IPO'd at $1.8 Trillion, Crashed 32%");
  });
});

describe("choosing the headlines", () => {
  const picked = pickHeadlines(parseRss(yahoo), NOW, termsFor({ symbol: "NVDA", name: "NVIDIA" }));

  it("puts stories naming the company first", () => {
    expect(picked).to.have.length(3);
    expect(picked.slice(0, 2).every((h) => /nvidia/i.test(h.title))).to.equal(true);
    expect(picked[picked.length - 1].title).to.include("eVTOL");
  });

  it("shows a syndicated story once", () => {
    expect(picked.filter((h) => h.title.startsWith("Nvidia Raised Its Dividend"))).to.have.length(1);
  });

  it("leaves out stories older than three days", () => {
    expect(picked.some((h) => h.title === "Old Nvidia story")).to.equal(false);
  });

  it("stops at the limit", () => {
    const many: Headline[] = Array.from({ length: 12 }, (_, i) => ({
      title: `Nvidia story ${i}`,
      source: "x",
      url: `https://x/${i}`,
      publishedAt: NOW - i * 60_000,
    }));
    expect(pickHeadlines(many, NOW, ["nvidia"])).to.have.length(5);
  });
});

describe("where the headlines come from", () => {
  it("uses the ticker on Yahoo for an equity", () => {
    expect(feedUrl({ symbol: "NVDA", name: "NVIDIA", assetClass: "equity" })).to.include("s=NVDA");
  });

  it("uses the USD pair on Yahoo for crypto", () => {
    expect(feedUrl({ symbol: "BTC", name: "Bitcoin", assetClass: "crypto" })).to.include("s=BTC-USD");
  });

  it("searches Google News by name for a pre IPO company", () => {
    const url = feedUrl({ symbol: "SPACEX", name: "SpaceX", assetClass: "preipo" });
    expect(url).to.include("news.google.com");
    expect(decodeURIComponent(url)).to.include('"SpaceX"');
  });
});

describe("the day in numbers", () => {
  it("measures the change from the first point to the price", () => {
    const day = dayStats([100, 104, 98, 101], 102)!;
    expect(day.changePct).to.be.closeTo(2, 1e-9);
    expect(day.high).to.equal(104);
    expect(day.low).to.equal(98);
    expect(day.rangePosition).to.equal(67);
  });

  it("counts the live price in the range", () => {
    expect(dayStats([100, 101], 110)!.high).to.equal(110);
  });

  it("is not a day without two points and a price", () => {
    expect(dayStats([100], 101)).to.equal(null);
    expect(dayStats([100, 101], null)).to.equal(null);
  });

  it("says where in the range in words", () => {
    expect(describeRange(90)).to.equal("near the day's high");
    expect(describeRange(10)).to.equal("near the day's low");
    expect(describeRange(50)).to.equal("mid range for the day");
  });

  it("refuses a line that disagrees with the live price", () => {
    // SPY's line from a pool that priced it upside down.
    expect(plausibleLine([0.3345, 0.3314], 769.04)).to.equal(false);
    expect(plausibleLine([769.85, 773.63], 769.04)).to.equal(true);
    expect(plausibleLine([], 769.04)).to.equal(false);
  });
});
