# UNIQLO Sale Tracker

Automated pipeline that scrapes UNIQLO sale pages, scores deals, checks size availability, and sends alerts to Telegram. Runs hourly on GitHub Actions for multiple countries.

## How It Works

```
fetch-html.js → html-to-csv.js → deal-filter.py → fetch-sizes.js → filter-sizes.py → send-telegram.py → insert-db.py
```

| Step | Script | What it does |
|------|--------|-------------|
| 1 | `fetch-html.js` | Opens sale page in headless Chrome, scrolls to load all products, saves raw HTML |
| 2 | `html-to-csv.js` | Parses HTML into CSV with product names, prices, ratings, and color variant URLs |
| 3 | `deal-filter.py` | Scores products by discount + reviews, classifies as SUPER / GOOD DEAL / AVOID etc. |
| 4 | `fetch-sizes.js` | Visits each product page to check available sizes per color variant |
| 5 | `filter-sizes.py` | Keeps only products with your sizes in stock and discount >= 35% |
| 6 | `send-telegram.py` | Sends a formatted digest to Telegram |
| 7 | `insert-db.py` | Uploads price/size history to Supabase for tracking over time |

## Supported Countries

Configured in `country-config.json`:

| Country | Code | Sale URL |
|---------|------|----------|
| Germany | `de` | `uniqlo.com/de/de/feature/sale/women` |
| Netherlands | `nl` | `uniqlo.com/nl/nl/feature/sale/women` |
| France | `fr` | `uniqlo.com/fr/fr/feature/sale/women` |

## Setup

### Prerequisites

- Node.js 20+
- Python 3.11+

### Install dependencies

```bash
npm install
pip install -r requirements.txt
```

### Environment variables

Create a `.env` file (or set as GitHub Actions secrets):

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
SUPABASE_URL=...
SUPABASE_KEY=...
```

For multiple countries, add suffixed secrets (e.g. `TELEGRAM_BOT_TOKEN_NL`).

## Usage

### Run locally

```bash
# Full pipeline for Germany
node fetch-html.js --country de
node html-to-csv.js --country de
python deal-filter.py --country de
node fetch-sizes.js --country de --limit 10
python filter-sizes.py --input product-ids/uniqlo-with-sizes.csv --output product-ids/sizes-filtered.csv
python send-telegram.py
```

### Run on GitHub Actions

The workflow runs automatically every hour (03:29–20:29 UTC). You can also trigger manually:

**Actions** → **UNIQLO Automation** → **Run workflow** → select country (`de`, `nl`, or `all`)

## Project Structure

```
├── fetch-html.js          # Scrape sale page HTML
├── html-to-csv.js         # Parse HTML → CSV
├── deal-filter.py         # Score and classify deals
├── fetch-sizes.js         # Check size availability
├── filter-sizes.py        # Filter by size + discount
├── send-telegram.py       # Telegram alerts
├── insert-db.py           # Supabase upload
├── utils.py               # Shared helpers
├── country-config.json    # Per-country settings
├── product-ids/           # Runtime data (CSVs, ID lists)
│   ├── blocked_ids.json   # Products to skip
│   ├── target-ids-de.txt  # Tracked product IDs (DE)
│   └── target-ids-nl.txt  # Tracked product IDs (NL)
└── .github/workflows/
    └── main.yml           # GitHub Actions workflow
```

## Configuration

### `country-config.json`

Each country entry controls:
- `locale_path` — URL path segment (e.g. `de/de`)
- `sale_url` — Sale page to scrape
- `color_label` — Localized label for color extraction (e.g. `Farbe:`, `Kleur:`)
- `filter_mode` — `action_filtered` (only top deals) or `all` (track everything)
- `gender_keywords` — URL patterns for gender classification

### `product-ids/blocked_ids.json`

Block specific products or color variants from Telegram alerts:

```json
{
  "E12345": true,
  "E67890": ["09-BLACK", "69-NAVY"]
}
```

## Deal Classification

Products are scored using a composite of discount percentile and review quality (rating x log10 of review count):

| Action | Criteria |
|--------|----------|
| SUPER | Top 10% reviews + top 20% discount |
| GOOD DEAL | Top 20% reviews + top 20% discount |
| WAIT FOR SALE | Top 10% reviews but moderate discount |
| AVOID | Bottom 30% on both metrics |
