import os
import json
import argparse
import pandas as pd
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

def get_client():
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_KEY must be set in .env")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ---------------------------------------------------------------------------
# products
# ---------------------------------------------------------------------------

def upsert_products(csv_path: str, country: str):
    """Load filtered-uniqlo-products.csv (or uniqlo-with-sizes.csv) and upsert into products table."""
    df = pd.read_csv(csv_path)
    client = get_client()

    rows = []
    for _, row in df.iterrows():
        rows.append({
            "id":           str(row["Product ID"]),
            "country":      country,
            "name":         row.get("Product Name"),
            "promo_price":  float(row["Promo Price"])  if pd.notna(row.get("Promo Price"))  else None,
            "orig_price":   float(row["Original Price"]) if pd.notna(row.get("Original Price")) else None,
            "discount_pct": float(row["Discount %"])   if pd.notna(row.get("Discount %"))   else None,
            "rating":       float(row["Rating"])        if pd.notna(row.get("Rating"))        else None,
            "reviews":      int(float(row["Reviews"]))  if pd.notna(row.get("Reviews"))       else None,
            "review_score": float(row["Review_Score"])  if pd.notna(row.get("Review_Score"))  else None,
            "action":       row.get("Action"),
            "product_url":  row.get("Product URL"),
            "fetched_at":   row.get("Fetched At"),
        })

    result = client.table("products").upsert(rows).execute()
    print(f"[products] Upserted {len(rows)} rows for country={country}")
    return result


# ---------------------------------------------------------------------------
# product_sizes
# ---------------------------------------------------------------------------

def _parse_sizes_str(sizes_str: str):
    """Parse 'COLOR_CODE-NAME: S, M, L | ...' into list of dicts."""
    variants = []
    if not sizes_str or str(sizes_str).strip().lower() == "unavailable":
        return variants
    for variant in str(sizes_str).split("|"):
        variant = variant.strip()
        if not variant or ":" not in variant:
            continue
        color_part, sizes_part = variant.split(":", 1)
        color_part = color_part.strip()
        # color_part format: '0069-DUNKELBLAU'
        if "-" in color_part:
            code, name = color_part.split("-", 1)
        else:
            code, name = color_part, color_part
        sizes = [s.strip() for s in sizes_part.split(",") if s.strip()]
        variants.append({"color_code": code, "color_name": name, "sizes": sizes})
    return variants


def upsert_product_sizes(csv_path: str, country: str):
    """Load uniqlo-with-sizes.csv and upsert into product_sizes table."""
    df = pd.read_csv(csv_path)
    client = get_client()

    rows = []
    for _, row in df.iterrows():
        pid = str(row["Product ID"])
        fetched_at = row.get("Fetched At")
        for variant in _parse_sizes_str(row.get("Available Sizes", "")):
            rows.append({
                "product_id": pid,
                "country":    country,
                "color_code": variant["color_code"],
                "color_name": variant["color_name"],
                "sizes":      variant["sizes"],
                "fetched_at": fetched_at,
            })

    result = client.table("product_sizes").upsert(rows).execute()
    print(f"[product_sizes] Upserted {len(rows)} color variants for country={country}")
    return result


# ---------------------------------------------------------------------------
# blocked_products
# ---------------------------------------------------------------------------

def sync_blocked_products(json_path: str, country: str = None):
    """Push blocked_ids.json into blocked_products table."""
    with open(json_path, "r") as f:
        blocklist = json.load(f)

    client = get_client()
    rows = []

    for product_id, rule in blocklist.items():
        if rule is True:
            rows.append({
                "product_id":     product_id,
                "country":        country,
                "blocked_colors": None,
            })
        elif isinstance(rule, list):
            rows.append({
                "product_id":     product_id,
                "country":        country,
                "blocked_colors": rule,
            })

    result = client.table("blocked_products").upsert(rows).execute()
    print(f"[blocked_products] Synced {len(rows)} entries")
    return result


def fetch_blocked_products(country: str = None) -> dict:
    """Fetch blocked_products from DB and return in blocked_ids.json format."""
    client = get_client()
    query = client.table("blocked_products").select("*")
    if country:
        query = query.or_(f"country.eq.{country},country.is.null")
    result = query.execute()

    blocklist = {}
    for row in result.data:
        pid = row["product_id"]
        colors = row.get("blocked_colors")
        blocklist[pid] = colors if colors else True

    return blocklist


# ---------------------------------------------------------------------------
# sent_digests
# ---------------------------------------------------------------------------

def mark_as_sent(product_ids: list, country: str):
    """Record which products were included in the latest Telegram digest."""
    client = get_client()
    rows = [{"product_id": pid, "country": country} for pid in product_ids]
    result = client.table("sent_digests").insert(rows).execute()
    print(f"[sent_digests] Marked {len(rows)} products as sent for country={country}")
    return result


def was_sent_recently(product_id: str, country: str, within_days: int = 7) -> bool:
    """Check if a product was already sent in the last N days."""
    client = get_client()
    from datetime import datetime, timedelta
    cutoff = (datetime.utcnow() - timedelta(days=within_days)).isoformat()
    result = (
        client.table("sent_digests")
        .select("product_id")
        .eq("product_id", product_id)
        .eq("country", country)
        .gte("sent_at", cutoff)
        .limit(1)
        .execute()
    )
    return len(result.data) > 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Supabase DB sync for UNIQLO pipeline")
    parser.add_argument("--country", type=str, default="de", help="Country code (e.g. de, nl, fr)")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # upsert-products
    p1 = subparsers.add_parser("upsert-products", help="Upsert products from CSV")
    p1.add_argument("--csv", default="product-ids/filtered-uniqlo-products.csv")

    # upsert-sizes
    p2 = subparsers.add_parser("upsert-sizes", help="Upsert product sizes from CSV")
    p2.add_argument("--csv", default="product-ids/uniqlo-with-sizes.csv")

    # sync-blocked
    p3 = subparsers.add_parser("sync-blocked", help="Push blocked_ids.json to DB")
    p3.add_argument("--json", default="product-ids/blocked_ids.json")

    # fetch-blocked
    subparsers.add_parser("fetch-blocked", help="Print blocked products from DB")

    args = parser.parse_args()

    if args.command == "upsert-products":
        upsert_products(args.csv, args.country)
    elif args.command == "upsert-sizes":
        upsert_product_sizes(args.csv, args.country)
    elif args.command == "sync-blocked":
        sync_blocked_products(args.json, args.country)
    elif args.command == "fetch-blocked":
        data = fetch_blocked_products(args.country)
        print(json.dumps(data, indent=2))
