use anchor_lang::prelude::*;

use crate::constants::BPS_DENOMINATOR;
use crate::errors::ConduitError;

/// Turning target weights into token quantities.
///
/// Everything else in this program reasons in basis points, which is why it
/// needs no prices at all: a cap on a share of a portfolio is enforceable
/// without knowing what anything costs. That is a genuine strength and it ends
/// here. Moving tokens means converting a share into a quantity, and a quantity
/// needs a price.
///
/// This module is the conversion, and nothing else. It is pure arithmetic over
/// plain integers so it can be tested without a validator, a token account or a
/// price feed, which matters more here than anywhere else in the program:
/// rounding in the wrong direction does not fail loudly, it quietly leaks value
/// on every settlement.
///
/// Three rules govern all of it.
///
/// Integers throughout. A price is an integer and an exponent, a token balance
/// is an integer and a decimal count, and at no point is either turned into a
/// float. Financial arithmetic that rounds through binary fractions is wrong in
/// a way that is very hard to see.
///
/// Widen before multiplying. A balance times a price overflows u64 with
/// unremarkable inputs, so every product is taken in u128 and narrowed only
/// once the result is known to fit.
///
/// Round against the portfolio. Where a division is inexact the remainder is
/// left with the desk rather than handed to the portfolio, so the error can
/// never accumulate in favour of the account doing the trading. A fraction of
/// one base unit is not worth an argument, but a systematic fraction in the
/// same direction is exactly how these things go wrong.
///
/// The one exception is a target of zero, which means hold none and is settled
/// exactly. Rounding a full exit leaves dust, and a position that can never
/// quite close means a portfolio can never reach full cash.

/// The price of one whole token, as the oracle reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Price {
    /// Always positive by the time it reaches here.
    pub value: u64,
    /// Base ten exponent, effectively always negative for a USD price.
    pub exponent: i32,
}

/// One asset being settled, with everything needed to value and move it.
#[derive(Clone, Copy, Debug)]
pub struct Holding {
    /// Base units currently in the portfolio token account.
    pub balance: u64,
    /// Decimals of the mint, so base units can be related to whole tokens.
    pub decimals: u8,
    pub price: Price,
    /// Share of the portfolio this asset should end up as.
    pub target_bps: u16,
}

/// What one asset settlement requires, in base units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leg {
    /// Base units of the asset to move. Zero means nothing to do.
    pub asset_amount: u64,
    /// Base units of cash moving the other way.
    pub cash_amount: u64,
    /// True when the portfolio is buying, so cash leaves and the asset arrives.
    pub buying: bool,
}

/// Ten to the power of `n`, as u128, refusing anything that would overflow.
fn pow10(n: u32) -> Result<u128> {
    10u128
        .checked_pow(n)
        .ok_or(ConduitError::ArithmeticOverflow.into())
}

/// Value of a holding, in cash base units.
///
/// The arithmetic in full, because the exponents are the part that goes wrong:
///
///   value = balance / 10^asset_decimals        whole tokens
///         * price.value * 10^price.exponent    price of one whole token
///         * 10^cash_decimals                   back into cash base units
///
/// Rearranged so every division happens last and nothing is truncated early.
pub fn value_of(
    balance: u64,
    asset_decimals: u8,
    price: Price,
    cash_decimals: u8,
) -> Result<u64> {
    if balance == 0 {
        return Ok(0);
    }

    require!(price.value > 0, ConduitError::PriceUnusable);
    require!(price.exponent <= 0, ConduitError::PriceUnusable);

    let numerator_pow = u32::from(cash_decimals);
    let denominator_pow = u32::from(asset_decimals)
        .checked_add(price.exponent.unsigned_abs())
        .ok_or(ConduitError::ArithmeticOverflow)?;

    let product = (balance as u128)
        .checked_mul(price.value as u128)
        .ok_or(ConduitError::ArithmeticOverflow)?
        .checked_mul(pow10(numerator_pow)?)
        .ok_or(ConduitError::ArithmeticOverflow)?;

    let value = product
        .checked_div(pow10(denominator_pow)?)
        .ok_or(ConduitError::ArithmeticOverflow)?;

    u64::try_from(value).map_err(|_| ConduitError::ArithmeticOverflow.into())
}

/// Base units of an asset that a given amount of cash buys.
///
/// The inverse of `value_of`, and deliberately rounded down: a buy takes no
/// more of the asset than the cash strictly pays for.
pub fn quantity_for(
    cash_amount: u64,
    asset_decimals: u8,
    price: Price,
    cash_decimals: u8,
) -> Result<u64> {
    if cash_amount == 0 {
        return Ok(0);
    }

    require!(price.value > 0, ConduitError::PriceUnusable);
    require!(price.exponent <= 0, ConduitError::PriceUnusable);

    let numerator_pow = u32::from(asset_decimals)
        .checked_add(price.exponent.unsigned_abs())
        .ok_or(ConduitError::ArithmeticOverflow)?;

    let product = (cash_amount as u128)
        .checked_mul(pow10(numerator_pow)?)
        .ok_or(ConduitError::ArithmeticOverflow)?;

    let denominator = pow10(u32::from(cash_decimals))?
        .checked_mul(price.value as u128)
        .ok_or(ConduitError::ArithmeticOverflow)?;

    let quantity = product
        .checked_div(denominator)
        .ok_or(ConduitError::ArithmeticOverflow)?;

    u64::try_from(quantity).map_err(|_| ConduitError::ArithmeticOverflow.into())
}

/// Total value of the portfolio, in cash base units.
///
/// Cash plus every holding marked at its oracle price. This is the figure every
/// target weight is a share of, so it has to be computed from actual balances
/// rather than from anything the portfolio account claims about itself.
pub fn net_asset_value(
    cash_balance: u64,
    cash_decimals: u8,
    holdings: &[Holding],
) -> Result<u64> {
    let mut total = cash_balance as u128;

    for holding in holdings {
        let value = value_of(
            holding.balance,
            holding.decimals,
            holding.price,
            cash_decimals,
        )?;
        total = total
            .checked_add(value as u128)
            .ok_or(ConduitError::ArithmeticOverflow)?;
    }

    u64::try_from(total).map_err(|_| ConduitError::ArithmeticOverflow.into())
}

/// What one holding must trade to reach its target share of the portfolio.
///
/// Returns `None` when the move is smaller than one base unit of the asset,
/// which is not worth a transfer and would round to nothing anyway.
pub fn leg_for(
    holding: &Holding,
    nav: u64,
    cash_decimals: u8,
) -> Result<Option<Leg>> {
    require!(
        holding.target_bps <= BPS_DENOMINATOR,
        ConduitError::InvalidBasisPoints
    );

    // A target of zero is settled before anything is valued.
    //
    // Doing it by value does not work at the bottom of the range. A balance
    // worth less than one base unit of cash values at zero, which makes it
    // indistinguishable from holding nothing, and the position could never be
    // closed. The portfolio receives whatever the dust is worth, which may
    // genuinely be nothing, and ends up holding none of it. That is the right
    // trade: an amount below the smallest representable price is not worth
    // keeping a position open for.
    if holding.target_bps == 0 {
        if holding.balance == 0 {
            return Ok(None);
        }

        let proceeds = value_of(
            holding.balance,
            holding.decimals,
            holding.price,
            cash_decimals,
        )?;

        return Ok(Some(Leg {
            asset_amount: holding.balance,
            cash_amount: proceeds,
            buying: false,
        }));
    }

    // Target value of this holding, rounded down so the sum of targets can
    // never exceed the portfolio.
    let target_value = (nav as u128)
        .checked_mul(holding.target_bps as u128)
        .ok_or(ConduitError::ArithmeticOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(ConduitError::ArithmeticOverflow)?;

    let target_value =
        u64::try_from(target_value).map_err(|_| ConduitError::ArithmeticOverflow)?;

    let current_value = value_of(
        holding.balance,
        holding.decimals,
        holding.price,
        cash_decimals,
    )?;

    if target_value == current_value {
        return Ok(None);
    }

    if target_value > current_value {
        let cash_amount = target_value - current_value;
        let asset_amount =
            quantity_for(cash_amount, holding.decimals, holding.price, cash_decimals)?;

        if asset_amount == 0 {
            return Ok(None);
        }

        // Charge for exactly what is delivered rather than for what was asked.
        // Rounding the quantity down and still taking the full cash would leave
        // the difference with the desk on every single buy.
        let charged = value_of(
            asset_amount,
            holding.decimals,
            holding.price,
            cash_decimals,
        )?;

        return Ok(Some(Leg {
            asset_amount,
            cash_amount: charged,
            buying: true,
        }));
    }

    let excess_value = current_value - target_value;

    let mut asset_amount =
        quantity_for(excess_value, holding.decimals, holding.price, cash_decimals)?;

    // Never try to sell more than is actually held. Rounding cannot produce
    // this, but a stale balance passed in by a caller could.
    asset_amount = asset_amount.min(holding.balance);

    if asset_amount == 0 {
        return Ok(None);
    }

    let proceeds = value_of(
        asset_amount,
        holding.decimals,
        holding.price,
        cash_decimals,
    )?;

    Ok(Some(Leg {
        asset_amount,
        cash_amount: proceeds,
        buying: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Six decimals, as USDC and most stablecoins use.
    const CASH_DECIMALS: u8 = 6;

    /// Roughly the shape of the live SOL feed: 116.45 at exponent -8.
    fn sol_price() -> Price {
        Price {
            value: 11_645_597_417,
            exponent: -8,
        }
    }

    fn holding(balance: u64, target_bps: u16) -> Holding {
        Holding {
            balance,
            decimals: 9,
            price: sol_price(),
            target_bps,
        }
    }

    #[test]
    fn values_a_whole_token_at_its_price() {
        // One SOL, nine decimals, at 116.45559... should be 116.455974 cash
        // units at six decimals.
        let value = value_of(1_000_000_000, 9, sol_price(), CASH_DECIMALS).unwrap();
        assert_eq!(value, 116_455_974);
    }

    #[test]
    fn values_nothing_as_nothing() {
        assert_eq!(value_of(0, 9, sol_price(), CASH_DECIMALS).unwrap(), 0);
    }

    #[test]
    fn quantity_and_value_are_inverses_within_a_base_unit() {
        let cash = 500_000_000u64; // 500 cash units
        let quantity = quantity_for(cash, 9, sol_price(), CASH_DECIMALS).unwrap();
        let back = value_of(quantity, 9, sol_price(), CASH_DECIMALS).unwrap();

        // Never more than was paid, and never short by more than one unit.
        assert!(back <= cash, "conversion created value: {back} from {cash}");
        assert!(cash - back <= 1, "lost {} units round tripping", cash - back);
    }

    #[test]
    fn rounds_a_buy_down_rather_than_up() {
        // A price that does not divide evenly into the cash offered.
        let price = Price { value: 3, exponent: -1 }; // 0.3
        let quantity = quantity_for(1_000_000, 0, price, CASH_DECIMALS).unwrap();
        let cost = value_of(quantity, 0, price, CASH_DECIMALS).unwrap();
        assert!(cost <= 1_000_000, "a buy cost more than was offered");
    }

    #[test]
    fn nav_is_cash_plus_every_holding() {
        let holdings = [holding(1_000_000_000, 5000), holding(2_000_000_000, 2500)];
        let nav = net_asset_value(100_000_000, CASH_DECIMALS, &holdings).unwrap();

        // 100 cash + 1 SOL + 2 SOL, all at the same price.
        assert_eq!(nav, 100_000_000 + 116_455_974 + 232_911_948);
    }

    #[test]
    fn nav_of_pure_cash_is_the_cash() {
        assert_eq!(net_asset_value(42, CASH_DECIMALS, &[]).unwrap(), 42);
    }

    #[test]
    fn buys_when_below_target() {
        // A portfolio holding nothing but 1000 cash units, targeting a quarter
        // of itself in the asset.
        let h = holding(0, 2500);
        let nav = net_asset_value(1_000_000_000, CASH_DECIMALS, &[h]).unwrap();
        let leg = leg_for(&h, nav, CASH_DECIMALS).unwrap().unwrap();

        assert!(leg.buying);
        assert!(leg.asset_amount > 0);
        // A quarter of the portfolio, within a base unit of rounding.
        assert!(leg.cash_amount <= nav / 4);
        assert!(nav / 4 - leg.cash_amount <= 1);
    }

    #[test]
    fn sells_when_above_target() {
        // Holding two whole tokens and targeting nothing.
        let h = holding(2_000_000_000, 0);
        let nav = net_asset_value(0, CASH_DECIMALS, &[h]).unwrap();
        let leg = leg_for(&h, nav, CASH_DECIMALS).unwrap().unwrap();

        assert!(!leg.buying);
        assert_eq!(leg.asset_amount, 2_000_000_000, "should sell the lot");
    }

    #[test]
    fn exits_a_position_completely_leaving_no_dust() {
        // A balance chosen so the round trip through value loses base units,
        // which is what left three lamports behind before this was exact.
        for balance in [1u64, 7, 999, 2_000_000_000, 123_456_789_012] {
            let h = holding(balance, 0);
            let nav = net_asset_value(0, CASH_DECIMALS, &[h]).unwrap();
            let leg = leg_for(&h, nav, CASH_DECIMALS).unwrap().unwrap();
            assert!(!leg.buying);
            assert_eq!(
                leg.asset_amount, balance,
                "a target of zero left {} base units behind",
                balance - leg.asset_amount
            );
        }
    }

    #[test]
    fn does_nothing_when_already_on_target() {
        let balance = 1_000_000_000u64;
        let value = value_of(balance, 9, sol_price(), CASH_DECIMALS).unwrap();

        // A portfolio that is entirely this asset, targeting all of itself.
        let h = holding(balance, BPS_DENOMINATOR);
        let nav = net_asset_value(0, CASH_DECIMALS, &[h]).unwrap();
        assert_eq!(nav, value);

        assert!(leg_for(&h, nav, CASH_DECIMALS).unwrap().is_none());
    }

    #[test]
    fn ignores_a_move_smaller_than_one_base_unit() {
        // A target a hair away from the current holding, worth less than one
        // base unit of the asset.
        let price = Price { value: 1_000_000_000_000, exponent: -6 }; // 1,000,000
        let h = Holding {
            balance: 1,
            decimals: 0,
            price,
            target_bps: 9_999,
        };
        let nav = net_asset_value(0, CASH_DECIMALS, &[h]).unwrap();
        assert!(leg_for(&h, nav, CASH_DECIMALS).unwrap().is_none());
    }

    #[test]
    fn never_sells_more_than_is_held() {
        let h = holding(1_000, 0);
        // A nav far larger than the holding, which would imply a huge sale if
        // the balance were not respected.
        let leg = leg_for(&h, u64::MAX / 4, CASH_DECIMALS).unwrap();
        if let Some(leg) = leg {
            assert!(leg.asset_amount <= 1_000);
        }
    }

    #[test]
    fn refuses_a_price_of_zero() {
        let price = Price { value: 0, exponent: -8 };
        assert!(value_of(1_000, 9, price, CASH_DECIMALS).is_err());
        assert!(quantity_for(1_000, 9, price, CASH_DECIMALS).is_err());
    }

    #[test]
    fn refuses_a_positive_exponent() {
        // Pyth reports USD prices with a negative exponent. A positive one
        // means the account was misread, and guessing would misprice by orders
        // of magnitude.
        let price = Price { value: 100, exponent: 2 };
        assert!(value_of(1_000, 9, price, CASH_DECIMALS).is_err());
    }

    #[test]
    fn survives_a_balance_that_would_overflow_a_narrower_type() {
        // A large balance at a real price. The product exceeds u64 and must be
        // taken in u128 before it is narrowed.
        let balance = 1_000_000_000_000_000_000u64;
        let value = value_of(balance, 9, sol_price(), CASH_DECIMALS).unwrap();
        assert_eq!(value, 116_455_974_170_000_000);
    }

    #[test]
    fn target_weights_never_sum_past_the_portfolio() {
        // Three holdings splitting the whole portfolio. Rounding each target
        // down must not let the total exceed the nav.
        let holdings = [
            holding(0, 3_333),
            holding(0, 3_333),
            holding(0, 3_334),
        ];
        let nav = net_asset_value(1_000_000_007, CASH_DECIMALS, &holdings).unwrap();

        let spent: u64 = holdings
            .iter()
            .filter_map(|h| leg_for(h, nav, CASH_DECIMALS).unwrap())
            .map(|leg| leg.cash_amount)
            .sum();

        assert!(spent <= nav, "spent {spent} against a nav of {nav}");
    }
}
