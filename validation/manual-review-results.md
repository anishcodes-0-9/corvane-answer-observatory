# Manual accuracy audit: results

Sample: 15 answers drawn at random (seed `corvane-manual-audit-v1`) from the analysable answers, labelled by hand before looking at the tool's predictions.

### All sampled answers (15 answers)

| Measure | Result |
|---|---|
| Mentions (answer × company cells) | 90/90 (100.0%) |
| Mention precision | 1.000 (0 false positives) |
| Mention recall | 1.000 (0 missed) |
| Position, where both found the company | 41/41 (100.0%) |
| Tone, where both found the company | 39/41 (95.1%) |

### Excluding answers marked ambiguous (14 answers)

| Measure | Result |
|---|---|
| Mentions (answer × company cells) | 84/84 (100.0%) |
| Mention precision | 1.000 (0 false positives) |
| Mention recall | 1.000 (0 missed) |
| Position, where both found the company | 38/38 (100.0%) |
| Tone, where both found the company | 37/38 (97.4%) |

## Disagreements

| Answer | Company | Field | Human | Tool | Ambiguous |
|---|---|---|---|---|---|
| r_4ac2f20f0ff9 | routelyne | tone | recommended | neutral |  |
| r_aee5a16d9acc | corvane | tone | neutral | negative | yes |

## Reviewer notes

- r_495db021ac8d: TrakVia is the only named brand and is explicitly called the best overall option; website mention confirms it.
- r_c10a92d98721: Fleetora is named first; both are described by features without a recommendation or criticism.
- r_3a551965edff: Routelyne is first and Corvane second; both are positively recommended. Final verdict reinforces Routelyne.
- r_4ac2f20f0ff9: Routelyne's ELD-compliance claim contradicts facts.json (eld_compliance=false); factual accuracy does not change tone.
- r_f2e7fa46fff4: Routelyne is explicitly the top suggestion. TrakVia is criticized for slower setup. Routelyne's ELD claim contradicts facts.json.
- r_8da2dcd9f33f: Novahaul is named first without judgement; Routelyne is the safest choice; Corvane is worth shortlisting.
- r_8c2d909e8645: Trakvia is explicitly ruled out for fleets under 100; Routelyne criticized but not ruled out; Gridwell neutral; Fleetora recommended.
- r_43d53d30944f: Corvane is the bottom-line choice; Trakvia is a strong choice; Gridwell is an option to compare.
- r_f0c9f5405128: All three are positively recommended. Corvane's Chicago HQ claim contradicts facts.json; Columbus, Ohio and founded 2014 are correct.
- r_6cf003b4fe1c: All three are positive overall. Fleetora's mixed price statement resolves to recommended because the final verdict says it is the one to pick.
- r_e15185b616b6: Corvane is recommended; Gridwell is described by its enterprise focus; Routelyne is an option but setup is criticized.
- r_aee5a16d9acc (ambiguous): Treat 'Route Lyne' as Routelyne. Corvane's positives and contract complaints are mixed without a clear final verdict; neutral is conservative. Corvane ELD claim matches facts.json.
- r_6a8d07d37113: Trakvia feature description is neutral. Routelyne receives reliability criticism and an explicit caution but is not ruled out.
- r_97d3fb9d7e72: Routelyne gets a cautionary negative tone; Trakvia neutral; Corvane and Gridwell are explicitly advised against. The $25 price is not attributed to a named brand.
- r_0760990328ce: Gridwell is criticized for limited reporting but not ruled out; Routelyne is described by low pricing without explicit recommendation.
