---
name: opencode-session-tools
description: Cross-session tools for opencode. List the sessions in this project, ask another session a question and get its answer back, rename, move, or stop a session. Use when the user points at another session ("ask the JYZ one"), when work in one folder needs a fact another session already established, or when a runaway session or subagent must be stopped.
---

# opencode-session-tools

Five tools that make the other opencode sessions on a machine addressable. They run inside
the opencode server through a plugin, so calls happen in-process: no shell, no HTTP, no
copy-pasting between windows.

## Permission first

**Never call these tools unless the user asked.** Another session is live work someone is
watching. `session_ask` spends that session's tokens, and `session_interrupt` destroys work in
flight. The user naming a session, or saying "stop it", is the permission. Absent that, read
and report instead.

## Install

The plugin is this directory. opencode picks plugins up from its config directory, so one
symlink is the whole install. Any POSIX shell:

```sh
mkdir -p "$HOME/.config/opencode/plugin"
ln -sfn "$PWD/src/index.ts" "$HOME/.config/opencode/plugin/session-tools.ts"
opencode plugin list          # or: opencode mcp list is unrelated; check the log for "loading plugin"
```

`install.sh` in this directory does exactly that and prints the result. The plugin needs no
build step and no `node_modules` at runtime: the host supplies `@opencode/plugin` and `effect`,
so only typechecking wants them (`bun install && bunx tsc --noEmit`).

opencode reloads it on the next config touch. If the tools do not appear, touch
`opencode.json` and check `~/.local/share/opencode/log/opencode.log` for `loading plugin`.

## The tools

### `session_list`

Lists top-level sessions for the current project, newest first.

```json
{ "limit": 20, "search": "jyz", "directory": "~/dev/jyz", "subagents": false }
```

Returns, per session: `id`, `title`, `directory`, `updated`, `parent`, `running`. Pass
`subagents: true` to include child sessions (subagents) with their `parent`. `search` matches
titles, `directory` filters by folder.

Use it to learn an id or title before anything else, and to see which sessions are `running`
before deciding to interrupt one.

### `session_ask`

Sends a question to another session and returns its answer.

```json
{
  "session": "ses_…",
  "question": "Should the deletion of packages/cli/opencode.json be committed?",
  "timeout_ms": 120000,
  "delivery": "steer"
}
```

- `session` accepts a session id (`ses_…`), an exact or partial title, or a directory.
- Every question arrives with a provenance line the tool writes itself:

  ```
  [sent from session ses_18f2c3a9… model commandcode/deepseek-v4.1-flash#high]
  [answer, then continue your own work immediately — do not stop or wait]
  ```

  The first line is built from the asking session's own row, not from any argument, so it
  cannot be dropped, and it always precedes the question text. The second tells the target the
  question is a side errand: answer it, then carry on with what it was doing. Neither line can
  be removed by the sender; treat them as the message's header.
- `delivery: "steer"` (default) hands the question over as soon as the target's current turn
  finishes. It never interrupts what is running — no model call, no tool, no shell is cut — it
  simply waits for this turn to end. `delivery: "queue"` instead waits behind work already
  pending, so it can sit out several turns before it is read. `steer` is core's own default.
- The answer is **only this exchange**: every assistant message after the question was
  admitted. The session's earlier work is not included, and it carries on with its own queue
  afterwards.
- The reply is returned the moment it appears — the tool polls the target's transcript and
  never waits for that session to fall idle, so a target that answers mid-work and keeps going
  costs you seconds, not its whole run. Measured: 7 s against a session that stayed busy
  afterwards, with `answer` exactly `pong`.
- `answered` is `false` when the timeout expires without any reply text; the target may still
  be working. Ask again rather than reading silence as a no.
- The question carries `metadata.from_session`, so the other side can see who asked.

### `session_rename`

```json
{ "session": "ses_…", "title": "JYZ" }
```

Changes the title in the session list and the sidebar. Address by id, title or directory.

### `session_move`

```json
{ "session": "ses_…", "directory": "~/dev/jyz/packages/cli" }
```

Moves a session to another directory; its next turn runs there with that project's files,
instructions and config. Relative paths resolve against the session's current directory.

### `session_interrupt`

```json
{ "session": "ses_…" }
```

Stops that session's current turn: the model loop, any subagent it is waiting on, and the
shell commands it started — interrupting a session cancels its jobs. Subagents are child
sessions, so a child's id stops just that subagent; the id is in the `subagent` tool's result.
On an idle session it is a no-op and reports `interrupted: false`.

This is the only destructive tool here. The owner cannot undo it, so it needs the user's
explicit word.

## Reading the results

Every tool returns structured output plus a one-line `content` summary. `session_ask` also
returns `sessionID`, so a follow-up can go straight back to the same session. Errors are plain
sentences; an unknown session says to run `session_list` first.

## Files

- `SKILL.md` — this file.
- `src/index.ts` — the plugin: five tools in one `Plugin.define({ id, setup })`.
- `package.json`, `tsconfig.json` — typecheck only (`bun install`, `bunx tsc --noEmit`).
- `install.sh` — symlink it into an opencode config directory.
