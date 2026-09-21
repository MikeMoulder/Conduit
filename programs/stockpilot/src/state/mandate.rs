use anchor_lang::prelude::*;

use crate::constants::{BPS_DENOMINATOR, MAX_ASSETS};
use crate::errors::StockpilotError;

/// Lifecycle of a mandate.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MandateStatus {
    /// Accepting proposals from the delegated agent.
    Active,
    /// Owner has suspended the agent. Existing positions are untouched.
    Paused,
    /// Terminal. No further proposals will ever be accepted.
    Closed,
}

/// One asset the mandate permits the agent to hold.
///
/// Identity is the SPL mint, because that is what actually moves on chain. The
/// Pyth feed id is carried alongside so valuation cannot be pointed at a
/// different instrument than the one being held: the binding between "what I own"
/// and "what price I mark it at" is fixed when the mandate is created, not chosen
/// later by whoever submits a proposal.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct AllowedAsset {
    pub mint: Pubkey,
    pub feed_id: [u8; 32],
}

/// The numeric limits a proposal is checked against.
///
/// Separated from the account struct so the checking logic can be unit tested as
/// a pure function, with no validator, no accounts and no runtime.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct MandateConstraints {
    /// Largest share any single position may occupy.
    pub max_position_bps: u16,
    /// Smallest share that must remain in cash.
    pub min_cash_bps: u16,
    /// Largest share of the portfolio that may change hands in one rebalance.
    pub max_turnover_bps: u16,
    /// Largest number of simultaneous positions.
    pub max_assets: u8,
}

impl MandateConstraints {
    /// Rejects constraint sets that are malformed or self defeating.
    ///
    /// Run once at mandate creation rather than on every proposal. Catching an
    /// incoherent mandate at birth is far kinder than letting the user discover
    /// months later that their agent was never able to do what they asked.
    pub fn validate(&self) -> Result<()> {
        require!(
            self.max_position_bps <= BPS_DENOMINATOR
                && self.min_cash_bps <= BPS_DENOMINATOR
                && self.max_turnover_bps <= BPS_DENOMINATOR,
            StockpilotError::InvalidBasisPoints
        );

        require!(
            self.max_assets as usize <= MAX_ASSETS && self.max_assets > 0,
            StockpilotError::TooManyAssets
        );

        require!(self.max_position_bps > 0, StockpilotError::ContradictoryConstraints);

        // Coherence check. The most the agent may ever deploy is
        // max_assets * max_position_bps. Add the cash the agent must always hold
        // back. If those together cannot account for the whole portfolio, the
        // mandate silently forces idle cash the user never asked to hold, which
        // almost always means they mis-stated one of the limits.
        let max_deployable = (self.max_assets as u32)
            .checked_mul(self.max_position_bps as u32)
            .ok_or(StockpilotError::ArithmeticOverflow)?;

        let reachable = max_deployable
            .checked_add(self.min_cash_bps as u32)
            .ok_or(StockpilotError::ArithmeticOverflow)?;

        require!(
            reachable >= BPS_DENOMINATOR as u32,
            StockpilotError::ContradictoryConstraints
        );

        Ok(())
    }
}

/// The constitution.
///
/// This account is the reason the project exists. The agent holds no authority of
/// its own: it may only submit proposals, and every proposal is re-checked
/// against this account by the program before anything moves. The agent cannot
/// edit these limits, cannot withdraw, and cannot replace itself. Those are not
/// promises made by a model, they are instructions it has no way to reach.
#[account]
#[derive(InitSpace)]
pub struct Mandate {
    /// Sole authority permitted to amend, pause or close this mandate.
    pub owner: Pubkey,
    /// Delegated proposer. May propose rebalances and nothing else.
    pub agent: Pubkey,
    /// Limits every proposal is measured against.
    pub constraints: MandateConstraints,
    /// Universe of assets the agent may hold.
    #[max_len(MAX_ASSETS)]
    pub allowed_assets: Vec<AllowedAsset>,
    pub status: MandateStatus,
    /// Layout version, so a future migration can tell accounts apart.
    pub version: u16,
    pub bump: u8,
    pub created_at: i64,
    pub rebalance_count: u64,
    pub last_rebalance_at: i64,
}

impl Mandate {
    pub const VERSION: u16 = 1;

    /// True when the mint appears in the permitted universe.
    pub fn permits_asset(&self, mint: &Pubkey) -> bool {
        self.allowed_assets.iter().any(|a| a.mint == *mint)
    }
}
