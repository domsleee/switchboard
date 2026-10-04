const $ = id => document.getElementById(id);
fetch('/api/health',{cache:'no-store'}).then(response=>response.ok?response.json():null).then(build=>{
  if(build&&/^[a-f0-9]{7,40}$/.test(build.commit)&&/^\d{4}-\d{2}-\d{2}$/.test(build.commit_date))
    $('build-version').textContent=`${build.commit} · ${build.commit_date}`;
}).catch(()=>{});
const hosts = new Map(), sessions = new Map();
const startedHosts = new Set();
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
let contextItem = null, menuTrigger = null, archiveSignature = null;
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
  if(entry.starting&&active&&!active.is_plugin){
    paneId=active.pane_id;entry.starting=false;clearTimeout(entry.startTimeout);
    if(entry.selectOnStart){selected=JSON.stringify([entry.host,entry.name,'pane',paneId]);restoringTab=false;entry.needsFocus=true;}
  }
  else if(creating&&active&&!active.is_plugin&&!entry.pendingNewTab?.paneIds?.has(active.pane_id))paneId=active.pane_id;
  else if(requested?.[0]===entry.host&&requested[1]===entry.name&&requested[2]==='pane'&&Number.isInteger(requested[3]))paneId=requested[3];
  if(Number.isInteger(paneId)&&state.panes?.some(p=>!p.is_plugin&&p.pane_id===paneId)){
    entry.provisionalTabs??=[];
    if(!entry.provisionalTabs.some(tab=>tab.id===paneId))entry.provisionalTabs.push({id:paneId,pending:true,name:'New tab',panes:[]});
    if(creating){
      if(selected===tabKey(entry,creating))selected=tabKey(entry,entry.provisionalTabs.find(tab=>tab.id===paneId));
      entry.creatingTab=null;entry.pendingNewTab=null;entry.followActiveTab=false;
    }
  }
  if(entry.catalogUnavailable&&!entry.catalog?.length){
    entry.provisionalTabs??=[];
    for(const pane of state.panes||[]){
      if(pane.is_plugin||entry.provisionalTabs.some(tab=>state.panes.some(current=>!current.is_plugin&&current.pane_id===tab.id&&current.tab_position===pane.tab_position)))continue;
      entry.provisionalTabs.push({id:pane.pane_id,position:pane.tab_position,pending:true,fallback:true,panes:[]});
    }
  }
  // Native control messages arrive before the slower attention scanner. Pane
  // identity lets the new terminal appear and reconnect without inventing a tab ID.
  entry.provisionalTabs=(entry.provisionalTabs||[]).filter(tab=>{
    if(tab.fallback&&(!entry.catalogUnavailable||entry.catalog?.length))return false;
    const pane=state.panes?.find(p=>!p.is_plugin&&p.pane_id===tab.id);
    if(!pane)return false;
    tab.position=pane.tab_position;
    tab.name=state.tabs?.find(t=>t.position===pane.tab_position)?.name||(tab.fallback?'Terminal':'New tab');
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
  for(const [key,button] of tabButtons)if(!liveKeys.has(key)){button._row.remove();tabButtons.delete(key);}
  const shown=tabs.filter(matchesSearch), nodes=[],shownKeys=new Set(shown.map(item=>item.key));
  const titles=new Map(tabs.map(item=>[item.key,tabTitle(item)])),titleCounts=new Map();
  for(const item of tabs){const key=JSON.stringify([item.entry.host,titles.get(item.key)]);titleCounts.set(key,(titleCounts.get(key)||0)+1);}
  for (const item of shown) {
    let button=tabButtons.get(item.key);
    if(!button){
      button=document.createElement('button');button.draggable=true;
      const row=document.createElement('div');row.className='tab-row';
      const actions=document.createElement('button');actions.className='tab-actions';actions.textContent='⋯';
      actions.setAttribute('aria-haspopup','menu');actions.setAttribute('aria-controls','tab-menu');
      actions.onclick=()=>{const bounds=actions.getBoundingClientRect();openTabMenu(button._item,bounds.right,bounds.top,actions);};
      row.append(button,actions);button._row=row;
      button.onkeydown=event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const bounds=button.getBoundingClientRect();openTabMenu(button._item,bounds.right,bounds.top,button);}};
      const star=document.createElement('span');star.className='star';star.setAttribute('aria-hidden','true');
      const name=document.createElement('span');name.className='tab-name';
      const label=document.createElement('small');button.append(star,name,label);
      button.ondragstart=event=>{
        dragging=true;
        dragState={key:button._item.key,clientY:event.clientY,target:null};
        event.dataTransfer.setData(dragType,dragState.key);event.dataTransfer.effectAllowed='move';
        button.classList.add('dragging');$('tabs').classList.add('reordering');
      };
      button.ondragend=finishDrag;
      button.oncontextmenu=event=>{event.preventDefault();openTabMenu(button._item,event.clientX,event.clientY,button);};
      button.onclick=()=>{if(dragging||Date.now()<suppressTabClickUntil)return;activate(button._item);};
      tabButtons.set(item.key,button);
    }
    button._item=item;
    button.draggable=!item.tab.pending||Number.isInteger(item.tab.id);
    const title=titles.get(item.key);
    const machine=hosts.get(item.entry.host)?.name || item.entry.host;
    const stateLabel=autoLabel(item);
    const unavailable=attentionErrors.some(error=>error.host==='Switchboard'||error.host===item.entry.host&&(!error.session||error.session===item.entry.name));
    const flagged=!!ready[item.key]||item.tab.name.startsWith('*');
    const starred=isReady(item);
    const status=unavailable?'Status unavailable':stateLabel==='Ready'?'':stateLabel;
    const duplicate=titleCounts.get(JSON.stringify([item.entry.host,title]))>1;
    const subtitle=`${machine}${duplicate?' · '+item.entry.name:''}${status?' · '+status:''}${flagged?' · For review':''}`;
    button.title=`${title} · ${machine} · ${item.entry.name}\n${status||'No pending attention'}${flagged?' · Flagged for review':''}\nDrag to reorder · Alt+Shift+H/L moves this tab · Right-click for actions`;
    button.className='tab-select'+(item.key===selected?' selected':'')+(starred?' needs-attention':'');
    button.setAttribute('aria-pressed',String(item.key===selected));
    button.setAttribute('aria-label',`${title}, ${machine}, ${item.entry.name}${status?', '+status:''}${flagged?', Flagged for review':''}`);
    const dot=button.children[0];dot.hidden=false;
    dot.className='star '+(unavailable?'unavailable':starred?'attention':stateLabel==='Working'?'working':'quiet');
    if(button.children[1].textContent!==title)button.children[1].textContent=title;
    button.dataset.agentState=unavailable?'Status unavailable':stateLabel;
    if(button.children[2].textContent!==subtitle)button.children[2].textContent=subtitle;
    const row=button._row,actions=row.lastElementChild;row._item=item;
    row.classList.toggle('active',item.key===selected);
    actions.setAttribute('aria-label',`Actions for ${title} · ${machine}`);
    actions.title=`Actions for ${title}`;
    actions.setAttribute('aria-expanded',String(!$('tab-menu').hidden&&contextItem?.key===item.key));
    nodes.push(row);
  }
  for(const button of tabButtons.values())if(!shownKeys.has(button._item.key))button._row.remove();
  let cursor=$('tabs').firstChild;
  for(const node of nodes){if(node!==cursor)$('tabs').insertBefore(node,cursor);else cursor=cursor.nextSibling;}
  $('tab-count').textContent=`${shown.length}${shown.length!==tabs.length?' / '+tabs.length:''} tabs`;
  $('tab-no-results').hidden=shown.length>0;

  const current=tabs.find(t=>t.key===selected);
  updateTabUrl(current);
  const notifications=allTabs(true,true).filter(isReady).length;
  $('notifications').textContent=`${notifications} notification${notifications===1?'':'s'}`;
  $('notifications').classList.toggle('has-notifications',notifications>0);
  $('notifications').hidden=notifications===0;
  $('tab-count').hidden=shown.length===tabs.length;
  $('sidebar-summary').hidden=notifications===0&&shown.length===tabs.length;
  document.title=`${notifications?'('+notifications+') ':''}`+(current?`${tabTitle(current)} · ${hosts.get(current.entry.host)?.name} · Switchboard`:'Switchboard');
  const startingEntry=[...sessions.values()].find(entry=>entry.starting&&(filter==='all'||groups[entry.host]===filter));
  const currentEntry=current?.entry||(waitingForRequestedTab()?sessions.get(sessionKey(...JSON.parse(selected).slice(0,2))):startingEntry);
  for (const entry of sessions.values()) entry.frame.classList.toggle('active',entry===currentEntry);
  updateSelectionTools(current);
  if(!$('tab-menu').hidden)updateTabMenu();
  const archiveCount=allTabs(true,true).filter(item=>archived[item.key]).length;
  $('archive').textContent=`Archive${archiveCount?' ('+archiveCount+')':''}`;
  if($('archive-dialog').open)renderArchive();
  if(!current){$('artifact-preview').hidden=true;$('artifact-frame').src='about:blank';}
  $('empty').hidden=!!current;
  if (!current) $('empty').textContent=restoringTab?'Connecting to the requested terminal…':startingEntry?'Starting a terminal…':filter==='all'?(archiveCount?'All tabs are archived. Open Archive to restore one.':'No connected tabs. Use + to open a terminal, or check your machines in Settings.'):`No ${filter} tabs. Assign machines to this group in Settings.`;
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
  if(!$('tab-menu').hidden && event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeTabMenu(true);return;}
  if(event.key==='Escape'&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){
    if(mobileSidebar.matches&&sidebarOpen){event.preventDefault();sidebarOpen=false;updateSidebar();$('sidebar-toggle').focus();return;}
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
function connectSession(host,name,starting=false) {
  const key=sessionKey(host.id,name);
  if(sessions.has(key))return sessions.get(key);
  const frame=document.createElement('iframe');frame.title=`${host.name}: ${name}`;
  frame.src=`/hosts/${encodeURIComponent(host.id)}/${encodeURIComponent(name)}`;
  frame.allow='clipboard-read; clipboard-write';
  const entry={host:host.id,name,frame,state:null,starting,catalogUnavailable:catalogUnavailable(host.id,name)};sessions.set(key,entry);
  setCatalog(entry,tabCatalog.filter(tab=>tab.host===entry.host&&tab.session===entry.name));$('terminals').append(frame);
  if(starting)entry.startTimeout=setTimeout(()=>{
    if(entry.starting){entry.starting=false;entry.closeError='Terminal did not start. Check the machine connection and use + to try again.';render();}
  },30000);
  return entry;
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
        // Only the first successful catalog on this page can start a session.
        // Closing the last tab must not make the next poll recreate it.
        if(!host.error&&Array.isArray(host.sessions)&&!startedHosts.has(host.id)){
          startedHosts.add(host.id);
          if(host.sessions.length===0)connectSession(host,'main',true);
        }
        for(const session of host.sessions||[]) {
          if(!session.web_clients_allowed)continue;
          connectSession(host,session.name);
        }
        if(!host.error) for(const [key,entry] of sessions) {
          if(entry.host===host.id&&!entry.starting&&!host.sessions.some(s=>s.name===entry.name)) {clearTimeout(entry.startTimeout);entry.frame.remove();sessions.delete(key);}
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
  }else if(event.data?.type==='zellij-selection-changed'){
    if(entry.frame.classList.contains('active'))updateSelectionTools();
  }else if(event.data?.type==='zellij-clipboard'){
    setStatus(event.data.ok?'Copied to this browser.':event.data.error||'Copy failed; use the terminal’s clipboard panel.',!event.data.ok);
  }else if(event.data?.type==='zellij-disconnected'){entry.disconnected=true;entry.needsFocus=true;setStatus(`${hosts.get(entry.host)?.name}: reconnecting…`,true);}
});
$('artifact-back').onclick=()=>{const current=allTabs().find(item=>item.key===selected);if(current)focus(current);else $('artifact-preview').hidden=true;};
function updateSelectionTools(current=allTabs().find(item=>item.key===selected)){
  const api=current?.entry.frame.contentWindow.SwitchboardClipboard;
  const visible=!!current&&$('artifact-preview').hidden&&!!(api?.selectionMode||api?.getSelectionText?.());
  $('selection-tools').hidden=!visible;
  $('selection-target').textContent=current?tabTitle(current):'';
  $('selection-target').title=current?`${tabTitle(current)} · ${hosts.get(current.entry.host)?.name}`:'';
  $('copy').disabled=!api?.getSelectionText?.();
}
$('select-text').onclick=()=>{
  const item=contextItem;if(!item)return;
  closeTabMenu();
  if(item.key!==selected)activate(item,false);
  const api=item.entry.frame.contentWindow.SwitchboardClipboard;
  if(!api){setStatus('Terminal clipboard is unavailable; refresh this page.',true);return;}
  api.setSelectionMode(true);updateSelectionTools();
  sidebarOpen=false;updateSidebar();item.entry.frame.focus();
};
$('exit-selection').onclick=()=>{
  const current=allTabs().find(item=>item.key===selected),api=current?.entry.frame.contentWindow.SwitchboardClipboard;
  api?.setSelectionMode(false);api?.clearSelection();updateSelectionTools();current?.entry.frame.focus();
};
// Keep the terminal selection when using the contextual copy tools.
$('copy').onmousedown=event=>event.preventDefault();
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
    if(!entry.state||!sessionTabs(entry).length)continue;
    const option=document.createElement('option');option.value=key;option.textContent=`${hosts.get(entry.host)?.name} · ${entry.name}`;option.selected=entry===current;select.append(option);
  }
  for(const host of hosts.values())if(!host.error&&host.sessions?.length===0&&![...select.options].some(option=>option.value===sessionKey(host.id,'main'))){
    const option=document.createElement('option');option.value=sessionKey(host.id,'main');option.textContent=host.name;select.append(option);
  }
  if(!select.options.length){setStatus('No machines are connected. Check your machines in Settings.',true);return;}
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
  event.preventDefault();const key=$('new-tab-target').value;let entry=sessions.get(key);
  if(!entry?.state){
    const [id,name]=JSON.parse(key),host=hosts.get(id);
    if(!host||host.error||host.sessions?.length!==0)return;
    if(entry&&!entry.starting){entry.frame.remove();sessions.delete(key);}
    connectSession(host,name,true).selectOnStart=true;
    if(filter!=='all'&&groups[id]!==filter)setFilter('all');$('tab-search').value='';
    $('new-tab-dialog').close();render();return;
  }
  if(!sessionTabs(entry).length)return;
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
  const item=contextItem;if(!item)return;
  ready[item.key]=Date.now();saveReady();
  closeTabMenu(true);render();
};
$('settings').onclick=()=>$('settings-dialog').showModal();
$('size-owner').onclick=()=>{
  const item=contextItem;
  if(!item || $('size-owner').disabled)return;
  item.entry.frame.contentWindow.postMessage({type:'zellij-size-owner',tab_position:item.tab.position,owned:true},location.origin);
  closeTabMenu(true);
};
$('close-settings').onclick=()=>$('settings-dialog').close();
$('refresh').onclick=async()=>{
  const button=$('refresh');button.disabled=true;button.textContent='Refreshing…';
  try{await refresh();}finally{button.disabled=false;button.textContent='Refresh';}
};
$('native-tabs').onclick=()=>{nativeTabs=!nativeTabs;localStorage.setItem('switchboard-native-tabs',String(nativeTabs));updateNativeTabs();};
updateNativeTabs();
refresh();setInterval(refresh,15000);

function closeTabMenu(restore=false){
  $('tab-menu').hidden=true;$('close-tab').disabled=false;contextItem=null;
  menuTrigger?.setAttribute('aria-expanded','false');
  if(restore===true&&menuTrigger?.isConnected)menuTrigger.focus();
  menuTrigger=null;
}
function updateTabMenu(){
  const item=allTabs().find(tab=>tab.key===contextItem?.key);
  if(!item){closeTabMenu(true);return;}
  contextItem=item;
  $('tab-menu-target').textContent=`${tabTitle(item)} · ${hosts.get(item.entry.host)?.name||item.entry.host} · ${item.entry.name}`;
  $('ready').disabled=!!item.tab.pending&&!Number.isInteger(item.tab.id);
  $('archive-tab').disabled=!!item.tab.pending&&!Number.isInteger(item.tab.id);
  $('close-tab').disabled=!!item.tab.pending||!Number.isInteger(item.tab.id);
  $('close-tab').title=item.tab.pending||!Number.isInteger(item.tab.id)?'Waiting for the tab identity to finish connecting':'Close this tab · Ctrl+D';
  $('select-text').disabled=!item.entry.frame.contentWindow.SwitchboardClipboard;
  $('select-text').setAttribute('aria-pressed',String(!!item.entry.frame.contentWindow.SwitchboardClipboard?.selectionMode));
  const viewport=item.entry.state?.tab_viewport,sizeOwner=$('size-owner');
  const focused=item.key===selected&&activeTab(item.entry)?.id===item.tab.id&&!item.entry.requestedPane&&!item.entry.focusPending&&!item.entry.pendingNewTab;
  sizeOwner.disabled=!focused||!viewport||!item.entry.frame.contentWindow.__zjSupportsTabViewport;
  sizeOwner.setAttribute('aria-pressed',String(!!viewport?.is_owner&&focused));
  sizeOwner.textContent=viewport?.is_owner&&focused?'Using this window’s size':'Use this window’s size';
  sizeOwner.title=!focused?'Select this tab first.':!viewport?'Available in new sessions after updating Switchboard.':viewport.constrained?'A smaller plain terminal is keeping this tab within its screen.':'The last focused browser window sets the size.';
}
function openTabMenu(item,x,y,trigger=tabButtons.get(item.key)){
  closeTabMenu();contextItem=item;menuTrigger=trigger;
  const menu=$('tab-menu');menu.hidden=false;updateTabMenu();
  if(menu.hidden)return;
  trigger?.setAttribute('aria-expanded','true');
  menu.style.left=`${Math.max(4,Math.min(x,innerWidth-menu.offsetWidth-4))}px`;
  menu.style.top=`${Math.max(4,Math.min(y,innerHeight-menu.offsetHeight-4))}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
}
$('tab-menu').onkeydown=event=>{
  const items=[...$('tab-menu').querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }else if(event.key==='Tab')closeTabMenu(true);
};
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
let sidebarWidth=Number(localStorage.getItem('switchboard-sidebar-width'))||242;
function setSidebarWidth(width){
  sidebarWidth=Math.max(180,Math.min(420,width,Math.max(180,innerWidth-320)));
  document.documentElement.style.setProperty('--sidebar-width',`${sidebarWidth}px`);
  $('sidebar-resize').setAttribute('aria-valuemin','180');$('sidebar-resize').setAttribute('aria-valuemax',String(Math.min(420,Math.max(180,innerWidth-320))));$('sidebar-resize').setAttribute('aria-valuenow',String(Math.round(sidebarWidth)));
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
    // The relay also preserves catalogs during failed scans. Use those on a
    // fresh page, and retain browser entries the failed scan could not supply.
    const incoming=data.tabs||[],identity=tab=>JSON.stringify([tab.host,tab.session,tab.id]);
    const supplied=new Set(incoming.map(identity));
    tabCatalog=[...incoming,...tabCatalog.filter(tab=>catalogUnavailable(tab.host,tab.session)&&!supplied.has(identity(tab)))];
    for(const entry of sessions.values()){
      entry.catalogUnavailable=catalogUnavailable(entry.host,entry.name);
      setCatalog(entry,tabCatalog.filter(tab=>tab.host===entry.host&&tab.session===entry.name));
      updateCreatedTabs(entry);
    }
    const current=allTabs().find(item=>item.key===selected);
    if(current && document.hasFocus() && !document.hidden && $('artifact-preview').hidden && !document.querySelector('dialog[open]') && !current.entry.requestedPane && !current.entry.focusPending && activeTab(current.entry)?.id===current.tab.id)acknowledgeAttention(current);
    render();
    const selectedTab=allTabs().find(item=>item.key===selected);if(selectedTab?.entry.needsFocus)focus(selectedTab,true);
  }catch(_){paneAttention.clear();attentionErrors=[{host:'Switchboard'}];render();}
  finally{attentionLoading=false;if(attentionRefreshPending){attentionRefreshPending=false;refreshAttention();}}
}
refreshAttention();setInterval(refreshAttention,2000);
