import CofluxProtocol

/// 目录工作区（无 repo 终端，plan 045）：projectID 为空即目录工作区。
/// 判定在客户端收敛于此一处，勿在 UI 层散落裸比较（store.ts:263-264 同语义）。
public func isDirWorkspace(_ workspace: Coflux_V1_Workspace) -> Bool {
    workspace.projectID.isEmpty
}

/// 设备的 canonical 目录工作区（plan 048）：projectID 为空且 daemonID 匹配者中
/// createdAt 最早，同刻按 id 升序取第一。
///
/// 排序规则与 server 侧 terminalCreate 的幂等复用查询逐字同构（hub.ts:2949-2951）：
/// server 复用哪一行，新终端就落在哪一行，客户端必须解析出同一行，否则新开的终端
/// 会出现在页面没有渲染的那个工作区里。DB 的 uq_workspaces_directory_device 是最终
/// 防线，不是客户端可以省掉 tie-break 的理由（桌面侧只按 createdAt 排、无 id
/// tie-break，比这里松一度）。
public func canonicalDirWorkspace(
    daemonID: String,
    in workspaces: [Coflux_V1_Workspace]
) -> Coflux_V1_Workspace? {
    workspaces
        .filter { isDirWorkspace($0) && $0.daemonID == daemonID }
        .min { left, right in
            if left.createdAt != right.createdAt { return left.createdAt < right.createdAt }
            return left.id < right.id
        }
}
