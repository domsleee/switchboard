# Inline HTML cards in Conversation mode

Status: proposal. Nothing here is implemented.

An agent should be able to put a diagram in a conversation and have it look native,
as T3 Code's `html_render` tool does. Switchboard can get there with what it already
has: a file on the agent's computer, a line naming it, and a script-free sandboxed
frame in the transcript.

## Flow

1. The agent writes one self-contained page to
   `~/.switchboard/artifacts/<id>/<name>.html`, using a new `<id>` for each version.
2. The agent prints the page's full path on its own line. This is the convention
   images already use, stated in `plugins/switchboard/session-context.md`.
3. `conversation-media.js` sees a path matching
   `/.switchboard/artifacts/<id>/<name>.html` and renders a card.
4. The card reads the page as text from `/api/hosts/{host}/file`, which already
   reaches paired computers through the gateway.
5. The card wraps that text and sets it as the `srcdoc` of a sandboxed iframe.

```html
<iframe sandbox="" srcdoc="<!doctype html>
  <meta http-equiv='Content-Security-Policy' content='POLICY'>
  <style>THEME TOKENS</style>
  AGENT HTML"></iframe>
```

`POLICY` is:

```text
default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
base-uri 'none'; form-action 'none'
```

The policy comes before the agent's markup, because a later policy can only tighten
an earlier one. Pages must inline their images and fonts.

The policy lasts only as long as the `srcdoc` document, and a link click can replace
that document with one that has no policy. Before wrapping the page, the card parses
it with `DOMParser`, removes `href` and `xlink:href` from every `<a>` and `<area>`,
and serializes the result. Following a link is what Open is for.

## Choices

**No MCP tool.** Five agent harnesses would each need a server registered, and
Switchboard's agent features avoid that today (`docs/SWITCHBOARD_CHATS.md`). A path
on its own line works in all of them.

**`srcdoc`, not a URL.** The artifact listener on 8091 is loopback-only, so a phone
on Tailscale cannot load it. `conversation-media.js` rejects loopback URLs for that
reason. The relay's own origin holds terminal access and must never run agent
scripts. Reading the page as text works on every viewer and adds no route.

**No scripts inline.** A static SVG needs none, and the sidebar is already sensitive
to main-thread load. Interactive pages keep the existing path: the card's Open button
uses the HTML preview ticket (`POST /api/hosts/{host}/html`), which runs scripts on
the separate 8091 origin. That route has the same loopback limit, so a phone sees
only the static card.

**The path match is a convenience, not a boundary.** Transcript text is untrusted and
can name any artifact. The sandbox and policy are what make rendering safe; the match
only stops arbitrary `.html` paths from turning into cards.

## Theme

The card injects a small documented token set, using the values from
`conversation.css`: `--background`, `--foreground`, `--card`, `--border`,
`--muted-foreground`, `--accent`, `--destructive`, `--warning`, `--font-sans` and
`--font-mono`. Names match T3 Code's where they overlap, so agent habits carry over.
Conversation mode is dark only, so the tokens are written once at render time and no
theme-change message is needed.

## Sizing and cost

A sandboxed frame without scripts cannot report its height, and the parent cannot
measure it. The card parses the page with `DOMParser`, which runs nothing, and sets
the height from the first of these that applies:

1. A root `<svg viewBox>`, scaled to the card's width.
2. `<meta name="switchboard-height" content="N">`, capped at 900.
3. A default of 480, with the frame scrolling inside.

Frames mount only near the viewport and unmount when far from it, with at most three
live. Pages over 2 MiB, matching the transcript's embedded preview budget, show the
path and Open instead.

## Scope

The first version covers Conversation mode only; a raw terminal keeps its
modified-click preview. Later, if wanted: click-to-run scripts with
`sandbox="allow-scripts"`, relative assets inlined at publish time, and a
`zellij switchboard` command that writes the page and prints the path.

## Tests to add

The browser behaviour below was checked once by hand, in a local fixture using
Playwright 1.65 Chromium and WebKit, with T3's real architecture diagram as the page.
Keep it as a Playwright test alongside the implementation:

- Injected tokens reach the SVG (`fill` and `stroke` resolve to the theme's colours).
- Inside the card, no request is made for `<img>`, stylesheet, `<script src>`,
  `fetch` or `<meta http-equiv=refresh>`; inline script does not run.
- A control frame with the same sandbox but no policy does load its image, proving
  the request counter works.
- Clicking a link with its target left in navigates the frame, and clicking the same
  link after the card removes its target makes no request.
