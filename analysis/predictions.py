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
# Price drop timing — P(price dropped vs previous fetch | day, hour)
# ---------------------------------------------------------------------------

def price_drop_timing(df: pd.DataFrame):
    """
    For each (day_of_week, hour), compute:
      - drop_rate   : fraction of fetches where a product's price was lower than its previous fetch
      - avg_drop_pct: average % size of those drops

    Returns (drop_rate_pivot, avg_drop_pivot) — both indexed by hour, columned by day name.
    """
    d = df.sort_values(["product_id", "size", "color", "fetched_at"]).copy()
    d["prev_price"] = d.groupby(["product_id", "size", "color"])["promo_price"].shift(1)

    # Only rows where a previous price exists
    d = d[d["prev_price"].notna()].copy()
    d["price_dropped"] = (d["promo_price"] < d["prev_price"]).astype(int)
    d["drop_pct"] = np.where(
        d["price_dropped"] == 1,
        (d["prev_price"] - d["promo_price"]) / d["prev_price"] * 100,
        np.nan,
    )

    agg = (
        d.groupby(["day_of_week", "hour"])
        .agg(
            drops=("price_dropped", "sum"),
            total=("price_dropped", "count"),
            avg_drop_pct=("drop_pct", "mean"),
        )
        .reset_index()
    )
    agg["drop_rate"] = agg["drops"] / agg["total"].clip(lower=1)

    day_map = {0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat"}
    agg["day_name"] = agg["day_of_week"].map(day_map)

    col_order = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    rate_pivot = agg.pivot(index="hour", columns="day_name", values="drop_rate")
    avg_pivot  = agg.pivot(index="hour", columns="day_name", values="avg_drop_pct")

    rate_pivot = rate_pivot.reindex(columns=[c for c in col_order if c in rate_pivot.columns]).fillna(0)
    avg_pivot  = avg_pivot.reindex(columns=[c for c in col_order if c in avg_pivot.columns]).fillna(0)

    return rate_pivot, avg_pivot


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
