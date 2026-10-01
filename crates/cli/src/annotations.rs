//! `coflux annotations list | watch | resolve` (plan 20260929-browser-annotations).
//!
//! The user annotates elements of the workspace's page in Coflux's built-in browser, or comments on
//! lines of the workspace's diff in the desktop's changes view (plan
//! 20261001-changes-review-comments); the worker of the workspace's device keeps both kinds. These commands are local agent actions on `/agent`, resolved
//! to the caller's **effective** workspace like every other local command: `list` prints the
//! pending ones as markdown (or `--json`), `watch` blocks until there are some, and `resolve`
//! records what the agent changed so the user can confirm it or reopen it.
//!
//! Rendering is pure (unit-tested); I/O only happens in [`run`].

use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::args::ParsedArgs;
use crate::gateway;

/// Default `watch` budget, in seconds: the same order as `terminal wait`.
const DEFAULT_WATCH_TIMEOUT_S: f64 = 1800.0;
/// One `/agent` round is capped at 25 s on the loopback endpoint; the daemon blocks up to this.
const WATCH_ROUND_MS: u64 = 20_000;

fn body(action: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("action".into(), Value::from(action));
    map
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Inline code that survives backticks inside the value.
fn code(value: &str) -> String {
    let fence = if value.contains('`') { "``" } else { "`" };
    format!("{fence}{value}{fence}")
}

fn workspace_label(result: &Value) -> String {
    let reference = text(result, "ref");
    let reference = if reference.is_empty() { text(result, "workspaceId") } else { reference };
    let path = text(result, "path");
    if path.is_empty() {
        reference.to_string()
    } else {
        format!("{reference} ({path})")
    }
}

/// The element's opening tag with its id, classes and identifying attributes.
fn opening_tag(element: &Value) -> Option<String> {
    let tag = text(element, "tag");
    if tag.is_empty() {
        return None;
    }
    let mut opening = format!("<{tag}");
    let id = text(element, "elementId");
    if !id.is_empty() {
        opening.push_str(&format!(" id=\"{id}\""));
    }
    let classes: Vec<&str> = element
        .get("classes")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !classes.is_empty() {
        opening.push_str(&format!(" class=\"{}\"", classes.join(" ")));
    }
    if let Some(attributes) = element.get("attributes").and_then(Value::as_object) {
        for (key, value) in attributes {
            if let Some(value) = value.as_str() {
                opening.push_str(&format!(" {key}=\"{}\"", one_line(value)));
            }
        }
    }
    opening.push('>');
    Some(opening)
}

fn components(source: &Value) -> Vec<&str> {
    source
        .get("components")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}

fn render_element(element: &Value, out: &mut Vec<String>) {
    if let Some(opening) = opening_tag(element) {
        let excerpt = one_line(text(element, "text"));
        if excerpt.is_empty() {
            out.push(format!("- Element: {}", code(&opening)));
        } else {
            out.push(format!("- Element: {} with text \"{excerpt}\"", code(&opening)));
        }
    }
    let selector = text(element, "selector");
    if !selector.is_empty() {
        out.push(format!("- Selector: {}", code(selector)));
    }
    let dom_path = text(element, "domPath");
    if !dom_path.is_empty() {
        out.push(format!("- DOM path: {}", code(dom_path)));
    }
    if let Some(styles) = element.get("styles").and_then(Value::as_object) {
        let rendered: Vec<String> = styles
            .iter()
            .filter_map(|(key, value)| value.as_str().map(|value| format!("{key}: {value}")))
            .collect();
        if !rendered.is_empty() {
            out.push(format!("- Computed styles: {}", code(&rendered.join("; "))));
        }
    }
}

fn render_source(source: &Value, out: &mut Vec<String>) {
    if source.is_null() {
        return;
    }
    let components = components(source);
    let framework = text(source, "framework");
    if !components.is_empty() {
        let chain = components.join(" < ");
        if framework.is_empty() {
            out.push(format!("- Components (innermost first): {chain}"));
        } else {
            out.push(format!("- Components (innermost first, {framework}): {chain}"));
        }
    }
    let file = text(source, "file");
    if !file.is_empty() {
        let mut location = file.to_string();
        let line = number(source, "line");
        if line > 0 {
            location.push_str(&format!(":{line}"));
            let column = number(source, "column");
            if column > 0 {
                location.push_str(&format!(":{column}"));
            }
        }
        out.push(format!("- Source: {}", code(&location)));
    }
}

fn render_target(target: &Value, out: &mut Vec<String>) {
    render_source(target.get("source").unwrap_or(&Value::Null), out);
    render_element(target.get("element").unwrap_or(&Value::Null), out);
}

/// One line naming an element inside a region: its component chain, then its tag and selector.
fn inner_element_line(target: &Value) -> String {
    let source = target.get("source").unwrap_or(&Value::Null);
    let element = target.get("element").unwrap_or(&Value::Null);
    let mut parts = Vec::new();
    let chain = components(source);
    if !chain.is_empty() {
        parts.push(chain.join(" < "));
    }
    if let Some(opening) = opening_tag(element) {
        parts.push(code(&opening));
    }
    let selector = text(element, "selector");
    if !selector.is_empty() {
        parts.push(format!("selector {}", code(selector)));
    }
    let file = text(source, "file");
    if !file.is_empty() {
        let line = number(source, "line");
        let location = if line > 0 { format!("{file}:{line}") } else { file.to_string() };
        parts.push(format!("source {}", code(&location)));
    }
    format!("- {}", parts.join(" · "))
}

/// The elements an annotation points at: one element, several (a shift-click selection), or a
/// region with the element containing it (`targets[0]`) and the elements inside it.
fn render_targets(annotation: &Value, out: &mut Vec<String>) {
    let targets = annotation
        .get("targets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let region = annotation.get("region").filter(|region| region.is_object());
    if let Some(region) = region {
        let value = |key: &str| region.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        out.push(format!(
            "- Region: the user dragged a {}×{} px area on the page, {} px right and {} px down from the top-left corner of the container below. The comment is about that area.",
            format_number(value("width")),
            format_number(value("height")),
            format_number(value("x")),
            format_number(value("y")),
        ));
        if let Some(container) = targets.first() {
            out.push(String::new());
            out.push("### Container (the innermost element holding the region)".into());
            out.push(String::new());
            render_target(container, out);
        }
        if targets.len() > 1 {
            out.push(String::new());
            out.push("### Inside the region".into());
            out.push(String::new());
            for target in &targets[1..] {
                out.push(inner_element_line(target));
            }
        }
        return;
    }
    if targets.len() > 1 {
        out.push(format!(
            "- Elements: {} (the user selected them together; the comment applies to all of them)",
            targets.len()
        ));
        for (index, target) in targets.iter().enumerate() {
            out.push(String::new());
            out.push(format!("### Element {} of {}", index + 1, targets.len()));
            out.push(String::new());
            render_target(target, out);
        }
        return;
    }
    if let Some(target) = targets.first() {
        render_target(target, out);
    }
}

/// A fenced block that survives backtick runs inside the value.
fn fenced(value: &str, out: &mut Vec<String>) {
    let mut longest = 0;
    let mut run = 0;
    for character in value.chars() {
        if character == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat(longest.max(2) + 1);
    out.push(fence.clone());
    for line in value.lines() {
        out.push(line.to_string());
    }
    out.push(fence);
}

/// A code comment's location and the lines it was written on.
fn render_code(anchor: &Value, out: &mut Vec<String>) {
    let path = text(anchor, "path");
    let start = number(anchor, "startLine");
    let end = number(anchor, "endLine").max(start);
    let location = if end > start { format!("{path}:{start}-{end}") } else { format!("{path}:{start}") };
    if text(anchor, "side") == "base" {
        let commit = text(anchor, "baseCommit");
        let at = if commit.is_empty() { String::new() } else { format!(" at commit {}", code(commit)) };
        out.push(format!(
            "- Code: {} on the base side of the diff (the version{at} that the changes are compared against, not the working tree)",
            code(&location)
        ));
    } else {
        out.push(format!("- Code: {} in the working tree", code(&location)));
    }
    let lines = text(anchor, "lines");
    if !lines.is_empty() {
        out.push("- Commented lines (as they were when the comment was written):".into());
        out.push(String::new());
        fenced(lines, out);
    }
}

/// One annotation as a markdown section.
pub fn render_annotation(annotation: &Value) -> String {
    let mut out = Vec::new();
    out.push(format!(
        "## #{} · {}",
        number(annotation, "number"),
        code(text(annotation, "id"))
    ));
    out.push(String::new());
    let comment = text(annotation, "comment").trim();
    if !comment.is_empty() {
        for line in comment.lines() {
            out.push(format!("> {line}"));
        }
        out.push(String::new());
    }
    if let Some(follow_ups) = annotation.get("followUps").and_then(Value::as_array) {
        for follow_up in follow_ups {
            let note = one_line(text(follow_up, "previousNote"));
            let reply = one_line(text(follow_up, "comment"));
            if !note.is_empty() {
                out.push(format!("- Earlier you resolved it with: \"{note}\""));
            }
            out.push(format!("- The user reopened it: \"{reply}\""));
        }
    }
    if let Some(code) = annotation.get("code").filter(|code| code.is_object()) {
        render_code(code, &mut out);
        return out.join("\n");
    }
    let page = annotation.get("page").cloned().unwrap_or(Value::Null);
    let url = text(&page, "url");
    let title = one_line(text(&page, "title"));
    if !url.is_empty() {
        if title.is_empty() {
            out.push(format!("- Page: {url}"));
        } else {
            out.push(format!("- Page: {url} (\"{title}\")"));
        }
    }
    if let Some(images) = annotation.get("images").and_then(Value::as_array) {
        for image in images {
            let label = if text(image, "kind") == "screenshot" {
                "Screenshot of the current state"
            } else {
                "Reference image from the user"
            };
            out.push(format!("- {label}: {}", text(image, "path")));
        }
    }
    render_targets(annotation, &mut out);
    out.join("\n")
}

/// `coflux annotations list`: the effective workspace's pending annotations as markdown.
pub fn render_list(result: &Value) -> String {
    let workspace = workspace_label(result);
    let annotations = result
        .get("annotations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let resolved = number(result, "resolvedCount");
    if annotations.is_empty() {
        let mut line = format!("No pending annotations in workspace {workspace}.");
        if resolved > 0 {
            line.push_str(&format!(" {resolved} resolved one(s) are waiting for the user to review."));
        }
        return line;
    }
    let is_code = |annotation: &Value| annotation.get("code").is_some_and(Value::is_object);
    let code_count = annotations.iter().filter(|annotation| is_code(*annotation)).count();
    let page_count = annotations.len() - code_count;
    let mut intro = format!(
        "{} pending. For each one: make the change, then run `coflux annotations resolve <id> --note \"<what you changed>\"`.",
        annotations.len()
    );
    if page_count > 0 {
        intro.push_str(" Browser annotations: the user marked elements in Coflux's built-in browser; one annotation can cover several elements selected together, or a dragged region with the elements inside it. Find the code (component names and source locations are the best leads; the selector and DOM path describe the element in the page). Map raw values such as colors, sizes and spacing to the project's design system (its tokens and components) instead of hard-coding them. Images are files on this machine: read them to see the current state and the user's references.");
    }
    if code_count > 0 {
        intro.push_str(" Code comments: the user commented on lines of this workspace's diff in Coflux's changes view. The file and line range are where the lines were when the comment was written; if the file has changed since, find the commented lines by their text.");
    }
    let mut out = vec![format!("# Annotations · workspace {workspace}"), String::new(), intro];
    for annotation in &annotations {
        out.push(String::new());
        out.push(render_annotation(annotation));
    }
    out.join("\n")
}

pub fn render_resolved(result: &Value) -> String {
    let annotation = result.get("annotation").cloned().unwrap_or(Value::Null);
    format!(
        "Resolved #{} ({}). The user will confirm it, or reopen it with a comment.",
        number(&annotation, "number"),
        text(&annotation, "id")
    )
}

fn timeout_secs(raw: Option<&str>) -> f64 {
    raw.and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(DEFAULT_WATCH_TIMEOUT_S)
}

fn print_listing(result: &Value, json: bool) {
    if json {
        println!("{result}");
    } else {
        println!("{}", render_list(result));
    }
}

pub fn run(args: &ParsedArgs) {
    let json = args.flag("json");
    match args.positional(1) {
        Some("list") => {
            let result = gateway::agent_post(body("annotations.list"));
            print_listing(&result, json);
        }
        Some("watch") => {
            let timeout = timeout_secs(args.string("timeout"));
            let deadline = Duration::try_from_secs_f64(timeout)
                .ok()
                .and_then(|timeout| Instant::now().checked_add(timeout));
            loop {
                let round_ms = deadline
                    .map(|deadline| deadline.saturating_duration_since(Instant::now()).as_millis() as u64)
                    .unwrap_or(WATCH_ROUND_MS)
                    .clamp(1, WATCH_ROUND_MS);
                let mut request = body("annotations.watch");
                request.insert("timeoutMs".into(), Value::from(round_ms));
                let result = gateway::agent_post(request);
                if text(&result, "state") == "pending" {
                    print_listing(&result, json);
                    return;
                }
                if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    crate::die(&format!(
                        "no pending annotations in workspace {} within {timeout}s",
                        workspace_label(&result)
                    ));
                }
            }
        }
        Some("resolve") => {
            let Some(id) = args.positional(2) else {
                crate::die("usage: coflux annotations resolve <id> --note \"<what you changed>\"");
            };
            let note = args.string("note").unwrap_or("").trim().to_string();
            if note.is_empty() {
                crate::die("annotations resolve needs --note \"<what you changed>\": the user reads it to review the change");
            }
            let mut request = body("annotations.resolve");
            request.insert("annotationId".into(), Value::from(id));
            request.insert("note".into(), Value::from(note));
            let result = gateway::agent_post(request);
            if json {
                println!("{result}");
            } else {
                println!("{}", render_resolved(&result));
            }
        }
        _ => crate::die("annotations needs a subcommand: list | watch | resolve <id> --note \"…\""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "workspaceId": "3f2a1b7c-0000",
            "ref": "coflux:workspace:3f2a1b7c",
            "path": "/src/app",
            "revision": 4,
            "resolvedCount": 1,
            "annotations": [{
                "id": "ann-0011", "number": 2, "status": "pending",
                "comment": "Make it blue",
                "page": { "url": "http://localhost:3000/", "title": "Home" },
                "targets": [{
                    "element": { "tag": "button", "elementId": "save", "classes": ["btn"], "attributes": {},
                        "styles": { "color": "rgb(0, 0, 0)" }, "selector": "#save", "domPath": "html > body > button", "text": "Save" },
                    "source": { "framework": "react", "components": ["SaveButton", "Toolbar"], "file": "src/Save.tsx", "line": 12, "column": 3 }
                }],
                "region": null,
                "images": [{ "kind": "screenshot", "path": "/h/annotations/w/ann-0011/img-1.png" }, { "kind": "reference", "path": "/h/r.jpg" }],
                "followUps": [{ "comment": "still black", "previousNote": "set color", "createdAt": 1.0 }]
            }]
        })
    }

    #[test]
    fn list_renders_everything_an_agent_needs() {
        let rendered = render_list(&sample());
        for phrase in [
            "workspace coflux:workspace:3f2a1b7c (/src/app)",
            "## #2 · `ann-0011`",
            "> Make it blue",
            "Components (innermost first, react): SaveButton < Toolbar",
            "Source: `src/Save.tsx:12:3`",
            "Element: `<button id=\"save\" class=\"btn\">` with text \"Save\"",
            "Screenshot of the current state: /h/annotations/w/ann-0011/img-1.png",
            "Reference image from the user: /h/r.jpg",
            "The user reopened it: \"still black\"",
            "coflux annotations resolve <id>",
            "design system",
        ] {
            assert!(rendered.contains(phrase), "missing {phrase}\n{rendered}");
        }
    }

    #[test]
    fn a_multi_element_annotation_describes_every_element() {
        let annotation = json!({
            "id": "ann-2", "number": 5, "comment": "Align these",
            "targets": [
                { "element": { "tag": "button", "selector": ".a" }, "source": { "framework": "react", "components": ["Button", "Header"] } },
                { "element": { "tag": "div", "classes": ["card"], "selector": ".b" }, "source": { "components": ["Card"], "file": "src/Card.tsx", "line": 4 } },
                { "element": { "tag": "nav", "selector": "nav" }, "source": null }
            ],
            "region": null
        });
        let rendered = render_annotation(&annotation);
        for phrase in [
            "- Elements: 3 (the user selected them together; the comment applies to all of them)",
            "### Element 1 of 3",
            "Components (innermost first, react): Button < Header",
            "### Element 2 of 3",
            "Source: `src/Card.tsx:4`",
            "### Element 3 of 3",
            "Selector: `nav`",
        ] {
            assert!(rendered.contains(phrase), "missing {phrase}\n{rendered}");
        }
    }

    #[test]
    fn a_region_annotation_describes_the_region_its_container_and_what_is_inside() {
        let annotation = json!({
            "id": "ann-3", "number": 6, "comment": "Too crowded",
            "targets": [
                { "element": { "tag": "header", "selector": "header" }, "source": { "components": ["Header", "App"] } },
                { "element": { "tag": "img", "selector": "#logo" }, "source": { "components": ["Logo"] } },
                { "element": { "tag": "a", "selector": "a.home" }, "source": null }
            ],
            "region": { "x": 12.0, "y": 4.5, "width": 320.0, "height": 80.0 },
            "images": [{ "kind": "screenshot", "path": "/h/region.png" }]
        });
        let rendered = render_annotation(&annotation);
        for phrase in [
            "- Region: the user dragged a 320×80 px area on the page, 12 px right and 4.5 px down",
            "### Container (the innermost element holding the region)",
            "Components (innermost first): Header < App",
            "### Inside the region",
            "- Logo · `<img>` · selector `#logo`",
            "- `<a>` · selector `a.home`",
            "Screenshot of the current state: /h/region.png",
        ] {
            assert!(rendered.contains(phrase), "missing {phrase}\n{rendered}");
        }
    }

    #[test]
    fn empty_list_names_the_workspace() {
        let rendered = render_list(&json!({ "ref": "coflux:workspace:aa", "annotations": [], "resolvedCount": 2 }));
        assert_eq!(
            rendered,
            "No pending annotations in workspace coflux:workspace:aa. 2 resolved one(s) are waiting for the user to review."
        );
    }

    #[test]
    fn code_comments_render_their_location_and_lines() {
        let result = json!({
            "ref": "coflux:workspace:aa",
            "resolvedCount": 0,
            "annotations": [
                {
                    "id": "ann-7", "number": 7, "kind": "code", "comment": "Use the shared helper here",
                    "page": { "url": "", "title": "" }, "targets": [], "region": null, "images": [],
                    "code": { "path": "src/lib.rs", "side": "working-tree", "startLine": 12, "endLine": 14,
                        "lines": "fn total() {\n    a + b\n}", "baseCommit": null }
                },
                {
                    "id": "ann-8", "number": 8, "kind": "code", "comment": "Why was this removed?",
                    "targets": [], "region": null,
                    "code": { "path": "src/old.rs", "side": "base", "startLine": 3, "endLine": 3,
                        "lines": "let s = \"```\";", "baseCommit": "0a1b2c3d" }
                }
            ]
        });
        let rendered = render_list(&result);
        for phrase in [
            "# Annotations · workspace coflux:workspace:aa",
            "Code comments: the user commented on lines",
            "## #7 · `ann-7`",
            "> Use the shared helper here",
            "- Code: `src/lib.rs:12-14` in the working tree",
            "```\nfn total() {\n    a + b\n}\n```",
            "- Code: `src/old.rs:3` on the base side of the diff (the version at commit `0a1b2c3d`",
            "````\nlet s = \"```\";\n````",
        ] {
            assert!(rendered.contains(phrase), "missing {phrase}\n{rendered}");
        }
        // No page-annotation guidance or page lines for a code-only list.
        assert!(!rendered.contains("Browser annotations:"));
        assert!(!rendered.contains("- Page:"));
    }

    #[test]
    fn resolved_line() {
        assert_eq!(
            render_resolved(&json!({ "annotation": { "id": "ann-1", "number": 3 } })),
            "Resolved #3 (ann-1). The user will confirm it, or reopen it with a comment."
        );
    }
}
