//! The `PreToolUse` guard against `git worktree remove|move` on a coflux workspace
//! (plan 20261018-worktree-guard-managed-only).
//!
//! Removing or moving, with git directly, a worktree that coflux registered as a workspace leaves
//! that workspace's record behind in the user's sidebar: nothing deletes it afterwards. So inside a
//! Coflux terminal a Bash tool call whose command would do that is denied, and the reason names the
//! coflux command that does it properly. Everything else passes: a worktree coflux has no record of,
//! a command this module cannot read with certainty, a daemon that is down or slow. The guard has an
//! opinion only when it is sure.
//!
//! Three steps, each of which can only end in "no opinion":
//! 1. a small shell lexer finds `git … worktree remove|move <target>` in the command text and the
//!    directory git will run in, without spawning anything: this runs on every tool call;
//! 2. `git worktree list --porcelain` and git's own matching rules (suffix first, then path) turn the
//!    target into a listed worktree root;
//! 3. the local daemon's `workspace.current`, asked with that root as the caller's cwd, says whether
//!    the root is the registered path of a workspace on this device.
//!
//! Contract with both hook entry points: the returned string is the complete decision JSON, printed
//! as the only line of stdout; `None` means print nothing. Nothing here may panic: a panicking hook
//! exits before the turn-state event is forwarded.

use super::{env, local_within};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Total time for the `git worktree list` children of one invocation.
const GIT_BUDGET: Duration = Duration::from_millis(1000);
/// Total time for the daemon calls of one invocation. The bundle hook is killed after 8 s, and a
/// killed hook loses the turn-state event it was about to forward.
const DAEMON_BUDGET: Duration = Duration::from_millis(4000);
/// The most a single daemon call may take, as for every other local call (`local_at`).
const DAEMON_CALL: Duration = Duration::from_millis(1800);
/// Not worth starting a child or a call with less than this left.
const MIN_LEFT: Duration = Duration::from_millis(100);

/// The deny decision for one hook payload, or `None` for no opinion. The caller has already
/// checked that the host is Claude Code.
pub(crate) fn deny_decision(payload: &Value) -> Option<String> {
    if env("COFLUX_SESSION_ID").is_empty() {
        return None;
    }
    if str_field(payload, "hook_event_name") != Some("PreToolUse")
        || str_field(payload, "tool_name") != Some("Bash")
    {
        return None;
    }
    let command = payload
        .get("tool_input")
        .and_then(|input| input.get("command"))
        .and_then(Value::as_str)?;
    let home = std::env::var("HOME").ok();
    let found = candidates(
        command,
        str_field(payload, "cwd").unwrap_or_default(),
        home.as_deref(),
    );
    if found.is_empty() {
        return None;
    }
    let mut listings = Listings::new();
    let mut asked: Vec<PathBuf> = Vec::new();
    let mut git_left = GIT_BUDGET;
    let mut daemon_left = DAEMON_BUDGET;
    for candidate in &found {
        let Some(root) = resolve(candidate, &mut listings, &mut git_left) else {
            continue;
        };
        let key = canonical(&root);
        if asked.contains(&key) {
            continue;
        }
        asked.push(key);
        // Candidates left when the budget runs out give no opinion.
        if daemon_left < MIN_LEFT {
            break;
        }
        let started = Instant::now();
        let workspace = registered(&root, daemon_left.min(DAEMON_CALL));
        daemon_left = daemon_left.saturating_sub(started.elapsed());
        if let Some(workspace) = workspace {
            return Some(decision(candidate.verb, &root, &workspace));
        }
    }
    None
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn canonical(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/* ------------------------------ the decision ------------------------------ */

fn decision(verb: Verb, root: &str, workspace: &Value) -> String {
    json!({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason(verb, root, workspace),
    }})
    .to_string()
}

fn reason(verb: Verb, root: &str, workspace: &Value) -> String {
    let id = str_field(workspace, "workspaceId").unwrap_or_default();
    let named = match str_field(workspace, "ref").filter(|reference| !reference.is_empty()) {
        Some(reference) => format!("{id} ({reference})"),
        None => id.to_string(),
    };
    let verb = verb.as_str();
    let mut text = format!(
        "Blocked `git worktree {verb}`: {root} is the coflux workspace {named} on this device, and doing this with git directly leaves that workspace's record in the user's sidebar pointing at a directory that is gone. Use `coflux workspace remove {id}` instead: it closes that workspace's terminals, then removes the worktree and its sidebar record. Moving a coflux worktree is not supported: remove it and create a new one."
    );
    if str_field(workspace, "owningWorkspaceId") == Some(id) {
        text.push_str(" This terminal belongs to that workspace, so removing it would close this terminal: leave the worktree first (ExitWorktree, or `coflux workspace enter <path of another workspace>`).");
    }
    text.push_str(" Worktrees coflux has no record of are not blocked, and Claude Code's own worktree cleanup needs nothing from you.");
    text
}

/* ------------------------- target -> worktree root ------------------------ */

/// Worktree listings taken in this invocation, by the directory git ran in (`None` = git failed).
type Listings = Vec<(PathBuf, Option<Vec<String>>)>;

/// The listed worktree root a candidate names, if git would find one.
fn resolve(
    candidate: &Candidate,
    listings: &mut Listings,
    git_left: &mut Duration,
) -> Option<String> {
    let target = Path::new(&candidate.target);
    let dir = match &candidate.base {
        Some(base) => base.clone(),
        // An absolute target means the same from anywhere; its own repository lists it.
        None if target.is_absolute() => target.to_path_buf(),
        None => return None,
    };
    let roots = match listings.iter().find(|(listed, _)| *listed == dir) {
        Some((_, roots)) => roots.clone(),
        None => {
            let roots = list_worktrees(&dir, git_left);
            listings.push((dir, roots.clone()));
            roots
        }
    }?;
    let root = match_root(&candidate.target, candidate.base.as_deref(), &roots)?;
    // Git refuses to remove or move the main worktree, which it always lists first: such a command
    // fails on its own, and pointing it at `coflux workspace remove` would be wrong advice.
    if roots.first() == Some(&root) {
        return None;
    }
    Some(root)
}

/// The `worktree <path>` lines of `git -C <dir> worktree list --porcelain`.
fn list_worktrees(dir: &Path, git_left: &mut Duration) -> Option<Vec<String>> {
    if *git_left < MIN_LEFT {
        return None;
    }
    let started = Instant::now();
    let mut git = Command::new("git");
    git.arg("-C")
        .arg(dir)
        .args(["worktree", "list", "--porcelain"]);
    let output = run_bounded(&mut git, *git_left);
    *git_left = git_left.saturating_sub(started.elapsed());
    Some(
        output?
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .map(str::to_string)
            .collect(),
    )
}

/// Run a child with a deadline, which std `Command` does not have: its stdout on success, `None`
/// on a spawn failure, a non-zero exit or the deadline (which kills it).
fn run_bounded(command: &mut Command, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Read on a thread: a child blocked on a full pipe would otherwise only end at the deadline.
    let (sender, receiver) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes);
            let _ = sender.send(bytes);
        });
    }
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let left = deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(50));
                let bytes = receiver.recv_timeout(left).ok()?;
                return if status.success() {
                    String::from_utf8(bytes).ok()
                } else {
                    None
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The listed root `target` names, by git's own rules (`find_worktree`): the one root that ends
/// with `target` at a `/` boundary (or is it); otherwise the one root equal to `target`, taken from
/// `base`, once both are canonical.
fn match_root(target: &str, base: Option<&Path>, roots: &[String]) -> Option<String> {
    if !target.is_empty() {
        let mut suffixed = roots.iter().filter(|root| {
            root.strip_suffix(target)
                .is_some_and(|head| head.is_empty() || head.ends_with('/'))
        });
        if let (Some(root), None) = (suffixed.next(), suffixed.next()) {
            return Some(root.clone());
        }
    }
    let path = Path::new(target);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base?.join(path)
    };
    let wanted = fs::canonicalize(path).ok()?;
    let mut same = roots
        .iter()
        .filter(|root| fs::canonicalize(root).is_ok_and(|root| root == wanted));
    match (same.next(), same.next()) {
        (Some(root), None) => Some(root.clone()),
        _ => None,
    }
}

/* ------------------------------ root -> daemon ----------------------------- */

/// The daemon's `workspace.current` reply when `root` is the registered path of a workspace on this
/// device. Asked with the root as the caller's cwd, the daemon answers with the workspace that cwd
/// falls in (the longest registered prefix, else the terminal's own workspace), so only a reply
/// whose `path` is the root itself names the root's workspace. An empty `path` means that workspace
/// is not in the daemon's table yet.
fn registered(root: &str, timeout: Duration) -> Option<Value> {
    let workspace = local_within("workspace.current", None, root, timeout).ok()?;
    if str_field(&workspace, "workspaceId").is_none_or(str::is_empty) {
        return None;
    }
    let path = str_field(&workspace, "path").filter(|path| !path.is_empty())?;
    let same = canonical(path) == canonical(root);
    same.then_some(workspace)
}

/* -------------------------- command text -> targets ------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verb {
    Remove,
    Move,
}

impl Verb {
    fn as_str(self) -> &'static str {
        match self {
            Verb::Remove => "remove",
            Verb::Move => "move",
        }
    }
}

/// One `git … worktree remove|move` in the command text.
#[derive(Debug, Clone, PartialEq)]
struct Candidate {
    verb: Verb,
    /// The target as written (for `move`, the source).
    target: String,
    /// The directory git runs in; `None` when the command text does not say for sure.
    base: Option<PathBuf>,
}

/// Every `git … worktree remove|move` with a literal target in `command`, run from `cwd`.
fn candidates(command: &str, cwd: &str, home: Option<&str>) -> Vec<Candidate> {
    let Some(tokens) = Lexer::new(command, home).run() else {
        return Vec::new();
    };
    let mut base = Some(PathBuf::from(cwd)).filter(|dir| dir.is_absolute());
    let mut found = Vec::new();
    let mut words = Vec::new();
    let mut before = None;
    let mut tokens = tokens.into_iter();
    loop {
        let after = match tokens.next() {
            Some(Token::Word(word)) => {
                words.push(word);
                continue;
            }
            Some(Token::Sep(sep)) => Some(sep),
            None => None,
        };
        scan(&words, base.as_deref(), &mut found);
        base = directory_after(&words, before, after, base);
        words.clear();
        match after {
            None => return found,
            // A subshell ends: where the shell is now depends on what ran inside it.
            Some(Sep::Close) => base = None,
            Some(_) => {}
        }
        before = after;
    }
}

/// The occurrences in one simple command, which can sit anywhere in it (`sudo git`, `do git`).
fn scan(words: &[Word], base: Option<&Path>, found: &mut Vec<Candidate>) {
    for (at, word) in words.iter().enumerate() {
        if !word.literal || !(word.text == "git" || word.text.ends_with("/git")) {
            continue;
        }
        // A git variable assigned in front (`GIT_DIR=… git`) can point git at another repository.
        let before = words.get(..at).unwrap_or_default();
        if before
            .iter()
            .any(|word| word.text.starts_with("GIT_") && word.text.contains('='))
        {
            continue;
        }
        if let Some(candidate) = occurrence(words.get(at + 1..).unwrap_or_default(), base) {
            found.push(candidate);
        }
    }
}

/// `[global options] worktree remove|move [options] <target>`, the words after a `git` word.
fn occurrence(args: &[Word], base: Option<&Path>) -> Option<Candidate> {
    let mut base = base.map(Path::to_path_buf);
    let mut rest = args.iter();
    loop {
        let word = rest.next()?;
        if !word.literal {
            return None;
        }
        let option = word.text.as_str();
        match option {
            "worktree" => break,
            // Applied in order and consumed here: the listing runs in the resulting directory.
            "-C" => base = change_directory(base, rest.next()?),
            // Options whose value is the next word.
            "-c" | "--namespace" | "--config-env" | "--attr-source" | "--super-prefix" => {
                rest.next()?;
            }
            "-p" | "-P" => {}
            // These pick the repository by something other than the directory: not sure enough.
            "--git-dir" | "--work-tree" | "--bare" => return None,
            // These print something and exit instead of running the subcommand.
            "-h" | "--help" | "-v" | "--version" | "--exec-path" | "--html-path" | "--man-path"
            | "--info-path" => return None,
            _ => {
                if let Some(dir) = option.strip_prefix("-C") {
                    let dir = Word {
                        text: dir.to_string(),
                        literal: true,
                    };
                    base = change_directory(base, &dir);
                } else if option.starts_with("--git-dir=")
                    || option.starts_with("--work-tree=")
                    || option.starts_with("--list-cmds=")
                {
                    return None;
                } else if !(option.starts_with("-c") || option.starts_with("--")) {
                    // Another subcommand, or a short option git does not have.
                    return None;
                }
            }
        }
    }
    let verb = match rest.next() {
        Some(word) if word.literal && word.text == "remove" => Verb::Remove,
        Some(word) if word.literal && word.text == "move" => Verb::Move,
        _ => return None,
    };
    // Git's option parser accepts options anywhere before `--`, in bundles (`-ff`) and abbreviated
    // (`--forc`): any dash word is an option, and the first other word is the target.
    let mut options = true;
    for word in rest {
        if !word.literal {
            return None;
        }
        if options && word.text == "--" {
            options = false;
        } else if !(options && word.text.starts_with('-') && word.text != "-") {
            return Some(Candidate {
                verb,
                target: word.text.clone(),
                base,
            });
        }
    }
    None
}

/// Where the shell is after one simple command, `None` once that is not known for sure.
fn directory_after(
    words: &[Word],
    before: Option<Sep>,
    after: Option<Sep>,
    base: Option<PathBuf>,
) -> Option<PathBuf> {
    let changes_directory = |word: &Word| matches!(word.text.as_str(), "cd" | "pushd" | "popd");
    let mut rest = words.iter();
    match rest.next() {
        None => return base,
        Some(head) if head.literal && head.text == "cd" => {}
        // pushd/popd, or a cd out of command position (`builtin cd`, `then cd`): stop guessing.
        Some(_) if words.iter().any(changes_directory) => return None,
        Some(_) => return base,
    }
    // A cd in a pipeline or in the background runs in a subshell of its own.
    if before == Some(Sep::Pipe) || matches!(after, Some(Sep::Pipe | Sep::Background)) {
        return None;
    }
    let path = match rest.next() {
        Some(word) if word.literal && word.text == "--" => rest.next(),
        // `cd -`, `cd -P …`
        Some(word) if word.text.starts_with('-') => None,
        other => other,
    };
    // `cd` alone goes home, `cd ""` stays, and `cd a b` is an error (a substitution in zsh).
    let path = path.filter(|path| path.literal && !path.text.is_empty())?;
    if rest.next().is_some() {
        return None;
    }
    change_directory(base, path)
}

/// The directory after a `cd` or `git -C` to `dir` from `base`.
fn change_directory(base: Option<PathBuf>, dir: &Word) -> Option<PathBuf> {
    if !dir.literal {
        return None;
    }
    // `git -C ""` leaves the directory unchanged.
    if dir.text.is_empty() {
        return base;
    }
    let dir = Path::new(&dir.text);
    if dir.is_absolute() {
        Some(dir.to_path_buf())
    } else {
        base.map(|base| base.join(dir))
    }
}

/* ---------------------------------- lexer --------------------------------- */

/// One shell word after quote removal.
#[derive(Debug, Clone, PartialEq)]
struct Word {
    text: String,
    /// False when the shell would expand the word at run time (parameters, command substitution,
    /// globs, brace expansion, `~user`): its value is not known here.
    literal: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sep {
    /// `;`, `&&`, `||` or a newline: the next command runs later in the same shell.
    Sequence,
    /// `|` or `|&`: both sides run in subshells.
    Pipe,
    /// `&`: the command before it runs in a background subshell.
    Background,
    /// `(`: a subshell or a command substitution starts.
    Open,
    /// `)`: it ends.
    Close,
}

enum Token {
    Word(Word),
    Sep(Sep),
}

/// What the next word is when a redirection operator precedes it.
enum Redirect {
    /// A file or a descriptor: not an argument of the command.
    Target,
    /// A here-document delimiter: the document's lines are skipped at the next newline.
    Heredoc { strip_tabs: bool },
}

/// Splits a command into words and separators the way a POSIX shell does, closely enough to
/// tell literal words from expanded ones. `None` for unterminated quoting: the shell would refuse
/// the whole command and run nothing.
struct Lexer<'a> {
    chars: Vec<char>,
    at: usize,
    home: Option<&'a str>,
    tokens: Vec<Token>,
    word: String,
    started: bool,
    literal: bool,
    quoted: bool,
    brace: bool,
    redirect: Option<Redirect>,
    heredocs: Vec<(String, bool)>,
}

fn ends_word(c: char) -> bool {
    c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')' | '<' | '>')
}

impl<'a> Lexer<'a> {
    fn new(command: &str, home: Option<&'a str>) -> Self {
        Lexer {
            chars: command.chars().collect(),
            at: 0,
            home,
            tokens: Vec::new(),
            word: String::new(),
            started: false,
            literal: true,
            quoted: false,
            brace: false,
            redirect: None,
            heredocs: Vec::new(),
        }
    }

    fn peek(&self, ahead: usize) -> Option<char> {
        self.chars.get(self.at + ahead).copied()
    }

    fn push(&mut self, c: char) {
        self.word.push(c);
        self.started = true;
    }

    fn reset(&mut self) {
        self.word.clear();
        self.started = false;
        self.literal = true;
        self.quoted = false;
        self.brace = false;
    }

    fn finish(&mut self) {
        if !self.started {
            return;
        }
        // `{` alone opens a group; anywhere else an unquoted brace may be a brace expansion.
        let literal = self.literal && !(self.brace && self.word != "{");
        let word = Word {
            text: std::mem::take(&mut self.word),
            literal,
        };
        self.reset();
        match self.redirect.take() {
            None => self.tokens.push(Token::Word(word)),
            Some(Redirect::Target) => {}
            Some(Redirect::Heredoc { strip_tabs }) => self.heredocs.push((word.text, strip_tabs)),
        }
    }

    fn separator(&mut self, sep: Sep, width: usize) {
        self.finish();
        self.redirect = None;
        self.tokens.push(Token::Sep(sep));
        self.at += width;
    }

    fn run(mut self) -> Option<Vec<Token>> {
        while let Some(c) = self.peek(0) {
            match c {
                ' ' | '\t' | '\r' => {
                    self.finish();
                    self.at += 1;
                }
                '\n' => {
                    self.separator(Sep::Sequence, 1);
                    self.skip_heredocs();
                }
                ';' => self.separator(Sep::Sequence, 1),
                '&' => match self.peek(1) {
                    Some('&') => self.separator(Sep::Sequence, 2),
                    // `&>file`, `&>>file`
                    Some('>') => {
                        self.finish();
                        self.at += 2;
                        if self.peek(0) == Some('>') {
                            self.at += 1;
                        }
                        self.redirect = Some(Redirect::Target);
                    }
                    _ => self.separator(Sep::Background, 1),
                },
                '|' => match self.peek(1) {
                    Some('|') => self.separator(Sep::Sequence, 2),
                    Some('&') => self.separator(Sep::Pipe, 2),
                    _ => self.separator(Sep::Pipe, 1),
                },
                '(' => self.separator(Sep::Open, 1),
                ')' => self.separator(Sep::Close, 1),
                '<' | '>' => self.redirection(c),
                '#' if !self.started => self.skip_line(),
                '\\' => {
                    // A backslash-newline joins lines; any other escaped character is literal.
                    if let Some(next) = self.peek(1).filter(|next| *next != '\n') {
                        self.quoted = true;
                        self.push(next);
                    }
                    self.at += 2;
                }
                '\'' => self.single_quoted()?,
                '"' => self.double_quoted()?,
                '`' => self.backquoted()?,
                '$' | '*' | '?' | '[' => {
                    self.literal = false;
                    self.push(c);
                    self.at += 1;
                }
                '{' => {
                    self.brace = true;
                    self.push(c);
                    self.at += 1;
                }
                '~' if !self.started => self.tilde(),
                _ => {
                    self.push(c);
                    self.at += 1;
                }
            }
        }
        self.finish();
        Some(self.tokens)
    }

    fn single_quoted(&mut self) -> Option<()> {
        self.started = true;
        self.quoted = true;
        self.at += 1;
        loop {
            let c = self.peek(0)?;
            self.at += 1;
            if c == '\'' {
                return Some(());
            }
            self.word.push(c);
        }
    }

    fn double_quoted(&mut self) -> Option<()> {
        self.started = true;
        self.quoted = true;
        self.at += 1;
        loop {
            let c = self.peek(0)?;
            self.at += 1;
            match c {
                '"' => return Some(()),
                '\\' => match self.peek(0) {
                    Some(next @ ('"' | '\\' | '$' | '`')) => {
                        self.word.push(next);
                        self.at += 1;
                    }
                    Some('\n') => self.at += 1,
                    _ => self.word.push('\\'),
                },
                '$' | '`' => {
                    self.literal = false;
                    self.word.push(c);
                }
                _ => self.word.push(c),
            }
        }
    }

    /// A command substitution in backquotes: opaque, so the word is not literal.
    fn backquoted(&mut self) -> Option<()> {
        self.started = true;
        self.literal = false;
        self.at += 1;
        loop {
            let c = self.peek(0)?;
            self.at += 1;
            match c {
                '`' => return Some(()),
                '\\' => self.at += 1,
                _ => self.word.push(c),
            }
        }
    }

    /// `~` and `~/…` expand to HOME; any other tilde prefix (`~user`, `~+`) is not literal.
    fn tilde(&mut self) {
        let plain = self
            .peek(1)
            .is_none_or(|next| next == '/' || ends_word(next));
        match self.home.filter(|home| !home.is_empty()) {
            Some(home) if plain => {
                self.word.push_str(home);
                self.started = true;
            }
            _ => {
                self.literal = false;
                self.push('~');
            }
        }
        self.at += 1;
    }

    fn redirection(&mut self, c: char) {
        if !self.quoted && !self.word.is_empty() && self.word.chars().all(|d| d.is_ascii_digit()) {
            // The descriptor of `2>`, not an argument.
            self.reset();
        } else {
            self.finish();
        }
        self.at += 1;
        let mut redirect = Redirect::Target;
        match (c, self.peek(0)) {
            ('<', Some('<')) => {
                self.at += 1;
                if self.peek(0) == Some('<') {
                    // A here-string: its word is data.
                    self.at += 1;
                } else {
                    let strip_tabs = self.peek(0) == Some('-');
                    if strip_tabs {
                        self.at += 1;
                    }
                    redirect = Redirect::Heredoc { strip_tabs };
                }
            }
            ('<', Some('>' | '&')) | ('>', Some('>' | '&' | '|')) => self.at += 1,
            _ => {}
        }
        self.redirect = Some(redirect);
    }

    fn skip_line(&mut self) {
        while let Some(c) = self.peek(0) {
            if c == '\n' {
                return;
            }
            self.at += 1;
        }
    }

    /// Here-document bodies start after the newline that ends their command.
    fn skip_heredocs(&mut self) {
        for (delimiter, strip_tabs) in std::mem::take(&mut self.heredocs) {
            while self.at < self.chars.len() {
                let start = self.at;
                self.skip_line();
                let line: String = self
                    .chars
                    .get(start..self.at)
                    .unwrap_or_default()
                    .iter()
                    .collect();
                self.at += 1;
                let line = if strip_tabs {
                    line.trim_start_matches('\t')
                } else {
                    line.as_str()
                };
                if line == delimiter {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CWD: &str = "/w";

    fn found(command: &str) -> Vec<Candidate> {
        candidates(command, CWD, Some("/home/u"))
    }

    fn one(verb: Verb, target: &str, base: Option<&str>) -> Vec<Candidate> {
        vec![Candidate {
            verb,
            target: target.into(),
            base: base.map(PathBuf::from),
        }]
    }

    #[test]
    fn finds_the_target_and_the_directory_git_runs_in() {
        assert_eq!(
            found("git worktree remove .claude/worktrees/a"),
            one(Verb::Remove, ".claude/worktrees/a", Some(CWD))
        );
        assert_eq!(
            found("git -C /r worktree remove -f --force x"),
            one(Verb::Remove, "x", Some("/r"))
        );
        assert_eq!(
            found("git worktree move a /tmp/b"),
            one(Verb::Move, "a", Some(CWD))
        );
        assert_eq!(
            found("git -C /r -C sub worktree remove a"),
            one(Verb::Remove, "a", Some("/r/sub"))
        );
        assert_eq!(
            found("git worktree remove -- -odd"),
            one(Verb::Remove, "-odd", Some(CWD))
        );
        assert_eq!(
            found("sudo /usr/bin/git worktree remove a"),
            one(Verb::Remove, "a", Some(CWD))
        );
        assert_eq!(
            found("git --no-pager -c core.x=1 worktree remove a"),
            one(Verb::Remove, "a", Some(CWD))
        );
        assert_eq!(
            found("git worktree remove ~/wt"),
            one(Verb::Remove, "/home/u/wt", Some(CWD))
        );
        assert_eq!(
            found("git worktree \\\n  remove a"),
            one(Verb::Remove, "a", Some(CWD))
        );
    }

    #[test]
    fn a_literal_cd_moves_the_base_and_anything_else_makes_it_unknown() {
        assert_eq!(
            found("cd /r && git worktree remove a"),
            one(Verb::Remove, "a", Some("/r"))
        );
        assert_eq!(
            found("cd sub; git worktree remove a"),
            one(Verb::Remove, "a", Some("/w/sub"))
        );
        assert_eq!(
            found("cd -- /r\ngit worktree remove a"),
            one(Verb::Remove, "a", Some("/r"))
        );
        assert_eq!(
            found("cd ~ && git worktree remove a"),
            one(Verb::Remove, "a", Some("/home/u"))
        );
        assert_eq!(
            found("cd /r 2>/dev/null && git worktree remove a 2>&1 | tail -n 1"),
            one(Verb::Remove, "a", Some("/r"))
        );
        for command in [
            "cd \"$X\" && git worktree remove a",
            "cd -P /r && git worktree remove a",
            "(cd /r && true); git worktree remove a",
            "cd && git worktree remove a",
            "cd - && git worktree remove a",
            "pushd /r && git worktree remove a",
            "builtin cd /r && git worktree remove a",
            "cd /r | git worktree remove a",
            "git -C \"$R\" worktree remove a",
        ] {
            assert_eq!(found(command), one(Verb::Remove, "a", None), "{command}");
        }
    }

    #[test]
    fn every_occurrence_counts() {
        let mut both = one(Verb::Remove, "a", Some(CWD));
        both.extend(one(Verb::Remove, "b", Some(CWD)));
        assert_eq!(found("git worktree remove a; git worktree remove b"), both);
        assert_eq!(
            found("cat <<EOF > notes\ngit worktree remove a\nEOF\ngit worktree remove b"),
            one(Verb::Remove, "b", Some(CWD)),
            "a here-document body is data"
        );
    }

    #[test]
    fn quoted_text_expansions_and_other_subcommands_are_not_targets() {
        for command in [
            "git commit -m \"git worktree remove a\"",
            "echo 'git worktree move a b'",
            "git worktree remove \"$wt\"",
            "git worktree remove `pwd`",
            "git worktree remove .claude/worktrees/*",
            "git worktree remove .claude/worktrees/{a,b}",
            "git worktree remove ~someone/a",
            "for wt in a b; do git worktree remove $wt; done",
            "git worktree list",
            "git worktree add x",
            "git worktree prune",
            "git worktree remove",
            "git --git-dir=/r/.git worktree remove a",
            "git --work-tree /r worktree remove a",
            "GIT_DIR=/r/.git git worktree remove a",
            "git --version worktree remove a",
            "ls # git worktree remove a",
            "cat <<'EOF'\ngit worktree remove a\nEOF",
            "git worktree remove 'unterminated",
        ] {
            assert!(found(command).is_empty(), "{command}");
        }
    }

    const ROOTS: [&str; 3] = ["/r", "/r/.claude/worktrees/a", "/x/a"];

    fn listed(roots: &[&str]) -> Vec<String> {
        roots.iter().map(|root| root.to_string()).collect()
    }

    #[test]
    fn a_unique_suffix_names_the_root_before_any_path() {
        let roots = listed(&ROOTS);
        assert_eq!(
            match_root("worktrees/a", None, &roots).as_deref(),
            Some("/r/.claude/worktrees/a")
        );
        assert_eq!(
            match_root(".claude/worktrees/a", Some(Path::new("/r")), &roots).as_deref(),
            Some("/r/.claude/worktrees/a")
        );
        assert_eq!(match_root("/r", None, &roots).as_deref(), Some("/r"));
    }

    /// Only the directory this test created is removed.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "coflux-worktree-guard-{}-{}",
                std::process::id(),
                super::super::now()
            ));
            fs::create_dir(&path).expect("create the test directory");
            TempDir(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            if !self.0.as_os_str().is_empty() {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn without_a_unique_suffix_the_path_from_the_base_decides() {
        let temp = TempDir::new();
        let at = |path: &str| temp.0.join(path).to_string_lossy().into_owned();
        for dir in ["r/.claude/worktrees/a", "x/a", "q"] {
            fs::create_dir_all(temp.0.join(dir)).expect("create a test worktree");
        }
        let roots = vec![at("r"), at("r/.claude/worktrees/a"), at("x/a")];
        let (r, x, q) = (temp.0.join("r"), temp.0.join("x"), temp.0.join("q"));
        // `a` ends two roots: the path step decides.
        assert_eq!(match_root("a", Some(x.as_path()), &roots), Some(at("x/a")));
        assert_eq!(match_root("a", Some(q.as_path()), &roots), None);
        assert_eq!(match_root("a", None, &roots), None);
        assert_eq!(match_root("b", Some(r.as_path()), &roots), None);
        assert_eq!(match_root(&at("r/.claude"), None, &roots), None);
        assert_eq!(
            match_root("./a", Some(x.as_path()), &roots),
            Some(at("x/a"))
        );
    }

    #[test]
    fn the_reason_names_the_workspace_and_warns_when_it_is_this_terminals() {
        let workspace = json!({
            "workspaceId": "3f2a1b7c-aaaa-bbbb-cccc-ddddeeeeffff",
            "ref": "coflux:workspace:3f2a1b7c",
            "path": "/r/wt",
            "owningWorkspaceId": "3f2a1b7c-aaaa-bbbb-cccc-ddddeeeeffff",
        });
        let output: Value = serde_json::from_str(&decision(Verb::Remove, "/r/wt", &workspace))
            .expect("the decision is JSON");
        let hook = &output["hookSpecificOutput"];
        assert_eq!(hook["hookEventName"], "PreToolUse");
        assert_eq!(hook["permissionDecision"], "deny");
        let said = hook["permissionDecisionReason"]
            .as_str()
            .unwrap_or_default();
        for part in [
            "`git worktree remove`",
            "/r/wt",
            "3f2a1b7c-aaaa-bbbb-cccc-ddddeeeeffff (coflux:workspace:3f2a1b7c)",
            "`coflux workspace remove 3f2a1b7c-aaaa-bbbb-cccc-ddddeeeeffff`",
            "not supported",
            "This terminal belongs to that workspace",
            "ExitWorktree",
            "no record of are not blocked",
        ] {
            assert!(said.contains(part), "{part}: {said}");
        }
        let elsewhere = json!({
            "workspaceId": "3f2a1b7c-aaaa-bbbb-cccc-ddddeeeeffff",
            "path": "/r/wt",
            "owningWorkspaceId": "9e21c4d0-1111-2222-3333-444455556666",
        });
        let said = reason(Verb::Move, "/r/wt", &elsewhere);
        assert!(said.contains("`git worktree move`"), "{said}");
        assert!(!said.contains("This terminal belongs"), "{said}");
        assert!(!said.contains("(coflux:workspace:"), "{said}");
    }

    /// Whatever the environment, these never reach git or the daemon.
    #[test]
    fn says_nothing_about_other_events_or_commands_without_a_target() {
        let payload = |event: &str, tool: &str, command: Value| json!({"hook_event_name": event, "tool_name": tool, "tool_input": {"command": command}, "cwd": CWD});
        let quiet = [
            payload("PostToolUse", "Bash", json!("git worktree remove a")),
            payload("PreToolUse", "Read", json!("git worktree remove a")),
            payload("PreToolUse", "Bash", json!("git status")),
            payload("PreToolUse", "Bash", json!(3)),
            json!([1, 2]),
        ];
        for payload in quiet {
            assert_eq!(deny_decision(&payload), None, "{payload}");
        }
    }
}
