import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowUpDown, Check, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { DictionaryItem, DictionaryItemInput } from '../../shared/types';
import ConfirmationModal from './ConfirmationModal';
import { Dialog, DialogContent } from './ui/dialog';
import { Popover, PopoverContent } from './ui/popover';
import { toast } from './toast/useToast';
import { rowActionsClassName } from '../lib/rowActions';

type DictionaryScope = 'all' | 'personal';
type SortMode = 'newest' | 'oldest' | 'alphabetical';
type EditorMode = 'create' | 'edit';

type DictionaryDraft = DictionaryItemInput & {
  editKind: 'word' | 'replacement';
};

const emptyDraft: DictionaryDraft = {
  phrase: '',
  misspelling: '',
  correctMisspelling: false,
  shared: false,
  editKind: 'word',
};

const SORT_OPTIONS: Array<{ id: SortMode; label: string }> = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'alphabetical', label: 'Alphabetical (A-Z)' },
];

const SORT_LABELS: Record<SortMode, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  alphabetical: 'Alphabetical',
};

function formatRelativeFromNow(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export default function HistoryView() {
  const [items, setItems] = useState<DictionaryItem[]>([]);
  const [scope, setScope] = useState<DictionaryScope>('all');
  const [sortMode, setSortMode] = useState<SortMode>('alphabetical');
  const [search, setSearch] = useState('');
  const [editorMode, setEditorMode] = useState<EditorMode>('create');
  const [draft, setDraft] = useState<DictionaryDraft>(emptyDraft);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSortOpen, setIsSortOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DictionaryItem | null>(null);
  const [lastLoadAt, setLastLoadAt] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());

  const load = async () => {
    const data = await window.api.getDictionaryItems();
    setItems(data);
    setLastLoadAt(Date.now());
  };

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const lastSyncLabel = formatRelativeFromNow(lastLoadAt, now);

  useEffect(() => {
    void load();
    const offSynced = window.api.onSyncedDataUpdated?.(({ tables }) => {
      if (tables.includes('dictionary')) void load();
    });
    const offCleared = window.api.onLocalDataCleared?.(() => {
      void load();
    });
    return () => {
      if (typeof offSynced === 'function') offSynced();
      if (typeof offCleared === 'function') offCleared();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isModalOpen) {
          closeModal();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen]);

  const visibleItems = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (scope === 'personal' && item.shared) return false;
      if (!normalizedSearch) return true;

      const left = item.misspelling?.toLowerCase() ?? '';
      const right = item.phrase.toLowerCase();
      return left.includes(normalizedSearch) || right.includes(normalizedSearch);
    });

    return filtered.sort((left, right) => {
      if (sortMode === 'alphabetical') {
        const leftLabel = left.misspelling?.trim() || left.phrase;
        const rightLabel = right.misspelling?.trim() || right.phrase;
        return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: 'base' });
      }

      const leftTime = Date.parse(left.createdAt || '') || 0;
      const rightTime = Date.parse(right.createdAt || '') || 0;
      return sortMode === 'newest' ? rightTime - leftTime : leftTime - rightTime;
    });
  }, [items, scope, search, sortMode]);

  const openCreate = () => {
    setEditorMode('create');
    setDraft(emptyDraft);
    setIsModalOpen(true);
  };

  const openEdit = (item: DictionaryItem) => {
    const isReplacement = Boolean(item.correctMisspelling && item.misspelling?.trim());
    setEditorMode('edit');
    setDraft({
      id: item.id,
      phrase: item.phrase,
      misspelling: item.misspelling ?? '',
      correctMisspelling: isReplacement,
      shared: false,
      editKind: isReplacement ? 'replacement' : 'word',
    });
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setDraft(emptyDraft);
    setEditorMode('create');
    setIsModalOpen(false);
  };

  const saveItem = async (event: React.FormEvent) => {
    event.preventDefault();

    const isReplacement = draft.editKind === 'replacement' || draft.correctMisspelling;
    const phrase = draft.phrase.trim();
    const misspelling = draft.misspelling?.trim() ?? '';

    if (!phrase) return;
    if (isReplacement && !misspelling) return;

    // Build the user-visible label for the toast. Replacement entries
    // show the "misspelling → phrase" mapping so users immediately see
    // which rule was saved; plain word entries just show the phrase.
    const label = isReplacement ? `${misspelling} → ${phrase}` : phrase;
    const isEditing = editorMode === 'edit';

    try {
      await window.api.saveDictionaryItem({
        id: draft.id,
        phrase,
        misspelling: isReplacement ? misspelling : null,
        correctMisspelling: isReplacement,
        shared: false,
      });
      toast.success(`"${label}" ${isEditing ? 'updated' : 'added successfully'}`);
      closeModal();
      await load();
    } catch (err) {
      console.error('Failed to save dictionary item:', err);
      toast.error(`Could not save "${label}". Try again.`);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const label = deleteTarget.misspelling?.trim()
      ? `${deleteTarget.misspelling} → ${deleteTarget.phrase}`
      : deleteTarget.phrase;
    try {
      await window.api.deleteDictionaryItem(deleteTarget.id);
      toast.success(`"${label}" removed`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      console.error('Failed to delete dictionary item:', err);
      toast.error(`Could not delete "${label}".`);
      setDeleteTarget(null);
    }
  };

  const isReplacementDraft = draft.editKind === 'replacement' || draft.correctMisspelling;

  const personalCount = items.filter((i) => !i.shared).length;

  return (
    <div className="echo-pane-inner static-click-buttons">
      {/* Pane header — serif title + lede, primary action on the right. */}
      <div style={{ marginBottom: 28 }}>
        <div
          className="flex items-start justify-between gap-6"
        >
          <div style={{ maxWidth: 560 }}>
            <h1 className="echo-h-page">Personal dictionary</h1>
            <p className="echo-lede" style={{ marginTop: 12, marginBottom: 0 }}>
              Teach Echo the words that matter to you — names, product terms, spellings.
              Echo quietly corrects them while you talk.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="echo-btn echo-btn-dark"
          >
            <Plus size={14} /> Add word
          </button>
        </div>
      </div>

      {/* Tabs + Toolbar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 8,
          marginBottom: 16,
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div className="echo-tabs">
          <button
            type="button"
            className={scope === 'all' ? 'active' : ''}
            onClick={() => setScope('all')}
          >
            All <span style={{ color: 'var(--ink-muted)', marginLeft: 4 }}>· {items.length}</span>
          </button>
          <button
            type="button"
            className={scope === 'personal' ? 'active' : ''}
            onClick={() => setScope('personal')}
          >
            Personal <span style={{ color: 'var(--ink-muted)', marginLeft: 4 }}>· {personalCount}</span>
          </button>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="echo-search">
            <Search size={14} style={{ color: 'var(--ink-muted)' }} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search dictionary…"
            />
          </div>

          <Popover open={isSortOpen} onOpenChange={setIsSortOpen} align="end">
            <button
              type="button"
              onClick={() => setIsSortOpen((c) => !c)}
              title="Sort entries"
              aria-label="Sort entries"
              aria-haspopup="menu"
              aria-expanded={isSortOpen}
              className="echo-btn echo-btn-outline"
            >
              <ArrowUpDown size={13} />
              {SORT_LABELS[sortMode]}
            </button>

            <PopoverContent className="w-[180px] p-1">
              {SORT_OPTIONS.map((option) => (
                <SortMenuButton
                  key={option.id}
                  label={option.label}
                  active={sortMode === option.id}
                  onClick={() => { setSortMode(option.id); setIsSortOpen(false); }}
                />
              ))}
            </PopoverContent>
          </Popover>

          <button
            type="button"
            onClick={() => void load()}
            title="Refresh"
            aria-label="Refresh"
            className="echo-icon-btn"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="echo-card">
        {visibleItems.length > 0 ? (
          visibleItems.map((item) => {
            const isReplacement = Boolean(item.correctMisspelling && item.misspelling?.trim());
            const isRowActive =
              deleteTarget?.id === item.id ||
              (isModalOpen && editorMode === 'edit' && draft.id === item.id);
            return (
              <div key={item.id} className="echo-entry-row group">
                <div className="term">
                  {isReplacement ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          color: 'var(--ink-muted)',
                          textDecoration: 'line-through',
                          fontSize: 15.5,
                        }}
                      >
                        {item.misspelling}
                      </span>
                      <ArrowRight size={12} style={{ color: 'var(--ink-muted)' }} />
                      <span>{item.phrase}</span>
                    </span>
                  ) : (
                    item.phrase
                  )}
                </div>
                <div className={rowActionsClassName(isRowActive)}>
                    <button
                      type="button"
                      title="Edit"
                      onClick={() => openEdit(item)}
                      className="echo-icon-btn plain"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      title="Delete"
                      onClick={() => setDeleteTarget(item)}
                      className="echo-icon-btn plain"
                      style={{ color: 'var(--ink-soft)' }}
                    >
                      <Trash2 size={14} />
                    </button>
                </div>
              </div>
            );
          })
        ) : (
          <div
            style={{
              padding: '64px 28px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: 6,
            }}
          >
            <Search size={24} style={{ color: 'var(--ink-muted)', marginBottom: 6 }} />
            <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink)' }}>
              {search ? 'No entries match that search.' : 'Your dictionary is empty.'}
            </p>
            <p style={{ marginTop: 4, fontSize: 13, color: 'var(--ink-soft)' }}>
              Add preferred spellings or replacements for dictated text.
            </p>
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: 18,
          fontSize: 12.5,
          color: 'var(--ink-muted)',
          textAlign: 'center',
        }}
      >
        Synced across devices · Last update {lastSyncLabel}
      </div>

      {/* Create/Edit Modal — shared Framer Motion Dialog for snappy open/close. */}
      <Dialog open={isModalOpen} onOpenChange={(next) => { if (!next) closeModal(); }}>
        <DialogContent animation="pop" onClose={closeModal}>
          <form onSubmit={saveItem}>
            <div className="echo-modal-header">
              <h2 className="echo-modal-title">
                {editorMode === 'edit' ? (isReplacementDraft ? 'Edit replacement' : 'Edit word') : 'Add to vocabulary'}
              </h2>
            </div>

            <div className="echo-modal-body">
              {editorMode === 'create' && (
                <LabeledSwitch
                  label="Correct a misspelling"
                  onChange={(checked) =>
                    setDraft((current) => ({
                      ...current,
                      correctMisspelling: checked,
                      editKind: checked ? 'replacement' : 'word',
                      misspelling: checked ? current.misspelling : '',
                    }))
                  }
                  checked={draft.correctMisspelling}
                />
              )}

              {isReplacementDraft ? (
                <div className="grid items-center gap-3 md:grid-cols-[1fr_20px_1fr]">
                  <input autoFocus value={draft.misspelling ?? ''} onChange={(e) => setDraft((c) => ({ ...c, misspelling: e.target.value }))} placeholder="Misspelling" className="echo-composer-input" />
                  <ArrowRight size={16} className="mx-auto text-muted-foreground" />
                  <input value={draft.phrase} onChange={(e) => setDraft((c) => ({ ...c, phrase: e.target.value }))} placeholder="Correct spelling" className="echo-composer-input" />
                </div>
              ) : (
                <input autoFocus value={draft.phrase} onChange={(e) => setDraft((c) => ({ ...c, phrase: e.target.value }))} placeholder="Add a new word" className="echo-composer-input" />
              )}
            </div>

            <div className="echo-modal-footer">
              <button type="button" onClick={closeModal} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={!draft.phrase.trim() || (isReplacementDraft && !(draft.misspelling ?? '').trim())} className="btn-primary">
                {editorMode === 'edit' ? 'Save changes' : 'Add word'}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmationModal
        open={deleteTarget !== null}
        title="Delete this vocabulary entry?"
        description="Echo will stop using this saved word or replacement in future dictation."
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function SortMenuButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
    >
      <span>{label}</span>
      {active ? <Check size={13} className="text-foreground" /> : null}
    </button>
  );
}

function LabeledSwitch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (c: boolean) => void }) {
  return (
    <div className="echo-composer-switch-row flex items-center justify-between rounded-xl border border-border bg-popover">
      <span className="echo-composer-switch-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-[22px] w-[40px] shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${checked ? 'bg-primary' : 'bg-foreground/15'}`}
      >
        <span
          className="pointer-events-none absolute left-0 top-[2px] h-[18px] w-[18px] rounded-full bg-popover shadow-sm transition-transform duration-150 ease-out"
          style={{ transform: checked ? 'translateX(20px)' : 'translateX(2px)' }}
        />
      </button>
    </div>
  );
}

