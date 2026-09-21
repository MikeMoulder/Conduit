use anchor_lang::prelude::*;

/// Every way a proposal can be refused.
///
/// These are intentionally granular. When the chain rejects an agent's proposal
/// the user is entitled to know precisely which clause of their mandate was
/// breached, and a single generic "invalid allocation" error would make the
/// enforcement look arbitrary rather than principled.
#[error_code]
pub enum StockpilotError {
    #[msg("Mandate is not active, so it cannot accept proposals")]
    MandateNotActive,

    #[msg("Signer is not the agent delegated by this mandate")]
    UnauthorizedAgent,

    #[msg("Signer is not the owner of this mandate")]
    UnauthorizedOwner,

    #[msg("Proposal references more assets than the mandate permits")]
    TooManyAssets,

    #[msg("Proposal references an asset outside the mandate's permitted universe")]
    AssetNotAllowed,

    #[msg("Proposal references the same asset more than once")]
    DuplicateAsset,

    #[msg("A single position exceeds the mandate's maximum position size")]
    PositionExceedsMaxSize,

    #[msg("Proposal leaves less cash than the mandate's minimum reserve")]
    InsufficientCashReserve,

    #[msg("Allocations and cash must sum to exactly 10000 basis points")]
    AllocationMustSumToFull,

    #[msg("Proposal turnover exceeds the mandate's per rebalance limit")]
    TurnoverExceeded,

    #[msg("A basis point value exceeds 10000")]
    InvalidBasisPoints,

    #[msg("Mandate constraints are internally contradictory and can never be satisfied")]
    ContradictoryConstraints,

    #[msg("Arithmetic overflow while evaluating the proposal")]
    ArithmeticOverflow,

    #[msg("The mandate's permitted asset universe is empty")]
    EmptyAssetUniverse,
}
