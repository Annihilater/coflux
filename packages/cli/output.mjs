// The one place cofluxd and coflux decide how a message looks: symbols, colour, the error shape.
//
// - `✓` success and plain lines go to stdout; `!` warnings and `✗ Error:` go to stderr.
// - Every error is one line saying what happened plus one indented line saying what to do next.
// - Colour only when the stream is a TTY and NO_COLOR is unset (https://no-color.org) and TERM is
//   not "dumb". Agents call coflux without a TTY and always get plain text.
//
// Hand-rolled SGR on purpose: `util.styleText` does not exist before Node 20.12 and colours
// unconditionally before 22.13, and package.json promises Node 20.
import process from "node:process";

const SGR = { green: [32, 39], yellow: [33, 39], red: [31, 39], bold: [1, 22], dim: [2, 22] };

/** Whether `stream` may carry colour. */
export function colorEnabled(stream) {
  if (!stream?.isTTY) return false;
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  return process.env.TERM !== "dumb";
}

function paint(stream, style, text) {
  if (!colorEnabled(stream)) return text;
  const [open, close] = SGR[style];
  return `\u001b[${open}m${text}\u001b[${close}m`;
}

/** Bold for emphasis on stdout (a URL, a command to run). */
export const bold = (text, stream = process.stdout) => paint(stream, "bold", text);
export const dim = (text, stream = process.stdout) => paint(stream, "dim", text);

/** A plain line on stdout. */
export function info(message = "") {
  process.stdout.write(`${message}\n`);
}

/** `✓ message` on stdout. */
export function success(message) {
  process.stdout.write(`${paint(process.stdout, "green", "✓")} ${message}\n`);
}

/** `! message` on stderr, with an optional indented next step. */
export function warn(message, next) {
  let text = `${paint(process.stderr, "yellow", "!")} ${message}\n`;
  if (next) text += next.split("\n").map((line) => `  ${line}\n`).join("");
  process.stderr.write(text);
}

/** `✗ Error: what` plus an indented next step, on stderr. */
export function error(what, next) {
  let text = `${paint(process.stderr, "red", "✗ Error:")} ${what}\n`;
  if (next) text += next.split("\n").map((line) => `  ${line}\n`).join("");
  process.stderr.write(text);
}

/** Print an error and exit. The write completes before the exit, even into a pipe. */
export function fail(what, next, code = 1) {
  error(what, next);
  // A message this short is written in full before process.exit: libuv tries the write
  // synchronously first and only queues what the pipe cannot take at once.
  process.exit(code);
}

/** `Doing X... ` now, then `done` (or a failure word) when the step ends. */
export function step(label) {
  process.stdout.write(`${label}... `);
  return {
    done(word = "done") { process.stdout.write(`${word}\n`); },
    failed(word = "failed") { process.stdout.write(`${word}\n`); },
  };
}

/** Aligned key/value rows on stdout; rows whose value is undefined or null are skipped. */
export function table(rows) {
  const shown = rows.filter(([, value]) => value !== undefined && value !== null);
  const width = Math.max(0, ...shown.map(([key]) => key.length));
  for (const [key, value] of shown) {
    const lines = String(value).split("\n");
    process.stdout.write(`${key.padEnd(width)}  ${lines[0]}\n`);
    for (const line of lines.slice(1)) process.stdout.write(`${" ".repeat(width)}  ${line}\n`);
  }
}

/** A short human duration: `45s`, `12m`, `3h 12m`, `2d 4h`. */
export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
