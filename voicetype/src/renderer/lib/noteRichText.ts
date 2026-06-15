const ALLOWED_EDITOR_TAGS = new Set([
  'A',
  'B',
  'BLOCKQUOTE',
  'BR',
  'CODE',
  'DIV',
  'EM',
  'H1',
  'H2',
  'H3',
  'I',
  'LI',
  'OL',
  'P',
  'STRONG',
  'TABLE',
  'TBODY',
  'TD',
  'TH',
  'THEAD',
  'TR',
  'U',
  'UL',
]);

const OUTLINE_DIV_CLASSES = [
  'sticky-outline',
  'sticky-outline-row',
  'sticky-outline-children',
  'sticky-outline-body',
  'sticky-outline-toggle',
  'sticky-outline-gutter',
];

const BLOCK_TAGS = new Set(['BLOCKQUOTE', 'DIV', 'H1', 'H2', 'H3', 'LI', 'OL', 'P', 'TABLE', 'TR', 'UL']);
// Headings count as structural content even while textless so that a freshly
// created (still empty) heading block isn't treated as an empty editor and
// wiped by the empty-state normalization in useRichTextEditor.
const STRUCTURAL_CONTENT_TAGS = new Set(['A', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3']);
const HTML_ENTITY_PATTERN = /&(?:[a-z][a-z0-9]+|#\d+|#x[\da-f]+);/i;

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function sanitizeNoteHtml(html: string): string {
  if (!html.trim()) return '';
  const template = document.createElement('template');
  template.innerHTML = html.includes('<') || HTML_ENTITY_PATTERN.test(html)
    ? html
    : escapeHtml(html).replace(/\n/g, '<br>');

  const cleanNode = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? '');
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const element = node as HTMLElement;
    if (!ALLOWED_EDITOR_TAGS.has(element.tagName)) {
      const fragment = document.createDocumentFragment();
      element.childNodes.forEach((child) => {
        const cleaned = cleanNode(child);
        if (cleaned) fragment.appendChild(cleaned);
      });
      return fragment;
    }

    const cleaned = document.createElement(element.tagName.toLowerCase());
    if (element.tagName === 'A') {
      const href = element.getAttribute('href') ?? '';
      if (/^https?:\/\//i.test(href)) {
        cleaned.setAttribute('href', href);
        cleaned.setAttribute('rel', 'noreferrer');
      }
    } else if (element.tagName === 'UL' && element.getAttribute('data-list') === 'check') {
      cleaned.setAttribute('data-list', 'check');
    } else if (element.tagName === 'LI' && element.getAttribute('data-checked') === 'true') {
      cleaned.setAttribute('data-checked', 'true');
    } else if (element.tagName === 'DIV') {
      const preservedOutlineClasses = OUTLINE_DIV_CLASSES.filter((className) =>
        element.classList.contains(className),
      );
      if (preservedOutlineClasses.length > 0) {
        cleaned.className = preservedOutlineClasses.join(' ');
      } else if (element.classList.contains('sticky-indent')) {
        cleaned.className = 'sticky-indent';
      }
      if (element.classList.contains('sticky-outline')) {
        const expanded = element.getAttribute('data-expanded');
        if (expanded === 'true' || expanded === 'false') {
          cleaned.setAttribute('data-expanded', expanded);
        }
      }
      if (element.classList.contains('sticky-outline-toggle')) {
        cleaned.setAttribute('role', 'button');
        cleaned.setAttribute('aria-label', 'Toggle nested content');
        const ariaExpanded = element.getAttribute('aria-expanded');
        if (ariaExpanded === 'true' || ariaExpanded === 'false') {
          cleaned.setAttribute('aria-expanded', ariaExpanded);
        }
      }
    } else if (element.tagName === 'TABLE' && element.classList.contains('sticky-note-table')) {
      cleaned.className = 'sticky-note-table';
    }
    element.childNodes.forEach((child) => {
      const cleanedChild = cleanNode(child);
      if (cleanedChild) cleaned.appendChild(cleanedChild);
    });
    return cleaned;
  };

  const fragment = document.createDocumentFragment();
  template.content.childNodes.forEach((child) => {
    const cleaned = cleanNode(child);
    if (cleaned) fragment.appendChild(cleaned);
  });

  const div = document.createElement('div');
  div.appendChild(fragment);
  return div.innerHTML;
}

export function noteHtmlToPlainText(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = sanitizeNoteHtml(html);
  let text = '';

  const appendBreak = () => {
    if (text && !text.endsWith('\n')) text += '\n';
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as HTMLElement;
    if (element.tagName === 'BR') {
      appendBreak();
      return;
    }

    element.childNodes.forEach(walk);
    if (BLOCK_TAGS.has(element.tagName)) appendBreak();
  };

  template.content.childNodes.forEach(walk);
  return text.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

export function noteHtmlIsEffectivelyEmpty(html: string): boolean {
  const sanitized = sanitizeNoteHtml(html);
  if (!sanitized.trim()) return true;

  const template = document.createElement('template');
  template.innerHTML = sanitized;

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;
  while (node) {
    if (STRUCTURAL_CONTENT_TAGS.has(node.tagName)) return false;
    node = walker.nextNode() as Element | null;
  }

  return noteHtmlToPlainText(sanitized).trim().length === 0;
}

export function noteHtmlHasMeaningfulContent(html: string): boolean {
  return !noteHtmlIsEffectivelyEmpty(html);
}
