/**
 * Creates the keypair the agent signs proposals with.
 *
 * Why this exists
 * ---------------
 * The agent is a separate actor, not a role the owner plays. A mandate records
 * an agent address, and `propose_rebalance` requires that exact key to sign.
 * Every other instruction requires the owner. That separation is the point of
 * the project, and it needs two real keys to be real.
 *
 * The key is written to app/.env, which is gitignored and already holds the
 * other secrets. The public key is printed. The secret is not printed, not
 * logged and not echoed on any error path, because terminal scrollback is a
 * file like any other.
 *
 * This key can spend nothing. It is not a treasury. Its only power is to submit
 * a proposal, which the program then checks against the mandate and refuses if
 * it breaches a clause.
 *
 * Plain JavaScript rather than TypeScript on purpose: it runs before anything
 * is built, with no loader and no build step, so it cannot be broken by a
 * toolchain that is not working yet.
 *
 * Usage
 * -----
 *   npm run agent:keypair               print the configured agent, create if absent
 *   npm run agent:keypair -- --force    replace the existing key
 *
 * Replacing the key does not touch a mandate that already exists. A mandate
 * names its agent at creation and the program reads it from the account, so an
 * older mandate keeps pointing at the old address and stops accepting proposals
 * from the new one. Rotating an agent should require the owner to act, not
 * happen quietly because a file changed.
 */

import fs from "node:fs";
import path from "node:path";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const ENV_PATH = path.resolve(process.cwd(), ".env");
const VARIABLE = "AGENT_SECRET_KEY";

function readEnv() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
}

/** The raw value of the variable, or null. No caller ever prints it. */
function currentSecret(contents) {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== VARIABLE) continue;
    const value = trimmed.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function publicKeyOf(secret) {
  const bytes = secret.startsWith("[")
    ? Uint8Array.from(JSON.parse(secret))
    : bs58.decode(secret);
  return Keypair.fromSecretKey(bytes).publicKey.toBase58();
}

function write(contents, secret) {
  const line = `${VARIABLE}=${secret}`;
  const lines = contents.split(/\r?\n/);
  const index = lines.findIndex((l) => l.trim().startsWith(`${VARIABLE}=`));

  if (index === -1) {
    const body =
      contents.length === 0 || contents.endsWith("\n") ? contents : `${contents}\n`;
    fs.writeFileSync(
      ENV_PATH,
      `${body}\n# --- Agent identity ---\n` +
        `# The keypair that signs propose_rebalance.\n` +
        `# Created by scripts/create-agent-keypair.mjs. Server only.\n` +
        `# Never give this a NEXT_PUBLIC_ prefix.\n` +
        `${line}\n`,
      { mode: 0o600 },
    );
  } else {
    lines[index] = line;
    fs.writeFileSync(ENV_PATH, lines.join("\n"), { mode: 0o600 });
  }
}

function main() {
  if (!fs.existsSync(path.resolve(process.cwd(), "package.json"))) {
    console.error("Run this from the app directory: npm run agent:keypair");
    process.exit(1);
  }

  const force = process.argv.includes("--force");
  const contents = readEnv();
  const existing = currentSecret(contents);

  if (existing && !force) {
    let address;
    try {
      address = publicKeyOf(existing);
    } catch {
      console.error(`${VARIABLE} is set in .env but is not a readable secret key.`);
      console.error("Run with --force to replace it.");
      process.exit(1);
    }
    console.log("Agent already configured.");
    console.log(`  address: ${address}`);
    console.log("  secret:  present in .env, not shown");
    return;
  }

  const keypair = Keypair.generate();
  write(contents, bs58.encode(keypair.secretKey));

  console.log(existing ? "Agent key replaced." : "Agent key created.");
  console.log(`  address: ${keypair.publicKey.toBase58()}`);
  console.log(`  written: .env as ${VARIABLE}, mode 600, not shown`);
  console.log("");
  console.log("The agent pays for its own proposal transactions, so it needs a");
  console.log("small devnet balance:");
  console.log(`  solana airdrop 1 ${keypair.publicKey.toBase58()} --url devnet`);

  if (existing) {
    console.log("");
    console.log("Mandates created before now still name the old agent and will");
    console.log("refuse proposals signed by this one.");
  }
}

main();
