---
name: switchboard-artifact
description: Publish a file through Switchboard so the user can open it in a browser on any of their paired computers. Use when the user wants to view or share an image, screenshot, video, PDF, HTML page or Markdown document on another computer, or when you produced one (report, screenshot, recording, plan) for them to look at.
---

# Switchboard artifact

Switchboard's relay serves published files to the browser on every paired computer, so one link opens the file on the Mac, on Windows, or wherever the user is sitting. Publishing copies the files; the source stays authoritative.

Building the page itself (HTML layout, video and audio players, design boards) belongs to the `artifact` skill when it is available; this skill only publishes. Switchboard replaces that skill's Python static server: publish here instead of starting a server whenever this computer runs Switchboard.

## Publish

```sh
zellij switchboard artifact <file> [supporting files...] [--id <id>]
```

- The first file is the one the link opens. Supporting files are what it references (images in a Markdown document, scripts and media beside an HTML page). They must sit inside the first file's folder and keep their relative paths, so relative links keep working. When they live elsewhere, copy the set into one scratch folder and publish from there.
- `--id` names the folder `~/.switchboard/artifacts/<id>/`. The default is the first file's lowercase name without its extension. Pick a short, stable id per deliverable (`bench-video`, `tab-latency-plan`) and republish with the same `--id` after every edit: the link stays the same. Republishing overwrites files of the same path and leaves dropped files in place.
- The command prints one link: `http://127.0.0.1:8091/artifacts/<computer>/<id>/<file>`.

Images, video, audio, PDF and HTML open as authored; video and audio seek. Markdown renders as a reading page; append `?raw` for the source.

## Report

Check the link before sharing it: `curl -sS -o /dev/null -w '%{http_code}\n' '<link>'` prints `200`. That proves this computer only; say so, and say it opens on other computers that run a build with artifact support.

Give the user the printed link verbatim on a line of its own. The same `127.0.0.1` link is correct on every paired computer: each one's relay fetches the file over pairing. The listener answers only to `127.0.0.1:8091` or `localhost:8091`, so keep the host exactly as printed.

## Not yet available

Report these as missing rather than inventing flags:

- No `list` or `remove` command. List with `ls ~/.switchboard/artifacts`; remove an artifact by deleting its folder there.
- Mermaid fences show as code, headings have no anchors, and raw HTML inside Markdown shows as text.
- An open page does not refresh after a republish; tell the user to reload.
- Artifact pages cannot reach terminal APIs: they run on a separate origin the terminal relay rejects.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `unrecognized subcommand 'artifact'` | This computer's `zellij` predates artifact support | Tell the user. A merge to `main` reaches every computer within about 15 minutes. |
| `Published to …, but the Switchboard relay did not answer` | Relay on port 8090 is down; the files are copied | Check `curl -sS http://127.0.0.1:8090/api/hosts`, then the relay log (`~/Library/Logs/zellij-switchboard.log` on Mac, `~/.config/switchboard/web.log` on Windows). Republish once it answers. |
| `… must be inside …, the first file's directory` | A supporting file sits outside the first file's folder | Stage everything into one folder and publish from there. |
| Connection refused on 8091 | The viewing computer's relay is down or predates artifact support | Check its build in `/api/hosts`. |
| `Unknown computer` | The viewing computer is not paired with the publisher | Check `/api/mesh` on the viewing computer. |
| `Computer unavailable` or `Computer timed out` | The publishing computer is offline or unreachable | Its files load once it is back. |
| Opens here, `Artifact not found` elsewhere | The publishing computer's build serves no artifacts to peers yet | Compare build commits in `/api/hosts`; wait for the update. |
| `Markdown too large to render; add ?raw` | Document over 4 MB | Share the `?raw` link or split the document. |
| `Untrusted artifact request` | The host in the link was changed | Use the link exactly as printed. |
