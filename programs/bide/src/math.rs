use crate::errors::BideError;
use anchor_lang::prelude::*;

pub fn mul_div_floor(a: u64, b: u64, d: u64) -> Result<u64> {
    require!(d != 0, BideError::MathOverflow);
    let v = (a as u128)
        .checked_mul(b as u128)
        .ok_or(BideError::MathOverflow)?
        / d as u128;
    u64::try_from(v).map_err(|_| error!(BideError::MathOverflow))
}

pub fn mul_div_ceil(a: u64, b: u64, d: u64) -> Result<u64> {
    require!(d != 0, BideError::MathOverflow);
    let n = (a as u128).checked_mul(b as u128).ok_or(BideError::MathOverflow)?;
    let v = n.div_ceil(d as u128);
    u64::try_from(v).map_err(|_| error!(BideError::MathOverflow))
}

pub fn pow10(decimals: u8) -> Result<u64> {
    10u64.checked_pow(decimals as u32).ok_or(error!(BideError::MathOverflow))
}

/// strike (USDC units per 1 whole asset) × size (asset base units) / 10^dec, rounded down
pub fn notional_floor(strike: u64, size: u64, decimals: u8) -> Result<u64> {
    mul_div_floor(strike, size, pow10(decimals)?)
}

/// same, rounded up (amounts the user must lock)
pub fn notional_ceil(strike: u64, size: u64, decimals: u8) -> Result<u64> {
    mul_div_ceil(strike, size, pow10(decimals)?)
}

/// Dutch auction: linear from start to floor over auction_secs, then floor.
pub fn auction_price(start: u64, floor: u64, auction_start: i64, auction_secs: u32, now: i64) -> Result<u64> {
    require!(floor <= start, BideError::AuctionParamsInvalid);
    if auction_secs == 0 {
        return Ok(floor);
    }
    let elapsed = now.saturating_sub(auction_start).clamp(0, auction_secs as i64) as u64;
    let drop = mul_div_floor(start - floor, elapsed, auction_secs as u64)?;
    Ok(start - drop)
}

/// Median of filled samples (≤ 10). Even count → mean of the middle two (floor).
pub fn median(samples: &[u64; 10], mask: u16, n: u8) -> Option<u64> {
    let mut v = [0u64; 10];
    let mut k = 0usize;
    for i in 0..(n as usize).min(10) {
        if mask & (1 << i) != 0 {
            v[k] = samples[i];
            k += 1;
        }
    }
    if k == 0 {
        return None;
    }
    let s = &mut v[..k];
    s.sort_unstable();
    if k % 2 == 1 {
        Some(s[k / 2])
    } else {
        let a = s[k / 2 - 1] as u128;
        let b = s[k / 2] as u128;
        Some(((a + b) / 2) as u64)
    }
}

pub fn count_mask(mask: u16, n: u8) -> u8 {
    let m = if n >= 16 { mask } else { mask & ((1u16 << n) - 1) };
    m.count_ones() as u8
}

/// Pyth (price, expo) → USDC base units (6 decimals). price must be > 0.
pub fn pyth_to_usdc(price: i64, expo: i32) -> Result<u64> {
    require!(price > 0, BideError::StalePrice);
    let p = price as u128;
    let e = 6i32.checked_add(expo).ok_or(BideError::MathOverflow)?;
    let v = if e >= 0 {
        p.checked_mul(10u128.checked_pow(e as u32).ok_or(BideError::MathOverflow)?)
            .ok_or(BideError::MathOverflow)?
    } else {
        p / 10u128.checked_pow((-e) as u32).ok_or(BideError::MathOverflow)?
    };
    u64::try_from(v).map_err(|_| error!(BideError::MathOverflow))
}

/// conf/price ≤ max_bps
pub fn conf_ok(price: i64, conf: u64, max_bps: u16) -> bool {
    if price <= 0 {
        return false;
    }
    (conf as u128) * (crate::constants::BPS as u128) <= (price as u128) * (max_bps as u128)
}

/// |a − b| ≤ ref × bps / 10_000
pub fn within_bps(a: u64, b: u64, reference: u64, bps: u16) -> bool {
    let diff = a.abs_diff(b) as u128;
    diff * (crate::constants::BPS as u128) <= (reference as u128) * (bps as u128)
}

/// User min premium check (after fee):
/// floor × (10_000 − fee_bps)/10_000 ≥ notional × min_bps_per_day × secs/(86_400 × 10_000)
pub fn premium_meets_min(floor: u64, fee_bps: u16, notional: u64, min_bps_per_day: u16, secs_to_expiry: i64) -> Result<bool> {
    require!(fee_bps as u64 <= crate::constants::BPS, BideError::FeeTooHigh);
    let secs = secs_to_expiry.max(0) as u128;
    let lhs = (floor as u128)
        .checked_mul((crate::constants::BPS - fee_bps as u64) as u128)
        .and_then(|x| x.checked_mul(86_400))
        .ok_or(BideError::MathOverflow)?;
    let rhs = (notional as u128)
        .checked_mul(min_bps_per_day as u128)
        .and_then(|x| x.checked_mul(secs))
        .ok_or(BideError::MathOverflow)?;
    Ok(lhs >= rhs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notional_rounding() {
        // $110 × 0.2 SOL
        assert_eq!(notional_floor(110_000_000, 200_000_000, 9).unwrap(), 22_000_000);
        // 1 lamport at $110 → 0.00000011 USDC → floor 0, ceil 1
        assert_eq!(notional_floor(110_000_000, 1, 9).unwrap(), 0);
        assert_eq!(notional_ceil(110_000_000, 1, 9).unwrap(), 1);
        assert!(notional_floor(u64::MAX, u64::MAX, 0).is_err());
    }

    #[test]
    fn auction() {
        assert_eq!(auction_price(300, 100, 1000, 30, 1000).unwrap(), 300);
        assert_eq!(auction_price(300, 100, 1000, 30, 1015).unwrap(), 200);
        assert_eq!(auction_price(300, 100, 1000, 30, 1030).unwrap(), 100);
        assert_eq!(auction_price(300, 100, 1000, 30, 5000).unwrap(), 100);
        assert_eq!(auction_price(300, 100, 1000, 30, 900).unwrap(), 300);
        assert!(auction_price(100, 300, 1000, 30, 1000).is_err());
    }

    #[test]
    fn med() {
        let mut s = [0u64; 10];
        s[0] = 5; s[1] = 1; s[2] = 3;
        assert_eq!(median(&s, 0b111, 10), Some(3));
        s[3] = 10;
        assert_eq!(median(&s, 0b1111, 10), Some(4));
        assert_eq!(median(&s, 0, 10), None);
        assert_eq!(count_mask(0b1111, 10), 4);
        assert_eq!(count_mask(0xffff, 10), 10);
    }

    #[test]
    fn pyth() {
        // 150.12345678 with expo -8 → 150_123_456
        assert_eq!(pyth_to_usdc(15_012_345_678, -8).unwrap(), 150_123_456);
        assert_eq!(pyth_to_usdc(150, 0).unwrap(), 150_000_000);
        assert!(pyth_to_usdc(-1, -8).is_err());
        assert!(conf_ok(10_000, 50, 50));
        assert!(!conf_ok(10_000, 51, 50));
    }

    #[test]
    fn min_premium() {
        // notional 22 USDC, 10 bps/day, 1 day → 0.022 USDC = 22_000 after fee; fee 10% → floor ≥ 24_445
        assert!(premium_meets_min(24_445, 1000, 22_000_000, 10, 86_400).unwrap());
        assert!(!premium_meets_min(24_444, 1000, 22_000_000, 10, 86_400).unwrap());
    }
}
