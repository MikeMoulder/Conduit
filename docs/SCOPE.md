# STOCKPILOT: Scope Lock

Status: LOCKED
Date locked: 2026-09-21
Submission deadline: 2026-09-25, 4:00pm ET

---

## 1. One line

An AI portfolio manager for tokenized stocks where the risk mandate is enforced
by a Solana program, not by the model's good intentions.

## 2. The wedge

Every AI investing product on the market asks the user to trust the model.
STOCKPILOT removes the need for trust.

The user's mandate (max position size, minimum cash, allowed assets, turnover
cap) is written to a Program Derived Address on Solana. The agent cannot touch
the portfolio directly. It can only submit a proposed rebalance through a
program instruction that re-validates every constraint on chain and rejects any
proposal that breaks the mandate.

The AI proposes. The chain disposes.

This is the part a brokerage app cannot copy and a purely off chain AI agent
cannot copy. It is the answer to the judging question "why does this belong on
Solana".

## 3. Core loop (must ship)

1. User writes an investment mandate in plain English.
2. Agent pipeline converts it into a machine readable mandate and a proposed
   allocation. Pipeline stages: Research, Bull, Bear, Risk, Portfolio Manager.
3. Mandate is committed on chain as the portfolio constitution.
4. User approves. Portfolio is funded and positions are opened.
5. Pyth feeds drive live valuation and the tokenized versus equity spread.
6. Thesis breaker conditions are monitored per position.
7. When a breaker trips, the agent proposes a rebalance. The proposal is
   validated on chain and executed or rejected.

## 4. The demo moment

Step 7 run twice, back to back:

- A valid rebalance passes policy validation and settles on chain.
- A deliberately over concentrated rebalance is submitted and the program
  rejects it with a constraint violation error.

The second case is the one judges remember. It proves the constitution is real
and not UI theatre.

## 5. Prize tracks

| Track | Prize | Decision | Reason |
| --- | --- | --- | --- |
| Main track | $100,000 | TARGET | Primary goal. Core loop is built for this. |
| Pyth | Pyth Pro access | TARGET | Natural fit. Dual feed comparison drives real allocation decisions. |
| PreStocks | $10,000 | STRETCH | Pre IPO sleeve inside the mandate. Start only after core loop is green. |
| Tessera | $6,000 | EXCLUDED | Mutually exclusive with PreStocks. See section 6. |
| Clawpump | $5,000 | EXCLUDED | Requires mainnet token launch with a stock paired liquidity pool. |
| Meteora DBC | $5,000 | EXCLUDED | Same as above. Separate workstream, real capital, dilutes the story. |

## 6. Critical eligibility note

The PreStocks bounty states that any project integrating a non PreStocks pre IPO
token is ineligible for that bounty. Tessera tokens are pre IPO tokens.

Therefore PreStocks and Tessera cannot both be targeted. PreStocks is chosen
because the prize is larger ($10,000 against $6,000) and because their brief
explicitly names AI agents as a wanted category.

If we integrate PreStocks, we must not integrate Tessera. This is a hard
constraint, not a preference.

## 7. Pyth integration plan

Three feed classes are read and used, not merely displayed:

- `Equity.US.AAPL/USD` for the reference equity price.
- `Crypto.AAPLX/USD` for the xStock tokenized representation.
- `Crypto.AAPLON/USD` for the Ondo representation.

The spread between reference and tokenized price feeds directly into two places:

1. Execution timing. The agent prefers to build a position when the tokenized
   asset trades at a discount to its reference equity.
2. Risk scoring. A persistent wide spread is treated as a liquidity warning and
   lowers the maximum allowed position size for that asset.

This satisfies the Pyth brief that live financial data must do real work.

## 8. Technical stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js 15 App Router, TypeScript, Tailwind v4, shadcn/ui |
| On chain | Anchor program on devnet, mandate PDA and portfolio PDA |
| Chain client | @solana/web3.js, Solana wallet adapter |
| Prices | Pyth Hermes client |
| Agents | Anthropic SDK, staged pipeline with structured output |
| Storage | Drizzle ORM over SQLite for agent run history and thesis cards |
| Deploy | Vercel for the app, devnet for the program |

## 9. Explicitly out of scope

These are recorded so they do not get rebuilt by accident later:

- Mainnet deployment and real capital.
- Token launch, bonding curve, or liquidity pool creation.
- Agent versus agent social layer and strategy following.
- Tokenized strategy identity such as a $AIGROWTH token.
- Mobile application.
- Any custody of user funds beyond the devnet demo flow.

## 10. Build order (risk first)

The riskiest and least reversible pieces are built first so that failure is
discovered early while there is still time to route around it.

1. Anchor program: mandate PDA, portfolio PDA, policy validated rebalance.
2. Program tests proving a violating rebalance is rejected.
3. Pyth price service with dual feed spread calculation.
4. Agent pipeline producing a structured, schema valid allocation.
5. Next.js app shell and wallet connection.
6. Mandate authoring flow.
7. Portfolio and agent activity views.
8. Thesis breaker monitoring.
9. End to end demo script and recording.
10. README, documentation, and submission.
