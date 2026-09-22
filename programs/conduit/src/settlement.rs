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

/* -------------------------------------------------------------------------- */
/* Reading a price off the chain                                              */
/* -------------------------------------------------------------------------- */

/// The Pyth receiver program on Solana. A price account must be owned by it.
///
/// Checked rather than assumed. Without it, anyone could hand this instruction
/// an account they wrote themselves containing whatever price suited them, and
/// every protection in this program would then be measured against a number
/// they chose.
pub const PYTH_RECEIVER: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// How old a price may be before this program refuses to settle on it.
///
/// Ten minutes, chosen against what devnet actually does rather than what would
/// look strict. The sponsored feeds there are pushed roughly once a minute and
/// occasionally skip, so two minutes left almost no headroom and would have
/// failed settlements for no reason.
///
/// It still does the job it exists for. The abandoned shards carrying these
/// same feeds are months out of date, one of them a hundred and ninety two
/// days, so anything meaningfully stale is refused by a factor of thousands. A
/// settlement priced off an old feed moves real balances at a rate that no
/// longer exists, and failing is the better outcome.
///
/// Mainnet updates sub second. This would be tightened there.
pub const MAX_PRICE_AGE_SECONDS: i64 = 600;

/// Where the price message starts inside a `PriceUpdateV2` account.
///
/// The layout is eight bytes of discriminator, a thirty two byte write
/// authority, a verification level, and then the message. The verification
/// level is the part that needs care: it is an enum whose `Partial` variant
/// carries a byte of its own, so the message begins at a different offset
/// depending on which variant is present. Assuming one width silently misreads
/// every field after it, which is the worst possible failure here because the
/// result is still a number.
fn message_offset(data: &[u8]) -> Result<usize> {
    const TAG: usize = 8 + 32;
    require!(data.len() > TAG, ConduitError::PriceUnusable);

    // 0 is Partial, which carries a u8. 1 is Full, which carries nothing.
    let width = match data[TAG] {
        0 => 2,
        1 => 1,
        _ => return Err(ConduitError::PriceUnusable.into()),
    };

    Ok(TAG + width)
}

fn read_i64(data: &[u8], at: usize) -> Result<i64> {
    let bytes: [u8; 8] = data
        .get(at..at + 8)
        .ok_or(ConduitError::PriceUnusable)?
        .try_into()
        .map_err(|_| ConduitError::PriceUnusable)?;
    Ok(i64::from_le_bytes(bytes))
}

fn read_i32(data: &[u8], at: usize) -> Result<i32> {
    let bytes: [u8; 4] = data
        .get(at..at + 4)
        .ok_or(ConduitError::PriceUnusable)?
        .try_into()
        .map_err(|_| ConduitError::PriceUnusable)?;
    Ok(i32::from_le_bytes(bytes))
}

/// Reads a price, and refuses it unless it is the one the mandate bound.
///
/// The feed id check is why the mandate has carried a `feed_id` per permitted
/// asset since it was first written, with a comment saying valuation must not
/// be repointable at a different instrument. This is that check finally being
/// made. A price account for Bitcoin cannot be used to settle a position in
/// Solana, however convenient the number would be.
pub fn read_price(
    data: &[u8],
    expected_feed_id: &[u8; 32],
    now: i64,
) -> Result<Price> {
    require!(
        expected_feed_id != &[0u8; 32],
        ConduitError::MandateNotSettleable
    );

    let base = message_offset(data)?;

    let feed_id: &[u8] = data
        .get(base..base + 32)
        .ok_or(ConduitError::PriceUnusable)?;
    require!(feed_id == expected_feed_id, ConduitError::PriceFeedMismatch);

    let price = read_i64(data, base + 32)?;
    let exponent = read_i32(data, base + 48)?;
    let publish_time = read_i64(data, base + 52)?;

    usable(price, exponent, publish_time, now)
}

/// The checks every price must pass, whoever published it.
///
/// Shared on purpose. A price from this program's own publisher is trusted
/// differently from a Pyth price, and that difference belongs at the point
/// where the account owner is checked. Once a number is in hand the questions
/// are identical, and letting the two paths drift apart would mean one of them
/// eventually accepts something the other would not.
fn usable(price: i64, exponent: i32, publish_time: i64, now: i64) -> Result<Price> {
    require!(price > 0, ConduitError::PriceUnusable);
    require!(exponent <= 0, ConduitError::PriceUnusable);
    require!(
        now.saturating_sub(publish_time) <= MAX_PRICE_AGE_SECONDS,
        ConduitError::PriceUnusable
    );
    // A price stamped in the future is as wrong as a stale one, and means
    // something is misconfigured rather than merely slow.
    require!(
        publish_time.saturating_sub(now) <= MAX_PRICE_AGE_SECONDS,
        ConduitError::PriceUnusable
    );

    Ok(Price {
        value: price as u64,
        exponent,
    })
}

/// Reads a price this program published itself.
///
/// The account has already been deserialised by the caller, which is why this
/// takes fields rather than bytes: an account owned by this program carries a
/// discriminator Anchor checks, so there is no layout to parse defensively and
/// no variable width enum to get wrong. That is the one advantage of publishing
/// a price ourselves, and it is a small one next to what it costs in trust.
///
/// Everything else is identical to the Pyth path, including refusing a mandate
/// that bound an asset to no feed at all. The feed id check is what stops a
/// caller passing the published price of one instrument while settling another.
pub fn read_published_price(
    stored_feed_id: &[u8; 32],
    price: u64,
    exponent: i32,
    publish_time: i64,
    expected_feed_id: &[u8; 32],
    now: i64,
) -> Result<Price> {
    require!(
        expected_feed_id != &[0u8; 32],
        ConduitError::MandateNotSettleable
    );
    require!(
        stored_feed_id == expected_feed_id,
        ConduitError::PriceFeedMismatch
    );

    // Widening to i64 so the shared checks see the same shape they see from
    // Pyth, whose price field is signed. A published price cannot be negative
    // by construction, but it can exceed i64 if something upstream is wrong,
    // and that should be refused rather than wrapped.
    let signed = i64::try_from(price).map_err(|_| ConduitError::PriceUnusable)?;

    usable(signed, exponent, publish_time, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Six decimals, as USDC and most stablecoins use.
    const CASH_DECIMALS: u8 = 6;

    /// A real `PriceUpdateV2` account, read off devnet with the Solana CLI.
    ///
    /// Genuine bytes rather than a constructed fixture, which is the point. A
    /// hand written one would encode whatever layout I believed was correct,
    /// and that belief is exactly what is under test.
    const SOL_USD_ACCOUNT: [u8; 134] = [
        0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd, 0x60, 0x31, 0x47, 0x04,
        0x34, 0x0d, 0xed, 0xdf, 0x37, 0x1f, 0xd4, 0x24, 0x72, 0x14, 0x8f, 0x24,
        0x8e, 0x9d, 0x1a, 0x6d, 0x1a, 0x5e, 0xb2, 0xac, 0x3a, 0xcd, 0x8b, 0x7f,
        0xd5, 0xd6, 0xb2, 0x43, 0x01, 0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb,
        0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39, 0x2a, 0x0d, 0x2f,
        0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5,
        0x6d, 0xe9, 0xb6, 0x21, 0xb6, 0x02, 0x00, 0x00, 0x00, 0x34, 0x9f, 0x1b,
        0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0xff, 0xff, 0xff, 0x87, 0x59, 0xb2,
        0x6a, 0x00, 0x00, 0x00, 0x00, 0x86, 0x59, 0xb2, 0x6a, 0x00, 0x00, 0x00,
        0x00, 0x8c, 0x74, 0x2a, 0xb9, 0x02, 0x00, 0x00, 0x00, 0xae, 0x6c, 0x12,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x25, 0xc0, 0xf1, 0x1d, 0x00, 0x00, 0x00,
        0x00, 0x00,
    ];

    /// The feed that account carries: Pyth SOL/USD.
    const SOL_FEED_ID: [u8; 32] = [
        0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40,
        0x95, 0xd1, 0xda, 0x39, 0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc,
        0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
    ];

    /// The moment that account was published.
    const SOL_PUBLISH_TIME: i64 = 1_790_073_223;

    #[test]
    fn reads_a_real_price_account() {
        let price = read_price(&SOL_USD_ACCOUNT, &SOL_FEED_ID, SOL_PUBLISH_TIME).unwrap();
        assert_eq!(price.value, 11_645_597_417);
        assert_eq!(price.exponent, -8);

        // A hundred and sixteen dollars and change, as SOL was at the time.
        let value = value_of(1_000_000_000, 9, price, CASH_DECIMALS).unwrap();
        assert_eq!(value, 116_455_974);
    }

    #[test]
    fn refuses_a_price_account_for_a_different_feed() {
        let mut wrong = SOL_FEED_ID;
        wrong[0] ^= 0xff;
        assert!(read_price(&SOL_USD_ACCOUNT, &wrong, SOL_PUBLISH_TIME).is_err());
    }

    #[test]
    fn refuses_an_asset_the_mandate_bound_to_no_feed() {
        // All zeros is how the registry records an asset with no Pyth feed.
        // Settling one would mean pricing it from an account nobody vouched for.
        assert!(read_price(&SOL_USD_ACCOUNT, &[0u8; 32], SOL_PUBLISH_TIME).is_err());
    }

    #[test]
    fn refuses_a_stale_price() {
        // The abandoned devnet shards are months old, so this margin is huge.
        let late = SOL_PUBLISH_TIME + MAX_PRICE_AGE_SECONDS + 1;
        assert!(read_price(&SOL_USD_ACCOUNT, &SOL_FEED_ID, late).is_err());

        let just_inside = SOL_PUBLISH_TIME + MAX_PRICE_AGE_SECONDS;
        assert!(read_price(&SOL_USD_ACCOUNT, &SOL_FEED_ID, just_inside).is_ok());
    }

    #[test]
    fn refuses_a_price_stamped_in_the_future() {
        let early = SOL_PUBLISH_TIME - MAX_PRICE_AGE_SECONDS - 1;
        assert!(read_price(&SOL_USD_ACCOUNT, &SOL_FEED_ID, early).is_err());
    }

    #[test]
    fn refuses_an_account_too_short_to_hold_a_price() {
        for length in [0usize, 8, 40, 41, 70] {
            let truncated = &SOL_USD_ACCOUNT[..length.min(SOL_USD_ACCOUNT.len())];
            assert!(
                read_price(truncated, &SOL_FEED_ID, SOL_PUBLISH_TIME).is_err(),
                "accepted an account of {length} bytes"
            );
        }
    }

    #[test]
    fn refuses_an_unknown_verification_level() {
        let mut tampered = SOL_USD_ACCOUNT;
        tampered[40] = 7;
        assert!(read_price(&tampered, &SOL_FEED_ID, SOL_PUBLISH_TIME).is_err());
    }

    #[test]
    fn a_partial_verification_shifts_every_field_after_it() {
        // Partial carries a byte of its own, so the message starts one later.
        // Reading it at the Full offset misreads the feed id and everything
        // beyond it, which is why the width is derived rather than assumed.
        let mut partial = [0u8; 135];
        partial[..40].copy_from_slice(&SOL_USD_ACCOUNT[..40]);
        partial[40] = 0; // Partial
        partial[41] = 13; // its signature count
        partial[42..].copy_from_slice(&SOL_USD_ACCOUNT[41..]);

        let price = read_price(&partial, &SOL_FEED_ID, SOL_PUBLISH_TIME).unwrap();
        assert_eq!(price.value, 11_645_597_417);
        assert_eq!(price.exponent, -8);
    }


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

    /* ---- prices this program published itself ---- */

    /// A feed id in the publisher's own namespace, not Pyth's.
    ///
    /// Distinct on purpose. Reusing a Pyth feed id for a price we assert
    /// ourselves would make a settlement look Pyth priced when it is not, and
    /// the whole reason this path is separate is that it carries a different
    /// claim.
    const PUBLISHED_FEED: [u8; 32] = [0x7c; 32];

    /// A moment, in the middle of nothing, to measure staleness against.
    const PUBLISHED_AT: i64 = 1_790_000_000;

    fn published(price: u64, exponent: i32) -> Result<Price> {
        read_published_price(
            &PUBLISHED_FEED,
            price,
            exponent,
            PUBLISHED_AT,
            &PUBLISHED_FEED,
            PUBLISHED_AT,
        )
    }

    #[test]
    fn reads_a_price_this_program_published() {
        // 339.55 at eight decimals, roughly what AAPL trades at.
        let price = published(33_955_000_000, -8).unwrap();
        assert_eq!(price.value, 33_955_000_000);
        assert_eq!(price.exponent, -8);
    }

    #[test]
    fn published_and_pyth_prices_value_identically() {
        // The point of sharing a Price type. Whatever a settlement does with a
        // Pyth price it must do with a published one, because the arithmetic
        // downstream cannot see which it was handed and should not care.
        let from_pyth = read_price(&SOL_USD_ACCOUNT, &SOL_FEED_ID, SOL_PUBLISH_TIME).unwrap();
        let same = read_published_price(
            &PUBLISHED_FEED,
            from_pyth.value,
            from_pyth.exponent,
            PUBLISHED_AT,
            &PUBLISHED_FEED,
            PUBLISHED_AT,
        )
        .unwrap();

        assert_eq!(
            value_of(1_000_000_000, 9, from_pyth, CASH_DECIMALS).unwrap(),
            value_of(1_000_000_000, 9, same, CASH_DECIMALS).unwrap()
        );
    }

    #[test]
    fn refuses_a_published_price_for_a_different_feed() {
        // The check that stops one instrument being settled at another's
        // price. Without it the publisher's accounts would be interchangeable.
        let other = [0x5a; 32];
        assert!(read_published_price(
            &other,
            33_955_000_000,
            -8,
            PUBLISHED_AT,
            &PUBLISHED_FEED,
            PUBLISHED_AT,
        )
        .is_err());
    }

    #[test]
    fn refuses_an_asset_the_mandate_bound_to_no_published_feed() {
        // A zero feed id means the mandate never named a price source. Settling
        // it would mean valuing an asset on nothing at all.
        assert!(read_published_price(
            &[0u8; 32],
            33_955_000_000,
            -8,
            PUBLISHED_AT,
            &[0u8; 32],
            PUBLISHED_AT,
        )
        .is_err());
    }

    #[test]
    fn refuses_a_stale_published_price() {
        let late = PUBLISHED_AT + MAX_PRICE_AGE_SECONDS + 1;
        assert!(read_published_price(
            &PUBLISHED_FEED,
            33_955_000_000,
            -8,
            PUBLISHED_AT,
            &PUBLISHED_FEED,
            late,
        )
        .is_err());

        let just_inside = PUBLISHED_AT + MAX_PRICE_AGE_SECONDS;
        assert!(read_published_price(
            &PUBLISHED_FEED,
            33_955_000_000,
            -8,
            PUBLISHED_AT,
            &PUBLISHED_FEED,
            just_inside,
        )
        .is_ok());
    }

    #[test]
    fn refuses_a_published_price_stamped_in_the_future() {
        let early = PUBLISHED_AT - MAX_PRICE_AGE_SECONDS - 1;
        assert!(read_published_price(
            &PUBLISHED_FEED,
            33_955_000_000,
            -8,
            PUBLISHED_AT,
            &PUBLISHED_FEED,
            early,
        )
        .is_err());
    }

    #[test]
    fn refuses_a_published_price_of_zero() {
        assert!(published(0, -8).is_err());
    }

    #[test]
    fn refuses_a_published_positive_exponent() {
        // Same rule as Pyth. A positive exponent would multiply rather than
        // divide, turning a price into something thousands of times too large.
        assert!(published(33_955_000_000, 1).is_err());
    }

    #[test]
    fn refuses_a_published_price_too_large_to_be_signed() {
        // Widening to i64 is where this would wrap. A publisher sending
        // nonsense should be refused rather than have it silently become a
        // negative price that then fails a different check for the wrong
        // reason.
        assert!(published(u64::MAX, -8).is_err());
        assert!(published((i64::MAX as u64) + 1, -8).is_err());
        assert!(published(i64::MAX as u64, -8).is_ok());
    }
}
