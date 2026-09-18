import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "packages/cli/cofluxd.mjs");

// plan 20260918-ptyd-terminal-custody M5：非桌面路径上 ptyd 必须独立受管——launchd 一个 plist 只能跑一个
// 程序，systemd 默认 KillMode=control-group 会在 restart 时杀整个 cgroup。仓库里没有 fixture 文件，模板
// 是 cofluxd.mjs 里的函数，用隐藏命令 `service-files` 渲染出来断言。
test("cofluxd 渲染的 plist 与 unit：ptyd 有自己的服务文件，supervisor 重启不带走它，停止仍一并停", async () => {
  const home = mkdtempSync(join(tmpdir(), "coflux-service-files-"));
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, "service-files"], {
      cwd: ROOT,
      env: { ...process.env, COFLUX_HOME: home },
      timeout: 15_000,
    });
    const files = JSON.parse(stdout);

    // launchd：两个 label，各自只跑自己的二进制；ptyd KeepAlive 自愈。
    const { supervisor: plist, ptyd: ptydPlist } = files.launchd;
    assert.match(plist.path, /com\.coflux\.daemon\.plist$/);
    assert.match(ptydPlist.path, /com\.coflux\.ptyd\.plist$/);
    assert.match(plist.text, /<string>com\.coflux\.daemon<\/string>/);
    assert.match(plist.text, new RegExp(`<string>${join(home, "bin", "coflux-supervisor").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
    assert.doesNotMatch(plist.text, /coflux-ptyd/, "supervisor 的 plist 不得启动 ptyd（supervisor 永不启动 ptyd）");
    assert.match(ptydPlist.text, /<string>com\.coflux\.ptyd<\/string>/);
    assert.match(ptydPlist.text, new RegExp(`<string>${join(home, "bin", "coflux-ptyd").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
    assert.match(ptydPlist.text, /<key>KeepAlive<\/key><true\/>/);
    assert.match(ptydPlist.text, new RegExp(`<key>COFLUX_HOME</key><string>${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));

    // systemd：ptyd 自己一个 unit；supervisor 的 unit Requires/After 它，ExecStart 只有 supervisor。
    const { supervisor: unit, ptyd: ptydUnit } = files.systemd;
    assert.match(unit.path, /coflux-daemon\.service$/);
    assert.match(ptydUnit.path, /coflux-ptyd\.service$/);
    assert.match(unit.text, /^Requires=coflux-ptyd\.service$/m);
    assert.match(unit.text, /^After=.*coflux-ptyd\.service/m);
    assert.match(unit.text, new RegExp(`^ExecStart=${join(home, "bin", "coflux-supervisor").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.doesNotMatch(unit.text, /coflux-ptyd$/m, "supervisor 的 unit 不得 ExecStart ptyd");
    assert.match(ptydUnit.text, new RegExp(`^ExecStart=${join(home, "bin", "coflux-ptyd").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(ptydUnit.text, /^Restart=always$/m);
    assert.match(ptydUnit.text, /^KillMode=process$/m, "ptyd 的 unit 停止时只发给 ptyd 本身，由它自己结束 shell");
    assert.match(ptydUnit.text, /^Environment=COFLUX_HOME=/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cofluxd help：restart 不再声称结束会话，restart --ptyd 才会", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, "help"], { cwd: ROOT, timeout: 15_000 });
  assert.match(stdout, /restart\s+重启 supervisor 应用新版本（终端留在 ptyd 里，不结束会话）/);
  assert.match(stdout, /restart --ptyd\s+连 ptyd 一起重启（⚠ 结束本机所有活会话/);
});
