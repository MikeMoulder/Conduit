/**
 * Collects a logo for every asset in the registry and stores it locally.
 *
 * Why local rather than hotlinked
 * ------------------------------
 * The issuers all publish a logo and all of them would serve it directly, which
 * would mean eighteen external requests on the first render, from three
 * different hosts, any of which can rate limit, block a referrer or simply be
 * slow. None of that is worth risking during a demo for a decorative asset that
 * changes about once a year.
 *
 * Downloading them also makes the interface work with no network at all, which
 * is a property worth having when the venue wifi is the venue wifi.
 *
 * Where they come from
 * --------------------
 *   equities and crypto   Jupiter's token list, which carries the issuer logo
 *   pre IPO               the PreStocks API, which returns its own image field
 *
 * Usage
 * -----
 *   npm run logos
 *
 * Idempotent. An asset that already has a file is skipped unless --force is
 * passed, so this is safe to run to pick up a newly added asset.
 */

import fs from "node:fs";
import path from "node:path";

const REGISTRY = path.resolve(process.cwd(), "src/lib/registry.devnet.json");
const OUT_DIR = path.resolve(process.cwd(), "public/assets");
const force = process.argv.includes("--force");

async function jupiterIcon(asset) {
  const query = asset.mainnetMint ?? asset.symbol;
  const response = await fetch(
    `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(query)}`,
  );
  if (!response.ok) return null;

  const list = await response.json();
  if (!Array.isArray(list)) return null;

  const hit = asset.mainnetMint
    ? list.find((t) => t.id === asset.mainnetMint)
    : list.find((t) => (t.symbol || "").toUpperCase() === asset.symbol);

  return hit?.icon ?? null;
}

async function preStocksIcons() {
  const response = await fetch("https://prestocks.com/api/prestocks");
  if (!response.ok) return new Map();

  const body = await response.json();
  const icons = new Map();
  for (const record of Array.isArray(body) ? body : []) {
    if (record?.symbol && record?.image) {
      icons.set(String(record.symbol).toUpperCase(), String(record.image));
    }
  }
  return icons;
}

/** Extension from the URL, defaulting to png, which every source here uses. */
function extensionOf(url) {
  const clean = url.split("?")[0];
  const ext = path.extname(clean).toLowerCase();
  return [".png", ".svg", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`http ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error("empty body");
  fs.writeFileSync(destination, buffer);
  return buffer.length;
}

async function main() {
  if (!fs.existsSync(REGISTRY)) {
    console.error("Run this from the app directory: npm run logos");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  const preStocks = await preStocksIcons();

  let written = 0;
  let skipped = 0;
  const missing = [];

  for (const asset of registry.assets) {
    const url =
      asset.priceSource === "prestocks"
        ? preStocks.get(asset.symbol)
        : await jupiterIcon(asset);

    if (!url) {
      missing.push(asset.symbol);
      console.log(`${asset.symbol.padEnd(11)} no logo published`);
      continue;
    }

    const file = `${asset.symbol.toLowerCase()}${extensionOf(url)}`;
    const destination = path.join(OUT_DIR, file);
    const logo = `/assets/${file}`;

    if (fs.existsSync(destination) && !force) {
      asset.logo = logo;
      skipped += 1;
      console.log(`${asset.symbol.padEnd(11)} already present`);
      continue;
    }

    try {
      const bytes = await download(url, destination);
      asset.logo = logo;
      written += 1;
      console.log(`${asset.symbol.padEnd(11)} ${String(bytes).padStart(7)} bytes  ${file}`);
    } catch (error) {
      missing.push(asset.symbol);
      console.log(`${asset.symbol.padEnd(11)} failed: ${String(error.message).slice(0, 50)}`);
    }
  }

  fs.writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`);

  console.log("");
  console.log(`${written} downloaded, ${skipped} already present`);
  if (missing.length > 0) {
    // Named rather than counted. An asset with no logo renders a lettered tile,
    // which is fine, but it should be a known gap rather than a surprise.
    console.log(`no logo for: ${missing.join(", ")}`);
  }
}

main();
