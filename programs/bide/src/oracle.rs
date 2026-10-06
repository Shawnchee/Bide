use crate::{constants::*, errors::BideError, math, state::Asset};
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

/// Deserialize a PriceUpdateV2 owned by the (upgraded) Pyth receiver and require Full verification.
pub fn load_price_update(acc: &AccountInfo) -> Result<PriceUpdateV2> {
    require_keys_eq!(*acc.owner, PYTH_RECEIVER, BideError::WrongFeed);
    let data = acc.try_borrow_data()?;
    let pu = PriceUpdateV2::try_deserialize(&mut &data[..]).map_err(|_| error!(BideError::WrongFeed))?;
    require!(pu.verification_level == VerificationLevel::Full, BideError::NotFullyVerified);
    Ok(pu)
}

/// Spot from the asset's sponsored push feed → USDC base units.
/// Age limit = asset.max_spot_age_secs (devnet 600), conf ≤ asset.max_conf_bps.
pub fn read_spot(asset: &Asset, feed: &AccountInfo, now: i64) -> Result<u64> {
    require_keys_eq!(feed.key(), asset.spot_feed, BideError::WrongFeed);
    let pu = load_price_update(feed)?;
    let m = &pu.price_message;
    require!(m.feed_id == asset.pyth_feed_id, BideError::WrongFeed);
    require!(
        now.saturating_sub(m.publish_time) <= asset.max_spot_age_secs as i64,
        BideError::StalePrice
    );
    require!(math::conf_ok(m.price, m.conf, asset.max_conf_bps), BideError::PriceConfidenceTooWide);
    math::pyth_to_usdc(m.price, m.exponent)
}
