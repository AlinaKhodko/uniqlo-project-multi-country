import pandas as pd
import numpy as np
import re
from pathlib import Path
from datetime import datetime
import json
import argparse

from utils import load_country_config, save_or_append_df

# Paths
CSV_PATH = 'product-ids/uniqlo-products.csv'
ID_PATH = 'product-ids/filtered-ids.txt'
BLOCK_PATH = 'product-ids/blocked_ids.json'
OUTPUT_CSV = 'product-ids/filtered-uniqlo-products.csv'

# Parse arguments
parser = argparse.ArgumentParser()
parser.add_argument("--country", type=str, default="de", help="Country code (e.g. de, nl, fr)")
args = parser.parse_args()

config = load_country_config(args.country)
TARGET_IDS_FILE = f'product-ids/target-ids-{args.country}.txt'
print(f"Country: {args.country.upper()} | Filter mode: {config['filter_mode']}")

# Load and clean product data
df = pd.read_csv(CSV_PATH)

def clean_price(price_str):
    if pd.isna(price_str):
        return None
    price_str = price_str.replace('€', '').replace(',', '.').strip()
    match = re.findall(r'\d+\.?\d*', price_str)
    return float(match[0]) if match else None

df['Promo Price'] = df['Price (Promo)'].apply(clean_price)
df['Original Price'] = df['Price (Original)'].apply(clean_price)
df['Discount %'] = ((df['Original Price'] - df['Promo Price']) / df['Original Price']) * 100
df['Discount %'] = df['Discount %'].round(2)

df['Reviews'] = df['Reviews'].replace('', pd.NA).fillna(0)
df['Rating'] = df['Rating'].replace('', pd.NA).fillna(0)

df['Reviews'] = df['Reviews'].replace('[^0-9]', '', regex=True).astype(float)
df['Rating'] = pd.to_numeric(df['Rating'], errors='coerce')
df.dropna(subset=['Reviews', 'Rating', 'Discount %'], inplace=True)

# Smart review score (rating x log scale reviews)
df['Review_Score'] = df['Rating'] * np.log10(df['Reviews'] + 1)
df['Review_Score'] = df['Review_Score'].round(2)
# Quantiles (rounded to 1 digit)
df['Review_Score_Quantile'] = df['Review_Score'].rank(pct=True).round(2)
df['Discount_Quantile'] = df['Discount %'].rank(pct=True).round(2)

# Extract and format the unique timestamp from the 'Fetched At' column
try:
    unique_timestamp = df['Fetched At'].dropna().unique()[0]
    timestamp_dt = pd.to_datetime(unique_timestamp)
    timestamp_str = timestamp_dt.strftime('%Y-%m-%d %H:%M')
    title_with_time = f'UNIQLO Product Insights ({timestamp_str})'
except Exception as e:
    title_with_time = 'UNIQLO Product Insights'
    print(f"Could not format 'Fetched At' timestamp: {e}")

# Categorize products
def classify_action(row):
    r_q = row['Review_Score_Quantile']
    d_q = row['Discount_Quantile']
    discount = row['Discount %']
    price = row['Promo Price']

    if r_q >= 0.9 and d_q >= 0.80:
        return 'SUPER'
    elif r_q >= 0.9 and 0.5 <= d_q < 0.80:
        return 'WAIT FOR SALE'
    elif r_q >= 0.80 and d_q >= 0.80:
        return 'GOOD DEAL'
    elif r_q >= 0.80 and 0.4 <= d_q < 0.80:
        return 'DECENT'
    elif 0.7 <= r_q < 0.8 and d_q >= 0.8:
        return 'CHEAP UPPER MID'
    elif r_q < 0.5 and d_q >= 0.9:
        return 'CHEAP BUT MID'
    elif discount >= 76:
        return 'BIG DISCOUNT'
    elif price is not None and price <= 5:
        return 'VERY CHEAP'
    elif r_q < 0.3 and d_q < 0.3:
        return 'AVOID'
    else:
        return 'NEUTRAL'

df['Action'] = df.apply(classify_action, axis=1)

# Select products based on filter_mode from config
selected_actions = {'SUPER', 'GOOD DEAL', 'CHEAP UPPER MID', 'BIG DISCOUNT'}

if config['filter_mode'] == 'all':
    filtered_ids = (
        df['Product ID']
        .dropna()
        .astype(str)
        .tolist()
    )
else:
    filtered_ids = (
        df[df['Action'].isin(selected_actions)]['Product ID']
        .dropna()
        .astype(str)
        .tolist()
    )

# Load block list
blocked_ids = {}
if Path(BLOCK_PATH).exists():
    with open(BLOCK_PATH, 'r') as f:
        blocked_ids = json.load(f)
print(blocked_ids)
filtered_ids = [pid for pid in filtered_ids if blocked_ids.get(pid) is not True]

# Load existing interested IDs
existing_ids = set()
if Path(TARGET_IDS_FILE).exists():
    with open(TARGET_IDS_FILE, 'r') as f:
        existing_ids = set(line.strip() for line in f if line.strip())

# Append new IDs (no duplicates)
updated_ids = sorted(existing_ids.union(filtered_ids))
with open(ID_PATH, 'w') as f:
    for pid in updated_ids:
        f.write(pid + '\n')

print(f"Added {len(filtered_ids)} new IDs. Total now: {len(updated_ids)}")

# Save enriched CSV
df.to_csv(CSV_PATH, index=False)
print(f"Updated dataset with metrics saved to {CSV_PATH}")

save_or_append_df(df, 'product-ids/uniqlo-raw-history.csv')

if config['filter_mode'] == 'all':
    print(existing_ids)
    filtered_df = df[df['Product ID'].astype(str).isin(existing_ids)]
    print(filtered_df)
else:
    filtered_df = df[df['Product ID'].astype(str).isin(updated_ids)]

columns_to_drop = ['Price (Promo)', 'Price (Original)']
filtered_df_csv = filtered_df.drop(columns=[col for col in columns_to_drop if col in filtered_df.columns])

# Exclude fully-blocked products so fetch-sizes.js skips them entirely
filtered_df_csv = filtered_df_csv[
    ~filtered_df_csv['Product ID'].astype(str).apply(lambda pid: blocked_ids.get(pid) is True)
]

# Save filtered dataset
filtered_df_csv.to_csv(OUTPUT_CSV, index=False)

print(f"Filtered {len(filtered_df)} rows out of {len(df)}")
print(f"Saved filtered file to: {OUTPUT_CSV}")
