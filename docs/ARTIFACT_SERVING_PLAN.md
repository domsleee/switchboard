# Artifact serving and Markdown previews

Status: a first slice is implemented; the rest of this document is still the agreed
direction.

Implemented:

- `zellij switchboard artifact FILE [MORE FILES] [--id ID]` copies the files into
  `~/.switchboard/artifacts/ID/` (later files keep their paths relative to the first
  file's directory) and prints
  `http://127.0.0.1:8091/artifacts/COMPUTER/ID/FILE`. `COMPUTER` is this computer's
  paired name; a host ID or display name also works.
- The relay's loopback artifact listener on port 8091 serves those files with GET,
  HEAD and single byte ranges (`206`, `416`), content types by extension, and no
  directory listings. Markdown renders on request with raw HTML shown as text and
  unsafe link schemes removed; `?raw` returns the source.
- Another computer's artifacts load through the paired gateway, with the same
  credential as its terminals. Each computer's browser opens the same URL.
- Paths must be plain relative names. The real path, after symlinks and junctions,
  must stay inside its artifact directory.

Deviations from the plan below:

- No LAN listener or `public_url`. Artifacts stay loopback-only and reach other
  computers through pairing, so they need no anonymous LAN access. The legacy
  `artifact_proxy` gallery still works on the same 8091 listener.
- Not yet: Mermaid, heading anchors, refresh of open documents, `list`/`remove`
  commands, the `switchboard_artifact` skill, and per-ID publication locking.

Switchboard should serve project documents and HTML artifacts from the machine
where they live. Each machine gets one configured address and one shared artifact
listener in the existing Rust relay process. Artifacts live under
`~/.switchboard/artifacts/`. An agent publishes a document there and receives a
stable URL that works from the other computers on the LAN.

Markdown is a primary use case. Designs already live in repository docs folders,
including this plan and Switchboard's update and acceptance documents. The user
and agent should be able to edit those files normally and read them through
Switchboard without maintaining a second HTML copy.

## What we have today

The dotfiles `artifact` skill creates HTML and media, and ships a Python static
server with byte-range support. The skill already recommends reusing a suitable
server, but otherwise leaves a helper process to manage for each serving job.

Switchboard's [artifact relay](../zellij-client/src/switchboard_relay/artifacts.rs)
streams an upstream server through a separate listener on `127.0.0.1:8091`.
The current Windows gallery uses that relay through Portless. The relay does not
serve local files itself. Its host validation and embedding policy assume the
existing local URLs, and it does not forward range request and response headers.
See the [current setup](../tools/switchboard/README.md).

Consolidation should remove repeated helper processes and port management. We
should measure the memory saving rather than assume it is large. Serving files
in Rust will not remove the browser memory needed to display them.

## The proposed workflow

Each artifact has its own directory beneath the user's Switchboard directory:

```text
~/.switchboard/
  artifacts/
    artifact-serving-plan/
      ARTIFACT_SERVING_PLAN.md
      images/
    media-review/
      index.html
      comparison.mp4
```

An agent can author an artifact directly in that directory. A design that belongs
in a repository stays in the repository; publishing copies its Markdown and
selected supporting files into the artifact directory. For example, the proposed
CLI could be:

```sh
zellij artifact publish docs/ARTIFACT_SERVING_PLAN.md \
  --id artifact-serving-plan --title "Artifact serving plan"
```

This uses the existing executable, currently named `zellij`. The command syntax
is illustrative. It would return a URL such as:

```text
http://192.168.1.20:8091/artifacts/artifact-serving-plan/ARTIFACT_SERVING_PLAN.md
```

Opening that URL renders the Markdown. The viewer offers a raw source link and
shows the title. HTML documents open as authored, with relative images, scripts,
audio and video served from the artifact directory. The publishing command needs
an explicit way to include supporting files while preserving their relative
paths; it must not copy a whole repository implicitly.

For repository documents, the repository file is authoritative and the served
copy is a publication. The agent republishes after editing the source, updating
the same URL. Automatic browser refresh observes the published files; it does
not silently synchronise arbitrary repository files. Documents authored directly
in the artifact directory appear in the browser as they are edited. Both paths
serve Markdown directly without maintaining a generated HTML copy.

Closing the originating terminal does not remove an artifact. Published copies
survive moving or deleting the original checkout. Removing an artifact deletes
its published directory, leaving repository source files intact.

## Dedicated agent skill

Ship a dedicated **`switchboard_artifact`** skill with artifact support. This is
part of the implementation deliverable, not a claim that publication works today.
Keep its source in the Switchboard repository so Mac and Windows installations
can receive the same version alongside the executable. Use the skill-creator
workflow when implementing and validating the skill.

The skill covers authoring or updating an artifact, publishing it through the
running Switchboard service, and returning a verified URL. Repository documents
remain authoritative; include only explicitly selected supporting assets and
republish to the same artifact ID. Use `~/.switchboard/artifacts/` for published
files, never the Obsidian vault by default. Reuse the shared Rust listener rather
than starting a server per artifact.

Instructions must use the actual implemented CLI and report missing capability
honestly on older installations. Do not describe illustrative commands from this
plan as available. Verify Markdown, relative assets and media as applicable;
use headless browser checks and screenshots without opening desktop windows.
Distinguish a locally verified URL from one tested on another computer.

Include skill installation/discovery on Mac and Windows in packaging acceptance.
Exercise the skill with a repository Markdown publication, an HTML mockup with
relative assets, an update retaining its URL, and an older executable lacking
artifact support. Removing a publication must preserve its repository source.

## Serving across machines

Add an optional `artifacts` section to each machine's existing JSON relay config:

```json
{
  "artifacts": {
    "listen": "0.0.0.0:8091",
    "public_url": "http://192.168.1.20:8091"
  }
}
```

This is a proposed config fragment. `listen` controls the socket;
`public_url` controls the links returned to the user. Each computer has a fixed
IP, so configuration is sufficient. No discovery, automatic IP selection, or
Portless setup is required. Binding to the specific LAN IP is also valid.

```text
Browser on Mac or phone
  -> Windows fixed IP and artifact port
  -> Windows Switchboard relay
  -> ~/.switchboard/artifacts/ on Windows
```

Requests go directly to the machine holding the files. The Mac does not need to
relay Windows files. If Windows is offline, its documents are unavailable. The
first version does not replicate artifacts between computers.

Keep the artifact listener separate from the terminal listener, within the same
process. Only artifact reads are exposed on the LAN; publishing is a local
filesystem operation. Existing terminal authentication and binding remain intact.
An optional Portless alias can point at the artifact listener later.

## Markdown rendering

Render Markdown on demand using a maintained parser, with a small bundled reading
template. Include headings and anchors, tables, task lists, fenced code,
images, links and Mermaid diagrams in the first release. Bundle the Mermaid
renderer so diagrams do not depend on a CDN. Use readable typography and a sensible content width.

Relative image and document links resolve against the current document inside
the artifact directory. Links to another `.md` file open its rendered view; anchor
links continue to work. Provide raw Markdown through an explicit query or route.
Disable raw HTML in Markdown initially and reject unsafe link schemes. Explicit
HTML artifacts retain their existing JavaScript behaviour on the artifact origin.

Render when requested, with a document size limit and no unbounded rendered-page
cache. Automatically refresh an open Markdown document after published content
changes, preserving its scroll position where practical. Watch only artifacts
with active viewers, share watches between viewers, and release them when the
last viewer disconnects. Debounce editor saves. No watcher is needed for closed
documents, and no browser editor or Markdown-to-HTML build step is needed.

## Publication and lifecycle

Use directories as the catalog rather than maintaining a separate database.
Store small per-artifact metadata outside the publicly served tree, under
`~/.switchboard/`, if needed for titles and entrypoints. An artifact's directory
name is its stable ID. A session or tab association can be added later; it should
not determine document lifetime.

The local CLI publishes files atomically where possible and reports completion
only after the selected content is available. It must handle concurrent writes to
the same ID explicitly, rather than silently mixing two publications. Publishing
must not restart the relay. A whole-directory atomic swap across platforms is an
implementation detail to resolve; the browser should refresh only after a
publication completes.

The CLI needs publish, list and remove operations. Republishing the same source
updates its existing ID; replacing an unrelated artifact requires an explicit
overwrite. The skill prints the resulting link in the conversation. A searchable
library in the Switchboard UI is deferred.

## Boundaries that affect the design

- Serve only directories beneath `~/.switchboard/artifacts/`. Reject path
  traversal, symlinks escaping an artifact directory, and Windows junction
  escapes. Keep Switchboard configuration and metadata outside the served tree.
  Disable directory listings.
- Stream media with bounded buffers. Preserve GET, HEAD and byte ranges so audio
  and video can seek without downloading the complete file.
- LAN serving is opt-in. The simple first version is readable by anyone who can
  reach the configured listener; artifact IDs are not authentication. This is the
  agreed access model for the current LAN setup.
- Keep artifact content away from terminal APIs and credentials. A different port
  creates a separate origin, but cookies are not port-scoped; review cookie scope
  if terminal access is ever exposed on the same IP. The artifact service must not
  use terminal cookies or allow cross-origin terminal control.
- Open documents in a new browser tab initially. An HTTPS Switchboard page cannot
  reliably embed HTTP LAN artifacts because of mixed-content restrictions. An
  embedded preview would need a compatible HTTPS route or a same-scheme setup.

## Delivery plan

1. Add configuration, local publication and direct file serving to the existing
   relay. Keep the legacy `artifact_proxy` configuration working during migration;
   reject conflicting listeners with a clear error rather than silently taking
   port 8091. Update host validation for the configured address.
2. Add Markdown rendering, Mermaid, raw-source access and refresh while a
   document is open. Use this plan and the existing update document as real
   reading examples, including relative links and images.
3. Update the dotfiles artifact skill to publish through Switchboard when available.
   For repository documents, republish after source edits.
   Preserve its standalone fallback for machines without Switchboard. A Markdown
   design should not need to become an HTML artifact to use the service.
4. Migrate one Mac document and one Windows media artifact. Verify both from a
   second device before retiring their old helper servers. A small artifact list
   in Switchboard can follow; cross-machine aggregation, inline previews,
   comments and version history are separate follow-ups.

Validation should cover publication persistence, stable URLs, missing files,
containment on both operating systems, Markdown links, Mermaid, raw source,
refresh after edits or republication, watcher cleanup after closing viewers, and exact
range responses including `206`, `416` and body-free HEAD responses. Check browser
reading and media seeking from another computer. Compare process count and memory
with several published artifacts and concurrent large downloads; idle memory
should not grow with total media size. Confirm terminal sessions survive an
artifact error or connection-service restart.

## Agreed scope

The first release uses anonymous fixed-IP LAN access and stores artifacts under
`~/.switchboard/artifacts/`. Links in the conversation open documents in a new tab;
a document library is not required. Markdown, Mermaid and automatic refresh of
open documents are included.

The main implementation questions are publication consistency across platforms
and copying a document's supporting files without breaking relative links. Keep
those mechanics small. Remote discovery, cross-machine replication, an embedded
editor, comments and version history are outside this release.
