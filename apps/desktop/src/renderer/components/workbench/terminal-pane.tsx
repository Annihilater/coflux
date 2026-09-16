import { useEffect, useRef, useState } from "react";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type IDecoration, type IMarker } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ContextMenu, type ContextMenuOption } from "@astryxdesign/core/ContextMenu";
import { useToast } from "@astryxdesign/core/Toast";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { FsWriteResult } from "@coflux/client";

import { commandOutputText, createCommandMarkReader } from "@/components/workbench/terminal-command-marks";
import {
  canSendTerminalInput,
  canSendTerminalResize,
  type TerminalControlState,
} from "@/components/workbench/terminal-control-state";
import { findFileReferences, readTerminalLine } from "@/components/workbench/terminal-file-references";
import { decideTerminalFit, TERMINAL_FIT_LIMITS, type TerminalFitProposal } from "@/components/workbench/terminal-fit";
import { applyImeCommittedInputPatch, type XtermCoreInternals } from "@/components/workbench/terminal-ime-patch";
import { shouldOpenTerminalLink } from "@/components/workbench/terminal-link-activation";
import { SHORTCUT_MODIFIER_PREFIX } from "@/components/workbench/shortcut-modifier";

/** 控制权状态与输入门控的真相源在 terminal-control-state.ts（纯值语义，可无 DOM 单测）；
 * 这里原样再导出，调用方（terminal-attach.ts 等）的 import 路径不变。 */
export type { TerminalControlState };

export type TerminalController = {
  dimensions: () => { cols: number; rows: number };
  fit: () => void;
  focus: () => void;
  reset: () => void;
  writeSystem: (message: string, tone?: "warning" | "error" | "success") => void;
  /** 原样写入（plan 097 回放已退出终端的最后输出用）：不经 session consumer，不 reset。 */
  writeRaw: (data: Uint8Array | string) => void;
};

type TerminalPaneProps = {
  taskId: string;
  sessionId: string | null;
  workspaceId: string;
  active: boolean;
  controlState: TerminalControlState;
  registerSessionConsumer: (sessionId: string, consumer: (data: Uint8Array, replace: boolean) => void) => () => void;
  sendInput: (sessionId: string, data: string) => void;
  sendResize: (sessionId: string, cols: number, rows: number) => void;
  sendFsWrite: (workspaceId: string, path: string, data: Uint8Array, temp: boolean) => Promise<FsWriteResult>;
  onReady: (taskId: string, controller: TerminalController) => void;
  onDispose: (taskId: string, controller: TerminalController) => void;
  onSessionReady: (taskId: string, sessionId: string, controller: TerminalController) => void;
  onOutput: (taskId: string, sessionId: string) => void;
};

// 终端贴图（plan 014）的压缩目标独立于文件上传上限，保持 3.5MB 以节省截图传输带宽。
const PASTE_BUDGET_BYTES = 3.5 * 1024 * 1024;
const PASTE_MIN_DIMENSION = 64; // 降分辨率的下限：避免退化成不可读的一两个像素
// 拖拽文件上传上限须与 server maxPayload、worker MAX_WRITE_BYTES 同为 30MB；任一偏小都会让前端放行后被下游拒绝。
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

/** ⌘F 查找的高亮：颜色只接受 #RRGGBB，取自上面的终端主题。开着 decorations 才有
 * onDidChangeResults（命中计数），所以它不是纯装饰。 */
const SEARCH_OPTIONS: ISearchOptions = {
  decorations: {
    matchBackground: "#3a3a3a",
    matchOverviewRuler: "#6a6a6a",
    activeMatchBackground: "#c9a227",
    activeMatchColorOverviewRuler: "#c9a227",
  },
};

const NO_SEARCH_RESULTS = { index: -1, count: 0 };

/**
 * Astryx 的 ContextMenu 触发区默认「包住内容」，而终端要整块可右键。
 * 仓库没有编译 StyleX，triggerXstyle 用不了，只能拿到元素后直接铺满。
 */
function fillContextMenuTrigger(element: HTMLDivElement | null): void {
  if (!element) return;
  element.style.width = "100%";
  element.style.height = "100%";
}

/** 命令装饰条的颜色，取自上面的终端主题。 */
const COMMAND_COLORS = { running: "#6a6a6a", success: "#4fae6e", failure: "#e05c6a", unknown: "#c9a227" } as const;
/** 命令账本上限：markers 会随 scrollback 裁剪自行 dispose，这条只是防病态输出把账本撑爆。 */
const MAX_TRACKED_COMMANDS = 500;

/** 命令导航（OSC 133）对 React 层暴露的接口；账本本身活在挂载期闭包里。 */
type TerminalCommandNavigation = {
  count: () => number;
  /** 滚到上/下一个提示符。 */
  scrollBy: (delta: -1 | 1) => void;
  /** 最后一条已结束命令的输出；没有则返回 null。 */
  lastOutput: () => string | null;
  /** gap 恢复（快照覆盖）与「重新打开」时清账：快照是渲染好的屏幕，里面没有 OSC 133。 */
  clear: () => void;
};

function extForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

/** 拖拽上传使用生成式单段文件名，原扩展名只保留安全的 ASCII 字母数字，避免 temp 路径校验失败。 */
function safeDropExtension(name: string): string {
  const match = name.match(/\.([a-zA-Z0-9]{1,16})$/);
  return match ? `.${match[1]}` : "";
}

function fileFromDragItem(item: DataTransferItem): File | null {
  if (item.kind !== "file") return null;
  // 只借 entry 标记区分文件与目录，不递归展开目录；不支持该 API 的浏览器回落到标准 getAsFile。
  const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isFile: boolean } | null }).webkitGetAsEntry?.();
  if (entry && !entry.isFile) return null;
  return item.getAsFile();
}

/** 把图片压缩到预算内：先在原分辨率按 JPEG 质量阶梯降（文字截图的可读性损失最小），
 * 仍超限再减半分辨率重来；两者都到头仍超限则回落已压出的最小结果（上传若仍失败，由调用方报错）。 */
async function compressToBudget(blob: Blob, budget: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  let width = bitmap.width;
  let height = bitmap.height;
  const qualities = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
  let smallest: Blob | null = null;
  while (true) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of qualities) {
      const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!encoded) continue;
      if (!smallest || encoded.size < smallest.size) smallest = encoded;
      if (encoded.size <= budget) return new Uint8Array(await encoded.arrayBuffer());
    }
    if (Math.min(width, height) <= PASTE_MIN_DIMENSION) break;
    width /= 2;
    height /= 2;
  }
  return new Uint8Array(await (smallest ?? blob).arrayBuffer());
}

export function TerminalPane(props: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  // 上传中用光标转圈表达进行态；成功不打扰，只在失败时弹 toast 告知原因——不写进终端画面避免污染 claude 会话。
  const [isUploading, setIsUploading] = useState(false);
  const showToast = useToast();
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const commandsRef = useRef<TerminalCommandNavigation | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState(NO_SEARCH_RESULTS);
  // 右键菜单打开那一刻的终端快照：菜单项的可用性要按当下的选区算，而组件不会因为选区变化重渲染。
  const [menuSelection, setMenuSelection] = useState(false);
  const [menuCommands, setMenuCommands] = useState(0);
  // 链接悬停提示（需要修饰键才激活，不提示的话没人猜得到）；位置用 fixed，省掉容器坐标换算。
  const [linkHint, setLinkHint] = useState<{ label: string; x: number; y: number } | null>(null);

  // onData/onResize/粘贴/拖拽处理在挂载时注册一次，但要读到"当下"的 active/controlState/sessionId 等——
  // React 组件体每次渲染都跑而闭包只捕获创建时的值，故镜像进 ref（landmine 17：untrack 无直接对应物，
  // 这里反过来是"始终读最新"而非"读一次"，用同样的 ref 手段解决）。
  const liveRef = useRef({
    active: props.active,
    controlState: props.controlState,
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
    sendInput: props.sendInput,
    sendResize: props.sendResize,
    sendFsWrite: props.sendFsWrite,
    showToast,
  });
  useEffect(() => {
    liveRef.current = {
      active: props.active,
      controlState: props.controlState,
      sessionId: props.sessionId,
      workspaceId: props.workspaceId,
      sendInput: props.sendInput,
      sendResize: props.sendResize,
      sendFsWrite: props.sendFsWrite,
      showToast,
    };
  });

  // 挂载时创建 xterm 等命令式资源，只跑一次：TerminalPane 以 taskId 为 React key，
  // 同一实例生命周期内 taskId 不变，无需把 props 列进依赖数组。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      // addon-unicode11 走的是标记为 (EXPERIMENTAL) 的 terminal.unicode.register，
      // allowProposedApi 为 false 时它在 activate 阶段直接抛错（不是降级渲染），必须放行。
      allowProposedApi: true,
      convertEol: false,
      // 下面四项与 rescaleOverlappingGlyphs 一起对齐 Cursor 的默认观感（plan 20260916）：
      // 不闪的块状光标、行高 1、对比度下限 4.5。fontFamily 不动——这串在 macOS 上实际解析到的
      // 就是 Menlo（前三个字体都不存在），与 Cursor 用的是同一个。
      cursorBlink: false,
      cursorStyle: "block",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 12, // 等宽字体同 px 视觉大于 UI sans（页面 base 13px），降 1px 找平衡（VS Code 同款配比）
      lineHeight: 1,
      // 主题里 brightBlack 这类暗色按作者给的对比度渲染会糊；4.5 = WCAG AA 正文下限，
      // xterm 会按背景色把不达标的前景色提亮到刚好达标，不改主题本身。
      minimumContrastRatio: 4.5,
      // 宽度超过一格的字形（部分 Nerd Font / powerline 图标）缩放到格内，不再压住右边的字符。
      rescaleOverlappingGlyphs: true,
      scrollback: 10_000,
      // kitty 键盘协议（CSI u）：Shift+Enter 之类的组合键才有办法编码给远端 TUI。
      // 由应用在运行时协商启用，不进快照——gap 恢复后的 terminal.reset() 会让已启用它的 TUI
      // 面对一个「忘了这回事」的终端，协议级模式持久化不在本 plan 范围内。
      vtExtensions: { kittyKeyboard: true },
      theme: {
        background: "#0a0a0a",
        foreground: "#e4e4e4",
        cursor: "#e4e4e4",
        selectionBackground: "#3a3a3a88",
        black: "#1a1a1a",
        brightBlack: "#6a6a6a",
        red: "#e05c6a",
        green: "#4fae6e",
        yellow: "#c9a227",
        blue: "#6b9bd1",
        magenta: "#b07cc6",
        cyan: "#56b6c2",
        white: "#d4d4d4",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    // Unicode 11 宽度表：emoji 与全角标点按两格算，否则光标漂移、行尾留垃圾（Claude Code 首当其冲）。
    // 残留分歧（本 plan 不关）：supervisor 快照用的 vt100 走 unicode-width 0.2.2 = Unicode 17，
    // 这里是 11，Unicode 12-17 新增的字符两边宽度仍不一致，gap 恢复时表现为折行位置对不上。
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    // ⌘F 查找（命中高亮 + 计数）与 OSC 52 剪贴板。
    // OSC 52 的「读」走 navigator.clipboard.readText()，需要主进程放行 clipboard-read
    // （见 main/index.ts 的 allowedPermissions），不放行时不报错、只是什么都不发生。
    const searchAddon = new SearchAddon();
    terminal.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => setSearchResults({ index: resultIndex, count: resultCount }));
    terminal.loadAddon(new ClipboardAddon());

    // 输出中的 URL：⌘（或 Ctrl）+点击在系统浏览器打开，普通点击只聚焦终端（plan 109）。
    // 必须传自定义激活函数——插件默认的那个先调无 URL 的 window.open()、再赋 location.href，
    // 主进程对 window.open 一律 deny 且只放行 http(s) 的 URL，收到 about:blank 直接丢弃，表现为点了没反应。
    // 这里带 URL 调 window.open，主进程的 setWindowOpenHandler 拿到真实 URL 交 shell.openExternal；
    // 返回值在桌面版恒为 null（deny），不据此分支。
    terminal.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          setLinkHint(null);
          if (!shouldOpenTerminalLink(event)) return;
          window.open(uri, "_blank", "noopener");
        },
        {
          hover: (event) => setLinkHint({ label: `${SHORTCUT_MODIFIER_PREFIX} 点击打开`, x: event.clientX, y: event.clientY }),
          leave: () => setLinkHint(null),
        },
      ),
    );

    // 文件引用（`src/a.ts:12:5`）：悬停有下划线与提示，⌘+点击把原文复制到剪贴板。
    // 不是「在编辑器里打开」——工作台没有编辑器面板，而本 plan 只许动主进程的权限集合，
    // 没法新开一个打开文件的 IPC。对着 agent 终端而言，路径能一键进剪贴板就是最有用的动作。
    terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const { text, cellOf } = readTerminalLine(line);
        const references = findFileReferences(text);
        if (references.length === 0) {
          callback(undefined);
          return;
        }
        callback(
          references.map((reference) => ({
            // IBufferRange 是「1-based 含右端」，正好等于 0-based 右开端点（见 addon-web-links 的 LinkComputer）。
            range: {
              start: { x: cellOf[reference.start]! + 1, y: bufferLineNumber },
              end: { x: cellOf[reference.end]!, y: bufferLineNumber },
            },
            text: reference.text,
            decorations: { pointerCursor: true, underline: true },
            activate: (event: MouseEvent, linkText: string) => {
              setLinkHint(null);
              if (!shouldOpenTerminalLink(event)) return;
              void navigator.clipboard.writeText(linkText).then(
                () => liveRef.current.showToast({ body: `已复制 ${linkText}`, type: "info" }),
                () => liveRef.current.showToast({ body: "复制路径失败", type: "error" }),
              );
            },
            hover: (event: MouseEvent) => setLinkHint({ label: `${SHORTCUT_MODIFIER_PREFIX} 点击复制路径`, x: event.clientX, y: event.clientY }),
            leave: () => setLinkHint(null),
          })),
        );
      },
    });
    // 命令边界（OSC 133）：shell 集成早就在往流里发，这里才第一次有人接。
    // 标记只用来认边界；载荷里的会话标识全程留在 createCommandMarkReader 的闭包里
    // （不进 state、不打日志、不进错误信息，见 terminal-command-marks.ts）。
    type CommandEntry = {
      prompt: IMarker;
      decoration: IDecoration | undefined;
      element: HTMLElement | undefined;
      state: keyof typeof COMMAND_COLORS;
      start: IMarker | undefined;
      end: IMarker | undefined;
    };
    const commands: CommandEntry[] = [];
    const markReader = createCommandMarkReader();

    const paintCommand = (entry: CommandEntry) => {
      const element = entry.element;
      if (!element) return;
      // 装饰默认落在第 0 列上，会压住提示符本身；挪进 host 的 pl-3 内边距，当成 Cursor 那样的行首标记条。
      element.style.width = "3px";
      element.style.height = "100%";
      element.style.marginLeft = "-9px";
      element.style.borderRadius = "2px";
      element.style.backgroundColor = COMMAND_COLORS[entry.state];
    };
    const dropCommand = (entry: CommandEntry) => {
      const index = commands.indexOf(entry);
      if (index >= 0) commands.splice(index, 1);
      entry.decoration?.dispose();
      entry.start?.dispose();
      entry.end?.dispose();
    };
    const clearCommands = () => {
      for (const entry of [...commands]) {
        dropCommand(entry);
        entry.prompt.dispose();
      }
      commands.length = 0;
    };
    const beginCommand = () => {
      // 上一条没等到 D 就又出提示符：shell 被 exec 掉或钩子被跳过，按「未知」收尾而不是一直转。
      const previous = commands[commands.length - 1];
      if (previous && previous.state === "running") {
        previous.state = "unknown";
        paintCommand(previous);
      }
      const prompt = terminal.registerMarker(0);
      const entry: CommandEntry = {
        prompt,
        decoration: terminal.registerDecoration({ marker: prompt, x: 0, width: 1 }),
        element: undefined,
        state: "unknown",
        start: undefined,
        end: undefined,
      };
      entry.decoration?.onRender((element) => {
        entry.element = element;
        paintCommand(entry);
      });
      // marker 随 scrollback 裁剪自行 dispose，账本跟着掉这一行。
      prompt.onDispose(() => dropCommand(entry));
      commands.push(entry);
      while (commands.length > MAX_TRACKED_COMMANDS) {
        const oldest = commands[0]!;
        dropCommand(oldest);
        oldest.prompt.dispose();
      }
    };
    terminal.parser.registerOscHandler(133, (data) => {
      const mark = markReader.read(data);
      if (!mark) return false;
      const current = commands[commands.length - 1];
      if (mark.kind === "prompt-start") {
        beginCommand();
      } else if (mark.kind === "command-start" && current) {
        current.start = terminal.registerMarker(0);
        current.state = "running";
        paintCommand(current);
      } else if (mark.kind === "command-end" && current) {
        current.end = terminal.registerMarker(0);
        current.state = mark.exitCode === undefined ? "unknown" : mark.exitCode === 0 ? "success" : "failure";
        paintCommand(current);
      }
      return true;
    });

    const promptLines = () => commands.map((entry) => entry.prompt.line).filter((line) => line >= 0);
    commandsRef.current = {
      count: () => commands.length,
      scrollBy: (delta) => {
        const lines = promptLines().sort((a, b) => a - b);
        const from = terminal.buffer.active.viewportY;
        const target = delta < 0 ? lines.filter((line) => line < from).pop() : lines.find((line) => line > from);
        if (target !== undefined) terminal.scrollToLine(target);
      },
      lastOutput: () => {
        const entry = [...commands].reverse().find((item) => item.start && item.start.line >= 0 && item.state !== "running");
        if (!entry?.start) return null;
        const buffer = terminal.buffer.active;
        const last = (entry.end && entry.end.line >= 0 ? entry.end.line : buffer.baseY + buffer.cursorY) - 1;
        const lines: string[] = [];
        for (let y = entry.start.line; y <= last; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
        const text = commandOutputText(lines);
        return text.length > 0 ? text : null;
      },
      clear: clearCommands,
    };

    terminal.open(host);
    // 中文 IME 直接提交的补丁踩的是 xterm 私有内部结构，失效时会静默回落成上游 bug
    // （全角 ？！ 要连按两次），typecheck 与单测都看不出来——所以这里必须吵：控制台报错 + 终端里写一行。
    const imePatch = applyImeCommittedInputPatch((terminal as unknown as { _core?: XtermCoreInternals })._core);
    terminalRef.current = terminal;

    // WebGL 渲染器动态加载（addon 约 247KB，不进首屏主 chunk）：
    // context 丢失（息屏/切显卡/驱动重置）时 dispose addon，xterm 自动回退
    // DOM 渲染器，避免白屏；实例化或 chunk 加载失败同样静默回退。
    let disposed = false;
    import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        if (disposed || !terminal.element) return; // 面板已卸载则不再挂载
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          terminal.loadAddon(webgl);
          fit(); // WebGL 用字形图集重新度量 cell，尺寸可能与挂载时的 DOM 渲染器度量有亚像素差异，补一次 fit 对齐
        } catch {
          // WebGL 不可用（无硬件加速/被禁用），保持默认 DOM 渲染器。
        }
      })
      .catch(() => {
        // chunk 加载失败（离线/网络异常），保持默认 DOM 渲染器。
      });

    // 防抖窗口里待落地的那次 fit；applyFit 与卸载都要清掉它。
    let pendingFit: number | undefined;
    const applyFit = () => {
      if (pendingFit !== undefined) {
        window.clearTimeout(pendingFit);
        pendingFit = undefined;
      }
      try {
        fitAddon.fit();
      } catch {
        // 容器切换显示的瞬间可能尚无可测尺寸，下一次观察回调会再次 fit。
      }
    };
    const fit = () => {
      if (!liveRef.current.active || !host.isConnected) return;
      // 工作区保活模式下被 display:none 隐藏时尺寸为 0：FitAddon 会把终端钳到 2×1
      // 并经 onResize 把 2×1 传给远程 PTY（远端 TUI 按 2 列重排，切回闪残影、污染镜像）。
      // 0 尺寸一律不 fit，切回显示后 WorkspaceTerminal 的 rAF fit 会用真实尺寸补上。
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // 拖窗口时 ResizeObserver 每帧都回调；六个 fit 入口全从这里过，判定统一放这儿（见 terminal-fit.ts）。
      let proposed: TerminalFitProposal;
      try {
        proposed = fitAddon.proposeDimensions();
      } catch {
        return;
      }
      const decision = decideTerminalFit({ cols: terminal.cols, rows: terminal.rows, bufferLines: terminal.buffer.active.length }, proposed);
      if (decision === "skip") return;
      if (decision === "immediate") {
        applyFit();
        return;
      }
      if (pendingFit !== undefined) window.clearTimeout(pendingFit);
      pendingFit = window.setTimeout(() => {
        pendingFit = undefined;
        // 防抖落地时面板可能已经被隐藏（尺寸归零）：那条「不可见不 fit」的性质要一直成立。
        if (!liveRef.current.active || !host.isConnected) return;
        const size = host.getBoundingClientRect();
        if (size.width === 0 || size.height === 0) return;
        applyFit();
      }, TERMINAL_FIT_LIMITS.debounceMs);
    };
    const controller: TerminalController = {
      dimensions: () => ({ cols: terminal.cols, rows: terminal.rows }),
      fit,
      focus: () => terminal.focus(),
      reset: () => {
        terminal.reset();
        terminal.clear();
        clearCommands();
      },
      writeSystem: (message, tone = "warning") => {
        const color = tone === "error" ? "31" : tone === "success" ? "32" : "33";
        terminal.writeln(`\r\n\x1b[${color}m[${message}]\x1b[0m`);
      },
      writeRaw: (data) => {
        terminal.write(data);
      },
    };
    controllerRef.current = controller;
    if (!imePatch.applied) {
      console.error("xterm 的 IME 提交补丁未生效，缺失内部字段：", imePatch.missing.join(", "));
      controller.writeSystem("输入法补丁未生效（xterm 内部结构已变），全角标点可能需连按两次", "error");
    }
    props.onReady(props.taskId, controller);

    // 输入/resize 的门控见 terminal-control-state.ts（输入含 attaching，尺寸只在 owned）。
    terminal.onData((data) => {
      const { active, controlState, sessionId, sendInput } = liveRef.current;
      if (active && canSendTerminalInput(controlState) && sessionId) sendInput(sessionId, data);
    });
    terminal.onResize(({ cols, rows }) => {
      const { active, controlState, sessionId, sendResize } = liveRef.current;
      if (active && canSendTerminalResize(controlState) && sessionId) sendResize(sessionId, cols, rows);
    });

    // 剪贴板贴图（plan 014）：capture 阶段挂在 host（xterm textarea 的祖先）上，
    // 抢在 xterm 自己给 textarea 注册的 paste 监听之前拦截——只处理 image/*，
    // 文本粘贴不 preventDefault，原样落到 xterm 默认行为，行为不变。
    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const imageItem = [...items].find((item) => item.type.startsWith("image/"));
      if (!imageItem) return;
      event.preventDefault();
      event.stopPropagation();

      const { active, controlState, sessionId, workspaceId, sendFsWrite } = liveRef.current;
      if (!(active && controlState === "owned" && sessionId)) {
        controllerRef.current?.writeSystem("未持有控制权，无法粘贴图片", "warning");
        return;
      }
      const blob = imageItem.getAsFile();
      if (!blob) return;

      void (async () => {
        try {
          const bytes =
            blob.size > PASTE_BUDGET_BYTES ? await compressToBudget(blob, PASTE_BUDGET_BYTES) : new Uint8Array(await blob.arrayBuffer());
          const ext = extForMime(blob.size > PASTE_BUDGET_BYTES ? "image/jpeg" : blob.type);
          const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
          // temp=true：落 daemon 侧系统临时目录，name 是单段文件名（不拼目录前缀）；
          // 回带的 result.path 是 worker 侧确定的绝对路径，直接注入。
          const result = await sendFsWrite(workspaceId, name, bytes, true);
          if (result.ok && result.path) {
            terminal.paste(` ${result.path} `);
          } else {
            controllerRef.current?.writeSystem(`图片上传失败：${result.error}`, "error");
          }
        } catch (e) {
          controllerRef.current?.writeSystem(`图片处理失败：${e instanceof Error ? e.message : String(e)}`, "error");
        }
      })();
    };
    host.addEventListener("paste", handlePaste, { capture: true });

    const hasFileTransfer = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const handleDragEnter = (event: DragEvent) => {
      if (!hasFileTransfer(event)) return;
      event.preventDefault();
      setIsDraggingFile(true);
    };
    const handleDragOver = (event: DragEvent) => {
      if (!hasFileTransfer(event)) return;
      event.preventDefault(); // 必须拦截，否则浏览器会拒绝 drop 或把文件导航到当前页面。
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setIsDraggingFile(true);
    };
    const handleDragLeave = (event: DragEvent) => {
      const nextTarget = event.relatedTarget;
      // host 内子元素之间移动会冒泡出 dragleave；只有真正离开整个终端区域才隐藏遮罩。
      if (nextTarget instanceof Node && host.contains(nextTarget)) return;
      setIsDraggingFile(false);
    };
    const handleDrop = (event: DragEvent) => {
      event.preventDefault(); // 防止浏览器用拖入文件替换当前页面。
      setIsDraggingFile(false);

      const files = Array.from(event.dataTransfer?.items ?? []).map(fileFromDragItem).filter((file): file is File => file !== null);
      if (files.length === 0) return; // 文件夹不递归展开，也不打扰用户。

      const { active, controlState, sessionId, workspaceId, sendFsWrite, showToast } = liveRef.current;
      if (!(active && controlState === "owned" && sessionId)) {
        showToast({ body: "未持有控制权，无法上传文件", type: "error" });
        return;
      }

      const uploadableFiles = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
      const rejectedCount = files.length - uploadableFiles.length;
      if (rejectedCount > 0) {
        showToast({ body: `${rejectedCount} 个文件超过 30MB，已拒绝上传`, type: "error" });
      }
      if (uploadableFiles.length === 0) return;

      setIsUploading(true);
      void (async () => {
        const uploadedPaths: string[] = [];
        for (const file of uploadableFiles) {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const name = `drop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeDropExtension(file.name)}`;
            const result = await sendFsWrite(workspaceId, name, bytes, true);
            if (result.ok && result.path) {
              uploadedPaths.push(result.path);
            } else {
              showToast({ body: `文件上传失败：${result.error}`, type: "error" });
            }
          } catch (e) {
            showToast({ body: `文件上传失败：${e instanceof Error ? e.message : String(e)}`, type: "error" });
          }
        }
        setIsUploading(false);
        if (uploadedPaths.length > 0) {
          terminal.paste(` ${uploadedPaths.join(" ")} `);
        }
      })();
    };
    host.addEventListener("dragenter", handleDragEnter);
    host.addEventListener("dragover", handleDragOver);
    host.addEventListener("dragleave", handleDragLeave);
    host.addEventListener("drop", handleDrop);

    const observer = new ResizeObserver(() => fit());
    observer.observe(host);
    if (props.active) requestAnimationFrame(() => fit());

    // devicePixelRatio 变化（浏览器缩放、拖跨不同缩放比的显示器）后 xterm 按新 dpr
    // 重新取整 cell 尺寸，host CSS 尺寸不变、ResizeObserver 不会触发，需主动补 fit。
    // media query 字符串绑定的是创建时的 dpr 值，change 只在离开该值时触发一次，
    // 故每次触发后以新 dpr 自递归重建监听。
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      fit();
      watchDpr();
    };
    const watchDpr = () => {
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDprChange, { once: true });
    };
    watchDpr();

    return () => {
      disposed = true;
      observer.disconnect();
      if (pendingFit !== undefined) window.clearTimeout(pendingFit);
      dprQuery?.removeEventListener("change", onDprChange);
      host.removeEventListener("paste", handlePaste, { capture: true });
      host.removeEventListener("dragenter", handleDragEnter);
      host.removeEventListener("dragover", handleDragOver);
      host.removeEventListener("dragleave", handleDragLeave);
      host.removeEventListener("drop", handleDrop);
      props.onDispose(props.taskId, controller);
      terminal.dispose(); // 一并 dispose 已挂载的 addons（fit/webgl/search/clipboard/unicode11）与输入监听
      terminalRef.current = null;
      controllerRef.current = null;
      searchAddonRef.current = null;
      commandsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // sessionReady 门控：先注册 ptyOutput consumer，再通知上层可以 attach——
  // 否则 attach 回放的 scrollback 字节会在 consumer 注册前到达而丢失。
  useEffect(() => {
    const sessionId = props.sessionId;
    const terminal = terminalRef.current;
    const controller = controllerRef.current;
    if (!sessionId || !terminal || !controller) return;
    const unregister = props.registerSessionConsumer(sessionId, (data, replace) => {
      if (replace) {
        // gap 恢复：快照是渲染好的屏幕，里面没有 OSC 133，旧的命令边界跟着这一屏一起作废。
        terminal.reset();
        commandsRef.current?.clear();
      }
      terminal.write(data);
      props.onOutput(props.taskId, sessionId);
    });
    props.onSessionReady(props.taskId, sessionId, controller);
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  useEffect(() => {
    if (!props.active) return;
    const frame = requestAnimationFrame(() => {
      controllerRef.current?.fit();
      controllerRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.active]);

  // 查找与右键菜单的动作：都在组件体里定义（由 React 事件触发，闭包捕获的就是当下的 props，
  // 不像挂载期注册的那批必须经 liveRef）。
  function runSearch(term: string, direction: "next" | "previous", incremental = false) {
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (term.length === 0) {
      addon.clearDecorations();
      setSearchResults(NO_SEARCH_RESULTS);
      return;
    }
    if (direction === "next") addon.findNext(term, { ...SEARCH_OPTIONS, incremental });
    else addon.findPrevious(term, SEARCH_OPTIONS);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchResults(NO_SEARCH_RESULTS);
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  }

  function copySelection() {
    const text = terminalRef.current?.getSelection() ?? "";
    if (text.length === 0) return;
    void navigator.clipboard.writeText(text).catch(() => showToast({ body: "复制失败", type: "error" }));
  }

  function pasteFromClipboard() {
    void navigator.clipboard.readText().then(
      (text) => {
        if (text.length > 0) terminalRef.current?.paste(text);
      },
      () => showToast({ body: "读取剪贴板失败", type: "error" }),
    );
  }

  function copyLastCommandOutput() {
    const text = commandsRef.current?.lastOutput() ?? null;
    if (text === null) {
      showToast({ body: "没有可复制的命令输出", type: "error" });
      return;
    }
    void navigator.clipboard.writeText(text).catch(() => showToast({ body: "复制失败", type: "error" }));
  }

  // ⌘F / ⌘↑ / ⌘↓：挂在 window capture 阶段，只有可见面板响应。use-global-shortcuts 的纯 ⌘ 前缀里
  // 没有这几个键位，不会互相抢；这里要 preventDefault，否则组合键会被编码下发给远端 shell。
  useEffect(() => {
    if (!props.active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.code === "KeyF") {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
        // 已经开着时 searchOpen 不变、下面那个 effect 不会重跑，这里补上「换个词重搜」的全选。
        searchInputRef.current?.select();
        return;
      }
      if (event.code !== "ArrowUp" && event.code !== "ArrowDown") return;
      event.preventDefault();
      event.stopPropagation();
      commandsRef.current?.scrollBy(event.code === "ArrowUp" ? -1 : 1);
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [props.active]);

  // 打开查找框时聚焦并全选输入内容（再按一次 ⌘F 是「换个词重搜」而不是追加）。
  useEffect(() => {
    if (!searchOpen) return;
    const input = searchInputRef.current;
    input?.focus();
    input?.select();
  }, [searchOpen]);

  const contextMenuItems: ContextMenuOption[] = [
    { label: "复制", isDisabled: !menuSelection, onClick: copySelection },
    { label: "粘贴", onClick: pasteFromClipboard },
    { type: "divider" },
    { label: "全选", onClick: () => terminalRef.current?.selectAll() },
    { label: `查找…  ${SHORTCUT_MODIFIER_PREFIX}F`, onClick: () => setSearchOpen(true) },
    { type: "divider" },
    // 命令导航（OSC 133）：没有 shell 集成的会话里一条边界都收不到，这几项就是灰的。
    { label: `上一个命令  ${SHORTCUT_MODIFIER_PREFIX}↑`, isDisabled: menuCommands === 0, onClick: () => commandsRef.current?.scrollBy(-1) },
    { label: `下一个命令  ${SHORTCUT_MODIFIER_PREFIX}↓`, isDisabled: menuCommands === 0, onClick: () => commandsRef.current?.scrollBy(1) },
    { label: "复制上一条命令的输出", isDisabled: menuCommands === 0, onClick: copyLastCommandOutput },
    { type: "divider" },
    { label: "清屏", onClick: () => terminalRef.current?.clear() },
  ];

  function handleContextMenuOpenChange(open: boolean) {
    if (open) {
      setMenuSelection(Boolean(terminalRef.current?.hasSelection()));
      setMenuCommands(commandsRef.current?.count() ?? 0);
      return;
    }
    // 菜单自己也要收焦点，等它归位后再把焦点还给终端。
    requestAnimationFrame(() => terminalRef.current?.focus());
  }

  // Tab 切换用 display 隐藏而非卸载：卸载 xterm 会丢 scrollback 与选区。
  // pointer-events-auto：面板层整体是 pointer-events-none（plan 104，见 terminal-panes.tsx），
  // 只有当前可见的面板把鼠标事件（选区、链接、拖拽上传）收回来。
  return (
    <div
      className={props.active ? "pointer-events-auto absolute inset-0 block" : "absolute inset-0 hidden"}
      aria-hidden={!props.active}
    >
      {/* macOS 上 Electron 不提供默认右键菜单，不接管的话右键完全没反应。 */}
      <ContextMenu
        ref={fillContextMenuTrigger}
        label="终端操作"
        size="sm"
        menuWidth={220}
        items={contextMenuItems}
        onOpenChange={handleContextMenuOpenChange}
      >
        <div ref={hostRef} className={`h-full w-full pb-3 pl-3 pt-2${isUploading ? " cursor-progress [&_*]:cursor-progress" : ""}`} />
      </ContextMenu>
      {searchOpen ? (
        <div className="absolute right-4 top-2 z-20 flex items-center gap-1 rounded-md border border-border bg-background/95 px-1.5 py-1 shadow-lg backdrop-blur">
          <input
            ref={searchInputRef}
            value={searchTerm}
            placeholder="查找"
            aria-label="在终端里查找"
            className="w-44 bg-transparent px-1 text-xs text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(event) => {
              setSearchTerm(event.target.value);
              runSearch(event.target.value, "next", true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              runSearch(searchTerm, event.shiftKey ? "previous" : "next");
            }}
          />
          <span className="min-w-12 text-center text-[11px] tabular-nums text-muted-foreground">
            {searchTerm.length === 0 ? "" : searchResults.count === 0 ? "无结果" : `${searchResults.index + 1}/${searchResults.count}`}
          </span>
          <button className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="上一个匹配" onClick={() => runSearch(searchTerm, "previous")}>
            <ChevronUp className="size-3.5" />
          </button>
          <button className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="下一个匹配" onClick={() => runSearch(searchTerm, "next")}>
            <ChevronDown className="size-3.5" />
          </button>
          <button className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="关闭查找" onClick={closeSearch}>
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {linkHint ? (
        <div
          className="pointer-events-none fixed z-30 rounded border border-border bg-background/95 px-1.5 py-0.5 text-[11px] text-muted-foreground shadow"
          style={{ left: linkHint.x + 12, top: linkHint.y + 16 }}
        >
          {linkHint.label}
        </div>
      ) : null}
      {isDraggingFile ? (
        <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg border border-warning/20 bg-warning/10 text-sm font-medium text-warning backdrop-blur">
          松开上传
        </div>
      ) : null}
    </div>
  );
}
