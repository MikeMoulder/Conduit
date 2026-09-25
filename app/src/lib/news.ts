/**
 * Recent headlines for an asset, so the copilot can say why it moved.
 *
 * Headlines, not analysis. The copilot is told to treat them as what was
 * reported and to name the source, never to present a headline's claim as a
 * fact it checked. That is the only honest use of a news feed nobody here
 * verified.
 *
 * Two free feeds, neither needing a key. Yahoo Finance for anything with a
 * listed ticker, keyed by the ticker, which keeps the stories about the
 * stock. Google News for the pre IPO names, which have no ticker there,
 * searched by company name. Gemini's own web search would have been the
 * obvious choice and is refused on this key's quota.
 *
 * The parser is plain string work over RSS, which is small and stable enough
 * that a dependency would be more code than it saves.
 */

export interface Headline {
  title: string;
  source: string;
  url: string;
  /** Milliseconds since the epoch. */
  publishedAt: number;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decode(text: string): string {
  return text
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

function tag(item: string, name: string): string | null {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return match ? decode(match[1]) : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/**
 * Parses an RSS feed into headlines, newest first.
 *
 * Google News appends " - Publisher" to every title and names the publisher
 * in a source tag; that suffix is removed so a title reads as written. Items
 * without a title, a link or a readable date are dropped rather than shown
 * undated, because "when" is half of what makes a headline useful here.
 */
export function parseRss(xml: string): Headline[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const headlines: Headline[] = [];

  for (const item of items) {
    const rawTitle = tag(item, "title");
    const url = tag(item, "link");
    const date = tag(item, "pubDate");
    const publishedAt = date ? Date.parse(date) : NaN;
    if (!rawTitle || !url || !Number.isFinite(publishedAt)) continue;

    const source = tag(item, "source") ?? hostOf(url);
    const title = rawTitle.endsWith(` - ${source}`) ? rawTitle.slice(0, -(source.length + 3)) : rawTitle;
    headlines.push({ title, source, url, publishedAt });
  }

  return headlines.sort((a, b) => b.publishedAt - a.publishedAt);
}

/**
 * The few most recent headlines from the window, one per title, the ones that
 * name the company first.
 *
 * Syndicated stories arrive several times under the same title; keeping the
 * first of each leaves room for different stories. And a ticker's feed also
 * carries stories that only mention it in passing, an article about dividend
 * stocks in Nvidia's, so stories naming the company lead and the rest only
 * fill the space left.
 */
export function pickHeadlines(
  all: Headline[],
  now: number,
  terms: string[] = [],
  limit = 5,
  windowMs = 3 * 86_400_000,
): Headline[] {
  const seen = new Set<string>();
  const recent: Headline[] = [];
  for (const h of all) {
    if (now - h.publishedAt > windowMs || h.publishedAt - now > 3_600_000) continue;
    const key = h.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push(h);
  }

  const words = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
  const names = (h: Headline) => {
    const title = ` ${h.title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    return words.some((w) => title.includes(` ${w} `));
  };
  return [...recent.filter(names), ...recent.filter((h) => !names(h))].slice(0, limit);
}

/** What a headline has to mention to be about this asset. */
export function termsFor(asset: { symbol: string; name: string }): string[] {
  const first = asset.name.split(/[\s.,]+/)[0];
  return [asset.symbol, first, asset.name].filter(Boolean);
}

export function feedUrl(asset: { symbol: string; name: string; assetClass: string }): string {
  if (asset.assetClass === "preipo") {
    const q = encodeURIComponent(`"${asset.name}" when:7d`);
    return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  }
  const ticker = asset.assetClass === "crypto" ? `${asset.symbol}-USD` : asset.symbol;
  return `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
}

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { headlines: Headline[]; at: number }>();

/** Never throws: no headlines is an answer the copilot can give plainly. */
export async function fetchHeadlines(asset: { symbol: string; name: string; assetClass: string }): Promise<Headline[]> {
  const hit = cache.get(asset.symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.headlines;

  try {
    const response = await fetch(feedUrl(asset), {
      cache: "no-store",
      headers: { "user-agent": "Mozilla/5.0 (Conduit news reader)" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return hit?.headlines ?? [];
    const headlines = pickHeadlines(parseRss(await response.text()), Date.now(), termsFor(asset));
    cache.set(asset.symbol, { headlines, at: Date.now() });
    return headlines;
  } catch {
    return hit?.headlines ?? [];
  }
}
