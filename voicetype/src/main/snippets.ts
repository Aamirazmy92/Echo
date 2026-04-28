import { Snippet } from '../shared/types';

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function expandSnippets(text: string, snippets: Snippet[]): string {
  let result = text;
  const orderedSnippets = [...snippets].sort((a, b) => b.trigger.length - a.trigger.length);

  for (const snippet of orderedSnippets) {
    const regex = new RegExp(`\\b${escapeRegex(snippet.trigger).replace(/\s+/g, '\\s+')}\\b`, 'gi');
    result = result.replace(regex, snippet.expansion);
  }
  return result;
}
