# Implement the user's annotations: browser annotations and code comments

Read this when the user hands you annotations (the desktop types an instruction into your terminal,
or they ask you to handle the annotations), or before `coflux annotations list|resolve|watch`.

```sh
coflux annotations list
coflux annotations resolve 3 --note "Primary button now uses the brand token; spacing from the 8px scale"
coflux annotations watch
```

Annotations come in two kinds that share one numbered list (#1, #2…):

- **Browser annotations**: the user points at elements of a page in Coflux's built-in browser tab
  ("this element — change it like so").
- **Code comments**: the user reviews this workspace's diff in Coflux's changes view and comments
  on a line or a range of lines ("rename this", "this breaks when the list is empty").

They belong to the workspace your cwd is in and live on this machine, so they are there whether or
not a desktop is open.

- `list` prints the pending ones, both kinds, as markdown: the user's comment (and, for a reopened
  one, your earlier note and what the user answered), then where it points. It always names the
  workspace it resolved: an empty list in the wrong workspace means you moved (`coflux workspace`).
  Add `--json` for structured output (`kind` is `page` or `code`).
- A **code comment** gives the file, the line range and the side of the diff, then the commented
  lines in a fenced block. `in the working tree` means the current file; `on the base side` means
  the version the changes are compared against (with its commit), typically lines the change
  removed or replaced — read that version with `git show <commit>:<path>` if you need more context.
  The line numbers are where the lines were when the comment was written: if the file has changed
  since, find the commented lines by their text. The comment is about those lines, but the fix may
  belong elsewhere (a caller, a test); make the change the comment asks for.
- A **browser annotation** gives the page, the component chain and source location when the page
  exposed them, the element's selector, DOM path and key computed styles, and the paths of its
  images.
- A browser annotation is not always one element. When the user selected several elements together, it
  lists each one with its own component chain and context under "Element 1 of n": the comment
  applies to all of them, so change them consistently and resolve the annotation once. When the user
  dragged a **region**, it gives the region's size and offset, the *container* (the innermost
  element holding it — usually the component to edit) and the components inside the region; the
  comment is about that area as a whole, and the screenshot shows exactly the region.
- Find the code from the most specific lead: a source location first, then the component names,
  then text and selectors (`rg` for them). Treat the computed styles as the current state, not as
  the target: map colors, sizes and spacing onto the project's design system (its tokens, theme and
  components) instead of hard-coding raw values.
- The images are local files: read them. A *screenshot of the current state* shows the element as
  the user saw it; a *reference image* is what the user wants or pointed at.
- After implementing each annotation, run `resolve <id or number> --note "<what you changed>"`.
  The note is what the user reads to review the change; the pin on their page (or the comment card
  under the diff line) turns into a check.
  They confirm it (it disappears) or reopen it with a comment, and it comes back in `list`. Resolve
  only what you actually changed; if you cannot or should not do one, resolve it with a note that
  says why rather than leaving it pending silently.
- `watch` blocks until the workspace has pending annotations and then prints them like `list`
  (default budget 30 minutes, `--timeout <seconds>`). Use it only when the user asked you to keep
  handling annotations hands-free: loop list → implement → resolve → `watch`.
