/**
 * OSC 133 命令边界标记的消费（plan 20260916）。
 *
 * 标记本来就在 PTY 字节流里流到渲染层——supervisor 用 `OscCapture::with_secret` 读它但不从流里
 * 摘掉（摘掉就要重写输出流，会动到 gap/resume 依赖的字节偏移）。这里只是终于给它注册了一个 handler。
 *
 * 形状（crates/supervisor/src/shell/{zshrc.zsh,init.bash,coflux.fish}）：
 *   OSC 133 ; A ; coflux=<secret> BEL          提示符开始
 *   OSC 133 ; C ; coflux=<secret> BEL          命令开始
 *   OSC 133 ; D ; <status> ; coflux=<secret>   命令结束
 * xterm 的 registerOscHandler 交给我们的是 `133;` 之后的部分，故 params[0] 是那个字母。
 *
 * ## secret 的处理
 *
 * secret 是 supervisor 给每个会话生成、只经环境变量交给 shell 的，渲染层没有带外的副本，
 * 只能 TOFU：第一条形状正确的标记带的值即本会话的 secret，之后必须逐字相同。shell 集成在第一个
 * 提示符之前就发 A，任何用户程序都轮不到抢在它前面，这个假设在实践中成立。
 *
 * 它**只活在这个闭包里**：不进 React state、不打日志、不进任何错误信息，返回的 mark 对象里也没有它。
 * 拒绝一条标记时不解释原因，正是为了不让它以任何形式泄到外面。
 */

export type TerminalCommandMark =
  | { kind: "prompt-start" }
  | { kind: "command-start" }
  | { kind: "command-end"; exitCode?: number };

export type CommandMarkReader = {
  /** 认得且通过鉴权则返回标记，否则返回 null（不区分「形状不对」与「secret 不对」）。 */
  read(payload: string): TerminalCommandMark | null;
};

const SECRET_PREFIX = "coflux=";
const EXIT_CODE = /^-?\d{1,10}$/;

export function createCommandMarkReader(): CommandMarkReader {
  let sessionSecret: string | null = null;
  return {
    read(payload: string): TerminalCommandMark | null {
      const params = payload.split(";");
      const mark = markOf(params);
      // 先认形状再认 secret：不然一条字段乱填的 OSC 133 就能把 TOFU 的第一枪骗走。
      if (!mark) return null;
      const presented = params
        .slice(1)
        .filter((param) => param.startsWith(SECRET_PREFIX))
        .map((param) => param.slice(SECRET_PREFIX.length))
        .filter((value) => value.length > 0);
      if (presented.length === 0) return null;
      if (sessionSecret === null) sessionSecret = presented[0]!;
      if (!presented.includes(sessionSecret)) return null;
      return mark;
    },
  };
}

function markOf(params: readonly string[]): TerminalCommandMark | null {
  switch (params[0]) {
    case "A":
      return { kind: "prompt-start" };
    case "C":
      return { kind: "command-start" };
    case "D": {
      const status = params[1];
      return { kind: "command-end", exitCode: status !== undefined && EXIT_CODE.test(status) ? Number(status) : undefined };
    }
    default:
      return null;
  }
}

/** 一条命令的输出文本：去掉尾部空行（命令与下一个提示符之间总会多出一两行）。 */
export function commandOutputText(lines: readonly string[]): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim().length === 0) end--;
  return lines.slice(0, end).join("\n");
}
