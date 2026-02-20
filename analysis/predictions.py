import numpy as np
import pandas as pd
from scipy import stats


# ---------------------------------------------------------------------------
# Price prediction — polynomial trend on historical promo prices
# ---------------------------------------------------------------------------

def predict_price(df: pd.DataFrame, horizon_days: int = 30, deg: int = 2):
    """
    Fit a polynomial trend to historical promo prices and project forward.

    Returns:
        dict with keys:
          - forecast_dates   : list of future dates
          - forecast_prices  : predicted promo price per date
          - ci_lower / ci_upper : 80% confidence interval
          - current_price    : last observed promo price
          - min_price_ever   : historical minimum
          - expected_min_in_horizon : predicted minimum in the horizon window
          - trend            : 'falling' | 'rising' | 'stable'
    """
    df = df.sort_values("fetched_at").drop_duplicates(subset=["fetched_at", "promo_price"])
    if len(df) < 3:
        return None

    x = (df["fetched_at"] - df["fetched_at"].min()).dt.total_seconds() / 86400
    y = df["promo_price"].values

    coeffs = np.polyfit(x, y, deg=min(deg, len(df) - 1))
    poly   = np.poly1d(coeffs)

    # Residuals → std for confidence interval
    residuals = y - poly(x)
    std = residuals.std()

    # Future dates
    last_day    = x.max()
    future_days = np.linspace(last_day + 1, last_day + horizon_days, horizon_days)
    future_pred = poly(future_days)

    last_date   = df["fetched_at"].max()
    future_dates = pd.date_range(last_date + pd.Timedelta(days=1), periods=horizon_days)

    # Trend direction from derivative at last point
    slope = np.polyder(poly)(last_day)
    if slope < -0.05:
        trend = "falling"
    elif slope > 0.05:
        trend = "rising"
    else:
        trend = "stable"

    return {
        "forecast_dates":          future_dates,
        "forecast_prices":         future_pred,
        "ci_lower":                future_pred - 1.28 * std,
        "ci_upper":                future_pred + 1.28 * std,
        "current_price":           float(y[-1]),
        "min_price_ever":          float(y.min()),
        "expected_min_in_horizon": float(future_pred.min()),
        "trend":                   trend,
        "std":                     float(std),
    }


# ---------------------------------------------------------------------------
# Deal probability — P(good deal | day_of_week, hour)
# ---------------------------------------------------------------------------

def deal_probability(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute P(good deal) for each (day_of_week, hour) combination.

    Returns a pivot table: rows=hour, cols=day_of_week, values=probability.
    """
    df = df.copy()
    df["is_good"] = df["action"].isin(
        ["SUPER", "GOOD DEAL", "BIG DISCOUNT", "VERY CHEAP", "CHEAP UPPER MID"]
    ).astype(int)

    agg = (
        df.groupby(["day_of_week", "hour"])["is_good"]
        .agg(["sum", "count"])
        .reset_index()
    )
    agg["probability"] = agg["sum"] / agg["count"].clip(lower=1)

    pivot = agg.pivot(index="hour", columns="day_of_week", values="probability")
    pivot.columns = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    return pivot


# ---------------------------------------------------------------------------
# Price drop probability — P(price drops below threshold within N days)
# ---------------------------------------------------------------------------

def price_drop_probability(df: pd.DataFrame, target_price: float) -> dict:
    """
    Estimate probability that promo_price will drop to or below target_price.
    Uses empirical distribution of historical prices.
    """
    prices = df["promo_price"].dropna().values
    if len(prices) == 0:
        return {"probability": 0.0, "historical_min": None, "pct_below_target": 0.0}

    pct_below = float((prices <= target_price).mean())
    hist_min  = float(prices.min())

    # Fit normal distribution and use CDF
    mu, sigma = prices.mean(), prices.std()
    if sigma > 0:
        prob = float(stats.norm.cdf(target_price, loc=mu, scale=sigma))
    else:
        prob = 1.0 if target_price >= mu else 0.0

    return {
        "probability":      round(prob, 3),
        "pct_below_target": round(pct_below, 3),
        "historical_min":   hist_min,
        "historical_mean":  round(float(mu), 2),
    }


# ---------------------------------------------------------------------------
# Best time to buy recommendation
# ---------------------------------------------------------------------------

def best_time_to_buy(deal_prob_pivot: pd.DataFrame) -> dict:
    """Return the (day, hour) with highest deal probability."""
    stacked = deal_prob_pivot.stack()
    best_idx = stacked.idxmax()
    return {
        "best_hour":        int(best_idx[0]),
        "best_day":         best_idx[1],
        "probability":      round(float(stacked.max()), 3),
    }
