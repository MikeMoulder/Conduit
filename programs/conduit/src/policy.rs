use anchor_lang::prelude::*;

use crate::constants::BPS_DENOMINATOR;
use crate::errors::ConduitError;
use crate::state::{AllowedAsset, MandateConstraints, Position};

/// A target weight the agent is asking for.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct ProposedPosition {
    pub mint: Pubkey,
    pub target_bps: u16,
}

/// What a proposal works out to once it has passed every check.
///
/// Returned rather than recomputed by the caller so the values the program acts
/// on are provably the same values it validated.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ProposalReport {
    /// Residual cash implied by the proposed weights.
    pub cash_bps: u16,
    /// Share of the portfolio changing hands, already halved.
    pub turnover_bps: u16,
    /// Number of positions after the rebalance.
    pub position_count: u8,
}

/// Decides whether a proposal is permitted by a mandate.
///
/// This is the whole point of the program. The agent may compute whatever it
/// likes off chain; nothing it produces is trusted. Every constraint is
/// re-derived here from the mandate as stored on chain, and any breach refuses
/// the transaction outright.
///
/// Checks run cheapest first so a malformed proposal is rejected before any
/// arithmetic is done on it.
pub fn evaluate_proposal(
    constraints: &MandateConstraints,
    allowed: &[AllowedAsset],
    current: &[Position],
    proposed: &[ProposedPosition],
) -> Result<ProposalReport> {
    require!(!allowed.is_empty(), ConduitError::EmptyAssetUniverse);

    require!(
        proposed.len() <= constraints.max_assets as usize,
        ConduitError::TooManyAssets
    );

    let mut allocated_bps: u32 = 0;

    for (i, position) in proposed.iter().enumerate() {
        require!(
            position.target_bps <= BPS_DENOMINATOR,
            ConduitError::InvalidBasisPoints
        );

        // A zero weight is not an error, but it must not consume one of the
        // mandate's position slots, so it is rejected as malformed rather than
        // silently accepted and stored.
        require!(position.target_bps > 0, ConduitError::InvalidBasisPoints);

        require!(
            position.target_bps <= constraints.max_position_bps,
            ConduitError::PositionExceedsMaxSize
        );

        require!(
            allowed.iter().any(|a| a.mint == position.mint),
            ConduitError::AssetNotAllowed
        );

        // Quadratic, but bounded by MAX_ASSETS which is 8, so at most 28
        // comparisons. A hash set would allocate, which is worse here.
        require!(
            !proposed[..i].iter().any(|p| p.mint == position.mint),
            ConduitError::DuplicateAsset
        );

        allocated_bps = allocated_bps
            .checked_add(position.target_bps as u32)
            .ok_or(ConduitError::ArithmeticOverflow)?;
    }

    require!(
        allocated_bps <= BPS_DENOMINATOR as u32,
        ConduitError::AllocationMustSumToFull
    );

    // Cash is the residual, never supplied by the agent. Deriving it removes a
    // whole class of proposals that look balanced but are not.
    let cash_bps = (BPS_DENOMINATOR as u32 - allocated_bps) as u16;

    require!(
        cash_bps >= constraints.min_cash_bps,
        ConduitError::InsufficientCashReserve
    );

    let turnover_bps = compute_turnover_bps(current, proposed, cash_bps)?;

    require!(
        turnover_bps <= constraints.max_turnover_bps,
        ConduitError::TurnoverExceeded
    );

    Ok(ProposalReport {
        cash_bps,
        turnover_bps,
        position_count: proposed.len() as u8,
    })
}

/// Share of the portfolio that changes hands to reach the proposed weights.
///
/// Every weight that moves is counted twice, once leaving and once arriving, so
/// the total is halved. Cash is included deliberately: selling a position to sit
/// in cash is turnover, and omitting the cash leg would report it as half of what
/// it really is, letting an agent churn a portfolio while appearing to respect
/// the limit.
fn compute_turnover_bps(
    current: &[Position],
    proposed: &[ProposedPosition],
    proposed_cash_bps: u16,
) -> Result<u16> {
    let mut total_delta: u32 = 0;

    for position in proposed.iter() {
        let previous = current
            .iter()
            .find(|p| p.mint == position.mint)
            .map(|p| p.target_bps)
            .unwrap_or(0);

        total_delta = total_delta
            .checked_add(position.target_bps.abs_diff(previous) as u32)
            .ok_or(ConduitError::ArithmeticOverflow)?;
    }

    // Positions being exited entirely do not appear in the proposal, so they are
    // picked up here. Without this, closing a position would be free.
    for position in current.iter() {
        if !proposed.iter().any(|p| p.mint == position.mint) {
            total_delta = total_delta
                .checked_add(position.target_bps as u32)
                .ok_or(ConduitError::ArithmeticOverflow)?;
        }
    }

    let current_allocated: u32 = current.iter().map(|p| p.target_bps as u32).sum();
    let current_cash = (BPS_DENOMINATOR as u32).saturating_sub(current_allocated) as u16;

    total_delta = total_delta
        .checked_add(proposed_cash_bps.abs_diff(current_cash) as u32)
        .ok_or(ConduitError::ArithmeticOverflow)?;

    Ok((total_delta / 2) as u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::error::Error;

    /// Extracts the numeric code from an Anchor error so assertions target the
    /// specific constraint that fired, not merely that something failed.
    fn code_of(err: &Error) -> u32 {
        match err {
            Error::AnchorError(e) => e.error_code_number,
            Error::ProgramError(_) => u32::MAX,
        }
    }

    fn expect_err<T: std::fmt::Debug>(res: Result<T>, expected: ConduitError) {
        let expected_code = expected as u32 + anchor_lang::error::ERROR_CODE_OFFSET;
        match res {
            Err(e) => assert_eq!(
                code_of(&e),
                expected_code,
                "expected error code {}, got {}",
                expected_code,
                code_of(&e)
            ),
            Ok(v) => panic!("expected a rejection, but the call succeeded with {:?}", v),
        }
    }

    fn constraints() -> MandateConstraints {
        MandateConstraints {
            max_position_bps: 2_500,
            min_cash_bps: 1_500,
            max_turnover_bps: 10_000,
            max_assets: 4,
        }
    }

    /// Constraints with the limits opened up, for tests that isolate one rule.
    fn permissive(max_turnover_bps: u16) -> MandateConstraints {
        MandateConstraints {
            max_position_bps: 10_000,
            min_cash_bps: 0,
            max_turnover_bps,
            max_assets: 4,
        }
    }

    fn universe(mints: &[Pubkey]) -> Vec<AllowedAsset> {
        mints
            .iter()
            .map(|m| AllowedAsset {
                mint: *m,
                feed_id: [0u8; 32],
            })
            .collect()
    }

    fn held(pairs: &[(Pubkey, u16)]) -> Vec<Position> {
        pairs
            .iter()
            .map(|(m, b)| Position {
                mint: *m,
                target_bps: *b,
            })
            .collect()
    }

    fn want(pairs: &[(Pubkey, u16)]) -> Vec<ProposedPosition> {
        pairs
            .iter()
            .map(|(m, b)| ProposedPosition {
                mint: *m,
                target_bps: *b,
            })
            .collect()
    }

    #[test]
    fn accepts_a_compliant_proposal() {
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        let report = evaluate_proposal(
            &constraints(),
            &universe(&[a, b]),
            &[],
            &want(&[(a, 2_500), (b, 2_000)]),
        )
        .expect("compliant proposal must be accepted");

        assert_eq!(report.cash_bps, 5_500);
        assert_eq!(report.position_count, 2);
    }

    #[test]
    fn derives_cash_as_the_residual() {
        let a = Pubkey::new_unique();
        let report =
            evaluate_proposal(&constraints(), &universe(&[a]), &[], &want(&[(a, 2_000)])).unwrap();
        assert_eq!(report.cash_bps, 8_000);
    }

    #[test]
    fn rejects_a_position_above_the_concentration_limit() {
        let a = Pubkey::new_unique();
        expect_err(
            evaluate_proposal(&constraints(), &universe(&[a]), &[], &want(&[(a, 2_501)])),
            ConduitError::PositionExceedsMaxSize,
        );
    }

    #[test]
    fn accepts_a_position_exactly_at_the_concentration_limit() {
        let a = Pubkey::new_unique();
        assert!(
            evaluate_proposal(&constraints(), &universe(&[a]), &[], &want(&[(a, 2_500)])).is_ok(),
            "the limit is inclusive, so exactly max_position_bps must pass"
        );
    }

    #[test]
    fn rejects_a_proposal_that_breaches_the_cash_floor() {
        let mut c = permissive(10_000);
        c.min_cash_bps = 2_000;
        let a = Pubkey::new_unique();
        expect_err(
            evaluate_proposal(&c, &universe(&[a]), &[], &want(&[(a, 8_100)])),
            ConduitError::InsufficientCashReserve,
        );
    }

    #[test]
    fn rejects_more_positions_than_the_mandate_allows() {
        let m: Vec<Pubkey> = (0..5).map(|_| Pubkey::new_unique()).collect();
        let proposal: Vec<(Pubkey, u16)> = m.iter().map(|k| (*k, 1_000)).collect();
        expect_err(
            evaluate_proposal(&constraints(), &universe(&m), &[], &want(&proposal)),
            ConduitError::TooManyAssets,
        );
    }

    #[test]
    fn rejects_an_asset_outside_the_permitted_universe() {
        let (permitted, intruder) = (Pubkey::new_unique(), Pubkey::new_unique());
        expect_err(
            evaluate_proposal(
                &constraints(),
                &universe(&[permitted]),
                &[],
                &want(&[(intruder, 1_000)]),
            ),
            ConduitError::AssetNotAllowed,
        );
    }

    #[test]
    fn rejects_the_same_asset_listed_twice() {
        let a = Pubkey::new_unique();
        expect_err(
            evaluate_proposal(
                &constraints(),
                &universe(&[a]),
                &[],
                &want(&[(a, 1_000), (a, 1_000)]),
            ),
            ConduitError::DuplicateAsset,
        );
    }

    #[test]
    fn rejects_allocations_summing_beyond_one_hundred_percent() {
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        expect_err(
            evaluate_proposal(
                &permissive(10_000),
                &universe(&[a, b]),
                &[],
                &want(&[(a, 6_000), (b, 5_000)]),
            ),
            ConduitError::AllocationMustSumToFull,
        );
    }

    #[test]
    fn rejects_a_zero_weight_position() {
        let a = Pubkey::new_unique();
        expect_err(
            evaluate_proposal(&constraints(), &universe(&[a]), &[], &want(&[(a, 0)])),
            ConduitError::InvalidBasisPoints,
        );
    }

    #[test]
    fn rejects_an_empty_asset_universe() {
        expect_err(
            evaluate_proposal(&constraints(), &[], &[], &[]),
            ConduitError::EmptyAssetUniverse,
        );
    }

    #[test]
    fn counts_the_cash_leg_when_measuring_turnover() {
        // Selling half of a 4000 bps position into cash is 2000 bps of turnover.
        // Ignoring the cash leg would report 1000, letting an agent churn a
        // portfolio at twice the rate its mandate permits.
        let a = Pubkey::new_unique();
        let report = evaluate_proposal(
            &permissive(10_000),
            &universe(&[a]),
            &held(&[(a, 4_000)]),
            &want(&[(a, 2_000)]),
        )
        .unwrap();
        assert_eq!(report.turnover_bps, 2_000);
    }

    #[test]
    fn counts_a_fully_exited_position_as_turnover() {
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        let report = evaluate_proposal(
            &permissive(10_000),
            &universe(&[a, b]),
            &held(&[(a, 3_000), (b, 3_000)]),
            &want(&[(a, 3_000)]),
        )
        .unwrap();
        assert_eq!(
            report.turnover_bps, 3_000,
            "exiting b entirely must count, or closing a position would be free"
        );
    }

    #[test]
    fn measures_a_pure_switch_as_a_single_sided_move() {
        // Moving 2000 bps from a to b is 2000 bps of turnover, not 4000.
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        let report = evaluate_proposal(
            &permissive(10_000),
            &universe(&[a, b]),
            &held(&[(a, 5_000), (b, 1_000)]),
            &want(&[(a, 3_000), (b, 3_000)]),
        )
        .unwrap();
        assert_eq!(report.turnover_bps, 2_000);
    }

    #[test]
    fn rejects_a_proposal_that_churns_past_the_turnover_limit() {
        let a = Pubkey::new_unique();
        expect_err(
            evaluate_proposal(
                &permissive(1_000),
                &universe(&[a]),
                &held(&[(a, 8_000)]),
                &want(&[(a, 2_000)]),
            ),
            ConduitError::TurnoverExceeded,
        );
    }

    #[test]
    fn accepts_constraints_that_can_be_satisfied() {
        assert!(constraints().validate().is_ok());
    }

    #[test]
    fn rejects_constraints_that_cannot_reach_full_allocation() {
        // Four positions capped at 10 percent each, with no cash floor, tops out
        // at 40 percent deployed. The mandate can never express what the user
        // most likely meant, so it is refused at creation rather than surprising
        // them later.
        let mut c = permissive(10_000);
        c.max_position_bps = 1_000;
        expect_err(c.validate(), ConduitError::ContradictoryConstraints);
    }

    #[test]
    fn rejects_constraints_with_out_of_range_basis_points() {
        let mut c = constraints();
        c.min_cash_bps = 10_001;
        expect_err(c.validate(), ConduitError::InvalidBasisPoints);
    }

    #[test]
    fn rejects_constraints_allowing_more_assets_than_account_capacity() {
        let mut c = constraints();
        c.max_assets = 9;
        expect_err(c.validate(), ConduitError::TooManyAssets);
    }
}
