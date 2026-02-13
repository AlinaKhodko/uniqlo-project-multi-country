const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
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

const filePath = path.join(__dirname, './product-ids/uniqlo-raw.html');
const html = fs.readFileSync(filePath, 'utf8');

// Extract timestamp from HTML comment
const timestampMatch = html.match(/<!--\s*Fetched on ([\d\-T:.Z]+)\s*-->/);
const fetchedAt = timestampMatch ? timestampMatch[1] : 'Unknown';

const $ = cheerio.load(html);

// Fix mojibake (Euro and others)
function fixMojibake(str) {
  return str
    .replace(/â‚¬/g, '€')
    .replace(/â€œ/g, '"')
    .replace(/â€/g, '"')
    .replace(/â€˜/g, "'")
    .replace(/â€™/g, "'")
    .replace(/â€"/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// CSV header (now includes color variant URLs)
const baseUrl = 'https://www.uniqlo.com';
const rows = [['Product ID', 'Product Name', 'Price (Promo)', 'Price (Original)', 'Rating', 'Reviews', 'Product URL', 'Color Variant URLs', 'Fetched At']];
const seen = new Set();

// Selector to catch all product blocks
const productBlocks = $('a[href*="/products/"]');
console.log(`Found ${productBlocks.length} product blocks`);

productBlocks.each((_, el) => {
  const $el = $(el);

  const allTexts = $el.find('[data-testid="ITOTypography"]')
    .map((_, d) => $(d).text().trim())
    .get()
    .filter(Boolean);

  const name = fixMojibake(allTexts[1] || '');
  const promoPrice = fixMojibake(allTexts[2] || '');
  const originalPrice = fixMojibake(allTexts[3] || '');

  const rating = $el.find('.fr-ec-rating-average-product-tile').text().trim();
  const reviews = $el.find('.fr-ec-rating-static__count-product-tile').text().trim().replace(/[()]/g, '');

  const productHref = $el.attr('href')?.trim() || '';
  const productId = productHref.split('/products/')[1]?.split('/')[0] || '';
  const suffix = productHref.split('/').pop()?.slice(0, 2) || '00';
  const productURL = productHref ? baseUrl + productHref : '';

  const localePath = config.locale_path;
  const productBaseURL = `${baseUrl}/${localePath}/products/${productId}/${suffix}`;

  const rawCodes = $el.find('img.image__img')
    .map((_, img) => {
      const src = $(img).attr('src') || '';
      const match = src.match(/goods_(\d{2})_/);
      return match ? match[1] : null;
    })
    .get()
    .filter(Boolean);

  const colorVariantURLs = [...new Set(rawCodes.map(code =>
    `${productBaseURL}?colorDisplayCode=${code}`
  ))].join(' | ');


  if (productId && name && (promoPrice || originalPrice)) {
    if (!seen.has(productId)) {
      seen.add(productId);
      rows.push([
        productId,
        name,
        promoPrice,
        originalPrice,
        rating,
        reviews,
        productURL,
        colorVariantURLs,
        fetchedAt
      ]);
      console.log(`Parsed: ${name} | ${promoPrice} | ${colorVariantURLs}`);
    }
  } else {
    console.log(`Skipped: ${productURL} | name: "${name}"`);
  }
});

// Write to CSV
const csv = rows.map(row => row.map(val => `"${val}"`).join(',')).join('\n');
fs.writeFileSync('./product-ids/uniqlo-products.csv', csv, 'utf8');

console.log(`Saved ${rows.length - 1} products to uniqlo-products.csv with timestamp: ${fetchedAt}`);
