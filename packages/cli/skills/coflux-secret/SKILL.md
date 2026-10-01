---
name: coflux-secret
description: Use this whenever you need a value from the user that must not appear in the conversation, the model provider's logs or on screen — an API key, token, password, database connection string, private key or certificate, cookie, recovery code, or personal data such as an ID or card number. Use it before you go digging for such a value in shell history, the keychain or the user's config files yourself, and use it the moment the user offers to paste a secret into the chat — stop them and ask through `coflux secret` instead. The user types or pastes the value into a masked card on their Coflux desktop or iOS app; you only learn whether it was provided, and the value reaches commands and dotenv files without ever entering your context. Works only inside a Coflux terminal. Not for interactive prompts (an ssh or sudo password prompt, a one-time code typed into a login flow).
---

# Get a secret from the user without seeing it

```sh
coflux secret ask OPENAI_API_KEY --reason "Run the integration tests against the real API"
coflux secret exec OPENAI_API_KEY -- pnpm test:integration
coflux secret inject DATABASE_URL --file .env.local
```

**Only inside a Coflux terminal.** `coflux secret` talks to the local Coflux daemon that runs this
terminal; you are in one when a `<coflux-session>` block is in your context or `COFLUX_SESSION_ID`
is set. Outside a Coflux terminal the command is unavailable: tell the user where the value needs to
go (an environment variable, a file) and let them put it there themselves — still never through the
chat.

## When to use it

Use `coflux secret` whenever a task needs a value only the user has and that the user would not
want in the transcript, in the model provider's logs or on screen:

- API keys, access tokens, passwords, database connection strings;
- private keys, certificates, cookies, recovery codes;
- personal data such as ID numbers or card numbers.

Three situations call for it:

1. **You need such a value.** Ask with `coflux secret ask`, never in the chat.
2. **You are about to dig it out yourself** — from shell history, the keychain, the user's dotfiles
   or config files of other projects. Stop and ask through the card instead.
3. **The user offers to paste it into the chat** ("I'll paste the key", "here is the token…").
   Intercept: tell them not to, and run `coflux secret ask` so they can enter it in the card. If a
   secret was already pasted into the chat, do not repeat or reuse it; suggest they rotate it and
   provide the new value through the card.

**Never ask the user to paste a secret into the chat**: that puts it in the transcript, the model
provider's logs and on screen. With `coflux secret` you never see the value; you get a name and an
outcome, and every use of the value goes back through coflux.

## Commands

- `ask NAME --reason "<why>"` shows a masked request card over this terminal in every Coflux desktop
  and iOS app of the account (plus one inbox notification). It blocks until the user answers, then
  prints exactly one word: `provided`, `declined` or `cancelled` (closed card, timeout — default
  10 minutes, `--timeout <seconds>` — or the terminal ended). Exit status is 0 only for `provided`.
  Write the reason for the user: say what the value is for and where it will go. NAME is an
  environment-variable name. Asking again for a NAME replaces its value. On `declined`, do not ask
  again unprompted; on `cancelled`, tell the user what you were waiting for before retrying. A
  timeout with no card on the user's screen usually means their app is too old — say so.
- `exec NAME [NAME…] -- <cmd> [args…]` runs the command with each value in a same-name environment
  variable, passes its exit status through, and shows every occurrence of a single-line value in
  its output as `***` (see the limit for multi-line values below). A NAME that was not provided in
  this terminal fails with a sentence telling you to `ask` first.
- `inject NAME --file <path> [--key KEY]` makes the daemon insert or update `KEY=value` (KEY
  defaults to NAME) in a dotenv file inside the workspace your cwd is in. A new file is owner-only;
  a path outside the workspace, including through a symlink, is refused. It prints only that the
  file was written. Checking that the file is gitignored is yours.

Values belong to **this terminal**: only processes in it can use them, and they are dropped when it
ends (and when the user's device restarts its coflux runtime) — a new terminal must `ask` again.
They live only in the local daemon's memory, never on disk or on the center. `coflux terminal read`
and the center's copy of any terminal show a held single-line value as `***`.

`ask` needs the daemon connected to the center (the request reaches the user's apps through it) and
fails at once otherwise; `exec` and `inject` stay local.

## Multi-line values

Private keys, certificates and JSON credentials span several lines. The user pastes them into the
same card; the value arrives with every line break intact, as **LF** (`\n`) line endings — any CRLF
or lone CR in what they pasted becomes LF, and nothing else changes, including a trailing newline.
Land such a value in one of three ways:

- **An environment variable**: `coflux secret exec NAME -- <cmd>`, exactly as for a single-line
  value.
- **A dotenv file**: `coflux secret inject NAME --file .env.local`. The daemon writes it
  double-quoted with line breaks escaped as `\n`, which dotenv readers turn back into line breaks.
- **A standalone owner-only file** (for example `key.pem`):

  ```sh
  coflux secret exec NAME -- sh -c '(umask 077; printf %s "$NAME" > <path>)'
  ```

  `printf %s` writes the value byte for byte, trailing newline included; `umask 077` makes the file
  owner-only from the moment it exists. Checking that the path is gitignored is yours.

**Multi-line values are not redacted in terminal output.** The `***` replacement matches only the
complete value as one piece. A terminal rewrites `\n` as `\r\n`, and a program may print a single
line of the value on its own, so a multi-line value — or any one line of it — printed to a terminal
shows in clear text in `exec` output, in `coflux terminal read` and in the center's copy of the
terminal. The only protection is never printing it: do not `cat` the file you wrote, do not echo
the variable, and do not run commands that dump their environment or config.

## Boundaries

- **Not for interactive prompts.** An `ssh` or `sudo` password prompt, or a one-time code typed into
  a login flow, stays with the user: open a terminal they can take over, `coflux notify` them, and
  `coflux terminal wait`.
- **The built-in executor cannot use `coflux secret`** (it is not a terminal process).
- **It prevents accidents, not a determined agent.** Once a value is in an environment variable or
  a file you can read, printing it on purpose would leak it — never do that.
