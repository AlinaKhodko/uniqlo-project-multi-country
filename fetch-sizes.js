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
  .help()
  .argv;

const config = countryConfig[argv.country];

const INPUT_CSV = 'product-ids/filtered-uniqlo-products.csv';
const OUTPUT_CSV = 'product-ids/uniqlo-with-sizes.csv';
const N = 100; // Number of products to process

async function extractColorAndSizes(url, browser, colorLabel) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // Accept cookies
    try {
      await page.waitForSelector('button#onetrust-accept-btn-handler', { timeout: 5000 });
      await page.click('button#onetrust-accept-btn-handler');
      await page.waitForTimeout(1000);
    } catch {}

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

(async () => {
  const rows = [];
  const colorLabel = config.color_label;

  // Read CSV
  await new Promise((resolve, reject) => {
    fs.createReadStream(path.join(__dirname, INPUT_CSV))
      .pipe(csv())
      .on('data', row => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  const browser = await puppeteer.launch({
    headless: 'new', // or true
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1400,1000']
  });

  for (let i = 0; i < Math.min(N, rows.length); i++) {
    const row = rows[i];
    const urls = row['Color Variant URLs']
      ? row['Color Variant URLs'].split('|').map(url => url.trim()).filter(Boolean)
      : [];

    const variants = [];

    console.log(`\n${row['Product Name']} (${urls.length} color variants)`);

    for (const url of urls) {
      console.log(`${url}`);
      const result = await extractColorAndSizes(url, browser, colorLabel);
      if (result) variants.push(result);
    }

    row['Available Sizes'] = variants.join(' | ') || 'Unavailable';

    // Save after every product
    const csvOutput = parse(rows, { fields: Object.keys(rows[0]) });
    fs.writeFileSync(path.join(__dirname, OUTPUT_CSV), csvOutput, 'utf8');
    console.log(`Saved progress after "${row['Product Name']}"`);
  }

  await browser.close();
  console.log(`\nFinal CSV saved to ${OUTPUT_CSV}`);
})();
