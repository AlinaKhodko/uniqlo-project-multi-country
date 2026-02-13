const puppeteer = require('puppeteer'); // or 'puppeteer'
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

(async () => {
const browser = await puppeteer.launch({
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

await page.goto(targetUrl, { waitUntil: 'networkidle2' });


// Accept cookies
try {
await page.waitForSelector('button#onetrust-accept-btn-handler', { timeout: 5000 });
await page.click('button#onetrust-accept-btn-handler');
console.log('Accepted cookies');
} catch {
console.log('No cookie popup found');
}

// Scroll loop
let previousCount = 0;
let stableCounter = 0;
const maxStable = 6;
const maxScrolls = 150;

for (let i = 0; i < maxScrolls && stableCounter < maxStable; i++) {
const currentCount = await page.evaluate(() =>
document.querySelectorAll('[data-testid="productTile"]').length
);
console.log(`Scroll ${i + 1}: ${currentCount} products loaded`);

if (currentCount === previousCount) {
stableCounter++;
} else {
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
fs.writeFileSync(path.resolve(argv.output), timestampComment + html, 'utf8');
console.log(`Saved to ${argv.output}`);

await browser.close();
})();
