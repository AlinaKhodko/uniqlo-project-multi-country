const puppeteer = require('puppeteer');
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
.option('url', {
alias: 'u',
type: 'string',
description: 'URL to scrape (overrides country config)'
})
.option('output', {
alias: 'o',
type: 'string',
default: 'product-ids/uniqlo-raw.html',
description: 'Path to save raw HTML'
})
.help()
.argv;

const config = countryConfig[argv.country];
const targetUrl = argv.url || config.sale_url;

async function gotoWithRetry(page, url, options, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.goto(url, options);
    } catch (err) {
      if (i === attempts - 1) throw err;
      const delay = 2000 * Math.pow(2, i);
      console.warn(`Navigation failed (attempt ${i + 1}/${attempts}): ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

(async () => {
let browser;
try {
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1400,1000']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });

  await page.setExtraHTTPHeaders({
    'Accept-Language': config.accept_language,
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  console.log(`Navigating to ${targetUrl}`);

  await gotoWithRetry(page, targetUrl, { waitUntil: 'networkidle2' });

  // Accept cookies
  try {
    await page.waitForSelector('button#onetrust-accept-btn-handler', { timeout: 5000 });
    await page.click('button#onetrust-accept-btn-handler');
    console.log('Accepted cookies');
  } catch {
    console.log('No cookie popup found');
  }

  // Wait for product tiles to render before scrolling
  try {
    await page.waitForSelector('[data-testid="productTile"]', { timeout: 30000 });
    console.log('Product tiles detected, starting scroll');
  } catch {
    console.log('WARNING: No product tiles appeared after 30s, will try scrolling anyway');
  }

  // Scroll loop
  let previousCount = 0;
  let stableCounter = 0;
  const maxStable = 3;
  const maxScrolls = 150;

  for (let i = 0; i < maxScrolls && stableCounter < maxStable; i++) {
    const currentCount = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="productTile"]').length
    );
    console.log(`Scroll ${i + 1}: ${currentCount} products loaded`);

    if (currentCount === previousCount && currentCount > 0) {
      stableCounter++;
    } else if (currentCount !== previousCount) {
      stableCounter = 0;
      previousCount = currentCount;
    }

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  console.log('Finished scrolling');

  // Add timestamp (adjusted for UTC+3)
  const now = new Date();
  now.setHours(now.getHours() + 3); // shift by 3 hours
  const timestampComment = `<!-- Fetched on ${now.toISOString()} -->\n`;

  const html = await page.content();

  // Validate HTML contains product tiles before saving
  const productTileCount = (html.match(/data-testid="productTile"/g) || []).length;
  if (productTileCount === 0) {
    fs.writeFileSync(path.resolve(argv.output + '.debug.html'), timestampComment + html, 'utf8');
    console.error('ERROR: No product tiles found in HTML. Debug HTML saved to ' + argv.output + '.debug.html');
    process.exit(1);
  }
  console.log(`Validated: ${productTileCount} product tiles in HTML`);

  fs.writeFileSync(path.resolve(argv.output), timestampComment + html, 'utf8');
  console.log(`Saved to ${argv.output}`);
} catch (err) {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
} finally {
  if (browser) await browser.close();
}
})();
