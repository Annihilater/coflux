/**
 * OSC 52 载荷解析：远端程序往 PTY 写 `ESC ] 52 ; <selection> ; <base64> BEL`，想把一段文本
 * 放进「你面前这台机器」的剪贴板。supervisor 原样透传 PTY 字节，序列完整到达渲染层。
 *
 * xterm 6.0.0 自带的 OSC handler 里没有 52，@xterm/addon-clipboard 也没装——解析自己写，
 * 是因为三条行为都必须由我们决定，而不是由某个 addon 的默认值决定：
 *
 * 1. **查询（载荷是 `?`）永远不回一个字节**。addon 的设计就是回一条 OSC 52 应答，
 *    哪怕 provider 返回空串也照回——那等于把剪贴板交给远端跑的任意程序读。
 * 2. 上限压在**编码后的长度**上，先拒再解码：解码本身就是要防的那次分配。
 *    （它挡不住 xterm 缓冲整条 OSC——那发生在 handler 被调用之前，xterm 自有 10MB 上限；
 *    这里只约束进剪贴板与过 IPC 的量。）
 * 3. base64 → 字节 → 严格 UTF-8，链条上任何一环失败就整条丢弃。宁可不复制，也不能把
 *    `atob()` 的 Latin-1 原文（中文 / emoji / 重音字母全成乱码）或半截内容塞进剪贴板。
 *
 * 纯函数，不碰 Electron / DOM：渲染层单测在纯 Node 下跑。
 */

/** 编码后 base64 原文的长度上限（约 750KB 解码文本）：够贴一整份文件，又不至于让远端一条
 * 序列把主进程 IPC 撑爆。与 ipc-sanitize 里对**解码后文本**的上限是两道独立的闸。 */
export const OSC52_MAX_ENCODED_LENGTH = 1_000_000;

export type Osc52Payload =
  /** 合法的剪贴板写入；text 已是解码后的 Unicode 文本，可直接交给系统剪贴板 */
  | { kind: "write"; text: string }
  /** 读取请求：消费掉，不回任何字节 */
  | { kind: "query" }
  /** 不针对剪贴板 / 形状不对 / 超限 / 解不出来：什么都不做，剪贴板原样保留 */
  | { kind: "ignore" };

/**
 * selection 参数是一串单字母：c=clipboard、p=primary、q=secondary、s=select、0-7=cut buffer。
 * 只认系统剪贴板：显式带 c，或按惯例留空（空等价于 s0，落到剪贴板）；为与留空一致，
 * 显式的 s 也算。只写 primary / secondary / cut buffer 的序列碰不到系统剪贴板，忽略。
 */
function targetsClipboard(selection: string): boolean {
  if (selection.length === 0) return true;
  if (!/^[cpqs0-7]+$/.test(selection)) return false;
  return selection.includes("c") || selection.includes("s");
}

/** 严格 base64 解码；字符集不对、长度补不齐、atob 抛错一律 null（不做任何"尽力而为"的容错）。 */
function decodeBase64(payload: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  const remainder = payload.length % 4;
  if (remainder === 1) return null; // 补几个 = 都凑不出合法长度
  const padded = remainder === 0 ? payload : payload + "=".repeat(4 - remainder);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** fatal:true 是这里的全部意义：非法 UTF-8 抛错而不是替换成 U+FFFD，我们据此整条丢弃。
 * decode() 不带 stream 每次都重置状态，实例可复用。 */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 解析 xterm OSC handler 交来的 52 号载荷（`52;` 之后的全部内容，形如 `c;aGVsbG8=`）。
 * 空载荷按"忽略"处理：规范里那是"清空剪贴板"，远端程序没资格替用户清掉。
 */
export function parseOsc52Payload(data: string): Osc52Payload {
  const separator = data.indexOf(";");
  if (separator < 0) return { kind: "ignore" }; // 连 selection 分隔符都没有，形状不对
  const selection = data.slice(0, separator);
  const payload = data.slice(separator + 1);
  if (!targetsClipboard(selection)) return { kind: "ignore" };
  if (payload === "?") return { kind: "query" };
  if (payload.length === 0 || payload.length > OSC52_MAX_ENCODED_LENGTH) return { kind: "ignore" };
  const bytes = decodeBase64(payload);
  if (!bytes || bytes.length === 0) return { kind: "ignore" };
  const text = decodeUtf8(bytes);
  if (text === null || text.length === 0) return { kind: "ignore" };
  return { kind: "write", text };
}
