import os
import pandas as pd
import requests
import json
import re
from pathlib import Path
from dotenv import load_dotenv
from datetime import datetime

# 📂 Load environment variables
load_dotenv()
BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN')
CHAT_ID = os.getenv('TELEGRAM_CHAT_ID')

# 📄 Paths
CSV_PATH = 'product-ids/sizes-filtered.csv'
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


# 🧠 Blocklist logic
def is_blocked(product_id, sizes_str, blocklist):
    """Check if a product is fully blocked (returns True) or needs filtering (returns False).
    Color-only blocking that removes all variants also returns True."""
    if product_id not in blocklist:
        return False

    rule = blocklist[product_id]
    if rule is True:
        return True

    rule = normalize_rule(rule)
    if rule is None:
        return False

    blocked_colors = [c.upper() for c in rule.get("colors", [])]
    if not blocked_colors:
        return False

    # If there are blocked colors but no sizes field, check if ALL variants are blocked
    if not sizes_str or pd.isna(sizes_str):
        return False

    sizes_str_upper = str(sizes_str).upper()
    # Check if every variant matches a blocked color
    for variant in sizes_str_upper.split('|'):
        variant = variant.strip()
        if not variant:
            continue
        if ':' in variant:
            color_part = variant.split(':', 1)[0].strip()
        else:
            color_part = variant
        if not any(bc in color_part for bc in blocked_colors):
            return False  # At least one variant is not blocked

    return True  # All variants matched blocked colors


def filter_sizes_from_variant(sizes_part, blocked_sizes):
    """Remove blocked sizes from a comma-separated sizes string."""
    sizes = [s.strip() for s in sizes_part.split(',') if s.strip()]
    filtered = [s for s in sizes if s.upper() not in blocked_sizes]
    return ', '.join(filtered)


def filter_variants(sizes_str, product_id, blocklist):
    """Apply color + size blocking to the sizes string. Returns cleaned string or empty."""
    if not sizes_str or pd.isna(sizes_str) or str(sizes_str).strip().lower() == 'unavailable':
        return sizes_str

    rule = blocklist.get(product_id)
    rule = normalize_rule(rule) if rule is not None else {}
    if rule is True:
        return ''  # Fully blocked, shouldn't reach here but safe

    blocked_colors = set(c.upper() for c in (rule.get("colors", []) if isinstance(rule, dict) else []))
    blocked_sizes_product = set(s.upper() for s in (rule.get("sizes", []) if isinstance(rule, dict) else []))
    global_blocked = set(s.upper() for s in blocklist.get("global_blocked_sizes", []))
    all_blocked_sizes = blocked_sizes_product | global_blocked

    result_variants = []
    for variant in str(sizes_str).split('|'):
        variant = variant.strip()
        if not variant:
            continue

        # Check color blocking
        if blocked_colors and ':' in variant:
            color_part = variant.split(':', 1)[0].strip().upper()
            if any(bc in color_part for bc in blocked_colors):
                continue  # Skip this variant entirely

        # Apply size blocking
        if all_blocked_sizes:
            if ':' in variant:
                color_part, sizes_part = variant.split(':', 1)
                filtered = filter_sizes_from_variant(sizes_part, all_blocked_sizes)
                if not filtered:
                    continue  # No sizes left
                variant = f"{color_part}: {filtered}"
            else:
                filtered = filter_sizes_from_variant(variant, all_blocked_sizes)
                if not filtered:
                    continue
                variant = filtered

        result_variants.append(variant)

    return ' | '.join(result_variants)


# ✍️ Build message
def create_message_from_csv(csv_path, max_items=40):
    if not Path(csv_path).exists():
        return "❌ No product data found."

    df = pd.read_csv(csv_path)

    if df.empty:
        return "ℹ️ No interesting products to report."

    # 🔒 Load blocked list
    blocklist = load_blocked_config()

    # 🧹 Filter fully blocked products
    df = df[~df.apply(lambda row: is_blocked(row['Product ID'], row.get('Available Sizes', ''), blocklist), axis=1)]

    if df.empty:
        return "ℹ️ All results were filtered by blocklist."

    # 📆 Timestamp from Fetched At
    try:
        timestamp = pd.to_datetime(df['Fetched At'].dropna().iloc[0])
        date_str = timestamp.strftime('%d %b %Y • %H:%M')
    except:
        date_str = 'Unknown Time'

    df = df.sort_values(by='Product Name', ascending=False).head(max_items)

    message = f"*🛍️ UNIQLO Digest ({date_str})*\n"

    for _, row in df.iterrows():
        name = row['Product Name']
        url = row['Product URL']
        discount = row.get('Discount %', '')
        rating = row.get('Rating', '')
        reviews = row.get('Reviews', '')
        action = row.get('Action', '')
        sizes = row.get('Available Sizes', '')
        promo = row.get('Promo Price', '')

        # Apply variant-level filtering (color + size blocking)
        filtered_sizes = filter_variants(sizes, row['Product ID'], blocklist)

        # If all variants were removed, skip this product
        if not filtered_sizes or filtered_sizes.strip().lower() == 'unavailable':
            continue

        message += f"\n🔗 [{name}]({url})"
        message += f"\n💸 *-{int(discount)}%* | 🪙 {promo} | ⭐ {rating} ({int(float(reviews))} reviews)"
        for variant in str(filtered_sizes).split('|'):
            variant = variant.strip()
            if variant:
                message += f"\n🧵 `{variant}`"
        if action:
            message += f"\n🎯 _{action}_"
        message += "\n"

    return message.strip()


# 📤 Send to Telegram
def send_telegram(text):
    if not BOT_TOKEN or not CHAT_ID:
        print("❌ Missing Telegram credentials.")
        return False

    url = f'https://api.telegram.org/bot{BOT_TOKEN}/sendMessage'
    payload = {
        'chat_id': CHAT_ID,
        'text': text,
        'parse_mode': 'Markdown',
        'disable_web_page_preview': False
    }

    try:
        res = requests.post(url, json=payload)
        if res.ok:
            print("✅ Telegram message sent")
        else:
            print(f"⚠️ Failed: {res.status_code} - {res.text}")
        return res.ok
    except Exception as e:
        print(f"❌ Telegram error: {e}")
        return False


# 🔁 Entry point
if __name__ == '__main__':
    msg = create_message_from_csv(CSV_PATH)
    print("---- Message Preview ----")
    print(msg)
    print("-------------------------\n")

    send_telegram(msg)
