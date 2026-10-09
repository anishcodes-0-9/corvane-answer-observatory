# Manual review: how to label the 15 answers

The brief asks us to "pick 15 answers at random, check them by hand, and report
how often your tool is right on mentions and tone, and where it goes wrong".

1. `DATA_DIR=<data pack> npm run audit:sample` writes two files:
   - `validation/manual-review.csv`: the blind sheet, with the answer text
     and empty label columns.
   - `validation/manual-review-predictions.csv`: the tool's answers.
     **Don't open this until you have finished labelling.**
2. Open `manual-review.csv` in a spreadsheet and fill in every label column.
   Use the brief's definitions, not the tool's.
3. Save it as CSV and run `npm run audit:compare`. It refuses to report until
   every cell is filled, then writes `validation/manual-review-results.md`.

Both sheets contain answer text from the data pack, so they are git-ignored.
Only the results file is meant to be committed.

## What to fill in, for each of the six companies

| Column | Value |
|---|---|
| `<company>_mentioned` | `true` if the answer text names the company, a variation or obvious misspelling of its name, or its website; otherwise `false`. Citations don't count. Corvane Logistics is never Corvane. |
| `<company>_position` | Only when mentioned: 1 for the first of the six companies named in the answer text, 2 for the next new one, and so on. |
| `<company>_tone` | Only when mentioned: `recommended`, `neutral`, `negative` or `not_recommended` (definitions below). Use the final verdict when the answer is mixed. |
| `ambiguous` | `yes` if any judgement on this answer was genuinely unclear. |
| `notes` | What was unclear, or anything worth reporting. |

Leave position and tone blank when the company is not mentioned.

**Tone, from the brief:**

- `recommended`: the answer suggests choosing the company.
- `neutral`: named without a judgement.
- `negative`: criticised, but not ruled out.
- `not_recommended`: the answer advises against it.

Companies: `corvane` (Corvane Fleet), `trakvia`, `routelyne`, `gridwell`
(Gridwell Systems), `fleetora`, `novahaul`.
