// Reuse the stock web client and expose only metadata and explicit focus commands.
(() => {
  // Stock reconnect notices and terminal construction must never grab parent focus.
  window.__switchboardManagedFocus = true;
  const NativeSocket = window.WebSocket;
  const host = location.pathname.split('/')[2];
  let latest;
  let disconnectedPane;
  // Retain the requested pane even if control closes before the stock handler
  // captures its reconnect target. Socket-open alone must not enable typing.
  window.__zjReconnectPane = () => desiredFocus || latest?.active_pane || disconnectedPane;
  let escapeStatus;
  let pendingFocus, desiredFocus, focusInputState, focusId, focusTimeout, focusAttempts=0;
  const focusMaxAttempts=3, focusTimeoutMs=5000;
  let pendingNewTab;
  window.addEventListener('zellij-terminal-failed',event=>{
    const pane=desiredFocus||latest?.active_pane||disconnectedPane;
    const failure={...event.detail};
    if(failure.operation==='browser'){
      failure.session=latest?.session_name||decodeURIComponent(location.pathname.split('/').slice(3).join('/'));
      failure.pane_id=pane?.pane_id??null;failure.is_plugin=!!pane?.is_plugin;
      failure.pending_records??=terminalSocket?.owner?.pending?.length??null;
    }
    parent.postMessage({type:'zellij-terminal-failed',failure},location.origin);
  });
  let focusOrigin, preserveFocus = false;
  function focusTerminalInput() {
    const capture=window.__zjSoftKbdEnabled&&window.__zjSoftKbdCapture?.element;
    if(capture)capture.focus({preventScroll:true});
    else window.term?.focus();
  }
  function conversationOpen(){return !!parent.document.getElementById('terminals')?.classList.contains('conversation-open');}
  function restoreTerminalFocus(origin = focusOrigin, preserve = preserveFocus) {
    if (conversationOpen() || !parent.document.hasFocus() || parent.document.querySelector('dialog[open]') ||
      (window.frameElement && !window.frameElement.classList.contains('active'))) return;
    const active = parent.document.activeElement;
    // Focus still in this frame but on nothing (a reconnect reload or a pane
    // switch blurred xterm) belongs to the terminal; it was never elsewhere.
    const stray = !!window.frameElement && active === window.frameElement && (!document.activeElement || document.activeElement === document.body);
    if (stray || (!preserve && active === origin)) focusTerminalInput();
  }
  let terminalSocket, controlSocket;
  // Instant typing draws what the terminal socket sends before it echoes (predict.js, off by default).
  const predict=window.SwitchboardPredictiveEcho?.install({report:miss=>{const pane=latest?.active_pane;
    if(pane)parent.postMessage({type:'zellij-predict-diagnostic',diagnostic:{...miss,pane_id:pane.pane_id,is_plugin:!!pane.is_plugin}},location.origin);}});
  window.__switchboardPredict=predict;
  let scrollport, lastViewport, viewportTab, bottomButton, claimedViewportTab;
  let chromeKey, nativeTopBar=false, nativeBottomRows=0;
  const diagnostics=window.SwitchboardTerminalDiagnostics?.(
    diagnostic=>parent.postMessage({type:'zellij-switch-diagnostic',diagnostic},location.origin),
    ()=>{const size=physicalViewport(),term=window.term,cellHeight=term?._core?._renderService?.dimensions?.css?.cell?.height;
      // CSSOM normalizes zero lengths and omits a repeated fourth inset.
      const clip=term?._core?.screenElement?.style?.clipPath?.match(/^inset\(0(?:px)? 0(?:px)? ([\d.]+)px(?: 0(?:px)?)?\)$/);
      return {physical_cols:size?.cols??term?.cols??0,physical_rows:size?.rows??term?.rows??0,
      native_cols:latest?.tab_viewport?.cols??0,native_rows:latest?.tab_viewport?.rows??0,
      scroll_height_px:Math.round(scrollport?.scrollHeight??0),client_height_px:Math.round(scrollport?.clientHeight??0),scroll_top_px:Math.round(scrollport?.scrollTop??0),
      xterm_cols:window.term?.cols??0,xterm_rows:window.term?.rows??0,buffer_rows:window.term?.buffer?.active?.length??0,
      clipped_bottom_rows:clip&&cellHeight?Math.round(Number(clip[1])/cellHeight):0,
      document_hidden:document.visibilityState==='hidden',browser_focused:parent.document.hasFocus()};});
  window.addEventListener('wheel',event=>diagnostics?.wheel(event),{capture:true,passive:true});
  // wheel.js reports how many wheel reports reached the terminal.
  window.__zjOnWheelReports=count=>diagnostics?.wheelReports(count);
  // First load of this page; performance.now() counts from this frame's navigation.
  const load={socket_ms:null,frame_ms:null,done:false,visible:document.visibilityState==='visible'&&!!window.frameElement?.classList.contains('active')};
  function reportLoad(){
    if(load.done)return;
    load.done=true;
    const now=Math.round(performance.now()),page=performance.getEntriesByType?.('navigation')?.[0];
    parent.postMessage({type:'zellij-load-diagnostic',diagnostic:{outcome:'ready',elapsed_ms:now,
      page_ms:page?Math.round(page.domContentLoadedEventEnd)||null:null,socket_ms:load.socket_ms,frame_ms:load.frame_ms,
      render_ms:now,visible:load.visible}},location.origin);
  }
  let shiftPressedAt=null,shiftReleasedAt=null;
  window.addEventListener('keyup',event=>{if(event.key==='Shift'){shiftPressedAt=null;shiftReleasedAt=performance.now();}},true);
  window.addEventListener('blur',()=>{shiftPressedAt=null;shiftReleasedAt=null;});
  function viewportSupported(){return !!window.__zjSupportsTabViewport && !!latest?.tab_viewport;}
  function physicalViewport(){
    if(conversationOpen()||!viewportSupported())return;
    const cell=window.term?._core?._renderService?.dimensions?.css?.cell;
    if(!cell?.width||!cell.height)return;
    const mobile=document.body.classList.contains('zj-mobile-active');
    const height=(window.visualViewport?.height||window.innerHeight);
    const width=(window.visualViewport?.width||window.innerWidth);
    const top=!mobile&&!showNativeTabs&&nativeTopBar?cell.height:0;
    const nativeRows=mobile?0:nativeBottomRows;
    const chrome=mobile?parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zj-chrome-top'))||0:0;
    const footer=mobile?parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zj-chrome-bottom'))||0:0;
    // A frame with no room has nothing true to report; see hasRoom in the web client.
    if(Math.floor(width/cell.width)<=2)return;
    return {cols:Math.floor(width/cell.width),rows:Math.max(1,Math.floor((height-chrome-footer+top)/cell.height)+nativeRows)};
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
      if(conversationOpen()||!viewportSupported()||!Number.isInteger(tab)||!window.__zjSendControl)return false;
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
  window.addEventListener('focus',()=>{claimFocusedViewport(true);if(!pendingFocus&&!pendingNewTab)restoreTerminalFocus(null);});
  // A viewer behind Conversation or another sidebar tab must not size the
  // terminal on other screens. The engine confirms in tab_viewport.hidden;
  // an older engine never does, so the sidebar disconnects that viewer instead.
  let sentHidden=null,viewerReportedHidden=false,hiddenAck=0;
  function viewerHidden(){return conversationOpen()||!!window.frameElement&&!window.frameElement.classList.contains('active');}
  // The web client asks on every attach, so a viewer that loads or reconnects
  // behind Conversation never sizes the tab for other screens.
  window.__zjViewerHidden=viewerHidden;
  function updateHidden(){
    if(!latest||!window.__zjSendControl||controlSocket?.readyState!==1)return;
    const hidden=viewerHidden();
    if(hidden===(sentHidden??false)){sentHidden=hidden;return;}
    sentHidden=hidden;viewerReportedHidden=true;clearTimeout(hiddenAck);
    window.__zjSendControl({type:'SetViewerHidden',hidden});
    if(hidden){
      claimedViewportTab=null;
      hiddenAck=setTimeout(()=>{if(sentHidden&&latest?.tab_viewport?.hidden!==true)parent.postMessage({type:'zellij-hide-unsupported'},location.origin);},2000);
    }else claimFocusedViewport(true);
  }
  if(window.frameElement){
    const watch=new MutationObserver(()=>updateHidden());
    watch.observe(window.frameElement,{attributes:true,attributeFilter:['class']});
    const terminals=parent.document.getElementById('terminals');
    if(terminals)watch.observe(terminals,{attributes:true,attributeFilter:['class']});
    // Observing the sidebar's #terminals would otherwise keep this whole page in memory after the frame retires.
    addEventListener('pagehide',event=>{if(!event.persisted)watch.disconnect();});
  }
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
      bottomButton.onclick=()=>{scrollport.scrollTop=scrollport.scrollHeight;focusTerminalInput();};
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
  function releaseNewTab(outcome,detail) {
    if(!pendingNewTab)return;
    const pending=pendingNewTab,now=performance.timeOrigin+performance.now();
    clearTimeout(pending.timeout);
    if(window.term)window.term.options.disableStdin=pending.disabled;
    pendingNewTab=null;
    parent.postMessage({type:'zellij-new-tab-diagnostic',diagnostic:{
      request_id:pending.requestId,outcome,elapsed_ms:Math.round(now-pending.startedAt),
      delivery_ms:Math.round(pending.receivedAt-pending.startedAt),
      sent_ms:pending.sentAt===null?null:Math.round(pending.sentAt-pending.startedAt),
      pane_id:outcome==='ready'?latest.active_pane.pane_id:null,
      control_socket:controlSocket?.readyState??null,
    }},location.origin);
    if(outcome!=='ready'){
      const message=detail||(outcome==='timeout'?'No new tab received. Check the connection and try again.':
        'Tab creation interrupted by a connection change. Check the connection and try again.');
      showEscapeStatus(message,true);
      parent.postMessage({type:'zellij-new-tab-failed',request_id:pending.requestId,message},location.origin);
    }
  }
  function sendPendingNewTab(){
    if(!pendingNewTab||pendingNewTab.sentAt!==null||!window.__zjSendControl)return;
    if(controlSocket&&controlSocket.readyState!==1){
      if(controlSocket.readyState!==0)releaseNewTab('disconnected');
      return;
    }
    // Unlike focus, creation is not idempotent. Retry only an unsent request.
    pendingNewTab.sentAt=performance.timeOrigin+performance.now();
    if(typeof pendingNewTab.prompt==='string'){
      createAgentTab(pendingNewTab);return;
    }
    try{window.__zjSendControl({type:'NewTab',elevated:pendingNewTab.elevated,project:pendingNewTab.project,command:pendingNewTab.command,prompt:pendingNewTab.prompt,images:pendingNewTab.images});}
    catch(_){releaseNewTab('send-failed');}
  }
  async function createAgentTab(pending){
    // Workers deliberately survive updates. Resolve model launches in the current
    // web service, since a retained worker may still hardcode the old Sol default.
    try{
      const response=await fetch(`/hosts/${host}/new-tab`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:latest.session_name,project:pending.project,command:pending.command,prompt:pending.prompt,images:pending.images,elevated:pending.elevated})});
      if(!response.ok)throw Error(response.status===404?'Update Switchboard on this computer to create this tab.':await response.text());
      const result=await response.json();
      if(!Number.isInteger(result.pane_id)||result.pane_id<0)throw Error('The new tab did not return its identity. Check the tab list before retrying.');
      if(pendingNewTab!==pending)return;
      pending.createdPane=result.pane_id;
      window.__zjSendControl({type:'FocusPane',pane_id:result.pane_id,is_plugin:false});
    }catch(error){if(pendingNewTab===pending)releaseNewTab('send-failed',error.message||'Could not confirm tab creation. Check the tab list before retrying.');}
  }
  function holdFocusInput() {
    if(controlSocket?.resumable)return; // focus and input share one ordered worker stream
    if(!window.term?.element)return;
    focusInputState ||= {disabled:window.term.options.disableStdin,pointer:window.term.element.style.pointerEvents};
    window.term.options.disableStdin=true;window.term.element.style.pointerEvents='none';
    window.__zjSoftKbdCapture?.element?.blur();window.term.blur();
    showEscapeStatus('Switching terminal…');
  }
  function dispatchFocus() {
    clearTimeout(focusTimeout);
    // A superseding click restarts the attempt budget for the newest target.
    if(pendingFocus!==desiredFocus)focusAttempts=0;
    pendingFocus=desiredFocus;
    focusAttempts++;
    // Control sends can be dropped during reconnect, and a no-op focus may
    // produce no MobileState. Never leave input disabled waiting forever.
    focusTimeout=setTimeout(focusTimedOut,focusTimeoutMs);
    sendPendingFocus();
  }
  function sendPendingFocus() {
    // The stock sender silently discards messages before its socket is open.
    // Keep startup/reconnect requests until the connection can deliver them.
    if(!pendingFocus||!window.__zjSendControl||(controlSocket&&controlSocket.readyState!==1))return;
    try {
      window.__zjSendControl({type:'FocusPane',pane_id:pendingFocus.pane_id,is_plugin:pendingFocus.is_plugin});
    } catch (_) {
      failFocus('Terminal switch failed. Check the connection and try again.');
    }
  }
  function focusTimedOut(){
    // A newer click supersedes the unconfirmed target instead of failing it,
    // so rapid switches never stall on an acknowledgement that will not come.
    if(pendingFocus!==desiredFocus){dispatchFocus();return;}
    if(focusAttempts<focusMaxAttempts){
      showEscapeStatus(`Switching terminal… (attempt ${focusAttempts+1} of ${focusMaxAttempts})`);
      dispatchFocus();return;
    }
    failFocus('Terminal switch timed out. Try selecting the tab again.');
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
    diagnostics?.finish('timeout');
    releaseFocus();
    parent.postMessage({type:'zellij-focus-failed',host,focus_id:focusId,payload:latest,message},location.origin);
    showEscapeStatus(message,true);
    restoreTerminalFocus();
  }
  function rejectFocus() {
    if(desiredFocus.pane_id!==pendingFocus.pane_id || desiredFocus.is_plugin!==pendingFocus.is_plugin){
      if(latest?.active_pane?.pane_id===desiredFocus.pane_id && latest.active_pane.is_plugin===desiredFocus.is_plugin){
        diagnostics?.ack();
        releaseFocus();restoreTerminalFocus();
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
    // Closed shadow roots expose their host; the capture mirrors its own focus.
    return !!active && (window.term?.element?.contains(active) ||
      active === window.__zjSoftKbdCapture?.element || window.__zjSoftKbdCapture?.isFocused);
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
  window.addEventListener('keydown',event=>{
    const digit=/^Digit[1-9]$/.test(event.code);
    // Keep browser tab shortcuts away from older peers' terminal handlers:
    // Ctrl/Cmd+digits on every platform, without preventDefault.
    if(digit&&!event.altKey&&!event.shiftKey&&
        (event.metaKey!==event.ctrlKey)){
      event.stopImmediatePropagation();return;
    }
    if(event.key==='Shift'&&!event.repeat)shiftPressedAt=performance.now();
    if(event.key==='Enter'&&event.shiftKey&&!event.isComposing&&terminalFocused()&&!pendingFocus&&!pendingNewTab){
      const now=performance.now(),pane=latest?.active_pane;
      if(pane)parent.postMessage({type:'zellij-key-diagnostic',diagnostic:{pane_id:pane.pane_id,is_plugin:!!pane.is_plugin,
        shift:true,ctrl:!!event.ctrlKey,alt:!!event.altKey,meta:!!event.metaKey,repeat:!!event.repeat,
        held_ms:shiftPressedAt===null?null:Math.round(now-shiftPressedAt),released_ms:shiftReleasedAt===null?null:Math.round(now-shiftReleasedAt)}},location.origin);
    }
    if(hasDialog())return;
    if(event.code==='KeyT'&&!event.ctrlKey&&!event.metaKey&&event.altKey&&!event.shiftKey&&!event.isComposing&&terminalFocused()){
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.repeat)parent.postMessage({type:'zellij-open-new-tab',host},location.origin);return;
    }
    if(event.code==='KeyD'&&event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey
        &&!event.isComposing&&(terminalFocused()||(pendingFocus&&document.activeElement===document.body))){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.repeat)return;
      // Closing uses the parent's selected tab ID, independently of native focus.
      parent.postMessage({type:'zellij-close-tab',host},location.origin);return;
    }
    // Match the sidebar: Alt+digits on every platform, before xterm/Zellij.
    if(digit&&!event.metaKey&&!event.shiftKey&&
        event.altKey&&!event.ctrlKey){
      event.preventDefault();event.stopImmediatePropagation();
      parent.postMessage({type:'zellij-tab-number',host,number:+event.code.slice(5)},location.origin);return;
    }
    // Cmd+K on a Mac, Ctrl+K elsewhere: a Mac terminal's Ctrl+K deletes to the end of the line.
    if((navigator.platform.startsWith('Mac')?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey)&&!event.altKey&&!event.shiftKey&&event.code==='KeyK'){
      event.preventDefault();event.stopImmediatePropagation();
      parent.postMessage({type:'zellij-tab-search',host},location.origin);return;
    }
    if(event.code==='KeyL'&&event.ctrlKey&&!event.metaKey&&!event.shiftKey
        &&!event.isComposing&&!event.getModifierState?.('AltGraph')&&terminalFocused()){
      // Cancel the address-bar action before xterm handles Ctrl+L. Ctrl+Alt+L
      // sends the same clear-screen input if the browser keeps Ctrl+L itself.
      event.preventDefault();event.stopImmediatePropagation();
      if(pendingFocus||pendingNewTab||window.term?.options.disableStdin)return;
      if(terminalSocket?.readyState===1)window.term?.input('\x0c');
      return;
    }
    if(event.code==='Backspace'&&(event.ctrlKey!==event.altKey)&&!event.metaKey&&!event.shiftKey
        &&!event.isComposing&&terminalFocused()){
      // xterm.js sends ^H, which Zellij reads as Ctrl+H (Move mode). Send ^W
      // (delete word left) for either Ctrl or Alt instead of ambiguous Backspace
      // sequences, including when the shell runs through Windows ConPTY.
      event.preventDefault();event.stopImmediatePropagation();
      if(pendingFocus||pendingNewTab||window.term?.options.disableStdin)return;
      if(terminalSocket?.readyState===1)window.term?.input('\x17');
      return;
    }
    if(!event.altKey||event.ctrlKey||event.metaKey||event.isComposing)return;
    if(!event.shiftKey && ['ArrowLeft','ArrowRight'].includes(event.code) && terminalFocused()){
      event.preventDefault();event.stopImmediatePropagation();
      if(pendingFocus||pendingNewTab||window.term?.options.disableStdin)return;
      if(terminalSocket?.readyState!==1)return;
      // Send standard word movement rather than Zellij's Alt+Arrow pane bindings.
      window.term?.input(event.code==='ArrowLeft'?'\x1b[1;5D':'\x1b[1;5C');
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
    #switchboard-viewport { position:fixed;inset:0;overflow:auto;overscroll-behavior:contain; }
    /* Keep scrolling without Windows' persistent scrollbar tracks. */
    #switchboard-viewport, .xterm .xterm-viewport { scrollbar-width:none; }
    #switchboard-viewport::-webkit-scrollbar, .xterm .xterm-viewport::-webkit-scrollbar { display:none; }
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
      diagnostics?.hook(term);
      hookedTerm = term;
      term.onRender(updateChrome);
      term.onRender(()=>{if(load.frame_ms!==null)reportLoad();});
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
    // Guesses belong to the pane they were typed in; another pane's screen would report them as its misses.
    const was=latest?.active_pane,now=payload?.active_pane;
    if(was&&(was.pane_id!==now?.pane_id||was.is_plugin!==now?.is_plugin))predict?.reset();
    latest = payload;
    // The engine says how the viewer attached: hidden behind Conversation, it must still
    // rejoin sizing if Terminal was shown first. On an older engine the web server reports
    // hidden just after the first state, so until this viewer reports, a hidden state wins.
    const reportedHidden=payload?.tab_viewport?.hidden;
    if(typeof reportedHidden==='boolean'&&(sentHidden===null||reportedHidden&&!viewerReportedHidden))sentHidden=reportedHidden;
    diagnostics?.state(payload);
    if(viewportSupported())window.dispatchEvent(new Event('zellij:rendering-resize'));
    const created=pendingNewTab&&pendingNewTab.sentAt!==null&&latest.active_pane&&!latest.active_pane.is_plugin&&!pendingNewTab.panes.has(latest.active_pane.pane_id)&&
      (typeof pendingNewTab.prompt!=='string'||latest.active_pane.pane_id===pendingNewTab.createdPane);
    if(created){const origin=pendingNewTab.focusOrigin;releaseNewTab('ready');restoreTerminalFocus(origin);}
    const missingFocus=pendingFocus && Array.isArray(latest.panes) && !latest.panes.some(pane=>pane.pane_id===pendingFocus.pane_id && pane.is_plugin===pendingFocus.is_plugin);
    if(missingFocus)rejectFocus();
    if(!missingFocus && pendingFocus && latest.active_pane?.pane_id===pendingFocus.pane_id && latest.active_pane?.is_plugin===pendingFocus.is_plugin){
      if(desiredFocus.pane_id!==pendingFocus.pane_id || desiredFocus.is_plugin!==pendingFocus.is_plugin)dispatchFocus();
      else{diagnostics?.ack();releaseFocus();restoreTerminalFocus();}
    }
    parent.postMessage({type: 'zellij-state', host, payload, focus_id:focusId, focus_pending:!!pendingFocus}, location.origin);
    updateHidden();
    requestAnimationFrame(updateChrome);
  }
  function observeSocket(socket,url) {
      if(String(url).includes('/ws/terminal')){
        terminalSocket=socket;
        predict?.attach(window.term);
        socket.addEventListener('open',()=>{load.socket_ms??=Math.round(performance.now());});
        socket.addEventListener('message',event=>{if(terminalSocket!==socket)return;load.frame_ms??=Math.round(performance.now());diagnostics?.hook(window.term);diagnostics?.frame(event.data);});
        socket.addEventListener('close',()=>{if(terminalSocket===socket){terminalSocket=null;predict?.reset();}});
      }
      if (String(url).includes('/ws/control')) {
        controlSocket=socket;
        socket.addEventListener('open',()=>{
          if(controlSocket!==socket)return;
          sendPendingNewTab();
          if(!pendingFocus)return;
          holdFocusInput();
          if(pendingFocus!==desiredFocus)dispatchFocus();else sendPendingFocus();
        });
        socket.addEventListener('message', event => {
          if(controlSocket!==socket)return;
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'MobileState') sendState(message.payload);
            if (message.type === 'FocusConfirmed' && latest?.active_pane?.pane_id===message.payload?.pane_id && latest.active_pane.is_plugin===message.payload.is_plugin) sendState(latest);
            if (message.type === 'LogError') {
              // Unrelated control errors must not acknowledge an in-flight focus.
              if(pendingFocus && message.lines?.some(line=>line.includes(`Could not find pane with id: ${pendingFocus.is_plugin?'Plugin':'Terminal'}(${pendingFocus.pane_id})`)))rejectFocus();
            }
          } catch (_) {}
        });
        socket.addEventListener('close', () => {
          if(controlSocket!==socket)return;
          disconnectedPane = desiredFocus || latest?.active_pane || disconnectedPane;
          latest = undefined;
          diagnostics?.finish('disconnected');
          lastViewport=null;claimedViewportTab=null;sentHidden=null;viewerReportedHidden=false;clearTimeout(hiddenAck);updateViewport();
          releaseFocus();
          parent.postMessage({type:'zellij-disconnected',host},location.origin);
          releaseNewTab('disconnected');
        });
      }
  }
  // All the ways a viewer can change a terminal's size. Every control message passes
  // through here, so a viewer behind Conversation cannot size the terminal by any route.
  const sizingMessages=new Set(['TerminalResize','SetTabViewport','SetMobileRenderPreferences']);
  function suppressConversationResize(socket,data){
    if(controlSocket!==socket||!conversationOpen())return false;
    try{return sizingMessages.has(JSON.parse(data)?.payload?.type);}catch{return false;}
  }
  // Tells the sidebar the moment typed text is submitted, so the tab can show Working
  // before the agent reports its turn. Commands (/, !) may not start a turn at all.
  let typedDraft='',typedPane=null;
  function noteTerminalInput(socket,data){
    if(terminalSocket!==socket||socket.readyState!==1||typeof data!=='string')return;
    const pane=latest?.active_pane;
    if(!pane||pane.is_plugin){typedDraft='';return;}
    if(pane.pane_id!==typedPane){typedPane=pane.pane_id;typedDraft='';}
    if(data==='\x1b')parent.postMessage({type:'zellij-escape-sent',pane_id:pane.pane_id},location.origin);
    if(data==='\r'){
      const prompt=typedDraft.trimStart();typedDraft='';
      if(prompt&&prompt[0]!=='!'&&!/^\/[a-z][\w:.-]*(?:\s|$)/i.test(prompt))parent.postMessage({type:'zellij-prompt-submit',pane_id:pane.pane_id},location.origin);
      return;
    }
    if(data==='\x7f'){typedDraft=typedDraft.slice(0,-1);return;}
    if(data==='\x03'||data==='\x15'){typedDraft='';return;}
    const text=data.replace(/\x1b\[20[01]~/g,'');
    if(!/[\x00-\x08\x0b-\x1f\x7f]/.test(text))typedDraft+=text;
  }
  window.addEventListener("zellij-resumable-sockets",event=>{
    for (const socket of [event.detail.terminal,event.detail.control]) {
      const send=socket.send;
      socket.send=function(data){
        if(suppressConversationResize(this,data))return;
        if(controlSocket===this)diagnostics?.sent(data);
        if(terminalSocket===this&&this.readyState===1)predict?.sent(data);
        noteTerminalInput(this,data);
        return send.call(this,data);
      };
    }
    observeSocket(event.detail.terminal,"/ws/terminal");
    observeSocket(event.detail.control,"/ws/control");
  });
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args); observeSocket(this,args[0]);
    }
    send(data) {
      // The stock client also sends legacy/forced resizes when no physical
      // viewport is available. Conversation must not resize the native terminal.
      if(suppressConversationResize(this,data))return;
      if(controlSocket===this)diagnostics?.sent(data);
      if(terminalSocket===this&&this.readyState===1)predict?.sent(data);
      noteTerminalInput(this,data);
      return super.send(data);
    }
  };
  // Claude's input box, read as the relay's claude_prompt reads a screen dump: the
  // row after a rule that starts with ❯ (! in shell mode), through the next rule.
  // Claude draws its placeholder, queued-message hint and suggested prompt dim and
  // typed text never, so only undimmed cells are a draft.
  function claudePrompt(){
    const buffer=window.term.buffer.active,rows=[];
    for(let y=0;y<window.term.rows;y++){
      const line=buffer.getLine(buffer.baseY+y);let text='',bright='';
      if(typeof line?.getCell==='function')for(let x=0;x<line.length;x++){const cell=line.getCell(x),c=cell?.getChars()||' ';text+=c;bright+=cell?.isDim()?' ':c;}
      else text=bright=line?.translateToString(true)||'';
      rows.push({text,bright});
    }
    // A renamed session's box shows its name in the top rule: `──── name ─`.
    const rule=row=>/^[─━]{8,}(?: [^─━]*\S[^─━]* [─━]+)?$/.test(row.text.trim());
    for(let start=rows.length-1;start>0;start--){
      const marker=rows[start].text.trimStart()[0];
      if(!['❯','!'].includes(marker)||!rule(rows[start-1]))continue;
      const end=rows.findIndex((row,i)=>i>start&&rule(row));if(end<0)continue;
      const first=rows[start].bright.slice(rows[start].text.indexOf(marker)+1);
      const draft=[first,...rows.slice(start+1,end).map(row=>row.bright)].map(line=>line.trim()).join('\n').trim();
      return {draft,stashed:rows.slice(end+1).some(row=>row.text.includes('› stashed')),shell:marker==='!'};
    }
    return null;
  }
  // A draft typed in Terminal goes into Claude's stash (Ctrl+S), which keeps its
  // pasted blocks and shell mode; Claude restores it once the reply is submitted.
  // Ctrl+S never interrupts a turn, unlike Escape.
  function sendToClaude(message,reply,unchanged){
    const box=claudePrompt();
    if(!box)return reply(false,"Waiting for Claude's input box.");
    if(box.draft&&box.stashed)return reply(false,'Claude already holds a stashed prompt and a new draft in Terminal. Send or clear the draft there first.');
    const wait=(done,tries,then)=>{const now=claudePrompt();if(now&&done(now))return then(true);if(!tries)return then(false);setTimeout(()=>wait(done,tries-1,then),50);};
    const send=()=>{
      try{window.term.paste(message.text);window.term.input('\r');}catch{return reply(false,'Could not send the reply. Check the terminal before retrying.');}
      if(!box.draft)return reply(true);
      wait(now=>!now.stashed&&now.draft===box.draft&&now.shell===box.shell,20,restored=>reply(true,'',restored?'':"Your terminal draft is in Claude's stash. Press Ctrl+S on its empty prompt to bring it back."));
    };
    // An empty shell-mode box would run the reply as a command. Ctrl+S has nothing
    // to stash there; Backspace returns it to chat mode.
    if(!box.draft&&box.shell){
      try{window.term.input('\x7f');}catch{return reply(false,'Could not send the reply. Check the terminal before retrying.');}
      return wait(now=>!now.draft&&!now.shell,30,chat=>{
        if(!chat)return reply(false,'Claude stayed in shell mode. Open Terminal to send.');
        if(!unchanged()||terminalSocket?.readyState!==1)return reply(false,'The terminal pane changed. Open the intended terminal before replying.');
        send();
      });
    }
    if(!box.draft)return send();
    try{window.term.input('\x13');}catch{return reply(false,'Could not send the reply. Check the terminal before retrying.');}
    // Stashing also leaves shell mode.
    wait(now=>!now.draft&&now.stashed&&!now.shell,30,stashed=>{
      if(!stashed)return reply(false,'Claude did not set the terminal draft aside. Open Terminal to send.');
      if(!unchanged()||terminalSocket?.readyState!==1)return reply(false,'The terminal pane changed. Your terminal draft is in Claude\'s stash; press Ctrl+S on its empty prompt to bring it back.');
      send();
    });
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent) return;
    const message = event.data;
    if (message?.type === 'zellij-conversation-paste') {
      const reply=(ok,error,notice)=>parent.postMessage({type:'zellij-conversation-paste-result',id:message.id,ok,error,...notice&&{notice}},location.origin);
      if(typeof message.id!=='string'||typeof message.text!=='string'||!message.text||message.text.length>16000||/[\x00-\x08\x0b-\x1f\x7f]/.test(message.text))return reply(false,'Invalid terminal draft.');
      const unchanged=()=>!pendingFocus&&!pendingNewTab&&!latest?.active_pane?.is_plugin&&latest?.active_pane?.pane_id===message.pane_id&&window.frameElement?.classList.contains('active');
      if(!unchanged())return reply(false,'The terminal pane changed. Open the intended terminal before replying.');
      if(terminalSocket?.readyState!==1||!window.term||window.term.options.disableStdin)return reply(false,'The terminal is disconnected or not ready.');
      if(message.text.includes('\n')&&!window.term.modes.bracketedPasteMode)return reply(false,'This terminal cannot safely paste a multiline reply. Open the terminal instead.');
      if(message.submit&&message.agent==='claude')return sendToClaude(message,reply,unchanged);
      if(message.submit){
        const marker=message.agent==='codex'?'›':null;
        const buffer=window.term.buffer.active,lines=[];
        for(let row=0;row<window.term.rows;row++)lines.push(buffer.getLine(buffer.baseY+row)?.translateToString(true)||'');
        if(message.agent==='copilot'){
          const top=lines.findLastIndex(line=>/^╻▄+/.test(line.trim())),bottom=lines.findLastIndex(line=>/^╹▀+/.test(line.trim()));
          if(top<0||bottom<=top+1||!lines.slice(top+1,bottom).every(line=>/^┃\s*$/.test(line.trim())))return reply(false,'Clear the terminal prompt before sending.');
        }else{
        const index=marker?lines.findLastIndex(line=>line.trimStart().startsWith(marker)):-1;
        const bright=row=>{const line=buffer.getLine(buffer.baseY+row);if(!line)return '';if(typeof line.getCell!=='function')return lines[row];let text='';
          for(let x=0;x<line.length;x++){const cell=line.getCell(x);if(cell&&!cell.isDim())text+=cell.getChars()||' ';}return text;};
        const prompt=index<0?null:bright(index).trimStart().replace(marker,'').trim();
        const placeholder=['Ask Codex to do anything','Ask a follow-up question'].includes(prompt);
        if(prompt===null||(prompt!==''&&!placeholder))return reply(false,'Clear the terminal prompt before sending.');
        for(const line of lines.slice(index+1)){
          const text=line.trim();if(!text)continue;
          if(/^[─━ ]+$/.test(text)||(message.agent==='codex'&&/^(?:GPT-|gpt-|\? for shortcuts|← for agents)/.test(text)))break;
          return reply(false,'Clear the terminal prompt before sending.');
        }
        }
      }
      try{window.term.paste(message.text);if(message.submit)window.term.input('\r');reply(true);}catch{reply(false,'Could not send the reply. Check the terminal before retrying.');}
    } else if (message?.type === 'zellij-focus') {
      diagnostics?.start(message,window.term,!!pendingFocus||latest?.active_pane?.pane_id!==message.pane_id||latest?.active_pane?.is_plugin!==message.is_plugin);
      // An already active pane gets no new state; its current size is the size on arrival.
      if(latest)diagnostics?.state(latest);
      focusId=message.focus_id;
      focusOrigin=parent.document.activeElement;preserveFocus=!!message.preserve_focus;
      if (pendingFocus || latest?.active_pane?.pane_id !== message.pane_id || latest?.active_pane?.is_plugin !== message.is_plugin){
        desiredFocus={pane_id:message.pane_id,is_plugin:message.is_plugin};
        holdFocusInput();
        if(!pendingFocus)dispatchFocus();
      }else{diagnostics?.ack();releaseFocus();restoreTerminalFocus();if(latest)sendState(latest);}
    } else if (message?.type === 'zellij-restore-focus') {
      // Enabling an inert iframe can leave its input blurred. Restore only the
      // keyboard: another pane focus would replace the switch's render timings.
      if(!pendingFocus&&!pendingNewTab&&!parent.document.hidden&&parent.document.getElementById('artifact-preview')?.hidden!==false)
        restoreTerminalFocus(parent.document.body,false);
    } else if (message?.type === 'zellij-interrupt') {
      const pane=latest?.active_pane;
      const ok=Date.now()<=message.expires&&!hasDialog()&&!pendingFocus&&!pendingNewTab&&latest?.session_name===message.session&&pane&&!pane.is_plugin&&pane.pane_id===message.pane_id&&terminalSocket?.readyState===1&&window.term&&!window.term.options.disableStdin;
      if(ok)window.term.input('\x1b');
      parent.postMessage({type:'zellij-interrupt-result',id:message.id,ok:!!ok},location.origin);
    } else if (message?.type === 'zellij-escape' && !hasDialog()) {
      focusTerminalInput();
      // The same byte the key sends, in order with typing on the terminal socket.
      window.term?.input('\x1b');
    } else if (message?.type === 'zellij-native-tabs') {
      showNativeTabs = !!message.visible;
      updateChrome();
    } else if(message?.type==='zellij-window-focus'){
      claimFocusedViewport(true);
    } else if(message?.type==='zellij-browser-resume'&&Number.isInteger(message.id)&&message.id>=0){
      const receivedAt=performance.timeOrigin+performance.now();
      const pending=diagnostics?.pending(message.started_at);
      const received={id:message.id,received_at:receivedAt,
        initial_writes_pending:pending?.writes_pending??null,initial_render_pending:pending?.render_pending??null,
        terminal_hidden:document.visibilityState==='hidden',
        terminal_active:window.frameElement?window.frameElement.classList.contains('active'):null};
      const reply=(type,phase,animationAt=null,renderCycleMs=null)=>parent.postMessage({type,diagnostic:{...received,phase,animation_at:animationAt,render_cycle_ms:renderCycleMs,
        ...diagnostics?.pending(message.started_at),terminal_socket:terminalSocket?.readyState??null,
        control_socket:controlSocket?.readyState??null}},location.origin);
      reply('zellij-browser-resume-received','received');
      requestAnimationFrame(()=>{
        const animationStarted=performance.now(),animationAt=performance.timeOrigin+animationStarted;
        // Rendering runs after animation callbacks; sample in the following task.
        setTimeout(()=>reply('zellij-browser-resume-diagnostic','animation',animationAt,Math.round(performance.now()-animationStarted)),0);
      });
    } else if(message?.type==='zellij-size-owner' && viewportSupported() && !pendingFocus && !pendingNewTab && message.tab_position===latest.active_pane?.tab_position){
      const size=physicalViewport();
      if(size)window.__zjViewport.report(size,!!message.owned);
    } else if (message?.type === 'zellij-new-tab') {
      if(pendingNewTab)return;
      if(pendingFocus||!latest?.active_pane||!window.term||!window.__zjSendControl){
        parent.postMessage({type:'zellij-new-tab-failed',request_id:message.request_id,message:'The terminal is reconnecting. Wait for it to connect and try again.'},location.origin);
        return;
      }
      preserveFocus=false;
      const receivedAt=performance.timeOrigin+performance.now();
      pendingNewTab={requestId:message.request_id??0,startedAt:Number.isFinite(message.started_at)&&message.started_at<=receivedAt?message.started_at:receivedAt,
        elevated:message.elevated===true,project:message.project,command:message.command,prompt:message.prompt,images:message.images,receivedAt,sentAt:null,focusOrigin:parent.document.activeElement,panes:new Set((latest.panes||[]).filter(pane=>!pane.is_plugin).map(pane=>pane.pane_id)),disabled:window.term.options.disableStdin};
      pendingNewTab.panes.add(latest.active_pane.pane_id);
      window.term.options.disableStdin=true;
      pendingNewTab.timeout=setTimeout(()=>releaseNewTab('timeout'),30000);
      sendPendingNewTab();
    }
  });
})();
