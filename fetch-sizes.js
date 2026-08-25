// Reads available sizes per colour from Uniqlo's own JSON API.
//
// Replaces the Puppeteer scraper (kept as fetch-sizes-browser.js). The product
// pages sit behind an Akamai bot wall that 403s headless Chrome, but the API the
// page itself calls answers a plain HTTPS request as long as the x-fr-clientid
// header is present. Two calls per product:
//
//   details -> colour names, size names, display order
//   l2s     -> every colour x size combination plus its stock status
//
// Output format is identical to the browser version, so filter-sizes.py and
// everything downstream is unchanged.

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { parse } = require('json2csv');
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
  .option('limit', {
    alias: 'n',
    type: 'number',
    default: 100,
    description: 'Number of products to process'
  })
  .help()
  .argv;

const config = countryConfig[argv.country];
const COUNTRY = argv.country;

const INPUT_CSV = 'product-ids/filtered-uniqlo-products.csv';
const OUTPUT_CSV = 'product-ids/uniqlo-with-sizes.csv';
const N = argv.limit;
const CONCURRENCY = 5;
const BATCH_SIZE = 5;

const API_BASE = `https://www.uniqlo.com/${COUNTRY}/api/commerce/v5/${COUNTRY}`;
// The web app identifies itself with this header; without it the API replies
// 400 "invalid or missing client id".
const CLIENT_ID = config.api_client_id || `uq.${COUNTRY}.web-spa`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

let failedRequests = 0;

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

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

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

  failedRequests++;
  throw lastError;
}

// Product URLs look like /de/de/products/E481369-000/00?colorDisplayCode=69 -
// the segment after the product id is the price group, which the API needs.
function parseProductRef(row) {
  const url = row['Product URL'] || (row['Color Variant URLs'] || '').split('|')[0] || '';
  const match = url.match(/\/products\/(E?\d+-\d+)(?:\/(\w+))?/);

  if (match) {
    return { productId: match[1], priceGroup: match[2] || '00' };
  }
  if (row['Product ID']) {
    return { productId: row['Product ID'], priceGroup: '00' };
  }
  return null;
}

async function fetchSizes(productId, priceGroup) {
  const base = `${API_BASE}/products/${productId}/price-groups/${priceGroup}`;

  const [details, l2s] = await Promise.all([
    getJson(`${base}/details?includeModelSize=true&httpFailure=true`),
    getJson(`${base}/l2s?withPrices=true&withStocks=true&httpFailure=true`)
  ]);

  const sizeNames = new Map((details.sizes || []).map(s => [s.displayCode, s.name]));
  const sizeOrder = new Map((details.sizes || []).map((s, i) => [s.displayCode, i]));
  const stocks = l2s.stocks || {};

  // disableSizeChip is the flag the site uses to strike a size chip through, so it
  // matches what the browser scraper read off the DOM across IN_STOCK, LOW_STOCK
  // and STOCK_OUT alike.
  const availableByColor = new Map();
  for (const item of l2s.l2s || []) {
    const stock = stocks[item.l2Id];
    if (!stock || stock.disableSizeChip) continue;

    const colorCode = item.color.displayCode;
    if (!availableByColor.has(colorCode)) availableByColor.set(colorCode, []);
    availableByColor.get(colorCode).push(item.size.displayCode);
  }

  const variants = [];
  for (const color of details.colors || []) {
    const codes = availableByColor.get(color.displayCode);
    if (!codes || codes.length === 0) continue;

    const sizes = [...new Set(codes)]
      .sort((a, b) => (sizeOrder.get(a) ?? 99) - (sizeOrder.get(b) ?? 99))
      .map(code => sizeNames.get(code) || code);

    // Same label shape as the browser version: price group + colour code + name.
    variants.push(`${priceGroup}${color.displayCode}-${color.name.toUpperCase()}: ${sizes.join(', ')}`);
  }

  return variants;
}

function saveProgress(rows, outputPath) {
  const csvOutput = parse(rows, { fields: Object.keys(rows[0]) });
  fs.writeFileSync(outputPath, csvOutput, 'utf8');
}

(async () => {
  const rows = [];
  const outputPath = path.join(__dirname, OUTPUT_CSV);

  await new Promise((resolve, reject) => {
    fs.createReadStream(path.join(__dirname, INPUT_CSV))
      .pipe(csv())
      .on('data', row => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  const total = Math.min(N, rows.length);
  let processed = 0;

  async function processProduct(row) {
    const ref = parseProductRef(row);

    if (!ref) {
      console.log(`[${row['Product Name']}] No product id - skipping`);
      row['Available Sizes'] = 'Unavailable';
      processed++;
      return;
    }

    try {
      const variants = await fetchSizes(ref.productId, ref.priceGroup);

      if (variants.length > 0) {
        console.log(`[${row['Product Name']}] ${variants.length} colour(s) in stock`);
        for (const variant of variants) console.log(`  ${variant}`);
      } else {
        console.log(`[${row['Product Name']}] Sold out in every colour`);
      }

      row['Available Sizes'] = variants.length > 0 ? variants.join(' | ') : 'Unavailable';
    } catch (err) {
      console.error(`[${row['Product Name']}] Failed (${ref.productId}/${ref.priceGroup}): ${err.message}`);
      row['Available Sizes'] = 'Unavailable';
    }

    processed++;

    if (processed % BATCH_SIZE === 0) {
      saveProgress(rows, outputPath);
      console.log(`--- Saved progress (${processed}/${total}) ---`);
    }
  }

  for (let i = 0; i < total; i += CONCURRENCY) {
    const batch = rows.slice(i, Math.min(i + CONCURRENCY, total));
    await Promise.all(batch.map(row => processProduct(row)));
  }

  saveProgress(rows, outputPath);

  const withSizes = rows.slice(0, total).filter(r => r['Available Sizes'] !== 'Unavailable').length;
  console.log(`\nFinal CSV saved to ${OUTPUT_CSV}`);
  console.log(`${withSizes}/${total} products have at least one size in stock`);
  if (failedRequests > 0) {
    console.error(`WARNING: ${failedRequests} API request(s) failed after ${MAX_RETRIES} attempts.`);
  }
})();
