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
  .option('output', {
    alias: 'o',
    type: 'string',
    default: './product-ids/uniqlo-products.csv',
    description: 'Output CSV file path'
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
const stats = { total: 0, withLink: 0, noLink: 0, priceSuspect: 0 };
// Selector to catch all product blocks
const productBlocks = $('a[href*="/products/"]');
console.log(`Found ${productBlocks.length} product blocks`);

productBlocks.each((_, el) => {
  const $el = $(el);

  const typoElements = $el.find('[data-testid="ITOTypography"]');
  const allTexts = typoElements
    .map((_, d) => $(d).text().trim())
    .get()
    .filter(Boolean);

  if (allTexts.length < 4) {
    const href = $el.attr('href') || '(no href)';
    console.warn(`Warning: product block has ${allTexts.length} ITOTypography elements (expected >=4): ${href}`);
  }

  const name = fixMojibake(allTexts[1] || '');
  const [gender, sizeOnly] = (allTexts[0] || '').split(',').map(s => s.trim());
// gender -> "Herren", sizeOnly -> "XS-3XL"
  const promoPrice = fixMojibake(allTexts[2] || '');
  const originalPrice = fixMojibake(allTexts[3] || '');

  if (promoPrice && !/^[\d.,\s€$£¥]+$/.test(promoPrice)) {
    console.warn(`Warning: unexpected promo price format "${promoPrice}" for "${name}"`);
  }
  if (originalPrice && !/^[\d.,\s€$£¥]+$/.test(originalPrice)) {
    console.warn(`Warning: unexpected original price format "${originalPrice}" for "${name}"`);
  }

  const rating = $el.find('.fr-ec-rating-average-product-tile').text().trim();
  const reviews = $el.find('.fr-ec-rating-static__count-product-tile').text().trim().replace(/[()]/g, '');

  const productHref = $el.attr('href')?.trim() || '';
  const productId = productHref.split('/products/')[1]?.split('/')[0] || '';
  const suffix = productHref.split('/').pop()?.slice(0, 2) || '00';
  const productURL = productHref ? baseUrl + productHref : '';

  const localePath = config.locale_path;
  const productBaseURL = `${baseUrl}/${localePath}/products/${productId}/${suffix}`;

  // const rawCodes = $el.find('img.image__img')
  //   .map((_, img) => {
  //     const src = $(img).attr('src') || '';
  //     const match = src.match(/goods_(\d{2})_/);
  //     return match ? match[1] : null;
  //   })
  //   .get()
  //   .filter(Boolean);

  // const colorVariantURLs = [...new Set(rawCodes.map(code =>
  //   `${productBaseURL}?colorDisplayCode=${code}`
  // ))].join(' | ');

  // Default color code from the href — always present in the DOM,
  // independent of image lazy-loading.
  const defaultColor = productHref.match(/colorDisplayCode=(\d+)/)?.[1] || null;

  // Color codes from tile images — read data-src FIRST. The real URL lives
  // in data-src before the lazy <img> swaps it into src; un-scrolled tiles
  // have an empty/placeholder src, which is why most links came back blank.
  const imgCodes = $el.find('img.image__img')
    .map((_, img) => {
      const src = $(img).attr('data-src') || $(img).attr('src') || '';
      const match = src.match(/goods_(\d{2})_/);
      return match ? match[1] : null;
    })
    .get()
    .filter(Boolean);

  // Default color first, then any variants found in images, deduped.
  const rawCodes = [defaultColor, ...imgCodes].filter(Boolean);

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

      stats.total++;
      colorVariantURLs ? stats.withLink++ : stats.noLink++;

      const priceOk = /^[\d.,\s€$£¥]+$/.test(originalPrice);
      if (originalPrice && !priceOk) stats.priceSuspect++;

      console.log(
        `Parsed: ${name}\n` +
        `   size:   ${[gender, sizeOnly].filter(Boolean).join(', ') || '—'}\n` +
        `   price:  ${promoPrice || '—'}  (was ${originalPrice || '—'})${priceOk ? '' : '  ⚠ price looks off'}\n` +
        `   colors: default=${defaultColor ?? '—'}  img=[${imgCodes.join(',') || '—'}]\n` +
        `   links:  ${colorVariantURLs || '⚠ NONE'}`
      );
    }
  } else {
    console.log(`Skipped: ${productURL} | name: "${name}"`);
  }
});

console.log(`\n=== Summary ===`);
console.log(`Parsed products : ${stats.total}`);
console.log(`With link       : ${stats.withLink}`);
console.log(`Missing link    : ${stats.noLink}   ${stats.noLink === 0 ? '✓ all good' : '⚠ investigate'}`);
console.log(`Suspect prices  : ${stats.priceSuspect}  ${stats.priceSuspect === 0 ? '✓' : '⚠ possible positional shift'}`);

// Write to CSV (RFC 4180: escape " as "")
const csvData = rows.map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',')).join('\n');
fs.writeFileSync(argv.output, csvData, 'utf8');

console.log(`Saved ${rows.length - 1} products to ${argv.output} with timestamp: ${fetchedAt}`);
