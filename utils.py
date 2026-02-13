import json
import os
import pandas as pd
from pathlib import Path


def load_country_config(country: str) -> dict:
    """Load config for a given country code from country-config.json."""
    config_path = Path(__file__).parent / 'country-config.json'
    with open(config_path, 'r') as f:
        all_configs = json.load(f)
    if country not in all_configs:
        raise ValueError(f"Unknown country '{country}'. Available: {list(all_configs.keys())}")
    return all_configs[country]


def save_or_append_df(df: pd.DataFrame, csv_path: str):
    """
    Saves a DataFrame to a CSV file. Appends to the file if it exists, including only data rows (no header).
    If the file does not exist, creates it with headers.
    """
    if os.path.exists(csv_path):
        df.to_csv(csv_path, mode='a', header=False, index=False)
        print(f"Appended {len(df)} rows to {csv_path}")
    else:
        df.to_csv(csv_path, index=False)
        print(f"Created new file and saved {len(df)} rows to {csv_path}")
