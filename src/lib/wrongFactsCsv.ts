/**
 * wrong_facts.csv, exactly as the brief specifies:
 *   response_id, brand, fact_key, claim_text
 * One row per incorrect claim. Core scope: Corvane only.
 */
import type { CompanyFacts, WrongFact } from "./facts";
import { toCsv } from "./mentionsCsv";

export const WRONG_FACTS_HEADER = ["response_id", "brand", "fact_key", "claim_text"] as const;

/** Rows in a stable order: input response order, then position in the answer, then fact key. */
export function sortWrongFacts(rows: readonly WrongFact[], responseOrder: readonly string[]): WrongFact[] {
  const order = new Map(responseOrder.map((id, i) => [id, i]));
  return [...rows].sort(
    (a, b) =>
      order.get(a.responseId)! - order.get(b.responseId)! ||
      a.start - b.start ||
      (a.factKey < b.factKey ? -1 : a.factKey > b.factKey ? 1 : 0),
  );
}

/**
 * Checks each row: a known, analysed response; an allowed brand; a fact_key
 * that exists in facts.json for that brand; a claim that appears verbatim in
 * the answer; and no duplicate rows.
 */
export function validateWrongFacts(
  rows: readonly WrongFact[],
  answerText: ReadonlyMap<string, string>,
  facts: ReadonlyMap<string, CompanyFacts>,
  allowedBrands: readonly string[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const where = `${r.responseId}/${r.brand}/${r.factKey}`;
    const text = answerText.get(r.responseId);
    if (text === undefined) problems.push(`${where}: response is unknown or was not analysed`);
    else if (!r.claimText || !text.includes(r.claimText)) problems.push(`${where}: claim_text is not in the answer`);
    if (!allowedBrands.includes(r.brand)) problems.push(`${where}: brand is outside ${allowedBrands.join(", ")}`);
    const f = facts.get(r.brand);
    const [head, sub] = r.factKey.split(".");
    const known =
      f !== undefined &&
      ((head === "hq" && f.hq !== null && !sub) ||
        (head === "founded" && f.founded !== null && !sub) ||
        (head === "starting_price_usd" && f.startingPriceUsd !== null && !sub) ||
        (head === "integrations" && !sub) ||
        (head === "features" && sub !== undefined && sub in f.features));
    if (!known) problems.push(`${where}: fact_key is not an entry in facts.json`);
    const key = `${r.responseId}|${r.brand}|${r.factKey}|${r.claimText}`;
    if (seen.has(key)) problems.push(`${where}: duplicate row`);
    seen.add(key);
  }
  return problems;
}

export function wrongFactsCsv(rows: readonly WrongFact[]): string {
  return toCsv(WRONG_FACTS_HEADER, rows.map((r) => [r.responseId, r.brand, r.factKey, r.claimText]));
}
