// Instant typing (Settings → Appearance, off by default). Typed characters are drawn at the cursor
// before the computer echoes them, then kept only while the real screen agrees, as mosh does.
// Only plain typing and Backspace into blank space are guessed; any other key pauses guessing until
// the screen has had time to settle. Guesses sit on an overlay and never enter xterm's buffer, so a
// wrong guess is undone by removing it.
(root => {
  const FLAG = 'switchboard-predictive-echo';
  // Mosh's thresholds: below 20ms of echo time guessing is pointless, above 30ms it is worth showing.
  const SHOW_ABOVE_MS = 30, HIDE_BELOW_MS = 20;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const typeable = ch => { const c = ch.codePointAt(0); return (c >= 0x20 && c < 0x7f) || (c >= 0xa1 && c <= 0x24f && c !== 0xad); };
  const blank = ch => ch === '' || ch === ' ' || ch === '\u00a0';
  // Characters on screen before guessing began are only erased when they are plain ASCII text. Prompts
  // end in a space or no-break space (❯\u00a0, "$ "), so Backspace at the start of the input is not guessed.
  const erasable = ch => { const c = ch.codePointAt(0); return c > 0x20 && c < 0x7f; };
  // A space between words is erased too; prompts end in a symbol before their space ("$ ", "> ").
  const wordChar = ch => /^[A-Za-z0-9]$/.test(ch);
  // Zellij pane frames and side-by-side panes put a vertical border at the right of the pane's row.
  const border = ch => ch !== '' && '│┃║╎╏┆┇┊┋'.includes(ch);
  const hasParam = (params, values) => params.some(p => values.includes(Array.isArray(p) ? p[0] : p));

  // Focus reports and button-less mouse motion change nothing on screen, so they don't pause guessing.
  function neutral(data) {
    if (data === '\x1b[I' || data === '\x1b[O') return true;
    const mouse = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
    return !!mouse && (mouse[1] & 32) !== 0 && (mouse[1] & 3) === 3;
  }

  function create({ term, now, setTimer, clearTimer, enabled, draw, report = () => {} }) {
    let run = null, pausedUntil = 0, srtt = null, showing = true, timer = null;
    // A key that is not guessed may move or redraw the input, so guessing waits for a frame after it.
    let lastKeyAt = -Infinity, lastWriteAt = -Infinity;
    const counts = { guessed: 0, confirmed: 0, dropped: 0 };
    // Zellij hides the cursor while it redraws, so a hidden cursor means a frame is still arriving.
    let hidden = !!term._core?.coreService?.isCursorHidden;
    const settle = () => srtt === null ? 250 : clamp(1.5 * srtt + 30, 60, 600);
    const timeout = () => srtt === null ? 1000 : clamp(3 * srtt + 200, 300, 2500);
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
      if (hasParam(params, [25])) hidden = true;
      if (hasParam(params, [47, 1047, 1049])) drop('screen');
      return false;
    });
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => {
      if (hasParam(params, [25])) hidden = false;
      if (hasParam(params, [47, 1047, 1049])) drop('screen');
      return false;
    });
    term.onWriteParsed(reconcile);
    term.onResize(() => drop(false));

    // The predicted row after the first n guesses: cell contents, which cells guesses wrote, and the cursor.
    function predicted(n = run.ops.length) {
      const line = run.base.slice(), written = new Map();
      let cursor = run.anchor;
      for (const op of run.ops.slice(0, n)) { line[op.pos] = op.ch; written.set(op.pos, op); cursor = op.x; }
      return { line, written, cursor };
    }
    function start() {
      const buffer = term.buffer.active;
      if (hidden || buffer.viewportY !== buffer.baseY || lastWriteAt <= lastKeyAt) return false;
      const row = buffer.baseY + buffer.cursorY, x = buffer.cursorX, line = buffer.getLine(row);
      if (!line || x >= term.cols) return false;
      const base = [], dim = [];
      for (let i = 0; i < term.cols; i++) { const cell = line.getCell(i); base.push(cell?.getChars() || ''); dim.push(!!cell?.isDim()); }
      // Guess only at the end of what is typed: the rest of the pane's row is blank or dim placeholder
      // text, which the program clears once typing starts.
      let clearEnd = x, edge = term.cols;
      for (let i = x; i < term.cols; i++) {
        if (blank(base[i])) continue;
        if (border(base[i])) { edge = i; break; }
        if (!dim[i]) return false;
        clearEnd = i + 1;
      }
      const t = now();
      run = { row, anchor: x, base, dim, ops: [], open: true, closeBy: Infinity, clearEnd, edge,
        sinceKey: t - lastKeyAt, sinceWrite: t - lastWriteAt, frames: 0, confirmed: 0 };
      return true;
    }
    function ready(t) { return enabled() && t >= pausedUntil && ((run && run.open) || (!run && start())); }
    function type(ch, t) {
      if (!ready(t)) return false;
      const { cursor } = predicted();
      // The last two columns are where programs differ on wrapping.
      if (cursor >= run.edge - 2) return false;
      run.ops.push({ at: t, pos: cursor, ch, x: cursor + 1, typed: true });
      counts.guessed++;
      return true;
    }
    function erase(t) {
      if (!ready(t)) return false;
      const { line, written, cursor } = predicted(), pos = cursor - 1;
      if (pos < 0) return false;
      const writer = written.get(pos);
      const word = erasable(line[pos]) || (line[pos] === ' ' && pos > 0 && wordChar(line[pos - 1]));
      if (writer ? !writer.typed : (run.dim[pos] || !word)) return false;
      run.ops.push({ at: t, pos, ch: ' ', x: pos, typed: false });
      counts.guessed++;
      return true;
    }
    function pause(t) {
      lastKeyAt = t;
      pausedUntil = Math.max(pausedUntil, t + settle());
      if (run) { run.open = false; run.closeBy = Math.min(run.closeBy, t + settle()); }
    }
    function sent(data) {
      if (!enabled()) { if (run) drop(false); return; }
      const t = now();
      if (typeof data !== 'string') pause(t);
      else if (!neutral(data)) {
        for (const ch of data) {
          const guessed = typeable(ch) ? type(ch, t) : (ch === '\x7f' || ch === '\b') ? erase(t) : false;
          if (!guessed) { pause(t); break; }
        }
      }
      if (run && !run.ops.length) run = null;
      schedule(); render();
    }
    // The screen shows the state after the first n guesses when the cursor sits where they leave it and
    // every cell any guess touches shows that state. A blank guess also accepts the dim placeholder coming
    // back, and a cell no guess has written yet accepts its placeholder vanishing.
    function confirms(n) {
      const buffer = term.buffer.active, { line: expected, written, cursor } = predicted(n);
      if (buffer.baseY + buffer.cursorY !== run.row || buffer.cursorX !== cursor) return false;
      const line = buffer.getLine(run.row);
      for (const pos of new Set(run.ops.map(op => op.pos))) {
        const cell = line?.getCell(pos), shown = cell?.getChars() || '', want = expected[pos];
        const ok = written.has(pos) ? (want === ' ' ? blank(shown) || cell?.isDim() : shown === want)
          : shown === want || (blank(shown) && blank(want)) || run.dim[pos];
        if (!ok) return false;
      }
      return true;
    }
    // Echoes arrive in order, so a frame is taken as the earliest state it could be. A frame drawn before
    // any echo can look like a later state (Backspace then retyping the same letter); taking it for that
    // state would remove the guesses and show the screen replaying the edit.
    function settled() {
      for (let n = 0; n <= run.ops.length; n++) if (confirms(n)) return n;
      return -1;
    }
    function accept(n) {
      const done = run.ops.splice(0, n), last = done[done.length - 1];
      counts.confirmed += n; run.confirmed += n;
      for (const op of done) { run.base[op.pos] = op.ch; run.dim[op.pos] = false; }
      run.anchor = last.x;
      const sample = now() - last.at;
      srtt = srtt === null ? sample : srtt * 7 / 8 + sample / 8;
      if (srtt > SHOW_ABOVE_MS) showing = true; else if (srtt < HIDE_BELOW_MS) showing = false;
      if (!run.ops.length) run = null;
    }
    function reconcile() {
      lastWriteAt = now();
      if (!run || hidden) return;
      run.frames++;
      const buffer = term.buffer.active;
      // The input moved to another row (a submitted message, output above it): these guesses are stale.
      if (buffer.baseY + buffer.cursorY !== run.row) { drop('moved'); return; }
      const n = settled();
      if (n > 0) accept(n);
      schedule(); render();
    }
    // At the deadline a screen that already shows every guess confirms them, as coalesced echoes can.
    function expire() {
      timer = null;
      if (run && !hidden && confirms(run.ops.length)) { accept(run.ops.length); schedule(); render(); }
      else drop('timeout');
    }
    function schedule() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (!run) return;
      const deadline = Math.min(run.closeBy, run.ops[0].at + timeout());
      timer = setTimer(expire, Math.max(0, deadline - now()));
    }
    // reason is set when the guesses were wrong: 'timeout', 'moved' or 'screen' (switched screens).
    function drop(reason) {
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (run && reason) {
        const t = now(), buffer = term.buffer.active;
        pausedUntil = Math.max(pausedUntil, t + settle()); counts.dropped += run.ops.length;
        // Counts and positions only; never what was typed.
        report({ outcome: reason, pending: run.ops.length, typed: run.ops.filter(op => op.typed).length,
          confirmed: Math.min(run.confirmed, 65535), frames: Math.min(run.frames, 65535), age_ms: Math.round(t - run.ops[0].at),
          srtt_ms: finite(srtt), since_input_ms: idle(run.sinceKey), since_write_ms: idle(run.sinceWrite),
          run_row: Math.max(0, run.row - buffer.viewportY), cursor_row: buffer.cursorY, cursor_col: buffer.cursorX,
          expected_col: predicted().cursor, cursor_hidden: hidden });
      }
      run = null;
      render();
    }
    function model() {
      if (!run || !showing) return null;
      const row = run.row - term.buffer.active.viewportY;
      if (row < 0 || row >= term.rows) return null;
      const { line, written, cursor } = predicted();
      let lo = Math.min(run.anchor, cursor), end = Math.max(run.anchor + 1, cursor + 1, run.clearEnd);
      for (const pos of written.keys()) { lo = Math.min(lo, pos); end = Math.max(end, pos + 1); }
      end = Math.min(end, term.cols);
      const cells = [];
      for (let x = lo; x < end; x++) cells.push({ x, ch: written.has(x) ? line[x] : ' ' });
      return { row, cells, cursor };
    }
    function render() { draw(model()); }
    const finite = ms => ms !== null && Number.isFinite(ms) ? Math.round(ms) : null;
    // A tab left open for days still reports its misses; the relay bounds durations at a day.
    const idle = ms => finite(ms) === null ? null : Math.min(finite(ms), 86_400_000);
    return { sent, reconcile, drop: () => drop(null), model, state: () => ({ srtt, showing, pausedUntil, run, ...counts }) };
  }

  const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed',
    'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  const ANSI_DEFAULT = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];
  function paletteColor(theme, index) {
    if (index < 16) return theme[ANSI[index]] || ANSI_DEFAULT[index];
    const hex = v => v.toString(16).padStart(2, '0');
    if (index >= 232) { const v = 8 + (index - 232) * 10; return '#' + hex(v) + hex(v) + hex(v); }
    const levels = [0, 95, 135, 175, 215, 255], i = index - 16;
    return '#' + hex(levels[Math.floor(i / 36)]) + hex(levels[Math.floor(i / 6) % 6]) + hex(levels[i % 6]);
  }
  function cellBackground(cell, theme) {
    const fallback = theme.background || '#000000';
    if (!cell || cell.isBgDefault() || cell.isInverse()) return fallback;
    const value = cell.getBgColor();
    if (cell.isBgRGB()) return '#' + value.toString(16).padStart(6, '0');
    return cell.isBgPalette() ? paletteColor(theme, value) : fallback;
  }

  function domRenderer(term) {
    let layer = null;
    return model => {
      if (!model) { layer?.replaceChildren(); return; }
      const screen = term.element?.querySelector('.xterm-screen');
      if (!screen) return;
      if (!layer || layer.parentNode !== screen) {
        layer = document.createElement('div');
        layer.className = 'switchboard-prediction';
        layer.setAttribute('aria-hidden', 'true');
        Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '10', overflow: 'hidden' });
        screen.append(layer);
      }
      const cell = term._core?._renderService?.dimensions?.css?.cell;
      const width = cell?.width || screen.clientWidth / term.cols, height = cell?.height || screen.clientHeight / term.rows;
      const theme = term.options.theme || {}, foreground = theme.foreground || '#ffffff', cursorColor = theme.cursor || foreground;
      const line = term.buffer.active.getLine(term.buffer.active.viewportY + model.row);
      const spans = model.cells.map(({ x, ch }) => {
        const span = document.createElement('span'), background = cellBackground(line?.getCell(x), theme);
        span.textContent = ch;
        Object.assign(span.style, {
          position: 'absolute', left: x * width + 'px', top: model.row * height + 'px', width: width + 'px', height: height + 'px',
          lineHeight: height + 'px', textAlign: 'center', whiteSpace: 'pre', fontFamily: term.options.fontFamily,
          fontSize: term.options.fontSize + 'px', color: foreground, background,
          textDecoration: ch === ' ' ? 'none' : 'underline dotted', textDecorationColor: 'rgba(160,160,160,.7)',
        });
        if (x === model.cursor) {
          const style = term.options.cursorStyle || 'block';
          if (style === 'bar') span.style.boxShadow = `inset ${term.options.cursorWidth || 1}px 0 ${cursorColor}`;
          else if (style === 'underline') span.style.boxShadow = `inset 0 -2px ${cursorColor}`;
          else { span.style.background = cursorColor; span.style.color = background; }
        }
        return span;
      });
      layer.replaceChildren(...spans);
    };
  }

  // One per terminal frame: the bridge reports what the terminal socket sends.
  function install({ report } = {}) {
    const read = () => { try { return localStorage.getItem(FLAG) === 'true'; } catch { return false; } };
    let on = read(), attached = null, core = null, reportedAt = -Infinity;
    // One miss a second at most, so a confused screen cannot flood the relay's log.
    const throttled = miss => { const t = performance.now(); if (report && t - reportedAt >= 1000) { reportedAt = t; report(miss); } };
    addEventListener('storage', event => { if (event.key === FLAG) { on = read(); if (!on) core?.drop(); } });
    return {
      attach(term) {
        if (!term || term === attached || !term.parser || !term.onWriteParsed) return;
        attached = term;
        core = create({ term, now: () => performance.now(), setTimer: setTimeout, clearTimer: clearTimeout, enabled: () => on, draw: domRenderer(term), report: throttled });
      },
      sent: data => core?.sent(data),
      reset: () => core?.drop(),
      // Counts only, for latency.test.cjs --predict; never what was typed.
      stats: () => { const { srtt, showing, guessed, confirmed, dropped } = core?.state() || {}; return { srtt, showing, guessed, confirmed, dropped }; },
    };
  }

  root.SwitchboardPredictiveEcho = { FLAG, create, install, domRenderer, neutral };
  if (typeof module !== 'undefined') module.exports = root.SwitchboardPredictiveEcho;
})(globalThis);
