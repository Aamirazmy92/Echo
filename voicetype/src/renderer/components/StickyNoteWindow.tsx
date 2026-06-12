import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { Note } from '../../shared/types';
import { noteHtmlToPlainText, sanitizeNoteHtml } from '../lib/noteRichText';
import { toast } from './toast/useToast';
import NoteLockModal from './NoteLockModal';
import Titlebar from './sticky/Titlebar';
import Sidebar from './sticky/Sidebar';
import Editor from './sticky/Editor';
import { useNoteTabs } from './sticky/useNoteTabs';
import { useTabDrag } from './sticky/useTabDrag';
import { useRichTextEditor } from './sticky/useRichTextEditor';

class EditorErrorBoundary extends Component<
  { fallback: ReactNode; onError?: (error: unknown) => void; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    try {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error
        ? `${error.stack || ''}${info.componentStack ? `\n--- componentStack ---${info.componentStack}` : ''}`
        : info.componentStack || undefined;
      window.api?.reportRendererError?.('sticky-editor', message, stack);
    } catch {
      // Reporting is best-effort.
    }
    this.props.onError?.(error);
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function reportStickyError(scope: string, error: unknown) {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    window.api?.reportRendererError?.(scope, message, stack);
  } catch {
    // Reporter unavailable — fall back to console.
    console.error(`[${scope}]`, error);
  }
}

export default function StickyNoteWindow() {
  try {
    return <StickyNoteWindowInner />;
  } catch (error) {
    reportStickyError('sticky-window-render', error);
    throw error;
  }
}

function StickyNoteWindowInner() {
  const initialNoteId = useMemo(() => {
    const param = new URLSearchParams(window.location.search).get('stickyNote');
    if (!param || param === 'new') return undefined;
    const n = Number(param);
    return Number.isFinite(n) ? n : undefined;
  }, []);

  const tabsApi = useNoteTabs(initialNoteId);
  const {
    tabs,
    activeTab,
    activeTabId,
    setActiveTabId,
    filteredNotes,
    search,
    setSearch,
    getTabBody,
    updateTab,
    updateBodyDraft,
    openNoteInTab,
    addNewTab,
    closeTab,
    flushPendingSaves,
    setTabs,
    saveTabForTransfer,
    removeTabFromWindow,
    notes,
    setNotes,
    saveStatus,
    bodyDraftsRef,
  } = tabsApi;

  const tabBarRef = useRef<HTMLDivElement | null>(null);

  const tabDrag = useTabDrag({
    tabs,
    tabBarRef,
    saveTabForTransfer,
    removeTabFromWindow,
    setTabs,
  });

  const lastEditorEmittedHtmlRef = useRef('');

  const handleBodyChange = useCallback(
    (html: string) => {
      if (!activeTab) return;
      lastEditorEmittedHtmlRef.current = html;
      updateBodyDraft(activeTab.clientId, html);
    },
    [activeTab, updateBodyDraft],
  );

  const editor = useRichTextEditor(handleBodyChange);

  // Sync the editor DOM when switching tabs or when note content changes
  // externally (sidebar reopen, save from another window). Never rewrite
  // the DOM for local keystrokes — that resets the caret and causes reversed text.
  const renderedTabRef = useRef<{ clientId: string | null; body?: string }>({
    clientId: null,
  });
  useEffect(() => {
    if (!activeTab) return;
    const editorEl = editor.editorRef.current;
    if (!editorEl) return;

    const draftBody = getTabBody(activeTab);
    const normalizedDraft = sanitizeNoteHtml(draftBody);
    const tabChanged = renderedTabRef.current.clientId !== activeTab.clientId;

    if (tabChanged) {
      editor.setEditorContent(normalizedDraft);
      lastEditorEmittedHtmlRef.current = normalizedDraft;
      renderedTabRef.current = {
        clientId: activeTab.clientId,
        body: normalizedDraft,
      };
      return;
    }

    const localNormalized = sanitizeNoteHtml(lastEditorEmittedHtmlRef.current);
    const externalBodyUpdate = localNormalized !== normalizedDraft;
    if (externalBodyUpdate && editorEl.innerHTML !== normalizedDraft) {
      editor.setEditorContent(normalizedDraft);
      lastEditorEmittedHtmlRef.current = normalizedDraft;
    }

    renderedTabRef.current = {
      clientId: activeTab.clientId,
      body: normalizedDraft,
    };
  }, [activeTab, activeTabId, activeTab?.body, getTabBody, editor.setEditorContent, editor.editorRef]);

  // Re-focus the editor when switching tabs.
  useEffect(() => {
    editor.editorRef.current?.focus();
  }, [activeTabId, editor.editorRef]);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editTitleValue, setEditTitleValue] = useState('');
  const [renamingNoteId, setRenamingNoteId] = useState<number | null>(null);
  const [renamingNoteTitle, setRenamingNoteTitle] = useState('');
  const [openNoteMenuId, setOpenNoteMenuId] = useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [lockDialog, setLockDialog] = useState<{
    note: Note;
    mode: 'setup' | 'unlock' | 'remove';
  } | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);

  useEffect(() => {
    if (openNoteMenuId === null) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) {
        setOpenNoteMenuId(null);
        return;
      }
      if (target.closest('.sticky-note-row-menu') || target.closest('.sticky-note-row-menu-btn')) return;
      setOpenNoteMenuId(null);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [openNoteMenuId]);

  const startTabRename = useCallback((tab: { clientId: string; title: string }) => {
    setEditingTabId(tab.clientId);
    setEditTitleValue(tab.title || 'Untitled');
  }, []);

  const commitTabRename = useCallback(
    (clientId: string, newTitle: string) => {
      setEditingTabId(null);
      const trimmed = newTitle.trim();
      if (!trimmed) return;
      updateTab(clientId, { title: trimmed });
    },
    [updateTab],
  );

  const startNoteRename = useCallback((note: { id: number; title: string }) => {
    setOpenNoteMenuId(null);
    setRenamingNoteId(note.id);
    setRenamingNoteTitle(note.title || 'Untitled');
  }, []);

  const commitNoteRename = useCallback(
    async (noteId: number, title: string) => {
      const note = notes.find((n) => n.id === noteId);
      setRenamingNoteId(null);
      if (!note) return;
      const trimmed = title.trim();
      if (!trimmed || trimmed === note.title) return;
      try {
        const updated = await window.api.saveNote({
          id: note.id,
          title: trimmed,
          body: note.body,
        });
        setNotes((prev) =>
          prev.map((n) =>
            n.id === noteId ? { ...n, title: updated.title, updatedAt: updated.updatedAt } : n,
          ),
        );
        setTabs((prev) =>
          prev.map((tab) => (tab.noteId === noteId ? { ...tab, title: updated.title } : tab)),
        );
      } catch {
        toast.error('Could not rename note.');
      }
    },
    [notes, setNotes, setTabs],
  );

  const togglePin = useCallback(
    async (noteId: number) => {
      const note = notes.find((n) => n.id === noteId);
      if (!note) return;
      try {
        const updated = await window.api.toggleNotePin(noteId, !note.pinned);
        setNotes((prev) =>
          prev.map((n) =>
            n.id === noteId ? { ...n, pinned: updated.pinned, updatedAt: updated.updatedAt } : n,
          ),
        );
      } catch {
        toast.error('Could not update pin.');
      }
    },
    [notes, setNotes],
  );

  const mergeUpdatedNote = useCallback(
    (updated: Note) => {
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.noteId !== updated.id) return tab;
          bodyDraftsRef.current[tab.clientId] = updated.body;
          return {
            ...tab,
            title: updated.title || 'Untitled',
            body: updated.body,
            locked: updated.locked,
            lockUnlocked: updated.lockUnlocked,
          };
        }),
      );
    },
    [bodyDraftsRef, setNotes, setTabs],
  );

  const openLockDialog = useCallback((note: Note, mode: 'setup' | 'unlock' | 'remove') => {
    setOpenNoteMenuId(null);
    setLockError(null);
    setLockDialog({ note, mode });
  }, []);

  const handleRelockNote = useCallback(
    async (note: Note) => {
      try {
        const updated = await window.api.relockNote(note.id);
        if (updated) mergeUpdatedNote(updated);
        toast.success('Note locked');
      } catch {
        toast.error('Could not lock note.');
      }
    },
    [mergeUpdatedNote],
  );

  const handleLockDialogSubmit = useCallback(
    async (code: string) => {
      if (!lockDialog) return;
      setLockError(null);
      try {
        if (lockDialog.mode === 'setup') {
          const updated = await window.api.lockNote(lockDialog.note.id, code);
          mergeUpdatedNote(updated);
          setLockDialog(null);
          toast.success('Note locked');
          return;
        }

        if (lockDialog.mode === 'unlock') {
          const result = await window.api.unlockNote(lockDialog.note.id, code);
          if (!result.ok) {
            setLockError('Incorrect code.');
            return;
          }
          mergeUpdatedNote(result.note);
          setLockDialog(null);
          return;
        }

        const unlock = await window.api.unlockNote(lockDialog.note.id, code);
        if (!unlock.ok) {
          setLockError('Incorrect code.');
          return;
        }
        const updated = await window.api.removeNoteLock(lockDialog.note.id);
        mergeUpdatedNote(updated);
        setLockDialog(null);
        toast.success('Lock removed');
      } catch (error) {
        setLockError(error instanceof Error ? error.message : 'Could not update note lock.');
      }
    },
    [lockDialog, mergeUpdatedNote],
  );

  const performDeleteNote = useCallback(
    async (noteId: number) => {
      try {
        await window.api.deleteNote(noteId);
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
        setTabs((prev) => prev.filter((t) => t.noteId !== noteId));
      } catch {
        toast.error('Could not delete note.');
      }
    },
    [setNotes, setTabs],
  );

  const onTitleChange = useCallback(
    (value: string) => {
      if (!activeTab) return;
      updateTab(activeTab.clientId, { title: value });
    },
    [activeTab, updateTab],
  );

  const handleMaximize = useCallback(() => {
    window.api.toggleCurrentWindowMaximize?.();
  }, []);

  const handleCloseWindow = useCallback(() => {
    void (async () => {
      await flushPendingSaves();
      window.api.forceCloseCurrentWindow?.();
    })();
  }, [flushPendingSaves]);

  // Derived values for the editor header.
  const activeBodyPlainText = useMemo(
    () => noteHtmlToPlainText(getTabBody(activeTab)),
    [activeTab, getTabBody],
  );
  const wordCount = useMemo(() => {
    const trimmed = activeBodyPlainText.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [activeBodyPlainText]);

  const meta = useMemo(() => {
    if (!activeTab) return '';
    const note = activeTab.noteId ? notes.find((n) => n.id === activeTab.noteId) : null;
    const iso = note?.updatedAt || note?.createdAt;
    const wordLabel = `${wordCount} ${wordCount === 1 ? 'word' : 'words'}`;
    if (!iso) return wordLabel;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return wordLabel;
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
    return `${day} · ${time} · ${wordLabel}`;
  }, [activeTab, notes, wordCount]);

  const openNoteIds = useMemo(() => {
    const set = new Set<number>();
    for (const tab of tabs) if (tab.noteId !== undefined) set.add(tab.noteId);
    return set;
  }, [tabs]);

  if (!activeTab) {
    // Shouldn't happen — tabs always has at least the initial tab — but guard anyway.
    return <div className="sticky-note-viewport" />;
  }

  const titleForEditor = activeTab.title || '';

  return (
    <div className="sticky-note-viewport">
      <Titlebar
        tabs={tabs}
        activeTabId={activeTabId}
        editingTabId={editingTabId}
        editTitleValue={editTitleValue}
        setEditTitleValue={setEditTitleValue}
        setEditingTabId={setEditingTabId}
        onTabClick={(tab) => setActiveTabId(tab.clientId)}
        onTabRename={startTabRename}
        onTabClose={closeTab}
        onAddNewTab={addNewTab}
        onCommitRename={commitTabRename}
        onMaximize={handleMaximize}
        onClose={handleCloseWindow}
        draggingClientId={tabDrag.draggingClientId}
        dragOverClientId={tabDrag.dragOverClientId}
        dragPreview={tabDrag.dragPreview}
        tabBarRef={tabBarRef}
        onTabPointerDown={tabDrag.onTabPointerDown}
        recentlyDraggedRef={tabDrag.recentlyDraggedRef}
        saveStatus={saveStatus}
      />

      <div className="sticky-note-body">
        <Sidebar
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
          filteredNotes={filteredNotes}
          openNoteIds={openNoteIds}
          search={search}
          setSearch={setSearch}
          onOpenNote={openNoteInTab}
          onAddNewTab={addNewTab}
          onRenameNote={startNoteRename}
          onTogglePin={togglePin}
          onRequestDelete={(id) => setDeleteConfirmId(id)}
          renamingNoteId={renamingNoteId}
          renamingNoteTitle={renamingNoteTitle}
          setRenamingNoteTitle={setRenamingNoteTitle}
          setRenamingNoteId={setRenamingNoteId}
          onCommitRename={commitNoteRename}
          openNoteMenuId={openNoteMenuId}
          setOpenNoteMenuId={setOpenNoteMenuId}
          onLockNote={(note) => openLockDialog(note, 'setup')}
          onUnlockNote={(note) => openLockDialog(note, 'unlock')}
          onRelockNote={(note) => void handleRelockNote(note)}
          onRemoveNoteLock={(note) => openLockDialog(note, 'remove')}
        />

        <EditorErrorBoundary
          fallback={
            <main className="sticky-editor-pane">
              <div className="sticky-editor-fallback">
                <div className="sticky-editor-fallback-title">This note can&rsquo;t be displayed</div>
                <div className="sticky-editor-fallback-desc">
                  The note couldn&rsquo;t be opened safely. Switch to a different note from the sidebar, or
                  close this tab and start a new one.
                </div>
              </div>
            </main>
          }
          onError={(error) => {
            // Reset the rendered ref so re-opening the tab triggers a fresh load.
            renderedTabRef.current = { clientId: null };
            reportStickyError('sticky-editor-boundary', error);
          }}
        >
          <Editor
            editor={editor}
            title={titleForEditor}
            onTitleChange={onTitleChange}
            wordCount={wordCount}
            meta={meta}
          />
        </EditorErrorBoundary>
      </div>

      {deleteConfirmId !== null && (
        <div className="sticky-delete-overlay" onClick={() => setDeleteConfirmId(null)}>
          <div className="sticky-delete-modal" onClick={(event) => event.stopPropagation()}>
            <p className="sticky-delete-title">Delete this note?</p>
            <p className="sticky-delete-desc">This cannot be undone.</p>
            <div className="sticky-delete-actions">
              <button
                type="button"
                className="sticky-delete-cancel"
                onClick={() => setDeleteConfirmId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="sticky-delete-confirm"
                onClick={() => {
                  void performDeleteNote(deleteConfirmId);
                  setDeleteConfirmId(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <NoteLockModal
        open={lockDialog !== null}
        mode={lockDialog?.mode ?? 'unlock'}
        noteTitle={lockDialog?.note.title ?? ''}
        error={lockError}
        onSubmit={handleLockDialogSubmit}
        onClose={() => {
          setLockDialog(null);
          setLockError(null);
        }}
      />
    </div>
  );
}
