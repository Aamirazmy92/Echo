import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpDown, Check, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react';
import { DictionaryItem, DictionaryItemInput } from '../../shared/types';
import ConfirmationModal from './ConfirmationModal';
import { Dialog, DialogContent } from './ui/dialog';

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
  const sortMenuRef = useRef<HTMLDivElement | null>(null);

  const load = async () => {
    const data = await (window as any).api.getDictionaryItems();
    setItems(data);
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

    await (window as any).api.saveDictionaryItem({
      id: draft.id,
      phrase,
      misspelling: isReplacement ? misspelling : null,
      correctMisspelling: isReplacement,
      shared: false,
    });

    closeModal();
    await load();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await (window as any).api.deleteDictionaryItem(deleteTarget.id);
    setDeleteTarget(null);
    await load();
  };

  const isReplacementDraft = draft.editKind === 'replacement' || draft.correctMisspelling;

  return (
    <div className="page-shell static-click-buttons">
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Personal dictionary</h1>
          <p className="page-subtitle">
            Teach Echo the words that matter to you — names, product terms, and
            spellings Echo quietly corrects while you talk.
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
              placeholder="Search dictionary..."
              className="w-[200px] border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="relative" ref={sortMenuRef}>
            <button
              type="button"
              title="Sort"
              onClick={() => setIsSortOpen((c) => !c)}
              className="btn-ghost-icon"
            >
              <ArrowUpDown size={12} />
            </button>
            {isSortOpen && (
              <SortMenu active={sortMode} onSelect={(s) => { setSortMode(s); setIsSortOpen(false); }} />
            )}
          </div>
          <button
            type="button"
            title="Refresh"
            onClick={() => void load()}
            className="btn-ghost-icon"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
          {visibleItems.length > 0 ? (
            <div>
              {visibleItems.map((item) => {
                const isReplacement = Boolean(item.correctMisspelling && item.misspelling?.trim());
                return (
                  <div key={item.id} className="group flex items-center border-b border-border/50 px-5 py-3.5 transition-colors last:border-0 hover:bg-accent/50">
                    <div className="min-w-0 flex-1">
                      {isReplacement ? (
                        <div className="flex items-center gap-2.5 text-sm">
                          <span className="max-w-[200px] truncate text-muted-foreground line-through">{item.misspelling}</span>
                          <ArrowRight size={12} className="shrink-0 text-muted-foreground" />
                          <span className="truncate font-medium text-foreground">{item.phrase}</span>
                        </div>
                      ) : (
                        <span className="text-sm font-medium text-foreground">{item.phrase}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button title="Edit" onClick={() => openEdit(item)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil size={14} /></button>
                      <button title="Delete" onClick={() => setDeleteTarget(item)} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Trash2 size={14} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-16 text-center">
              <Search size={24} className="mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">{search ? 'No entries match that search.' : 'Your dictionary is empty.'}</p>
              <p className="mt-1.5 text-xs text-muted-foreground">Add preferred spellings or replacements for dictated text.</p>
            </div>
          )}
      </div>

      {/* Create/Edit Modal — shared CSS-only Dialog for snappy open/close. */}
      <Dialog open={isModalOpen} onOpenChange={(next) => { if (!next) closeModal(); }}>
        <DialogContent animation="pop" className="max-w-lg" onClose={closeModal}>
          <form onSubmit={saveItem}>
            <div className="mb-5">
              <h2 className="text-[15px] font-semibold text-foreground">
                {editorMode === 'edit' ? (isReplacementDraft ? 'Edit replacement' : 'Edit word') : 'Add to vocabulary'}
              </h2>
            </div>

            <div className="space-y-4">
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
                  <input autoFocus value={draft.misspelling ?? ''} onChange={(e) => setDraft((c) => ({ ...c, misspelling: e.target.value }))} placeholder="Misspelling" className="h-9 rounded-lg border-2 border-border bg-background/60 px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring" />
                  <ArrowRight size={14} className="mx-auto text-muted-foreground" />
                  <input value={draft.phrase} onChange={(e) => setDraft((c) => ({ ...c, phrase: e.target.value }))} placeholder="Correct spelling" className="h-9 rounded-lg border-2 border-border bg-background/60 px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring" />
                </div>
              ) : (
                <input autoFocus value={draft.phrase} onChange={(e) => setDraft((c) => ({ ...c, phrase: e.target.value }))} placeholder="Add a new word" className="h-9 w-full rounded-lg border-2 border-border bg-background/60 px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring" />
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
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
          className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          {option.label}
          {active === option.id && <Check size={13} className="text-foreground" />}
        </button>
      ))}
    </div>
  );
}

function LabeledSwitch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (c: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border bg-muted/50 px-4 py-3">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-[22px] w-[40px] shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${checked ? 'bg-primary' : 'bg-foreground/15'}`}
      >
        <span
          className="pointer-events-none absolute left-0 top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-150 ease-out"
          style={{ transform: checked ? 'translateX(20px)' : 'translateX(2px)' }}
        />
      </button>
    </div>
  );
}

