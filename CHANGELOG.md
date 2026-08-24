# Changelog

## [0.8.0] - 2026-08-24

### Added

- Initial release: per-task CPU and memory for running Kandev agents, opened
  with a global hotkey or from a top-bar chip.
- Exact attribution from `KANDEV_TASK_ID` in each process's environment, with
  parent inheritance as the fallback.
- Linux, macOS and Windows samplers. Linux reports PSS where available.
- Per-task CPU sparklines, idle-task grouping with hysteresis, and a filter
  across task titles, process names, command lines and PIDs.
