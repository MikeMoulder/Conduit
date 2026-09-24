import { PublicKey, Transaction } from "@solana/web3.js";
import { z } from "zod";

import { fetchMandate, fetchPortfolio } from "@/lib/accounts";
import { extractProgramError, portfolioPda } from "@/lib/chain";
import { confirmSignature } from "@/lib/confirm";
import {
  FUND_UNITS,
  createAssociatedTokenAccountIdempotent,
  getFaucetKeypair,
  topUpAmount,
  transferTokens,
} from "@/lib/faucet";
import { associatedTokenAddress, desk, fetchHoldings } from "@/lib/holdings";
import { getConnection } from "@/lib/rpc";

/**
 * Funds a portfolio with demo cash, so it has something to settle with.
 *
 * Devnet only, and labelled as such everywhere it surfaces. This is not a
 * deposit: nothing leaves the person's wallet and nothing here has value. It
 * exists because without it nobody but the operator can take a portfolio from
 * targets to holdings, which would make the one part of the product that moves
 * real tokens impossible for anyone else to see.
 *
 * Unauthenticated on purpose. Topping up somebody else's portfolio with
 * worthless cash hurts nobody, and asking for a signature would add a wallet
 * prompt to the one step that should not need one. What bounds abuse is that
 * the amount is a top up to a fixed figure, so repeated calls send nothing, and
 * that the faucet can only hand out the float it was stocked with.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const requestSchema = z.object({
  mandate: z.string().min(32).max(44),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  const faucet = getFaucetKeypair();
  if (!faucet) {
    return Response.json(
      {
        error: "no faucet configured",
        detail: "FAUCET_SECRET_KEY is not set on the server.",
      },
      { status: 409 },
    );
  }

  let mandateAddress: PublicKey;
  try {
    mandateAddress = new PublicKey(parsed.data.mandate);
  } catch {
    return Response.json({ error: "mandate is not a valid address" }, { status: 400 });
  }

  const connection = getConnection();
  const mandate = await fetchMandate(connection, mandateAddress);
  if (!mandate) {
    return Response.json({ error: "no mandate at that address" }, { status: 404 });
  }

  // Only a portfolio this program created. Token accounts for an address that
  // is not one would be rent paid for nothing.
  const portfolioAddress = portfolioPda(mandateAddress);
  const portfolio = await fetchPortfolio(connection, portfolioAddress);
  if (!portfolio) {
    return Response.json(
      { error: "the mandate has no portfolio account yet" },
      { status: 404 },
    );
  }

  const cashMint = new PublicKey(desk.cashMint);
  const portfolioCash = associatedTokenAddress(portfolioAddress, cashMint);
  const faucetCash = associatedTokenAddress(faucet.publicKey, cashMint);

  const target = BigInt(FUND_UNITS) * BigInt(10) ** BigInt(desk.cashDecimals);

  const before = await fetchHoldings(connection, portfolioAddress, mandate);
  const held = BigInt(before.cash?.amount ?? "0");
  const amount = topUpAmount(held, target);

  // Checked before sending rather than left to the token program, so an empty
  // faucet reads as an empty faucet and not as an opaque transfer failure.
  if (amount > BigInt(0)) {
    const float = await connection
      .getTokenAccountBalance(faucetCash)
      .then((r) => BigInt(r.value.amount))
      .catch(() => BigInt(0));

    if (float < amount) {
      return Response.json(
        {
          error: "the faucet is out of demo cash",
          detail: "It needs restocking from the build host with npm run faucet.",
        },
        { status: 503 },
      );
    }
  }

  // Every token account settle will ask for, created if missing. Settle takes
  // the portfolio's account for each permitted asset whether or not it holds
  // anything, so a portfolio funded with cash alone would still be refused.
  const instructions = [
    createAssociatedTokenAccountIdempotent(
      faucet.publicKey,
      portfolioCash,
      portfolioAddress,
      cashMint,
    ),
    ...mandate.allowedAssets.map((allowed) => {
      const mint = new PublicKey(allowed.mint);
      return createAssociatedTokenAccountIdempotent(
        faucet.publicKey,
        associatedTokenAddress(portfolioAddress, mint),
        portfolioAddress,
        mint,
      );
    }),
  ];

  if (amount > BigInt(0)) {
    instructions.push(
      transferTokens(faucetCash, portfolioCash, faucet.publicKey, amount),
    );
  }

  let signature: string;
  let lastValidBlockHeight: number;

  try {
    const latest = await connection.getLatestBlockhash("confirmed");
    lastValidBlockHeight = latest.lastValidBlockHeight;

    const transaction = new Transaction({
      feePayer: faucet.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight,
    }).add(...instructions);

    transaction.sign(faucet);
    signature = await connection.sendRawTransaction(transaction.serialize());
  } catch (error) {
    const programError = extractProgramError(error);
    return Response.json({
      funded: false,
      stage: "send",
      programError,
      detail:
        programError?.message ??
        (error instanceof Error ? error.message : String(error)),
    });
  }

  const outcome = await confirmSignature(connection, signature, {
    lastValidBlockHeight,
    timeoutMs: 90_000,
  });

  if (outcome.status !== "confirmed") {
    return Response.json({
      funded: false,
      stage: "confirm",
      signature,
      outcome: outcome.status,
      programError:
        outcome.status === "failed" ? extractProgramError(outcome.error) : null,
    });
  }

  const after = await fetchHoldings(connection, portfolioAddress, mandate);

  return Response.json({
    funded: true,
    signature,
    slot: outcome.slot,
    sent: Number(amount) / 10 ** desk.cashDecimals,
    before,
    after,
  });
}
