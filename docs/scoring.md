# Visibility score

Core requirement 4: "A single visibility score, for Corvane and each tracked
competitor, that you define and explain in plain English. Week-on-week changes
must separate real movement from the normal variation between runs, and an
incomplete week must not show up as a false drop."

## In plain English

The score is out of 100. It answers: *when buyers ask these 15 questions, how
strongly do the AI engines back this company?* Each answer earns points for
the company:

| What the answer does | Points |
|---|---|
| Recommends it | 100 |
| Mentions it without a judgement | 50 |
| Criticises it, without ruling it out | 25 |
| Advises against it | 0 |
| Doesn't mention it | 0 |

A score of 100 means every answer recommends the company. 50 means it is
always mentioned but never endorsed. 0 means it is absent or advised against.

**These weights are product-design choices, not validated business weights.**
They put the brief's four tones in order and keep the scale easy to explain.
"Not recommended" scores the same as "not mentioned": both mean the buyer is
not steered towards the company, and the advice against it is surfaced
separately on the dashboard rather than pushed below zero.

**Position is not part of the score.** In these answers position mostly
reflects list order; it is kept as a separate detail metric.

## How it is calculated

1. **Slot.** One question × engine × week. Each slot was asked twice (runs 1 and 2).
2. **Slot score.** The average points over the runs that produced an
   analysable answer. A timeout or empty answer is left out, never counted as
   "not mentioned". A slot with no analysable answer is **missing**: it has no
   score, not a zero.
3. **Week score.** The average over that week's observed slots. Each week
   reports observed and expected slots, the missing count, missing engines, and
   a **partial** flag when anything expected is missing.
4. **Brands.** All six companies are scored. Corvane and the three tracked
   competitors are the headline.

## Week-on-week change

- **Matched slots only.** A change compares only question × engine slots
  observed in *both* weeks. In the case-study data, week 5 has no Perplexity
  answers, so weeks 4→5 and 5→6 compare the 30 ChatGPT and AI Overview slots,
  not all 45. Missing data therefore cannot create a decline. Example: Corvane's
  plain week averages fall from 40.28 (week 4) to 37.50 (week 5), but on the 30
  matched slots the average change is −0.42.
- **Movement vs evidence.** The *average change* across matched slots describes
  the movement. Whether it exceeds normal run-to-run variation is a separate
  question, answered with a 95% confidence interval for that average:
  - **up / down:** the whole interval is above / below zero.
  - **no clear change:** the interval includes zero; the movement is within
    the variation between runs and questions.
  - **inconclusive:** fewer than 10 matched slots (or none).
- **Explanations.** For each change, the matched slots that moved most are
  listed with links to the underlying answers. Where a company fell, the
  competitors whose scores rose in those same slots are listed.
- **Run-to-run swing (context).** Each week also reports the average gap
  between run 1 and run 2 of the same slot: how much answers vary when nothing
  else changes.

## Uncertainty method and its assumptions

The interval is a paired Student-t interval on the matched-slot differences:
mean ± t(0.975, n−1) × SD/√n. The critical value comes from a table for the
actual degrees of freedom; between entries the smaller df (a wider interval)
is used.

Its assumptions, and how far they hold:

- **Slots are independent.** Approximately: different questions and engines,
  but an engine's behaviour can shift as a whole between weeks, which this does
  not model.
- **The average difference is roughly normal.** With 30–45 slots this is a
  reasonable approximation, but differences come in steps of 12.5 or 25 points,
  so the interval is approximate.
- **Each slot is a two-run average,** so run-to-run variation is part of the
  slot differences the interval is built from.

Below 10 matched slots the interval is too unreliable to call, so the result is
"inconclusive". A clear change means the answers to *these 15 questions on
these engines* moved more than run-to-run variation would explain. It does not
prove a wider market trend, and no correction is made for comparing many
brand-week pairs: with 30 comparisons, one or two "clear" results can appear
by chance.

## Results on the case-study data (`npm run scores`)

- Weeks 1–4 and 6 observe all 45 slots. Week 5 is partial (30/45; Perplexity
  missing).
- Corvane: 42.5, 41.7, 49.2, 40.3, 37.5 (partial), 36.4. Every week-on-week
  change is "no clear change".
- The only clear change across all brands is Routelyne, weeks 3→4: +13.6
  points over 45 matched slots (95% interval 4.3 to 22.9).
