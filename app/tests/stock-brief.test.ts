import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "chai";

import { dayStats, describeRange, plausibleLine } from "../src/lib/day-stats";
import {
  feedUrl,
  fetchHeadlines,
  namesAny,
  parseFinnhub,
  parseRss,
  pickHeadlines,
  termsFor,
  type Headline,
} from "../src/lib/news";

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

const finnhub = [
  {
    headline: "Can Plug Power's NZ Electrolyzer Win Offset Questions",
    source: "Yahoo",
    url: "https://finnhub.io/api/news?id=1",
    datetime: Math.floor(NOW / 1000) - 3_600,
    summary: "Plug Power won a contract in New Zealand.",
  },
  {
    headline: "Chip stocks climb into the weekend",
    source: "SeekingAlpha",
    url: "https://finnhub.io/api/news?id=2",
    datetime: Math.floor(NOW / 1000) - 7_200,
    summary: "Nvidia led the semiconductor index higher after   Musk said Colossus 2 would double its chip count.",
  },
  {
    headline: "Nvidia raises its dividend",
    source: "Yahoo",
    url: "https://finnhub.io/api/news?id=3",
    datetime: Math.floor(NOW / 1000) - 10_800,
    summary: "x".repeat(400),
  },
  { headline: "", url: "https://finnhub.io/api/news?id=4", datetime: 1 },
  { headline: "No time", url: "https://finnhub.io/api/news?id=5" },
];

describe("reading Finnhub company news", () => {
  it("keeps headline, source, link, time and summary, newest first", () => {
    const all = parseFinnhub(finnhub);
    expect(all).to.have.length(3);
    expect(all[0].title).to.include("Plug Power");
    expect(all[1].summary).to.equal(
      "Nvidia led the semiconductor index higher after Musk said Colossus 2 would double its chip count.",
    );
  });

  it("trims a long summary", () => {
    expect(parseFinnhub(finnhub)[2].summary).to.have.length(320);
  });

  it("returns nothing for an error body rather than throwing", () => {
    expect(parseFinnhub({ error: "API limit reached" })).to.deep.equal([]);
  });

  it("ranks named in the title, then named in the summary, then the rest", () => {
    const picked = pickHeadlines(parseFinnhub(finnhub), NOW, termsFor({ symbol: "NVDA", name: "NVIDIA" }));
    expect(picked.map((h) => h.title)).to.deep.equal([
      "Nvidia raises its dividend",
      "Chip stocks climb into the weekend",
      "Can Plug Power's NZ Electrolyzer Win Offset Questions",
    ]);
  });

  it("matches a name with punctuation, and only whole words", () => {
    const spy = termsFor({ symbol: "SPY", name: "S&P 500 ETF" });
    expect(namesAny([{ title: "S&P 500 hits a record", source: "x", url: "u", publishedAt: NOW }], spy)).to.equal(true);
    const apple = termsFor({ symbol: "AAPL", name: "Apple" });
    expect(namesAny([{ title: "Pineapple prices soar", source: "x", url: "u", publishedAt: NOW }], apple)).to.equal(false);
  });
});

describe("choosing a news source", () => {
  const realFetch = globalThis.fetch;
  let calls: { url: string; headers: Record<string, string> }[];
  let finnhubBody: unknown;

  beforeEach(() => {
    calls = [];
    finnhubBody = finnhub;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes("finnhub.io")) return new Response(JSON.stringify(finnhubBody), { status: 200 });
      return new Response(yahoo, { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.FINNHUB_API_KEY;
  });

  // A different symbol per test: results are cached by symbol.
  it("uses Finnhub for a stock when there is a key, with the key in a header", async () => {
    process.env.FINNHUB_API_KEY = "test-key-not-real";
    const { provider, headlines } = await fetchHeadlines({ symbol: "NVDA", name: "NVIDIA", assetClass: "equity" });
    expect(provider).to.equal("finnhub");
    expect(headlines[0].summary).to.be.a("string");
    expect(calls[0].headers["X-Finnhub-Token"]).to.equal("test-key-not-real");
    expect(calls.every((c) => !c.url.includes("test-key-not-real"))).to.equal(true);
  });

  it("falls back to Yahoo without a key", async () => {
    const { provider } = await fetchHeadlines({ symbol: "MSFT", name: "Microsoft", assetClass: "equity" });
    expect(provider).to.equal("yahoo finance");
    expect(calls.some((c) => c.url.includes("finnhub"))).to.equal(false);
  });

  it("falls back to Yahoo when nothing from Finnhub names the company", async () => {
    process.env.FINNHUB_API_KEY = "test-key-not-real";
    const { provider } = await fetchHeadlines({ symbol: "GOOGL", name: "Alphabet", assetClass: "equity" });
    expect(provider).to.equal("yahoo finance");
  });

  it("falls back to Yahoo when Finnhub answers with an error", async () => {
    process.env.FINNHUB_API_KEY = "test-key-not-real";
    finnhubBody = { error: "API limit reached" };
    const { provider } = await fetchHeadlines({ symbol: "TSLA", name: "Tesla", assetClass: "equity" });
    expect(provider).to.equal("yahoo finance");
  });

  it("never asks Finnhub about a pre IPO company or a coin", async () => {
    process.env.FINNHUB_API_KEY = "test-key-not-real";
    expect((await fetchHeadlines({ symbol: "SPACEX", name: "SpaceX", assetClass: "preipo" })).provider).to.equal("google news");
    expect((await fetchHeadlines({ symbol: "BTC", name: "Bitcoin", assetClass: "crypto" })).provider).to.equal("yahoo finance");
    expect(calls.some((c) => c.url.includes("finnhub"))).to.equal(false);
  });
});
