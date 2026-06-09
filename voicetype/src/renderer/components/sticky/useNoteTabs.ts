import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Note } from '../../../shared/types';
import {
  noteHtmlHasMeaningfulContent,
  noteHtmlToPlainText,
  sanitizeNoteHtml,
} from '../../lib/noteRichText';
import { toast } from '../toast/useToast';

export type Tab = {
  clientId: string;
  noteId?: number;
  title: string;
  body: string;
};

export type AttachedNotePayload = {
  noteId?: number;
  title: string;
  body: string;
  // Set when the note was dragged in from another window — it should always
  // become its own tab rather than replacing a blank placeholder tab.
  keepAsNewTab?: boolean;
};

export type SaveStatus = 'idle' | 'saving' | 'saved';

export function newClientId(): string {
  return `tab-${Math.random().toString(36).slice(2, 9)}`;
}

const SAVE_DEBOUNCE_MS = 700;

export function useNoteTabs(initialNoteId: number | undefined) {
  const initialTabId = useMemo(() => newClientId(), []);
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { clientId: initialTabId, noteId: initialNoteId, title: 'Untitled', body: '' },
  ]);
  const [activeTabId, setActiveTabId] = useState(initialTabId);
  const [notes, setNotes] = useState<Note[]>([]);
  const [search, setSearch] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const bodyDraftsRef = useRef<Record<string, string>>({});
  const noteIdsRef = useRef<Record<string, number | undefined>>({});
  const saveQueuesRef = useRef<Record<string, Promise<void>>>({});

  const activeTab = useMemo(
    () => tabs.find((t) => t.clientId === activeTabId) ?? tabs[0],
    [tabs, activeTabId],
  );

  const getTabBody = useCallback((tab: Tab | undefined) => {
    if (!tab) return '';
    return bodyDraftsRef.current[tab.clientId] ?? tab.body;
  }, []);

  useEffect(() => {
    const next: Record<string, number | undefined> = {};
    for (const tab of tabs) {
      next[tab.clientId] = tab.noteId ?? noteIdsRef.current[tab.clientId];
    }
    noteIdsRef.current = next;
  }, [tabs]);

  const persist = useCallback(
    async (clientId: string, title: string, body: string, noteId?: number) => {
      const previousSave = saveQueuesRef.current[clientId] ?? Promise.resolve();
      const save = previousSave
        .catch(() => undefined)
        .then(async () => {
          const cleanBody = sanitizeNoteHtml(body);
          const resolvedNoteId = noteId ?? noteIdsRef.current[clientId];
          if (!resolvedNoteId && !noteHtmlHasMeaningfulContent(cleanBody)) {
            setSaveStatus('idle');
            return;
          }
          setSaveStatus('saving');
          try {
            const saved = await window.api.saveNote({
              id: resolvedNoteId,
              title: title.trim() || 'Untitled',
              body: cleanBody,
            });
            const currentDraft = bodyDraftsRef.current[clientId];
            const hasNewerDraft = currentDraft !== undefined && currentDraft !== body;
            noteIdsRef.current[clientId] = saved.id;
            if (!hasNewerDraft) {
              bodyDraftsRef.current[clientId] = saved.body;
            }
            setTabs((prev) =>
              prev.map((t) =>
                t.clientId === clientId
                  ? { ...t, noteId: saved.id, title: saved.title, body: hasNewerDraft ? t.body : saved.body }
                  : t,
              ),
            );
            setSaveStatus('saved');
          } catch {
            setSaveStatus('idle');
            toast.error('Could not save note.');
          }
        });

      saveQueuesRef.current[clientId] = save;
      await save.finally(() => {
        if (saveQueuesRef.current[clientId] === save) {
          delete saveQueuesRef.current[clientId];
        }
      });
    },
    [],
  );

  const scheduleSave = useCallback(
    (tab: Tab) => {
      setSaveStatus('saving');
      const existing = saveTimers.current[tab.clientId];
      if (existing) clearTimeout(existing);
      saveTimers.current[tab.clientId] = setTimeout(() => {
        delete saveTimers.current[tab.clientId];
        void persist(tab.clientId, tab.title, tab.body, tab.noteId);
      }, SAVE_DEBOUNCE_MS);
    },
    [persist],
  );

  const flushPendingSaves = useCallback(async () => {
    const writes = Object.entries(saveTimers.current).map(([clientId, timer]) => {
      clearTimeout(timer);
      delete saveTimers.current[clientId];
      const tab = tabs.find((t) => t.clientId === clientId);
      return tab
        ? persist(tab.clientId, tab.title, getTabBody(tab), tab.noteId)
        : Promise.resolve();
    });
    await Promise.allSettled(writes);
  }, [tabs, getTabBody, persist]);

  const updateTab = useCallback(
    (clientId: string, patch: Partial<Tab>) => {
      setTabs((prev) => {
        const next = prev.map((t) => (t.clientId === clientId ? { ...t, ...patch } : t));
        const updated = next.find((t) => t.clientId === clientId);
        if (updated) scheduleSave({ ...updated, body: getTabBody(updated) });
        return next;
      });
    },
    [getTabBody, scheduleSave],
  );

  const openNoteInTab = useCallback((note: Note) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.noteId === note.id);
      if (existing) {
        setActiveTabId(existing.clientId);
        bodyDraftsRef.current[existing.clientId] = note.body;
        return prev.map((t) =>
          t.clientId === existing.clientId
            ? { ...t, title: note.title || 'Untitled', body: note.body }
            : t,
        );
      }
      const id = newClientId();
      setActiveTabId(id);
      bodyDraftsRef.current[id] = note.body;
      return [
        ...prev,
        { clientId: id, noteId: note.id, title: note.title || 'Untitled', body: note.body },
      ];
    });
  }, []);

  const attachNoteInTab = useCallback((note: AttachedNotePayload) => {
    setTabs((prev) => {
      if (note.noteId !== undefined) {
        const existing = prev.find((t) => t.noteId === note.noteId);
        if (existing) {
          setActiveTabId(existing.clientId);
          bodyDraftsRef.current[existing.clientId] = note.body;
          return prev.map((t) =>
            t.clientId === existing.clientId
              ? { ...t, title: note.title || 'Untitled', body: note.body, noteId: note.noteId }
              : t,
          );
        }
      }

      const soleTab = prev.length === 1 ? prev[0] : null;
      const soleBody = soleTab ? bodyDraftsRef.current[soleTab.clientId] ?? soleTab.body : '';
      const soleTabIsBlank =
        soleTab &&
        !soleTab.noteId &&
        !noteHtmlHasMeaningfulContent(soleBody) &&
        (soleTab.title.trim() === '' || soleTab.title.trim() === 'Untitled');

      // A tab dragged in from another window always becomes its own tab so the
      // user keeps both tabs, even when the target only had a blank placeholder.
      if (soleTabIsBlank && soleTab && !note.keepAsNewTab) {
        setActiveTabId(soleTab.clientId);
        bodyDraftsRef.current[soleTab.clientId] = note.body;
        return [
          {
            ...soleTab,
            noteId: note.noteId,
            title: note.title || 'Untitled',
            body: note.body,
          },
        ];
      }

      const id = newClientId();
      setActiveTabId(id);
      bodyDraftsRef.current[id] = note.body;
      return [
        ...prev,
        { clientId: id, noteId: note.noteId, title: note.title || 'Untitled', body: note.body },
      ];
    });
  }, []);

  const addNewTab = useCallback(() => {
    const id = newClientId();
    setTabs((prev) => [...prev, { clientId: id, title: 'Untitled', body: '' }]);
    setActiveTabId(id);
  }, []);

  const removeTabFromWindow = useCallback((clientId: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.clientId !== clientId);
      if (next.length === 0) {
        // Last tab closed → close the window after pending saves flush.
        setTimeout(async () => {
          await Promise.allSettled(
            Object.entries(saveTimers.current).map(([cid, timer]) => {
              clearTimeout(timer);
              delete saveTimers.current[cid];
              return Promise.resolve();
            }),
          );
          window.api.forceCloseCurrentWindow?.();
        }, 0);
        return prev;
      }
      setActiveTabId((current) =>
        current === clientId ? next[next.length - 1].clientId : current,
      );
      return next;
    });
    delete bodyDraftsRef.current[clientId];
  }, []);

  const closeTab = useCallback(
    (clientId: string) => {
      const pendingTimer = saveTimers.current[clientId];
      const tab = tabs.find((t) => t.clientId === clientId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        delete saveTimers.current[clientId];
      }

      const body = getTabBody(tab);
      if (tab && (tab.noteId || noteHtmlHasMeaningfulContent(body))) {
        void persist(tab.clientId, tab.title, body, tab.noteId).finally(() => {
          removeTabFromWindow(clientId);
        });
        return;
      }
      removeTabFromWindow(clientId);
    },
    [tabs, getTabBody, persist, removeTabFromWindow],
  );

  const saveTabForTransfer = useCallback(
    async (tab: Tab): Promise<AttachedNotePayload> => {
      const pendingTimer = saveTimers.current[tab.clientId];
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        delete saveTimers.current[tab.clientId];
      }
      const body = getTabBody(tab);
      if (!tab.noteId && !noteHtmlHasMeaningfulContent(body)) {
        return { noteId: tab.noteId, title: tab.title.trim() || 'Untitled', body };
      }
      const saved = await window.api.saveNote({
        id: tab.noteId,
        title: tab.title.trim() || 'Untitled',
        body: sanitizeNoteHtml(body),
      });
      bodyDraftsRef.current[tab.clientId] = saved.body;
      return { noteId: saved.id, title: saved.title || 'Untitled', body: saved.body };
    },
    [getTabBody],
  );

  const refreshNotes = useCallback(async () => {
    try {
      const list = await window.api.getNotes();
      setNotes(list);
    } catch {
      // Notes list is best-effort; editor stays usable without it.
    }
  }, []);

  // ── IPC subscriptions ────────────────────────────────────────────────
  useEffect(() => {
    void refreshNotes();
    const off = window.api.onNotesUpdated?.(() => {
      void refreshNotes();
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [refreshNotes]);

  // Load initial note (when window opens with ?stickyNote=<id>).
  useEffect(() => {
    if (initialNoteId === undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await window.api.getNotes();
        const note = list.find((n) => n.id === initialNoteId);
        if (cancelled || !note) return;
        setTabs((prev) =>
          prev.map((t, i) =>
            i === 0
              ? { ...t, noteId: note.id, title: note.title || 'Untitled', body: note.body }
              : t,
          ),
        );
        bodyDraftsRef.current[initialTabId] = note.body;
      } catch {
        // Keep the blank tab if the saved note cannot be read.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialNoteId, initialTabId]);

  useEffect(() => {
    const off = window.api.onOpenNoteInSticky?.((note: Note) => {
      openNoteInTab(note);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [openNoteInTab]);

  useEffect(() => {
    const off = window.api.onAttachNoteInSticky?.((note) => {
      attachNoteInTab(note);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [attachNoteInTab]);

  useEffect(() => {
    const off = window.api.onNewBlankTabInSticky?.(() => {
      addNewTab();
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [addNewTab]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      void flushPendingSaves();
    };
    const handleBlur = () => {
      void flushPendingSaves();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('blur', handleBlur);
    };
  }, [flushPendingSaves]);

  const filteredNotes = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? notes.filter(
          (n) =>
            n.title.toLowerCase().includes(q) ||
            noteHtmlToPlainText(n.body).toLowerCase().includes(q),
        )
      : [...notes];
    list.sort((a, b) => {
      const aPinned = a.pinned ? 1 : 0;
      const bPinned = b.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return list;
  }, [notes, search]);

  const updateBodyDraft = useCallback(
    (clientId: string, body: string) => {
      bodyDraftsRef.current[clientId] = body;
      const tab = tabs.find((t) => t.clientId === clientId);
      if (tab) scheduleSave({ ...tab, body });
    },
    [tabs, scheduleSave],
  );

  return {
    initialTabId,
    tabs,
    setTabs,
    activeTab,
    activeTabId,
    setActiveTabId,
    notes,
    setNotes,
    search,
    setSearch,
    saveStatus,
    filteredNotes,
    bodyDraftsRef,
    getTabBody,
    updateTab,
    updateBodyDraft,
    openNoteInTab,
    attachNoteInTab,
    addNewTab,
    closeTab,
    removeTabFromWindow,
    saveTabForTransfer,
    flushPendingSaves,
    refreshNotes,
  };
}

export type UseNoteTabsReturn = ReturnType<typeof useNoteTabs>;
