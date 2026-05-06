import { describe, expect, it } from 'vitest';
import { applyDictionary } from './dictionary';
import { expandSnippets } from './snippets';
import type { DictionaryItem, Snippet } from '../shared/types';

describe('text transforms', () => {
  it('expands longer snippets before shorter triggers', () => {
    const snippets: Snippet[] = [
      { id: 1, trigger: 'sig', expansion: 'short', category: '', shared: false, createdAt: '' },
      { id: 2, trigger: 'sig work', expansion: 'long', category: '', shared: false, createdAt: '' },
    ];

    expect(expandSnippets('please add sig work here', snippets)).toBe('please add long here');
  });

  it('escapes regex characters in snippet triggers', () => {
    const snippets: Snippet[] = [
      { id: 1, trigger: 'c++', expansion: 'C plus plus', category: '', shared: false, createdAt: '' },
    ];

    expect(expandSnippets('I use c++ daily', snippets)).toBe('I use C plus plus daily');
  });

  it('applies exact dictionary misspelling replacements on whole phrases', () => {
    const items: DictionaryItem[] = [
      { id: 1, phrase: 'Supabase', misspelling: 'super base', correctMisspelling: true, shared: false, createdAt: '' },
    ];

    expect(applyDictionary('connect to super base today', items)).toBe('connect to Supabase today');
  });

  it('normalizes dictionary casing without replacing partial words', () => {
    const items: DictionaryItem[] = [
      { id: 1, phrase: 'Echo', misspelling: null, correctMisspelling: false, shared: false, createdAt: '' },
    ];

    expect(applyDictionary('echo echoes', items)).toBe('Echo echoes');
  });
});
