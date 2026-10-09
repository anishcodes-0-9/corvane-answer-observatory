"""Independent brand-mention oracle (stdlib only).

Deliberately simple and separate from the TypeScript matcher: hand-written,
case-insensitive regexes for each brand from the brief, the decoy masked first,
the one misspelling hand-identified in the data ("Corvain"), and no Unicode
normalisation or general fuzzy matching. Its job is to be wrong in different
ways from the implementation, so both are scored against the hand labels.

Usage:
  python3 -I validation/oracle.py labels validation/brand-labels.json
  python3 -I validation/oracle.py compare <Responses.json|responses.jsonl> <out/brand-analysis.json>
"""
import html
import json
import re
import sys

BRANDS = {
    "corvane": r"corvanefleet\.com|corva(?:ne|in)[ \t-]?fleet|corva(?:ne|in)",
    "trakvia": r"trakvia(?:\.com)?",
    "routelyne": r"route[ \t-]?lyne(?:\.com)?",
    "gridwell": r"gridwell(?:[ \t]+systems|\.io)?",
    "fleetora": r"fleetora(?:\.com)?",
    "novahaul": r"nova[ \t-]?haul(?:\.com)?",
}
DECOY = re.compile(r"(?i)\bcorva(?:ne|in)[ \t-]?logistics?\b")


def oracle_positions(text):
    """Brand -> 1-based position of first mention."""
    masked = DECOY.sub(lambda m: "#" * len(m.group(0)), text)
    first = {}
    for brand, pattern in BRANDS.items():
        m = re.search(r"(?i)\b(?:" + pattern + r")\b", masked)
        if m:
            first[brand] = m.start()
    order = sorted(first, key=first.get)
    return {b: i + 1 for i, b in enumerate(order)}


def score(name, cases, predict):
    tp = fp = fn = pos_ok = 0
    errors = []
    for c in cases:
        expected = {brand: i + 1 for i, (brand, _surfaces) in enumerate(c["mentions"])}
        got = predict(c)
        for b in sorted(set(expected) | set(got)):
            if b in expected and b in got:
                tp += 1
                if expected[b] == got[b]:
                    pos_ok += 1
                else:
                    errors.append(f"{c['id']}: {b} position {got[b]} (expected {expected[b]})")
            elif b in got:
                fp += 1
                errors.append(f"{c['id']}: false positive {b}  | {c['text']!r}")
            else:
                fn += 1
                errors.append(f"{c['id']}: missed {b}  | {c['text']!r}")
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    print(f"{name}: {len(cases)} cases, mention TP {tp}, FP {fp}, FN {fn}; "
          f"precision {precision:.3f}, recall {recall:.3f}; positions correct {pos_ok}/{tp}")
    for e in errors:
        print("   ", e)
    return errors


def cmd_labels(path):
    data = json.load(open(path, encoding="utf-8"))
    cases = data["cases"]
    score("oracle vs labels", cases, lambda c: oracle_positions(c["text"]))
    brief = [c for c in cases if "brief" in c["tags"]]
    score("oracle vs labels (brief-decided cases only)", brief, lambda c: oracle_positions(c["text"]))


def cmd_compare(responses_path, artifact_path):
    raw = open(responses_path, encoding="utf-8").read()
    records = json.loads(raw) if raw.lstrip().startswith("[") else [json.loads(l) for l in raw.splitlines() if l.strip()]
    texts = {}
    for r in records:
        texts.setdefault(r["response_id"], html.unescape(r.get("response_text") or r.get("answer") or ""))
    artifact = json.load(open(artifact_path, encoding="utf-8"))
    checked = disagreements = 0
    for a in artifact["responses"]:
        if a["status"] != "analyzed":
            continue
        checked += 1
        mine = {b["brand"]: b["position"] for b in a["brands"] if b["mentioned"]}
        theirs = oracle_positions(texts[a["responseId"]])
        if mine != theirs:
            disagreements += 1
            print(f"  {a['responseId']}: pipeline {mine} oracle {theirs}")
    print(f"real data: {checked} analysed responses compared; disagreements: {disagreements}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "labels":
        cmd_labels(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "compare":
        cmd_compare(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
        sys.exit(2)
