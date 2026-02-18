import pandas as pd
import argparse
import json
import re
from pathlib import Path

from utils import save_or_append_df

# ✅ Default sizes to keep
DEFAULT_SIZES = {"XS", "S", "M", "L", "XL", "26INCH", "27INCH", "28INCH", "29INCH", "39-42"}

BLOCKED_PATH = 'product-ids/blocked_ids.json'

def load_blocked_config():
    if Path(BLOCKED_PATH).exists():
        with open(BLOCKED_PATH, 'r') as f:
            return json.load(f)
    return {}

def normalize_rule(rule):
    """Normalize a blocklist rule to the canonical dict format."""
    if rule is True:
        return True
    if isinstance(rule, list):
        return {"colors": rule}
    if isinstance(rule, dict):
        return rule
    return None

def get_blocked_sizes(pid, blocklist):
    """Return the set of sizes blocked for a given product ID."""
    global_sizes = set(s.upper() for s in blocklist.get("global_blocked_sizes", []))
    rule = blocklist.get(pid)
    if rule is None or rule is True:
        return global_sizes
    rule = normalize_rule(rule)
    if rule is None:
        return global_sizes
    per_product = set(s.upper() for s in rule.get("sizes", []))
    return global_sizes | per_product

def clean_and_extract_sizes(size_str, blocked_sizes=None):
    if pd.isna(size_str) or str(size_str).strip().lower() == 'unavailable':
        return set()

    if blocked_sizes is None:
        blocked_sizes = set()

    size_str = re.sub(r'\s+', ' ', str(size_str)).strip()  # normalize whitespace

    all_sizes = set()
    for variant in size_str.split('|'):
        if ':' in variant:
            _, sizes_part = variant.split(':', 1)
        else:
            sizes_part = variant
        sizes = [s.strip().upper() for s in sizes_part.split(',') if s.strip()]
        all_sizes.update(sizes)
    return all_sizes - blocked_sizes

def should_keep(row, wanted_sizes, blocklist):
    pid = str(row.get('Product ID', ''))
    blocked_sizes = get_blocked_sizes(pid, blocklist)
    remaining = clean_and_extract_sizes(row['Available Sizes'], blocked_sizes)
    sizes_ok = not remaining.isdisjoint(wanted_sizes)
    discount_ok = pd.notna(row['Discount %']) and float(row['Discount %']) >= 35
    return sizes_ok and discount_ok


def main(input_csv, output_csv, wanted_sizes):
    blocklist = load_blocked_config()

    df = pd.read_csv(input_csv)
    initial_count = len(df)

    df_filtered = df[df.apply(lambda row: should_keep(row, wanted_sizes, blocklist), axis=1)]
    final_count = len(df_filtered)

    df_filtered.to_csv(output_csv, index=False)
    save_or_append_df(df_filtered, 'product-ids/verified-history.csv')

    print(f"✅ Kept {final_count} rows (from {initial_count}) based on size and discount ≥ 35%")
    print(f"📁 Saved to: {output_csv}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Filter UNIQLO rows by size and discount")
    parser.add_argument("--input", default="uniqlo-products-with-sizes.csv", help="Input CSV path")
    parser.add_argument("--output", default="uniqlo-products-with-sizes-filtered.csv", help="Output CSV path")
    parser.add_argument("--sizes", nargs="*", default=list(DEFAULT_SIZES), help="Sizes to keep (e.g. M L XL)")

    args = parser.parse_args()
    main(args.input, args.output, set(s.upper() for s in args.sizes))
