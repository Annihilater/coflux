import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ScrollText, X } from "lucide-react";

import {
  loadTranscript,
  type TranscriptEntry,
  type TranscriptExec,
  type TranscriptResult,
} from "@/components/workbench/terminal-transcript";

/**
 * 会话纸面（plan 20260919）：把当前终端里那个 agent 的整段对话摊成一页可以随便框选复制的纸。
 *
 * 为什么需要它：claude / codex 都经 Ink 渲染，**自己**按终端宽度折行，每一条视觉行都带一个
 * 真换行加缩进前缀。xterm 的选区本身处理软折行是对的，所以复制出来的每个换行都是应用真的
 * 发出过的——终端这侧无解。唯一没被折过的正文在 agent 自己的记录文件里。
 *
 * 三条形态上的定调（已与用户敲定，勿改）：展开 200–260ms、ease-out，收起约 160ms 快一档；
 * 纸面跟随主题、比终端亮一档、**绝不纯白**；正文是 Markdown **源码**、不渲染——这正是"粘贴
 * 出来就是作者原文"的原因，也让依赖数保持为零。
 */

/** 展开/收起时长：这动画一天要看几十次，过 300ms 就从惊喜变成等待。 */
const EXPAND_MS = 230;
const COLLAPSE_MS = 160;
/** 收拢态的半径：刚好罩住按钮，于是纸面看起来是从按钮里长出来的。 */
const SEED_RADIUS = 16;

type TerminalPaperProps = {
  /** 内置 agent 名（claude / codex）。 */
  agent: string;
  /** agent 自己的会话标识；调用方已确认可用。 */
  agentSessionId: string;
  workspaceId: string;
  /** 直接就是 `client.execInWorkspace`：它本身就按工作区归属路由，本地远程同一条路。 */
  exec: TranscriptExec;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** ⌘F 查找框占着同一个角（right-4 top-2）：它开着时按钮让位。 */
  buttonHidden: boolean;
  /** 收起之后把焦点还给终端。 */
  onRestoreFocus: () => void;
};

export function TerminalPaper(props: TerminalPaperProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const execRef = useRef(props.exec);

  // mounted 与 open 刻意分开：收起动画跑完之前纸面还得留在 DOM 里。
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [circle, setCircle] = useState({ x: 0, y: 0, radius: 0 });
  const [result, setResult] = useState<TranscriptResult | null>(null);

  /** 圆心取按钮中心，半径取到四角的最远距离——于是纸面正好在盖满的那一刻停住。 */
  const measure = useCallback(() => {
    const layer = layerRef.current;
    const button = buttonRef.current;
    if (!layer || !button) return;
    const box = layer.getBoundingClientRect();
    const dot = button.getBoundingClientRect();
    const x = dot.left + dot.width / 2 - box.left;
    const y = dot.top + dot.height / 2 - box.top;
    setCircle({
      x,
      y,
      radius: Math.max(
        Math.hypot(x, y),
        Math.hypot(box.width - x, y),
        Math.hypot(x, box.height - y),
        Math.hypot(box.width - x, box.height - y),
      ),
    });
  }, []);

  // 挂上之后先量一次再放大：首帧必须是收拢态，否则看不到"从按钮里长出来"。
  // 依赖里带 open 是为了"收起动画还没跑完又点开"——那时 mounted 一直是 true，
  // 只看 mounted 的话 expanded 永远回不到 true，纸面就卡在收拢态了。
  useLayoutEffect(() => {
    if (!mounted || !props.open) return;
    measure();
    const frame = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(frame);
  }, [mounted, props.open, measure]);

  // 窗口尺寸变了，最远角也就变了；不重算的话四角会露出终端。
  useEffect(() => {
    if (!mounted) return;
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [mounted, measure]);

  useEffect(() => {
    if (props.open) setMounted(true);
    else setExpanded(false);
  }, [props.open]);

  useEffect(() => {
    execRef.current = props.exec;
  }, [props.exec]);

  // 收起动画跑完才卸载并清掉快照——下次打开重新取一次，不做实时跟随。
  const onRestoreFocus = props.onRestoreFocus;
  useEffect(() => {
    if (props.open || !mounted || expanded) return;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setResult(null);
      onRestoreFocus();
    }, COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [props.open, mounted, expanded, onRestoreFocus]);

  // 打开即取一次快照。
  const { agent, agentSessionId, workspaceId } = props;
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    setResult(null);
    void loadTranscript(execRef.current, { agent, agentSessionId, workspaceId }).then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [mounted, agent, agentSessionId, workspaceId]);

  // 落在最新的一条上（记录文件是时间正序，最新在末尾）。
  useLayoutEffect(() => {
    if (!mounted || result === null) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [mounted, result]);

  const onOpenChange = props.onOpenChange;
  const requestClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  /**
   * Esc 走 window 的 capture 阶段。这一条不是洁癖：Esc 不是 ⌘ 组合键，终端的按键归属判定会把它
   * 判给终端并原样写进 PTY（terminal-pane.tsx 的 decideTerminalKeyOwner），而一个到得了
   * Claude Code 的 Esc 会打断它正在进行的回合——比纸面关不掉严重得多。焦点本来就在纸面上，
   * 这里是第二道保险。
   */
  useEffect(() => {
    if (!mounted) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      requestClose();
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [mounted, requestClose]);

  // 纸面自己收下焦点，终端那侧连 keydown 都收不到。
  useEffect(() => {
    if (!mounted) return;
    scrollRef.current?.focus({ preventScroll: true });
  }, [mounted]);

  function toggle() {
    if (props.open) {
      requestClose();
      return;
    }
    // 先量后开：首帧就得拿到正确的圆心，否则第一次展开会从左上角冒出来。
    measure();
    onOpenChange(true);
  }

  const showButton = props.open || !props.buttonHidden;

  return (
    // 整层不吃鼠标事件，按钮与纸面各自收回来；本层不设 z-index，于是子元素的层级与查找框
    // （z-20）、链接提示（z-30）在同一个层叠上下文里比较。
    <div ref={layerRef} className="pointer-events-none absolute inset-0">
      {mounted ? (
        <div
          className="pointer-events-auto absolute inset-0 z-40 overflow-hidden bg-popover"
          style={{
            clipPath: `circle(${expanded ? circle.radius : SEED_RADIUS}px at ${circle.x}px ${circle.y}px)`,
            transitionProperty: "clip-path",
            transitionDuration: `${expanded ? EXPAND_MS : COLLAPSE_MS}ms`,
            // 展开快起慢收（ease-out），收起换一条更利落的曲线并快一档。
            transitionTimingFunction: expanded ? "cubic-bezier(0.22, 1, 0.36, 1)" : "cubic-bezier(0.4, 0, 1, 1)",
          }}
        >
          <div
            ref={scrollRef}
            tabIndex={-1}
            aria-label="会话纸面"
            className="h-full w-full cursor-text select-text overflow-y-auto outline-none"
          >
            {/* 单栏窄版心 + 系统 UI 字体：与终端的等宽字一起，这两样才是"这是纸不是终端"的由来，
                不靠一个刺眼的白底（夜里会炸眼，纸面颜色跟随主题）。 */}
            <div className="mx-auto max-w-[68ch] px-8 pb-16 pt-6 font-sans text-base leading-[1.85]">
              <PaperHeader agent={props.agent} />
              <PaperBody result={result} />
            </div>
          </div>
        </div>
      ) : null}
      {showButton ? (
        <Tooltip content={props.open ? "收起会话纸面" : "把这段对话摊成一页"}>
          <button
            ref={buttonRef}
            // z-50：压在纸面（z-40）之上，于是"再点一次按钮收起"成立——按钮始终在原地。
            className="pointer-events-auto absolute right-4 top-2 z-50 flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            aria-label={props.open ? "收起会话纸面" : "展开会话纸面"}
            aria-expanded={props.open}
            onClick={toggle}
          >
            {props.open ? <X className="size-3.5" /> : <ScrollText className="size-3.5" />}
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** 贴在顶上：页面开局落在最新一条，不粘住的话这行提示一上来就在视野外。
 *  select-none 是为了整页框选时它不会混进复制出来的正文。 */
function PaperHeader({ agent }: { agent: string }) {
  return (
    <div className="sticky top-0 z-10 mb-6 flex select-none items-baseline gap-2 border-b border-border bg-popover pb-3 pr-10 pt-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">会话纸面</span>
      <span>{agent}</span>
      <span className="ml-auto">Esc 收起</span>
    </div>
  );
}

function PaperBody({ result }: { result: TranscriptResult | null }) {
  if (result === null) return <PaperNote title="正在读取会话记录…" />;
  if (result.status === "not-found") {
    return (
      <PaperNote
        title="没找到这个会话的记录文件"
        detail="agent 可能刚起来还没写下第一条，或者它的记录目录被 CLAUDE_CONFIG_DIR / CODEX_HOME 挪到了别处。daemon 以后台服务运行，环境变量与你的交互式 shell 未必一致。"
      />
    );
  }
  if (result.status === "failed") return <PaperNote title="读取失败" detail={result.detail} />;
  const { entries, truncated } = result.document;
  if (entries.length === 0) {
    return <PaperNote title="这段会话还没有可显示的内容" detail="记录文件读到了，但里面还没有人类提问或 agent 正文。" />;
  }
  return (
    <div className="space-y-5">
      {truncated ? (
        <p className="text-xs text-muted-foreground">⋯ 更早的内容已省略：只读取了记录文件末尾的一段。</p>
      ) : null}
      {entries.map((entry, index) => (
        <PaperEntry key={index} entry={entry} />
      ))}
    </div>
  );
}

function PaperEntry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "tool") {
    // 工具调用只当路标：一行、灰、永不展开。
    return <p className="truncate font-mono text-xs text-muted-foreground">⏺ {entry.label}</p>;
  }
  if (entry.kind === "prompt") {
    // 自己的话带一道浅浅的竖线，滚动时用它当锚点。
    return (
      <p className="whitespace-pre-wrap break-words border-l-2 border-foreground/25 pl-4 text-foreground">{entry.text}</p>
    );
  }
  // 正文原样铺开：whitespace-pre-wrap 保住作者写下的换行、让浏览器负责软折行——于是框选复制
  // 出来的是连续的散文，没有硬换行也没有缩进前缀。这里刻意不渲染 Markdown。
  return <p className="whitespace-pre-wrap break-words text-foreground/90">{entry.text}</p>;
}

function PaperNote({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="space-y-2 py-6">
      <p className="text-sm text-foreground">{title}</p>
      {detail ? <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p> : null}
    </div>
  );
}
