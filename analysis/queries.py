import os
import pandas as pd
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------

def get_engine():
    url = (
        f"postgresql://{os.getenv('DB_USER')}:{os.getenv('DB_PASSWORD')}"
        f"@{os.getenv('DB_HOST')}:{os.getenv('DB_PORT', '5432')}/{os.getenv('DB_NAME', 'postgres')}"
    )
    return create_engine(url, connect_args={"sslmode": "require"})


# ---------------------------------------------------------------------------
# Main timeseries query — full joined dataset
# ---------------------------------------------------------------------------

TIMESERIES_SQL = """
SELECT
    tv.id,
    tv.fetched_at,
    DATE(tv.fetched_at)                         AS date,
    EXTRACT(DOW   FROM tv.fetched_at)::int       AS day_of_week,
    EXTRACT(HOUR  FROM tv.fetched_at)::int       AS hour,
    EXTRACT(MONTH FROM tv.fetched_at)::int       AS month,
    EXTRACT(WEEK  FROM tv.fetched_at)::int       AS week,
    EXTRACT(YEAR  FROM tv.fetched_at)::int       AS year,
    tv.promo_price,
    tv.original_price,
    tv.discount_percent,
    tv.rating,
    tv.reviews,
    tv.action,
    pv.color,
    pv.size,
    p.name,
    p.product_id,
    p.gender
FROM timeseries_values tv
JOIN product_variants pv ON tv.variant_id = pv.id
JOIN parent p             ON pv.parent_id = p.id
{where}
ORDER BY tv.fetched_at
"""

GOOD_ACTIONS = ("SUPER", "GOOD DEAL", "BIG DISCOUNT", "VERY CHEAP", "CHEAP UPPER MID")


def load_timeseries(engine, size: str = None, gender: str = None,
                    actions: tuple = None, days: int = None) -> pd.DataFrame:
    """Load full timeseries with optional filters."""
    conditions = ["pv.size IS NOT NULL", "pv.size != ''"]
    if size:
        if isinstance(size, (list, tuple)):
            quoted = ", ".join(f"'{s}'" for s in size)
            conditions.append(f"pv.size IN ({quoted})")
        else:
            conditions.append(f"pv.size = '{size}'")
    if gender:
        conditions.append(f"p.gender = '{gender}'")
    if actions:
        quoted = ", ".join(f"'{a}'" for a in actions)
        conditions.append(f"tv.action IN ({quoted})")
    if days:
        conditions.append(f"tv.fetched_at >= NOW() - INTERVAL '{days} days'")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    sql = TIMESERIES_SQL.format(where=where)

    df = pd.read_sql(text(sql), engine)
    df["fetched_at"] = pd.to_datetime(df["fetched_at"])
    df["date"] = pd.to_datetime(df["date"])
    return df


# ---------------------------------------------------------------------------
# Price history per product
# ---------------------------------------------------------------------------

PRICE_HISTORY_SQL = """
SELECT
    tv.fetched_at,
    tv.promo_price,
    tv.original_price,
    tv.discount_percent,
    tv.action,
    pv.color,
    pv.size,
    p.name,
    p.product_id
FROM timeseries_values tv
JOIN product_variants pv ON tv.variant_id = pv.id
JOIN parent p             ON pv.parent_id = p.id
WHERE p.product_id = :product_id
ORDER BY tv.fetched_at
"""

def load_price_history(engine, product_id: str) -> pd.DataFrame:
    """Price history for a single product."""
    df = pd.read_sql(text(PRICE_HISTORY_SQL), engine, params={"product_id": product_id})
    df["fetched_at"] = pd.to_datetime(df["fetched_at"])
    return df


# ---------------------------------------------------------------------------
# Deal heatmap aggregation
# ---------------------------------------------------------------------------

HEATMAP_SQL = """
SELECT
    EXTRACT(DOW  FROM tv.fetched_at)::int  AS day_of_week,
    EXTRACT(HOUR FROM tv.fetched_at)::int  AS hour,
    COUNT(*)                               AS total_obs,
    SUM(CASE WHEN tv.action IN {good_actions} THEN 1 ELSE 0 END) AS good_deals,
    AVG(tv.discount_percent)               AS avg_discount
FROM timeseries_values tv
JOIN product_variants pv ON tv.variant_id = pv.id
{where}
GROUP BY 1, 2
ORDER BY 1, 2
"""

def load_deal_heatmap(engine, size: str = None) -> pd.DataFrame:
    good = str(GOOD_ACTIONS).replace("'", "'").replace("(", "(").replace(")", ")")
    if size:
        if isinstance(size, (list, tuple)):
            quoted = ", ".join(f"'{s}'" for s in size)
            where = f"WHERE pv.size IN ({quoted})"
        else:
            where = f"WHERE pv.size = '{size}'"
    else:
        where = ""
    sql = HEATMAP_SQL.format(
        good_actions=str(GOOD_ACTIONS),
        where=where
    )
    df = pd.read_sql(text(sql), engine)
    df["deal_rate"] = df["good_deals"] / df["total_obs"].clip(lower=1)
    return df


# ---------------------------------------------------------------------------
# Seasonal aggregation
# ---------------------------------------------------------------------------

SEASONAL_SQL = """
SELECT
    EXTRACT(YEAR  FROM tv.fetched_at)::int  AS year,
    EXTRACT(MONTH FROM tv.fetched_at)::int  AS month,
    EXTRACT(WEEK  FROM tv.fetched_at)::int  AS week,
    pv.size,
    COUNT(*)                                AS observations,
    SUM(CASE WHEN tv.action IN {good_actions} THEN 1 ELSE 0 END) AS good_deals,
    AVG(tv.discount_percent)                AS avg_discount,
    MIN(tv.promo_price)                     AS min_price,
    AVG(tv.promo_price)                     AS avg_price
FROM timeseries_values tv
JOIN product_variants pv ON tv.variant_id = pv.id
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3
"""

def load_seasonal(engine) -> pd.DataFrame:
    sql = SEASONAL_SQL.format(good_actions=str(GOOD_ACTIONS))
    return pd.read_sql(text(sql), engine)


# ---------------------------------------------------------------------------
# Top products
# ---------------------------------------------------------------------------

TOP_PRODUCTS_SQL = """
SELECT
    p.product_id,
    p.name,
    p.gender,
    COUNT(*)                                            AS observations,
    SUM(CASE WHEN tv.action IN {good_actions} THEN 1 ELSE 0 END) AS good_deal_count,
    MIN(tv.promo_price)                                 AS min_price_ever,
    AVG(tv.promo_price)                                 AS avg_price,
    MAX(tv.discount_percent)                            AS max_discount,
    AVG(tv.discount_percent)                            AS avg_discount,
    ROUND(AVG(tv.rating)::numeric, 2)                   AS avg_rating,
    MAX(tv.reviews)                                     AS max_reviews
FROM timeseries_values tv
JOIN product_variants pv ON tv.variant_id = pv.id
JOIN parent p             ON pv.parent_id = p.id
GROUP BY p.product_id, p.name, p.gender
ORDER BY good_deal_count DESC
LIMIT 50
"""

def load_top_products(engine) -> pd.DataFrame:
    sql = TOP_PRODUCTS_SQL.format(good_actions=str(GOOD_ACTIONS))
    return pd.read_sql(text(sql), engine)
