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
const BATCH_SIZE = 5;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

// Extract color name + available sizes from the current page state
async function readColorAndSizes(page, colorLabel, expectedColorCode) {
  // Wait for the specific color code to appear in the label element.
  // Without this, the old SSR-rendered color stays in the DOM after domcontentloaded
  // fires, causing us to read the previous color's data for every subsequent URL.
  try {
    if (expectedColorCode) {
      await page.waitForFunction((label, code) => {
        return Array.from(document.querySelectorAll('[data-testid="ITOTypography"]'))
          .some(e => {
            const text = e.textContent?.trim() || '';
            return text.startsWith(label) && text.includes(code);
          });
      }, { timeout: 8000 }, colorLabel, expectedColorCode);
    } else {
      await page.waitForFunction((label) => {
        return Array.from(document.querySelectorAll('[data-testid="ITOTypography"]'))
          .some(e => (e.textContent?.trim() || '').startsWith(label));
      }, { timeout: 8000 }, colorLabel);
    }
  } catch {}

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

  let sizes = [];
  try {
    await page.waitForSelector('.size-chip-group', { timeout: 3000 });
    sizes = await page.evaluate(() => {
      const wrappers = Array.from(document.querySelectorAll('.size-chip-wrapper'));
      return wrappers
        .filter(wrapper => !wrapper.querySelector('.strike'))
        .map(wrapper => {
          const button = wrapper.querySelector('button');
          return button?.innerText?.trim() || null;
        })
        .filter(Boolean);
    });
  } catch {}

  return { color, sizes };
}

// Discover all color codes from chip images on the current page
async function discoverColorUrls(page) {
  return page.evaluate(() => {
    const productMatch = window.location.pathname.match(/\/products\/([^/]+)/);
    if (!productMatch) return [];
    const fullId = productMatch[1];
    const numericId = fullId.replace(/^E/, '').replace(/-\d+$/, '');
    const basePath = window.location.pathname.replace(/\?.*$/, '');

    const codes = new Set();
    const chipPattern = new RegExp(`chip/goods_(\\d{2})_${numericId}`);

    document.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      const match = src.match(chipPattern);
      if (match) codes.add(match[1]);
    });

    return [...codes].map(code =>
      new URL(`${basePath}?colorDisplayCode=${code}`, window.location.origin).href
    );
  });
}

// Navigate to a URL on an existing page, read color+sizes
async function visitAndRead(page, url, colorLabel, productName) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const colorCode = new URL(url).searchParams.get('colorDisplayCode') || null;
    const { color, sizes } = await readColorAndSizes(page, colorLabel, colorCode);

    if (color && sizes.length > 0) {
      console.log(`  [${productName}] ${color}: ${sizes.join(', ')}`);
      return `${color}: ${sizes.join(', ')}`;
    } else {
      console.log(`  [${productName}] ${color || 'Unknown'}: ${sizes.length > 0 ? sizes.join(', ') : 'None'}`);
      return null;
    }
  } catch (err) {
    console.error(`  [${productName}] Failed (${url}): ${err.message}`);
    return null;
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
    const csvUrls = row['Color Variant URLs']
      ? row['Color Variant URLs'].split('|').map(url => url.trim()).filter(Boolean)
      : [];

    if (csvUrls.length === 0) {
      row['Available Sizes'] = 'Unavailable';
      processed++;
      return;
    }

    console.log(`\n[${row['Product Name']}] ${csvUrls.length} color(s) from CSV`);

    // Open one tab for this entire product
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    const variants = [];
    const seenColors = new Set();

    try {
      // Visit first URL, read color+sizes, discover all colors
      const firstVariant = await visitAndRead(page, csvUrls[0], colorLabel, row['Product Name']);
      if (firstVariant) {
        seenColors.add(firstVariant.split(':')[0]);
        variants.push(firstVariant);
      }

      const discoveredUrls = await discoverColorUrls(page);

      // Merge CSV + discovered URLs, skip the first one
      const visitedUrls = new Set([csvUrls[0]]);
      const allUrls = [...new Set([...csvUrls, ...discoveredUrls])];
      const remaining = allUrls.filter(u => !visitedUrls.has(u));

      if (remaining.length > 0) {
        console.log(`  [${row['Product Name']}] Discovered ${remaining.length} additional color(s)`);
      }

      // Visit remaining on the same tab, stop after 2 consecutive dupes
      let dupeStreak = 0;
      for (const url of remaining) {
        if (dupeStreak >= 2) {
          console.log(`  [${row['Product Name']}] Stopping early — remaining codes are unavailable`);
          break;
        }
        const variant = await visitAndRead(page, url, colorLabel, row['Product Name']);
        if (variant) {
          const colorName = variant.split(':')[0];
          if (!seenColors.has(colorName)) {
            seenColors.add(colorName);
            variants.push(variant);
            dupeStreak = 0;
          } else {
            dupeStreak++;
          }
        }
      }
    } finally {
      await page.close();
    }

    row['Available Sizes'] = variants.length > 0 ? variants.join(' | ') : 'Unavailable';
    processed++;

    if (processed % BATCH_SIZE === 0) {
      saveProgress(rows, outputPath);
      console.log(`--- Saved progress (${processed}/${total}) ---`);
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
