# opencode-monitored-shell

OpenCode plugin that runs **every** command in the background with its complete
`stdout`+`stderr` written to a log file on disk. The agent reads deltas instead
of holding a pipe, so a long build cannot die with the turn and nothing is lost
to output truncation.

Built for OpenCode V2 (`Plugin.define` / `setup(ctx)`). It needs no Bun and no
V1 API: plain Node, plain `child_process`.

## The problem

The built-in `shell` tool keeps output in the tool result. Long output is
truncated to a preview, and a command that outlives the foreground timeout is
killed with the turn. Workarounds — wrapping in `| tail`, re-running to see the
middle, raising timeouts — all lose information.

This plugin inverts it:

- the process is spawned detached, so it survives the turn and a client
  disconnect;
- `stdout` and `stderr` share one file descriptor, so their order is preserved
  and the file grows to whatever size the command produces;
- the agent polls only the lines appended since its previous call;
- the whole log stays on disk, so the middle of a 20-minute build is one
  `grep` away.

## Install

From npm:

```jsonc
{
  "plugins": ["opencode-monitored-shell"]
}
```

From git, without publishing:

```sh
opencode plugin add github:yakov255/opencode-monitored-shell
```

## Tools

| Tool | Purpose |
| --- | --- |
| `run` | Start a command detached. Returns `id`, `pid`, log path. |
| `run_status` | Status plus **only new lines** since the last call. `wait: N` blocks up to N seconds and returns earlier on exit. |
| `run_logs` | Full log: `tail`, `grep` by regex, or `from_line`. |
| `run_stop` | `SIGTERM` to the process group, then `SIGKILL` after a grace period. |
| `run_list` | Runs with status, exit code and runtime. |
| `run_cleanup` | Delete finished runs older than N hours (default 72). |

### Observing a long command

```
run({ command: "docker build -f Dockerfile.prod -t app .", label: "build" })
→ id: build-20261120-170037-epnu
  pid: 2108304
  log: ~/.local/share/opencode/runs/build-20261120-170037-epnu.log

run_status({ id: "build-20261120-170037-epnu", wait: 30 })
→ status: running
  newLines: 8
  <only the 8 lines appended since the previous call>
```

`wait` is the polling interval. Use `30` for normal work and `600` or more for
slow builds: the call returns as soon as the process exits, so a large `wait`
costs nothing when the command finishes early.

### Reading history

```
run_logs({ id, mode: "grep", pattern: "error|warning" })
run_logs({ id, mode: "from_line", from_line: 400, limit: 100 })
run_logs({ id, mode: "tail", lines: 50 })
```

## Design notes

**No automatic kill on error.** Lines that look like errors are reported in a
`warnings` field, and that is all. `error:` appears in the output of successful
builds, tests print `FAIL` as part of normal operation, and `grep` exits 1 when
it finds nothing. A regex that kills processes would destroy more work than it
saves, so the decision stays with the agent that can read the context.

**No timeout.** A command runs until it finishes or until `run_stop`. There is
no barrier to lift, because the process is not tied to the request.

**Deltas, not buffers.** The read offset is stored in the run registry on disk,
so the delta does not depend on conversation history. Truncation is never
silent: `skippedLines` and `unreadBytes` say what was not shown.

**Lines never split.** When a delta hits the 256 KB read limit mid-line, the
plugin backs up to the last newline and reports the remaining bytes, so no line
arrives as two fragments.

**One ping on completion.** When a run finishes, the plugin posts one synthetic
message to the session that started it. An agent busy with something else is
told once, instead of polling an idle process.

## State

Everything lives outside projects:

```
~/.local/share/opencode/runs/
├── runs.json          # registry: id, command, cwd, pid, times, exit code, offset
├── build-<ts>.log     # complete stdout+stderr, never truncated
└── deploy-<ts>.log
```

`XDG_DATA_HOME` is respected. Runs survive an OpenCode service restart: the
registry is on disk and status is verified against the real PID.

## Requirements

- OpenCode V2 (plugin API `Plugin.define`)
- Node ≥ 20 (ships with OpenCode)
- POSIX: process groups via `detached`, `SIGTERM`/`SIGKILL`. Windows is not
  supported.

## License

MIT
