import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import {
  MoreHorizontal,
  LockKeyhole,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  Plus,
  Search,
  Trash2,
  UnlockKeyhole,
} from 'lucide-react';
import type { Note } from '../../../shared/types';
import { noteHtmlToPlainText } from '../../lib/noteRichText';

type SidebarProps = {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  filteredNotes: Note[];
  openNoteIds: Set<number>;
  search: string;
  setSearch: (value: string) => void;
  onOpenNote: (note: Note) => void;
  onAddNewTab: () => void;
  onRenameNote: (note: Note) => void;
  onTogglePin: (id: number) => void;
  onLockNote: (note: Note) => void;
  onUnlockNote: (note: Note) => void;
  onRelockNote: (note: Note) => void;
  onRemoveNoteLock: (note: Note) => void;
  onRequestDelete: (id: number) => void;
  renamingNoteId: number | null;
  renamingNoteTitle: string;
  setRenamingNoteTitle: (v: string) => void;
  setRenamingNoteId: (id: number | null) => void;
  onCommitRename: (id: number, title: string) => void;
  openNoteMenuId: number | null;
  setOpenNoteMenuId: (id: number | null) => void;
};

const noDrag: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export default function Sidebar({
  collapsed,
  setCollapsed,
  filteredNotes,
  openNoteIds,
  search,
  setSearch,
  onOpenNote,
  onAddNewTab,
  onRenameNote,
  onTogglePin,
  onLockNote,
  onUnlockNote,
  onRelockNote,
  onRemoveNoteLock,
  onRequestDelete,
  renamingNoteId,
  renamingNoteTitle,
  setRenamingNoteTitle,
  setRenamingNoteId,
  onCommitRename,
  openNoteMenuId,
  setOpenNoteMenuId,
}: SidebarProps) {
  if (collapsed) {
    return (
      <aside className="sticky-sidebar is-collapsed">
        <button
          type="button"
          className="sticky-sidebar-icon-btn"
          style={noDrag}
          onClick={() => setCollapsed(false)}
          aria-label="Expand notes"
          title="Expand notes"
        >
          <PanelLeftOpen size={15} />
        </button>
        <button
          type="button"
          className="sticky-sidebar-icon-btn"
          style={noDrag}
          onClick={onAddNewTab}
          aria-label="New note"
          title="New note"
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          className="sticky-sidebar-icon-btn"
          style={noDrag}
          onClick={() => setCollapsed(false)}
          aria-label="Search notes"
          title="Search notes"
        >
          <Search size={15} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sticky-sidebar">
      <div className="sticky-sidebar-head">
        <button
          type="button"
          className="sticky-sidebar-collapse"
          style={noDrag}
          onClick={() => setCollapsed(true)}
          aria-label="Collapse notes"
          title="Collapse notes"
        >
          <PanelLeftClose size={14} />
        </button>
        <span className="sticky-sidebar-heading">Notes</span>
      </div>

      <div className="sticky-sidebar-search" style={noDrag}>
        <Search size={12} className="sticky-sidebar-search-icon" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          aria-label="Search notes"
        />
      </div>

      <div className="sticky-sidebar-list">
        {filteredNotes.length === 0 ? (
          <div className="sticky-sidebar-empty">
            <span className="sticky-sidebar-empty-icon">
              <Search size={16} />
            </span>
            {search ? (
              <>
                <span className="sticky-sidebar-empty-title">No matches</span>
                <span className="sticky-sidebar-empty-hint">Try a different search.</span>
              </>
            ) : (
              <>
                <span className="sticky-sidebar-empty-title">No notes yet</span>
                <span className="sticky-sidebar-empty-hint">Your saved notes appear here.</span>
                <button
                  type="button"
                  className="sticky-sidebar-empty-action"
                  style={noDrag}
                  onClick={onAddNewTab}
                >
                  <Plus size={13} />
                  New note
                </button>
              </>
            )}
          </div>
        ) : (
          filteredNotes.map((note) => {
            const isOpen = openNoteIds.has(note.id);
            const isPinned = note.pinned;
            const isLockedClosed = note.locked && !note.lockUnlocked;
            const preview = isLockedClosed ? 'Locked' : noteHtmlToPlainText(note.body).slice(0, 90);
            return (
              <div
                key={note.id}
                className={`sticky-note-row ${isOpen ? 'is-open' : ''}`}
                style={noDrag}
              >
                {renamingNoteId === note.id ? (
                  <input
                    autoFocus
                    value={renamingNoteTitle}
                    onChange={(e) => setRenamingNoteTitle(e.target.value)}
                    onBlur={() => void onCommitRename(note.id, renamingNoteTitle)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void onCommitRename(note.id, renamingNoteTitle);
                      else if (e.key === 'Escape') setRenamingNoteId(null);
                    }}
                    className="sticky-note-row-rename"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenNote(note)}
                    className="sticky-note-row-body"
                  >
                    <span className="sticky-note-row-title">
                      {isPinned && <Pin size={9} className="sticky-note-row-pin" />}
                      {note.locked && <LockKeyhole size={9} className="sticky-note-row-lock" />}
                      <span className="truncate">{note.title || 'Untitled'}</span>
                    </span>
                    <span className="sticky-note-row-preview">{preview || 'No content'}</span>
                    <span className="sticky-note-row-when">
                      {formatRelative(note.updatedAt || note.createdAt)}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenNoteMenuId(openNoteMenuId === note.id ? null : note.id);
                  }}
                  className="sticky-note-row-menu-btn"
                  aria-label="Note options"
                  aria-expanded={openNoteMenuId === note.id}
                >
                  <MoreHorizontal size={13} />
                </button>

                {openNoteMenuId === note.id && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.12, ease: 'easeOut' }}
                    className="sticky-note-row-menu"
                  >
                    <button type="button" onClick={() => onRenameNote(note)}>
                      <Pencil size={12} />
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenNoteMenuId(null);
                        onTogglePin(note.id);
                      }}
                    >
                      <Pin size={12} className={isPinned ? 'sticky-note-row-pin' : ''} />
                      {isPinned ? 'Unpin' : 'Pin'}
                    </button>
                    {!note.locked && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpenNoteMenuId(null);
                          onLockNote(note);
                        }}
                      >
                        <LockKeyhole size={12} />
                        Lock
                      </button>
                    )}
                    {note.locked && !note.lockUnlocked && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpenNoteMenuId(null);
                          onUnlockNote(note);
                        }}
                      >
                        <UnlockKeyhole size={12} />
                        Unlock
                      </button>
                    )}
                    {note.locked && note.lockUnlocked && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenNoteMenuId(null);
                            onRelockNote(note);
                          }}
                        >
                          <LockKeyhole size={12} />
                          Lock now
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenNoteMenuId(null);
                            onRemoveNoteLock(note);
                          }}
                        >
                          <UnlockKeyhole size={12} />
                          Remove lock
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => {
                        setOpenNoteMenuId(null);
                        onRequestDelete(note.id);
                      }}
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </motion.div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfNoteDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfNoteDay) / 86_400_000);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
