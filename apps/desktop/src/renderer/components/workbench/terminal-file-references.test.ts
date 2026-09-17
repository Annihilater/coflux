import assert from "node:assert/strict";
import { test } from "node:test";

import { findFileReferences, parseFileReference, readTerminalLine, type TerminalBufferLine } from "./terminal-file-references";

/** 造一行 buffer：每格写成 [内容, 宽度]，宽字符是 ["中", 2] 后跟 ["", 0]，空白格是 ["", 1]。 */
function bufferLine(cells: readonly (readonly [string, number])[]): TerminalBufferLine {
  return {
    length: cells.length,
    getCell: (x) => {
      const cell = cells[x];
      return cell ? { getChars: () => cell[0], getWidth: () => cell[1] } : undefined;
    },
  };
}

/** `中x` + 空白 + `a.ts` 的一行：宽字符占两格。 */
function cellsOf(text: string): (readonly [string, number])[] {
  const cells: (readonly [string, number])[] = [];
  for (const char of text) {
    const wide = char.codePointAt(0)! >= 0x1100 && char !== " ";
    cells.push([char === " " ? "" : char, wide ? 2 : 1]);
    if (wide) cells.push(["", 0]);
  }
  return cells;
}

test("带行列的路径：路径、行、列分开解出来，原文保留给展示与复制", () => {
  assert.deepEqual(parseFileReference("src/a/b.ts:12:5"), { text: "src/a/b.ts:12:5", path: "src/a/b.ts", line: 12, column: 5 });
  assert.deepEqual(parseFileReference("./a.tsx:3"), { text: "./a.tsx:3", path: "./a.tsx", line: 3, column: undefined });
  assert.deepEqual(parseFileReference("/abs/path/file.rs"), { text: "/abs/path/file.rs", path: "/abs/path/file.rs", line: undefined, column: undefined });
  assert.deepEqual(parseFileReference("~/.zshrc"), { text: "~/.zshrc", path: "~/.zshrc", line: undefined, column: undefined });
});

test("URL 交给 addon-web-links，不在这里认；目录、时间、版本号、命令行参数都不算文件", () => {
  for (const token of ["https://example.com/a.ts", "http://x/y.ts:3", "src/components/", ".", "..", "12:30", "1.5", "v1.2.3", "--out=dist/a.js", "3.14"]) {
    assert.equal(parseFileReference(token), null, token);
  }
});

test("散文里的缩写不当成文件（扩展名至少两位），带目录的单字母扩展名仍然认", () => {
  assert.equal(parseFileReference("e.g"), null);
  assert.equal(parseFileReference("i.e"), null);
  assert.equal(parseFileReference("main.c"), null);
  assert.deepEqual(parseFileReference("src/main.c"), { text: "src/main.c", path: "src/main.c", line: undefined, column: undefined });
});

test("一行里找出全部引用，并给出字符串区间；包裹符号与尾随标点不算在内", () => {
  const line = '  at (src/app.ts:10:2), see "docs/readme.md" and ./x.py:7.';
  const found = findFileReferences(line);
  assert.deepEqual(
    found.map((item) => item.text),
    ["src/app.ts:10:2", "docs/readme.md", "./x.py:7"],
  );
  for (const item of found) {
    assert.equal(line.slice(item.start, item.end), item.text);
  }
});

test("纯英文正文不产生引用", () => {
  assert.deepEqual(findFileReferences("the quick brown fox jumps over the lazy dog"), []);
});

test("行文本还原：空白格补空格，宽字符的后半格跳过，字符串下标能换回正确的 cell", () => {
  const line = bufferLine(cellsOf("错误 src/a.ts:3"));
  const { text, cellOf } = readTerminalLine(line);
  assert.equal(text, "错误 src/a.ts:3");
  // 「错误」两个宽字符占 4 格，随后一个空格格，所以 src 从第 5 格开始。
  const [reference] = findFileReferences(text);
  assert.ok(reference);
  assert.equal(reference.text, "src/a.ts:3");
  assert.equal(cellOf[reference.start], 5);
  // 右开端点 = 行内 cell 总数（宽字符各占两格）：4 + 1 + "src/a.ts:3".length
  assert.equal(cellOf[reference.end], 5 + "src/a.ts:3".length);
  assert.equal(cellOf[cellOf.length - 1], line.length);
});
