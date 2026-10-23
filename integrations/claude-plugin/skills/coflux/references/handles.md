# Entity handles

Read this when a `coflux:` string does not resolve, when you need to know which `ref` fields a
command returns, or when an older daemon rejects a handle.

## The grammar

Every coflux entity has a **handle**: one short string that says both "this is coflux" and "this is
a device / project / workspace / terminal".

```
coflux:device:b6767697
coflux:project:7a83f21e
coflux:workspace:3f2a1b7c
coflux:terminal:9e21c4d0
```

The grammar is `coflux:<kind>:<short>`. `<kind>` is one of `device`, `project`, `workspace` and
`terminal`. `<short>` is the first 8 hexadecimal characters of the entity's UUID — its first
dash-delimited group. Handles are always generated in lowercase and are read case-insensitively.
There is nothing else encoded in one: no name, no timestamp, no device. UUIDs stay canonical; a
handle is another way to *write* an id, not a replacement for it.

**Anywhere an id is accepted, a handle is accepted.** That covers every account CLI command taking
a device, project, workspace or terminal id, the `--device` / `--workspace` filters of the list
commands, and every local terminal command taking a terminal id. `coflux terminal read
coflux:terminal:9e21c4d0` and `coflux terminal read <that terminal's full UUID>` are the same call.

**Anywhere an entity is returned, its handle comes back too**, in a `ref` field beside the
entity's unchanged id field. The ids in JSON — `taskId`, `workspaceId`, `deviceId` — are still full
UUIDs, and `ref` is the handle next to them; where one payload carries two ids of the same kind it
gets two keys, as `coflux workspace` does with `ref` and `owningRef`. Local terminal results carry
both as well, and their `taskId` is always the **resolved** UUID — never the handle you passed in,
so it is safe to feed onward. The local `coflux terminal list` text rows lead with the handle, so
the next command can be typed straight from what you just read.

So when the user pastes you a `coflux:` string, you already know what kind of thing it names and
can use it as-is — no listing, no guessing. Handles are made to be pasted rather than displayed:
the desktop and iOS clients offer "copy handle" on the entity (right-click in the desktop sidebar
and terminal tabs, long-press on iOS rows and terminal chips) and show no handle text otherwise.

## When a handle does not resolve

A handle is a prefix, so resolving one can fail in three distinct ways — and there is a fourth case
that is not a resolution failure at all. Each is one readable sentence; what matters is which of the
four you got:

- **Nothing matches** — no entity of that kind, within the scope that command can see, starts with
  that short id. The handle belongs to another account, to a workspace you are not in, or to
  something that no longer exists. List and pick again; re-running the same string cannot help.
- **More than one matches** — two entities of that kind share the short id, so nothing is acted on.
  Use the full UUID instead. There is no "first match" fallback, and picking one yourself is
  exactly what the error exists to prevent.
- **Wrong kind** — the handle is well-formed but names a different kind than the command expects
  (a workspace handle where a terminal id goes). The command fails rather than act on an adjacent
  entity; the fix is a handle of the expected kind, never a retry.
- **It was never a handle** — the `coflux:<kind>:` prefix is **mandatory**. `b6767697` on its own is
  not a handle, however faithfully it copies the first 8 characters of a real UUID. Nothing rejects
  it as malformed: it is forwarded untouched as a literal id and fails wherever that id is looked
  up, **with a message that says nothing about id syntax** — for a device it reads
  `设备 b6767697 不存在或不属于当前账号`. The three errors above cannot warn you here, because the
  string never reached the resolver. Write `coflux:device:b6767697`, never `b6767697`.

The scopes differ on purpose: account CLI commands resolve a handle among **the requesting
account's** entities, while local terminal commands resolve it among the terminals of **the
workspace your cwd is in** — the same boundary that already makes another workspace's terminal
indistinguishable from one that does not exist. An unknown terminal handle therefore shares the
local "terminal is not in this workspace or does not exist" sentence; a terminal handle of the
wrong kind, or whose prefix matches more than one terminal in this workspace, has its own sentence.

Handles need a daemon and a CLI new enough to know about them. An older one rejects a handle the
way it rejects any unrecognised id; there, use the full UUID and tell the user to upgrade.
