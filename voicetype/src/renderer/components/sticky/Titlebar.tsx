import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useRef } from 'react';
import { motion } from 'framer-motion';
import { Check, Loader2, Maximize2, Plus, X } from 'lucide-react';
import type { SaveStatus, Tab } from './useNoteTabs';
import type { TabDragPreview } from './useTabDrag';

type TitlebarProps = {
  tabs: Tab[];
  activeTabId: string;
  editingTabId: string | null;
  editTitleValue: string;
  setEditTitleValue: (value: string) => void;
  setEditingTabId: (id: string | null) => void;
  onTabClick: (tab: Tab) => void;
  onTabRename: (tab: Tab) => void;
  onTabClose: (clientId: string) => void;
  onAddNewTab: () => void;
  onCommitRename: (clientId: string, title: string) => void;
  onMaximize: () => void;
  onClose: () => void;
  draggingClientId: string | null;
  dragOverClientId: string | null;
  dragPreview: TabDragPreview | null;
  tabBarRef: RefObject<HTMLDivElement>;
  onTabPointerDown: (event: ReactPointerEvent<HTMLElement>, tab: Tab) => void;
  recentlyDraggedRef: { current: boolean };
  saveStatus: SaveStatus;
};

export default function Titlebar({
  tabs,
  activeTabId,
  editingTabId,
  editTitleValue,
  setEditTitleValue,
  setEditingTabId,
  onTabClick,
  onTabRename,
  onTabClose,
  onAddNewTab,
  onCommitRename,
  onMaximize,
  onClose,
  draggingClientId,
  dragOverClientId,
  dragPreview,
  tabBarRef,
  onTabPointerDown,
  recentlyDraggedRef,
  saveStatus,
}: TitlebarProps) {
  const noDrag: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties;
  const lastClickRef = useRef<{ clientId: string; time: number } | null>(null);

  return (
    <div className="sticky-titlebar">
      <div
        ref={tabBarRef}
        className="sticky-tabbar"
      >
        {tabs.map((tab) => {
          const isActive = activeTabId === tab.clientId;
          const isDragging = draggingClientId === tab.clientId;
          const isTearingOut = dragPreview?.clientId === tab.clientId;
          const isDropTarget = dragOverClientId === tab.clientId;
          return (
            <motion.div
              layout={isDragging ? false : 'position'}
              transition={{ type: 'spring', stiffness: 700, damping: 44, mass: 0.6 }}
              key={tab.clientId}
              data-tab-id={tab.clientId}
              role="button"
              tabIndex={0}
              onPointerDown={(e) => onTabPointerDown(e, tab)}
              onClick={() => {
                if (recentlyDraggedRef.current) return;
                const now = Date.now();
                const last = lastClickRef.current;
                if (last && last.clientId === tab.clientId && now - last.time < 300) {
                  lastClickRef.current = null;
                  onTabRename(tab);
                  return;
                }
                lastClickRef.current = { clientId: tab.clientId, time: now };
                onTabClick(tab);
              }}
              onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onTabClick(tab);
                }
              }}
              style={noDrag}
              animate={{ opacity: isTearingOut ? 0.4 : 1 }}
              className={`sticky-tab ${isActive ? 'is-active' : ''} ${isDragging ? 'is-dragging' : ''} ${isDropTarget ? 'is-drop-target' : ''}`}
              title={tab.title || 'Untitled'}
            >
              {editingTabId === tab.clientId ? (
                <input
                  autoFocus
                  ref={(el) => {
                    if (el) el.select();
                  }}
                  value={editTitleValue}
                  onChange={(e) => setEditTitleValue(e.target.value)}
                  onBlur={() => onCommitRename(tab.clientId, editTitleValue)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onCommitRename(tab.clientId, editTitleValue);
                    else if (e.key === 'Escape') setEditingTabId(null);
                  }}
                  className="sticky-tab-input"
                  style={noDrag}
                />
              ) : (
                <span className="sticky-tab-label">{tab.title || 'Untitled'}</span>
              )}
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.clientId);
                }}
                className="sticky-tab-close"
                aria-label="Close note"
                title="Close note"
              >
                <X size={11} />
              </button>
            </motion.div>
          );
        })}
        <button
          type="button"
          onClick={onAddNewTab}
          style={noDrag}
          className="sticky-tab-new"
          aria-label="New note"
          title="New note"
        >
          <Plus size={15} />
        </button>
      </div>

      {dragPreview && (
        <div
          className="sticky-tab-drag-preview"
          style={{
            ...noDrag,
            left: dragPreview.x,
            top: dragPreview.y,
            width: dragPreview.width,
          }}
        >
          <span className="sticky-tab-label">{dragPreview.title}</span>
        </div>
      )}

      <div className="sticky-titlebar-controls">
        <span className={`sticky-save-status is-${saveStatus}`} aria-live="polite">
          {saveStatus === 'saving' ? (
            <>
              <Loader2 size={11} className="sticky-save-spin" />
              Saving…
            </>
          ) : saveStatus === 'saved' ? (
            <>
              <Check size={11} />
              Saved
            </>
          ) : null}
        </span>
        <button
          type="button"
          onClick={onMaximize}
          style={noDrag}
          className="sticky-control-btn"
          title="Toggle size"
          aria-label="Toggle size"
        >
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          onClick={onClose}
          style={noDrag}
          className="sticky-control-btn sticky-control-close"
          title="Close"
          aria-label="Close window"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
