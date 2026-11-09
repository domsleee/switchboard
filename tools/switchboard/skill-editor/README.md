# Inline skill editor

The New tab prompt uses ProseMirror for text editing, selection, undo, clipboard,
and IME handling. Skills appear as inline chips with atomic selection/deletion;
the underlying document always retains the original text. The editor's `value` and
selection offsets retain their original `$plugin:skill` or `/plugin:skill` text.
The host-specific completion catalog decides which tokens become chips.

After editing `editor.js` or dependencies, run these commands in this directory:

```sh
npm ci
npm run build
```

Commit `package-lock.json` and the generated `../static/skill-editor.js`. The
bundle includes its dependencies' licenses. CI runs `npm run build -- --check`
to reject a stale bundle. Browser coverage is in `../skill-editor.test.cjs` and
the New tab fixtures; set `PLAYWRIGHT_MODULE` as for the other sidebar tests.
