/**
 * 终端输出里的文件引用识别（plan 20260916 的 `file:line` 链接）。
 *
 * 纯字符串进、区间出：渲染层单测在纯 Node 下跑，没有 DOM，这里不碰 xterm 也不碰 DOM。
 * 调用方（terminal-pane.tsx）负责把字符串下标换算成 xterm 的 1-based cell 坐标。
 *
 * 判定刻意保守——宁可漏，不可把普通英文单词变成一片下划线：
 * - 带 `/` 的路径段；或
 * - `名字.扩展名` 形态（扩展名首字符是字母、总长 ≤ 10）。
 * URL 交给 addon-web-links，这里显式排除带 scheme 的 token。
 */

export type TerminalFileReference = {
  /** 原文（含 :line:col 后缀），用于展示与复制。 */
  text: string;
  /** 去掉行列后缀的路径部分。 */
  path: string;
  line?: number;
  column?: number;
  /** 在输入字符串里的下标区间，右开。 */
  start: number;
  end: number;
};

/** 结尾常见的标点：报错信息里 `at src/a.ts:1:2)` `见 a.ts,` 这类尾巴不算路径的一部分。 */
const TRAILING = new Set([".", ",", ";", ":", ")", "]", "}", "'", '"', "`", "，", "。", "、", "）", "》"]);
/** 开头常见的包裹符号。 */
const LEADING = new Set(["(", "[", "{", "'", '"', "`", "<", "（", "《"]);

const LINE_COLUMN = /^(.*?):(\d{1,7})(?::(\d{1,7}))?$/;
/** 扩展名要求 2-10 位：一位的话散文里的 `e.g` 会被当成文件。代价是裸 `main.c` 认不出来
 * （带目录的 `src/main.c` 照样认），这个方向的误伤比把正文划一片下划线便宜。 */
const NAME_WITH_EXTENSION = /^[\w~@+][\w~@+.-]*\.[A-Za-z][A-Za-z0-9]{1,9}$/;
const PATH_SEGMENT = /^[\w~@+./-]+$/;

/** 在一行文本里找出所有文件引用，按出现顺序返回。 */
export function findFileReferences(text: string): TerminalFileReference[] {
  const references: TerminalFileReference[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const raw = match[0];
    const offset = match.index ?? 0;
    let start = 0;
    let end = raw.length;
    while (start < end && LEADING.has(raw[start]!)) start++;
    while (end > start && TRAILING.has(raw[end - 1]!)) end--;
    const token = raw.slice(start, end);
    const reference = parseFileReference(token);
    if (!reference) continue;
    references.push({ ...reference, start: offset + start, end: offset + end });
  }
  return references;
}

/** xterm 的 IBufferLine / IBufferCell 里用到的那部分。xterm 没把这两个接口导出，
 * 而且单测要能造假的行，所以在这里按结构自己声明。 */
export type TerminalBufferCell = { getChars(): string; getWidth(): number };
export type TerminalBufferLine = { readonly length: number; getCell(x: number): TerminalBufferCell | undefined };

export type TerminalLineText = {
  text: string;
  /** cellOf[i] = 字符串下标 i 落在哪个 0-based cell；末尾多一位表示行末，
   * 正好用作 xterm 链接区间右端（IBufferRange.end.x 是「1-based 含右端」= 0-based 右开端点）。 */
  cellOf: number[];
};

/**
 * 把一行 buffer 读成字符串，同时记下每个字符对应的 cell。
 *
 * 宽字符（CJK / emoji）占两格，后半格 width 为 0、内容为空，必须跳过而不是当成一个空格，
 * 否则字符串下标换算回 cell 坐标时整行链接都会偏。空白 cell 的 getChars() 是空串，补一个空格
 * 才能与 translateToString 得到同一份文本。
 */
export function readTerminalLine(line: TerminalBufferLine): TerminalLineText {
  let text = "";
  const cellOf: number[] = [];
  for (let index = 0; index < line.length; index++) {
    const cell = line.getCell(index);
    if (!cell) continue;
    if (cell.getWidth() === 0) continue; // 宽字符的后半格
    const chars = cell.getChars() || " ";
    for (let offset = 0; offset < chars.length; offset++) cellOf.push(index);
    text += chars;
  }
  cellOf.push(line.length);
  return { text, cellOf };
}

/** 单个 token 的解析；不认识则返回 null。导出供单测直接盯判定规则。 */
export function parseFileReference(token: string): Omit<TerminalFileReference, "start" | "end"> | null {
  if (token.length === 0 || token.includes("://")) return null;
  let path = token;
  let line: number | undefined;
  let column: number | undefined;
  const suffix = LINE_COLUMN.exec(token);
  if (suffix) {
    path = suffix[1]!;
    line = Number(suffix[2]);
    column = suffix[3] === undefined ? undefined : Number(suffix[3]);
  }
  if (path.length === 0 || !PATH_SEGMENT.test(path)) return null;
  // 纯目录（以 / 结尾）与 `.`/`..` 不算文件引用。
  if (path.endsWith("/") || path === "." || path === "..") return null;
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (last.length === 0) return null;
  const looksLikePath = path.includes("/");
  if (!looksLikePath && !NAME_WITH_EXTENSION.test(path)) return null;
  // `1.5` `v1.2.3` 这类版本号/小数：末段扩展名必须以字母开头，上面的正则已保证；
  // 但纯数字开头的裸文件名（无目录）容易误伤，统一要求有目录或合法扩展名。
  if (!looksLikePath && !/^[A-Za-z_~@+]/.test(path)) return null;
  return { text: token, path, line, column };
}
