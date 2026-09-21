//! STOCKPILOT: on chain enforcement of an investment mandate.
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

pub mod constants;
pub mod errors;
pub mod policy;
pub mod state;

use constants::{MANDATE_SEED, MAX_ASSETS, PORTFOLIO_SEED};
use errors::StockpilotError;
use policy::{evaluate_proposal, ProposedPosition};
use state::{AllowedAsset, Mandate, MandateConstraints, MandateStatus, Portfolio, Position};

declare_id!("6X7wfnLNHQvW94CHPVFdguraojh5uEN3Y1gjfi2pkxVu");

#[program]
pub mod stockpilot {
    use super::*;

    /// Creates a mandate: the constitution a portfolio will operate under.
    ///
    /// Constraints are validated here rather than on first use, so an incoherent
    /// mandate fails immediately at the point the owner can still fix it.
    pub fn initialize_mandate(
        ctx: Context<InitializeMandate>,
        _mandate_id: u64,
        constraints: MandateConstraints,
        allowed_assets: Vec<AllowedAsset>,
        agent: Pubkey,
    ) -> Result<()> {
        require!(
            !allowed_assets.is_empty(),
            StockpilotError::EmptyAssetUniverse
        );
        require!(
            allowed_assets.len() <= MAX_ASSETS,
            StockpilotError::TooManyAssets
        );

        // A universe containing the same mint twice would let a proposal satisfy
        // the permitted-asset check through either entry while the owner believes
        // they authorised one instrument.
        for (i, asset) in allowed_assets.iter().enumerate() {
            require!(
                !allowed_assets[..i].iter().any(|a| a.mint == asset.mint),
                StockpilotError::DuplicateAsset
            );
        }

        constraints.validate()?;

        let mandate = &mut ctx.accounts.mandate;
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
            StockpilotError::MandateNotActive
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
            .ok_or(StockpilotError::ArithmeticOverflow)?;
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
            StockpilotError::MandateNotActive
        );

        mandate.status = status;
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
        has_one = owner @ StockpilotError::UnauthorizedOwner,
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
        has_one = agent @ StockpilotError::UnauthorizedAgent,
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
        has_one = owner @ StockpilotError::UnauthorizedOwner,
    )]
    pub mandate: Account<'info, Mandate>,

    pub owner: Signer<'info>,
}
