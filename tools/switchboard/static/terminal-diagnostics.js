// Counts and timings only. Terminal contents and keystrokes never enter a report.
window.SwitchboardTerminalDiagnostics = function (report, dimensions) {
  const now = () => performance.now();
  let span, quietTimer, deadlineTimer, hookedTerm, renderListener, scrollListener, lineFeedListener, resizeListener, animationProbe;
  let queued = 0, renderStarted = null, quiet = false;
  function geometry() {
    const result = dimensions();
    if (span) span.max_clipped_bottom_rows = Math.max(span.max_clipped_bottom_rows,result.clipped_bottom_rows || 0);
    return result;
  }
  function size(term) {
    if (!span || !(term?.cols > 0 && term.rows > 0)) return;
    if (!span.first_xterm_cols) {
      span.first_xterm_cols = span.min_xterm_cols = term.cols;
      span.first_xterm_rows = span.min_xterm_rows = term.rows;
    } else if (span.last_xterm_cols !== term.cols || span.last_xterm_rows !== term.rows) span.xterm_size_changes++;
    span.last_xterm_cols = term.cols;span.last_xterm_rows = term.rows;
    span.min_xterm_cols = Math.min(span.min_xterm_cols,term.cols);span.min_xterm_rows = Math.min(span.min_xterm_rows,term.rows);
    span.max_xterm_cols = Math.max(span.max_xterm_cols,term.cols);span.max_xterm_rows = Math.max(span.max_xterm_rows,term.rows);
  }
  function finish(outcome) {
    if (!span) return;
    clearTimeout(quietTimer);clearTimeout(deadlineTimer);
    const measured = geometry();
    const result = {...span, ...measured, outcome, elapsed_ms:Math.round(now()-span.started), writes_pending:queued,
      render_pending:renderStarted !== null, animation_pending:!!animationProbe};
    delete result.started;delete result.last_native_cols;delete result.last_native_rows;
    delete result.last_xterm_cols;delete result.last_xterm_rows;
    result.slow = result.ack_ms > 500 || result.first_parse_ms > 500 || result.max_parse_lag_ms > 500 ||
      (result.ack_ms === null && result.elapsed_ms > 500) || (queued > 0 && result.elapsed_ms > 500) ||
      (result.expected_render && result.first_parse_ms === null && result.elapsed_ms > 500) ||
      result.first_render_ms > 500 || result.first_animation_ms > 500 || result.max_render_lag_ms > 500 || result.max_animation_lag_ms > 500 ||
      (result.render_tracking && result.expected_render && result.first_render_ms === null && result.elapsed_ms > 500);
    result.oversized_viewport = result.client_height_px > 0 && result.scroll_height_px > result.client_height_px * 8;
    span = null;animationProbe = null;
    report(result);
  }
  function settle() {
    clearTimeout(quietTimer);
    quiet = false;
    if (span && span.ack_ms !== null && !queued && renderStarted === null && !animationProbe &&
      (!span.expected_render || span.first_parse_ms !== null)) quietTimer = setTimeout(() => {
        if (!span) return;
        quiet = true;span.first_quiet_ms ??= Math.round(now()-span.started);
      }, 150);
  }
  return {
    start(request, term, expectedRender=true) {
      finish('superseded');
      this.hook(term);
      span = {started:now(), focus_id:request.focus_id ?? 0, pane_id:request.pane_id, is_plugin:!!request.is_plugin,expected_render:expectedRender,
        ack_ms:null, first_frame_ms:null, first_parse_ms:null, last_frame_ms:null, last_parse_ms:null,
        frames:0, bytes:0, max_parse_lag_ms:0, viewport_claims:0, terminal_resizes:0,
        control_tracking:true,focus_commands:0,terminal_metrics:0,cell_size_changes:0,
        first_cell_width_px:0,first_cell_height_px:0,last_cell_width_px:0,last_cell_height_px:0,
        min_cell_width_px:0,min_cell_height_px:0,max_cell_width_px:0,max_cell_height_px:0,
        render_tracking:typeof term?.onRender === 'function', first_render_ms:null,last_render_ms:null,render_events:0,max_render_lag_ms:0,
        first_animation_ms:null,last_animation_ms:null,max_animation_lag_ms:0,first_quiet_ms:null,late_frames:0,
        buffer_scroll_events:0,line_feed_events:0,wheel_events:0,
        max_clipped_bottom_rows:0,
        xterm_size_changes:0,first_xterm_cols:0,first_xterm_rows:0,min_xterm_cols:0,min_xterm_rows:0,max_xterm_cols:0,max_xterm_rows:0,
        hidden_at_start:!!dimensions().document_hidden,viewport_size_changes:0,
        first_native_cols:0,first_native_rows:0,min_native_cols:0,min_native_rows:0,max_native_cols:0,max_native_rows:0};
      size(term);
      geometry();
      quiet = false;
      deadlineTimer = setTimeout(() => finish('timeout'), 16000);
    },
    hook(term) {
      if (!term?.write || term === hookedTerm) return;
      renderListener?.dispose();
      scrollListener?.dispose();lineFeedListener?.dispose();resizeListener?.dispose();
      hookedTerm = term;queued = 0;renderStarted = null;animationProbe = null;
      size(term);
      // With scrollback=0, wrapping the bottom row still emits onScroll(0).
      // A normal-height DOM viewport therefore cannot rule out screen movement.
      scrollListener = term.onScroll?.(() => {if (term === hookedTerm && span) span.buffer_scroll_events++;});
      lineFeedListener = term.onLineFeed?.(() => {if (term === hookedTerm && span) span.line_feed_events++;});
      resizeListener = term.onResize?.(() => {if (term === hookedTerm) size(term);});
      renderListener = term.onRender?.(() => {
        if (term !== hookedTerm) return;
        const started = renderStarted;renderStarted = null;
        if (!span) return;
        geometry();
        const elapsed = Math.round(now()-span.started);
        span.render_events++;span.last_render_ms = elapsed;
        if (span.first_parse_ms !== null || started !== null) span.first_render_ms ??= elapsed;
        if (started !== null) span.max_render_lag_ms = Math.max(span.max_render_lag_ms,Math.round(now()-started));
        settle();
        if (typeof requestAnimationFrame !== 'function' || animationProbe) return;
        const tracked = span, probe = {}, requested = now();animationProbe = probe;
        clearTimeout(quietTimer);quiet = false;
        requestAnimationFrame(() => {
          if (animationProbe !== probe) return;
          animationProbe = null;
          if (span !== tracked) return;
          geometry();
          const elapsed = Math.round(now()-tracked.started);
          tracked.first_animation_ms ??= elapsed;tracked.last_animation_ms = elapsed;
          tracked.max_animation_lag_ms = Math.max(tracked.max_animation_lag_ms,Math.round(now()-requested));
          settle();
        });
      });
      const write = term.write;
      term.write = function (data, callback) {
        const started = now();queued++;clearTimeout(quietTimer);quiet = false;
        let completed = false;
        const done = () => {
          if (completed) return;completed = true;
          if (term === hookedTerm) {
            queued--;
            if (typeof term.onRender === 'function') renderStarted ??= now();
            if (span) {
              size(term);
              const parsed = Math.round(now()-span.started);
              span.first_parse_ms ??= parsed;
              span.last_parse_ms = parsed;
              span.max_parse_lag_ms = Math.max(span.max_parse_lag_ms, Math.round(now()-started));
              settle();
            }
          }
          if (typeof callback === 'function') callback();
        };
        try { return write.call(this, data, done); }
        catch (error) { if (!completed && term === hookedTerm) queued--;throw error; }
      };
    },
    frame(data) {
      if (!span) return;
      size(hookedTerm);
      const elapsed = Math.round(now()-span.started);
      span.frames++;span.first_frame_ms ??= elapsed;span.last_frame_ms = elapsed;
      if (span.first_quiet_ms !== null) span.late_frames++;
      span.bytes += typeof data === 'string' ? new TextEncoder().encode(data).length : data?.byteLength ?? data?.size ?? 0;
      clearTimeout(quietTimer);quiet = false;
    },
    wheel() {if (span) span.wheel_events++;},
    state(state) {
      if (!span || state?.active_pane?.pane_id !== span.pane_id || !!state.active_pane.is_plugin !== span.is_plugin) return;
      const cols = state.tab_viewport?.cols, rows = state.tab_viewport?.rows;
      if (!(cols > 0 && rows > 0)) return;
      if (!span.first_native_cols) {
        span.first_native_cols = span.min_native_cols = cols;
        span.first_native_rows = span.min_native_rows = rows;
      } else if (span.last_native_cols !== cols || span.last_native_rows !== rows) span.viewport_size_changes++;
      span.last_native_cols = cols;span.last_native_rows = rows;
      span.min_native_cols = Math.min(span.min_native_cols,cols);span.min_native_rows = Math.min(span.min_native_rows,rows);
      span.max_native_cols = Math.max(span.max_native_cols,cols);span.max_native_rows = Math.max(span.max_native_rows,rows);
    },
    sent(data) {
      if (!span || typeof data !== 'string') return;
      try {
        const envelope = JSON.parse(data);
        const message = envelope.payload || envelope;
        if (message.type === 'SetTabViewport') span.viewport_claims++;
        if (message.type === 'TerminalResize') span.terminal_resizes++;
        if (message.type === 'FocusPane') span.focus_commands++;
        if (message.type === 'TerminalMetrics') {
          span.terminal_metrics++;
          const width = message.cell_pixel_width, height = message.cell_pixel_height;
          if (![width,height].every(value => Number.isInteger(value) && value > 0 && value <= 65535)) return;
          if (!span.first_cell_width_px) {
            span.first_cell_width_px = span.min_cell_width_px = width;
            span.first_cell_height_px = span.min_cell_height_px = height;
          } else if (span.last_cell_width_px !== width || span.last_cell_height_px !== height) span.cell_size_changes++;
          span.last_cell_width_px = width;span.last_cell_height_px = height;
          span.min_cell_width_px = Math.min(span.min_cell_width_px,width);span.min_cell_height_px = Math.min(span.min_cell_height_px,height);
          span.max_cell_width_px = Math.max(span.max_cell_width_px,width);span.max_cell_height_px = Math.max(span.max_cell_height_px,height);
        }
      } catch (_) {}
    },
    ack() {
      if (!span || span.ack_ms !== null) return;
      span.ack_ms = Math.round(now()-span.started);
      clearTimeout(deadlineTimer);
      // A short quiet gap can precede more ConPTY replay. Keep observing the tail.
      deadlineTimer = setTimeout(() => finish(queued || renderStarted !== null || animationProbe ||
        span?.expected_render && (span.first_parse_ms === null || span.render_tracking && span.first_render_ms === null)?
        'timeout':quiet?'settled':'sampled'), 10000);
      settle();
    },
    finish,
  };
};
