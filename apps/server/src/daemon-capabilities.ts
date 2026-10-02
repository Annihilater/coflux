/**
 * daemon 认证/登记时宣告的控制面能力名（plan 091）。中心按能力名而不是 worker 版本号做门禁：
 * dev/测试的 worker 上报 `builtin`，仓库的自动升级也刻意不做 semver 比较；而旧 worker 对未知
 * ServerToDaemon 载荷是静默丢弃的——不设门禁，agent 会白等到超时且没有任何可读原因。
 *
 * 能力名是协议契约的一部分，与 crates/worker/src/main.rs 的常量保持一致；新增控制消息时同步加名字。
 */

/** 认识 PreparedDeviceOperationExecute：中心可触发已安装 prepared 操作的执行（建/删 worktree、建会话）。 */
export const DAEMON_CAPABILITY_PREPARED_EXECUTE = "prepared_execute";
/** 认识 ServerAgentRequest：中心可经 daemon 读命令日志/快照、往终端写输入。 */
export const DAEMON_CAPABILITY_TERMINAL_IO = "terminal_io";
/** 认识 ServerExecRun：中心可在该设备上一次性执行一条 `sh -c` 命令（`coflux device exec`，不是终端）。 */
export const DAEMON_CAPABILITY_DEVICE_EXEC = "device_exec";
/** 认识 ExecutorSettingsUpdate：中心下发的 executor 模型配置会被落成本机缓存文件（plan 20260918）。
 * 这条下发是 push、没有回执路径，所以门禁必须在**发送前**判定：不具备就不发，由桌面侧超时后给出
 * 「本机 daemon 版本过旧」的可读提示。 */
export const DAEMON_CAPABILITY_EXECUTOR_SETTINGS = "executor_settings_v1";
/** This daemon's lifecycle belongs to Coflux Desktop (plan 20261002-runtime-follows-app): the app
 * moves the runtime onto its bundled version by itself, so its worker version is always the app's.
 * The centre never hot-pushes a worker into it — the automatic sweep skips it and a client's
 * upgrade request is refused. Not a gate on a control message: it is the opposite, an opt-out. */
export const DAEMON_CAPABILITY_DESKTOP_MANAGED = "desktop_managed";
/** This daemon runs as `coflux-runtime` under `coflux-launcher` (plan 20261002-runtime-launcher-merge),
 * which can stage, observe and roll back a pushed runtime release. The centre pushes a schema 3
 * `runtime` only to daemons that carry it, and a schema 2 worker only to daemons that do not.
 * Same spelling as `coflux_protocol::launcher::RUNTIME_LAUNCHER_CAPABILITY`. */
export const DAEMON_CAPABILITY_RUNTIME_LAUNCHER = "runtime_launcher_v1";

/** The error a client gets for an upgrade request aimed at a desktop-managed daemon. */
export function daemonManagedByDesktop(deviceName: string): string {
  return `该设备的运行组件由 Coflux 桌面应用管理，随应用一起更新（${deviceName}），不接受远程升级`;
}

/** The error a client gets for an upgrade request aimed at a daemon without a launcher. */
export function daemonLacksLauncher(deviceName: string): string {
  return `该设备的 daemon 过旧（${deviceName}）：在该设备上运行 \`npm i -g cofluxd@latest && cofluxd update && cofluxd restart\` 后才接受运行组件更新`;
}

/** 写 tool 在缺失能力时返回的可读错误；SKILL/文档里以「需要升级」一词指代它。 */
export function daemonUpgradeRequired(deviceName: string): string {
  return `该设备的 daemon 需要升级（${deviceName}）：在该设备上运行 \`cofluxd update && cofluxd restart\` 后重试`;
}
