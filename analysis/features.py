import pandas as pd
import numpy as np

DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

SEASON_MAP = {12: "Winter", 1: "Winter", 2: "Winter",
              3:  "Spring", 4: "Spring", 5: "Spring",
              6:  "Summer", 7: "Summer", 8: "Summer",
              9:  "Autumn", 10: "Autumn", 11: "Autumn"}


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["day_name"]   = df["day_of_week"].map(lambda d: DAY_NAMES[int(d)])
    df["month_name"] = df["month"].map(lambda m: MONTH_NAMES[int(m) - 1])
    df["season"]     = df["month"].map(lambda m: SEASON_MAP[int(m)])
    df["is_weekend"]  = df["day_of_week"].isin([0, 6])
    df["is_good_deal"] = df["action"].isin(
        ["SUPER", "GOOD DEAL", "BIG DISCOUNT", "VERY CHEAP", "CHEAP UPPER MID"]
    )
    df["days_since_start"] = (
        df["fetched_at"] - df["fetched_at"].min()
    ).dt.total_seconds() / 86400
    return df
