// Counts and timings only. Terminal contents and keystrokes never enter a report.
window.SwitchboardRenderingDiagnostics = function () {
  const supported=typeof PerformanceObserver==='function'&&PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame');
  let frames=[];
  function remember(entries) {
    const cutoff=performance.now()-10000;
    frames=frames.filter(frame=>frame.end>=cutoff);
    for(const entry of entries){
      const end=entry.startTime+entry.duration;
      if(end>=cutoff)frames.push({start:entry.startTime,end,render:entry.renderStart,layout:entry.styleAndLayoutStart,
        scripts:(entry.scripts||[]).map(script=>({start:script.startTime,end:script.startTime+script.duration}))});
    }
    frames=frames.slice(-256);
  }
  const observer=supported?new PerformanceObserver(list=>remember(list.getEntries())):null;
  observer?.observe({entryTypes:['long-animation-frame']});
  return since=>{
    const result={long_frame_tracking:!!observer,long_frames:null,max_frame_ms:null,max_render_ms:null,max_layout_ms:null,max_script_ms:null};
    if(!observer)return result;
    remember(observer.takeRecords());
    const started=since-performance.timeOrigin,overlap=(start,end)=>Math.max(0,end-Math.max(start,started));
    result.long_frames=0;result.max_frame_ms=0;result.max_render_ms=0;result.max_layout_ms=0;result.max_script_ms=0;
    for(const frame of frames){
      if(frame.end<=started)continue;
      result.long_frames++;
      result.max_frame_ms=Math.max(result.max_frame_ms,Math.round(overlap(frame.start,frame.end)));
      if(frame.render>0)result.max_render_ms=Math.max(result.max_render_ms,Math.round(overlap(frame.render,frame.end)));
      if(frame.layout>0)result.max_layout_ms=Math.max(result.max_layout_ms,Math.round(overlap(frame.layout,frame.end)));
      result.max_script_ms=Math.max(result.max_script_ms,Math.round(frame.scripts.reduce((total,script)=>total+overlap(script.start,script.end),0)));
    }
    return result;
  };
};

window.SwitchboardTerminalDiagnostics = function (report, dimensions) {
  const now = () => performance.now();
  let span, quietTimer, deadlineTimer, hookedTerm, renderListener, scrollListener, lineFeedListener, resizeListener, animationProbe;
  let queued = 0, renderStarted = null, quiet = false;
  let recentTasks=[];
  function rememberTasks(entries) {
    const cutoff=now()-10000;
    recentTasks=recentTasks.filter(task=>task.end>=cutoff);
    for(const entry of entries)if(entry.startTime+entry.duration>=cutoff)
      recentTasks.push({end:entry.startTime+entry.duration,duration:entry.duration});
    recentTasks=recentTasks.slice(-256);
  }
  const taskObserver=typeof PerformanceObserver==='function'&&PerformanceObserver.supportedEntryTypes?.includes('longtask')?
    new PerformanceObserver(list=>rememberTasks(list.getEntries())):null;
  taskObserver?.observe({entryTypes:['longtask']});
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
    pending(since) {
      const result={writes_pending:queued,render_pending:renderStarted !== null};
      if(!Number.isFinite(since))return result;
      rememberTasks(taskObserver?.takeRecords()||[]);
      const tasks=recentTasks.filter(task=>performance.timeOrigin+task.end>since);
      return {...result,long_task_tracking:!!taskObserver,long_tasks:tasks.length,
        max_long_task_ms:Math.round(Math.max(0,...tasks.map(task=>task.duration))),
        total_long_task_ms:Math.round(tasks.reduce((total,task)=>total+task.duration,0))};
    },
    finish,
  };
};

window.SwitchboardBrowserDiagnostics = function (report, probe) {
  const now=()=>performance.now(),rounded=value=>Math.max(0,Math.round(value));
  const rendering=window.SwitchboardRenderingDiagnostics();
  let hiddenAt=document.hidden?now():null,span,sequence=0,deadline,animation,frozen=false;
  function tasks(entries) {
    if(!span)return;
    for(const entry of entries)if(entry.startTime+entry.duration>span.started){
      span.long_tasks++;span.total_long_task_ms+=rounded(entry.duration);
      span.max_long_task_ms=Math.max(span.max_long_task_ms,rounded(entry.duration));
    }
  }
  const observer=typeof PerformanceObserver==='function'&&PerformanceObserver.supportedEntryTypes?.includes('longtask')?
    new PerformanceObserver(list=>tasks(list.getEntries())):null;
  observer?.observe({entryTypes:['longtask']});
  function finish(outcome) {
    if(!span)return;
    clearTimeout(deadline);cancelAnimationFrame(animation);
    tasks(observer?.takeRecords()||[]);
    const result={...span,...rendering(performance.timeOrigin+span.started),outcome,elapsed_ms:rounded(now()-span.started)};
    delete result.started;span=null;
    report(result);
  }
  function start(reason,event) {
    finish('superseded');
    const started=now();
    span={id:++sequence,started,reason,hidden_ms:hiddenAt===null?null:rounded(started-hiddenAt),frozen,
      load_ms:reason==='discarded'?rounded(started):null,
      event_delay_ms:event?.timeStamp>0&&event.timeStamp<=started?rounded(started-event.timeStamp):null,
      first_animation_ms:null,terminal_animation_ms:null,terminal_probe:false,
      terminal_socket:null,control_socket:null,writes_pending:null,render_pending:null,
      terminal_message_ms:null,terminal_frame_ms:null,terminal_reply_ms:null,
      terminal_render_cycle_ms:null,
      initial_writes_pending:null,initial_render_pending:null,terminal_hidden:null,terminal_active:null,
      terminal_long_task_tracking:null,terminal_long_tasks:null,terminal_max_long_task_ms:null,terminal_total_long_task_ms:null,
      long_task_tracking:!!observer,long_tasks:0,max_long_task_ms:0,total_long_task_ms:0};
    hiddenAt=null;frozen=false;
    const tracked=span;
    span.terminal_probe=probe(span.id,performance.timeOrigin+started);
    animation=requestAnimationFrame(()=>{if(span===tracked)span.first_animation_ms=rounded(now()-started);});
    deadline=setTimeout(()=>finish('sampled'),5000);
  }
  document.addEventListener('visibilitychange',event=>{
    if(document.hidden){finish('hidden');hiddenAt=now();}
    else if(hiddenAt!==null)start('visible',event);
  });
  document.addEventListener('freeze',()=>{finish('hidden');frozen=true;});
  document.addEventListener('resume',event=>{if(!document.hidden&&!span)start('resumed',event);});
  window.addEventListener('pageshow',event=>{
    if(event.persisted){if(span)span.reason='restored';else start('restored',event);}
  });
  window.addEventListener('pagehide',()=>finish('hidden'));
  if(document.wasDiscarded&&!document.hidden)start('discarded');
  return {
    terminal(sample) {
      if(!span||sample?.id!==span.id||span.terminal_animation_ms!==null)return;
      const receivedOnly=sample.phase==='received';
      if(receivedOnly&&span.terminal_message_ms!==null)return;
      const received=performance.timeOrigin+now(),started=performance.timeOrigin+span.started;
      if(Number.isFinite(sample.received_at)&&sample.received_at>=started&&sample.received_at<=received){
        span.terminal_message_ms=rounded(sample.received_at-started);
        if(!receivedOnly&&Number.isFinite(sample.animation_at)&&sample.animation_at>=sample.received_at&&sample.animation_at<=received){
          span.terminal_frame_ms=rounded(sample.animation_at-sample.received_at);
          if(Number.isInteger(sample.render_cycle_ms)&&sample.render_cycle_ms>=0&&sample.render_cycle_ms<=4294967295)
            span.terminal_render_cycle_ms=sample.render_cycle_ms;
          span.terminal_reply_ms=rounded(received-sample.animation_at-(span.terminal_render_cycle_ms??0));
        }
      }
      for(const field of ['initial_writes_pending','long_tasks','max_long_task_ms','total_long_task_ms'])
        if(Number.isInteger(sample[field])&&sample[field]>=0)
          span[field==='initial_writes_pending'?field:`terminal_${field}`]=sample[field];
      for(const field of ['initial_render_pending','terminal_hidden','terminal_active','long_task_tracking'])
        if(typeof sample[field]==='boolean')span[field==='long_task_tracking'?'terminal_long_task_tracking':field]=sample[field];
      for(const field of ['terminal_socket','control_socket'])if(Number.isInteger(sample[field])&&sample[field]>=0&&sample[field]<=3)span[field]=sample[field];
      if(!receivedOnly){
        span.terminal_animation_ms=rounded(now()-span.started);
        if(Number.isInteger(sample.writes_pending)&&sample.writes_pending>=0)span.writes_pending=sample.writes_pending;
        if(typeof sample.render_pending==='boolean')span.render_pending=sample.render_pending;
      }
    },
  };
};
