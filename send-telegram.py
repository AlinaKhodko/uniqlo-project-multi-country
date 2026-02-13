import os
import pandas as pd
import requests
import json
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


# 🧠 Blocklist logic
def is_blocked(product_id, sizes_str, blocklist):
    if product_id not in blocklist:
        return False

    rule = blocklist[product_id]

    # Fully blocked
    if rule is True:
        return True

    if not sizes_str or pd.isna(sizes_str):
        return False

    sizes_str = sizes_str.upper()
    blocked_colors = [color.upper() for color in rule]

    return any(color in sizes_str for color in blocked_colors)


# ✍️ Build message
def create_message_from_csv(csv_path, max_items=40):
    if not Path(csv_path).exists():
        return "❌ No product data found."

    df = pd.read_csv(csv_path)

    if df.empty:
        return "ℹ️ No interesting products to report."

    # 🔒 Load blocked list
    blocklist = {}
    if Path(BLOCKED_PATH).exists():
        with open(BLOCKED_PATH, 'r') as f:
            blocklist = json.load(f)

    # 🧹 Filter blocked
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

        message += f"\n🔗 [{name}]({url})"
        message += f"\n💸 *-{int(discount)}%* | 🪙 {promo} | ⭐ {rating} ({int(float(reviews))} reviews)"
        if sizes and sizes != 'Unavailable':
            message += f"\n🧵 Sizes: `{sizes}`"
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
