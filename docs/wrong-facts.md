# Wrong facts: contract and limits

Core requirement 3: "Flag anything an AI engine says about Corvane that
contradicts facts.json, linked to the answer it came from. A claim that
facts.json doesn't cover is unverified, not wrong, so don't flag it."

`npm run export` writes `out/wrong_facts.csv` with exactly the brief's columns
`response_id, brand, fact_key, claim_text`, one row per incorrect claim.
`fact_key` is the dotted path into `facts.json` (`hq`, `founded`,
`starting_price_usd`, `features.dashcams`, `integrations`), and `claim_text` is
the sentence containing the claim, exactly as written. **Scope: Corvane only**;
checking competitors is a stretch item and is not exported.

This is pattern-based checking of explicit claims, not comprehensive
fact-checking. A claim phrased in a way the patterns don't recognise is missed;
the design prefers a missed claim over a false accusation.

## Supported claims

| fact_key | Recognised claims | Flagged when |
|---|---|---|
| `hq` | "based in …", "headquartered in …" with a city, a state, or "City, State" (state names or two-letter codes) | the city differs, or a stated state differs. Vague places ("the Midwest") are never flagged. |
| `founded` | "founded / established / launched / started in YYYY", "around / operating / in business since YYYY" | the year differs. |
| `starting_price_usd` | "pricing/plans start at $N", "expect to pay from $N", "starting at $N", per vehicle (per month) | the amount differs. "About/around $N" allows ±10% (minimum $2). Ranges and other units (per year, per user) are ignored. |
| `features.<name>` | gps tracking, ELD, fuel cards, maintenance alerts, driver app, dashcams, payroll | a feature the company has is explicitly denied ("doesn't support ELD"), or one it lacks is explicitly claimed ("includes built-in dashcams"). Audience phrases ("for carriers that need ELD") are not claims. |
| `integrations` | "doesn't integrate with X" for an integration listed in facts.json | always (it contradicts the list). |

## Attribution

A claim belongs to the brand named in its sentence, or to the last brand named
earlier on the same line ("Corvane Fleet is solid. It's based in Columbus,
Georgia."). These are never attributed to Corvane:

- sentences about the decoy (Corvane Logistics);
- sentences naming two companies;
- claims on a different line from the brand.

## Not flagged (unverified or unreliable)

- Anything facts.json doesn't cover: ratings, support hours, customer counts,
  target fleet sizes, industries served.
- Integrations not listed in facts.json ("integrates with Salesforce"): the
  list may be incomplete, so an unlisted one is unverified, not wrong.
- Feature descriptions with both an affirmation and a negation that can't be
  separated, and claims in unsupported phrasings.

## Results on the case-study data

47 rows in 47 answers:

| fact_key | Rows | Example claim |
|---|---|---|
| `hq` | 14 | "It's based in Columbus, Georgia." / "The company is headquartered in Chicago." |
| `founded` | 6 | "It was founded in 2009." |
| `starting_price_usd` | 10 | "around $45" / "from $49" per vehicle |
| `features.eld_compliance` | 8 | "doesn't support ELD compliance" |
| `integrations` | 5 | "doesn't integrate with QuickBooks" |
| `features.dashcams` | 4 | "includes built-in AI dashcams" |

Correct claims are not flagged: Columbus, Ohio; 2014; $29; QuickBooks and WEX;
ELD included.
