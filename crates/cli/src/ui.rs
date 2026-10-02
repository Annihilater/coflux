//! How the CLI prints, in the same shapes as `packages/cli/output.mjs`.
//!
//! - `✓` success and plain lines go to stdout; `✗ Error:` goes to stderr, followed by one indented
//!   line saying what to do next.
//! - Colour only when the stream is a TTY, NO_COLOR is unset or empty, and TERM is not "dumb".
//!   Agents call coflux without a TTY and always get plain text.

use std::io::{IsTerminal, Write};

/// Fallback next step for an error the daemon or the server relays without one.
pub const HELP_NEXT: &str = "Run coflux --help for usage.";

fn color_enabled(is_terminal: bool) -> bool {
    if !is_terminal {
        return false;
    }
    if std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty()) {
        return false;
    }
    std::env::var("TERM").map_or(true, |term| term != "dumb")
}

fn paint(is_terminal: bool, code: (u8, u8), text: &str) -> String {
    if color_enabled(is_terminal) {
        format!("\u{1b}[{}m{text}\u{1b}[{}m", code.0, code.1)
    } else {
        text.to_string()
    }
}

const GREEN: (u8, u8) = (32, 39);
const RED: (u8, u8) = (31, 39);

/// `✓ message` on stdout.
pub fn success(message: &str) {
    println!("{} {message}", paint(std::io::stdout().is_terminal(), GREEN, "✓"));
}

/// The error block: `✗ Error: what` plus each line of `next` indented by two spaces.
pub fn error_text(what: &str, next: &str, colored: bool) -> String {
    let mut text = format!("{} {what}\n", paint(colored, RED, "✗ Error:"));
    for line in next.lines().filter(|line| !line.is_empty()) {
        text.push_str("  ");
        text.push_str(line);
        text.push('\n');
    }
    text
}

/// `✗ Error: what` and the next step, on stderr.
pub fn error(what: &str, next: &str) {
    let mut stderr = std::io::stderr();
    let text = error_text(what, next, stderr.is_terminal());
    let _ = stderr.write_all(text.as_bytes());
    let _ = stderr.flush();
}

/// Print the error and exit with `code`.
pub fn fail(what: &str, next: &str, code: i32) -> ! {
    error(what, next);
    std::process::exit(code)
}
