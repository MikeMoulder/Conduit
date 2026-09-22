use anchor_lang::prelude::*;

/// The counterparty.
///
/// A purchase needs someone on the other side of it. Our devnet mints have no
/// pools and no order books, so there is nobody to trade with unless one is
/// provided, and minting on demand would look like trading while actually being
/// printing.
///
/// So the desk holds inventory. It is funded once, up front, with a finite
/// amount of each asset and of cash, and it swaps at the oracle price. That is
/// not a workaround for the absence of a venue, it is how tokenized equities
/// genuinely work in the primary market: you do not find a seller, you create
/// and redeem with the issuer at net asset value.
///
/// Its inventory lives in ordinary token accounts owned by this PDA, so what it
/// holds is visible to anyone who looks, and it cannot pay out more than it has.
#[account]
#[derive(InitSpace)]
pub struct Desk {
    /// May fund the desk and withdraw from it. Never signs a settlement.
    pub authority: Pubkey,
    /// The settlement currency every trade is priced in.
    pub cash_mint: Pubkey,
    pub bump: u8,
}
