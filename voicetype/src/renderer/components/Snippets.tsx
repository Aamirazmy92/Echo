import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUpDown, Check, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Snippet, SnippetInput } from '../../shared/types';
import ConfirmationModal from './ConfirmationModal';
import { Dialog, DialogContent } from './ui/dialog';

type SnippetScope = 'all' | 'personal';
type SortMode = 'newest' | 'oldest' | 'alphabetical';

const emptyDraft: SnippetInput = {
  trigger: '',
  expansion: '',
  category: '',
  shared: false,
};

export default function SnippetsView() {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [scope, setScope] = useState<SnippetScope>('all');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<SnippetInput & { id?: number }>(emptyDraft);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSortOpen, setIsSortOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Snippet | null>(null);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);

  const load = async () => {
    const data = await (window as any).api.getSnippets();
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

  useEffect(() => {
    if (!isSortOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!sortMenuRef.current?.contains(event.target as Node)) {
        setIsSortOpen(false);
      }
    };

    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [isSortOpen]);

  const visibleItems = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const filtered = snippets.filter((item) => {
      if (scope === 'personal' && item.shared) return false;
      if (!normalizedSearch) return true;

      const trigger = item.trigger.toLowerCase();
      const expansion = item.expansion.toLowerCase();
      return trigger.includes(normalizedSearch) || expansion.includes(normalizedSearch);
    });

    return filtered.sort((left, right) => {
      if (sortMode === 'alphabetical') {
        return left.trigger.localeCompare(right.trigger, undefined, { sensitivity: 'base' });
      }

      const leftTime = Date.parse(left.createdAt || '') || 0;
      const rightTime = Date.parse(right.createdAt || '') || 0;
      return sortMode === 'newest' ? rightTime - leftTime : leftTime - rightTime;
    });
  }, [snippets, scope, search, sortMode]);

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

    await (window as any).api.saveSnippet({
      id: draft.id,
      trigger,
      expansion,
      category,
      shared: draft.shared,
    });

    closeModal();
    await load();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await (window as any).api.deleteSnippet(deleteTarget.id);
    setDeleteTarget(null);
    await load();
  };

  return (
    <div className="page-shell static-click-buttons">
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Snippets</h1>
          <p className="page-subtitle">
            Save shortcuts for text you dictate often — emails, links, bios. Say the
            keyword and Echo expands it instantly.
          </p>
        </div>
        <button type="button" onClick={openCreate} className="btn-primary transition-transform duration-100 active:scale-[0.98]">
          Add new
        </button>
      </div>

      {/* Tabs + Toolbar */}
      <div className="mb-4 flex items-end justify-between border-b border-border pb-0">
        <div className="flex gap-5">
          <ScopeTab label="All" active={scope === 'all'} onClick={() => setScope('all')} />
          <ScopeTab label="Personal" active={scope === 'personal'} onClick={() => setScope('personal')} />
        </div>
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-10 items-center gap-2 rounded-lg border border-border bg-background/60 px-3">
            <Search size={16} className="text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search snippets..."
              className="w-[200px] border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="relative" ref={sortMenuRef}>
            <button type="button" title="Sort" onClick={() => setIsSortOpen((c) => !c)} className="btn-ghost-icon transition-transform duration-100 active:scale-[0.98]">
              <ArrowUpDown size={12} />
            </button>
            {isSortOpen && (
              <SortMenu active={sortMode} onSelect={(s) => { setSortMode(s); setIsSortOpen(false); }} />
            )}
          </div>
          <button type="button" title="Refresh" onClick={() => void load()} className="btn-ghost-icon transition-transform duration-100 active:scale-[0.98]">
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
          {visibleItems.length > 0 ? (
            <div>
              {visibleItems.map((item) => (
                <div key={item.id} className="group flex items-center border-b border-border/50 px-5 py-3.5 transition-colors last:border-0 hover:bg-accent/50">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5 text-sm">
                      <span className="shrink-0 font-medium text-foreground">{item.trigger}</span>
                      <ArrowRight size={12} className="shrink-0 text-muted-foreground" />
                      <span className="truncate text-foreground/80">{item.expansion}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button type="button" title="Edit" onClick={() => openEdit(item)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-transform duration-100 active:scale-[0.98]"><Pencil size={14} /></button>
                    <button type="button" title="Delete" onClick={() => setDeleteTarget(item)} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-transform duration-100 active:scale-[0.98]"><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-16 text-center">
              <Search size={24} className="mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">{search ? 'No snippets match that search.' : 'Your snippet library is empty.'}</p>
              <p className="mt-1.5 text-xs text-muted-foreground">Create shortcuts for text you type frequently.</p>
            </div>
          )}
      </div>

      {/* Create/Edit Modal */}
      <SnippetComposerModal
        open={isModalOpen}
        draft={draft}
        onClose={closeModal}
        onSubmit={saveItem}
        onDraftChange={setDraft}
      />

      <ConfirmationModal
        open={deleteTarget !== null}
        title="Delete this snippet?"
        description="This shortcut will stop expanding in dictated text. You can add it again at any time."
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function ScopeTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative pb-2.5 text-sm font-medium transition-colors ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
    >
      {label}
      {active && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-foreground" />}
    </button>
  );
}

function SortMenu({ active, onSelect }: { active: SortMode; onSelect: (s: SortMode) => void }) {
  const options: Array<{ id: SortMode; label: string }> = [
    { id: 'newest', label: 'Newest first' },
    { id: 'oldest', label: 'Oldest first' },
    { id: 'alphabetical', label: 'Alphabetical (A-Z)' },
  ];

  return (
    <div className="absolute right-0 top-full z-20 mt-1 w-[180px] overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg">
      <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sort by</div>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onSelect(option.id)}
          className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-foreground/70 transition-colors hover:bg-accent hover:text-foreground transition-transform duration-100 active:scale-[0.98]"
        >
          {option.label}
          {active === option.id && <Check size={13} className="text-foreground" />}
        </button>
      ))}
    </div>
  );
}

function SnippetComposerModal({
  open,
  draft,
  onClose,
  onSubmit,
  onDraftChange,
}: {
  open: boolean;
  draft: SnippetInput & { id?: number };
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void | Promise<void>;
  onDraftChange: React.Dispatch<React.SetStateAction<SnippetInput & { id?: number }>>;
}) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="max-w-lg p-6" onClose={onClose}>
        <form onSubmit={onSubmit}>
          {/* Header */}
          <div className="mb-5">
            <h2 className="text-[15px] font-semibold text-foreground">
              {draft.id ? 'Edit snippet' : 'Add snippet'}
            </h2>
          </div>

          <div className="space-y-3">
            <input
              autoFocus
              value={draft.trigger}
              onChange={(e) => onDraftChange((c) => ({ ...c, trigger: e.target.value.replace(/\s+/g, '') }))}
              placeholder="Snippet"
              className="h-10 w-full rounded-lg border-2 border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
            />
            <textarea
              value={draft.expansion}
              onChange={(e) => onDraftChange((c) => ({ ...c, expansion: e.target.value }))}
              placeholder="Expansion"
              className="min-h-[220px] max-h-[60vh] w-full resize-y rounded-lg border-2 border-border bg-background p-3 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
            />
          </div>

          <div className="mt-5 flex justify-end gap-2">
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
              {draft.id ? 'Save changes' : 'Add snippet'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
