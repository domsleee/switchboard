---
name: Bug report
about: Report a Switchboard problem
title: ''
labels: ["suspected bug"]
assignees: ''
---

## Environment

- Platform and OS version:
- `zellij --version`:
- Browser and version, if relevant:
- Component: terminal engine, browser, relay or desktop helper:

## Expected and actual behavior

## Minimal reproduction

Use an isolated test session when reproducing terminal or connection issues.

## Relevant diagnostics

Include relevant logs or screenshots, with tokens and private terminal
contents removed. For terminal rendering issues, include pane dimensions
(`stty size` on Unix) and the command that produces the output.

If raw terminal bytes are needed, run `zellij --debug` in an isolated session.
Native log paths are defined in
[consts.rs](../../zellij-utils/src/consts.rs). See the
[setup guide](../../tools/switchboard/README.md) for desktop helper logs.
