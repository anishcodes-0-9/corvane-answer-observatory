# Corvane Answer Observatory

An AI-visibility tracker for Corvane Fleet (a fictional client). It reads the
answers ChatGPT, Perplexity and Google AI Overviews gave to 15 buyer questions
over six weeks and works out:

- which of six companies each answer names, and in what order;
- how each answer treats each company;
- what the answers get wrong about Corvane;
- a weekly visibility score that separates real movement from run-to-run noise.

The results are shown in a web dashboard for the CEO and a browsable answer
view, and exported in the brief's exact CSV formats. The plain-English
summary for Marcus is in [NOTE_TO_MARCUS.md](NOTE_TO_MARCUS.md).

Everything is rules-based and runs on a laptop: no paid APIs, no network calls
at run time, and every number traces back to a specific answer.

## Run it

Requires Node 20+.

```bash
npm install
DATA_DIR=/path/to/corvane_data_pack npm start      # builds and serves http://localhost:3000
```

**Where to put the data.** The data pack is not in this repository. Point
`DATA_DIR` at the unzipped folder: it must contain the responses file
(`responses.jsonl` or `Responses.json`), `brands.json`, `facts.json` and
`prompts.csv`. Alternatively, copy them into `./data/`, which is git-ignored.

| Command | What it does |
|---|---|
| `npm start` | Production build, then serve the dashboard (`npm run dev` for development). |
| `npm run export` | Writes `out/mentions.csv` and `out/wrong_facts.csv` in the brief's exact formats. |
| `npm run scores` | Prints weekly scores and changes; writes `out/scores.json`. |
| `npm run data-quality` | Coverage and record accounting: duplicates, timeouts, missing engines. |
| `npm test` / `npm run typecheck` | 356 automated tests; TypeScript checks. |
| `npm run audit:sample` / `audit:compare` | The 15-answer manual accuracy check. |

**A new week's data.**

1. Drop the new file into the data folder; any name works, in JSON-array or
   JSONL format.
2. Add the week number to `weeks` in `config/expected-dataset.json`, so the
   tool knows that week is expected and can flag missing engines. That's a
   config edit, not a code change.

The loader accepts the field-name and format variations seen in the pack (two
schemas, renamed fields, different engine labels, day-first dates). It reports
anything unexpected rather than dropping it.

`out/` holds generated outputs and is git-ignored. Every output can be rebuilt
from the data pack, and identical input gives byte-identical files.

## What it does, briefly

| Requirement | How |
|---|---|
| Find every mention | Official names, aliases, the company's website, and obvious misspellings that aren't dictionary words. Corvane Logistics (and variants) never counts as Corvane. Citations are never counted. [docs/brand-analysis.md](docs/brand-analysis.md) |
| Position and tone | Position = order first named. Tone = the brief's four values, using the final verdict on mixed answers (rules over sentences and clauses). |
| Wrong facts | Explicit claims that contradict `facts.json` (HQ, founding year, price, features, integrations). Claims it doesn't cover are left unflagged. [docs/wrong-facts.md](docs/wrong-facts.md) |
| One honest score | Points per answer, averaged per question × engine slot; week-on-week changes on matched slots only, with a 95% interval. [docs/scoring.md](docs/scoring.md) |
| Monday view | Overview page: score, verdict, competitors, history, movement, why it moved, wrong facts, market, suggested next steps. |
| Accuracy check | Reproducible random sample of 15, blind sheet, comparison script ([validation/MANUAL_REVIEW.md](validation/MANUAL_REVIEW.md)). |

Results on the case-study data:

- **Exports:** `mentions.csv` has 3,060 rows (510 answers × 6 companies);
  `wrong_facts.csv` has 47 rows.
- **Corvane:**
  - weekly scores 42.5, 41.7, 49.2, 40.3, 37.5 (week 5, partial) and 36.4;
  - no week-on-week change is outside run-to-run variation;
  - in week 6 it is mentioned in 56% of answers and recommended in 26%.

## Assumptions

- **Timeouts.**
  - The 3 collector timeouts get their six `mentions.csv` rows with
    `mentioned=false` and blank position and tone. The brief asks for "one row
    for every answer", and the pack calls each line "one AI answer".
  - Everywhere else (scores, coverage, the dashboard) they are "not analysed",
    never "not mentioned".
- **Duplicates.** The 8 exact duplicate records are counted once.
- **Weeks and dates.** Weeks come from the `week` field, never from
  timestamps. Week 4's dates are read as DD/MM, because only that order fits
  between weeks 3 and 5.
- **Misspellings.**
  - A misspelling must be capitalised, be close to a name (edit distance 1–2,
    same first three letters), and not be an English word. So "Corvain"
    counts and "Corvina" doesn't.
  - Lower-case and spaced misspellings of one-word names ("Rout Lyne") are not
    matched. The brief doesn't decide these, so I chose the conservative
    default.
- **Websites and hosts.** A company's name inside another website's address
  doesn't count (`gridwell.io.example.com`). An email address at its own
  domain does.
- **The decoy.** "Corvane logistics" in lower case straight after Corvane is
  treated as the decoy, since the brief says it "never counts".
- **Tone in shared sentences.** A sentence naming two companies gives both the
  same verdict.
- **Score weights.** Recommended 100, neutral 50, negative 25,
  not recommended 0, absent 0. These are product choices, not validated weights.
- **Facts.**
  - An integration that isn't in `facts.json` is treated as unverified, not
    wrong.
  - Only Corvane's wrong facts are exported. The checker supports competitors,
    but that is a stretch item.

## What I prioritised, and why

The core requirements and the scoring export came first, because they are what
the brief says will be checked against an answer key. The order was:

1. A loader that can't lose records silently.
2. Mentions and positions.
3. Tone.
4. Wrong facts.
5. The score.
6. The dashboard.
7. The audit.

At each step, being honest about uncertainty came before features:

- missing data is shown as missing, not zero;
- inconclusive changes are labelled inconclusive;
- unverifiable claims are left unflagged.

**Stretch items:**

- **Done:** the detail view (answers page with filters and highlighted
  mentions, claims and citations), and a no-hard-coding brand config.
- **Partly done:**
  - competitor fact-checking (implemented, not exported);
  - the sources view (cited domains appear per answer and per wrong fact, but
    there's no dedicated sources analysis).
- **Not done:** head-to-head, a board-report export, and a deployed version.

## Accuracy

**Automated checks:**

- **Labelled cases:** 54 hand-labelled synthetic cases. The tool matches all
  of them, but they were written alongside the rules, so this is not
  independent evidence.
- **Independent oracle:** a deliberately naive regex matcher agrees with the
  tool on mentions and positions for all 507 real answers.
- **Mutation checks:** for key rules, deliberately broken versions are caught
  by the tests.

**Manual audit of 15 random answers: pending.** The sample is drawn (seed
`corvane-manual-audit-v1`) and the blind sheet is ready. Results will be added
here from `validation/manual-review-results.md` once the hand labels are
complete. No accuracy figure is claimed before then.

Known weak spots to look for:

- tone wording outside the phrase lists;
- sentences that name two companies;
- real-word typos without context;
- claims phrased in ways the fact patterns don't recognise.

## How AI coding tools were used

I built this with Claude Code. I set the requirements and priorities, reviewed
plans before code was written, approved every milestone, and made all commits
under my own identity. Claude wrote most of the code and tests and ran the
checks. Verification relied on:

- tests and mutation checks;
- an independent oracle;
- record-count reconciliation against the raw data;
- screenshots of the rendered dashboard at desktop and phone sizes.

**Mistakes the tools made that were caught and fixed:**

- **Loader.**
  - A symlinked responses file was silently ignored, and a response file in a
    subfolder escaped accounting while the input was still reported as fully
    accounted for.
  - A CSV export not named `responses*` was skipped.
  - Coverage inferred its expectations from the data, so a missing engine or a
    missing final week could never show up. It now uses an explicit expected
    dataset.
- **Matching.**
  - "Gridwel is" swallowed the next word.
  - The real word "Corvina" counted as Corvane.
  - "Corvane Logistic" (singular) counted as Corvane, while "Corvane Fleet
    Logistics" was wrongly suppressed.
  - An earlier report claimed email addresses weren't counted, when the name
    rule was in fact counting them.
- **Tone.** "1. **Trakvia**: Avoid…" came out neutral, because "Avoid" only
  counted at the start of a sentence.
- **Facts.**
  - "doesn't support ELD" was read as both a denial and an affirmation, and
    skipped.
  - "based in Columbus." kept the full stop and was flagged as a different
    city.
- **Scoring.** An early design note said a week had about 90 comparable cells;
  the correct number is 45 (15 questions × 3 engines).
- **Dashboard (found by screenshot review).**
  - The headline pushed the score below the fold.
  - The 3D field was cropped, and its labels collided with the text.
  - Interval markers were stretched into ovals, and fact cards overflowed.
  - On phones, the field sat behind the headline.
  - The Next.js dev server generated `AGENTS.md` and `CLAUDE.md` files in the
    repo; generation is now disabled.
- **Process.** The AI's early time estimates were off by about 30 minutes.

## Running this every day for 20 clients

**Cost.**

- Analysis is cheap. The full pipeline for one client's six weeks (518 answers)
  takes about 0.2 seconds on a laptop CPU, with no model or API costs.
- Twenty clients run nightly on one small VM or a scheduled serverless job, in
  minutes.
- The real cost is collecting answers from the engines (API fees or scraping,
  plus retries for timeouts). That scales with clients × questions × engines ×
  runs and should be budgeted per client.

**Storage.**

- Raw answers are small: this pack is 368 KB for six weekly collections, about
  60 KB each. Collected daily, that is roughly 0.45 MB per client-week, or
  about 0.5 GB a year for 20 clients.
- Store raw responses unchanged in object storage, organised by
  client/week/engine, plus each client's three config files (brands, facts,
  expected dataset).
- Everything else (CSVs, scores, dashboard data) is regenerated
  deterministically, so only small derived snapshots need keeping, for history
  and audit.

**When an engine changes its format.**

- Each new field name or engine label is an alias in one table in the loader.
- Anything unexpected is surfaced, not dropped:
  - unknown fields and engines show up in the data-quality report;
  - unparseable records are listed with their file and line;
  - the run refuses to export if any record is unaccounted for.
- For alerting, a nightly job would page on:
  - a non-zero exit;
  - coverage falling below the expected slots for any engine;
  - a sudden shift in one engine's mention rate, which often means a format
    change, such as answers losing their text.
- Per-engine fixture tests from recent real answers would catch breakage
  before it reaches clients.
- New clients are configuration only: their brands, aliases, decoys, facts and
  question list.
