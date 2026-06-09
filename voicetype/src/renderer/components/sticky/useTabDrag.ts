import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { toast } from '../toast/useToast';
import type { Tab, UseNoteTabsReturn } from './useNoteTabs';

export type TabDragPreview = {
  clientId: string;
  title: string;
  x: number;
  y: number;
  width: number;
};

type DragState = {
  clientId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  tabWidth: number;
  detached: boolean;
  commitStarted: boolean;
  reordering: boolean;
  tearingOut: boolean;
};

const TAB_BAR_Y_TOP = -10;
const TAB_BAR_Y_BOTTOM = 50;
const REORDER_HORIZONTAL_THRESHOLD = 6;
const REORDER_VERTICAL_LIMIT = 12;
const TEAR_OUT_VERTICAL_THRESHOLD = 28;
const MOVED_ENOUGH_HORIZONTAL = 4;
const MOVED_ENOUGH_VERTICAL = 6;

type Options = {
  tabs: Tab[];
  tabBarRef: React.RefObject<HTMLElement>;
  saveTabForTransfer: UseNoteTabsReturn['saveTabForTransfer'];
  removeTabFromWindow: UseNoteTabsReturn['removeTabFromWindow'];
  setTabs: UseNoteTabsReturn['setTabs'];
};

export function useTabDrag({
  tabs,
  tabBarRef,
  saveTabForTransfer,
  removeTabFromWindow,
  setTabs,
}: Options) {
  const [draggingClientId, setDraggingClientId] = useState<string | null>(null);
  const [dragOverClientId, setDragOverClientId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<TabDragPreview | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const recentlyDraggedRef = useRef(false);
  const detachInFlightRef = useRef<Set<string>>(new Set());

  const isOutsideTabBar = useCallback(
    (event: ReactPointerEvent<HTMLElement>) =>
      event.clientY < TAB_BAR_Y_TOP ||
      event.clientY > TAB_BAR_Y_BOTTOM ||
      event.clientX < -20 ||
      event.clientX > window.innerWidth + 20,
    [],
  );

  const moveTabToVisualIndex = useCallback(
    (clientId: string, targetIndex: number) => {
      setTabs((prev) => {
        const currentIndex = prev.findIndex((tab) => tab.clientId === clientId);
        if (currentIndex === -1) return prev;
        const movingTab = prev[currentIndex];
        const remainingTabs = prev.filter((tab) => tab.clientId !== clientId);
        const nextIndex = Math.max(0, Math.min(targetIndex, remainingTabs.length));
        const next = [...remainingTabs];
        next.splice(nextIndex, 0, movingTab);
        const unchanged = next.every((tab, index) => tab.clientId === prev[index]?.clientId);
        return unchanged ? prev : next;
      });
    },
    [setTabs],
  );

  const computeDropIndex = useCallback(
    (clientX: number, draggingId: string): number | null => {
      const bar = tabBarRef.current;
      if (!bar) return null;
      const children = Array.from(bar.children) as HTMLElement[];
      // The last child is the "+" new-tab button — skip it.
      const tabEls = children
        .slice(0, children.length - 1)
        .filter((el) => el.getAttribute('data-tab-id') !== draggingId);
      if (tabEls.length === 0) return 0;
      for (let index = 0; index < tabEls.length; index += 1) {
        const rect = tabEls[index].getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        if (clientX < center) return index;
      }
      return tabEls.length;
    },
    [tabBarRef],
  );

  const computeDropTarget = useCallback(
    (clientX: number, draggingId: string): string | null => {
      const index = computeDropIndex(clientX, draggingId);
      if (index === null) return null;
      const orderedTabs = tabs.filter((tab) => tab.clientId !== draggingId);
      return orderedTabs[Math.min(index, orderedTabs.length - 1)]?.clientId ?? null;
    },
    [computeDropIndex, tabs],
  );

  const updateDragPreview = useCallback(
    (event: ReactPointerEvent<HTMLElement>, dragState: DragState) => {
      const tab = tabs.find((t) => t.clientId === dragState.clientId);
      if (!tab) {
        setDragPreview(null);
        return;
      }
      setDragPreview({
        clientId: tab.clientId,
        title: tab.title || 'Untitled',
        x: event.clientX - dragState.grabOffsetX,
        y: event.clientY - dragState.grabOffsetY,
        width: dragState.tabWidth,
      });
    },
    [tabs],
  );

  const commitTabTransfer = useCallback(
    async (
      tab: Tab,
      point: { x: number; y: number },
      position: { x: number; y: number },
    ) => {
      if (detachInFlightRef.current.has(tab.clientId)) return;
      detachInFlightRef.current.add(tab.clientId);
      try {
        const note = await saveTabForTransfer(tab);
        const attached = await window.api.attachNoteToStickyWindow(note, point);
        if (!attached) {
          await window.api.createNewStickyNoteWindow(note, position);
        }
        removeTabFromWindow(tab.clientId);
      } catch {
        toast.error('Could not detach note.');
      } finally {
        detachInFlightRef.current.delete(tab.clientId);
      }
    },
    [saveTabForTransfer, removeTabFromWindow],
  );

  const detachTabAfterDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement> | PointerEvent, dragState: DragState) => {
      const tab = tabs.find((t) => t.clientId === dragState.clientId);
      if (!tab || dragState.commitStarted) return false;
      recentlyDraggedRef.current = true;
      dragState.commitStarted = true;
      dragState.detached = true;
      event.preventDefault();
      pointerCaptureTargetRef.current?.releasePointerCapture?.(event.pointerId);
      void commitTabTransfer(
        tab,
        { x: event.screenX, y: event.screenY },
        {
          x: event.screenX - dragState.grabOffsetX,
          y: event.screenY - dragState.grabOffsetY,
        },
      );
      return true;
    },
    [tabs, commitTabTransfer],
  );

  const updateReorderDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, dragState: DragState) => {
      if (isOutsideTabBar(event)) {
        setDragOverClientId(null);
        dragState.tearingOut = true;
        updateDragPreview(event, dragState);
        return;
      }
      dragState.tearingOut = false;
      setDragPreview(null);
      const dropIndex = computeDropIndex(event.clientX, dragState.clientId);
      if (dropIndex !== null) moveTabToVisualIndex(dragState.clientId, dropIndex);
      const dropId = computeDropTarget(event.clientX, dragState.clientId);
      setDragOverClientId(dropId && dropId !== dragState.clientId ? dropId : null);
    },
    [isOutsideTabBar, updateDragPreview, computeDropIndex, computeDropTarget, moveTabToVisualIndex],
  );

  const updateActiveDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement> | PointerEvent) => {
      const dragState = dragRef.current;
      if (!dragState || dragState.detached) return;

      const tab = tabs.find((t) => t.clientId === dragState.clientId);
      if (!tab) return;

      if (dragState.reordering) {
        recentlyDraggedRef.current = true;
        event.preventDefault();
        updateReorderDrag(event as ReactPointerEvent<HTMLElement>, dragState);
        return;
      }

      const movedUp = dragState.startClientY - event.clientY;
      const movedSideways = Math.abs(event.clientX - dragState.startClientX);

      // Horizontal drag within tab bar → reorder mode.
      if (
        movedSideways > REORDER_HORIZONTAL_THRESHOLD &&
        movedUp < REORDER_VERTICAL_LIMIT &&
        event.clientY > 0 &&
        event.clientY < 44
      ) {
        recentlyDraggedRef.current = true;
        dragState.reordering = true;
        setDraggingClientId(tab.clientId);
        updateReorderDrag(event as ReactPointerEvent<HTMLElement>, dragState);
        const dropId = computeDropTarget(event.clientX, tab.clientId);
        if (dropId && dropId !== tab.clientId) setDragOverClientId(dropId);
        return;
      }

      // Drag outside the tab bar → detach preview (commit on release).
      const outsideBounds = isOutsideTabBar(event as ReactPointerEvent<HTMLElement>);
      const movedEnough = movedSideways > MOVED_ENOUGH_HORIZONTAL || movedUp > MOVED_ENOUGH_VERTICAL;
      if (!movedEnough || (!outsideBounds && movedUp < TEAR_OUT_VERTICAL_THRESHOLD)) return;

      recentlyDraggedRef.current = true;
      event.preventDefault();
      dragState.reordering = true;
      dragState.tearingOut = true;
      setDraggingClientId(tab.clientId);
      setDragOverClientId(null);
      updateDragPreview(event as ReactPointerEvent<HTMLElement>, dragState);
    },
    [tabs, updateReorderDrag, computeDropTarget, isOutsideTabBar, updateDragPreview],
  );

  const dragListenersCleanupRef = useRef<(() => void) | null>(null);
  const pointerCaptureTargetRef = useRef<HTMLElement | null>(null);

  const onTabPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement> | PointerEvent) => {
      const dragState = dragRef.current;
      if (dragState && dragState.pointerId === event.pointerId && !dragState.commitStarted) {
        const movedUp = dragState.startClientY - event.clientY;
        const movedSideways = Math.abs(event.clientX - dragState.startClientX);
        const outsideBounds =
          event.clientY < 4 ||
          event.clientY > 50 ||
          event.clientX < -20 ||
          event.clientX > window.innerWidth + 20;
        const shouldDetach =
          dragState.tearingOut ||
          outsideBounds ||
          (!dragState.reordering && movedUp > REORDER_VERTICAL_LIMIT && movedSideways > 2);
        if (shouldDetach) detachTabAfterDrag(event as ReactPointerEvent<HTMLElement>, dragState);
      }
      if (dragState?.pointerId === event.pointerId) {
        dragRef.current = null;
        setDraggingClientId(null);
        setDragOverClientId(null);
        if (dragState.detached) {
          setTimeout(() => setDragPreview(null), 180);
        } else {
          setDragPreview(null);
        }
      }
      dragListenersCleanupRef.current?.();
      dragListenersCleanupRef.current = null;
      pointerCaptureTargetRef.current = null;
      // Clear the drag flag after the click event has had a chance to fire.
      setTimeout(() => {
        recentlyDraggedRef.current = false;
      }, 80);
    },
    [detachTabAfterDrag],
  );

  const onTabPointerEndRef = useRef(onTabPointerEnd);
  onTabPointerEndRef.current = onTabPointerEnd;

  const onTabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, tab: Tab) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      recentlyDraggedRef.current = false;
      pointerCaptureTargetRef.current = event.currentTarget;
      const rect = event.currentTarget.getBoundingClientRect();
      dragRef.current = {
        clientId: tab.clientId,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        grabOffsetX: event.clientX - rect.left,
        grabOffsetY: event.clientY - rect.top,
        tabWidth: rect.width,
        detached: false,
        commitStarted: false,
        reordering: false,
        tearingOut: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);

      dragListenersCleanupRef.current?.();

      const handleDocumentMove = (moveEvent: PointerEvent) => {
        const activeDrag = dragRef.current;
        if (!activeDrag || activeDrag.pointerId !== moveEvent.pointerId || activeDrag.detached) return;
        updateActiveDrag(moveEvent);
      };

      const handleDocumentEnd = (endEvent: PointerEvent) => {
        if (dragRef.current?.pointerId !== endEvent.pointerId) return;
        onTabPointerEndRef.current(endEvent);
      };

      document.addEventListener('pointermove', handleDocumentMove);
      document.addEventListener('pointerup', handleDocumentEnd);
      document.addEventListener('pointercancel', handleDocumentEnd);
      dragListenersCleanupRef.current = () => {
        document.removeEventListener('pointermove', handleDocumentMove);
        document.removeEventListener('pointerup', handleDocumentEnd);
        document.removeEventListener('pointercancel', handleDocumentEnd);
      };
    },
    [updateActiveDrag],
  );

  return {
    draggingClientId,
    dragOverClientId,
    dragPreview,
    recentlyDraggedRef,
    onTabPointerDown,
    onTabPointerEnd,
  };
}
