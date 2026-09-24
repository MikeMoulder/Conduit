/// Basis points denominator. 10_000 bps == 100.00%.
///
/// Every proportion in this program is expressed in basis points held in a u16.
/// Floating point is deliberately absent: it is not deterministic across
/// platforms, cannot represent most decimal fractions exactly, and has no place
/// in constraints that decide whether someone's money moves.
pub const BPS_DENOMINATOR: u16 = 10_000;

/// Maximum number of distinct assets a single mandate may reference.
///
/// This is a hard ceiling on account size, not a user facing limit. Accounts are
/// fixed size at initialization, so this value is baked into the rent paid by the
/// mandate creator. Eight is generous for a retail portfolio while keeping the
/// mandate account small enough to stay cheap.
pub const MAX_ASSETS: usize = 8;

/// PDA seed prefix for mandate accounts.
pub const MANDATE_SEED: &[u8] = b"mandate";

/// PDA seed prefix for portfolio accounts.
pub const PORTFOLIO_SEED: &[u8] = b"portfolio";

/// Seed for the settlement desk. One per deployment.
pub const DESK_SEED: &[u8] = b"desk";

/// The single account naming who may publish a price.
pub const PUBLISHER_SEED: &[u8] = b"publisher";

/// One published price per feed, addressed by the feed it carries so that the
/// account for a given instrument is derivable rather than announced.
pub const PRICE_SEED: &[u8] = b"price";

/// A person's main wallet, one per owner.
pub const WALLET_SEED: &[u8] = b"wallet";

/// The desk's statement of which feed prices a mint.
pub const DESK_ASSET_SEED: &[u8] = b"desk_asset";
