import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, GitBranch, Monitor, SquareTerminal, type LucideIcon } from "lucide-react";
import {
  CommandPalette,
  CommandPaletteFooter,
  CommandPaletteInput,
  useCommandPaletteContext,
  type CommandPaletteContextValue,
} from "@astryxdesign/core/CommandPalette";
import { Kbd } from "@astryxdesign/core/Kbd";
import type { SearchSource } from "@astryxdesign/core/Typeahead";

import { ActivityDots } from "@/components/workbench/pending-dots";
import {
  EMPTY_PALETTE_SNAPSHOT,
  buildPaletteSnapshot,
  searchPaletteEntries,
  type PaletteActivity,
  type PaletteEntry,
  type PaletteEntryKind,
  type PaletteFilter,
  type PaletteItem,
  type PaletteSnapshot,
} from "@/components/workbench/command-palette-data";
import { readRecentPlaces, type RecentPlacesStore } from "@/components/workbench/command-palette-recent";
import { cn } from "@/lib/utils";
import type { CofluxClient } from "@coflux/client";

/**
 * The ⌘P navigation palette (plan 20260921): one keyboard step to any workspace, project, running
 * terminal or device. A navigation palette, not a command launcher — nothing here runs anything.
 *
 * Built on the design system's own CommandPalette, with every string passed explicitly: the
 * renderer mounts no astryx i18n provider, so the component's defaults would render English.
 *
 * The data is read from the store once, in the render that opens the palette, and frozen for its
 * lifetime. The component bootstraps in an effect right after that commit, so anything computed
 * afterwards would arrive too late.
 */

export type NavigationPaletteProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  client: CofluxClient;
  recentStore: RecentPlacesStore;
  /** Where the user is right now; excluded from 「最近」 so Enter never lands on the current place. */
  current: { workspaceId: string | null; taskId: string | null; daemonId: string | null };
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenTerminal: (workspaceId: string, taskId: string) => void;
  onOpenDevice: (daemonId: string) => void;
};

/** The tab row. An Actions tab belongs here later; nothing of it is built now. */
const FILTER_TABS: readonly { id: PaletteFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "workspace", label: "工作区" },
  { id: "terminal", label: "终端" },
  { id: "device", label: "设备" },
];

const KIND_ICON: Record<PaletteEntryKind, LucideIcon> = {
  workspace: GitBranch,
  project: Folder,
  terminal: SquareTerminal,
  device: Monitor,
};

const ACTIVITY_LABEL: Record<Exclude<PaletteActivity, null>, string> = {
  active: "正在执行",
  approval: "等待批准",
  question: "等待回答",
  done: "本轮完成",
};

/**
 * The search input plus the filter tabs.
 *
 * It lives in the `input` slot because that slot renders inside the palette's own context, which
 * is what makes two things possible: driving the initial highlight, and switching tabs.
 *
 * The highlight has to be driven from here. The component starts at -1 and its Enter handler
 * ignores the key while the index is negative, so ⏎ would do nothing until the user pressed an
 * arrow — and the ⌘P then ⏎ bounce is the whole point. Picker-mode `value` would pre-highlight,
 * but it also paints a persistent selected background on that row for the palette's lifetime.
 *
 * ⌘[ / ⌘] are handled here too. They only ever arrive because the workbench suspends its own
 * capture-phase shortcuts while the palette is open; without that they are consumed before React
 * sees them. Switching a tab has to re-run the search explicitly: the component calls its source
 * on a keystroke and on open, and on nothing else.
 */
function PaletteHeader({
  filter,
  onFilterChange,
}: {
  filter: PaletteFilter;
  onFilterChange: (next: PaletteFilter, context: CommandPaletteContextValue) => void;
}) {
  const context = useCommandPaletteContext();
  const setHighlightedIndex = context?.setHighlightedIndex;
  const selectableItems = context?.selectableItems;

  // Every time the result set changes — bootstrap, keystroke, tab switch — the first row becomes
  // the highlighted one. For an empty query that first row is the place the user was before this
  // one, which is what makes ⌘P ⏎ a two-place bounce.
  useEffect(() => {
    setHighlightedIndex?.(0);
  }, [selectableItems, setHighlightedIndex]);

  function stepFilter(delta: number) {
    if (!context) return;
    const index = Math.max(0, FILTER_TABS.findIndex((tab) => tab.id === filter));
    const size = FILTER_TABS.length;
    onFilterChange(FILTER_TABS[(((index + delta) % size) + size) % size].id, context);
  }

  return (
    <div className="flex flex-col">
      <CommandPaletteInput
        placeholder="搜索工作区、终端、设备…"
        label="搜索工作区、终端、设备"
        onKeyDown={(event) => {
          if (!event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (event.code !== "BracketLeft" && event.code !== "BracketRight") return;
          event.preventDefault();
          event.stopPropagation();
          stepFilter(event.code === "BracketLeft" ? -1 : 1);
        }}
      />
      <div role="tablist" aria-label="条目类别" className="flex items-center gap-1 border-t border-border px-3 py-1.5">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === filter}
            className={cn(
              "flex h-6 items-center rounded-md px-2 text-xs transition-colors",
              tab.id === filter ? "bg-accent text-foreground" : "text-secondary-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            onClick={() => context && onFilterChange(tab.id, context)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One row: kind icon, primary label, secondary label, then trailing metadata.
 *
 * The keyboard highlight is drawn by the palette itself. `renderItem`'s `isSelected` argument
 * reflects picker-mode `value`, which this palette deliberately does not use, so a row must never
 * draw itself from it — two rows would look active after one arrow press.
 */
function PaletteRow({ entry }: { entry: PaletteEntry }) {
  const Icon = KIND_ICON[entry.kind];
  const isMainWorkspace = entry.kind === "workspace" && entry.detail === "主工作区";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {entry.activity ? (
        <ActivityDots status={entry.activity} label={ACTIVITY_LABEL[entry.activity]} />
      ) : (
        <Icon className={cn("size-3.5 shrink-0", isMainWorkspace ? "text-warning" : "opacity-70")} />
      )}
      <span className="truncate text-sm text-foreground">{entry.label}</span>
      {entry.detail ? <span className="shrink-0 truncate text-xs text-muted-foreground">{entry.detail}</span> : null}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-xs text-muted-foreground">
        {entry.context ? <span className="max-w-32 truncate">{entry.context}</span> : null}
        {entry.isOffline && entry.kind !== "device" ? <span>离线</span> : null}
        {entry.activity === "approval" || entry.activity === "question" ? (
          <span className="text-warning">{ACTIVITY_LABEL[entry.activity]}</span>
        ) : null}
      </span>
    </div>
  );
}

export function NavigationPalette(props: NavigationPaletteProps) {
  // The frozen data of one open. Refs rather than state: the source reads them from inside the
  // palette's own async search, where a value committed on the next render would be too late.
  const snapshotRef = useRef<PaletteSnapshot>(EMPTY_PALETTE_SNAPSHOT);
  const recentRef = useRef<readonly string[]>([]);
  const filterRef = useRef<PaletteFilter>("all");
  const wasOpenRef = useRef(false);
  const [filter, setFilter] = useState<PaletteFilter>("all");

  if (props.isOpen !== wasOpenRef.current) {
    wasOpenRef.current = props.isOpen;
    filterRef.current = "all";
    setFilter("all");
    if (props.isOpen) {
      const state = props.client.store.getState();
      snapshotRef.current = buildPaletteSnapshot({
        projects: state.projects,
        workspaces: state.workspaces,
        daemons: state.daemons,
        tasks: state.tasks,
        sessionAgents: state.sessionAgents,
        sessionCheckpoints: state.sessionCheckpoints,
        current: props.current,
      });
      recentRef.current = readRecentPlaces(props.recentStore);
    } else {
      // Nothing of the closed palette stays reachable: the next open builds its own.
      snapshotRef.current = EMPTY_PALETTE_SNAPSHOT;
      recentRef.current = [];
    }
  }

  const searchSource = useMemo<SearchSource<PaletteItem>>(
    () => ({
      bootstrap: () =>
        searchPaletteEntries({ snapshot: snapshotRef.current, query: "", filter: filterRef.current, recent: recentRef.current }),
      search: (query: string) =>
        searchPaletteEntries({ snapshot: snapshotRef.current, query, filter: filterRef.current, recent: recentRef.current }),
    }),
    [],
  );

  function changeFilter(next: PaletteFilter, context: CommandPaletteContextValue) {
    if (filterRef.current === next) return;
    // The ref has to be current *before* the re-run: the palette calls the source synchronously
    // inside setSearch, so a value waiting on the next render would still be the old tab.
    filterRef.current = next;
    setFilter(next);
    context.setSearch(context.search);
  }

  function openEntry(key: string) {
    const entry = snapshotRef.current.entries.find((item) => item.key === key);
    if (!entry) return;
    const target = entry.target;
    if (target.kind === "workspace") props.onOpenWorkspace(target.workspaceId);
    else if (target.kind === "terminal") props.onOpenTerminal(target.workspaceId, target.taskId);
    else props.onOpenDevice(target.daemonId);
  }

  return (
    <CommandPalette<PaletteItem>
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      searchSource={searchSource}
      onValueChange={openEntry}
      label="快速跳转"
      emptyBootstrapText="还没有去过别处，输入关键字搜索工作区、终端或设备"
      emptySearchText="没有匹配的工作区、终端或设备"
      renderItem={(item) => <PaletteRow entry={item.auxiliaryData.entry} />}
      input={<PaletteHeader filter={filter} onFilterChange={changeFilter} />}
      footer={
        <CommandPaletteFooter>
          <span className="flex items-center gap-1">
            <Kbd keys="up" />
            <Kbd keys="down" />
            选择
          </span>
          <span className="flex items-center gap-1">
            <Kbd keys="enter" />
            打开
          </span>
          <span className="flex items-center gap-1">
            <Kbd keys="mod+[" />
            <Kbd keys="mod+]" />
            切换类别
          </span>
          <span className="flex items-center gap-1">
            <Kbd keys="escape" />
            关闭
          </span>
        </CommandPaletteFooter>
      }
    />
  );
}
