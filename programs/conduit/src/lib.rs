//! Conduit: on chain enforcement of an investment mandate.
//!
//! The premise of this program is that an autonomous agent managing someone's
//! money should not be trusted, and does not need to be. The owner writes their
//! limits into a mandate account. The agent is granted exactly one power, to
//! propose a new allocation, and every proposal is re-checked against the mandate
//! by this program before anything is recorded.
//!
//! The agent cannot amend the mandate, cannot pause or close it, cannot add an
//! asset to the permitted universe and cannot replace itself. Those are not
//! policies a model is asked to respect. They are instructions it has no way to
//! reach.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod constants;
pub mod errors;
pub mod policy;
pub mod settlement;
pub mod state;

use constants::{
    BPS_DENOMINATOR, DESK_ASSET_SEED, DESK_SEED, MANDATE_SEED, MAX_ASSETS, PORTFOLIO_SEED,
    PRICE_SEED, PUBLISHER_SEED, WALLET_SEED,
};
use errors::ConduitError;
use policy::{evaluate_proposal, ProposedPosition};
use settlement::{
    leg_for, net_asset_value, quantity_for, read_price, read_published_price, value_of, Holding,
    Price, MAX_PRICE_AGE_SECONDS, PYTH_RECEIVER,
};
use state::{
    AllowedAsset, Desk, DeskAsset, MainWallet, Mandate, MandateConstraints, MandateStatus,
    Portfolio, Position, PublishedPrice, Publisher,
};

declare_id!("6X7wfnLNHQvW94CHPVFdguraojh5uEN3Y1gjfi2pkxVu");

/// Reads a price from whichever source owns the account, or refuses it.
///
/// The single place trust in a price is decided. Pyth means many publishers
/// agreed on a market; this program means its publishing key asserted a
/// number; any other owner means nobody vouched for it at all. Deserialised
/// rather than parsed by offset for our own accounts, so the discriminator is
/// checked and a mandate or portfolio cannot be passed off as a price.
fn price_from(price_info: &AccountInfo, feed_id: &[u8; 32], now: i64) -> Result<Price> {
    if price_info.owner == &PYTH_RECEIVER {
        read_price(&price_info.try_borrow_data()?, feed_id, now)
    } else if price_info.owner == &crate::ID {
        let data = price_info.try_borrow_data()?;
        let published = PublishedPrice::try_deserialize(&mut &data[..])?;
        read_published_price(
            &published.feed_id,
            published.price,
            published.exponent,
            published.publish_time,
            feed_id,
            now,
        )
    } else {
        err!(ConduitError::UnknownPriceSource)
    }
}

/// The owner, or the agent the owner named. Nobody else acts on a wallet.
fn require_wallet_signer(wallet: &MainWallet, signer: &Pubkey) -> Result<()> {
    require!(
        signer == &wallet.owner || signer == &wallet.agent,
        ConduitError::UnauthorizedWalletSigner
    );
    Ok(())
}


#[program]
pub mod conduit {
    use super::*;

    /// Creates a mandate: the constitution a portfolio will operate under.
    ///
    /// Constraints are validated here rather than on first use, so an incoherent
    /// mandate fails immediately at the point the owner can still fix it.
    pub fn initialize_mandate(
        ctx: Context<InitializeMandate>,
        mandate_id: u64,
        constraints: MandateConstraints,
        allowed_assets: Vec<AllowedAsset>,
        agent: Pubkey,
    ) -> Result<()> {
        require!(
            !allowed_assets.is_empty(),
            ConduitError::EmptyAssetUniverse
        );
        require!(
            allowed_assets.len() <= MAX_ASSETS,
            ConduitError::TooManyAssets
        );

        // A universe containing the same mint twice would let a proposal satisfy
        // the permitted-asset check through either entry while the owner believes
        // they authorised one instrument.
        for (i, asset) in allowed_assets.iter().enumerate() {
            require!(
                !allowed_assets[..i].iter().any(|a| a.mint == asset.mint),
                ConduitError::DuplicateAsset
            );
        }

        constraints.validate()?;

        let mandate = &mut ctx.accounts.mandate;
        mandate.mandate_id = mandate_id;
        mandate.owner = ctx.accounts.owner.key();
        mandate.agent = agent;
        mandate.constraints = constraints;
        mandate.allowed_assets = allowed_assets;
        mandate.status = MandateStatus::Active;
        mandate.version = Mandate::VERSION;
        mandate.bump = ctx.bumps.mandate;
        mandate.created_at = Clock::get()?.unix_timestamp;
        mandate.rebalance_count = 0;
        mandate.last_rebalance_at = 0;

        Ok(())
    }

    /// Opens the portfolio governed by a mandate.
    ///
    /// It starts fully in cash. That is the only allocation guaranteed to satisfy
    /// any well formed mandate, so initialization can never produce a portfolio
    /// that is already in breach.
    pub fn initialize_portfolio(ctx: Context<InitializePortfolio>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let portfolio = &mut ctx.accounts.portfolio;

        portfolio.mandate = ctx.accounts.mandate.key();
        portfolio.owner = ctx.accounts.owner.key();
        portfolio.positions = Vec::new();
        portfolio.cash_bps = constants::BPS_DENOMINATOR;
        portfolio.bump = ctx.bumps.portfolio;
        portfolio.created_at = now;
        portfolio.updated_at = now;

        Ok(())
    }

    /// The agent asks to move the portfolio to a new allocation.
    ///
    /// This is the only instruction the agent can call, and it is where the
    /// mandate is enforced. Nothing the agent computed off chain is taken on
    /// trust: the weights are re-checked against the mandate as stored on chain,
    /// and any breach aborts the transaction.
    pub fn propose_rebalance(
        ctx: Context<ProposeRebalance>,
        proposed: Vec<ProposedPosition>,
    ) -> Result<()> {
        let mandate = &mut ctx.accounts.mandate;
        let portfolio = &mut ctx.accounts.portfolio;

        require!(
            mandate.status == MandateStatus::Active,
            ConduitError::MandateNotActive
        );

        let report = evaluate_proposal(
            &mandate.constraints,
            &mandate.allowed_assets,
            &portfolio.positions,
            &proposed,
        )?;

        let now = Clock::get()?.unix_timestamp;

        portfolio.positions = proposed
            .iter()
            .map(|p| Position {
                mint: p.mint,
                target_bps: p.target_bps,
            })
            .collect();
        portfolio.cash_bps = report.cash_bps;
        portfolio.updated_at = now;

        mandate.rebalance_count = mandate
            .rebalance_count
            .checked_add(1)
            .ok_or(ConduitError::ArithmeticOverflow)?;
        mandate.last_rebalance_at = now;

        emit!(RebalanceExecuted {
            mandate: mandate.key(),
            portfolio: portfolio.key(),
            agent: ctx.accounts.agent.key(),
            turnover_bps: report.turnover_bps,
            cash_bps: report.cash_bps,
            position_count: report.position_count,
            sequence: mandate.rebalance_count,
            timestamp: now,
        });

        Ok(())
    }

    /// Owner suspends or resumes the agent, or closes the mandate permanently.
    ///
    /// Restricted to the owner. This is the control that makes delegation safe to
    /// grant in the first place: authority handed to an agent can be withdrawn
    /// without the agent's cooperation.
    pub fn set_mandate_status(ctx: Context<SetMandateStatus>, status: MandateStatus) -> Result<()> {
        let mandate = &mut ctx.accounts.mandate;

        require!(
            mandate.status != MandateStatus::Closed,
            ConduitError::MandateNotActive
        );

        mandate.status = status;
        Ok(())
    }

    /// Opens the desk that settlements trade against.
    ///
    /// Called once. The desk is funded afterwards by ordinary transfers into
    /// its token accounts, which is deliberate: funding it is not a privileged
    /// operation this program needs to model, it is somebody sending tokens to
    /// an address.
    pub fn initialize_desk(ctx: Context<InitializeDesk>) -> Result<()> {
        let desk = &mut ctx.accounts.desk;
        desk.authority = ctx.accounts.authority.key();
        desk.cash_mint = ctx.accounts.cash_mint.key();
        desk.bump = ctx.bumps.desk;
        Ok(())
    }


    /// Opens a person's main wallet and names the agent that may act on it.
    ///
    /// The one signature the owner gives for convenience. After it the agent
    /// can trade, fund mandates and withdraw on the owner's word without a
    /// wallet prompt, because every way money can leave is fixed by the
    /// program: to the desk at the published price, into the same owner's
    /// mandates, or back to the owner.
    pub fn open_wallet(ctx: Context<OpenWallet>, agent: Pubkey) -> Result<()> {
        let wallet = &mut ctx.accounts.wallet;
        wallet.owner = ctx.accounts.owner.key();
        wallet.agent = agent;
        wallet.bump = ctx.bumps.wallet;
        wallet.created_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// States which feed the desk prices a mint by.
    ///
    /// Signed by the desk authority. A main wallet has no mandate to bind its
    /// assets to feeds, so the counterparty does it, and a trade reads the
    /// binding from here rather than trusting the caller to pair a mint with
    /// the right price.
    pub fn register_desk_asset(ctx: Context<RegisterDeskAsset>, feed_id: [u8; 32]) -> Result<()> {
        require!(feed_id != [0u8; 32], ConduitError::PriceUnusable);
        let asset = &mut ctx.accounts.desk_asset;
        asset.mint = ctx.accounts.mint.key();
        asset.feed_id = feed_id;
        asset.bump = ctx.bumps.desk_asset;
        Ok(())
    }

    /// Buys or sells one asset in a main wallet, for a cash amount.
    ///
    /// No mandate is consulted: this is the owner's own money traded on their
    /// word. What the program does fix is everything a dishonest caller could
    /// otherwise choose. The price comes from the feed the desk bound to this
    /// mint, never from the caller. Both legs land in this wallet or the desk.
    /// Rounding goes against the wallet, so a trade can never pay out a unit
    /// the desk did not receive.
    ///
    /// A buy spends `amount` of cash. A sell raises at most `amount` of cash,
    /// selling the whole units that amount buys at the published price.
    pub fn trade(ctx: Context<Trade>, buying: bool, amount: u64) -> Result<()> {
        require_wallet_signer(&ctx.accounts.wallet, &ctx.accounts.signer.key())?;
        require!(amount > 0, ConduitError::TradeTooSmall);

        let now = Clock::get()?.unix_timestamp;
        let price = price_from(
            &ctx.accounts.price.to_account_info(),
            &ctx.accounts.desk_asset.feed_id,
            now,
        )?;

        let asset_decimals = ctx.accounts.mint.decimals;
        let cash_decimals = ctx.accounts.cash_mint.decimals;
        let quantity = quantity_for(amount, asset_decimals, price, cash_decimals)?;
        require!(quantity > 0, ConduitError::TradeTooSmall);

        let owner_key = ctx.accounts.wallet.owner;
        let wallet_seeds: &[&[u8]] = &[WALLET_SEED, owner_key.as_ref(), &[ctx.accounts.wallet.bump]];
        let desk_seeds: &[&[u8]] = &[DESK_SEED, &[ctx.accounts.desk.bump]];
        let token_program = ctx.accounts.token_program.to_account_info();

        let (asset_amount, cash_amount) = if buying {
            require!(
                ctx.accounts.wallet_cash.amount >= amount,
                ConduitError::InsufficientBalance
            );
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.clone(),
                    Transfer {
                        from: ctx.accounts.wallet_cash.to_account_info(),
                        to: ctx.accounts.desk_cash.to_account_info(),
                        authority: ctx.accounts.wallet.to_account_info(),
                    },
                    &[wallet_seeds],
                ),
                amount,
            )?;
            token::transfer(
                CpiContext::new_with_signer(
                    token_program,
                    Transfer {
                        from: ctx.accounts.desk_holding.to_account_info(),
                        to: ctx.accounts.wallet_asset.to_account_info(),
                        authority: ctx.accounts.desk.to_account_info(),
                    },
                    &[desk_seeds],
                ),
                quantity,
            )?;
            (quantity, amount)
        } else {
            require!(
                ctx.accounts.wallet_asset.amount >= quantity,
                ConduitError::InsufficientBalance
            );
            // Valued again from the units actually sold, rounded down, so the
            // cash paid out never exceeds what those units are worth.
            let proceeds = value_of(quantity, asset_decimals, price, cash_decimals)?;
            require!(proceeds > 0, ConduitError::TradeTooSmall);
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.clone(),
                    Transfer {
                        from: ctx.accounts.wallet_asset.to_account_info(),
                        to: ctx.accounts.desk_holding.to_account_info(),
                        authority: ctx.accounts.wallet.to_account_info(),
                    },
                    &[wallet_seeds],
                ),
                quantity,
            )?;
            token::transfer(
                CpiContext::new_with_signer(
                    token_program,
                    Transfer {
                        from: ctx.accounts.desk_cash.to_account_info(),
                        to: ctx.accounts.wallet_cash.to_account_info(),
                        authority: ctx.accounts.desk.to_account_info(),
                    },
                    &[desk_seeds],
                ),
                proceeds,
            )?;
            (quantity, proceeds)
        };

        emit!(WalletTraded {
            wallet: ctx.accounts.wallet.key(),
            owner: owner_key,
            signer: ctx.accounts.signer.key(),
            mint: ctx.accounts.mint.key(),
            buying,
            asset_amount,
            cash_amount,
            timestamp: now,
        });
        Ok(())
    }

    /// Moves money from the main wallet into one of the same owner's mandates.
    ///
    /// The owner or the agent. Money going into a mandate only ever gets more
    /// constrained, so there is nothing here the agent could use to escape a
    /// limit.
    pub fn move_to_mandate(ctx: Context<MoveToMandate>, amount: u64) -> Result<()> {
        require_wallet_signer(&ctx.accounts.wallet, &ctx.accounts.signer.key())?;
        require!(
            ctx.accounts.portfolio.owner == ctx.accounts.wallet.owner,
            ConduitError::WalletOwnerMismatch
        );
        require!(
            ctx.accounts.from.amount >= amount && amount > 0,
            ConduitError::InsufficientBalance
        );

        let owner_key = ctx.accounts.wallet.owner;
        let wallet_seeds: &[&[u8]] = &[WALLET_SEED, owner_key.as_ref(), &[ctx.accounts.wallet.bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.wallet.to_account_info(),
                },
                &[wallet_seeds],
            ),
            amount,
        )?;

        emit!(FundsMoved {
            owner: owner_key,
            signer: ctx.accounts.signer.key(),
            from: ctx.accounts.wallet.key(),
            to: ctx.accounts.portfolio.key(),
            mint: ctx.accounts.from.mint,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Moves money out of a mandate back into the owner's main wallet.
    ///
    /// Owner only, and this is the one place the agent is refused where the
    /// owner is not. The main wallet has no limits. If the agent could pull
    /// money out of a mandate into it, it could step around every rule the
    /// mandate sets by moving the cash first and trading it after.
    pub fn move_from_mandate(ctx: Context<MoveFromMandate>, amount: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.wallet.owner,
            ConduitError::OwnerOnly
        );
        require!(
            ctx.accounts.portfolio.owner == ctx.accounts.wallet.owner,
            ConduitError::WalletOwnerMismatch
        );
        require!(
            ctx.accounts.from.amount >= amount && amount > 0,
            ConduitError::InsufficientBalance
        );

        let mandate_key = ctx.accounts.portfolio.mandate;
        let portfolio_seeds: &[&[u8]] = &[
            PORTFOLIO_SEED,
            mandate_key.as_ref(),
            &[ctx.accounts.portfolio.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.portfolio.to_account_info(),
                },
                &[portfolio_seeds],
            ),
            amount,
        )?;

        emit!(FundsMoved {
            owner: ctx.accounts.wallet.owner,
            signer: ctx.accounts.owner.key(),
            from: ctx.accounts.portfolio.key(),
            to: ctx.accounts.wallet.key(),
            mint: ctx.accounts.from.mint,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Sends money from the main wallet back to the owner.
    ///
    /// The owner or the agent, because the destination is fixed: a token
    /// account the owner holds, checked here. The agent can carry out "send
    /// my money back" without a wallet prompt, and a stolen agent key can do
    /// nothing with this but return the owner's money to them.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require_wallet_signer(&ctx.accounts.wallet, &ctx.accounts.signer.key())?;
        require!(
            ctx.accounts.destination.owner == ctx.accounts.wallet.owner,
            ConduitError::DestinationNotOwner
        );
        require!(
            ctx.accounts.from.amount >= amount && amount > 0,
            ConduitError::InsufficientBalance
        );

        let owner_key = ctx.accounts.wallet.owner;
        let wallet_seeds: &[&[u8]] = &[WALLET_SEED, owner_key.as_ref(), &[ctx.accounts.wallet.bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.wallet.to_account_info(),
                },
                &[wallet_seeds],
            ),
            amount,
        )?;

        emit!(FundsMoved {
            owner: owner_key,
            signer: ctx.accounts.signer.key(),
            from: ctx.accounts.wallet.key(),
            to: ctx.accounts.destination.key(),
            mint: ctx.accounts.from.mint,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Sends money from a mandate straight back to the owner.
    ///
    /// The owner or the mandate's agent. Unlike moving money into the main
    /// wallet, this cannot be used to escape a limit: the money leaves the
    /// system entirely, to an account only the owner controls.
    pub fn withdraw_from_mandate(ctx: Context<WithdrawFromMandate>, amount: u64) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        require!(
            signer == ctx.accounts.mandate.owner || signer == ctx.accounts.mandate.agent,
            ConduitError::UnauthorizedWalletSigner
        );
        require!(
            ctx.accounts.destination.owner == ctx.accounts.mandate.owner,
            ConduitError::DestinationNotOwner
        );
        require!(
            ctx.accounts.from.amount >= amount && amount > 0,
            ConduitError::InsufficientBalance
        );

        let mandate_key = ctx.accounts.mandate.key();
        let portfolio_seeds: &[&[u8]] = &[
            PORTFOLIO_SEED,
            mandate_key.as_ref(),
            &[ctx.accounts.portfolio.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.portfolio.to_account_info(),
                },
                &[portfolio_seeds],
            ),
            amount,
        )?;

        emit!(FundsMoved {
            owner: ctx.accounts.mandate.owner,
            signer,
            from: ctx.accounts.portfolio.key(),
            to: ctx.accounts.destination.key(),
            mint: ctx.accounts.from.mint,
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Names the one key allowed to publish prices.
    ///
    /// Called once, by whoever deploys. Deliberately a different key from the
    /// agent and from any mandate owner, because the entire value of this
    /// account is that it is not the agent: an agent able to write its own
    /// marks could satisfy any mandate while doing anything at all.
    pub fn initialize_publisher(ctx: Context<InitializePublisher>) -> Result<()> {
        let publisher = &mut ctx.accounts.publisher;
        publisher.authority = ctx.accounts.authority.key();
        publisher.bump = ctx.bumps.publisher;
        Ok(())
    }

    /// Writes a price for an asset no oracle will price.
    ///
    /// Used for the tokenized equities, which Pyth gates behind a commercial
    /// grant, and for the pre IPO names, which have no market price anywhere
    /// because there is no market to observe. For those the issuer's mark is
    /// the price of record, and this is where that mark is recorded on chain.
    ///
    /// The checks here are the ones that can be made without trusting the
    /// caller's judgement. A price must be positive, its exponent must be
    /// negative or zero, its timestamp must be close to the cluster's own
    /// clock, and it must be newer than whatever is already stored. None of
    /// that makes the number true. It makes the account behave like a feed
    /// rather than a mutable variable, so that a stale or replayed write cannot
    /// quietly become the price a settlement runs at.
    pub fn publish_price(
        ctx: Context<PublishPrice>,
        feed_id: [u8; 32],
        price: u64,
        exponent: i32,
        publish_time: i64,
        source: String,
    ) -> Result<()> {
        require!(feed_id != [0u8; 32], ConduitError::PriceUnusable);
        require!(price > 0, ConduitError::PriceUnusable);
        require!(exponent <= 0, ConduitError::PriceUnusable);
        require!(source.len() <= 16, ConduitError::PriceUnusable);

        let now = Clock::get()?.unix_timestamp;
        require!(
            now.saturating_sub(publish_time) <= MAX_PRICE_AGE_SECONDS,
            ConduitError::PriceUnusable
        );
        require!(
            publish_time.saturating_sub(now) <= MAX_PRICE_AGE_SECONDS,
            ConduitError::PriceUnusable
        );

        let feed = &mut ctx.accounts.price;

        // Monotonic, which is what makes a replay useless. Without it an old
        // signed write could be resubmitted later and would look current.
        require!(
            feed.publish_time < publish_time,
            ConduitError::PriceNotNewer
        );

        feed.feed_id = feed_id;
        feed.price = price;
        feed.exponent = exponent;
        feed.publish_time = publish_time;
        feed.source = source;
        feed.bump = ctx.bumps.price;

        emit!(PricePublished {
            feed_id,
            price,
            exponent,
            publish_time,
        });

        Ok(())
    }

    /// Moves tokens until the portfolio actually holds what it says it targets.
    ///
    /// Everything up to this point has been policy. `propose_rebalance` decides
    /// what the weights should be and refuses anything the mandate forbids, but
    /// it moves nothing: a position was a number in an account. This is where
    /// value changes hands.
    ///
    /// The prices come from Pyth accounts on chain, each one checked against the
    /// feed id the mandate bound to that asset when it was created. The
    /// portfolio is valued from its actual token balances rather than from
    /// anything it claims about itself, because the balances are the only thing
    /// here that cannot be wrong.
    ///
    /// Signed by the agent, which is consistent rather than a new power. The
    /// agent chooses nothing here: every quantity is derived from targets the
    /// program already accepted and prices it did not supply. It is the same
    /// authority to execute an approved allocation, carried through to the point
    /// where the allocation becomes real.
    ///
    /// Assets are passed as four accounts each, in the order the mandate
    /// permits them: the price update, the mint, the portfolio token account and
    /// the desk token account.
    pub fn settle<'info>(ctx: Context<'_, '_, 'info, 'info, Settle<'info>>) -> Result<()> {
        let mandate = &ctx.accounts.mandate;

        require!(
            mandate.status == MandateStatus::Active,
            ConduitError::MandateNotActive
        );

        let expected = mandate
            .allowed_assets
            .len()
            .checked_mul(4)
            .ok_or(ConduitError::ArithmeticOverflow)?;
        require!(
            ctx.remaining_accounts.len() == expected,
            ConduitError::SettlementAccountsMismatch
        );

        let now = Clock::get()?.unix_timestamp;
        let cash_decimals = ctx.accounts.cash_mint.decimals;

        let mut holdings: Vec<Holding> = Vec::with_capacity(mandate.allowed_assets.len());
        let mut legs_accounts: Vec<(&AccountInfo<'info>, &AccountInfo<'info>)> =
            Vec::with_capacity(mandate.allowed_assets.len());

        for (index, allowed) in mandate.allowed_assets.iter().enumerate() {
            let chunk = &ctx.remaining_accounts[index * 4..index * 4 + 4];
            let (price_info, mint_info, portfolio_ata, desk_ata) =
                (&chunk[0], &chunk[1], &chunk[2], &chunk[3]);

            // A price account nobody vouched for is worth nothing, and the
            // owner is what decides whether anybody did. Two owners are
            // accepted and they are not equally trusted, which is the honest
            // position rather than an awkward one.
            //
            // Pyth means many independent publishers observed a market and
            // agreed. This program means one key asserted a number. The second
            // exists because for most of this universe the first is not
            // available at any price: Pyth gates equities behind a commercial
            // grant, and the pre IPO names have no market to observe at all, so
            // the issuer's mark is the price of record.
            //
            // What both share is the property the design rests on. Neither is
            // written by the agent. An agent that could choose its own marks
            // could satisfy any mandate while doing anything it liked.
            let price = price_from(price_info, &allowed.feed_id, now)?;

            require_keys_eq!(
                mint_info.key(),
                allowed.mint,
                ConduitError::SettlementAccountsMismatch
            );

            let mint: Account<'info, Mint> = Account::try_from(mint_info)?;
            let portfolio_token: Account<'info, TokenAccount> = Account::try_from(portfolio_ata)?;
            let desk_token: Account<'info, TokenAccount> = Account::try_from(desk_ata)?;

            require_keys_eq!(
                portfolio_token.owner,
                ctx.accounts.portfolio.key(),
                ConduitError::SettlementAccountsMismatch
            );
            require_keys_eq!(
                portfolio_token.mint,
                allowed.mint,
                ConduitError::SettlementAccountsMismatch
            );
            require_keys_eq!(
                desk_token.owner,
                ctx.accounts.desk.key(),
                ConduitError::SettlementAccountsMismatch
            );
            require_keys_eq!(
                desk_token.mint,
                allowed.mint,
                ConduitError::SettlementAccountsMismatch
            );

            // An asset the portfolio no longer targets is a target of zero
            // rather than an omission, which is what closes a position.
            let target_bps = ctx
                .accounts
                .portfolio
                .positions
                .iter()
                .find(|p| p.mint == allowed.mint)
                .map(|p| p.target_bps)
                .unwrap_or(0);

            holdings.push(Holding {
                balance: portfolio_token.amount,
                decimals: mint.decimals,
                price,
                target_bps,
            });
            legs_accounts.push((portfolio_ata, desk_ata));
        }

        let nav = net_asset_value(
            ctx.accounts.portfolio_cash.amount,
            cash_decimals,
            &holdings,
        )?;
        require!(nav > 0, ConduitError::NothingToSettle);

        let mandate_key = ctx.accounts.mandate.key();
        let portfolio_seeds: &[&[u8]] = &[
            PORTFOLIO_SEED,
            mandate_key.as_ref(),
            &[ctx.accounts.portfolio.bump],
        ];
        let desk_seeds: &[&[u8]] = &[DESK_SEED, &[ctx.accounts.desk.bump]];

        let mut executed: u8 = 0;

        for (holding, (portfolio_ata, desk_ata)) in holdings.iter().zip(legs_accounts.iter()) {
            let Some(leg) = leg_for(holding, nav, cash_decimals)? else {
                continue;
            };

            if leg.buying {
                // Asset in from the desk, cash out to it. The desk cannot
                // deliver more than its inventory, and the transfer fails
                // rather than inventing supply.
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: (*desk_ata).clone(),
                            to: (*portfolio_ata).clone(),
                            authority: ctx.accounts.desk.to_account_info(),
                        },
                        &[desk_seeds],
                    ),
                    leg.asset_amount,
                )?;

                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.portfolio_cash.to_account_info(),
                            to: ctx.accounts.desk_cash.to_account_info(),
                            authority: ctx.accounts.portfolio.to_account_info(),
                        },
                        &[portfolio_seeds],
                    ),
                    leg.cash_amount,
                )?;
            } else {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: (*portfolio_ata).clone(),
                            to: (*desk_ata).clone(),
                            authority: ctx.accounts.portfolio.to_account_info(),
                        },
                        &[portfolio_seeds],
                    ),
                    leg.asset_amount,
                )?;

                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.desk_cash.to_account_info(),
                            to: ctx.accounts.portfolio_cash.to_account_info(),
                            authority: ctx.accounts.desk.to_account_info(),
                        },
                        &[desk_seeds],
                    ),
                    leg.cash_amount,
                )?;
            }

            executed = executed.saturating_add(1);
        }

        // The mandate, checked again against what is actually held.
        //
        // Every weight here was already approved by `propose_rebalance`, so this
        // is not re-litigating the policy. It is checking that settling it did
        // what it was supposed to. A mistake in the arithmetic above, or a price
        // that moved between valuation and execution, would show up as a
        // portfolio that breaches its own mandate, and the whole transaction
        // reverts rather than leaving it that way.
        ctx.accounts.portfolio_cash.reload()?;
        let settled_cash = ctx.accounts.portfolio_cash.amount;

        let mut settled: Vec<Holding> = Vec::with_capacity(holdings.len());
        for (holding, (portfolio_ata, _)) in holdings.iter().zip(legs_accounts.iter()) {
            let token: Account<'info, TokenAccount> = Account::try_from(*portfolio_ata)?;
            settled.push(Holding {
                balance: token.amount,
                ..*holding
            });
        }

        let settled_nav = net_asset_value(settled_cash, cash_decimals, &settled)?;
        require!(settled_nav > 0, ConduitError::ArithmeticOverflow);

        for holding in settled.iter() {
            let value = settlement::value_of(
                holding.balance,
                holding.decimals,
                holding.price,
                cash_decimals,
            )?;
            let weight_bps = (value as u128)
                .checked_mul(BPS_DENOMINATOR as u128)
                .ok_or(ConduitError::ArithmeticOverflow)?
                .checked_div(settled_nav as u128)
                .ok_or(ConduitError::ArithmeticOverflow)? as u16;

            require!(
                weight_bps <= mandate.constraints.max_position_bps,
                ConduitError::PositionExceedsMaxSize
            );
        }

        let settled_cash_bps = (settled_cash as u128)
            .checked_mul(BPS_DENOMINATOR as u128)
            .ok_or(ConduitError::ArithmeticOverflow)?
            .checked_div(settled_nav as u128)
            .ok_or(ConduitError::ArithmeticOverflow)? as u16;

        require!(
            settled_cash_bps >= mandate.constraints.min_cash_bps,
            ConduitError::InsufficientCashReserve
        );

        emit!(PortfolioSettled {
            mandate: mandate_key,
            portfolio: ctx.accounts.portfolio.key(),
            agent: ctx.accounts.agent.key(),
            nav: settled_nav,
            cash_bps: settled_cash_bps,
            legs: executed,
            timestamp: now,
        });

        Ok(())
    }
}

/// Emitted on every accepted rebalance.
///
/// The client reads these to build the agent activity feed, so the history shown
/// to the user is reconstructed from chain state rather than from an application
/// database that could disagree with it.
/// A trade in a main wallet, on the owner's word rather than a mandate.
#[event]
pub struct WalletTraded {
    pub wallet: Pubkey,
    pub owner: Pubkey,
    /// The owner, or the agent acting for them.
    pub signer: Pubkey,
    pub mint: Pubkey,
    pub buying: bool,
    pub asset_amount: u64,
    pub cash_amount: u64,
    pub timestamp: i64,
}

/// Money moving between an owner's wallets, or back to the owner.
#[event]
pub struct FundsMoved {
    pub owner: Pubkey,
    pub signer: Pubkey,
    pub from: Pubkey,
    pub to: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

/// A price entering the chain, so the history of what a settlement could have
/// run at is recoverable without watching every account.
#[event]
pub struct PricePublished {
    pub feed_id: [u8; 32],
    pub price: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

#[event]
pub struct RebalanceExecuted {
    pub mandate: Pubkey,
    pub portfolio: Pubkey,
    pub agent: Pubkey,
    pub turnover_bps: u16,
    pub cash_bps: u16,
    pub position_count: u8,
    pub sequence: u64,
    pub timestamp: i64,
}

/// Emitted when a settlement actually moves tokens.
///
/// Separate from RebalanceExecuted on purpose. That one records a decision, this
/// one records value changing hands, and conflating the two would make a
/// portfolio look settled because somebody approved a target.
#[event]
pub struct PortfolioSettled {
    pub mandate: Pubkey,
    pub portfolio: Pubkey,
    pub agent: Pubkey,
    /// Portfolio value in cash base units, after settling.
    pub nav: u64,
    pub cash_bps: u16,
    /// How many assets actually traded. Zero means it was already in line.
    pub legs: u8,
    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct InitializeDesk<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Desk::INIT_SPACE,
        seeds = [DESK_SEED],
        bump,
    )]
    pub desk: Account<'info, Desk>,

    pub cash_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenWallet<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + MainWallet::INIT_SPACE,
        seeds = [WALLET_SEED, owner.key().as_ref()],
        bump,
    )]
    pub wallet: Account<'info, MainWallet>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterDeskAsset<'info> {
    #[account(seeds = [DESK_SEED], bump = desk.bump, has_one = authority)]
    pub desk: Account<'info, Desk>,

    #[account(
        init,
        payer = authority,
        space = 8 + DeskAsset::INIT_SPACE,
        seeds = [DESK_ASSET_SEED, mint.key().as_ref()],
        bump,
    )]
    pub desk_asset: Account<'info, DeskAsset>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(seeds = [WALLET_SEED, wallet.owner.as_ref()], bump = wallet.bump)]
    pub wallet: Account<'info, MainWallet>,

    pub signer: Signer<'info>,

    #[account(seeds = [DESK_SEED], bump = desk.bump)]
    pub desk: Account<'info, Desk>,

    /// The binding that stops a caller pairing this mint with another price.
    #[account(seeds = [DESK_ASSET_SEED, mint.key().as_ref()], bump = desk_asset.bump)]
    pub desk_asset: Account<'info, DeskAsset>,

    /// CHECK: owner and feed id are verified by `price_from` before use.
    pub price: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(address = desk.cash_mint)]
    pub cash_mint: Account<'info, Mint>,

    #[account(mut, token::mint = cash_mint, token::authority = wallet)]
    pub wallet_cash: Account<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = wallet)]
    pub wallet_asset: Account<'info, TokenAccount>,

    #[account(mut, token::mint = cash_mint, token::authority = desk)]
    pub desk_cash: Account<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = desk)]
    pub desk_holding: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MoveToMandate<'info> {
    #[account(seeds = [WALLET_SEED, wallet.owner.as_ref()], bump = wallet.bump)]
    pub wallet: Account<'info, MainWallet>,

    pub signer: Signer<'info>,

    #[account(seeds = [PORTFOLIO_SEED, portfolio.mandate.as_ref()], bump = portfolio.bump)]
    pub portfolio: Account<'info, Portfolio>,

    #[account(mut, token::authority = wallet)]
    pub from: Account<'info, TokenAccount>,

    #[account(mut, token::mint = from.mint, token::authority = portfolio)]
    pub to: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MoveFromMandate<'info> {
    #[account(seeds = [WALLET_SEED, wallet.owner.as_ref()], bump = wallet.bump)]
    pub wallet: Account<'info, MainWallet>,

    pub owner: Signer<'info>,

    #[account(seeds = [PORTFOLIO_SEED, portfolio.mandate.as_ref()], bump = portfolio.bump)]
    pub portfolio: Account<'info, Portfolio>,

    #[account(mut, token::authority = portfolio)]
    pub from: Account<'info, TokenAccount>,

    #[account(mut, token::mint = from.mint, token::authority = wallet)]
    pub to: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [WALLET_SEED, wallet.owner.as_ref()], bump = wallet.bump)]
    pub wallet: Account<'info, MainWallet>,

    pub signer: Signer<'info>,

    #[account(mut, token::authority = wallet)]
    pub from: Account<'info, TokenAccount>,

    #[account(mut, token::mint = from.mint)]
    pub destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawFromMandate<'info> {
    pub mandate: Account<'info, Mandate>,

    #[account(
        seeds = [PORTFOLIO_SEED, mandate.key().as_ref()],
        bump = portfolio.bump,
        has_one = mandate,
    )]
    pub portfolio: Account<'info, Portfolio>,

    pub signer: Signer<'info>,

    #[account(mut, token::authority = portfolio)]
    pub from: Account<'info, TokenAccount>,

    #[account(mut, token::mint = from.mint)]
    pub destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializePublisher<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Publisher::INIT_SPACE,
        seeds = [PUBLISHER_SEED],
        bump,
    )]
    pub publisher: Account<'info, Publisher>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct PublishPrice<'info> {
    #[account(
        seeds = [PUBLISHER_SEED],
        bump = publisher.bump,
        // The whole point of the account. Anyone may read a published price;
        // exactly one key may write one.
        has_one = authority @ ConduitError::UnauthorizedPublisher,
    )]
    pub publisher: Account<'info, Publisher>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + PublishedPrice::INIT_SPACE,
        seeds = [PRICE_SEED, feed_id.as_ref()],
        bump,
    )]
    pub price: Account<'info, PublishedPrice>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    pub mandate: Account<'info, Mandate>,

    #[account(
        seeds = [PORTFOLIO_SEED, mandate.key().as_ref()],
        bump = portfolio.bump,
        constraint = portfolio.mandate == mandate.key() @ ConduitError::SettlementAccountsMismatch,
    )]
    pub portfolio: Account<'info, Portfolio>,

    #[account(seeds = [DESK_SEED], bump = desk.bump)]
    pub desk: Account<'info, Desk>,

    /// The agent executes, and chooses nothing while doing so.
    #[account(constraint = mandate.agent == agent.key() @ ConduitError::UnauthorizedAgent)]
    pub agent: Signer<'info>,

    #[account(constraint = desk.cash_mint == cash_mint.key() @ ConduitError::SettlementAccountsMismatch)]
    pub cash_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = portfolio_cash.owner == portfolio.key() @ ConduitError::SettlementAccountsMismatch,
        constraint = portfolio_cash.mint == cash_mint.key() @ ConduitError::SettlementAccountsMismatch,
    )]
    pub portfolio_cash: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = desk_cash.owner == desk.key() @ ConduitError::SettlementAccountsMismatch,
        constraint = desk_cash.mint == cash_mint.key() @ ConduitError::SettlementAccountsMismatch,
    )]
    pub desk_cash: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(mandate_id: u64)]
pub struct InitializeMandate<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [MANDATE_SEED, owner.key().as_ref(), &mandate_id.to_le_bytes()],
        bump
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializePortfolio<'info> {
    #[account(
        has_one = owner @ ConduitError::UnauthorizedOwner,
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        init,
        payer = owner,
        space = 8 + Portfolio::INIT_SPACE,
        seeds = [PORTFOLIO_SEED, mandate.key().as_ref()],
        bump
    )]
    pub portfolio: Account<'info, Portfolio>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeRebalance<'info> {
    /// `has_one = agent` is the delegation boundary. Any signer other than the
    /// agent named in the mandate is refused before the proposal is even read.
    #[account(
        mut,
        has_one = agent @ ConduitError::UnauthorizedAgent,
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        mut,
        seeds = [PORTFOLIO_SEED, mandate.key().as_ref()],
        bump = portfolio.bump,
    )]
    pub portfolio: Account<'info, Portfolio>,

    pub agent: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetMandateStatus<'info> {
    #[account(
        mut,
        has_one = owner @ ConduitError::UnauthorizedOwner,
    )]
    pub mandate: Account<'info, Mandate>,

    pub owner: Signer<'info>,
}
