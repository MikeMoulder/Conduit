use anchor_lang::prelude::*;

/// A person's main wallet inside Conduit.
///
/// Where they keep money the agent trades on their word rather than on its own
/// judgement: "buy $3,000 of NVDA" typed into a chat window, executed without a
/// wallet prompt. That convenience is the reason it exists, and the design is
/// about what the convenience must never cost.
///
/// It is a program derived address seeded by the owner's key, so it is bound to
/// exactly one person and nobody holds a private key for it. Not the owner, not
/// the agent, not the operator. Money leaves it only through this program, and
/// the program lets money leave in three ways and no others:
///
///   - traded with the desk, at the published price, into this same wallet
///   - moved into one of the same owner's mandate wallets
///   - withdrawn to a token account the owner holds
///
/// So the agent key can act here without a signature from the owner, and the
/// worst a stolen agent key can do is trade at market prices or send the owner
/// their own money. It cannot send it anywhere else.
///
/// What it deliberately does not have is a mandate. Trades here are the
/// owner's decisions relayed by the agent, and the program cannot tell a relayed
/// decision from one the agent made up. That is the honest trade for not
/// signing every order: the owner trusts the app with what to trade here, and
/// never with custody. Money the agent decides about belongs in a mandate
/// wallet, where the chain checks every decision.
#[account]
#[derive(InitSpace)]
pub struct MainWallet {
    pub owner: Pubkey,
    /// The one other key that may act on this wallet.
    pub agent: Pubkey,
    pub bump: u8,
    pub created_at: i64,
}

/// Which price feed the desk trades a mint at.
///
/// A mandate binds each asset to a feed when its owner signs it. A main wallet
/// has no mandate, so the binding has to come from somewhere else, and it comes
/// from the desk: the counterparty states what it prices each instrument by.
/// Without it a caller could pass one asset's mint with another asset's price
/// and buy a share of NVDA at the price of something cheaper.
#[account]
#[derive(InitSpace)]
pub struct DeskAsset {
    pub mint: Pubkey,
    pub feed_id: [u8; 32],
    pub bump: u8,
}
