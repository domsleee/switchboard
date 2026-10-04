const $ = id => document.getElementById(id);
fetch('/api/health',{cache:'no-store'}).then(response=>response.ok?response.json():null).then(build=>{
  if(build&&/^[a-f0-9]{7,40}$/.test(build.commit)&&/^\d{4}-\d{2}-\d{2}$/.test(build.commit_date))
    $('build-version').textContent=`${build.commit} · ${build.commit_date}`;
}).catch(()=>{});
const hosts = new Map(), sessions = new Map();
const tabButtons=new Map();
const mobileSidebar=matchMedia("(max-width:700px)");
let sidebarCollapsed=localStorage.getItem("switchboard-sidebar-collapsed")==="true",sidebarOpen=false;
let filter = 'all', selected = requestedTab(), restoringTab=!!selected, loading = false, dragging = false;
const dragType='application/x-zellij-switchboard-tab';
let dragState=null, dragScrollFrame=0, suppressTabClickUntil=0;
function load(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (_) { return {}; } }
const groups = load('switchboard-groups');
const ready = load('switchboard-ready');
const archived = load('switchboard-archived');
if(restoringTab&&archived[selected]){delete archived[selected];localStorage.setItem('switchboard-archived',JSON.stringify(archived));}
const seenAttention = load('switchboard-attention-seen');
let paneAttention=new Map(),tabCatalog=[],attentionErrors=[],attentionLoading=false,attentionRefreshPending=false;
let contextItem = null, archiveSignature = null;
let tabOrder=load('switchboard-tab-order');
if(!Array.isArray(tabOrder))tabOrder=[];
let nativeTabs = localStorage.getItem('switchboard-native-tabs') === 'true';
function updateNativeTabs() {
  $('native-tabs').setAttribute('aria-pressed',String(nativeTabs));
  $('native-tabs').classList.toggle('selected',nativeTabs);
  for (const entry of sessions.values()) entry.frame.contentWindow.postMessage({type:'zellij-native-tabs',visible:nativeTabs},location.origin);
}
function saveReady() { localStorage.setItem('switchboard-ready', JSON.stringify(ready)); }
function setStatus(message,isError=false) {
  $('status').textContent=message;$('status').classList.toggle('has-error',isError);
  $('notifications').title=`${$('notifications').textContent}\n${message}`;
}
function requestedTab(){
  const query=new URLSearchParams(location.search),host=query.get('host'),session=query.get('session'),kind=query.has('tab')?'tab':'pane',id=query.get(kind);
  return host&&session&&/^\d+$/.test(id||'')&&Number(id)<=0xffffffff?JSON.stringify([host,session,kind,Number(id)]):null;
}
function waitingForRequestedTab(){
  if(!selected)return false;
  const [host,name]=JSON.parse(selected),machine=hosts.get(host),entry=sessions.get(sessionKey(host,name));
  // An unavailable host or scan is not evidence that the selected tab closed.
  if(machine?.error)return true;
  if(machine?.sessions&&!machine.sessions.some(session=>session.name===name))return false;
  if(catalogUnavailable(host,name))return true;
  if(!restoringTab)return false;
  if(!machine)return hosts.size===0&&loading;
  return machine.connecting||!!entry&&(!entry.state||!entry.catalog?.length);
}
function catalogUnavailable(host,session){
  return attentionErrors.some(error=>(error.host==='Switchboard'||error.host===host)&&(!error.session||error.session===session));
}
function updateTabUrl(item){
  if(!item&&(restoringTab||waitingForRequestedTab()))return;
  if(item?.tab.pending&&!Number.isInteger(item.tab.id))return;
  const url=new URL(location.href);
  for(const key of ['host','session','tab','pane'])url.searchParams.delete(key);
  if(item){url.searchParams.set('host',item.entry.host);url.searchParams.set('session',item.entry.name);url.searchParams.set(item.tab.pending?'pane':'tab',item.tab.id);}
  if(url.href!==location.href)history.replaceState(null,'',url);
}
function sessionKey(host, name) { return JSON.stringify([host, name]); }
function tabKey(entry, tab) { return JSON.stringify([entry.host, entry.name, tab.pending?'pane':'tab', tab.id]); }
function sessionTabs(entry){return [...(entry.catalog||[]),...(entry.provisionalTabs||[]),...(entry.creatingTab?[entry.creatingTab]:[])];}
function updateCreatedTabs(entry){
  const state=entry.state,active=state?.active_pane,creating=entry.creatingTab;
  if(state?.session_name!==entry.name)return;
  const requested=selected&&JSON.parse(selected);
  let paneId;
  if(creating&&active&&!active.is_plugin&&!entry.pendingNewTab?.paneIds?.has(active.pane_id))paneId=active.pane_id;
  else if(requested?.[0]===entry.host&&requested[1]===entry.name&&requested[2]==='pane'&&Number.isInteger(requested[3]))paneId=requested[3];
  if(Number.isInteger(paneId)&&state.panes?.some(p=>!p.is_plugin&&p.pane_id===paneId)){
    entry.provisionalTabs??=[];
    if(!entry.provisionalTabs.some(tab=>tab.id===paneId))entry.provisionalTabs.push({id:paneId,pending:true,name:'New tab',panes:[]});
    if(creating){
      if(selected===tabKey(entry,creating))selected=tabKey(entry,entry.provisionalTabs.find(tab=>tab.id===paneId));
      entry.creatingTab=null;entry.pendingNewTab=null;entry.followActiveTab=false;
    }
  }
  // Native control messages arrive before the slower attention scanner. Pane
  // identity lets the new terminal appear and reconnect without inventing a tab ID.
  entry.provisionalTabs=(entry.provisionalTabs||[]).filter(tab=>{
    const pane=state.panes?.find(p=>!p.is_plugin&&p.pane_id===tab.id);
    if(!pane)return false;
    tab.position=pane.tab_position;
    tab.name=state.tabs?.find(t=>t.position===pane.tab_position)?.name||'New tab';
    tab.panes=state.panes.filter(p=>p.tab_position===pane.tab_position);
    return true;
  });
  if(entry.provisionalTabs.length)setCatalog(entry,entry.catalog||[]);
}
function tabPanes(entry,tab){
  return (entry.state?.panes||[]).filter(p=>p.tab_position===tab.position && tab.panes.some(native=>native.pane_id===p.pane_id&&native.is_plugin===p.is_plugin));
}
function tabTitle(item){
  const live=tabPanes(item.entry,item.tab);
  const panes=item.tab.panes.map(p=>({...p,...live.find(current=>current.pane_id===p.pane_id&&current.is_plugin===p.is_plugin),tab_position:item.tab.position}));
  return SwitchboardTitles.tabTitle({panes,active_pane:item.entry.state?.active_pane},item.tab);
}
function activeTab(entry){
  const active=entry.state?.active_pane;
  return sessionTabs(entry).find(tab=>tab.position===active?.tab_position&&tab.panes.some(p=>p.pane_id===active.pane_id&&p.is_plugin===active.is_plugin));
}
function setCatalog(entry,tabs){
  // Carry browser preferences from the earlier pane keys to native tab IDs.
  const migrations=new Map();
  for(const tab of tabs)for(const pane of tab.panes){
    migrations.set(JSON.stringify([entry.host,entry.name,pane.pane_id,pane.is_plugin]),tabKey(entry,tab));
    if(!pane.is_plugin)migrations.set(JSON.stringify([entry.host,entry.name,'pane',pane.pane_id]),tabKey(entry,tab));
  }
  let changed=false;
  for(const store of [ready,archived])for(const [old,key] of migrations)if(old in store){store[key]=store[old];delete store[old];changed=true;}
  if(migrations.has(selected)){selected=migrations.get(selected);changed=true;}
  if(tabOrder.some(key=>migrations.has(key))){tabOrder=[...new Set(tabOrder.map(key=>migrations.get(key)||key))];changed=true;}
  if(changed){saveReady();localStorage.setItem('switchboard-archived',JSON.stringify(archived));localStorage.setItem('switchboard-tab-order',JSON.stringify(tabOrder));}
  entry.catalog=tabs;
  entry.provisionalTabs=entry.provisionalTabs?.filter(tab=>!migrations.has(tabKey(entry,tab)));
  // Keep confirmed closes hidden through snapshots taken before the close finished.
  for(const [id,closing] of entry.closingTabs||[])if(closing.session!==entry.name||!closing.pending&&!tabs.some(tab=>tab.id===id))entry.closingTabs.delete(id);
  syncActiveTab(entry);
}
function syncActiveTab(entry){
  const tab=activeTab(entry);
  if(!tab||entry.requestedPane||entry.focusPending)return;
  if(entry.pendingNewTab){
    if(entry.creatingTab)return;
    if(entry.pendingNewTab.has(tabKey(entry,tab)))return;
    entry.pendingNewTab=null;entry.followActiveTab=false;
    if(filter!=='all'&&groups[entry.host]!==filter)setFilter('all');$('tab-search').value='';selected=tabKey(entry,tab);entry.needsFocus=true;
  }else if(entry.followActiveTab&&entry.frame.classList.contains('active')){selected=tabKey(entry,tab);entry.followActiveTab=false;}
}
function attentionKey(host,session,pane){return JSON.stringify([host,session,pane]);}
function statesForTab(item){
  return item.tab.panes.filter(p=>!p.is_plugin)
    .map(p=>paneAttention.get(attentionKey(item.entry.host,item.entry.name,p.pane_id))).filter(Boolean);
}
function needsAttention(state){
  return ['approval','input'].includes(state.state) || (state.state==='ready'&&seenAttention[state.key]!==state.token);
}
function autoLabel(item){
  const states=statesForTab(item);
  if(states.some(s=>s.state==='approval'))return 'Approval needed';
  if(states.some(s=>s.state==='input'))return 'Input needed';
  if(states.some(s=>s.state==='working'))return 'Working';
  if(states.some(s=>s.state==='ready'))return states.some(needsAttention)?'Ready to review':'Ready';
  return '';
}
function acknowledgeAttention(item){
  let changed=false;
  for(const state of statesForTab(item))if(state.state==='ready'&&seenAttention[state.key]!==state.token){seenAttention[state.key]=state.token;changed=true;}
  if(changed)localStorage.setItem('switchboard-attention-seen',JSON.stringify(seenAttention));
}
function isReady(item){return !!(ready[item.key] || item.tab.name.startsWith('*') || statesForTab(item).some(needsAttention));}
function matchesSearch(item){
  const query=$('tab-search').value.trim().toLowerCase();
  return !query || `${tabTitle(item)} ${hosts.get(item.entry.host)?.name || item.entry.host} ${groups[item.entry.host]||''} ${item.entry.name} ${autoLabel(item)}`.toLowerCase().includes(query);
}
function allTabs(ignoreFilter=false, includeArchived=false) {
  const ranks=new Map(tabOrder.map((key,index)=>[key,index]));
  return [...sessions.values()].flatMap(entry => (entry.state ? sessionTabs(entry) : []).map(tab => ({entry,tab,key:tabKey(entry,tab)})))
    .filter(({entry,tab,key}) => !entry.closingTabs?.has(tab.id) && (includeArchived || !archived[key]) && (ignoreFilter || filter === 'all' || groups[entry.host] === filter))
    .sort((a,b) => (ranks.get(a.key)??Infinity)-(ranks.get(b.key)??Infinity));
}
function moveTab(key,targetKey,after=false) {
  if(key===targetKey)return;
  const tabs=allTabs(true,true),source=tabs.find(t=>t.key===key),target=tabs.find(t=>t.key===targetKey);
  if(!source||!target)return;
  // A missing host or catalog is temporary; retain its saved positions when another tab moves.
  const order=[...new Set([...tabOrder,...tabs.map(t=>t.key)])];
  order.splice(order.indexOf(key),1);
  order.splice(order.indexOf(targetKey)+(after?1:0),0,key);
  tabOrder=order;localStorage.setItem('switchboard-tab-order',JSON.stringify(tabOrder));render();
  tabButtons.get(key)?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function moveSelected(direction) {
  const tabs=allTabs().filter(matchesSearch),index=tabs.findIndex(t=>t.key===selected),target=tabs[index+direction];
  if(index<0||!target)return;
  moveTab(selected,target.key,direction>0);
}
function render() {
  // Live metadata arrives while dragging; keep the source element mounted.
  if(dragging)return;
  const tabs = allTabs();
  const previous = selected,wasRestoring=restoringTab;
  if(tabs.some(t=>t.key===selected))restoringTab=false;
  else if(!waitingForRequestedTab()){restoringTab=false;selected=tabs[0]?.key||null;}
  const liveKeys=new Set(tabs.map(item=>item.key));
  for(const [key,button] of tabButtons)if(!liveKeys.has(key)){button.remove();tabButtons.delete(key);}
  const shown=tabs.filter(matchesSearch), nodes=[],shownKeys=new Set(shown.map(item=>item.key));
  for (const item of shown) {
    let button=tabButtons.get(item.key);
    if(!button){
      button=document.createElement('button');button.draggable=true;
      const star=document.createElement('span');star.className='star';star.textContent='●';star.title='Needs attention';star.setAttribute('aria-label','Needs attention');
      const name=document.createElement('span');name.className='tab-name';
      const label=document.createElement('small');button.append(star,name,label);
      button.ondragstart=event=>{
        dragging=true;
        dragState={key:button._item.key,clientY:event.clientY,target:null};
        event.dataTransfer.setData(dragType,dragState.key);event.dataTransfer.effectAllowed='move';
        button.classList.add('dragging');$('tabs').classList.add('reordering');
      };
      button.ondragend=finishDrag;
      button.oncontextmenu=event=>{event.preventDefault();openTabMenu(button._item,event.clientX,event.clientY);};
      button.onclick=()=>{if(dragging||Date.now()<suppressTabClickUntil)return;activate(button._item);};
      tabButtons.set(item.key,button);
    }
    button._item=item;
    button.draggable=!item.tab.pending||Number.isInteger(item.tab.id);
    const title=tabTitle(item);
    button.title=`${title}\nDrag to reorder · Alt+Shift+H/L moves this tab · Right-click to archive or close`;
    const starred = isReady(item);
    button.className = (item.key === selected ? 'selected' : '')+(starred?' needs-attention':'');
    button.setAttribute('aria-pressed',String(item.key===selected));
    button.children[0].hidden=!starred;
    if(button.children[1].textContent!==title)button.children[1].textContent=title;
    const stateLabel=autoLabel(item);
    const subtitle=`${hosts.get(item.entry.host)?.name || item.entry.host} · ${item.entry.name}${stateLabel?' · '+stateLabel:''}`;
    button.dataset.agentState=stateLabel;
    if(button.children[2].textContent!==subtitle)button.children[2].textContent=subtitle;
    nodes.push(button);
  }
  for(const button of tabButtons.values())if(!shownKeys.has(button._item.key))button.remove();
  let cursor=$('tabs').firstChild;
  for(const node of nodes){if(node!==cursor)$('tabs').insertBefore(node,cursor);else cursor=cursor.nextSibling;}
  $('tab-count').textContent=`${shown.length}${shown.length!==tabs.length?' / '+tabs.length:''} tabs`;
  $('tab-no-results').hidden=shown.length>0;

  const current=tabs.find(t=>t.key===selected);
  updateTabUrl(current);
  const notifications=allTabs(true,true).filter(isReady).length;
  $('notifications').textContent=`${notifications} notification${notifications===1?'':'s'}`;
  $('notifications').classList.toggle('has-notifications',notifications>0);
  document.title=`${notifications?'('+notifications+') ':''}`+(current?`${tabTitle(current)} · ${hosts.get(current.entry.host)?.name} · Switchboard`:'Switchboard');
  const currentEntry=current?.entry||(waitingForRequestedTab()?sessions.get(sessionKey(...JSON.parse(selected).slice(0,2))):null);
  for (const entry of sessions.values()) entry.frame.classList.toggle('active',entry===currentEntry);
  const selecting=!!current?.entry.frame.contentWindow.SwitchboardClipboard?.selectionMode;
  $('select-text').setAttribute('aria-pressed',String(selecting));
  $('select-text').classList.toggle('selected',selecting);
  $('select-text').disabled=!current;
  $('copy').disabled=!current;
  $('ready').disabled=!current||current.tab.pending&&!Number.isInteger(current.tab.id);
  const viewport=current?.entry.state?.tab_viewport;
  const sizeOwner=$('size-owner');
  const focused=current && activeTab(current.entry)?.id===current.tab.id && !current.entry.requestedPane && !current.entry.focusPending && !current.entry.pendingNewTab;
  sizeOwner.disabled=!focused || !viewport || !current.entry.frame.contentWindow.__zjSupportsTabViewport;
  sizeOwner.setAttribute('aria-pressed',String(!!viewport?.is_owner));
  sizeOwner.textContent=viewport?.is_owner?'Using this window’s size':'Use this window’s size';
  sizeOwner.title=!viewport?'Available in new sessions after updating Switchboard.':viewport.constrained?'A smaller plain terminal is keeping this tab within its screen.':'The last focused browser window sets the size. Smaller browser viewers can scroll, starting at the bottom.';
  const archiveCount=allTabs(true,true).filter(item=>archived[item.key]).length;
  $('archive').textContent=`Archive${archiveCount?' ('+archiveCount+')':''}`;
  if($('archive-dialog').open)renderArchive();
  if(!current){$('artifact-preview').hidden=true;$('artifact-frame').src='about:blank';}
  $('empty').hidden=!!current;
  if (!current) $('empty').textContent=restoringTab?'Connecting to the requested terminal…':filter==='all'?(archiveCount?'All tabs are archived. Open Archive to restore one.':'No connected tabs. Open Settings to check your machines or refresh.'):`No ${filter} tabs. Assign machines to this group in Settings.`;
  const errors=[...hosts.values()].filter(h=>h.error).map(h=>`${h.name}: ${h.error}`);
  for(const entry of sessions.values())if(entry.closeError)errors.push(entry.closeError);
  for(const error of attentionErrors)errors.push(`${hosts.get(error.host)?.name||error.host}: attention status unavailable`);
  setStatus(errors.length?errors.join(' · '):`${hosts.size} machines · ${tabs.length} tabs${current?' · '+hosts.get(current.entry.host)?.name:''}`,errors.length>0);
  if ((selected !== previous || wasRestoring&&!restoringTab) && current) focus(current,true);
  if(selected!==previous) $('tabs').querySelector('.selected')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function updateDragTarget() {
  if(!dragState)return;
  const strip=$('tabs'),bounds=strip.getBoundingClientRect();
  const candidates=[...strip.children].filter(button=>button._item&&button._item.key!==dragState.key);
  const next=candidates.find(button=>{const rect=button.getBoundingClientRect();return dragState.clientY<rect.top+rect.height/2;});
  const target=next||candidates.at(-1);
  if(!target){dragState.target=null;strip.classList.remove('drop-target');return;}
  const after=!next,rect=target.getBoundingClientRect();
  dragState.target={key:target._item.key,after};
  strip.style.setProperty('--drop-top',`${(after?rect.bottom+1:rect.top-2)-bounds.top+strip.scrollTop}px`);
  strip.classList.add('drop-target');
}
function scrollDuringDrag() {
  dragScrollFrame=0;
  if(!dragState||!$('tabs').classList.contains('drop-target'))return;
  const strip=$('tabs'),bounds=strip.getBoundingClientRect(),edge=36;
  const top=Math.max(0,edge-(dragState.clientY-bounds.top));
  const bottom=Math.max(0,edge-(bounds.bottom-dragState.clientY));
  strip.scrollTop+=Math.max(-14,Math.min(14,(bottom-top)/3));
  updateDragTarget();
  dragScrollFrame=requestAnimationFrame(scrollDuringDrag);
}
$('tabs').addEventListener('dragover',event=>{
  if(!dragState||!event.dataTransfer.types.includes(dragType))return;
  event.preventDefault();event.dataTransfer.dropEffect='move';dragState.clientY=event.clientY;
  updateDragTarget();if(!dragScrollFrame)dragScrollFrame=requestAnimationFrame(scrollDuringDrag);
});
$('tabs').addEventListener('dragleave',event=>{
  if(event.relatedTarget&&$('tabs').contains(event.relatedTarget))return;
  $('tabs').classList.remove('drop-target');cancelAnimationFrame(dragScrollFrame);dragScrollFrame=0;
});
$('tabs').addEventListener('drop',event=>{
  if(!dragState||!event.dataTransfer.types.includes(dragType))return;
  event.preventDefault();dragState.clientY=event.clientY;updateDragTarget();
  const {key,target}=dragState;
  finishDrag();if(target)moveTab(key,target.key,target.after);
});
function finishDrag(){
  if(!dragging)return;
  dragging=false;dragState=null;suppressTabClickUntil=Date.now()+250;
  cancelAnimationFrame(dragScrollFrame);dragScrollFrame=0;
  $('tabs').classList.remove('reordering','drop-target');
  for(const button of tabButtons.values())button.classList.remove('dragging');
  render();
}
window.addEventListener('dragend',finishDrag,true);
window.addEventListener('drop',()=>setTimeout(finishDrag,0),true);
window.addEventListener('blur',finishDrag);
window.addEventListener('focus',()=>{
  const current=allTabs().find(item=>item.key===selected);
  if(current&&document.hasFocus())current.entry.frame.contentWindow.postMessage({type:'zellij-window-focus'},location.origin);
});
function focus(item,background=false) {
  const activeElement=document.activeElement;
  if(background&&(document.hidden||!document.hasFocus()||!$('artifact-preview').hidden||document.querySelector('dialog[open]')||activeElement&&activeElement!==document.body&&activeElement!==item.entry.frame)){
    item.entry.needsFocus=true;return;
  }
  // A polling retry must not blur/disable a terminal while its control socket
  // lacks current metadata. The next native state performs the reconnect focus.
  if(item.entry.disconnected){item.entry.needsFocus=true;return;}
  if(item.entry.pendingNewTab||item.tab.pending&&!item.tab.panes.length)return;
  item.entry.needsFocus=false;
  $('artifact-preview').hidden=true;
  $('artifact-frame').src='about:blank';
  const active=item.entry.state.active_pane;
  const panes=tabPanes(item.entry,item.tab);
  const pane=panes.find(p=>p.pane_id===active?.pane_id && p.is_plugin===active?.is_plugin)||panes[0];
  if(!pane){item.entry.needsFocus=true;setStatus('Waiting for terminal metadata…');return;}
  if(active?.pane_id!==pane.pane_id||active?.is_plugin!==pane.is_plugin)item.entry.frame.contentWindow.SwitchboardClipboard?.clearSelection();
  const focusId=item.entry.focusId=(item.entry.focusId||0)+1;
  if(item.entry.requestedPane || active?.pane_id!==pane.pane_id||active?.is_plugin!==pane.is_plugin)item.entry.requestedPane={pane_id:pane.pane_id,is_plugin:pane.is_plugin,focus_id:focusId};
  item.entry.frame.contentWindow.postMessage({type:'zellij-focus',pane_id:pane.pane_id,is_plugin:pane.is_plugin,focus_id:focusId},location.origin);
}
function activate(item, clear=true) {
  selected=item.key;restoringTab=false;item.entry.followActiveTab=false;
  if(mobileSidebar.matches){sidebarOpen=false;updateSidebar();}
  if(clear){delete ready[item.key];saveReady();}
  item.entry.acknowledgeTab=item.key;
  render();
  focus(item);
  tabButtons.get(item.key)?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function stepTab(direction) {
  const tabs=allTabs().filter(matchesSearch);
  if(!tabs.length)return;
  const index=tabs.findIndex(t=>t.key===selected);
  activate(tabs[(Math.max(index,0)+direction+tabs.length)%tabs.length]);
}
function closeSelectedTab(){
  const item=allTabs().find(item=>item.key===selected);
  if(!item||document.querySelector('dialog[open]')||!$('artifact-preview').hidden)return;
  if(item.entry.requestedPane||item.entry.focusPending||item.entry.followActiveTab){setStatus('Wait for the selected terminal to receive focus.',true);return;}
  contextItem=item;
  $('close-tab').click();
}
window.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey&&event.code==='KeyK'&&!document.querySelector('dialog[open]')){event.preventDefault();showTabSearch();return;}
  if(event.key==='Escape'&&event.target===$('tab-search')){
    event.preventDefault();
    if($('tab-search').value){$('tab-search').value='';render();}else{sidebarOpen=false;updateSidebar();allTabs().find(item=>item.key===selected)?.entry.frame.focus();}
    return;
  }
  if(event.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
  if(document.querySelector('dialog[open]'))return;
  if(event.code==='KeyT'&&(event.ctrlKey!==event.metaKey)&&event.altKey&&!event.shiftKey&&!event.isComposing){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)$('new-tab').click();return;}
  if(event.code==='KeyD'&&event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&!event.isComposing){
    event.preventDefault();event.stopImmediatePropagation();
    if(!event.repeat)closeSelectedTab();
    return;
  }
  if(!$('tab-menu').hidden && event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeTabMenu();return;}
  if(event.key==='Escape'&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){
    if(mobileSidebar.matches&&sidebarOpen){event.preventDefault();sidebarOpen=false;updateSidebar();return;}
    if(!$('artifact-preview').hidden){event.preventDefault();$('artifact-back').click();return;}
    const current=allTabs().find(item=>item.key===selected);
    if(current){event.preventDefault();event.stopImmediatePropagation();current.entry.frame.contentWindow.postMessage({type:'zellij-escape'},location.origin);current.entry.frame.focus();}
    return;
  }
  if(!event.altKey||event.ctrlKey||event.metaKey)return;
  const direction=event.code==='KeyH'?-1:event.code==='KeyL'?1:0;
  if(!direction)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.shiftKey)moveSelected(direction);else stepTab(direction);
},true);
function renderMachines() {
  const container=$('machines'),rows=new Map([...container.children].map(label=>[label.dataset.host,label])),nodes=[];
  for(const host of hosts.values()) {
    let label=rows.get(host.id);
    if(!label){
      label=document.createElement('label');label.dataset.host=host.id;label.append(document.createTextNode(host.name));
      const select=document.createElement('select');
      for(const [value,text] of [['','Ungrouped'],['work','Work'],['home','Home']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
      select.onchange=()=>{groups[host.id]=select.value;localStorage.setItem('switchboard-groups',JSON.stringify(groups));render();};label.append(select);
    }
    const select=label.lastElementChild;
    if(label.firstChild.textContent!==host.name)label.firstChild.textContent=host.name;
    select.setAttribute('aria-label',`${host.name} group`);
    if(select.value!==(groups[host.id]||''))select.value=groups[host.id]||'';
    nodes.push(label);rows.delete(host.id);
  }
  for(const label of rows.values())label.remove();
  let cursor=container.firstChild;
  for(const label of nodes){if(label!==cursor)container.insertBefore(label,cursor);else cursor=cursor.nextSibling;}
}
async function refresh() {
  if(loading)return;loading=true;
  try {
    const response=await fetch('/api/hosts?summary=1');if(!response.ok)throw Error('Cannot reach local relay');
    const data=await response.json();
    for(const host of data)hosts.set(host.id,{...hosts.get(host.id),...host,connecting:true});
    await Promise.all(data.map(async summary=>{
      try{
        const response=await fetch(`/api/hosts/${encodeURIComponent(summary.id)}`);if(!response.ok)throw Error('Cannot list sessions');
        const host=await response.json();hosts.set(host.id,host);
        for(const session of host.sessions||[]) {
          if(!session.web_clients_allowed)continue;
          const key=sessionKey(host.id,session.name);
          if(sessions.has(key))continue;
          const frame=document.createElement('iframe');frame.title=`${host.name}: ${session.name}`;
          frame.src=`/hosts/${encodeURIComponent(host.id)}/${encodeURIComponent(session.name)}`;
          frame.allow='clipboard-read; clipboard-write';
          const entry={host:host.id,name:session.name,frame,state:null};sessions.set(key,entry);setCatalog(entry,tabCatalog.filter(tab=>tab.host===entry.host&&tab.session===entry.name));$('terminals').append(frame);
        }
        if(!host.error) for(const [key,entry] of sessions) {
          if(entry.host===host.id&&!host.sessions.some(s=>s.name===entry.name)) {entry.frame.remove();sessions.delete(key);}
        }
      }catch(error){hosts.set(summary.id,{...hosts.get(summary.id),connecting:false,error:error.message});}
      renderMachines();render();
    }));
  }catch(error){setStatus(error.message,true);}finally{loading=false;}
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin)return;
  const entry=[...sessions.values()].find(e=>e.frame.contentWindow===event.source);
  if(!entry)return;
  if(event.data?.type==='zellij-state') {
    entry.disconnected=false;
    const previousPosition=entry.state?.active_pane?.tab_position;
    const previousPane=entry.state?.active_pane;
    entry.state=event.data.payload;
    updateCreatedTabs(entry);
    if(previousPane && (previousPane.pane_id!==entry.state.active_pane?.pane_id || previousPane.is_plugin!==entry.state.active_pane?.is_plugin))entry.frame.contentWindow.SwitchboardClipboard?.clearSelection();
    entry.focusPending=!!event.data.focus_pending;
    if(entry.requestedPane){
      const active=entry.state.active_pane,requested=entry.requestedPane;
      if(!event.data.focus_pending && event.data.focus_id===requested.focus_id && active?.pane_id===requested.pane_id&&active?.is_plugin===requested.is_plugin)entry.requestedPane=null;
    }
    entry.frame.contentWindow.postMessage({type:'zellij-native-tabs',visible:nativeTabs},location.origin);
    // A client can switch sessions using native Zellij controls; follow its metadata.
    if(entry.name!==entry.state.session_name){
      sessions.delete(sessionKey(entry.host,entry.name));
      entry.name=entry.state.session_name;setCatalog(entry,tabCatalog.filter(tab=>tab.host===entry.host&&tab.session===entry.name));entry.followActiveTab=entry.frame.classList.contains('active');
      const key=sessionKey(entry.host,entry.name), duplicate=sessions.get(key);
      if(duplicate&&duplicate!==entry)duplicate.frame.remove();
      sessions.set(key,entry);
    }
    if(!entry.needsFocus && !entry.requestedPane && !entry.focusPending && entry.frame.classList.contains('active') && previousPane && (previousPosition!==entry.state.active_pane?.tab_position||previousPane.pane_id!==entry.state.active_pane?.pane_id||previousPane.is_plugin!==entry.state.active_pane?.is_plugin)){
      const tab=activeTab(entry);
      if(tab){selected=tabKey(entry,tab);delete ready[selected];saveReady();entry.followActiveTab=false;}else entry.followActiveTab=true;
    }
    // Catalog and native focus arrive independently. Resolve creation on either
    // arrival and scan immediately instead of leaving the old tab highlighted.
    syncActiveTab(entry);
    if(entry.pendingNewTab&&!activeTab(entry))refreshAttention(true);
    const current=allTabs().find(item=>item.key===selected);
    if(current?.entry===entry && entry.acknowledgeTab===selected && !entry.requestedPane && !entry.focusPending && activeTab(entry)?.id===current.tab.id){acknowledgeAttention(current);entry.acknowledgeTab=null;}
    render();
    if(entry.needsFocus && entry.frame.classList.contains('active')){
      const current=allTabs().find(item=>item.key===selected);if(current)focus(current,true);
    }
  }else if(event.data?.type==='zellij-focus-failed'){
    if(entry.requestedPane?.focus_id!==event.data.focus_id)return;
    entry.requestedPane=null;
    if(!entry.frame.classList.contains('active'))return;
    const state=event.data.payload || entry.state;
    entry.state=state;const tab=activeTab(entry);
    if(tab){selected=tabKey(entry,tab);render();focus({entry,tab});}
    setStatus('That terminal is unavailable. Choose another tab.',true);
  }else if(event.data?.type==='zellij-open-new-tab'){
    if(entry.frame.classList.contains('active')&&!document.querySelector('dialog[open]'))$('new-tab').click();
  }else if(event.data?.type==='zellij-close-tab'){
    if(entry.frame.classList.contains('active'))closeSelectedTab();
  }else if(event.data?.type==='zellij-tab-search'){
    if(entry.frame.classList.contains('active'))showTabSearch();
  }else if(event.data?.type==='zellij-tab-step' && (event.data.direction===-1||event.data.direction===1)){
    if(entry.frame.classList.contains('active'))stepTab(event.data.direction);
  }else if(event.data?.type==='zellij-tab-move' && (event.data.direction===-1||event.data.direction===1)){
    if(entry.frame.classList.contains('active'))moveSelected(event.data.direction);
  }else if(event.data?.type==='zellij-open-link'){
    if(!entry.frame.classList.contains('active'))return;
    try{
      const url=new URL(event.data.uri);
      if(!['http:','https:','mailto:'].includes(url.protocol))return;
      const link=document.createElement('a');
      link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.click();
    }catch(_){setStatus('Invalid artifact link.',true);}
  }else if(event.data?.type==='zellij-clipboard'){
    setStatus(event.data.ok?'Copied to this browser.':event.data.error||'Copy failed; use the terminal’s clipboard panel.',!event.data.ok);
  }else if(event.data?.type==='zellij-disconnected'){entry.disconnected=true;entry.needsFocus=true;setStatus(`${hosts.get(entry.host)?.name}: reconnecting…`,true);}
});
$('artifact-back').onclick=()=>{const current=allTabs().find(item=>item.key===selected);if(current)focus(current);else $('artifact-preview').hidden=true;};
$('select-text').onclick=()=>{
  const current=allTabs().find(item=>item.key===selected),api=current?.entry.frame.contentWindow.SwitchboardClipboard;
  if(!api)return;
  const selecting=api.setSelectionMode(!api.selectionMode);
  $('select-text').setAttribute('aria-pressed',String(selecting));
  $('select-text').classList.toggle('selected',selecting);
  if(selecting)setStatus('Drag over terminal text, then Copy or Cmd+C / Ctrl+Shift+C.');
  current.entry.frame.focus();
};
$('copy').onclick=async()=>{
  const current=allTabs().find(item=>item.key===selected);
  const api=current?.entry.frame.contentWindow.SwitchboardClipboard;
  if(!api){setStatus('Terminal clipboard is unavailable; refresh this page.',true);return;}
  const result=await api.copySelection();
  setStatus(result.ok?'Copied to this browser.':result.error||'Nothing selected. Select terminal text first.',!result.ok);
};
function setFilter(value){filter=value;for(const b of $('filters').children)b.classList.toggle('selected',b.dataset.filter===value);render();}
$('filters').onclick=event=>{const button=event.target.closest('[data-filter]');if(button)setFilter(button.dataset.filter);};
$('new-tab').onclick=()=>{
  const select=$('new-tab-target');select.replaceChildren();
  const current=allTabs().find(t=>t.key===selected)?.entry;
  for(const [key,entry] of sessions){
    if(!entry.state||!entry.catalog?.length)continue;
    const option=document.createElement('option');option.value=key;option.textContent=`${hosts.get(entry.host)?.name} · ${entry.name}`;option.selected=entry===current;select.append(option);
  }
  if(!select.options.length){setStatus('Connect to a session before creating a tab.',true);return;}
  $('new-tab-dialog').showModal();
};
$('cancel-new-tab').onclick=()=>$('new-tab-dialog').close();
const newTabDialog=$('new-tab-dialog');
let newTabBackdropPressed=false;
function outsideNewTab(event){
  const bounds=newTabDialog.getBoundingClientRect();
  return event.target===newTabDialog&&(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom);
}
newTabDialog.onpointerdown=event=>{newTabBackdropPressed=outsideNewTab(event);};
newTabDialog.onclick=event=>{if(newTabBackdropPressed&&outsideNewTab(event))newTabDialog.close();newTabBackdropPressed=false;};
$('new-tab-form').onsubmit=event=>{
  event.preventDefault();const entry=sessions.get($('new-tab-target').value);if(!entry?.state||!entry.catalog?.length)return;
  if(entry.pendingNewTab||entry.requestedPane||entry.focusPending){setStatus('Wait for the terminal to receive focus before creating a tab.',true);return;}
  const pending=entry.pendingNewTab=new Set(sessionTabs(entry).map(tab=>tabKey(entry,tab)));
  pending.paneIds=new Set((entry.state.panes||[]).filter(p=>!p.is_plugin).map(p=>p.pane_id));
  if(entry.state.active_pane&&!entry.state.active_pane.is_plugin)pending.paneIds.add(entry.state.active_pane.pane_id);
  entry.creatingTab={id:'creating',pending:true,name:'Creating tab…',position:Infinity,panes:[]};
  selected=tabKey(entry,entry.creatingTab);
  restoringTab=false;entry.followActiveTab=true;
  if(filter!=='all'&&groups[entry.host]!==filter)setFilter('all');$('tab-search').value='';
  sidebarOpen=false;updateSidebar();$('artifact-preview').hidden=true;$('artifact-frame').src='about:blank';
  $('new-tab-dialog').close();render();
  entry.frame.contentWindow.postMessage({type:'zellij-new-tab'},location.origin);
  setStatus(`Creating a tab on ${hosts.get(entry.host)?.name}…`);
  setTimeout(()=>{if(entry.pendingNewTab===pending){const waiting=selected===tabKey(entry,entry.creatingTab);entry.pendingNewTab=null;entry.creatingTab=null;entry.followActiveTab=false;if(waiting){const active=activeTab(entry);selected=active?tabKey(entry,active):null;}render();setStatus('No new tab received. Check the connection and try again.',true);}},30000);
};
$('ready').onclick=()=>{
  if(!selected)return;
  ready[selected]=Date.now();saveReady();
  render();
};
$('settings').onclick=()=>$('settings-dialog').showModal();
$('size-owner').onclick=()=>{
  const current=allTabs().find(item=>item.key===selected);
  if(!current || $('size-owner').disabled)return;
  current.entry.frame.contentWindow.postMessage({type:'zellij-size-owner',tab_position:current.tab.position,owned:true},location.origin);
};
$('close-settings').onclick=()=>$('settings-dialog').close();
$('refresh').onclick=async()=>{
  const button=$('refresh');button.disabled=true;button.textContent='Refreshing…';
  try{await refresh();}finally{button.disabled=false;button.textContent='Refresh';}
};
$('native-tabs').onclick=()=>{nativeTabs=!nativeTabs;localStorage.setItem('switchboard-native-tabs',String(nativeTabs));updateNativeTabs();};
updateNativeTabs();
refresh();setInterval(refresh,15000);

function closeTabMenu(){ $('tab-menu').hidden=true;$('close-tab').disabled=false;contextItem=null; }
function openTabMenu(item,x,y){
  contextItem=item;
  $('archive-tab').disabled=item.tab.pending&&!Number.isInteger(item.tab.id);
  $('close-tab').disabled=!!item.tab.pending;
  $('close-tab').title=item.tab.pending?'Waiting for the tab identity to finish connecting':'';
  const menu=$('tab-menu');menu.hidden=false;
  menu.style.left=`${Math.max(0,Math.min(x,innerWidth-menu.offsetWidth))}px`;
  menu.style.top=`${Math.max(0,Math.min(y,innerHeight-menu.offsetHeight))}px`;
  $('archive-tab').focus();
}
function archiveTab(item){
  archived[item.key]=Date.now();
  localStorage.setItem('switchboard-archived',JSON.stringify(archived));
  closeTabMenu();render();
  const current=allTabs().find(t=>t.key===selected);
  if(current)current.entry.frame.focus();
}
$('archive-tab').onclick=()=>{if(contextItem)archiveTab(contextItem);};
document.addEventListener('pointerdown',event=>{if(!$('tab-menu').contains(event.target))closeTabMenu();},true);
window.addEventListener('blur',closeTabMenu);
$('tabs').addEventListener('scroll',closeTabMenu);
function renderArchive(){
  const query=$('archive-search').value.trim().toLowerCase();
  const list=$('archive-list');
  const tabs=allTabs(true,true).filter(item=>archived[item.key]);
  const signature=JSON.stringify([query,tabs.map(item=>[item.key,tabTitle(item),hosts.get(item.entry.host)?.name,item.entry.name])]);
  if(signature===archiveSignature)return;
  archiveSignature=signature;list.replaceChildren();
  for(const item of tabs){
    const title=tabTitle(item);
    const machine=`${hosts.get(item.entry.host)?.name || item.entry.host} · ${item.entry.name}`;
    if(!`${title} ${machine}`.toLowerCase().includes(query))continue;
    const row=document.createElement('div');row.className='archive-row';
    const label=document.createElement('span');label.textContent=`${title} · ${machine}`;
    const restore=document.createElement('button');restore.textContent='Restore';
    restore.setAttribute('aria-label',`Restore ${title}`);
    restore.onclick=()=>{
      delete archived[item.key];localStorage.setItem('switchboard-archived',JSON.stringify(archived));
      $('archive-dialog').close();$('tab-search').value='';setFilter('all');activate(item);
      tabButtons.get(item.key)?.scrollIntoView({block:'nearest',inline:'nearest'});
      item.entry.frame.focus();
    };
    row.append(label,restore);list.append(row);
  }
  if(!list.children.length){const empty=document.createElement('p');empty.textContent=tabs.length?'No matching archived tabs.':'No archived tabs.';list.append(empty);}
}
$('archive').onclick=()=>{$('archive-search').value='';renderArchive();$('archive-dialog').showModal();$('archive-search').focus();};
$('archive-search').oninput=renderArchive;
$('close-archive').onclick=()=>$('archive-dialog').close();

function updateSidebar(){
  document.body.classList.toggle('sidebar-collapsed',sidebarCollapsed);
  document.body.classList.toggle('sidebar-open',sidebarOpen&&mobileSidebar.matches);
  const visible=mobileSidebar.matches?sidebarOpen:!sidebarCollapsed;
  $('sidebar-toggle').setAttribute('aria-expanded',String(visible));
  $('sidebar-backdrop').hidden=!(mobileSidebar.matches&&sidebarOpen);
}
function showTabSearch(){
  if(mobileSidebar.matches)sidebarOpen=true;else{sidebarCollapsed=false;localStorage.setItem('switchboard-sidebar-collapsed','false');}
  updateSidebar();$('tab-search').focus();$('tab-search').select();
}
$('sidebar-toggle').onclick=()=>{
  if(mobileSidebar.matches)sidebarOpen=!sidebarOpen;
  else{sidebarCollapsed=!sidebarCollapsed;localStorage.setItem('switchboard-sidebar-collapsed',String(sidebarCollapsed));}
  updateSidebar();
};
$('sidebar-backdrop').onclick=()=>{sidebarOpen=false;updateSidebar();};
mobileSidebar.addEventListener('change',()=>{sidebarOpen=false;updateSidebar();});
$('tab-search').oninput=render;
$('tab-search').onkeydown=event=>{if(event.key==='Enter'){const item=allTabs().filter(matchesSearch)[0];if(item){event.preventDefault();activate(item);item.entry.frame.focus();}}};
let sidebarWidth=Number(localStorage.getItem('switchboard-sidebar-width'))||260;
function setSidebarWidth(width){
  sidebarWidth=Math.max(200,Math.min(420,width,Math.max(200,innerWidth-320)));
  document.documentElement.style.setProperty('--sidebar-width',`${sidebarWidth}px`);
  $('sidebar-resize').setAttribute('aria-valuemin','200');$('sidebar-resize').setAttribute('aria-valuemax',String(Math.min(420,Math.max(200,innerWidth-320))));$('sidebar-resize').setAttribute('aria-valuenow',String(Math.round(sidebarWidth)));
}
const resizeHandle=$('sidebar-resize');
resizeHandle.onpointerdown=event=>{
  if(event.button!==0)return;
  event.preventDefault();resizeHandle.setPointerCapture(event.pointerId);document.body.classList.add('resizing');
};
resizeHandle.onpointermove=event=>{if(resizeHandle.hasPointerCapture(event.pointerId))setSidebarWidth(event.clientX-$('workspace').getBoundingClientRect().left);};
resizeHandle.onlostpointercapture=()=>{document.body.classList.remove('resizing');localStorage.setItem('switchboard-sidebar-width',String(sidebarWidth));};
resizeHandle.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setSidebarWidth(sidebarWidth+(event.key==='ArrowLeft'?-20:20));localStorage.setItem('switchboard-sidebar-width',String(sidebarWidth));}};
window.addEventListener('resize',()=>{if(!mobileSidebar.matches)setSidebarWidth(sidebarWidth);});
setSidebarWidth(sidebarWidth);updateSidebar();

async function refreshAttention(immediate=false){
  if(attentionLoading){attentionRefreshPending ||= immediate;return;}attentionLoading=true;
  try{
    const response=await fetch('/api/attention');if(!response.ok)throw Error('Attention monitor unavailable');
    const data=await response.json();
    paneAttention=new Map((data.panes||[]).map(state=>{const key=attentionKey(state.host,state.session,state.pane_id);return [key,{...state,key}];}));
    attentionErrors=data.errors||[];
    // Retain the last known catalog only for failed scans. An authoritative
    // successful empty result still removes closed tabs and sessions.
    tabCatalog=[...(data.tabs||[]).filter(tab=>!catalogUnavailable(tab.host,tab.session)),...tabCatalog.filter(tab=>catalogUnavailable(tab.host,tab.session))];
    for(const entry of sessions.values())if(!catalogUnavailable(entry.host,entry.name))setCatalog(entry,tabCatalog.filter(tab=>tab.host===entry.host&&tab.session===entry.name));
    const current=allTabs().find(item=>item.key===selected);
    if(current && document.hasFocus() && !document.hidden && $('artifact-preview').hidden && !document.querySelector('dialog[open]') && !current.entry.requestedPane && !current.entry.focusPending && activeTab(current.entry)?.id===current.tab.id)acknowledgeAttention(current);
    render();
    const selectedTab=allTabs().find(item=>item.key===selected);if(selectedTab?.entry.needsFocus)focus(selectedTab,true);
  }catch(_){paneAttention.clear();attentionErrors=[{host:'Switchboard'}];render();}
  finally{attentionLoading=false;if(attentionRefreshPending){attentionRefreshPending=false;refreshAttention();}}
}
refreshAttention();setInterval(refreshAttention,2000);
