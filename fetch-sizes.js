const puppeteer = require('puppeteer');
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

const INPUT_CSV = 'product-ids/filtered-uniqlo-products.csv';
const OUTPUT_CSV = 'product-ids/uniqlo-with-sizes.csv';
const N = argv.limit;
const CONCURRENCY = 5;
const BATCH_SIZE = 20;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function withRetry(fn, attempts = 2, backoff = 2000) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      console.warn(`Retry ${i + 1}/${attempts - 1}: ${err.message}`);
      await sleep(backoff * (i + 1));
    }
  }
}

async function acceptCookies(browser, localePath) {
  const page = await browser.newPage();
  try {
    await page.goto(`https://www.uniqlo.com/${localePath}`, {
      waitUntil: 'networkidle2',
      timeout: 20000
    });
    try {
      await page.waitForSelector('button#onetrust-accept-btn-handler', { timeout: 5000 });
      await page.click('button#onetrust-accept-btn-handler');
      await sleep(1000);
      console.log('Accepted cookies on throwaway page');
    } catch {
      console.log('No cookie popup found');
    }
  } finally {
    await page.close();
  }
}

async function discoverColorUrls(page, baseUrl) {
  // Extract all color variant URLs from the product page's color chips
  const colorCodes = await page.evaluate(() => {
    const chips = document.querySelectorAll('[data-testid="color-chip"] a, .color-chip a, a[href*="colorDisplayCode"]');
    const codes = new Set();
    chips.forEach(chip => {
      const href = chip.getAttribute('href') || '';
      const match = href.match(/colorDisplayCode=(\d+)/);
      if (match) codes.add(match[1]);
    });
    // Also try image sources as fallback
    if (codes.size === 0) {
      document.querySelectorAll('img[src*="goods_"]').forEach(img => {
        const match = (img.getAttribute('src') || '').match(/goods_(\d{2})_/);
        if (match) codes.add(match[1]);
      });
    }
    return [...codes];
  });

  if (colorCodes.length === 0) return [];

  // Build URLs from the current page URL pattern
  const urlObj = new URL(baseUrl);
  const basePath = urlObj.origin + urlObj.pathname;
  return colorCodes.map(code => `${basePath}?colorDisplayCode=${code}`);
}

async function extractColorAndSizes(url, browser, colorLabel) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Extract selected color using country-specific label
    const color = await page.evaluate((label) => {
      const el = Array.from(document.querySelectorAll('[data-testid="ITOTypography"]'))
        .find(e => {
          const text = e.textContent?.trim() || '';
          return text.startsWith(label);
        });

      if (!el) return null;

      const text = el.textContent.trim();
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedLabel}\\s+(\\d+)\\s+(.+)$`);
      const match = text.match(regex);
      if (!match) return null;

      const code = match[1];
      const name = match[2];

      const pathMatch = window.location.pathname.match(/products\/[^/]+\/(\w+)/);
      const pathPart = pathMatch ? pathMatch[1] : '00';

      return `${pathPart}${code}-${name.toUpperCase()}`;
    }, colorLabel);

    // Extract available sizes
    await page.waitForSelector('.size-chip-group', { timeout: 10000 });
    const sizes = await page.evaluate(() => {
      const wrappers = Array.from(document.querySelectorAll('.size-chip-wrapper'));
      return wrappers
        .filter(wrapper => !wrapper.querySelector('.strike')) // Only available sizes
        .map(wrapper => {
          const button = wrapper.querySelector('button');
          return button?.innerText?.trim() || null;
        })
        .filter(Boolean);
    });

    console.log(`Color: ${color || 'Unknown'}`);
    console.log(`Sizes: ${sizes.join(', ') || 'None'}`);
    return color && sizes.length > 0 ? `${color}: ${sizes.join(', ')}` : null;
  } catch (err) {
    console.error(`Failed to scrape ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

function saveProgress(rows, outputPath) {
  const csvOutput = parse(rows, { fields: Object.keys(rows[0]) });
  fs.writeFileSync(outputPath, csvOutput, 'utf8');
}

(async () => {
  const rows = [];
  const colorLabel = config.color_label;
  const outputPath = path.join(__dirname, OUTPUT_CSV);

  // Read CSV
  await new Promise((resolve, reject) => {
    fs.createReadStream(path.join(__dirname, INPUT_CSV))
      .pipe(csv())
      .on('data', row => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1400,1000']
  });

  // Accept cookies once on a throwaway page
  await acceptCookies(browser, config.locale_path);

  const total = Math.min(N, rows.length);
  let processed = 0;

  async function processProduct(row) {
    let urls = row['Color Variant URLs']
      ? row['Color Variant URLs'].split('|').map(url => url.trim()).filter(Boolean)
      : [];

    // Discover all color variants from the first product page
    if (urls.length > 0) {
      try {
        const discoveryPage = await browser.newPage();
        await discoveryPage.setViewport({ width: 1400, height: 1000 });
        await discoveryPage.setUserAgent(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        );
        await discoveryPage.goto(urls[0], { waitUntil: 'networkidle2', timeout: 20000 });
        const discoveredUrls = await discoverColorUrls(discoveryPage, urls[0]);
        await discoveryPage.close();

        if (discoveredUrls.length > urls.length) {
          console.log(`Discovered ${discoveredUrls.length} color variants (CSV had ${urls.length})`);
          urls = discoveredUrls;
        }
      } catch (err) {
        console.warn(`Color discovery failed, using CSV URLs: ${err.message}`);
      }
    }

    const variants = [];

    console.log(`\n${row['Product Name']} (${urls.length} color variants)`);

    // Color variants stay sequential
    for (const url of urls) {
      console.log(`${url}`);
      const result = await withRetry(() => extractColorAndSizes(url, browser, colorLabel));
      if (result) variants.push(result);
    }

    row['Available Sizes'] = variants.join(' | ') || 'Unavailable';
    processed++;

    if (processed % BATCH_SIZE === 0) {
      saveProgress(rows, outputPath);
      console.log(`Saved progress (${processed}/${total})`);
    }
  }

  // Process products with concurrency pool
  for (let i = 0; i < total; i += CONCURRENCY) {
    const batch = rows.slice(i, Math.min(i + CONCURRENCY, total));
    await Promise.all(batch.map(row => processProduct(row)));
  }

  // Final save
  saveProgress(rows, outputPath);
  await browser.close();
  console.log(`\nFinal CSV saved to ${OUTPUT_CSV}`);
})();
