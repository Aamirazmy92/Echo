import { DictionaryItem } from '../shared/types';

type ReplacementRule = {
  replacement: string;
  source: string;
};

type WordSpan = {
  start: number;
  end: number;
  normalized: string;
};

type ReplacementCandidate = {
  start: number;
  end: number;
  replacement: string;
  distance: number;
};

const WORD_PATTERN = /[A-Za-z0-9']+/g;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeComparable(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function replaceWholePhrase(text: string, source: string, replacement: string) {
  const escaped = escapeRegex(source.trim()).replace(/\s+/g, '\\s+');
  const regex = new RegExp(`(^|[^A-Za-z0-9])(${escaped})(?=[^A-Za-z0-9]|$)`, 'gi');
  return text.replace(regex, (_match, prefix) => `${prefix}${replacement}`);
}

function getWordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  let match: RegExpExecArray | null;

  while ((match = WORD_PATTERN.exec(text)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      normalized: normalizeComparable(match[0]),
    });
  }

  return spans;
}

function levenshteinDistance(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array(b.length + 1).fill(0);
  const next = new Array(b.length + 1).fill(0);

  for (let index = 0; index <= b.length; index += 1) {
    prev[index] = index;
  }

  for (let row = 1; row <= a.length; row += 1) {
    next[0] = row;

    for (let col = 1; col <= b.length; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      next[col] = Math.min(next[col - 1] + 1, prev[col] + 1, prev[col - 1] + cost);
    }

    for (let col = 0; col <= b.length; col += 1) {
      prev[col] = next[col];
    }
  }

  return prev[b.length];
}

function getMisspellingThreshold(target: string) {
  if (target.length <= 6) return 1;
  if (target.length <= 14) return 2;
  return 3;
}

function collectLegacyFuzzyCandidates(text: string, items: DictionaryItem[]) {
  const candidates: ReplacementCandidate[] = [];
  const wordSpans = getWordSpans(text);

  for (const item of items) {
    if (!item.correctMisspelling || item.misspelling) continue;

    const targetWords = item.phrase
      .split(/\s+/)
      .map((part) => normalizeComparable(part))
      .filter(Boolean);

    if (!targetWords.length) continue;

    const targetCombined = targetWords.join(' ');
    const threshold = getMisspellingThreshold(targetCombined);

    for (let index = 0; index <= wordSpans.length - targetWords.length; index += 1) {
      const window = wordSpans.slice(index, index + targetWords.length);
      const combined = window.map((part) => part.normalized).join(' ');

      if (!combined || combined === targetCombined) continue;

      const firstLettersMatch =
        (window[0]?.normalized[0] ?? '') === (targetWords[0]?.[0] ?? '') &&
        (window[window.length - 1]?.normalized[0] ?? '') === (targetWords[targetWords.length - 1]?.[0] ?? '');

      if (!firstLettersMatch) continue;

      const distance = levenshteinDistance(combined, targetCombined);
      if (distance === 0 || distance > threshold) continue;

      candidates.push({
        start: window[0].start,
        end: window[window.length - 1].end,
        replacement: item.phrase,
        distance,
      });
    }
  }

  return candidates.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return (b.end - b.start) - (a.end - a.start);
  });
}

function applyCandidates(text: string, candidates: ReplacementCandidate[]) {
  if (!candidates.length) return text;

  let cursor = 0;
  let result = '';

  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    result += text.slice(cursor, candidate.start);
    result += candidate.replacement;
    cursor = candidate.end;
  }

  result += text.slice(cursor);
  return result;
}

export function applyDictionary(text: string, items: DictionaryItem[]) {
  if (!text.trim() || !items.length) return text;

  const exactReplacementRules: ReplacementRule[] = [];
  const caseNormalizationRules: ReplacementRule[] = [];

  for (const item of items) {
    if (item.correctMisspelling && item.misspelling?.trim()) {
      exactReplacementRules.push({
        source: item.misspelling.trim(),
        replacement: item.phrase,
      });
    }

    caseNormalizationRules.push({
      source: item.phrase,
      replacement: item.phrase,
    });
  }

  let result = text;

  for (const rule of exactReplacementRules.sort((a, b) => b.source.length - a.source.length)) {
    result = replaceWholePhrase(result, rule.source, rule.replacement);
  }

  const legacyFuzzy = collectLegacyFuzzyCandidates(result, items);
  result = applyCandidates(result, legacyFuzzy);

  for (const rule of caseNormalizationRules.sort((a, b) => b.source.length - a.source.length)) {
    result = replaceWholePhrase(result, rule.source, rule.replacement);
  }

  return result;
}
