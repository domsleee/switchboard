// Reuse the stock web client and expose only metadata and explicit focus commands.
(() => {
  const NativeSocket = window.WebSocket;
  const host = location.pathname.split('/')[2];
  let latest;
  let escapeQueue = Promise.resolve();
  let escapeStatus;
  let pendingFocus, desiredFocus, focusInputState, focusId, focusTimeout;
  let pendingNewTab;
  let terminalSocket;
  let scrollport, lastViewport, viewportTab, bottomButton, claimedViewportTab;
  let chromeKey, nativeTopBar=false, nativeBottomRows=0;
  function viewportSupported(){return !!window.__zjSupportsTabViewport && !!latest?.tab_viewport;}
  function physicalViewport(){
    if(!viewportSupported())return;
    const cell=window.term?._core?._renderService?.dimensions?.css?.cell;
    if(!cell?.width||!cell.height)return;
    const mobile=document.body.classList.contains('zj-mobile-active');
    const height=(window.visualViewport?.height||window.innerHeight);
    const width=(window.visualViewport?.width||window.innerWidth);
    const top=!mobile&&!showNativeTabs&&nativeTopBar?cell.height:0;
    const nativeRows=mobile?0:nativeBottomRows;
    const chrome=mobile?parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zj-chrome-top'))||0:0;
    const footer=mobile?parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zj-chrome-bottom'))||0:0;
    return {cols:Math.max(2,Math.floor(width/cell.width)),rows:Math.max(1,Math.floor((height-chrome-footer+top)/cell.height)+nativeRows)};
  }
  window.__zjViewport={
    dimensions:physicalViewport,
    getSizing(){
      if(!viewportSupported())return;
      const viewport=latest.tab_viewport;
      return viewport.owner_active?{pinned:true,cols:viewport.cols,rows:viewport.rows}:{pinned:false};
    },
    report(size,ownership){
      const tab=latest?.active_pane?.tab_position;
      if(!viewportSupported()||!Number.isInteger(tab)||!window.__zjSendControl)return false;
      const signature=JSON.stringify([tab,size.cols,size.rows]);
      if(ownership===undefined && lastViewport===signature)return false;
      lastViewport=signature;
      window.__zjSendControl({type:'SetTabViewport',size,tab_position:tab,ownership:ownership??null});
      return true;
    },
  };
  function claimFocusedViewport(force=false){
    const tab=latest?.active_pane?.tab_position;
    // Background sessions still publish state. Only the selected frame in the
    // focused browser window may claim, once per focus or tab change.
    if(pendingFocus||pendingNewTab||!Number.isInteger(tab)||!parent.document.hasFocus()||
      parent.document.visibilityState==='hidden'||(window.frameElement&&!window.frameElement.classList.contains('active'))||
      (!force&&claimedViewportTab===tab))return;
    const size=physicalViewport();
    if(size&&window.__zjViewport.report(size,true))claimedViewportTab=tab;
  }
  window.addEventListener('focus',()=>claimFocusedViewport(true));
  function moveTerminal(terminal,target,before=null){
    const active=document.activeElement,focused=terminal.contains(active)&&document.hasFocus();
    // Moving a focused textarea with append/before blurs it. Prefer a state
    // preserving DOM move, with a focus-preserving fallback for older browsers.
    if(typeof target.moveBefore==='function')target.moveBefore(terminal,before);
    else{
      target.insertBefore(terminal,before);
      if(focused&&document.activeElement!==active)active.focus({preventScroll:true});
    }
  }
  function updateViewport(){
    if(!scrollport && !window.__zjViewport.getSizing()?.pinned)return;
    const terminal=document.getElementById('terminal');
    if(!terminal)return;
    const sizing=window.__zjViewport.getSizing();
    if(!sizing?.pinned){
      if(scrollport){
        moveTerminal(terminal,scrollport.parentNode,scrollport);scrollport.remove();scrollport=null;
        for(const key of ['width','height','marginTop'])terminal.style[key]='';
        bottomButton?.remove();bottomButton=null;viewportTab=null;
        document.body.classList.remove('switchboard-owned-viewport');
      }
      return;
    }
    const cell=window.term?._core?._renderService?.dimensions?.css?.cell;
    if(!cell?.width||!cell.height)return;
    if(!scrollport){
      scrollport=document.createElement('div');scrollport.id='switchboard-viewport';
      terminal.before(scrollport);moveTerminal(terminal,scrollport);
      bottomButton=document.createElement('button');bottomButton.id='switchboard-bottom';bottomButton.textContent='Back to bottom';
      bottomButton.onclick=()=>{scrollport.scrollTop=scrollport.scrollHeight;window.term?.focus();};
      document.body.append(bottomButton);
      scrollport.addEventListener('scroll',()=>{bottomButton.hidden=scrollport.scrollHeight-scrollport.clientHeight-scrollport.scrollTop<cell.height;});
      // Follower scrolling pans the viewport instead of sending wheel input into the TUI.
      scrollport.addEventListener('wheel',event=>{
        if(scrollport.scrollHeight>scrollport.clientHeight||scrollport.scrollWidth>scrollport.clientWidth){
          event.stopPropagation();event.preventDefault();scrollport.scrollTop+=event.deltaY;scrollport.scrollLeft+=event.deltaX;
        }
      },{capture:true,passive:false});
      document.body.classList.add('switchboard-owned-viewport');
    }
    const tab=latest.active_pane?.tab_position;
    const atBottom=viewportTab!==tab||scrollport.scrollHeight-scrollport.clientHeight-scrollport.scrollTop<cell.height;
    const top=parseFloat(document.documentElement.style.getPropertyValue('--switchboard-tab-height'))||0;
    const bottomRows=window.__switchboardBottomRows?.(window.term,latest)||0;
    terminal.style.width=`${Math.max(sizing.cols*cell.width,scrollport.clientWidth)}px`;
    terminal.style.height=`${Math.max(1,(sizing.rows-bottomRows)*cell.height)}px`;
    terminal.style.marginTop=`${-top}px`;
    if(atBottom)scrollport.scrollTop=scrollport.scrollHeight;
    if(viewportTab!==tab)scrollport.scrollLeft=0;
    viewportTab=tab;
    bottomButton.hidden=scrollport.scrollHeight-scrollport.clientHeight-scrollport.scrollTop<cell.height;
  }
  function releaseNewTab() {
    if(!pendingNewTab)return;
    clearTimeout(pendingNewTab.timeout);
    if(window.term)window.term.options.disableStdin=pendingNewTab.disabled;
    pendingNewTab=null;
  }
  function dispatchFocus() {
    clearTimeout(focusTimeout);
    pendingFocus=desiredFocus;
    // Control sends can be dropped during reconnect, and a no-op focus may
    // produce no MobileState. Never leave input disabled waiting forever.
    focusTimeout=setTimeout(()=>failFocus('Terminal switch timed out. Try selecting the tab again.'),5000);
    try {
      window.__zjSendControl({type:'FocusPane',pane_id:pendingFocus.pane_id,is_plugin:pendingFocus.is_plugin});
    } catch (_) {
      failFocus('Terminal switch failed. Check the connection and try again.');
    }
  }
  function releaseFocus() {
    if(focusTimeout)clearTimeout(focusTimeout);
    focusTimeout=null;
    if(focusInputState && window.term){
      window.term.options.disableStdin=focusInputState.disabled;
      window.term.element.style.pointerEvents=focusInputState.pointer;
    }
    if(pendingFocus && escapeStatus)showEscapeStatus('');
    pendingFocus=null;desiredFocus=null;focusInputState=null;
  }
  function failFocus(message) {
    releaseFocus();
    parent.postMessage({type:'zellij-focus-failed',host,focus_id:focusId,payload:latest,message},location.origin);
    showEscapeStatus(message,true);
    window.term?.focus();
  }
  function rejectFocus() {
    if(desiredFocus.pane_id!==pendingFocus.pane_id || desiredFocus.is_plugin!==pendingFocus.is_plugin){
      if(latest?.active_pane?.pane_id===desiredFocus.pane_id && latest.active_pane.is_plugin===desiredFocus.is_plugin){
        releaseFocus();window.term?.focus();
        parent.postMessage({type:'zellij-state',host,payload:latest,focus_id:focusId,focus_pending:false},location.origin);
        return;
      }
      pendingFocus=null;dispatchFocus();
      return;
    }
    failFocus('That terminal is unavailable. Choose another tab.');
  }
  function hasDialog() {
    if (document.querySelector('dialog[open], .security-modal, [aria-modal="true"]')) return true;
    try { return !!parent.document?.querySelector('dialog[open], .security-modal, [aria-modal="true"]'); }
    catch (_) { return false; }
  }
  function terminalFocused() {
    const active = document.activeElement;
    return !!active && (window.term?.element?.contains(active) ||
      active === window.__zjSoftKbdCapture?.element);
  }
  function showEscapeStatus(message, failed = false) {
    if (!message && !escapeStatus) return;
    if (!escapeStatus) {
      escapeStatus = document.createElement('div');
      escapeStatus.setAttribute('role', 'status');
      escapeStatus.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:10000;max-width:min(360px,calc(100vw - 24px));box-sizing:border-box;padding:7px 10px;border:1px solid #363e4d;border-radius:6px;box-shadow:0 4px 16px #0006;background:#181b22;color:#e5e7eb;font:11px/1.4 system-ui;overflow-wrap:anywhere;pointer-events:none';
      document.body.append(escapeStatus);
    }
    escapeStatus.textContent = message;
    escapeStatus.style.color = failed ? '#ffd57a' : '#e5e7eb';
    escapeStatus.hidden = !message;
  }
  function sendEscape() {
      if(pendingFocus||pendingNewTab){showEscapeStatus('Waiting for the selected terminal to receive focus.',true);return;}
      const target = {session:latest?.session_name, pane_id:latest?.active_pane?.pane_id};
      if (!target.session || !Number.isInteger(target.pane_id)) {
        showEscapeStatus('Escape failed: terminal state is unavailable.', true);
        return;
      }
      showEscapeStatus('');
      escapeQueue = escapeQueue.then(async () => {
        try {
          const response = await fetch(`/api/hosts/${host}/escape`, {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(target),
          });
          if (!response.ok) throw new Error((await response.text()).slice(0, 240) || `HTTP ${response.status}`);
          showEscapeStatus('');
        } catch (error) {
          showEscapeStatus(`Escape failed: ${error.message}`, true);
        }
      });
  }
  window.addEventListener('keydown',event=>{
    if(hasDialog())return;
    if(event.code==='KeyT'&&event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey
        &&!event.isComposing&&terminalFocused()){
      // Switchboard owns tab navigation; do not enter Zellij's native Tab mode.
      event.preventDefault();event.stopImmediatePropagation();return;
    }
    if(event.code==='KeyT'&&(event.ctrlKey!==event.metaKey)&&event.altKey&&!event.shiftKey&&!event.isComposing&&terminalFocused()){
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.repeat)parent.postMessage({type:'zellij-open-new-tab',host},location.origin);return;
    }
    if(event.code==='KeyD'&&event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey
        &&!event.isComposing&&terminalFocused()){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.repeat)return;
      if(pendingFocus){showEscapeStatus('Waiting for the selected terminal to receive focus.',true);return;}
      parent.postMessage({type:'zellij-close-tab',host},location.origin);return;
    }
    if((event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey&&event.code==='KeyK'){
      event.preventDefault();event.stopImmediatePropagation();
      parent.postMessage({type:'zellij-tab-search',host},location.origin);return;
    }
    if(event.code === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey &&
        !event.shiftKey && !event.isComposing && terminalFocused()) {
      // Stock web 0.45.1 loses bare ESC during idle finalization. The relay
      // writes byte 27 directly to the terminal identified by current metadata.
      const pane = latest?.active_pane;
      if (pane?.is_plugin) return;
      event.preventDefault();event.stopImmediatePropagation();
      sendEscape();
      return;
    }
    if(event.code==='Backspace'&&event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey
        &&!event.isComposing&&terminalFocused()){
      // xterm.js sends ^H, which Zellij reads as Ctrl+H (Move mode). Send ^W
      // (delete word left) instead, as VS Code's terminal does.
      event.preventDefault();event.stopImmediatePropagation();
      if(pendingFocus||pendingNewTab||window.term?.options.disableStdin)return;
      if(terminalSocket?.readyState===1)terminalSocket.send('\x17');
      return;
    }
    if(!event.altKey||event.ctrlKey||event.metaKey||event.isComposing)return;
    if(!event.shiftKey && ['ArrowLeft','ArrowRight'].includes(event.code) && terminalFocused()){
      event.preventDefault();event.stopImmediatePropagation();
      if(pendingFocus||pendingNewTab||window.term?.options.disableStdin)return;
      if(terminalSocket?.readyState!==1)return;
      // Send standard word movement rather than Zellij's Alt+Arrow pane bindings.
      terminalSocket.send(event.code==='ArrowLeft'?'\x1b[1;5D':'\x1b[1;5C');
      return;
    }
    // Physical key codes also work with macOS Option producing ˙ and ¬.
    const direction=event.code==='KeyH'?-1:event.code==='KeyL'?1:0;
    if(!direction)return;
    event.preventDefault();event.stopImmediatePropagation();
    parent.postMessage({type:event.shiftKey?'zellij-tab-move':'zellij-tab-step',host,direction},location.origin);
  },true);
  let showNativeTabs = localStorage.getItem('switchboard-native-tabs') === 'true';
  let hookedTerm;
  const style = document.createElement('style');
  style.textContent = `
    #switchboard-viewport { position:fixed;inset:0;overflow:auto;scrollbar-width:thin;overscroll-behavior:contain; }
    body.zj-mobile-active #switchboard-viewport { top:var(--zj-chrome-top,0px);bottom:var(--zj-chrome-bottom,0px); }
    body.switchboard-owned-viewport #terminal { height:auto;overflow:hidden; }
    #switchboard-bottom { position:fixed;right:16px;bottom:16px;z-index:10000;padding:6px 10px;border:1px solid #555;border-radius:6px;background:#252525;color:white; }
    body.switchboard-hide-tabs:not(.zj-mobile-active),
    body.switchboard-hide-status:not(.zj-mobile-active) { overflow: hidden; }
    body.switchboard-hide-tabs:not(.zj-mobile-active) #terminal,
    body.switchboard-hide-status:not(.zj-mobile-active) #terminal {
      margin-top: calc(-1 * var(--switchboard-tab-height, 0px));
      height: calc(var(--dynamic-vh, 100vh) + var(--switchboard-tab-height, 0px));
    }
  `;
  document.head.append(style);
  function syncRendererScale(term) {
    const renderer=term._core?._renderService?._renderer?.value;
    const canvas=renderer?._canvas,expected=renderer?.dimensions?.device?.canvas;
    // The WebGL pixel observer can resize the backing canvas before its viewport
    // and cell dimensions catch up after zoom or a display-scale change.
    if(!canvas||!expected?.width||!expected.height||typeof renderer.handleResize!=='function')return;
    if(canvas.width===expected.width&&canvas.height===expected.height)return;
    renderer.handleResize(term.cols,term.rows);
    term.refresh(0,term.rows-1);
  }
  function updateChrome() {
    const term = window.term;
    if (!term || !document.body) return;
    if (hookedTerm !== term) {
      hookedTerm = term;
      term.onRender(updateChrome);
      term.onResize(updateChrome);
      new MutationObserver(updateChrome).observe(document.body,{attributes:true,attributeFilter:['class']});
    }
    syncRendererScale(term);
    // Only crop an identified native bar. Fullscreen panes and alternate layouts
    // without the bar keep every terminal row. Mobile owns its own viewport.
    const firstRow = term.buffer.active.getLine(term.buffer.active.viewportY)?.translateToString(true) || '';
    const identifiedTop = /^\s*Zellij\s*\(/.test(firstRow);
    const cellHeight = term._core?._renderService?.dimensions?.css?.cell?.height;
    const bottomRows = window.__switchboardBottomRows?.(term, latest) || 0;
    if(viewportSupported()){
      const position=latest.active_pane?.tab_position;
      const fullscreen=!!latest.render_prefs?.active_pane_is_fullscreen;
      const key=JSON.stringify([position,fullscreen,(latest.panes||[]).filter(pane=>pane.is_plugin&&pane.tab_position===position).map(pane=>pane.pane_id).sort((a,b)=>a-b)]);
      if(key!==chromeKey){chromeKey=key;nativeTopBar=false;nativeBottomRows=0;}
      // Resizing clears xterm temporarily. Keep known chrome measurements until the layout changes.
      if(!fullscreen){nativeTopBar ||= identifiedTop;nativeBottomRows=Math.max(nativeBottomRows,bottomRows);}
    }
    const hide = !showNativeTabs && (viewportSupported()?nativeTopBar:identifiedTop) && !document.body.classList.contains('zj-mobile-active');
    const hideBottom = bottomRows > 0 && !!cellHeight;
    const oldHeight = document.documentElement.style.getPropertyValue('--switchboard-tab-height');
    const height = hide && cellHeight ? `${cellHeight}px` : '0px';
    const changed = document.body.classList.contains('switchboard-hide-tabs') !== hide ||
      document.body.classList.contains('switchboard-hide-status') !== hideBottom ||
      oldHeight !== height;
    claimFocusedViewport();
    updateViewport();
    if (!changed) return;
    document.documentElement.style.setProperty('--switchboard-tab-height',height);
    document.body.classList.toggle('switchboard-hide-tabs',hide);
    document.body.classList.toggle('switchboard-hide-status',hideBottom);
    // Let the stock fit/resize handler allocate the extra row and report it to
    // the server. xterm's shifted bounds also keep mouse coordinates correct.
    // Bottom clipping must not resize: a resize briefly clears the status row,
    // which otherwise alternates the crop and sends another resize forever.
    if(oldHeight !== height)requestAnimationFrame(()=>window.dispatchEvent(new Event('zellij:rendering-resize')));
  }
  function sendState(payload) {
    latest = payload;
    if(viewportSupported())window.dispatchEvent(new Event('zellij:rendering-resize'));
    const created=pendingNewTab&&latest.active_pane&&!latest.active_pane.is_plugin&&!pendingNewTab.panes.has(latest.active_pane.pane_id);
    if(created){releaseNewTab();window.term?.focus();}
    const missingFocus=pendingFocus && Array.isArray(latest.panes) && !latest.panes.some(pane=>pane.pane_id===pendingFocus.pane_id && pane.is_plugin===pendingFocus.is_plugin);
    if(missingFocus)rejectFocus();
    if(!missingFocus && pendingFocus && latest.active_pane?.pane_id===pendingFocus.pane_id && latest.active_pane?.is_plugin===pendingFocus.is_plugin){
      if(desiredFocus.pane_id!==pendingFocus.pane_id || desiredFocus.is_plugin!==pendingFocus.is_plugin)dispatchFocus();
      else{releaseFocus();window.term?.focus();}
    }
    parent.postMessage({type: 'zellij-state', host, payload, focus_id:focusId, focus_pending:!!pendingFocus}, location.origin);
    requestAnimationFrame(updateChrome);
  }
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      if(String(args[0]).includes('/ws/terminal')){
        terminalSocket=this;
        this.addEventListener('close',()=>{if(terminalSocket===this)terminalSocket=null;});
      }
      if (String(args[0]).includes('/ws/control')) {
        this.addEventListener('message', event => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'MobileState') sendState(message.payload);
            if (message.type === 'LogError') {
              // Unrelated control errors must not acknowledge an in-flight focus.
              if(pendingFocus && message.lines?.some(line=>line.includes(`Could not find pane with id: ${pendingFocus.is_plugin?'Plugin':'Terminal'}(${pendingFocus.pane_id})`)))rejectFocus();
            }
          } catch (_) {}
        });
        this.addEventListener('close', () => {
          latest = undefined;
          lastViewport=null;claimedViewportTab=null;updateViewport();
          releaseFocus();
          releaseNewTab();
          parent.postMessage({type:'zellij-disconnected',host},location.origin);
        });
      }
    }
  };
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent) return;
    const message = event.data;
    if (message?.type === 'zellij-focus' && window.__zjSendControl) {
      focusId=message.focus_id;
      if (pendingFocus || latest?.active_pane?.pane_id !== message.pane_id || latest?.active_pane?.is_plugin !== message.is_plugin){
        desiredFocus={pane_id:message.pane_id,is_plugin:message.is_plugin};
        if(window.term?.element){
          focusInputState ||= {disabled:window.term.options.disableStdin,pointer:window.term.element.style.pointerEvents};
          window.term.options.disableStdin=true;window.term.element.style.pointerEvents='none';window.term.blur();
          showEscapeStatus('Switching terminal…');
        }
        if(!pendingFocus)dispatchFocus();
      }else{releaseFocus();window.term?.focus();if(latest)sendState(latest);}
    } else if (message?.type === 'zellij-escape' && !hasDialog()) {
      window.term?.focus();
      if(!latest?.active_pane?.is_plugin)sendEscape();
    } else if (message?.type === 'zellij-native-tabs') {
      showNativeTabs = !!message.visible;
      updateChrome();
    } else if(message?.type==='zellij-window-focus'){
      claimFocusedViewport(true);
    } else if(message?.type==='zellij-size-owner' && viewportSupported() && !pendingFocus && !pendingNewTab && message.tab_position===latest.active_pane?.tab_position){
      const size=physicalViewport();
      if(size)window.__zjViewport.report(size,!!message.owned);
    } else if (message?.type === 'zellij-new-tab' && window.__zjSendControl) {
      if(pendingFocus||pendingNewTab||!latest?.active_pane||!window.term)return;
      pendingNewTab={panes:new Set((latest.panes||[]).filter(pane=>!pane.is_plugin).map(pane=>pane.pane_id)),disabled:window.term.options.disableStdin};
      pendingNewTab.panes.add(latest.active_pane.pane_id);
      window.term.options.disableStdin=true;
      pendingNewTab.timeout=setTimeout(()=>{releaseNewTab();showEscapeStatus('No new tab received. Check the connection and try again.',true);},30000);
      window.__zjSendControl({type:'NewTab'});
    }
  });
})();
