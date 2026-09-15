// Lists the sale products straight from Uniqlo's JSON API and writes the same
// CSV that fetch-html.js + html-to-csv.js used to produce.
//
// Those two scripts drove the sale page in headless Chrome. Since September
// 2026 the page itself sits behind the Akamai bot wall and answers headless
// Chrome with "Access Denied", so the scrape returned 0 products every run.
// The product-list API the page calls internally still answers a plain HTTPS
// request with the x-fr-clientid header - the same trick fetch-sizes.js uses.
//
// Output columns are unchanged, so deal-filter.py and everything downstream
// keep working:
//   Product ID, Product Name, Price (Promo), Price (Original), Rating,
//   Reviews, Product URL, Color Variant URLs, Fetched At

const fs = require('fs');
const path = require('path');
const yargs = require('yargs');

const countryConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'country-config.json'), 'utf8'));

const argv = yargs
  .option('country', {
    alias: 'c',
    type: 'string',
    default: 'de',
    description: 'Country code (e.g. de, nl, fr)',
    choices: Object.keys(countryConfig)
  })
  .option('gender', {
    alias: 'g',
    type: 'string',
    description: 'Gender section to list (women, men, kids, baby). Default: taken from sale_url'
  })
  .option('output', {
    alias: 'o',
    type: 'string',
    default: './product-ids/uniqlo-products.csv',
    description: 'Output CSV file path'
  })
  .help()
  .argv;

const COUNTRY = argv.country;
const config = countryConfig[COUNTRY];

const API_BASE = `https://www.uniqlo.com/${COUNTRY}/api/commerce/v5/${COUNTRY}`;
const SITE_BASE = 'https://www.uniqlo.com';
const CLIENT_ID = config.api_client_id || `uq.${COUNTRY}.web-spa`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const PAGE_SIZE = 100; // API rejects anything above 100
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

// The sale page URL ends in the gender section (…/feature/sale/women).
const gender = (argv.gender || config.sale_url.split('/').filter(Boolean).pop() || 'women').toUpperCase();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'x-fr-clientid': CLIENT_ID,
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
          'Accept-Language': config.accept_language
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.status !== 'ok') {
        throw new Error(`API status ${body.status}: ${JSON.stringify(body.error || {})}`);
      }
      return body.result;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function productsUrl(params) {
  const query = new URLSearchParams({ httpFailure: 'true', ...params });
  return `${API_BASE}/products?${query}`;
}

// Same shape the DOM used to show, e.g. "19,90 €", so deal-filter.py's
// clean_price() sees nothing new.
function formatPrice(price) {
  if (!price || typeof price.value !== 'number') return '';
  const symbol = price.currency?.symbol || '€';
  return `${price.value.toFixed(2).replace('.', ',')} ${symbol}`;
}

// Timestamp shifted to UTC+3, exactly as fetch-html.js did, so the Telegram
// digest keeps showing the same local time as before.
function fetchedAtTimestamp() {
  const now = new Date();
  now.setHours(now.getHours() + 3);
  return now.toISOString();
}

function toRow(item, fetchedAt) {
  const productId = item.productId;
  const priceGroup = item.priceGroup || '00';
  const baseUrl = `${SITE_BASE}/${config.locale_path}/products/${productId}/${priceGroup}`;

  const defaultColor = item.representativeColorDisplayCode || item.colors?.[0]?.displayCode || null;
  const colorCodes = [defaultColor, ...(item.colors || []).map(c => c.displayCode)].filter(Boolean);
  const colorVariantURLs = [...new Set(colorCodes)]
    .map(code => `${baseUrl}?colorDisplayCode=${code}`)
    .join(' | ');

  const productURL = defaultColor ? `${baseUrl}?colorDisplayCode=${defaultColor}` : baseUrl;

  const rating = item.rating?.average != null ? String(item.rating.average) : '';
  const reviews = item.rating?.count != null ? String(item.rating.count) : '';

  return [
    productId,
    (item.name || '').replace(/\s+/g, ' ').trim(),
    formatPrice(item.prices?.promo),
    formatPrice(item.prices?.base),
    rating,
    reviews,
    productURL,
    colorVariantURLs,
    fetchedAt
  ];
}

(async () => {
  // Gender ids come back in the category tree of any listing response, so
  // look them up instead of hard-coding (they are the same for de/nl/fr today).
  const probe = await getJson(productsUrl({ limit: '1', offset: '0', flagCodes: 'discount' }));
  const genders = probe.aggregations?.tree?.genders || [];
  const genderNode = genders.find(g => g.name.toUpperCase() === gender);
  if (!genderNode) {
    console.error(`Gender "${gender}" not found. Available: ${genders.map(g => g.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`Country: ${COUNTRY.toUpperCase()} | Section: ${gender} (id ${genderNode.id}) | Filter: discount`);

  const fetchedAt = fetchedAtTimestamp();
  const header = ['Product ID', 'Product Name', 'Price (Promo)', 'Price (Original)', 'Rating', 'Reviews', 'Product URL', 'Color Variant URLs', 'Fetched At'];
  const rows = [header];
  const seen = new Set();
  const stats = { total: 0, noPromo: 0, noRating: 0 };

  let offset = 0;
  let expected = null;

  while (expected === null || offset < expected) {
    const result = await getJson(productsUrl({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      path: `${genderNode.id},,,`,
      flagCodes: 'discount'
    }));

    const items = result.items || [];
    expected = result.pagination?.total ?? items.length;
    console.log(`Page offset ${offset}: ${items.length} products (total ${expected})`);

    for (const item of items) {
      if (!item.productId || seen.has(item.productId)) continue;
      seen.add(item.productId);

      const row = toRow(item, fetchedAt);
      rows.push(row);
      stats.total++;
      if (!row[2]) stats.noPromo++;
      if (!row[4]) stats.noRating++;

      console.log(`Parsed: ${row[1]} | ${row[2] || '—'} (was ${row[3] || '—'}) | ⭐ ${row[4] || '—'} (${row[5] || '0'}) | ${row[7].split(' | ').length} colour(s)`);
    }

    if (items.length === 0) break;
    offset += items.length;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Parsed products : ${stats.total}`);
  console.log(`No promo price  : ${stats.noPromo}  ${stats.noPromo === 0 ? '✓' : '⚠ will be dropped by deal-filter'}`);
  console.log(`No rating       : ${stats.noRating}`);

  const csvData = rows.map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',')).join('\n');
  fs.mkdirSync(path.dirname(argv.output), { recursive: true });
  fs.writeFileSync(argv.output, csvData, 'utf8');
  console.log(`Saved ${rows.length - 1} products to ${argv.output} with timestamp: ${fetchedAt}`);

  if (stats.total === 0) {
    console.error('WARNING: API returned no products - check the filter or the API response format.');
    process.exit(1);
  }
})().catch(err => {
  console.error(`fetch-products.js failed: ${err.message}`);
  process.exit(1);
});
