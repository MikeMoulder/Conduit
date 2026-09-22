use anchor_lang::prelude::*;

/// The price source for everything no oracle will price.
///
/// Why this exists
/// ---------------
/// Settlement needs a price the program can verify itself, and for most of this
/// universe none is available. Pyth prices crypto and gates equities behind a
/// commercial grant. Switchboard is shutting down. RedStone carries the
/// equities but reaches Solana through a path we cannot stand up in the time we
/// have.
///
/// And for the pre IPO names the problem is not procurement, it is that the
/// price does not exist. OPENAI and SPACEX have no market. No oracle anywhere
/// publishes them, because there is nothing to observe. The issuer marks them,
/// and that mark is the price of record.
///
/// So for those assets a trusted publisher is not a shortcut around a
/// decentralised oracle. It is the same thing the real instrument does.
///
/// What it does and does not claim
/// -------------------------------
/// This is weaker than an oracle network and the difference should be stated
/// rather than blurred. An oracle means many parties independently observed a
/// market and agreed. This means one key asserted a number. Anyone reading a
/// settlement priced this way is trusting whoever holds that key.
///
/// What it does preserve is the property the whole design rests on: the agent
/// cannot choose the price. The publishing authority is a different key from
/// the agent key, the agent cannot reach this instruction, and a settlement is
/// valued from accounts the agent does not write. An agent that could pick its
/// own marks could satisfy any mandate while doing anything at all, and that
/// remains impossible.
#[account]
#[derive(InitSpace)]
pub struct Publisher {
    /// The only key that may write a price. Never the agent, never the owner.
    pub authority: Pubkey,
    pub bump: u8,
}

/// One published price, in the same shape the program reads from Pyth.
///
/// Deliberately the same fields Pyth carries, so that valuation does not care
/// where a price came from. Everything downstream of reading takes a value and
/// an exponent, and it should stay that way: the difference between sources
/// belongs at the boundary where trust is decided, not spread through the
/// arithmetic.
///
/// Stored per feed at a PDA of the feed id, so the address is derivable by
/// anyone and cannot be substituted. A caller who passes a different account
/// passes one whose recorded feed id does not match what the mandate named, and
/// that is checked before the number is used.
#[account]
#[derive(InitSpace)]
pub struct PublishedPrice {
    /// What this prices. Matched against the feed id the mandate recorded.
    pub feed_id: [u8; 32],
    /// Always positive. A non positive price is refused at publication.
    pub price: u64,
    /// Base ten exponent, negative for a USD price.
    pub exponent: i32,
    /// When the publisher observed it, not when the transaction landed.
    pub publish_time: i64,
    /// Where it came from, recorded so a reader can see what it is trusting.
    #[max_len(16)]
    pub source: String,
    pub bump: u8,
}
