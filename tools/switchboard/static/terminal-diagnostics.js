// Counts and timings only. Terminal contents and keystrokes never enter a report.
window.SwitchboardTerminalDiagnostics = function (report, dimensions) {
  const now = () => performance.now();
  let span, quietTimer, deadlineTimer, hookedTerm, queued = 0;
  function finish(outcome) {
    if (!span) return;
    clearTimeout(quietTimer);clearTimeout(deadlineTimer);
    const result = {...span, ...dimensions(), outcome, elapsed_ms:Math.round(now()-span.started), writes_pending:queued};
    delete result.started;
    result.slow = result.ack_ms > 500 || result.first_parse_ms > 500 || result.max_parse_lag_ms > 500 ||
      (result.ack_ms === null && result.elapsed_ms > 500) || (queued > 0 && result.elapsed_ms > 500) ||
      (result.expected_render && result.first_parse_ms === null && result.elapsed_ms > 500);
    span = null;
    report(result);
  }
  function settle() {
    clearTimeout(quietTimer);
    if (span && span.ack_ms !== null && !queued && (!span.expected_render || span.first_parse_ms !== null)) quietTimer = setTimeout(() => finish('settled'), 150);
  }
  return {
    start(request, term, expectedRender=true) {
      finish('superseded');
      this.hook(term);
      span = {started:now(), focus_id:request.focus_id ?? 0, pane_id:request.pane_id, is_plugin:!!request.is_plugin,expected_render:expectedRender,
        ack_ms:null, first_frame_ms:null, first_parse_ms:null, last_frame_ms:null, last_parse_ms:null,
        frames:0, bytes:0, max_parse_lag_ms:0, viewport_claims:0, terminal_resizes:0};
      deadlineTimer = setTimeout(() => finish('timeout'), 16000);
    },
    hook(term) {
      if (!term?.write || term === hookedTerm) return;
      hookedTerm = term;queued = 0;
      const write = term.write;
      term.write = function (data, callback) {
        const started = now();queued++;
        let completed = false;
        const done = () => {
          if (completed) return;completed = true;
          if (term === hookedTerm) {
            queued--;
            if (span) {
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
      const elapsed = Math.round(now()-span.started);
      span.frames++;span.first_frame_ms ??= elapsed;span.last_frame_ms = elapsed;
      span.bytes += typeof data === 'string' ? new TextEncoder().encode(data).length : data?.byteLength ?? data?.size ?? 0;
      clearTimeout(quietTimer);
    },
    sent(data) {
      if (!span || typeof data !== 'string') return;
      try {
        const message = JSON.parse(data);
        if (message.type === 'SetTabViewport') span.viewport_claims++;
        if (message.type === 'TerminalResize') span.terminal_resizes++;
      } catch (_) {}
    },
    ack() {
      if (!span || span.ack_ms !== null) return;
      span.ack_ms = Math.round(now()-span.started);
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(() => finish(queued || span?.expected_render && span.first_parse_ms === null?'timeout':'settled'), 2000);
      settle();
    },
    finish,
  };
};
