import { useCallback, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  escapeHtml,
  noteHtmlIsEffectivelyEmpty,
  sanitizeNoteHtml,
} from '../../lib/noteRichText';

export type ActiveFormats = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
};

export type BlockType = 'p' | 'h1' | 'h2' | 'h3';

const EMPTY_FORMATS: ActiveFormats = { bold: false, italic: false, underline: false };

const COMMAND_BY_FORMAT: Record<keyof ActiveFormats, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
};

function getCommandState(command: string): boolean {
  try {
    return document.queryCommandState(command);
  } catch {
    return false;
  }
}

// Force the browser to emit semantic tags (<b>/<i>/<u>) rather than
// inline-styled <span> elements for bold/italic/underline. Styled spans are
// stripped by sanitizeNoteHtml's allowlist, which would silently drop inline
// formatting when the note is saved or reopened.
function disableStyleWithCss() {
  try {
    document.execCommand('styleWithCSS', false, 'false');
  } catch {
    // Older/edge engines may not support the toggle — safe to ignore.
  }
}

const OUTLINE_STRUCTURAL_CLASSES = [
  'sticky-outline',
  'sticky-outline-row',
  'sticky-outline-children',
  'sticky-outline-body',
  'sticky-outline-toggle',
  'sticky-outline-gutter',
];

function isOutlineStructuralElement(element: HTMLElement): boolean {
  return OUTLINE_STRUCTURAL_CLASSES.some((className) => element.classList.contains(className));
}

function isIndentableContentBlock(element: HTMLElement): boolean {
  return ['P', 'H1', 'H2', 'H3', 'BLOCKQUOTE'].includes(element.tagName);
}

function getBlockAncestor(node: Node, editor: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== editor) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current as HTMLElement;
      if (isOutlineStructuralElement(element)) {
        current = element.parentNode;
        continue;
      }
      if (element.classList.contains('sticky-indent')) {
        current = element.parentNode;
        continue;
      }
      if (['P', 'DIV', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(element.tagName)) {
        return element;
      }
    }
    current = current.parentNode;
  }
  return null;
}

function createOutlineToggle(): HTMLDivElement {
  const toggle = document.createElement('div');
  toggle.className = 'sticky-outline-toggle';
  toggle.setAttribute('contenteditable', 'false');
  toggle.setAttribute('role', 'button');
  toggle.setAttribute('aria-label', 'Toggle nested content');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.tabIndex = -1;
  return toggle;
}

function createOutlineGutter(): HTMLDivElement {
  const gutter = document.createElement('div');
  gutter.className = 'sticky-outline-gutter';
  gutter.setAttribute('contenteditable', 'false');
  gutter.setAttribute('aria-hidden', 'true');
  return gutter;
}

function wrapContentInOutlineBody(content: HTMLElement): HTMLDivElement {
  const body = document.createElement('div');
  body.className = 'sticky-outline-body';
  body.appendChild(content);
  return body;
}

function wrapContentInOutlineRow(content: HTMLElement, role: 'toggle' | 'gutter'): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'sticky-outline-row';
  row.appendChild(role === 'toggle' ? createOutlineToggle() : createOutlineGutter());
  row.appendChild(wrapContentInOutlineBody(content));
  return row;
}

function ensureOutlineChildren(outline: HTMLElement): HTMLDivElement {
  const existing = outline.querySelector(':scope > .sticky-outline-children');
  if (existing instanceof HTMLDivElement) return existing;
  const children = document.createElement('div');
  children.className = 'sticky-outline-children';
  outline.appendChild(children);
  return children;
}

function ensureOutlineRootToggle(outline: HTMLElement) {
  const rootRow = outline.querySelector(':scope > .sticky-outline-row');
  if (!(rootRow instanceof HTMLElement)) return;
  const gutter = rootRow.querySelector(':scope > .sticky-outline-gutter');
  if (gutter) gutter.replaceWith(createOutlineToggle());
}

function convertContentBlockToOutline(content: HTMLElement): HTMLDivElement {
  const outline = document.createElement('div');
  outline.className = 'sticky-outline';
  outline.setAttribute('data-expanded', 'true');
  outline.appendChild(wrapContentInOutlineRow(content, 'toggle'));
  const children = document.createElement('div');
  children.className = 'sticky-outline-children';
  outline.appendChild(children);
  return outline;
}

function convertOutlineRowToOutline(row: HTMLElement): HTMLDivElement {
  const body = row.querySelector(':scope > .sticky-outline-body');
  const outline = document.createElement('div');
  outline.className = 'sticky-outline';
  outline.setAttribute('data-expanded', 'true');

  const rootRow = document.createElement('div');
  rootRow.className = 'sticky-outline-row';
  rootRow.appendChild(createOutlineToggle());
  if (body) rootRow.appendChild(body);
  outline.appendChild(rootRow);

  const children = document.createElement('div');
  children.className = 'sticky-outline-children';
  outline.appendChild(children);

  row.replaceWith(outline);
  return outline;
}

function unwrapLegacyIndentAround(block: HTMLElement) {
  const legacy = block.closest('.sticky-indent');
  if (!(legacy instanceof HTMLElement) || !legacy.classList.contains('sticky-indent')) return;
  if (legacy.parentElement && legacy.contains(block)) unwrapElement(legacy);
}

function getOutlineIndentContext(
  block: HTMLElement,
  editor: HTMLElement,
): { host: HTMLElement; item: HTMLElement } | null {
  unwrapLegacyIndentAround(block);

  const row = block.closest('.sticky-outline-row');
  if (row instanceof HTMLElement) {
    const host = row.parentElement;
    if (host instanceof HTMLElement) {
      if (host.classList.contains('sticky-outline-children')) {
        return { host, item: row };
      }
      if (host.classList.contains('sticky-outline') && row === host.firstElementChild) {
        const outerHost = host.parentElement;
        if (outerHost instanceof HTMLElement) return { host: outerHost, item: host };
      }
    }
  }

  if (block.parentElement === editor) {
    return { host: editor, item: block };
  }

  return null;
}

function previousOutlineSibling(host: HTMLElement, item: HTMLElement): HTMLElement | null {
  let previous = item.previousElementSibling;
  while (previous instanceof HTMLElement) {
    if (
      previous.classList.contains('sticky-outline') ||
      previous.classList.contains('sticky-outline-row') ||
      isIndentableContentBlock(previous) ||
      previous.classList.contains('sticky-indent')
    ) {
      return previous;
    }
    previous = previous.previousElementSibling;
  }
  return null;
}

function prepareOutlineParent(previous: HTMLElement): HTMLDivElement {
  if (previous.classList.contains('sticky-outline')) {
    previous.setAttribute('data-expanded', 'true');
    ensureOutlineRootToggle(previous);
    return previous as HTMLDivElement;
  }

  if (previous.classList.contains('sticky-outline-row')) {
    return convertOutlineRowToOutline(previous);
  }

  if (isIndentableContentBlock(previous)) {
    const outline = convertContentBlockToOutline(previous);
    previous.replaceWith(outline);
    return outline;
  }

  if (previous.classList.contains('sticky-indent')) {
    const inner = previous.querySelector(':scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > blockquote');
    if (inner instanceof HTMLElement) {
      const parent = previous.parentElement;
      const next = previous.nextSibling;
      unwrapElement(previous);
      const outline = convertContentBlockToOutline(inner);
      parent?.insertBefore(outline, next);
      return outline;
    }
  }

  return convertContentBlockToOutline(previous);
}

function moveItemIntoOutlineChildren(item: HTMLElement, childrenHost: HTMLDivElement): HTMLElement {
  if (item.classList.contains('sticky-outline')) {
    childrenHost.appendChild(item);
    return item;
  }

  if (item.classList.contains('sticky-outline-row')) {
    childrenHost.appendChild(item);
    return item;
  }

  if (isIndentableContentBlock(item)) {
    const row = wrapContentInOutlineRow(item, 'gutter');
    childrenHost.appendChild(row);
    return row;
  }

  if (item.classList.contains('sticky-indent')) {
    const inner = item.querySelector(':scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > blockquote');
    if (inner instanceof HTMLElement) {
      unwrapElement(item);
      return moveItemIntoOutlineChildren(inner, childrenHost);
    }
  }

  return item;
}

function unwrapElement(element: Element) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

function getListFormat(list: Element): 'bullet' | 'number' | 'check' | null {
  if (list.tagName === 'OL') return 'number';
  if (list.tagName === 'UL') {
    return list.getAttribute('data-list') === 'check' ? 'check' : 'bullet';
  }
  return null;
}

function convertListToFormat(
  list: HTMLOListElement | HTMLUListElement,
  target: 'bullet' | 'number' | 'check',
): HTMLOListElement | HTMLUListElement {
  const items = Array.from(list.children).filter(
    (child): child is HTMLLIElement => child.tagName === 'LI',
  );

  const newList: HTMLOListElement | HTMLUListElement =
    target === 'number' ? document.createElement('ol') : document.createElement('ul');

  if (target === 'check') {
    newList.setAttribute('data-list', 'check');
  }

  for (const item of items) {
    if (target !== 'check') item.removeAttribute('data-checked');
    newList.appendChild(item);
  }

  list.parentNode?.replaceChild(newList, list);
  return newList;
}

function rangeClosestAnchor(range: Range, editor: HTMLElement): HTMLAnchorElement | null {
  const node = range.commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const anchor = element?.closest('a');
  return anchor instanceof HTMLAnchorElement && editor.contains(anchor) ? anchor : null;
}

export function normalizeLinkUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\s*\.\s*/g, '.');
  if (!trimmed) return null;
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return /^https?:\/\/\S+$/i.test(withProtocol) ? withProtocol : null;
}

export function useRichTextEditor(
  onBodyChange: (html: string) => void,
) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<Range | null>(null);
  const pendingFormatsRef = useRef<ActiveFormats>({ ...EMPTY_FORMATS });
  const [activeFormats, setActiveFormats] = useState<ActiveFormats>({ ...EMPTY_FORMATS });
  const [activeBlock, setActiveBlock] = useState<BlockType>('p');
  const [isEmpty, setIsEmpty] = useState(true);

  const recomputeIsEmpty = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      setIsEmpty(true);
      return true;
    }
    const empty = noteHtmlIsEffectivelyEmpty(editor.innerHTML);
    setIsEmpty((prev) => (prev === empty ? prev : empty));
    return empty;
  }, []);

  const editorIsEmpty = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return true;
    return noteHtmlIsEffectivelyEmpty(editor.innerHTML);
  }, []);

  const placeCaretAtEndOfEditor = useCallback(() => {
    const editor = editorRef.current;
    const selection = document.getSelection();
    if (!editor || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    selectionRef.current = range.cloneRange();
  }, []);

  const normalizeEmptyEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !editorIsEmpty()) return false;
    if (editor.innerHTML !== '') editor.innerHTML = '';
    placeCaretAtEndOfEditor();
    return true;
  }, [editorIsEmpty, placeCaretAtEndOfEditor]);

  const readSelectionInlineFormats = useCallback((): ActiveFormats => {
    const editor = editorRef.current;
    const selection = document.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return { ...EMPTY_FORMATS };
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return { ...EMPTY_FORMATS };
    return {
      bold: getCommandState('bold'),
      italic: getCommandState('italic'),
      underline: getCommandState('underline'),
    };
  }, []);

  const readCurrentBlock = useCallback((): BlockType => {
    const editor = editorRef.current;
    const selection = document.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return 'p';
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return 'p';
    const block = getBlockAncestor(range.commonAncestorContainer, editor);
    if (!block) return 'p';
    switch (block.tagName) {
      case 'H1':
        return 'h1';
      case 'H2':
        return 'h2';
      case 'H3':
        return 'h3';
      default:
        return 'p';
    }
  }, []);

  const clearBrowserInlineFormats = useCallback(() => {
    disableStyleWithCss();
    document.execCommand('removeFormat', false);
    for (const command of Object.values(COMMAND_BY_FORMAT)) {
      if (getCommandState(command)) {
        document.execCommand(command, false);
      }
    }
  }, []);

  const syncBrowserInlineFormatsFromPending = useCallback(() => {
    disableStyleWithCss();
    const pending = pendingFormatsRef.current;
    for (const format of Object.keys(COMMAND_BY_FORMAT) as (keyof ActiveFormats)[]) {
      const command = COMMAND_BY_FORMAT[format];
      const shouldBeActive = pending[format];
      const isActive = getCommandState(command);
      if (shouldBeActive !== isActive) {
        document.execCommand(command, false);
      }
    }
  }, []);

  const refreshActiveFormats = useCallback(() => {
    if (editorIsEmpty()) {
      const pending = pendingFormatsRef.current;
      if (pending.bold || pending.italic || pending.underline) {
        syncBrowserInlineFormatsFromPending();
      } else {
        clearBrowserInlineFormats();
        normalizeEmptyEditor();
      }
      setActiveFormats((prev) => {
        const next = pendingFormatsRef.current;
        return prev.bold === next.bold && prev.italic === next.italic && prev.underline === next.underline
          ? prev
          : { ...next };
      });
      setActiveBlock('p');
      return;
    }
    const next = readSelectionInlineFormats();
    pendingFormatsRef.current = next;
    setActiveFormats((prev) =>
      prev.bold === next.bold && prev.italic === next.italic && prev.underline === next.underline
        ? prev
        : next,
    );
    const block = readCurrentBlock();
    setActiveBlock((prev) => (prev === block ? prev : block));
  }, [clearBrowserInlineFormats, editorIsEmpty, normalizeEmptyEditor, readCurrentBlock, readSelectionInlineFormats, syncBrowserInlineFormatsFromPending]);

  const saveSelection = useCallback(() => {
    const selection = document.getSelection();
    const editor = editorRef.current;
    if (!selection || selection.rangeCount === 0 || !editor) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    selectionRef.current = range.cloneRange();
  }, []);

  const restoreSelection = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = document.getSelection();
    if (!selection) return;
    const range = selectionRef.current;
    if (range && editor.contains(range.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    const fallback = document.createRange();
    fallback.selectNodeContents(editor);
    fallback.collapse(false);
    selection.removeAllRanges();
    selection.addRange(fallback);
    selectionRef.current = fallback.cloneRange();
  }, []);

  const getRestoredSelectionRange = useCallback(() => {
    restoreSelection();
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    return selection.getRangeAt(0);
  }, [restoreSelection]);

  const getSelectionText = useCallback(() => {
    const editor = editorRef.current;
    const savedRange = selectionRef.current;
    if (editor && savedRange && editor.contains(savedRange.commonAncestorContainer)) {
      return savedRange.toString();
    }
    const selection = document.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return '';
    const range = selection.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer) ? selection.toString() : '';
  }, []);

  const placeCaretAfter = useCallback((node: Node) => {
    const selection = document.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    selectionRef.current = range.cloneRange();
  }, []);

  const placeCaretInNode = useCallback((node: Node, atStart = true) => {
    const selection = document.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(atStart);
    selection.removeAllRanges();
    selection.addRange(range);
    selectionRef.current = range.cloneRange();
  }, []);

  const refocusEditor = useCallback(() => {
    editorRef.current?.focus();
  }, []);

  const syncBody = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    onBodyChange(editor.innerHTML);
    recomputeIsEmpty();
  }, [onBodyChange, recomputeIsEmpty]);

  const scheduleEditorRefocus = useCallback(() => {
    requestAnimationFrame(() => {
      refocusEditor();
      if (editorIsEmpty()) {
        const pending = pendingFormatsRef.current;
        if (pending.bold || pending.italic || pending.underline) {
          syncBrowserInlineFormatsFromPending();
        }
      }
    });
  }, [editorIsEmpty, refocusEditor, syncBrowserInlineFormatsFromPending]);

  const insertHtml = useCallback(
    (html: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      const sanitized = sanitizeNoteHtml(html);
      if (!sanitized) return;
      restoreSelection();
      editor.focus();
      if (document.queryCommandSupported('insertHTML')) {
        document.execCommand('insertHTML', false, sanitized);
      } else {
        const range = getRestoredSelectionRange();
        if (!range) return;
        const template = document.createElement('template');
        template.innerHTML = sanitized;
        const fragment = template.content;
        const lastChild = fragment.lastChild;
        range.deleteContents();
        range.insertNode(fragment);
        if (lastChild) placeCaretAfter(lastChild);
      }
      if (sanitized.includes('<table')) {
        const table = editor.querySelector('table:last-of-type');
        const firstCell = table?.querySelector('td, th');
        if (firstCell) placeCaretInNode(firstCell, false);
      } else if (sanitized.includes('data-list="check"')) {
        const list = editor.querySelector('ul[data-list="check"]:last-of-type');
        const firstItem = list?.querySelector('li');
        if (firstItem) placeCaretInNode(firstItem, false);
      } else if (/<(?:ul|ol)\b/.test(sanitized)) {
        const list = editor.querySelector('ul:last-of-type, ol:last-of-type');
        const firstItem = list?.querySelector('li');
        if (firstItem) placeCaretInNode(firstItem, false);
      } else if (sanitized.includes('<blockquote')) {
        const quote = editor.querySelector('blockquote:last-of-type');
        if (quote) placeCaretInNode(quote, false);
      }
      saveSelection();
      syncBody();
      refreshActiveFormats();
      scheduleEditorRefocus();
    },
    [restoreSelection, getRestoredSelectionRange, placeCaretAfter, placeCaretInNode, saveSelection, syncBody, refreshActiveFormats, scheduleEditorRefocus],
  );

  const runCommand = useCallback(
    (command: string, value?: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      restoreSelection();
      editor.focus();
      if (editorIsEmpty()) normalizeEmptyEditor();
      if (!getRestoredSelectionRange()) return;
      document.execCommand(command, false, value);
      saveSelection();
      syncBody();
      refreshActiveFormats();
      scheduleEditorRefocus();
    },
    [editorIsEmpty, normalizeEmptyEditor, getRestoredSelectionRange, restoreSelection, saveSelection, syncBody, refreshActiveFormats, scheduleEditorRefocus],
  );

  const toggleCodeFormat = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    restoreSelection();
    editor.focus();
    if (editorIsEmpty()) normalizeEmptyEditor();
    const range = getRestoredSelectionRange();
    if (!range) return;

    let container: Node = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) container = container.parentNode!;
    const codeEl =
      container instanceof Element ? container.closest('code') : null;

    if (codeEl && editor.contains(codeEl)) {
      unwrapElement(codeEl);
    } else if (!range.collapsed) {
      const wrapper = document.createElement('code');
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
      placeCaretAfter(wrapper);
    } else {
      const code = document.createElement('code');
      code.innerHTML = '<br>';
      range.insertNode(code);
      placeCaretInNode(code, false);
    }
    saveSelection();
    syncBody();
    refreshActiveFormats();
    scheduleEditorRefocus();
  }, [
    editorIsEmpty,
    normalizeEmptyEditor,
    getRestoredSelectionRange,
    restoreSelection,
    placeCaretAfter,
    placeCaretInNode,
    saveSelection,
    syncBody,
    refreshActiveFormats,
    scheduleEditorRefocus,
  ]);

  const toggleBlockquote = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    restoreSelection();
    editor.focus();
    if (editorIsEmpty()) normalizeEmptyEditor();
    const range = getRestoredSelectionRange();
    if (!range) return;

    let container: Node = range.commonAncestorContainer;
    if (container.nodeType === Node.TEXT_NODE) container = container.parentNode!;
    const quoteEl =
      container instanceof Element ? container.closest('blockquote') : null;

    if (quoteEl && editor.contains(quoteEl)) {
      unwrapElement(quoteEl);
    } else if (editorIsEmpty()) {
      insertHtml('<blockquote><br></blockquote>');
    } else {
      document.execCommand('formatBlock', false, 'blockquote');
    }
    saveSelection();
    syncBody();
    refreshActiveFormats();
    scheduleEditorRefocus();
  }, [
    editorIsEmpty,
    normalizeEmptyEditor,
    getRestoredSelectionRange,
    restoreSelection,
    insertHtml,
    saveSelection,
    syncBody,
    refreshActiveFormats,
    scheduleEditorRefocus,
  ]);

  const setBlockType = useCallback(
    (type: BlockType) => {
      const editor = editorRef.current;
      if (!editor) return;
      restoreSelection();
      editor.focus();
      if (editorIsEmpty()) normalizeEmptyEditor();
      if (!getRestoredSelectionRange()) return;
      const current = readCurrentBlock();
      const target: BlockType = current === type && type !== 'p' ? 'p' : type;
      document.execCommand('formatBlock', false, target.toUpperCase());
      saveSelection();
      syncBody();
      setActiveBlock(target);
      refreshActiveFormats();
      scheduleEditorRefocus();
    },
    [
      editorIsEmpty,
      normalizeEmptyEditor,
      getRestoredSelectionRange,
      readCurrentBlock,
      restoreSelection,
      saveSelection,
      syncBody,
      refreshActiveFormats,
      scheduleEditorRefocus,
    ],
  );

  const indentBlocks = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    restoreSelection();
    editor.focus();
    if (editorIsEmpty()) normalizeEmptyEditor();
    const range = getRestoredSelectionRange();
    if (!range) return;

    const block = getBlockAncestor(range.commonAncestorContainer, editor);
    if (!block || block.tagName === 'LI') {
      document.execCommand('indent');
      saveSelection();
      syncBody();
      refreshActiveFormats();
      scheduleEditorRefocus();
      return;
    }

    const context = getOutlineIndentContext(block, editor);
    if (!context) return;

    const previous = previousOutlineSibling(context.host, context.item);
    if (!previous) return;

    const parentOutline = prepareOutlineParent(previous);
    const childrenHost = ensureOutlineChildren(parentOutline);
    const movedItem = moveItemIntoOutlineChildren(context.item, childrenHost);
    const movedContent =
      movedItem.querySelector('.sticky-outline-body > :first-child') ??
      movedItem.querySelector('.sticky-outline-body') ??
      movedItem;
    placeCaretInNode(movedContent, false);

    saveSelection();
    syncBody();
    refreshActiveFormats();
    scheduleEditorRefocus();
  }, [
    editorIsEmpty,
    normalizeEmptyEditor,
    getRestoredSelectionRange,
    restoreSelection,
    saveSelection,
    syncBody,
    refreshActiveFormats,
    scheduleEditorRefocus,
    placeCaretInNode,
  ]);

  const toggleOutlineBlock = useCallback(
    (clientX: number, toggle: HTMLElement) => {
      const editor = editorRef.current;
      if (!editor || !editor.contains(toggle)) return false;
      const rect = toggle.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right) return false;

      const outline = toggle.closest('.sticky-outline');
      if (!(outline instanceof HTMLElement)) return false;

      const expanded = outline.getAttribute('data-expanded') !== 'false';
      outline.setAttribute('data-expanded', expanded ? 'false' : 'true');
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      saveSelection();
      syncBody();
      return true;
    },
    [saveSelection, syncBody],
  );

  const applyListFormat = useCallback(
    (target: 'bullet' | 'number' | 'check') => {
      const editor = editorRef.current;
      if (!editor) return;
      restoreSelection();
      editor.focus();
      if (editorIsEmpty()) normalizeEmptyEditor();
      const range = getRestoredSelectionRange();
      if (!range) return;

      let container: Node = range.commonAncestorContainer;
      if (container.nodeType === Node.TEXT_NODE) container = container.parentNode!;
      const listItem =
        container instanceof Element ? container.closest('li') : null;
      const list = listItem?.parentElement ?? null;

      if (listItem && list && editor.contains(listItem) && getListFormat(list)) {
        const currentFormat = getListFormat(list)!;
        if (currentFormat === target) {
          placeCaretInNode(listItem, false);
        } else {
          const converted = convertListToFormat(
            list as HTMLOListElement | HTMLUListElement,
            target,
          );
          const index = Array.from(list.children).indexOf(listItem);
          const nextItem =
            (index >= 0 ? converted.children.item(index) : null) ??
            converted.querySelector('li');
          if (nextItem) placeCaretInNode(nextItem, false);
        }
        saveSelection();
        syncBody();
        scheduleEditorRefocus();
        return;
      }

      const html =
        target === 'number'
          ? '<ol><li><br></li></ol>'
          : target === 'check'
            ? '<ul data-list="check"><li><br></li></ul>'
            : '<ul><li><br></li></ul>';
      insertHtml(html);
    },
    [
      editorIsEmpty,
      normalizeEmptyEditor,
      getRestoredSelectionRange,
      restoreSelection,
      insertHtml,
      placeCaretInNode,
      saveSelection,
      syncBody,
      scheduleEditorRefocus,
    ],
  );

  const insertBulletedList = useCallback(() => {
    applyListFormat('bullet');
  }, [applyListFormat]);

  const insertNumberedList = useCallback(() => {
    applyListFormat('number');
  }, [applyListFormat]);

  const insertChecklist = useCallback(() => {
    applyListFormat('check');
  }, [applyListFormat]);

  const toggleChecklistItem = useCallback(
    (clientX: number, listItem: HTMLLIElement) => {
      const editor = editorRef.current;
      if (!editor || !editor.contains(listItem)) return false;
      const rect = listItem.getBoundingClientRect();
      if (clientX - rect.left > 34) return false;
      const checked = listItem.getAttribute('data-checked') === 'true';
      if (checked) listItem.removeAttribute('data-checked');
      else listItem.setAttribute('data-checked', 'true');
      saveSelection();
      syncBody();
      return true;
    },
    [saveSelection, syncBody],
  );

  const continueListItem = useCallback(
    (listItem: HTMLLIElement) => {
      const text = (listItem.textContent ?? '').replace(/\u200B/g, '').trim();
      const list = listItem.parentElement;

      if (!text) {
        const paragraph = document.createElement('p');
        paragraph.innerHTML = '<br>';
        list?.parentNode?.insertBefore(paragraph, list.nextSibling);
        if (list && list.children.length === 1) list.remove();
        else listItem.remove();
        placeCaretInNode(paragraph, false);
      } else {
        const newItem = document.createElement('li');
        newItem.innerHTML = '<br>';
        listItem.parentNode?.insertBefore(newItem, listItem.nextSibling);
        placeCaretInNode(newItem, false);
      }
      saveSelection();
      syncBody();
    },
    [placeCaretInNode, saveSelection, syncBody],
  );

  const handleEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      const editor = editorRef.current;
      const selection = document.getSelection();
      if (!editor || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return;

      let container: Node = range.commonAncestorContainer;
      if (container.nodeType === Node.TEXT_NODE) container = container.parentNode!;
      if (!(container instanceof Element)) return;

      const checklistItem = container.closest('ul[data-list="check"] > li');
      if (checklistItem instanceof HTMLLIElement && editor.contains(checklistItem)) {
        event.preventDefault();
        continueListItem(checklistItem);
        return;
      }

      const bulletItem = container.closest('ul:not([data-list="check"]) > li');
      if (bulletItem instanceof HTMLLIElement && editor.contains(bulletItem)) {
        event.preventDefault();
        continueListItem(bulletItem);
        return;
      }

      const numberedItem = container.closest('ol > li');
      if (numberedItem instanceof HTMLLIElement && editor.contains(numberedItem)) {
        event.preventDefault();
        continueListItem(numberedItem);
      }
    },
    [continueListItem],
  );

  const wrapSelectionWithTag = useCallback(
    (tagName: 'strong' | 'em' | 'u' | 'code' | 'a', emptyHtml: string, attrs?: Record<string, string>) => {
      const range = getRestoredSelectionRange();
      if (!range) return;
      if (range.collapsed) {
        if (emptyHtml) insertHtml(emptyHtml);
        return;
      }
      const wrapper = document.createElement(tagName);
      Object.entries(attrs ?? {}).forEach(([key, value]) => wrapper.setAttribute(key, value));
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
      placeCaretAfter(wrapper);
      saveSelection();
      syncBody();
      refreshActiveFormats();
    },
    [getRestoredSelectionRange, insertHtml, placeCaretAfter, saveSelection, syncBody, refreshActiveFormats],
  );

  const toggleInlineFormat = useCallback(
    (format: keyof ActiveFormats) => {
      const editor = editorRef.current;
      if (!editor) return;
      restoreSelection();
      editor.focus();

      if (editorIsEmpty()) {
        normalizeEmptyEditor();
        pendingFormatsRef.current = {
          ...pendingFormatsRef.current,
          [format]: !pendingFormatsRef.current[format],
        };
        if (
          !pendingFormatsRef.current.bold &&
          !pendingFormatsRef.current.italic &&
          !pendingFormatsRef.current.underline
        ) {
          clearBrowserInlineFormats();
          normalizeEmptyEditor();
        } else {
          syncBrowserInlineFormatsFromPending();
        }
      } else {
        disableStyleWithCss();
        document.execCommand(COMMAND_BY_FORMAT[format], false);
        pendingFormatsRef.current = readSelectionInlineFormats();
      }

      setActiveFormats({ ...pendingFormatsRef.current });
      saveSelection();
      syncBody();
      scheduleEditorRefocus();
    },
    [
      clearBrowserInlineFormats,
      editorIsEmpty,
      normalizeEmptyEditor,
      readSelectionInlineFormats,
      restoreSelection,
      saveSelection,
      syncBody,
      syncBrowserInlineFormatsFromPending,
      scheduleEditorRefocus,
    ],
  );

  const onInput = useCallback(() => {
    saveSelection();
    if (editorIsEmpty()) {
      setActiveFormats({ ...pendingFormatsRef.current });
      setActiveBlock('p');
    } else {
      pendingFormatsRef.current = readSelectionInlineFormats();
      setActiveFormats({ ...pendingFormatsRef.current });
      const block = readCurrentBlock();
      setActiveBlock((prev) => (prev === block ? prev : block));
    }
    syncBody();
  }, [saveSelection, editorIsEmpty, readCurrentBlock, readSelectionInlineFormats, syncBody]);

  const onPaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const html = event.clipboardData.getData('text/html');
      const text = event.clipboardData.getData('text/plain');
      insertHtml(html || escapeHtml(text).replace(/\n/g, '<br>'));
    },
    [insertHtml],
  );

  const setEditorContent = useCallback(
    (html: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.innerHTML = sanitizeNoteHtml(html);
      selectionRef.current = null;
      pendingFormatsRef.current = { ...EMPTY_FORMATS };
      recomputeIsEmpty();
      refreshActiveFormats();
    },
    [recomputeIsEmpty, refreshActiveFormats],
  );

  const findAnchorInSelection = useCallback((): HTMLAnchorElement | null => {
    const editor = editorRef.current;
    const range = selectionRef.current;
    if (!editor || !range) return null;
    return rangeClosestAnchor(range, editor);
  }, []);

  return {
    editorRef,
    activeFormats,
    isEmpty,
    saveSelection,
    restoreSelection,
    getRestoredSelectionRange,
    getSelectionText,
    placeCaretAfter,
    placeCaretInNode,
    refreshActiveFormats,
    insertHtml,
    runCommand,
    wrapSelectionWithTag,
    activeBlock,
    setBlockType,
    toggleInlineFormat,
    toggleCodeFormat,
    toggleBlockquote,
    indentBlocks,
    insertBulletedList,
    insertNumberedList,
    insertChecklist,
    toggleChecklistItem,
    toggleOutlineBlock,
    handleEditorKeyDown,
    onInput,
    onPaste,
    setEditorContent,
    findAnchorInSelection,
    recomputeIsEmpty,
    syncBody,
    refocusEditor,
    scheduleEditorRefocus,
  };
}

export type UseRichTextEditorReturn = ReturnType<typeof useRichTextEditor>;
