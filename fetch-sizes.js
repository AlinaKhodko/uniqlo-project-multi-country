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
const CONCURRENCY = 3;
const BATCH_SIZE = 20;

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
async function readColorAndSizes(page, colorLabel) {
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
    await page.waitForSelector('.size-chip-group', { timeout: 5000 });
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

// Visit one product page and extract ALL color variants by clicking through chips
async function extractAllVariants(url, browser, colorLabel, productName) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  const variants = [];
  const seenColors = new Set();

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Find all color chip elements — try multiple selectors
    let chipCount = await page.evaluate(() => {
      // Look for color chip images/buttons in the product's color picker
      const selectors = [
        '.color-picker .color-chip',
        '[class*="colorChip"]',
        '[class*="color-chip"]',
        '[data-testid*="color-chip"]',
        '.pdp-color-chips button',
        '.pdp-color-chips a',
      ];
      for (const sel of selectors) {
        const chips = document.querySelectorAll(sel);
        if (chips.length > 1) return chips.length;
      }
      // Fallback: look for small clickable images near the color label
      const colorSection = document.querySelector('[class*="colorPicker"], [class*="color-picker"], [class*="ColorPicker"]');
      if (colorSection) {
        const clickables = colorSection.querySelectorAll('button, a, [role="radio"]');
        if (clickables.length > 1) return clickables.length;
      }
      return 0;
    });

    if (chipCount > 1 && chipCount <= 15) {
      console.log(`  [${productName}] Found ${chipCount} color chips, clicking through...`);

      for (let i = 0; i < chipCount; i++) {
        try {
          // Re-query and click the i-th chip (DOM may update after clicks)
          const clicked = await page.evaluate((index) => {
            const selectors = [
              '.color-picker .color-chip',
              '[class*="colorChip"]',
              '[class*="color-chip"]',
              '[data-testid*="color-chip"]',
              '.pdp-color-chips button',
              '.pdp-color-chips a',
            ];
            for (const sel of selectors) {
              const chips = document.querySelectorAll(sel);
              if (chips.length > 1 && chips[index]) {
                chips[index].click();
                return true;
              }
            }
            const colorSection = document.querySelector('[class*="colorPicker"], [class*="color-picker"], [class*="ColorPicker"]');
            if (colorSection) {
              const clickables = colorSection.querySelectorAll('button, a, [role="radio"]');
              if (clickables[index]) {
                clickables[index].click();
                return true;
              }
            }
            return false;
          }, i);

          if (!clicked) continue;
          await sleep(1500); // Wait for page to update after color switch

          const { color, sizes } = await readColorAndSizes(page, colorLabel);
          if (color && !seenColors.has(color)) {
            seenColors.add(color);
            if (sizes.length > 0) {
              variants.push(`${color}: ${sizes.join(', ')}`);
              console.log(`  [${productName}] ${color}: ${sizes.join(', ')}`);
            } else {
              console.log(`  [${productName}] ${color}: no sizes available`);
            }
          }
        } catch (err) {
          console.warn(`  [${productName}] Chip ${i} failed: ${err.message}`);
        }
      }
    } else {
      // No color chips found or just one — extract current color only
      const { color, sizes } = await readColorAndSizes(page, colorLabel);
      if (color && sizes.length > 0) {
        variants.push(`${color}: ${sizes.join(', ')}`);
        console.log(`  [${productName}] ${color}: ${sizes.join(', ')}`);
      } else {
        console.log(`  [${productName}] ${color || 'Unknown'}: ${sizes.length > 0 ? sizes.join(', ') : 'None'}`);
      }
    }
  } catch (err) {
    console.error(`  [${productName}] Failed: ${err.message}`);
  } finally {
    await page.close();
  }

  return variants;
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
    const urls = row['Color Variant URLs']
      ? row['Color Variant URLs'].split('|').map(url => url.trim()).filter(Boolean)
      : [];

    if (urls.length === 0) {
      row['Available Sizes'] = 'Unavailable';
      processed++;
      return;
    }

    console.log(`\n[${row['Product Name']}] Visiting ${urls[0]}`);

    // Visit the first URL and extract ALL colors by clicking through chips
    const variants = await extractAllVariants(urls[0], browser, colorLabel, row['Product Name']);

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
