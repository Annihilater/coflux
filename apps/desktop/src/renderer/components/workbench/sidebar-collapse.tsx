import { Tooltip } from "@astryxdesign/core/Tooltip";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { NO_DRAG_REGION_STYLE } from "@/components/workbench/drag-region";
import { SHORTCUT_MODIFIER_PREFIX } from "@/components/workbench/shortcut-modifier";
import { SIDEBAR_COLLAPSED_KEY } from "@/config";

/**
 * The collapsible workbench sidebar (plan 20260930-collapsible-sidebar). Collapsed means the
 * sidebar is not rendered at all; its width is a separate value (use-sidebar-width.ts, shared with
 * the settings page's left column) and is left untouched, so expanding restores it.
 *
 * While collapsed, the expand button lives in the "left dock": the mirror image of the top-right
 * action dock, one instance for every workspace and empty state, floating just right of the macOS
 * traffic lights. Surfaces that touch the window's top-left corner reserve `leftDockReserve` on
 * their left, the way the top-right strip reserves the action dock's width.
 */

/** Where the traffic lights end (main/window.ts: `trafficLightPosition` x=14, three 12 px lights 8 px apart) plus a gap. */
const TRAFFIC_LIGHTS_END = 72;
/** In native full screen macOS hides the traffic lights, so the dock moves to the strip's own inset. */
const FULL_SCREEN_DOCK_LEFT = 8;
/** The dock's width: one 24 px button with 4 px on either side. */
export const LEFT_DOCK_WIDTH = 32;

/** The dock's left edge in the window. */
export function leftDockLeft(fullScreen: boolean): number {
  return fullScreen ? FULL_SCREEN_DOCK_LEFT : TRAFFIC_LIGHTS_END;
}

/** How much a surface touching the window's top-left corner keeps free on its left while the sidebar is collapsed. */
export function leftDockReserve(fullScreen: boolean): number {
  return leftDockLeft(fullScreen) + LEFT_DOCK_WIDTH;
}

/** A per-machine UI preference like the width: unscoped, and unreadable storage means expanded. */
export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistSidebarCollapsed(collapsed: boolean) {
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    else localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
  } catch {
    // Storage unavailable: the state still holds for this session.
  }
}

/**
 * The collapse button (sidebar's top band) and the expand button (left dock). Both sit inside or
 * over a window drag region, so the button carries NO_DRAG_REGION_STYLE; its Tooltip is a
 * `[popover]` and is kept out of the drag region by the rule in index.css.
 */
export function SidebarToggleButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "展开侧边栏" : "收起侧边栏";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <Tooltip content={`${label} ${SHORTCUT_MODIFIER_PREFIX}B`} placement="below">
      <button
        type="button"
        aria-label={label}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        style={NO_DRAG_REGION_STYLE}
        onClick={onToggle}
      >
        <Icon className="size-3.5" />
      </button>
    </Tooltip>
  );
}
