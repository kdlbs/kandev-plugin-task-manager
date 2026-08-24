# Kandev Task Manager

Per-task CPU and memory for your running Kandev agents. Press
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Esc</kbd> (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>Esc</kbd>
on macOS) and see which task is actually eating the machine.

![The Task Manager modal, showing three working tasks with CPU sparklines and memory](docs/media/overview.png)

## Why

A busy Kandev instance runs a dozen agents at once. When the fans spin up, the
host's own process list tells you that `node` is busy — not *which task* asked
for it. This measures the machine and attributes every process back to the
Kandev task that spawned it.

## What it shows

Expand a task to see the processes it owns: the agent, its tool calls, and
anything they started in turn.

![A task expanded to show its process tree with command lines](docs/media/processes.png)

- **CPU** as a live rate, where **100% is one core** — the `top`/`htop`
  convention. A task pegging one core reads 100%, not 6% of a 16-core box. The
  bar turns red past a full core.
- **A sparkline** of roughly the last 30 seconds, so you can tell a steady
  load from a spike.
- **Memory**, summed over the task's whole process tree.
- **Idle tasks folded away.** Most agents sit at zero waiting on a reply;
  listing twenty of them buries the one doing work. Anything under 1% CPU
  collapses into a single row you can expand.

Filter by task title, process name, command line or PID. Click **Open** to jump
to the task.

![Filtering by a process command line](docs/media/filter.png)

## How attribution works

Kandev exports `KANDEV_TASK_ID` and `KANDEV_SESSION_ID` into every agent's
environment, and every process the agent spawns inherits it. So attribution is
exact rather than guesswork:

1. A process that declares `KANDEV_TASK_ID` in its own environment belongs to
   that task.
2. Otherwise it inherits its parent's attribution — which is what covers a tool
   call that scrubbed its environment (`env -i make`).

Ancestry is used only as the fallback, because a process's own declaration is
the ground truth. That ordering matters: the other way round, a process that
deliberately re-declares the variable gets silently charged to whichever task
happened to spawn it.

This is also why a dev server that outlived its shell still shows up. Being
re-parented to `init` severs it from the tree, but it kept the inherited
environment, so it is still attributed correctly.

Note that `/proc/<pid>/environ` reflects the environment a process was given at
`exec` time. A process cannot unset its way out of attribution afterwards.

## Platform support

| Platform | Process table | CPU | Memory | Environment |
| --- | --- | --- | --- | --- |
| Linux | `/proc` | `utime`+`stime` delta | **PSS** via `smaps_rollup`, falling back to RSS | `/proc/<pid>/environ` |
| macOS | `ps` | `TIME` delta (centisecond resolution) | RSS | `sysctl KERN_PROCARGS2` |
| Windows | Toolhelp32 | `GetProcessTimes` | Working set | PEB via `ReadProcessMemory` |

Memory marked with `*` is RSS, which counts pages shared between a parent and
its children in *every* process, so a tree total reads high. Linux reports PSS
where it can, which splits shared pages proportionally and can be summed
honestly.

> **Windows is untested.** It compiles and its parsers are unit-tested, but the
> syscall path has never been run on a Windows machine. It fails soft: if the
> PEB read is refused, a process inherits its parent's attribution rather than
> crashing. Reports welcome.

## Install

Download the tarball from [Releases](../../releases), then either:

- **Settings → Plugins → Install** and upload it, or
- drop it in `~/.kandev/plugins/` and press **Sync**.

The hotkey is remappable in **Settings → Keyboard shortcuts**. A CPU chip also
appears in the top bar on the Kanban and Tasks views, and opens the same panel.

![The panel open over the Kanban board, with the CPU chip in the top bar](docs/media/in-app.png)

## Cost

Sampling is request-driven: with the panel closed, the plugin does nothing.

A warm poll costs about **30 ms** on a machine running 24 tasks across 748
processes — essentially the cost of one `/proc` scan. Reading PSS for every
attributed process costs an order of magnitude more (~370 ms), so memory is
refreshed on its own slower cadence and reused in between. CPU percentages come
from a delta of cumulative CPU time across a 700 ms window, never from a
lifetime average like `ps %cpu`, which would report an agent that was busy an
hour ago as busy now.

## Development

```sh
make test          # unit tests
make live          # sample this machine and print the per-task rollup
make package-host  # build a package for the host platform only
make package       # build all five platforms
```

The Go SDK is not published as a standalone module yet, so `go.mod` resolves it
from a sibling checkout of the Kandev monorepo at `../kandev/apps/backend`.

`.harness/` renders `ui/bundle.js` against a stub host that reproduces Kandev's
real `DialogContent` — including that it is a CSS grid, which is what makes
layout bugs appear in the app but not in a naive mock:

```sh
python3 -m http.server 8977 &
node .harness/shoot.mjs      # layout, overflow, ordering and styling checks
node .harness/real-app.mjs   # the same checks against a running Kandev
```

## Licence

MIT — see [LICENSE](LICENSE).
