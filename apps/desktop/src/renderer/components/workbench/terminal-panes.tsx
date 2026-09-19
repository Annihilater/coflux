import { useStore } from "zustand";
import type { Task } from "@coflux/protocol";
import type { CofluxClient } from "@coflux/client";

import { TerminalPane } from "@/components/workbench/terminal-pane";
import type { TerminalAttach } from "@/components/workbench/terminal-attach";
import { isUsableAgentSessionId, transcriptAgentOf } from "@/components/workbench/terminal-transcript";

/**
 * 终端面板层（plan 104）：面板挂在 Workbench 层、按 task id 建立稳定身份，与工作区容器平级。
 * 终端被搬到别的工作区对面板而言只是 workspaceId prop 变了一下——同一个 xterm 实例、选区、
 * 滚动位置全部保住，不卸载也不重挂。
 *
 * 层与工作区容器的主体占同一个网格单元（见 workbench.tsx 的两行网格），DOM 上排在容器之后，
 * 故整层 pointer-events-none：不可见时不挡住容器里的空态 /「变更」视图 / 横幅，
 * 可见的那个面板自己把 pointer-events 开回来（见 terminal-pane.tsx）。
 */
export function TerminalPanes({
  tasks,
  visibleTaskId,
  client,
  attach,
}: {
  /** 已挂过面板且仍在快照里的 task；顺序稳定，避免 React 搬动已挂载的面板节点。 */
  tasks: readonly Task[];
  visibleTaskId: string | null;
  client: CofluxClient;
  attach: TerminalAttach;
}) {
  // 会话纸面（plan 20260919）的两个入参从 presence 来：终端里跑着哪个 agent、它自己的会话标识。
  // 两者缺一按钮就不出现——每个普通 shell 角上挂一个永远点不动的灰按钮只是噪声。
  const sessionAgents = useStore(client.store, (state) => state.sessionAgents);

  return (
    <div className="pointer-events-none relative col-start-1 row-start-2 min-h-0 min-w-0">
      {tasks.map((task) => {
        const entry = task.sessionId ? sessionAgents[task.sessionId] : undefined;
        // 旧 worker、以及旧离线缓存里恢复出来的条目都没有这个字段——别信 TS 上那个 string。
        const transcriptAgent = entry ? transcriptAgentOf(entry.agent) : null;
        const agentSessionId = entry && isUsableAgentSessionId(entry.agentSessionId) ? entry.agentSessionId : null;
        return (
          <TerminalPane
            key={task.id}
            taskId={task.id}
            sessionId={task.sessionId ?? null}
            workspaceId={task.workspaceId}
            active={task.id === visibleTaskId}
            controlState={attach.stateOf(task)}
            registerSessionConsumer={client.registerSessionConsumer}
            sendInput={client.sendInput}
            sendResize={client.resizeSession}
            sendFsWrite={client.sendFsWrite}
            onReady={attach.handleTerminalReady}
            onDispose={attach.handleTerminalDispose}
            onSessionReady={attach.handleSessionReady}
            onOutput={attach.handleOutput}
            transcriptAgent={transcriptAgent}
            agentSessionId={agentSessionId}
            execInWorkspace={client.execInWorkspace}
          />
        );
      })}
    </div>
  );
}
