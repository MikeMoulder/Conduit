# Conduit: Economics Plan

Status: plan only, nothing built yet. Written 2026-10-10.

## 1. Where we are today

- **Income is zero.** The desk fills every trade at the exact published price, with no spread and no fee (`trade` in `programs/conduit/src/lib.rs`).
- **We pay all the costs.** Three server wallets spend SOL:

| Wallet | What it pays for |
|---|---|
| Faucet | Network fees for trades tapped in the chat, opening token accounts for users, demo cash |
| Agent | Network fees for autopilot moves (rebalances) |
| Publisher | Writing stock prices on chain every 4 minutes |

This was on purpose for the demo: a new user can trade in seconds without owning any SOL.

## 2. What things cost

Solana numbers are fixed. Dollar values assume SOL at $150.

| Cost | SOL | Dollars | How often |
|---|---|---|---|
| Fee for one transaction (one signature) | 0.000005 | ~$0.00075 | Every trade or rebalance |
| Opening a token account (one per stock, per user) | ~0.00204 | ~$0.31 | Once. It is a deposit we get back if the account is closed |
| Price publishing (about 360 runs a day) | ~0.0018 a day | ~$8 a month | Always running |

The costs are small. The problem is that nothing pays for them.

## 3. How agents work (relevant to pricing)

- There is **one shared agent key** on the server. It does not hold anyone's money.
- Each user has **their own mandate**, a rulebook on Solana (position limits, minimum cash, allowed stocks). The mandate names which agent may propose moves.
- The program checks every proposal against **that user's** rules and refuses anything that breaks them.
- So one agent can serve every user safely, like one advisor working under many separate signed contracts. A key per user would add cost and key management without adding safety.

## 4. The model we chose

Two income sources, both enforced by the Solana program so users can verify exactly what they pay.

### A. Trade fee

- **0.10% of each trade**, with a small minimum (about $0.01) so tiny trades still cover their network fee.
- Taken in cash (the stablecoin) at the moment the trade settles, sent to a Conduit treasury account.
- Applies to manual chat trades and to autopilot trades.

### B. Autopilot management fee

- **0.50% a year** of the value inside a mandate (the money the AI manages).
- Collected in small slices, for example on each settled rebalance, based on how much time passed since the last collection.
- The rate is written into the mandate when the user creates it, so it can never be raised without the owner signing a change.
- Money in the main wallet that is not on autopilot pays no management fee.

### C. Free start, then users cover their own costs

- **New users:** we keep paying network fees and account opening for their first trades. This is the free trial feel and the cost is around $0.30 to $1 per new user.
- **After that:** network costs are covered by the trade fee (one $50 trade at 0.10% pays $0.05, enough for about 60 transaction fees).
- Token account deposits can be reclaimed when a user fully exits a stock.

## 5. What this looks like per user

| User | Activity | Our yearly income | Our yearly cost |
|---|---|---|---|
| Casual | 20 trades of $50, no autopilot | $1.00 | ~$0.32 (accounts plus fees) |
| Autopilot | $1,000 managed, 50 rebalances | $5.00 management plus trade fees on rebalanced amounts | ~$0.35 |
| Active | $10,000 managed, 100 trades of $500 | $50 management plus $50 trade fees | ~$0.40 |

Price publishing is a shared cost (~$100 a year) covered by the first few active users.

## 6. Why this model

- **Honest and visible:** fees live in the program, not hidden in prices. That fits the core pitch: "the AI proposes, Solana checks."
- **Familiar:** trade fees match exchanges, the management fee matches robo advisors like Betterment (0.25% to 0.40%).
- **Lined up with the product:** the main fee is charged for the thing that is special, the AI managing money within the user's rules.

We chose fees over a hidden spread because a spread is harder for users to see, and visibility is the selling point.

## 7. Build order (later, not now)

1. Add a treasury account and a `fee_bps` setting on the desk.
2. Take the trade fee inside `trade` and `settle`. Add tests.
3. Add the management fee rate to the mandate and collect it on settle. Add tests.
4. Show fees in the chat before a trade is confirmed, and on the portfolio screen.
5. Track "free trial" usage per user and stop paying fees after the limit.
6. Add a treasury balance check to the Telegram alerts.

## 8. Still open

- Exact free trial limit (number of trades, or a dollar amount of fees).
- Whether the management fee pauses when a mandate is paused.
- Whether fees are taken in the stablecoin only, or also in SOL.
