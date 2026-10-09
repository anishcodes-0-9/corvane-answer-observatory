/**
 * Text primitives shared by the brand catalog and the matcher, so brand forms
 * and answer text are normalised the same way.
 */

export interface Token {
  /** Normalised key: NFKD, combining marks removed, lower-cased. */
  key: string;
  /** Offsets into the original string (UTF-16 code units, end exclusive). */
  start: number;
  end: number;
  /** The token exactly as written. */
  raw: string;
}

// A token is a run of letters/digits, with any combining marks attached to it
// (so a decomposed "é" stays inside its word).
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

export function normalizeKey(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index;
    tokens.push({ key: normalizeKey(m[0]), start, end: start + m[0].length, raw: m[0] });
  }
  return tokens;
}

/**
 * Characters allowed between the parts of one name: spaces on the same line
 * (including non-breaking), hyphens/dashes, and zero-width characters. Line
 * breaks and punctuation end a name.
 */
const JOINER_RE = /^(?:[^\S\r\n]|[-‐-―​-‍⁠﻿]){1,3}$/u;

export function isNameJoiner(between: string): boolean {
  return JOINER_RE.test(between);
}

export function startsWithCapital(raw: string): boolean {
  return /^\p{Lu}/u.test(raw);
}

/** Optimal string alignment distance (Levenshtein plus adjacent transposition). */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    let rowMin = Infinity;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[rows - 1]![cols - 1]!;
}
