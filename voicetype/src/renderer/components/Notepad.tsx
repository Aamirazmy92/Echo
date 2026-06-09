import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Search, Plus, Pencil, Trash2, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import { toast } from './toast/useToast';
import type { Note } from '../../shared/types';
import ConfirmationModal from './ConfirmationModal';
import { noteHtmlToPlainText, sanitizeNoteHtml } from '../lib/noteRichText';
import { normalizeLinkUrl } from './sticky/useRichTextEditor';
import { rowActionsClassName } from '../lib/rowActions';

function parseNoteDate(value: string): Date | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function formatNoteListDate(value: string): string {
  const date = parseNoteDate(value);
  if (!date) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfNoteDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfNoteDay) / 86_400_000);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  if (dayDiff === 0) return `Today · ${time}`;
  if (dayDiff === 1) return `Yesterday · ${time}`;
  if (dayDiff < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} · ${time}`;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatNoteHeaderMeta(value: string, wordCount: number): string {
  const date = parseNoteDate(value);
  if (!date) return `${wordCount} words`;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfNoteDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfNoteDay) / 86_400_000);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  let day: string;
  if (dayDiff === 0) day = 'Today';
  else if (dayDiff === 1) day = 'Yesterday';
  else if (dayDiff < 7) day = date.toLocaleDateString(undefined, { weekday: 'long' });
  else day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return `${day} · ${time} · ${wordCount} ${wordCount === 1 ? 'word' : 'words'} · dictated`;
}

function wordCountFromHtml(html: string): number {
  const text = noteHtmlToPlainText(html).trim();
  if (!text) return 0;
  return text.split(/\s+/).length;
}

export default function NotepadView() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Note | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Close the row menu when clicking outside the menu or its trigger button.
  useEffect(() => {
    if (openMenuId === null) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) {
        setOpenMenuId(null);
        return;
      }
      if (target.closest('.echo-note-menu') || target.closest('.echo-note-menu-btn')) return;
      setOpenMenuId(null);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [openMenuId]);

  const load = useCallback(async () => {
    const data = await window.api.getNotes();
    setNotes(data);
    if (data.length > 0) {
      setSelectedId((current) => {
        if (current !== null && data.some((n) => n.id === current)) return current;
        return data[0].id;
      });
    } else {
      setSelectedId(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const off = window.api.onNotesUpdated?.(() => {
      void load();
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? notes.filter(
          (n) =>
            n.title.toLowerCase().includes(q) ||
            noteHtmlToPlainText(n.body).toLowerCase().includes(q),
        )
      : notes;
    // Stable sort: pinned notes first, then preserve incoming order
    // (already sorted by updated/created on the backend).
    return [...matched].sort((a, b) => {
      if (a.pinned === b.pinned) return 0;
      return a.pinned ? -1 : 1;
    });
  }, [notes, search]);

  const selectedNote = useMemo(
    () => filtered.find((n) => n.id === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  const openNote = (note?: Note) => {
    void window.api.openStickyNoteWindow(note?.id);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await window.api.deleteNote(deleteTarget.id);
      toast.success('Note deleted');
      if (selectedId === deleteTarget.id) setSelectedId(null);
      await load();
    } catch {
      toast.error('Could not delete note.');
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleTogglePin = async (note: Note) => {
    try {
      const updated = await window.api.toggleNotePin(note.id, !note.pinned);
      setNotes((prev) =>
        prev.map((n) =>
          n.id === note.id ? { ...n, pinned: updated.pinned, updatedAt: updated.updatedAt } : n,
        ),
      );
    } catch {
      toast.error(note.pinned ? 'Could not unpin note.' : 'Could not pin note.');
    }
  };

  const startRename = (note: Note) => {
    setRenamingId(note.id);
    setRenameDraft(note.title || 'Untitled');
  };

  const commitRename = async (note: Note) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next || next === note.title) return;
    try {
      const saved = await window.api.saveNote({
        id: note.id,
        title: next,
        body: note.body,
      });
      setNotes((prev) =>
        prev.map((n) =>
          n.id === note.id ? { ...n, title: saved.title, updatedAt: saved.updatedAt } : n,
        ),
      );
    } catch {
      toast.error('Could not rename note.');
    }
  };

  const renderedBody = useMemo(() => {
    if (!selectedNote) return '';
    return sanitizeNoteHtml(selectedNote.body);
  }, [selectedNote]);

  const handleReaderLinkActivation = useCallback(async (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    const element =
      target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
    const anchor = element?.closest('a');
    if (!(anchor instanceof HTMLAnchorElement)) return;

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
      } catch {
        window.api.reportRendererError?.(
          'notepad-open-link',
          error instanceof Error ? error.message : 'Could not open link',
          error instanceof Error ? error.stack : undefined,
        );
        toast.error('Could not open this link.');
      }
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Middle column — notes list */}
      <aside
        className="flex h-full min-h-0 shrink-0 flex-col"
        style={{
          width: 280,
          borderRight: '1px solid var(--line-soft)',
          background: 'transparent',
        }}
      >
        <div className="echo-note-list-head">
          <span
            style={{
              fontSize: 11,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--ink-muted)',
              fontWeight: 500,
            }}
          >
            Notepad
          </span>
          <button
            type="button"
            onClick={() => openNote()}
            className="echo-icon-btn plain"
            style={{ width: 28, height: 28 }}
            title="New note"
            aria-label="New note"
          >
            <Plus size={15} />
          </button>
        </div>

        <div style={{ padding: '4px 14px 12px' }}>
          <div className="echo-search" style={{ minWidth: 0, width: '100%' }}>
            <Search size={13} style={{ color: 'var(--ink-muted)' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search notes…"
              style={{ fontSize: 12.5 }}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div
              style={{
                padding: '40px 18px',
                textAlign: 'center',
                color: 'var(--ink-muted)',
                fontSize: 13,
              }}
            >
              {search ? 'No notes match.' : 'No notes yet.'}
            </div>
          ) : (
            <div>
              {filtered.map((note) => {
                const preview = noteHtmlToPlainText(note.body);
                const isActive = selectedNote?.id === note.id;
                const isMenuOpen = openMenuId === note.id;
                const isRenaming = renamingId === note.id;
                return (
                  <div
                    key={note.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (isRenaming) return;
                      setSelectedId(note.id);
                      setOpenMenuId(null);
                      openNote(note);
                    }}
                    onKeyDown={(e) => {
                      if (isRenaming) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedId(note.id);
                        setOpenMenuId(null);
                        openNote(note);
                      }
                    }}
                    className={`echo-note-item ${isActive ? 'active' : ''}`}
                    style={{ position: 'relative' }}
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => void commitRename(note)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') void commitRename(note);
                          else if (e.key === 'Escape') setRenamingId(null);
                        }}
                        className="echo-note-rename-input"
                      />
                    ) : (
                      <div
                        className="t"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          paddingRight: 24,
                        }}
                      >
                        {note.pinned && (
                          <Pin
                            size={11}
                            style={{ flexShrink: 0, color: 'var(--clay)', fill: 'var(--clay)' }}
                            aria-label="Pinned"
                          />
                        )}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {note.title || 'Untitled'}
                        </span>
                      </div>
                    )}
                    <div className="p">{preview || ' '}</div>
                    <div className="when">{formatNoteListDate(note.updatedAt || note.createdAt)}</div>

                    <button
                      type="button"
                      aria-label="Note options"
                      aria-expanded={isMenuOpen}
                      className={`echo-note-menu-btn ${isMenuOpen ? 'is-open' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(isMenuOpen ? null : note.id);
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </button>

                    {isMenuOpen && (
                      <div
                        className="echo-note-menu"
                        role="menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setOpenMenuId(null);
                            startRename(note);
                          }}
                        >
                          <Pencil size={12} />
                          Rename
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setOpenMenuId(null);
                            void handleTogglePin(note);
                          }}
                        >
                          {note.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                          {note.pinned ? 'Unpin' : 'Pin'}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="is-danger"
                          onClick={() => {
                            setOpenMenuId(null);
                            setDeleteTarget(note);
                          }}
                        >
                          <Trash2 size={12} />
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* Right column — note reader */}
      <section className="relative flex h-full min-h-0 flex-1 flex-col overflow-y-auto">
        {selectedNote ? (
          <div style={{ padding: '36px 56px 56px', maxWidth: 820 }}>
            <div className="group flex items-start justify-between gap-6">
              <h1
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 30,
                  lineHeight: 1.15,
                  letterSpacing: '-0.015em',
                  fontWeight: 400,
                  color: 'var(--ink)',
                  margin: 0,
                }}
              >
                {selectedNote.title || 'Untitled'}
              </h1>
              <div className={rowActionsClassName(deleteTarget?.id === selectedNote.id)}>
                <button
                  type="button"
                  title="Edit note"
                  onClick={() => openNote(selectedNote)}
                  className="echo-icon-btn plain"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  title="Delete note"
                  onClick={() => setDeleteTarget(selectedNote)}
                  className="echo-icon-btn plain"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <div
              style={{
                marginTop: 8,
                fontSize: 13,
                color: 'var(--ink-muted)',
              }}
            >
              {formatNoteHeaderMeta(
                selectedNote.updatedAt || selectedNote.createdAt,
                wordCountFromHtml(selectedNote.body),
              )}
            </div>
            <div
              className="echo-note-reader"
              onClick={handleReaderLinkActivation}
              style={{
                marginTop: 28,
                fontFamily: 'var(--font-display)',
                fontSize: 17,
                lineHeight: 1.7,
                color: 'var(--ink-2)',
              }}
              dangerouslySetInnerHTML={{ __html: renderedBody }}
            />
          </div>
        ) : (
          <div
            style={{
              padding: '120px 60px',
              textAlign: 'center',
              color: 'var(--ink-muted)',
              fontSize: 14,
            }}
          >
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--ink)', marginBottom: 8 }}>
              No note selected
            </div>
            <div>Pick a note on the left, or press <span style={{ color: 'var(--ink)' }}>+</span> to start a new one.</div>
          </div>
        )}
      </section>

      <ConfirmationModal
        open={deleteTarget !== null}
        title="Delete this note?"
        description="This note will be permanently removed. This cannot be undone."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
