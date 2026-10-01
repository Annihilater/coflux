import { useEffect, useRef, useState } from "react";

import type { SidebarWidthControl } from "@/components/workbench/use-sidebar-width";

type PaneResize = {
  pointerId: number;
  startX: number;
  startWidth: number;
  handle: HTMLDivElement;
  previousCursor: string;
  previousUserSelect: string;
};

/** Ends a resize in progress, if any: the document's cursor and selection go back, capture is released. */
function restoreResizeEnvironment(resizeRef: { current: PaneResize | null }) {
  const resize = resizeRef.current;
  if (!resize) return;
  resizeRef.current = null;
  document.documentElement.style.cursor = resize.previousCursor;
  document.documentElement.style.userSelect = resize.previousUserSelect;
  if (resize.handle.hasPointerCapture(resize.pointerId)) resize.handle.releasePointerCapture(resize.pointerId);
}

/**
 * A draggable pane width persisted in localStorage, with the same feel as the sidebar's
 * (pointer capture, persist on release, double-click restores the default), returned as the same
 * control shape so `SidebarResizeHandle` renders its handle.
 */
export function usePaneWidth(options: { storageKey: string; defaultWidth: number; min: number; max: number }): SidebarWidthControl {
  const { storageKey, defaultWidth, min, max } = options;
  const clampWidth = (value: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : defaultWidth);

  const [width, setWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === null || stored.trim() === "") return defaultWidth;
      return clampWidth(Number(stored));
    } catch {
      return defaultWidth;
    }
  });
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(width);
  const resizeRef = useRef<PaneResize | null>(null);

  function persist(value: number) {
    try {
      localStorage.setItem(storageKey, String(clampWidth(value)));
    } catch {
      // Without localStorage the width still holds for this session.
    }
  }

  function updateWidth(next: number) {
    const clamped = clampWidth(next);
    widthRef.current = clamped;
    setWidth(clamped);
  }

  function finishResize(pointerId: number) {
    if (resizeRef.current?.pointerId !== pointerId) return;
    restoreResizeEnvironment(resizeRef);
    setIsResizing(false);
    persist(widthRef.current);
  }

  // Unmounted mid-drag: put the document back.
  useEffect(() => () => restoreResizeEnvironment(resizeRef), []);

  return {
    width,
    isResizing,
    onPointerDown(event) {
      if (!event.isPrimary || event.button !== 0 || resizeRef.current) return;
      event.preventDefault();
      const handle = event.currentTarget;
      resizeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: widthRef.current,
        handle,
        previousCursor: document.documentElement.style.cursor,
        previousUserSelect: document.documentElement.style.userSelect,
      };
      handle.setPointerCapture(event.pointerId);
      document.documentElement.style.cursor = "col-resize";
      document.documentElement.style.userSelect = "none";
      setIsResizing(true);
    },
    onPointerMove(event) {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      updateWidth(resize.startWidth + event.clientX - resize.startX);
    },
    onPointerUp(event) {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      updateWidth(resize.startWidth + event.clientX - resize.startX);
      finishResize(event.pointerId);
    },
    onPointerCancel(event) {
      finishResize(event.pointerId);
    },
    onLostPointerCapture(event) {
      finishResize(event.pointerId);
    },
    onDoubleClick() {
      updateWidth(defaultWidth);
      persist(defaultWidth);
    },
  };
}
