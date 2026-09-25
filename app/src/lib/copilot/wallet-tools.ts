import "server-only";

import type { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { fetchMandate } from "../accounts";
import { assetBySymbol } from "../agent-actions";
import { getAgentIdentity } from "../agent-identity";
import { mandatePda } from "../chain";
import { FUND_UNITS } from "../faucet";
import { fetchMainWallet, fetchWalletBalances, walletAddress } from "../main-wallet";
import { getConnection } from "../rpc";
import { readAssetPrice } from "../settlement-prices";
import { ToolError, type CopilotTool, type ToolContext, type ToolOutcome } from "./tool-types";
import type { WalletCard } from "./events";

/**
 * The copilot's tools for a person's main wallet.
 *
 * The main wallet is where the agent trades on the person's word: "buy $3,000
 * of NVDA" typed into the chat, no wallet prompt. Every write still arrives as
 * an approval card, so nothing happens because a sentence asked for it, but
 * approving is a click, not a signature. The person signs exactly twice in the
 * whole flow: once to open the main wallet, and each time money leaves their
 * own wallet as a deposit.
 *
 * None of these tools takes an owner, a wallet or a destination. The owner is
 * the connected wallet, the main wallet is derived from it, and every
 * withdrawal goes back to the owner, so a sentence in a conversation cannot
 * point any of this at somebody else's money.
 */

const SOLANA_SOURCE = [
  { provider: "solana", detail: "read from the accounts on devnet", ok: true },
];

function requireOwner(ctx: ToolContext): PublicKey {
  if (!ctx.owner) {
    throw new ToolError(
      "No wallet is connected, so there is nobody whose main wallet this could be. Ask the person to connect one.",
    );
  }
  return ctx.owner;
}

const usd = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const mandateIdArg = z.number().int().min(0).max(1_000_000).optional();

async function requireMainWallet(owner: PublicKey) {
  const wallet = await fetchMainWallet(getConnection(), owner);
  if (!wallet) {
    throw new ToolError(
      "This person has no main wallet yet. Offer to open one with open_wallet: it takes one signature, after which trades need none.",
    );
  }
  return wallet;
}

async function requireOwnedMandate(owner: PublicKey, mandateId: number) {
  const address = mandatePda(owner, mandateId);
  const mandate = await fetchMandate(getConnection(), address);
  if (!mandate) {
    throw new ToolError(
      `There is no mandate ${mandateId} for this wallet. One has to be created before money can go into it.`,
    );
  }
  return { address, mandate };
}

/* -------------------------------------------------------------------------- */

const getWallet: CopilotTool = {
  label: "Reading the main wallet",
  declaration: {
    name: "get_wallet",
    description:
      "Reads the person's main wallet: whether it is open, the cash and every asset in it valued at the settlement price, and the demo cash still sitting in their own connected wallet waiting to be deposited. Use it before any trade, deposit, move or withdrawal, and whenever they ask what they have.",
    parameters: { type: "OBJECT", properties: {} },
  },
  async run(_args, ctx) {
    const owner = requireOwner(ctx);
    const connection = getConnection();

    const [wallet, own] = await Promise.all([
      fetchMainWallet(connection, owner),
      fetchWalletBalances(connection, owner),
    ]);
    const ownCash = own.cash?.uiAmount ?? 0;

    if (!wallet) {
      const card: WalletCard = {
        opened: false,
        address: null,
        cash: 0,
        holdings: [],
        total: 0,
        ownCash,
      };
      return {
        result: {
          opened: false,
          ownWalletCash: ownCash,
          note: "No main wallet yet. Offer to open one with open_wallet.",
        },
        summary: "no main wallet yet",
        card: { kind: "wallet", wallet: card },
        sources: SOLANA_SOURCE,
      };
    }

    const balances = await fetchWalletBalances(connection, walletAddress(owner));
    const held = balances.assets.filter((a) => a.uiAmount > 0);

    const holdings = await Promise.all(
      held.map(async (h) => {
        const asset = assetBySymbol(h.symbol);
        const price = asset ? await readAssetPrice(connection, asset) : null;
        return {
          symbol: h.symbol,
          amount: h.uiAmount,
          value: price && price.ok ? h.uiAmount * price.price.price : null,
        };
      }),
    );

    const cash = balances.cash?.uiAmount ?? 0;
    const total = cash + holdings.reduce((sum, h) => sum + (h.value ?? 0), 0);

    return {
      result: {
        opened: true,
        cash,
        holdings: holdings.map((h) => ({
          symbol: h.symbol,
          tokens: h.amount,
          value: h.value === null ? null : Math.round(h.value * 100) / 100,
        })),
        total: Math.round(total * 100) / 100,
        ownWalletCash: ownCash,
      },
      summary: `${usd(total)} in the main wallet, ${usd(ownCash)} not yet deposited`,
      card: {
        kind: "wallet",
        wallet: { opened: true, address: wallet.address, cash, holdings, total, ownCash },
      },
      sources: SOLANA_SOURCE,
    };
  },
};

const openWallet: CopilotTool = {
  label: "Preparing the main wallet",
  declaration: {
    name: "open_wallet",
    description:
      "Prepares the person's main wallet for them to approve and sign. It is an account bound to their address that nobody holds a key for; the agent can trade, fund their mandates and withdraw to them without further signatures, and the program only ever lets money leave it for the desk, their own mandates, or back to them. Offer this the first time they want to trade or deposit. This does NOT execute: they sign it once.",
    parameters: { type: "OBJECT", properties: {} },
  },
  async run(_args, ctx) {
    const owner = requireOwner(ctx);
    if (await fetchMainWallet(getConnection(), owner)) {
      throw new ToolError("This person already has a main wallet open. Nothing to do.");
    }

    const agent = getAgentIdentity();
    if (!agent.configured) throw new ToolError(agent.reason);

    return {
      result: { prepared: true, note: "Waiting for the person to sign once." },
      summary: "main wallet ready to open",
      action: {
        kind: "open-wallet",
        agent: agent.publicKey,
        summary:
          "Open your main wallet. It is bound to your address and nobody holds a key for it, not even Conduit. After this one signature the agent can trade, fund your mandates and send money back to you without asking you to sign again, and the program only ever lets money leave it for the desk, your own mandates, or you.",
      },
    };
  },
};

const getDemoCash: CopilotTool = {
  label: "Preparing demo cash",
  declaration: {
    name: "get_demo_cash",
    description: `Prepares a devnet faucet top up of the person's own connected wallet to ${FUND_UNITS.toLocaleString()} in demo cash. Worthless test currency, never call it a deposit or real money. Use it when they have no cash to deposit. This does NOT execute: they approve a card.`,
    parameters: { type: "OBJECT", properties: {} },
  },
  async run(_args, ctx) {
    const owner = requireOwner(ctx);
    const own = await fetchWalletBalances(getConnection(), owner);
    const cash = own.cash?.uiAmount ?? 0;

    if (cash >= FUND_UNITS) {
      throw new ToolError(
        `Their own wallet already holds ${usd(cash)} in demo cash, at or above the ${usd(FUND_UNITS)} the faucet tops up to.`,
      );
    }

    return {
      result: { prepared: true, current: cash, topUpTo: FUND_UNITS },
      summary: `ready to top up to ${usd(FUND_UNITS)} demo cash`,
      action: {
        kind: "demo-cash",
        owner: owner.toBase58(),
        summary: `Top your own wallet up to ${usd(FUND_UNITS)} in devnet demo cash. Worthless outside this demo. From there you choose how much goes into your main wallet or a mandate.`,
      },
    };
  },
};

/**
 * The step before a request that the main wallet cannot pay for yet.
 *
 * Refusing "buy $500 of NVDA" because the main wallet is empty is correct and
 * unhelpful. When the person's own wallet can cover the gap, the answer is the
 * card that closes it: a deposit of exactly what is missing, carrying what it
 * is for, so once they approve it the copilot carries straight on to the
 * request itself. When their own wallet cannot cover it either, the error says
 * so and points at demo cash.
 *
 * `then` names the request as a noun ("a buy of $500 of NVDA"), and `retry`
 * is the tool call that prepares it, so the copilot can repeat it exactly.
 * Named, not commanded: a small model handed "buy $500 of NVDA" as an
 * instruction reported the buy as done when it had only prepared a card.
 */
export async function fundFirst(input: {
  owner: PublicKey;
  needed: number;
  have: number;
  purpose: string;
  then: string;
  retry: { tool: string; args: Record<string, unknown> };
}): Promise<ToolOutcome> {
  const short = Math.ceil((input.needed - input.have) * 100) / 100;
  const own = await fetchWalletBalances(getConnection(), input.owner);
  const available = own.cash?.uiAmount ?? 0;

  if (available < short) {
    throw new ToolError(
      `The main wallet holds ${usd(input.have)} of cash and ${input.purpose} needs ${usd(input.needed)}. Their own wallet holds ${usd(available)}, not enough to cover the ${usd(short)} gap either. Offer get_demo_cash, then a deposit.`,
    );
  }

  return {
    result: {
      fundingFirst: true,
      mainWalletCash: input.have,
      needed: input.needed,
      depositPrepared: short,
      then: input.then,
      afterTheDepositCall: input.retry,
      notDoneYet: `Nothing is deposited and nothing is set up yet. Tell them their main wallet is short, to approve the deposit card first, and that the card for ${input.then} comes right after, for them to approve too.`,
      note: "The deposit card is showing. When its card result says it landed, call afterTheDepositCall straight away with those exact arguments. Do not ask again.",
    },
    summary: `main wallet short by ${usd(short)}, deposit prepared first`,
    action: {
      kind: "deposit",
      mandate: null,
      destinationLabel: "your main wallet",
      dollars: short,
      then: input.then,
      summary: `Your main wallet has ${usd(input.have)} of cash, so ${input.purpose} cannot go through yet. Approve moving ${usd(short)} in from your own wallet first. You sign this one, because the money is leaving your wallet. As soon as it lands, the card for ${input.then} comes next, for you to approve.`,
    },
  };
}

const deposit: CopilotTool = {
  label: "Preparing the deposit",
  declaration: {
    name: "deposit",
    description:
      "Prepares a deposit of cash from the person's own connected wallet into their main wallet, or straight into one of their mandates when a mandateId is given. Money leaving their own wallet needs their signature, so this is one of the only steps they sign. This does NOT execute.",
    parameters: {
      type: "OBJECT",
      properties: {
        dollars: { type: "NUMBER", description: "How much to deposit, in dollars." },
        mandateId: {
          type: "INTEGER",
          description: "Deposit straight into this mandate. Omit to deposit into the main wallet.",
        },
      },
      required: ["dollars"],
    },
  },
  async run(args, ctx) {
    const { dollars, mandateId } = z
      .object({ dollars: z.number().positive(), mandateId: mandateIdArg })
      .parse(args);
    const owner = requireOwner(ctx);

    const own = await fetchWalletBalances(getConnection(), owner);
    const available = own.cash?.uiAmount ?? 0;
    if (dollars > available) {
      throw new ToolError(
        `Their own wallet holds ${usd(available)}, less than ${usd(dollars)}. Offer get_demo_cash if they need more.`,
      );
    }

    let mandate: string | null = null;
    let label = "your main wallet";
    if (mandateId !== undefined) {
      const found = await requireOwnedMandate(owner, mandateId);
      mandate = found.address.toBase58();
      label = `mandate ${mandateId}`;
    } else {
      await requireMainWallet(owner);
    }

    return {
      result: { prepared: true, dollars, destination: label },
      summary: `deposit ${usd(dollars)} into ${label}, awaiting signature`,
      action: {
        kind: "deposit",
        mandate,
        destinationLabel: label,
        dollars,
        summary: `Move ${usd(dollars)} of demo cash from your own wallet into ${label}. You sign this one, because the money is leaving your wallet.`,
      },
    };
  },
};

const placeOrder: CopilotTool = {
  label: "Pricing the order",
  declaration: {
    name: "place_order",
    description:
      "Prepares a trade in the person's main wallet: buy or sell a dollar amount of one asset, for example buy $3,000 of NVDA. Use this whenever they name an amount of money. No mandate applies: the main wallet is theirs to direct. The agent signs once they approve, so there is no wallet prompt. The price is the settlement price the program will use. It trades now: for a trade at a later time ('in 2 minutes', 'in an hour') use set_price_trigger with condition after instead. Selling always uses this tool, never withdraw: 'sell google' or 'sell all my NVDA' with no amount is side SELL with all true, which sells the whole holding for cash in the main wallet. This does NOT execute.",
    parameters: {
      type: "OBJECT",
      properties: {
        side: { type: "STRING", description: "BUY or SELL." },
        symbol: { type: "STRING", description: "The asset, for example NVDA." },
        dollars: { type: "NUMBER", description: "The amount in US dollars. Leave out when selling all." },
        all: { type: "BOOLEAN", description: "SELL only: sell the whole holding of this asset." },
      },
      required: ["side", "symbol"],
    },
  },
  async run(args, ctx) {
    const parsed = z
      .object({
        side: z.string(),
        symbol: z.string().min(1),
        dollars: z.number().positive().optional(),
        all: z.boolean().optional(),
      })
      .parse(args);
    const owner = requireOwner(ctx);
    const side = parsed.side.toLowerCase() === "sell" ? "sell" : "buy";
    const all = side === "sell" && parsed.all === true;
    if (!all && parsed.dollars === undefined) {
      throw new ToolError(
        side === "sell"
          ? "Say how much to sell in dollars, or pass all true to sell the whole holding."
          : "Say how much to buy in dollars.",
      );
    }

    const asset = assetBySymbol(parsed.symbol);
    if (!asset) throw new ToolError(`The desk does not trade ${parsed.symbol.toUpperCase()}.`);

    await requireMainWallet(owner);
    const connection = getConnection();

    const [balances, price] = await Promise.all([
      fetchWalletBalances(connection, walletAddress(owner)),
      readAssetPrice(connection, asset),
    ]);
    if (!price.ok) throw new ToolError(price.reason);

    const cash = balances.cash?.uiAmount ?? 0;
    const heldTokens = balances.assets.find((a) => a.mint === asset.mint)?.uiAmount ?? 0;
    const heldValue = heldTokens * price.price.price;

    if (all && !(heldTokens > 0)) {
      throw new ToolError(`The main wallet holds no ${asset.symbol}, so there is nothing to sell.`);
    }
    // Selling all shows the holding's value now; the exact amount is fixed
    // when the person approves, from the balance and price at that moment.
    const dollars = all ? Math.floor(heldValue * 100) / 100 : parsed.dollars!;

    if (side === "buy" && dollars > cash) {
      return fundFirst({
        owner,
        needed: dollars,
        have: cash,
        purpose: `this ${usd(dollars)} buy of ${asset.symbol}`,
        then: `a buy of ${usd(dollars)} of ${asset.symbol} in your main wallet`,
        retry: { tool: "place_order", args: { side: "BUY", symbol: asset.symbol, dollars } },
      });
    }
    if (side === "sell" && !all && dollars > heldValue) {
      throw new ToolError(
        `The main wallet holds ${usd(heldValue)} of ${asset.symbol}, less than ${usd(dollars)}. To sell all of it, pass all true.`,
      );
    }

    const tokens = all ? heldTokens : dollars / price.price.price;
    const cashAfter = side === "buy" ? cash - dollars : cash + dollars;
    const verb = side === "buy" ? "Buy" : "Sell";

    return {
      result: {
        prepared: true,
        side,
        symbol: asset.symbol,
        dollars,
        ...(all ? { sellsAll: true } : {}),
        price: price.price.price,
        tokens,
        cashAfter,
        note: "Waiting for the person to approve. Nothing has been sent.",
      },
      summary: all
        ? `sell all ${asset.symbol} (about ${usd(dollars)}), awaiting approval`
        : `${side} ${usd(dollars)} of ${asset.symbol}, awaiting approval`,
      action: {
        kind: "trade",
        owner: owner.toBase58(),
        side,
        symbol: asset.symbol,
        dollars,
        ...(all ? { all: true } : {}),
        price: price.price.price,
        priceSource: price.price.source,
        priceAgeSeconds: price.price.ageSeconds,
        tokens,
        cashAfter,
        summary: all
          ? `Sell all ${Number(heldTokens.toFixed(6))} ${asset.symbol} in your main wallet for cash, about ${usd(dollars)} at ${usd(price.price.price)}. The exact amount is set from your balance and the price when you approve. The agent signs; the program fixes the price and keeps both sides of the trade in your wallet.`
          : `${verb} ${usd(dollars)} of ${asset.symbol} in your main wallet at ${usd(price.price.price)}. The agent signs; the program fixes the price and keeps both sides of the trade in your wallet.`,
      },
    };
  },
};

const fundMandate: CopilotTool = {
  label: "Preparing the transfer",
  declaration: {
    name: "fund_mandate",
    description:
      "Prepares moving cash from the person's main wallet into one of their mandates, which is how an autonomous investment gets its money. The agent signs once they approve. Money can go into a mandate this way; taking it back out into the main wallet needs the owner's own signature, so do not offer that here. This does NOT execute.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
        dollars: { type: "NUMBER", description: "How much to move, in dollars." },
      },
      required: ["dollars"],
    },
  },
  async run(args, ctx) {
    const { mandateId = 0, dollars } = z
      .object({ mandateId: mandateIdArg, dollars: z.number().positive() })
      .parse(args);
    const owner = requireOwner(ctx);

    await requireMainWallet(owner);
    const { address } = await requireOwnedMandate(owner, mandateId);

    const balances = await fetchWalletBalances(getConnection(), walletAddress(owner));
    const cash = balances.cash?.uiAmount ?? 0;
    if (dollars > cash) {
      return fundFirst({
        owner,
        needed: dollars,
        have: cash,
        purpose: `moving ${usd(dollars)} into mandate ${mandateId}`,
        then: `moving ${usd(dollars)} from your main wallet into mandate ${mandateId}`,
        retry: { tool: "fund_mandate", args: { mandateId, dollars } },
      });
    }

    const label = `mandate ${mandateId}`;
    return {
      result: { prepared: true, dollars, mandate: label, cashLeft: cash - dollars },
      summary: `move ${usd(dollars)} into ${label}, awaiting approval`,
      action: {
        kind: "fund-mandate",
        owner: owner.toBase58(),
        mandate: address.toBase58(),
        mandateLabel: label,
        dollars,
        summary: `Move ${usd(dollars)} from your main wallet into ${label}. From there the agent invests it on its own, and the program checks every decision against that mandate's rules.`,
      },
    };
  },
};

const withdraw: CopilotTool = {
  label: "Preparing the withdrawal",
  declaration: {
    name: "withdraw",
    description:
      "Prepares sending money back to the person's own connected wallet, from their main wallet, or from a mandate when a mandateId is given. Cash is withdrawn in dollars; an asset such as NVDA in whole tokens, or all of it. Use it only when they ask to withdraw, send or move money out to their own wallet. Never use it to sell: selling turns an asset into cash and is place_order with side SELL. The agent signs once they approve, and the program only lets it send the money to the owner. This does NOT execute.",
    parameters: {
      type: "OBJECT",
      properties: {
        symbol: { type: "STRING", description: "CASH, or an asset such as NVDA. Defaults to CASH." },
        amount: { type: "NUMBER", description: "Dollars for cash, whole tokens for an asset." },
        all: { type: "BOOLEAN", description: "Withdraw all of it." },
        mandateId: { type: "INTEGER", description: "Withdraw from this mandate instead of the main wallet." },
      },
    },
  },
  async run(args, ctx) {
    const parsed = z
      .object({
        symbol: z.string().default("CASH"),
        amount: z.number().positive().optional(),
        all: z.boolean().default(false),
        mandateId: mandateIdArg,
      })
      .parse(args);
    const owner = requireOwner(ctx);

    if (!parsed.all && parsed.amount === undefined) {
      throw new ToolError("Say how much to withdraw, or withdraw all of it.");
    }

    const symbol = parsed.symbol.toUpperCase();
    if (symbol !== "CASH" && !assetBySymbol(symbol)) {
      throw new ToolError(`There is nothing called ${symbol} to withdraw.`);
    }

    let mandate: string | null = null;
    let fromLabel = "your main wallet";
    if (parsed.mandateId !== undefined) {
      const found = await requireOwnedMandate(owner, parsed.mandateId);
      mandate = found.address.toBase58();
      fromLabel = `mandate ${parsed.mandateId}`;
    } else {
      await requireMainWallet(owner);
    }

    const what = parsed.all
      ? `all the ${symbol === "CASH" ? "cash" : symbol}`
      : symbol === "CASH"
        ? usd(parsed.amount!)
        : `${parsed.amount} ${symbol}`;

    return {
      result: { prepared: true, what, from: fromLabel },
      summary: `withdraw ${what} from ${fromLabel}, awaiting approval`,
      action: {
        kind: "withdraw",
        owner: owner.toBase58(),
        mandate,
        symbol,
        amount: parsed.amount ?? null,
        all: parsed.all,
        summary: `Send ${what} from ${fromLabel} back to your own wallet. The agent signs; the program will not let it go anywhere else.`,
      },
    };
  },
};

export const WALLET_TOOLS: Record<string, CopilotTool> = {
  get_wallet: getWallet,
  open_wallet: openWallet,
  get_demo_cash: getDemoCash,
  deposit,
  place_order: placeOrder,
  fund_mandate: fundMandate,
  withdraw,
};
