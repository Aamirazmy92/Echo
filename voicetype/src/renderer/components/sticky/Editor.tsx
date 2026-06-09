import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from 'react';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bold,
  Code2,
  Copy,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListEnd,
  ListOrdered,
  Quote,
  Table2,
  Type,
  Underline,
} from 'lucide-react';
import { toast } from '../toast/useToast';
import type { UseRichTextEditorReturn, ActiveFormats } from './useRichTextEditor';
import { normalizeLinkUrl } from './useRichTextEditor';

const noDrag: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties;

const TABLE_PICKER_COLUMNS = 10;
const TABLE_PICKER_ROWS = 10;

type FormatPopover = 'link' | 'table' | null;

type SlashCommand = {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
  keywords: string[];
  run: () => void;
};

function buildBlankTableHtml(columns: number, rows: number) {
  const makeCells = (tag: 'td' | 'th', count: number) =>
    Array.from({ length: count }, () => `<${tag}><br></${tag}>`).join('');
  if (rows <= 1) {
    return `<table class="sticky-note-table"><tbody><tr>${makeCells('td', columns)}</tr></tbody></table>`;
  }
  const headerRow = `<tr>${makeCells('th', columns)}</tr>`;
  const bodyRows = Array.from({ length: rows - 1 }, () => `<tr>${makeCells('td', columns)}</tr>`).join('');
  return `<table class="sticky-note-table"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}

type EditorProps = {
  editor: UseRichTextEditorReturn;
  title: string;
  onTitleChange: (value: string) => void;
  wordCount: number;
  meta: string;
};

export default function Editor({ editor, title, onTitleChange, meta }: EditorProps) {
  const {
    editorRef,
    isEmpty,
    activeFormats,
    setBlockType,
    insertHtml,
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
    saveSelection,
    refreshActiveFormats,
    getRestoredSelectionRange,
    getSelectionText,
    placeCaretAfter,
    syncBody,
    findAnchorInSelection,
  } = editor;

  const [formatPopover, setFormatPopover] = useState<FormatPopover>(null);
  const [formatsOpen, setFormatsOpen] = useState(false);
  const [linkForm, setLinkForm] = useState({ text: '', url: '' });
  const [copyFeedback, setCopyFeedback] = useState(false);
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const linkTextInputRef = useRef<HTMLInputElement | null>(null);
  const linkPopoverRef = useRef<HTMLDivElement | null>(null);
  const tablePickerRef = useRef<HTMLDivElement | null>(null);
  const linkRangeRef = useRef<Range | null>(null);
  const linkEditAnchorRef = useRef<HTMLAnchorElement | null>(null);

  const closeFormatPopover = useCallback(() => {
    linkRangeRef.current = null;
    linkEditAnchorRef.current = null;
    setFormatPopover(null);
  }, []);

  useEffect(
    () => () => {
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (formatPopover === null) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        closeFormatPopover();
        return;
      }
      if (linkPopoverRef.current?.contains(target)) return;
      if (tablePickerRef.current?.contains(target)) return;
      if (target.closest('[data-format-popover-trigger]')) return;
      closeFormatPopover();
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [formatPopover, closeFormatPopover]);

  useEffect(() => {
    if (formatPopover === 'link') setTimeout(() => linkTextInputRef.current?.focus(), 0);
  }, [formatPopover]);

  const getRangeAnchor = useCallback((range: Range): HTMLAnchorElement | null => {
    const editorEl = editorRef.current;
    if (!editorEl) return null;
    const node = range.commonAncestorContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const anchor = element?.closest('a');
    return anchor instanceof HTMLAnchorElement && editorEl.contains(anchor) ? anchor : null;
  }, [editorRef]);

  const getCurrentEditorRange = useCallback((): Range | null => {
    const editorEl = editorRef.current;
    const selection = document.getSelection();
    if (!editorEl || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return editorEl.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
  }, [editorRef]);

  const restoreLinkRange = useCallback((): Range | null => {
    const editorEl = editorRef.current;
    if (!editorEl) return null;

    editorEl.focus();
    const selection = document.getSelection();
    if (!selection) return null;

    const storedRange = linkRangeRef.current;
    if (storedRange && editorEl.contains(storedRange.commonAncestorContainer)) {
      const range = storedRange.cloneRange();
      selection.removeAllRanges();
      selection.addRange(range);
      return range;
    }

    const fallback = getRestoredSelectionRange();
    return fallback ? fallback.cloneRange() : null;
  }, [editorRef, getRestoredSelectionRange]);

  const openLinkPopover = useCallback(() => {
    saveSelection();
    const range = getCurrentEditorRange() ?? getRestoredSelectionRange()?.cloneRange() ?? null;
    const anchor = range ? getRangeAnchor(range) : findAnchorInSelection();
    linkRangeRef.current = range;
    linkEditAnchorRef.current = anchor && range?.collapsed ? anchor : null;
    setLinkForm({
      text: linkEditAnchorRef.current?.textContent ?? range?.toString() ?? getSelectionText(),
      url: linkEditAnchorRef.current?.getAttribute('href') ?? '',
    });
    setFormatPopover((open) => (open === 'link' ? null : 'link'));
  }, [saveSelection, getCurrentEditorRange, getRestoredSelectionRange, getRangeAnchor, findAnchorInSelection, getSelectionText]);

  const applyLinkForm = useCallback(() => {
    const editorEl = editorRef.current;
    if (!editorEl) return;
    const url = normalizeLinkUrl(linkForm.url);
    if (!url) {
      toast.error('Enter a valid link URL.');
      return;
    }
    const range = restoreLinkRange();
    if (!range) return;
    const text = linkForm.text.trim() || range.toString().trim() || url;
    const anchor = linkEditAnchorRef.current;

    if (anchor && editorEl.contains(anchor)) {
      anchor.href = url;
      anchor.rel = 'noreferrer';
      anchor.textContent = text;
      placeCaretAfter(anchor);
    } else if (!range.collapsed) {
      const link = document.createElement('a');
      link.href = url;
      link.rel = 'noreferrer';
      link.textContent = text;
      range.deleteContents();
      range.insertNode(link);
      placeCaretAfter(link);
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.rel = 'noreferrer';
      link.textContent = text;
      range.insertNode(link);
      placeCaretAfter(link);
    }
    saveSelection();
    syncBody();
    refreshActiveFormats();
    linkRangeRef.current = null;
    linkEditAnchorRef.current = null;
    setFormatPopover(null);
  }, [editorRef, linkForm, restoreLinkRange, placeCaretAfter, saveSelection, syncBody, refreshActiveFormats]);

  const insertTable = (columns: number, rows: number) => {
    saveSelection();
    insertHtml(buildBlankTableHtml(columns, rows));
    setFormatPopover(null);
  };

  const handleEditorLinkActivation = useCallback(async (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    const element =
      target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
    if (!element) return;
    const editorEl = editorRef.current;
    const anchor = element.closest('a');
    if (!editorEl || !(anchor instanceof HTMLAnchorElement) || !editorEl.contains(anchor)) return;

    event.preventDefault();
    event.stopPropagation();

    const url = normalizeLinkUrl(anchor.getAttribute('href') ?? anchor.href);
    if (!url) {
      toast.error('Could not open this link.');
      return;
    }

    try {
      if (typeof window.api.openExternalUrl === 'function') {
        await window.api.openExternalUrl(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      try {
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      } catch {
        window.api.reportRendererError?.(
          'sticky-open-link',
          error instanceof Error ? error.message : 'Could not open link',
          error instanceof Error ? error.stack : undefined,
        );
        toast.error('Could not open this link.');
      }
    }
  }, [editorRef]);

  const handleEditorMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    const element =
      target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
    if (!element) return;

    const outlineToggle = element.closest('.sticky-outline-toggle');
    if (outlineToggle instanceof HTMLElement && toggleOutlineBlock(event.clientX, outlineToggle)) {
      event.preventDefault();
      return;
    }

    const listItem = element.closest('ul[data-list="check"] > li');
    if (listItem instanceof HTMLLIElement && toggleChecklistItem(event.clientX, listItem)) {
      event.preventDefault();
      return;
    }

    void handleEditorLinkActivation(event);
  }, [toggleChecklistItem, toggleOutlineBlock, handleEditorLinkActivation]);

  const handleFormat = (
    kind: 'bold' | 'italic' | 'underline' | 'code' | 'bullet' | 'number' | 'check' | 'quote' | 'indent' | 'link' | 'table',
  ) => {
    saveSelection();
    setFormatsOpen(true);
    switch (kind) {
      case 'bold':
      case 'italic':
      case 'underline':
        toggleInlineFormat(kind);
        break;
      case 'code':
        toggleCodeFormat();
        break;
      case 'bullet':
        setFormatPopover(null);
        insertBulletedList();
        break;
      case 'number':
        setFormatPopover(null);
        insertNumberedList();
        break;
      case 'check':
        setFormatPopover(null);
        insertChecklist();
        break;
      case 'quote':
        setFormatPopover(null);
        toggleBlockquote();
        break;
      case 'indent':
        setFormatPopover(null);
        indentBlocks();
        break;
      case 'link':
        openLinkPopover();
        break;
      case 'table':
        saveSelection();
        setFormatPopover((open) => (open === 'table' ? null : 'table'));
        break;
    }
  };

  const handleCopy = async () => {
    try {
      const editorEl = editorRef.current;
      const text = editorEl?.innerText ?? '';
      await window.api.writeClipboardText(text);
      toast.success('Copied to clipboard.');
      setCopyFeedback(true);
      if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
      copyFeedbackTimer.current = setTimeout(() => setCopyFeedback(false), 1400);
    } catch {
      toast.error('Could not copy.');
    }
  };

  // ── Slash command menu ──────────────────────────────────────────────────
  const [slashMenu, setSlashMenu] = useState<{ query: string; x: number; y: number } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashQueryRef = useRef<string | null>(null);
  const slashRangeRef = useRef<{ node: Text; start: number; end: number } | null>(null);

  const closeSlashMenu = useCallback(() => {
    slashQueryRef.current = null;
    slashRangeRef.current = null;
    setSlashMenu(null);
  }, []);

  const slashCommands = useMemo<SlashCommand[]>(
    () => [
      { id: 'text', label: 'Text', hint: 'Plain paragraph', icon: <Type size={15} />, keywords: ['paragraph', 'body'], run: () => setBlockType('p') },
      { id: 'h1', label: 'Heading 1', hint: 'Large section title', icon: <Heading1 size={15} />, keywords: ['title', 'big', 'header'], run: () => setBlockType('h1') },
      { id: 'h2', label: 'Heading 2', hint: 'Medium heading', icon: <Heading2 size={15} />, keywords: ['subtitle', 'header'], run: () => setBlockType('h2') },
      { id: 'h3', label: 'Heading 3', hint: 'Small heading', icon: <Heading3 size={15} />, keywords: ['header'], run: () => setBlockType('h3') },
      { id: 'bullet', label: 'Bulleted list', hint: 'Simple bullet list', icon: <List size={15} />, keywords: ['unordered', 'bullets', 'ul'], run: () => insertBulletedList() },
      { id: 'number', label: 'Numbered list', hint: 'Ordered list', icon: <ListOrdered size={15} />, keywords: ['ordered', 'numbers', 'ol'], run: () => insertNumberedList() },
      { id: 'check', label: 'Checklist', hint: 'Track tasks', icon: <ListChecks size={15} />, keywords: ['todo', 'task', 'checkbox'], run: () => insertChecklist() },
      { id: 'quote', label: 'Quote', hint: 'Capture a quote', icon: <Quote size={15} />, keywords: ['blockquote', 'cite'], run: () => toggleBlockquote() },
      { id: 'code', label: 'Code', hint: 'Inline monospace', icon: <Code2 size={15} />, keywords: ['monospace', 'snippet'], run: () => toggleCodeFormat() },
      { id: 'table', label: 'Table', hint: 'Insert a 3×3 grid', icon: <Table2 size={15} />, keywords: ['grid', 'rows', 'columns'], run: () => insertHtml(buildBlankTableHtml(3, 3)) },
      { id: 'link', label: 'Link', hint: 'Add a hyperlink', icon: <LinkIcon size={15} />, keywords: ['url', 'href'], run: () => openLinkPopover() },
    ],
    [setBlockType, insertBulletedList, insertNumberedList, insertChecklist, toggleBlockquote, toggleCodeFormat, insertHtml, openLinkPopover],
  );

  const filteredSlashCommands = useMemo(() => {
    if (!slashMenu) return [];
    const q = slashMenu.query.toLowerCase();
    if (!q) return slashCommands;
    return slashCommands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords.some((k) => k.includes(q)),
    );
  }, [slashMenu, slashCommands]);

  const detectSlashTrigger = useCallback(() => {
    const editorEl = editorRef.current;
    const selection = document.getSelection();
    if (!editorEl || !selection || selection.rangeCount === 0) {
      closeSlashMenu();
      return;
    }
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !editorEl.contains(range.startContainer)) {
      closeSlashMenu();
      return;
    }
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      closeSlashMenu();
      return;
    }
    const text = node.textContent ?? '';
    const offset = range.startOffset;
    const before = text.slice(0, offset);
    const match = before.match(/(?:^|\s)\/([\p{L}\d]*)$/u);
    if (!match) {
      closeSlashMenu();
      return;
    }
    const query = match[1];
    slashRangeRef.current = { node: node as Text, start: offset - query.length - 1, end: offset };
    const rect = range.getBoundingClientRect();
    const editorRect = editorEl.getBoundingClientRect();
    const x = (rect.left || editorRect.left + 24);
    const y = (rect.bottom || editorRect.top + 24) + 6;
    if (slashQueryRef.current !== query) {
      slashQueryRef.current = query;
      setSlashIndex(0);
    }
    setSlashMenu({ query, x, y });
  }, [editorRef, closeSlashMenu]);

  const runSlashCommand = useCallback(
    (command: SlashCommand) => {
      const info = slashRangeRef.current;
      const editorEl = editorRef.current;
      if (info && editorEl && editorEl.contains(info.node)) {
        try {
          const range = document.createRange();
          range.setStart(info.node, info.start);
          range.setEnd(info.node, info.end);
          range.deleteContents();
          range.collapse(true);
          const selection = document.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          saveSelection();
          syncBody();
        } catch {
          // Stale range — run the command at the current caret instead.
        }
      }
      closeSlashMenu();
      command.run();
    },
    [editorRef, saveSelection, syncBody, closeSlashMenu],
  );

  const onEditorInput = useCallback(() => {
    onInput();
    detectSlashTrigger();
  }, [onInput, detectSlashTrigger]);

  const onEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (slashMenu) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSlashMenu();
          return;
        }
        if (filteredSlashCommands.length > 0) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSlashIndex((i) => (i + 1) % filteredSlashCommands.length);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSlashIndex((i) => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
            return;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            const idx = Math.min(slashIndex, filteredSlashCommands.length - 1);
            runSlashCommand(filteredSlashCommands[idx]);
            return;
          }
        }
      }
      handleEditorKeyDown(event);
    },
    [slashMenu, filteredSlashCommands, slashIndex, runSlashCommand, closeSlashMenu, handleEditorKeyDown],
  );

  return (
    <main className="sticky-editor-pane" style={noDrag}>
      <div className="sticky-editor-paper">
        <header className="sticky-editor-header">
          <input
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Untitled"
            className="sticky-editor-title"
            aria-label="Note title"
          />
          <div className="sticky-editor-meta">{meta}</div>
        </header>

        <div className="sticky-editor-body-wrap">
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onMouseDown={handleEditorMouseDown}
            onInput={onEditorInput}
            onKeyDown={onEditorKeyDown}
            onKeyUp={() => {
              saveSelection();
              refreshActiveFormats();
            }}
            onMouseUp={() => {
              closeSlashMenu();
              saveSelection();
              refreshActiveFormats();
            }}
            onBlur={closeSlashMenu}
            onFocus={() => {
              saveSelection();
              refreshActiveFormats();
            }}
            onPaste={onPaste}
            className="sticky-editor-body"
            aria-label="Note body"
            spellCheck
          />
          {isEmpty && (
            <div className="sticky-editor-placeholder" aria-hidden="true">
              Start typing, or press <kbd className="sticky-slash-kbd">/</kbd> for commands…
            </div>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {formatsOpen && (
          <motion.div
            key="format-toolbar"
            className="sticky-format-flyout"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            style={{ ...noDrag, originX: 1, originY: 1 }}
          >
            <FormattingToolbar activeFormats={activeFormats} onFormat={handleFormat} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="sticky-bottom-controls" style={noDrag}>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setFormatsOpen((open) => {
              if (open) setFormatPopover(null);
              return !open;
            });
          }}
          className={`sticky-format-toggle ${formatsOpen ? 'is-active' : ''}`}
          title="Format"
          aria-label="Format"
          aria-expanded={formatsOpen}
        >
          <Type size={14} />
          <span>Format</span>
        </button>

        <motion.button
          type="button"
          onClick={handleCopy}
          whileTap={{ scale: 0.97 }}
          className="sticky-copy-btn"
          title="Copy note"
          aria-label="Copy note"
        >
          <Copy size={13} />
          <span>{copyFeedback ? 'Copied' : 'Copy'}</span>
        </motion.button>
      </div>

      <AnimatePresence>
        {formatPopover === 'link' && (
          <motion.div
            ref={linkPopoverRef}
            key="link-popover"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className="sticky-editor-popover"
            style={noDrag}
          >
            <label className="sticky-popover-field">
              <span>Text</span>
              <input
                ref={linkTextInputRef}
                value={linkForm.text}
                onChange={(e) => setLinkForm((p) => ({ ...p, text: e.target.value }))}
                placeholder="Link text"
              />
            </label>
            <label className="sticky-popover-field">
              <span>URL</span>
              <input
                value={linkForm.url}
                onChange={(e) => setLinkForm((p) => ({ ...p, url: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    applyLinkForm();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeFormatPopover();
                  }
                }}
                placeholder="https://example.com"
              />
            </label>
            <div className="sticky-popover-actions">
              <button type="button" onClick={closeFormatPopover} className="sticky-popover-cancel">
                Cancel
              </button>
              <button type="button" onClick={applyLinkForm} className="sticky-popover-confirm">
                Apply
              </button>
            </div>
          </motion.div>
        )}

        {formatPopover === 'table' && (
          <TablePicker
            ref={tablePickerRef}
            key="table-picker"
            onInsert={insertTable}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {slashMenu && (
          <motion.div
            key="slash-menu"
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
            className="sticky-slash-menu"
            style={{ ...noDrag, position: 'fixed', left: slashMenu.x, top: slashMenu.y }}
          >
            {filteredSlashCommands.length === 0 ? (
              <div className="sticky-slash-empty">No matching blocks</div>
            ) : (
              filteredSlashCommands.map((cmd, i) => {
                const active = i === Math.min(slashIndex, filteredSlashCommands.length - 1);
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSlashIndex(i)}
                    onClick={() => runSlashCommand(cmd)}
                    className={`sticky-slash-item ${active ? 'is-active' : ''}`}
                  >
                    <span className="sticky-slash-icon">{cmd.icon}</span>
                    <span className="sticky-slash-text">
                      <span className="sticky-slash-label">{cmd.label}</span>
                      <span className="sticky-slash-hint">{cmd.hint}</span>
                    </span>
                  </button>
                );
              })
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

type FormattingToolbarProps = {
  activeFormats: ActiveFormats;
  onFormat: (kind: 'bold' | 'italic' | 'underline' | 'code' | 'bullet' | 'number' | 'check' | 'quote' | 'indent' | 'link' | 'table') => void;
};

function FormattingToolbar({ activeFormats, onFormat }: FormattingToolbarProps) {
  return (
    <div className="sticky-format-toolbar">
      <div className="sticky-format-group">
        <FormatButton icon={<Bold size={13} />} title="Bold" active={activeFormats.bold} onClick={() => onFormat('bold')} />
        <FormatButton icon={<Italic size={13} />} title="Italic" active={activeFormats.italic} onClick={() => onFormat('italic')} />
        <FormatButton icon={<Underline size={13} />} title="Underline" active={activeFormats.underline} onClick={() => onFormat('underline')} />
        <FormatButton icon={<Code2 size={13} />} title="Code" onClick={() => onFormat('code')} />
      </div>
      <ToolbarDivider />
      <div className="sticky-format-group">
        <FormatButton icon={<List size={13} />} title="Bulleted list" onClick={() => onFormat('bullet')} />
        <FormatButton icon={<ListOrdered size={13} />} title="Numbered list" onClick={() => onFormat('number')} />
        <FormatButton icon={<ListChecks size={13} />} title="Checklist" onClick={() => onFormat('check')} />
        <FormatButton icon={<Quote size={13} />} title="Quote" onClick={() => onFormat('quote')} />
        <FormatButton icon={<ListEnd size={13} />} title="Indent" onClick={() => onFormat('indent')} />
      </div>
      <ToolbarDivider />
      <div className="sticky-format-group">
        <FormatButton icon={<LinkIcon size={13} />} title="Link" popoverTrigger onClick={() => onFormat('link')} />
        <FormatButton icon={<Table2 size={13} />} title="Table" popoverTrigger onClick={() => onFormat('table')} />
      </div>
    </div>
  );
}

function FormatButton({
  icon,
  title,
  active = false,
  popoverTrigger = false,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  active?: boolean;
  popoverTrigger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      {...(popoverTrigger ? { 'data-format-popover-trigger': true } : {})}
      className={`sticky-format-btn ${active ? 'is-active' : ''}`}
    >
      {icon}
    </button>
  );
}

function ToolbarDivider() {
  return <span className="sticky-format-divider" />;
}

const TablePicker = forwardRef<HTMLDivElement, { onInsert: (columns: number, rows: number) => void }>(
  function TablePicker({ onInsert }, ref) {
  const [size, setSize] = useState({ columns: 3, rows: 1 });
  const cells = useMemo(
    () =>
      Array.from({ length: TABLE_PICKER_ROWS }, (_, rowIndex) =>
        Array.from({ length: TABLE_PICKER_COLUMNS }, (_, columnIndex) => ({
          columns: columnIndex + 1,
          rows: rowIndex + 1,
        })),
      ).flat(),
    [],
  );

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      className="sticky-table-picker"
      style={noDrag}
    >
      <div className="sticky-table-grid">
        {cells.map(({ columns, rows }) => {
          const active = columns <= size.columns && rows <= size.rows;
          return (
            <button
              type="button"
              key={`${columns}-${rows}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSize({ columns, rows })}
              onFocus={() => setSize({ columns, rows })}
              onClick={() => onInsert(columns, rows)}
              className={`sticky-table-cell ${active ? 'is-active' : ''}`}
              aria-label={`${columns} x ${rows} table`}
            />
          );
        })}
      </div>
      <p className="sticky-table-label">
        {size.columns} × {size.rows}
      </p>
    </motion.div>
  );
});
