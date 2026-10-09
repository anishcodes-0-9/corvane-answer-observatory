# Brand analysis: contract and design

Detects which of the six companies each answer mentions, in what order, and
with what tone, and exports `mentions.csv`.

## Source requirements (case-study brief)

- **Mention**: "the company is referred to in the answer text by its name, a
  variation of its name (including obvious misspellings), or its website. A
  company that appears only in the citations doesn't count as a mention.
  Corvane Logistics never counts as Corvane."
- **Position**: "the order in which companies are first named in the answer
  text. The first company named is 1, the next new company is 2, and so on.
  Only the six companies in brands.json count, and citations are ignored."
- **No hard-coding** (stretch): adding a competitor should be a configuration change.

`facts.json` plays no part in detection.

## Inputs and scope

- Retained responses from the loader (`NormalizedResponse[]`), unchanged.
- `brands.json` from the data directory: official names, websites and tiers.
- `config/brands.config.json` (repo): the brief's brand ID for each website,
  aliases the brief itself uses ("Corvane", "Gridwell"), the decoy, and
  fuzzy-match settings.
- Only `NormalizedResponse.text` (HTML entities decoded) is scanned; citations
  never are.
- Only responses with status `ok` are analysed. `error` (e.g. timeout) and
  `empty` responses are recorded as `not_analyzed`, never as "not mentioned".

## Matching rules

| Type | Rule |
|---|---|
| `website` | The brand's own domain, case-insensitive, optional `http(s)://`, `www.` and path, also as an email domain (`sales@trakvia.com`). Not part of a longer host (`notgridwell.io`, `gridwell.io.example.com`). |
| `name` | The official name compared word by word after case folding; written together or with spaces/hyphens ("CorvaneFleet", "CORVANE Fleet", "Route Lyne"). |
| `alias` | A configured alias, compared the same way. |
| `fuzzy` | An obvious misspelling (below). Always labelled `fuzzy` with its edit distance. |
| `decoy` | See "Decoys". Never a mention; suppresses overlapping brand matches. |

- **Normalisation:** a token is a run of Unicode letters/digits with any
  attached combining marks. Its key is NFKD-normalised, marks removed, and
  lower-cased. Offsets always point into the original `text`.
- **Word boundaries:** a brand inside a longer word never matches ("Gridwellness").
- **Host names:** a brand name inside any host name other than the brand's own
  domain is not a mention ("gridwell.io.example.com", "routelyne.io").

**Misspellings** count only if all of these hold:

1. The word starts with a capital letter.
2. Its key is at least 6 letters and shares the first 3 letters with a brand
   name or alias.
3. It is within edit distance 1 of keys under 7 letters, or 2 of longer keys.
4. It has at most as many words as the name ("Gridwel is" cannot swallow "is").
5. It does not merely extend a full name with more letters ("Corvanex",
   "Corvanes").
6. It is not an English dictionary word, unless the rest of a multi-word name
   follows it exactly. "Corvain" counts; "Corvina" (a fish and a grape) does
   not; "Corvina Fleet" does.

The dictionary is the pinned `word-list@4.1.0` package (MIT), not the operating
system's word list, so results are the same on every machine.

**Decoys.** "Corvane Logistics" is configured as head "Corvane" + qualifier
"Logistics". These are the decoy:

- "Corvane Logistics", "Corvain Logistics"
- the singular "Corvane Logistic"
- any case or hyphen: "CORVANE LOGISTICS", "Corvane-Logistics"
- one word: "CorvaneLogistics"
- with a possessive: "Corvane Logistics'"

These still count as Corvane:

- "Corvane Fleet Logistics" (the full client name)
- "Corvane, logistics aside" (punctuation between the words)
- "Corvane Logisticsware" (a different word)

**Overlaps (deterministic):**

1. Decoys are applied first; brand candidates overlapping a decoy are dropped.
2. Fuzzy candidates overlapping an exact candidate are dropped.
3. The rest are sorted, and non-overlapping ones taken greedily, by these keys
   in order: start offset, exact before fuzzy, smaller edit distance, longer
   span, match type (website, name, alias, fuzzy), then brand order in the config.

A fuzzy span equally close to two brands is recorded as `ambiguous` and not counted.

**Configuration errors stop the run:**

- an unknown brand reference
- a `brands.json` company with no config entry
- bad or duplicate IDs
- a name or alias shared by two brands
- a malformed decoy (it must end with a qualifier, and its head must be a name
  or alias of its brand)
- invalid fuzzy settings
- a missing or invalid file

**Provenance:** each analysed response carries its ID, week, engine, prompt,
run and source file/line. Each match carries start/end offsets, the exact
surface text, the match type, the form it matched, and the edit distance.

## Limitations

The brief does not decide these, so they are conservative defaults pinned by tests:

- Lower-case misspellings ("corvain") and spaced misspellings of one-word names
  ("Rout Lyne") are not matched.
- A real-word typo with no surrounding name ("Corvina" alone) is not matched.
- A lower-case qualifier straight after the head ("Corvane logistics tools") is
  treated as the decoy, because the brief says it "never counts".
- A misspelled qualifier ("Corvane Logisitcs") is not recognised as the decoy.

## Validation

- `validation/brand-labels.json`: hand-labelled cases written from the
  definitions above, with synthetic text. They are tagged `brief` where the
  brief decides the answer, and `contract-default` where this document chose a
  conservative default. `tests/brandLabels.test.ts` checks every label,
  including exact offsets.
- `validation/oracle.py`: an independent, deliberately naive regex
  implementation (stdlib only).
  - Scored against the same labels:
    `python3 -I validation/oracle.py labels validation/brand-labels.json`
  - Compared with the pipeline on real data:
    `python3 -I validation/oracle.py compare <responses file> out/brand-analysis.json`
