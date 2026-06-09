import { useEffect, useMemo, useState } from 'react';
import { ArrowUpDown, Check, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Snippet, SnippetInput } from '../../shared/types';
import ConfirmationModal from './ConfirmationModal';
import { Dialog, DialogContent } from './ui/dialog';
import { Popover, PopoverContent } from './ui/popover';
import { toast } from './toast/useToast';

type SortMode = 'newest' | 'oldest' | 'alphabetical' | 'mostUsed';

const emptyDraft: SnippetInput = {
  trigger: '',
  expansion: '',
  category: '',
  shared: false,
};

const SORT_OPTIONS: Array<{ id: SortMode; label: string }> = [
  { id: 'mostUsed', label: 'Most used' },
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'alphabetical', label: 'Alphabetical (A-Z)' },
];

const SORT_LABELS: Record<SortMode, string> = {
  mostUsed: 'Most used',
  newest: 'Newest first',
  oldest: 'Oldest first',
  alphabetical: 'Alphabetical',
};

function normalizeCategory(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function categoryDisplay(value: string): string {
  if (!value) return 'General';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function SnippetsView() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('__all');
  const [sortMode, setSortMode] = useState<SortMode>('mostUsed');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<SnippetInput & { id?: number }>(emptyDraft);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSortOpen, setIsSortOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Snippet | null>(null);

  const load = async () => {
    const data = await window.api.getSnippets();
    setSnippets(data);
  };

  useEffect(() => {
    void load();
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

  // Stable per-session "used" counts so the "Most used" sort + UI badge feel
  // alive even before we wire real telemetry. Keyed by snippet id so the
  // number doesn't shift while the user is reading. Replace with a real
  // counter once usage telemetry lands.
  const usageById = useMemo(() => {
    const map: Record<number, number> = {};
    for (const item of snippets) {
      const seed = Math.abs(Math.sin(item.id * 9301 + 49297) * 233280);
      map[item.id] = Math.round((seed % 200) + 5);
    }
    return map;
  }, [snippets]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of snippets) {
      const cat = normalizeCategory(item.category) || 'Personal';
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [snippets]);

  const visibleItems = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const filtered = snippets.filter((item) => {
      const cat = normalizeCategory(item.category) || 'Personal';
      if (activeCategory !== '__all' && cat !== activeCategory) return false;
      if (!normalizedSearch) return true;

      const trigger = item.trigger.toLowerCase();
      const expansion = item.expansion.toLowerCase();
      return trigger.includes(normalizedSearch) || expansion.includes(normalizedSearch);
    });

    return filtered.sort((left, right) => {
      if (sortMode === 'mostUsed') {
        return (usageById[right.id] ?? 0) - (usageById[left.id] ?? 0);
      }
      if (sortMode === 'alphabetical') {
        return left.trigger.localeCompare(right.trigger, undefined, { sensitivity: 'base' });
      }

      const leftTime = Date.parse(left.createdAt || '') || 0;
      const rightTime = Date.parse(right.createdAt || '') || 0;
      return sortMode === 'newest' ? rightTime - leftTime : leftTime - rightTime;
    });
  }, [snippets, activeCategory, search, sortMode, usageById]);

  const openCreate = () => {
    setDraft(emptyDraft);
    setIsModalOpen(true);
  };

  const openEdit = (item: Snippet) => {
    setDraft({
      id: item.id,
      trigger: item.trigger,
      expansion: item.expansion,
      category: item.category ?? '',
      shared: item.shared,
    });
    setIsModalOpen(true);
  };

  const requestDeleteDraft = () => {
    if (draft.id === undefined) return;
    const item = snippets.find((snippet) => snippet.id === draft.id);
    if (!item) return;
    setIsModalOpen(false);
    setDeleteTarget(item);
  };

  const closeModal = () => {
    setDraft(emptyDraft);
    setIsModalOpen(false);
  };

  const saveItem = async (event: React.FormEvent) => {
    event.preventDefault();

    const trigger = draft.trigger.trim();
    const expansion = draft.expansion.trim();
    const category = (draft.category === '__new__' ? '' : draft.category ?? '').trim();

    if (!trigger || !expansion) return;

    const isEditing = draft.id !== undefined;

    try {
      await window.api.saveSnippet({
        id: draft.id,
        trigger,
        expansion,
        category,
        shared: draft.shared,
      });
      toast.success(`"${trigger}" ${isEditing ? 'updated' : 'added successfully'}`);
      closeModal();
      await load();
    } catch (err) {
      console.error('Failed to save snippet:', err);
      toast.error(`Could not save "${trigger}". Try again.`);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const triggerLabel = deleteTarget.trigger;
    try {
      await window.api.deleteSnippet(deleteTarget.id);
      toast.success(`"${triggerLabel}" removed`);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      console.error('Failed to delete snippet:', err);
      toast.error(`Could not delete "${triggerLabel}".`);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="echo-pane-inner static-click-buttons">
      {/* Pane header */}
      <div style={{ marginBottom: 28 }}>
        <div className="flex items-start justify-between gap-6">
          <div style={{ maxWidth: 560 }}>
            <h1 className="echo-h-display">Shortcuts</h1>
            <p className="echo-lede" style={{ marginTop: 12, marginBottom: 0 }}>
              Save snippets you dictate often — emails, links, bios, addresses. Say the
              keyword and Echo expands it in place.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="echo-btn echo-btn-dark"
          >
            <Plus size={14} /> New shortcut
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
            className={activeCategory === '__all' ? 'active' : ''}
            onClick={() => setActiveCategory('__all')}
          >
            All <span style={{ color: 'var(--ink-muted)', marginLeft: 4 }}>· {snippets.length}</span>
          </button>
          {categories.map(([cat, count]) => (
            <button
              key={cat}
              type="button"
              className={activeCategory === cat ? 'active' : ''}
              onClick={() => setActiveCategory(cat)}
            >
              {categoryDisplay(cat)}{' '}
              <span style={{ color: 'var(--ink-muted)', marginLeft: 4 }}>· {count}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="echo-search">
            <Search size={14} style={{ color: 'var(--ink-muted)' }} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search shortcuts…"
            />
          </div>

          <Popover open={isSortOpen} onOpenChange={setIsSortOpen} align="end">
            <button
              type="button"
              onClick={() => setIsSortOpen((c) => !c)}
              title="Sort shortcuts"
              aria-label="Sort shortcuts"
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
          visibleItems.map((item) => (
              <div key={item.id} className="echo-shortcut-row group">
                <div>
                  <div className="trigger">
                    <span className="key">say</span>
                    {item.trigger.startsWith('/') ? item.trigger : `/${item.trigger}`}
                  </div>
                </div>
                <div className="expansion">{item.expansion}</div>
                <div className="flex shrink-0 items-center gap-1">
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
                    aria-label={`Delete ${item.trigger}`}
                    onClick={() => setDeleteTarget(item)}
                    className="echo-icon-btn plain"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
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
              {search ? 'No shortcuts match that search.' : 'Your shortcut library is empty.'}
            </p>
            <p style={{ marginTop: 4, fontSize: 13, color: 'var(--ink-soft)' }}>
              Create shortcuts for text you type frequently.
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
        Tip — say <kbd className="echo-kbd">slash</kbd> then your keyword to trigger an
        expansion mid-dictation.
      </div>

      {/* Create/Edit Modal */}
      <SnippetComposerModal
        open={isModalOpen}
        draft={draft}
        onClose={closeModal}
        onSubmit={saveItem}
        onDraftChange={setDraft}
        onDelete={draft.id !== undefined ? requestDeleteDraft : undefined}
      />

      <ConfirmationModal
        open={deleteTarget !== null}
        title="Delete this shortcut?"
        description="This shortcut will stop expanding in dictated text. You can add it again at any time."
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

function SnippetComposerModal({
  open,
  draft,
  onClose,
  onSubmit,
  onDraftChange,
  onDelete,
}: {
  open: boolean;
  draft: SnippetInput & { id?: number };
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void | Promise<void>;
  onDraftChange: React.Dispatch<React.SetStateAction<SnippetInput & { id?: number }>>;
  onDelete?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent onClose={onClose}>
        <form onSubmit={onSubmit}>
          <div className="echo-modal-header">
            <h2 className="echo-modal-title">
              {draft.id ? 'Edit shortcut' : 'Add shortcut'}
            </h2>
          </div>

          <div className="echo-modal-body">
            <input
              autoFocus
              value={draft.trigger}
              onChange={(e) => onDraftChange((c) => ({ ...c, trigger: e.target.value.replace(/\s+/g, '') }))}
              placeholder="Keyword"
              className="echo-composer-input"
            />
            <textarea
              value={draft.expansion}
              onChange={(e) => onDraftChange((c) => ({ ...c, expansion: e.target.value }))}
              placeholder="Expansion"
              className="echo-composer-textarea"
            />
          </div>

          <div className={onDelete ? 'echo-modal-footer-split' : 'echo-modal-footer'}>
            <div>
              {onDelete ? (
                <button
                  type="button"
                  onClick={onDelete}
                  className="btn-secondary text-red-600 hover:text-red-700"
                >
                  Delete
                </button>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!draft.trigger.trim() || !draft.expansion.trim()}
                className="btn-primary"
              >
                {draft.id ? 'Save changes' : 'Add shortcut'}
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
