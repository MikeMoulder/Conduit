/**
 * Recent headlines for an asset, so the copilot can say why it moved.
 *
 * Headlines, not analysis. The copilot is told to treat them as what was
 * reported and to name the source, never to present a headline's claim as a
 * fact it checked. That is the only honest use of a news feed nobody here
 * verified.
 *
 * Three sources, each used where it is best:
 *
 *   stocks    Finnhub company news, by ticker, with a summary of each
 *             article. A licensed API with a free key, and the summaries are
 *             what let the copilot say why a stock moved rather than guess
 *             from a headline. Falls back to Yahoo when there is no key, the
 *             call fails, or nothing it returns names the company.
 *   crypto    Yahoo Finance headlines, by the USD pair. Finnhub only has
 *             general crypto news, not per coin.
 *   pre IPO   Google News, searched by company name. Private companies have
 *             no ticker anywhere a news API keys by.
 *
 * Gemini's own web search would have been the obvious choice and is refused
 * on this key's quota. The RSS parser is plain string work, small and stable
 * enough that a dependency would be more code than it saves.
 */

export interface Headline {
  title: string;
  source: string;
  url: string;
  /** Milliseconds since the epoch. */
  publishedAt: number;
  /** A few sentences from the article, where the source gives them. */
  summary?: string;
}

export type NewsProvider = "finnhub" | "yahoo finance" | "google news";

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

  const names = namer(terms);

  // Named in the title first, then named only in the summary, then the rest.
  const inTitle = recent.filter((h) => names(h.title));
  const inSummary = recent.filter((h) => !names(h.title) && names(h.summary));
  const rest = recent.filter((h) => !names(h.title) && !names(h.summary));
  return [...inTitle, ...inSummary, ...rest].slice(0, limit);
}

/** Whether any of these headlines names the asset at all. */
export function namesAny(headlines: Headline[], terms: string[]): boolean {
  const names = namer(terms);
  return headlines.some((h) => names(`${h.title} ${h.summary ?? ""}`));
}

/**
 * A test for whether a text names any of these terms, as whole words.
 *
 * Punctuation reads as a space on both sides, so "S&P" in a term matches
 * "S&P 500" in a title, and "Apple" does not match "Pineapple".
 */
function namer(terms: string[]): (text: string | undefined) => boolean {
  const norm = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const words = terms.map(norm).filter((w) => w.trim().length >= 2);
  return (text) => Boolean(text) && words.some((w) => norm(text!).includes(w));
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

/** Finnhub's company news, as returned. Mapped rather than trusted. */
interface FinnhubArticle {
  headline?: unknown;
  source?: unknown;
  url?: unknown;
  datetime?: unknown;
  summary?: unknown;
}

/**
 * Converts Finnhub's response into headlines, newest first.
 *
 * An article without a headline, a link or a time is dropped. Summaries are
 * trimmed: they go into the model's context, and a few sentences is what a
 * brief needs.
 */
export function parseFinnhub(body: unknown): Headline[] {
  if (!Array.isArray(body)) return [];
  const headlines: Headline[] = [];
  for (const raw of body as FinnhubArticle[]) {
    const title = typeof raw.headline === "string" ? raw.headline.trim() : "";
    const url = typeof raw.url === "string" ? raw.url : "";
    const seconds = typeof raw.datetime === "number" ? raw.datetime : NaN;
    if (!title || !url || !Number.isFinite(seconds)) continue;
    const summary = typeof raw.summary === "string" ? raw.summary.replace(/\s+/g, " ").trim() : "";
    headlines.push({
      title,
      url,
      source: typeof raw.source === "string" && raw.source ? raw.source : hostOf(url),
      publishedAt: seconds * 1000,
      ...(summary ? { summary: summary.length > 320 ? `${summary.slice(0, 317)}...` : summary } : {}),
    });
  }
  return headlines.sort((a, b) => b.publishedAt - a.publishedAt);
}

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { headlines: Headline[]; provider: NewsProvider; at: number }>();

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    cache: "no-store",
    headers: { "user-agent": "Mozilla/5.0 (Conduit news reader)", ...headers },
    signal: AbortSignal.timeout(8_000),
  });
}

async function fromFinnhub(symbol: string, key: string, now: number): Promise<Headline[]> {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${day(now - 3 * 86_400_000)}&to=${day(now)}`;
  // The key goes in a header, not the URL, so it never lands in a log line.
  const response = await get(url, { "X-Finnhub-Token": key });
  if (!response.ok) return [];
  return parseFinnhub(await response.json());
}

async function fromFeed(asset: { symbol: string; name: string; assetClass: string }): Promise<Headline[]> {
  const response = await get(feedUrl(asset));
  if (!response.ok) return [];
  return parseRss(await response.text());
}

/**
 * The latest headlines about an asset, and where they came from.
 *
 * Never throws: no headlines is an answer the copilot can give plainly.
 */
export async function fetchHeadlines(asset: {
  symbol: string;
  name: string;
  assetClass: string;
}): Promise<{ headlines: Headline[]; provider: NewsProvider }> {
  const fallback: NewsProvider = asset.assetClass === "preipo" ? "google news" : "yahoo finance";
  const hit = cache.get(asset.symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return { headlines: hit.headlines, provider: hit.provider };

  const now = Date.now();
  const terms = termsFor(asset);
  const key = process.env.FINNHUB_API_KEY?.trim();

  try {
    if (asset.assetClass === "equity" && key) {
      const all = await fromFinnhub(asset.symbol, key, now).catch(() => []);
      const picked = pickHeadlines(all, now, terms);
      // Only kept if something in it is about the company. A ticker's feed
      // that names it nowhere is worse than Yahoo's.
      if (picked.length > 0 && namesAny(picked, terms)) {
        cache.set(asset.symbol, { headlines: picked, provider: "finnhub", at: now });
        return { headlines: picked, provider: "finnhub" };
      }
    }

    const headlines = pickHeadlines(await fromFeed(asset), now, terms);
    cache.set(asset.symbol, { headlines, provider: fallback, at: now });
    return { headlines, provider: fallback };
  } catch {
    return hit ? { headlines: hit.headlines, provider: hit.provider } : { headlines: [], provider: fallback };
  }
}
