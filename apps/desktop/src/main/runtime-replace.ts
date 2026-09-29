/**
 * supervisor 替换与自恢复的纯决策（plan 20260918-ptyd-terminal-custody）。I/O 全部经参数注入，
 * 便于 node --test 直接断言回滚路径与看门狗判定，不起真进程。
 */

export type ReplaceOutcome<Status> =
  | { ok: true; status: Status; rolledBack: false }
  | { ok: false; rolledBack: boolean; error: Error; rollbackError?: Error };

export type ReplaceDeps<Status> = {
  /** 让在跑的 supervisor 走 leave-sessions 退出（shell 留在 ptyd） */
  leave: () => Promise<void>;
  /** 从新目录起 supervisor；抛错 = 新版本起不来 */
  startNext: () => Promise<Status>;
  /** 从上一版目录再起一次 */
  startPrevious: () => Promise<Status>;
  /** 把运行时标记写成给定 id（新版成功写新 id；回滚写回旧 id） */
  writeMarker: (runtimeId: string) => void;
  nextId: string;
  previousId: string;
};

/**
 * 替换 supervisor：leave → 起新版 → 写标记。新版起不来就把上一版目录再起一次、标记回到旧 id，
 * 并把"更新未能应用"作为错误交给面板；终端全程留在 ptyd 里不动。
 */
export async function replaceSupervisor<Status>(deps: ReplaceDeps<Status>): Promise<ReplaceOutcome<Status>> {
  await deps.leave();
  try {
    const status = await deps.startNext();
    deps.writeMarker(deps.nextId);
    return { ok: true, status, rolledBack: false };
  } catch (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure));
    try {
      await deps.startPrevious();
      deps.writeMarker(deps.previousId);
      return { ok: false, rolledBack: true, error };
    } catch (rollback) {
      return { ok: false, rolledBack: false, error, rollbackError: rollback instanceof Error ? rollback : new Error(String(rollback)) };
    }
  }
}

export type WatchdogFacts = {
  /** ptyd 在跑（它活着就意味着用户没有主动停止本机终端） */
  ptydAlive: boolean;
  supervisorAlive: boolean;
  /** 运行时标记存在：这台 Mac 接入过，知道该从哪个目录起 */
  installed: boolean;
  /** 主进程正有动作在进行（启动/停止/替换）：不能插一脚 */
  busy: boolean;
  /** 上一次自动重启失败的时刻（ms），无则 null */
  lastFailureAt: number | null;
  now: number;
  /** 两次自动重启之间的最短间隔 */
  backoffMs: number;
};

/** 崩溃看门狗：ptyd 还在、supervisor 不在，而且不是我们自己正在换它——就该把它拉起来。 */
export function shouldRestartSupervisor(facts: WatchdogFacts): boolean {
  if (!facts.ptydAlive || facts.supervisorAlive || !facts.installed || facts.busy) return false;
  if (facts.lastFailureAt !== null && facts.now - facts.lastFailureAt < facts.backoffMs) return false;
  return true;
}
