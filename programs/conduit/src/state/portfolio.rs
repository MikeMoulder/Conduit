use anchor_lang::prelude::*;

use crate::constants::MAX_ASSETS;

/// A single holding, expressed as a target share of the portfolio.
///
/// Target weight rather than token amount is stored here on purpose. Weights are
/// what the mandate constrains and what survives a price move; token amounts are
/// a settlement detail that belongs with the token accounts themselves.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Position {
    pub mint: Pubkey,
    pub target_bps: u16,
}

/// The live allocation operating under a mandate.
#[account]
#[derive(InitSpace)]
pub struct Portfolio {
    /// Mandate governing this portfolio. Immutable once set.
    pub mandate: Pubkey,
    pub owner: Pubkey,
    #[max_len(MAX_ASSETS)]
    pub positions: Vec<Position>,
    /// Share currently held in cash. Positions plus cash always total 10000 bps.
    pub cash_bps: u16,
    pub bump: u8,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Portfolio {
    /// Current weight of a mint, or zero when it is not held.
    pub fn weight_of(&self, mint: &Pubkey) -> u16 {
        self.positions
            .iter()
            .find(|p| p.mint == *mint)
            .map(|p| p.target_bps)
            .unwrap_or(0)
    }
}
