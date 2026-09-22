//! CONDUIT: on chain enforcement of an investment mandate.
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

use constants::{BPS_DENOMINATOR, DESK_SEED, MANDATE_SEED, MAX_ASSETS, PORTFOLIO_SEED};
use errors::ConduitError;
use policy::{evaluate_proposal, ProposedPosition};
use settlement::{leg_for, net_asset_value, read_price, Holding, PYTH_RECEIVER};
use state::{
    AllowedAsset, Desk, Mandate, MandateConstraints, MandateStatus, Portfolio, Position,
};

declare_id!("6X7wfnLNHQvW94CHPVFdguraojh5uEN3Y1gjfi2pkxVu");

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

            // A price account nobody vouched for is worth nothing. The owner
            // check is what stops a caller supplying their own.
            require_keys_eq!(
                *price_info.owner,
                PYTH_RECEIVER,
                ConduitError::PriceUnusable
            );
            let price = read_price(&price_info.try_borrow_data()?, &allowed.feed_id, now)?;

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
