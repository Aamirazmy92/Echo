import { Snippet } from '../shared/types';

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTriggerPattern(trigger: string) {
  const escaped = escapeRegex(trigger.trim()).replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^A-Za-z0-9])(${escaped})(?=[^A-Za-z0-9]|$)`, 'gi');
}

export function expandSnippetsDetailed(
  text: string,
  snippets: Snippet[],
): { text: string; usedSnippetIds: number[] } {
  let result = text;
  const usedSnippetIds: number[] = [];
  const orderedSnippets = [...snippets].sort((a, b) => b.trigger.length - a.trigger.length);

  for (const snippet of orderedSnippets) {
    const regex = getTriggerPattern(snippet.trigger);
    result = result.replace(regex, (_match, prefix) => {
      usedSnippetIds.push(snippet.id);
      return `${prefix}${snippet.expansion}`;
    });
  }
  return { text: result, usedSnippetIds };
}

export function expandSnippets(text: string, snippets: Snippet[]): string {
  return expandSnippetsDetailed(text, snippets).text;
}
