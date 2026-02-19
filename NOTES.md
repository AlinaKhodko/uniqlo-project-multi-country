# Project Notes

## Action Algorithm — Known Limitations & Ideas

### Problem: cheap good deals can be missed

The current scoring is fully **relative** (quantile-based). Every product is ranked against the current batch. This means:

- On a day with many heavily-discounted products, even a 70% off item can land in a low `Discount_Quantile` and get labeled NEUTRAL or AVOID.
- A product with 4.5★ and 500 reviews might be in the bottom 20% on a day when the batch is packed with highly-reviewed items — and get skipped.

### Ideas to fix

1. **Add absolute discount floor as a secondary pass** — after the quantile filter, also catch anything with e.g. `Discount % >= 60` regardless of quantile. This ensures extreme deals are never dropped just because the batch is competitive.

2. **Add absolute price cap** — if `Promo Price <= 10€` (or similar threshold per country), always include it regardless of score. Very cheap items are low-risk impulse buys.

3. **Separate the review score from the action filter** — currently both review rank AND discount rank must be high to pass. Could pass products that meet EITHER a very high discount OR a very high review score (union instead of intersection for edge cases).

4. **Add a CLEARANCE label** — for products with `Discount % >= 70` and `Promo Price <= 15€`, show them separately in the message regardless of review score.
