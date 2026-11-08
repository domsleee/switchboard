const $ = id => document.getElementById(id);
// "Wed 7 Oct 2026, 7:31 pm (2 hours ago)" in the viewer's locale and time zone.
function humanTime(date,now=Date.now()){
  const units=[['year',31536e6],['month',2592e6],['week',6048e5],['day',864e5],['hour',36e5],['minute',6e4]];
  const elapsed=date-now,[unit,size]=units.find(([,size])=>Math.abs(elapsed)>=size)||['minute',6e4];
  const ago=new Intl.RelativeTimeFormat(undefined,{numeric:'auto'}).format(Math.round(elapsed/size),unit);
  return `${date.toLocaleString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'})} (${ago})`;
}
// Stamp the HTML itself: an update between loading the page and its first
// health request must not make stale assets look current.
(()=>{
  const valid=commit=>typeof commit==='string'&&/^[a-f0-9]{7,40}$/.test(commit);
  let loaded=document.querySelector('meta[name="switchboard-build"]')?.content;
  let checking=false,reloadTimer=null,reloading=false;
  const same=(a,b)=>a.startsWith(b)||b.startsWith(a);
  // A terminal page can own queued input or an acknowledged partial paste,
  // including legacy remote viewers. Service updates are independent; page
  // refresh waits until every viewer has safely retired or closed.
  const safe=()=>document.hidden&&!document.querySelector('dialog[open]')&&!document.querySelector('#terminals>iframe:not([src="about:blank"])')&&!globalThis.SwitchboardConversation?.hasUnsentWork?.();
  async function check(){
    if(checking||reloading)return;checking=true;
    clearTimeout(reloadTimer);reloadTimer=null;
    try{
      const response=await fetch('/api/health',{cache:'no-store'});
      const build=response.ok?await response.json():null;
      if(!valid(build?.commit))return;
      if(!valid(loaded))loaded=build.commit;
      if(same(loaded,build.commit)){
        if(/^\d{4}-\d{2}-\d{2}$/.test(build.commit_date)){
          $('build-version').textContent=`${build.commit} · ${build.commit_date}`;
          const when=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(build.commit_timestamp)?new Date(build.commit_timestamp):null;
          $('build-version').title=`Commit ${build.commit} · ${when?humanTime(when):build.commit_date}`;
        }
      }else if(safe()){
        // Recheck after the delay: a viewer or draft may have opened meanwhile.
        reloadTimer=setTimeout(()=>{if(safe()){reloading=true;location.reload();}},2000);
      }
    }catch(_){}finally{checking=false;}
  }
  document.addEventListener('visibilitychange',()=>{
    clearTimeout(reloadTimer);reloadTimer=null;void check();
  });
  window.addEventListener('pageshow',()=>void check());
  setInterval(check,30000);void check();
})();
const hosts = new Map(), sessions = new Map();
const tabButtons=new Map();
const mobileSidebar=matchMedia("(max-width:700px), (pointer:coarse) and (max-width:1000px)");
// An iframe's visual viewport does not report the keyboard covering its parent.
// Resize the terminal frame from the outer visual viewport so its normal fit
// handler sees the space actually available above the keyboard.
function updateMobileTerminalViewport(){
  const view=window.visualViewport;
  if(view&&view.scale!==1)return; // Preserve browser pinch zoom.
  const active=mobileSidebar.matches&&!$('terminals').classList.contains('conversation-open');
  document.body.classList.toggle('mobile-terminal-viewport',active);
  if(active){
    document.body.style.setProperty('--terminal-visible-height',(view?.height||innerHeight)+'px');
    document.body.style.setProperty('--terminal-visible-top',(view?.offsetTop||0)+'px');
  }
}
window.visualViewport?.addEventListener('resize',updateMobileTerminalViewport);
window.visualViewport?.addEventListener('scroll',updateMobileTerminalViewport);
window.addEventListener('resize',updateMobileTerminalViewport);
let sidebarCollapsed=localStorage.getItem("switchboard-sidebar-collapsed")==="true",sidebarOpen=false;
let filter = requestedFilter(), selected = requestedTab(), restoringTab=!!selected, loading = false, dragging = false, hostsLoaded = false;
const dragType='application/x-zellij-switchboard-tab';
let dragState=null, dragScrollFrame=0, suppressTabClickUntil=0;
function load(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (_) { return {}; } }
const groups = load('switchboard-groups');
const ready = load('switchboard-ready');
const pinned = load('switchboard-pinned');
function isPinned(key){return !!pinned[canonKey(key)];}
function savePinned(){localStorage.setItem('switchboard-pinned',JSON.stringify(pinned));}
function setPinned(item,on){
  if(on)pinned[canonKey(item.key)]=1;else delete pinned[canonKey(item.key)];
  savePinned();
}
// Tabs in the Hidden group at the bottom of the sidebar. The group shares them like the
// tab order; tabs archived before Hidden existed join it.
const hidden = localStorage.getItem('switchboard-hidden')===null?load('switchboard-archived'):load('switchboard-hidden');
function sectionExpanded(section){
  const key=`switchboard-${section}-open`;
  // Keep the old browser-wide preference until this view gets its own choice.
  return (localStorage.getItem(`${key}:${filter}`)??localStorage.getItem(key))==='true';
}
let snoozedOpen = sectionExpanded('snoozed');
let hiddenOpen = sectionExpanded('hidden');
const seenAttention = load('switchboard-attention-seen');
let attentionLoaded=false,paneAttention=keyedAttention(globalThis.SwitchboardStartup?.snapshot.attention||[]),tabCatalog=[],attentionErrors=[],attentionLoading=false,attentionRefreshPending=false,attentionVersion=0;
let contextItem = null, menuTrigger = null;
let tabOrder=load('switchboard-tab-order');
if(!Array.isArray(tabOrder))tabOrder=[];
let nativeTabs = localStorage.getItem('switchboard-native-tabs') === 'true';
function updateNativeTabs() {
  $('native-tabs').setAttribute('aria-pressed',String(nativeTabs));
  $('native-tabs').classList.toggle('selected',nativeTabs);
  for (const entry of sessions.values()) entry.frame.contentWindow.postMessage({type:'zellij-native-tabs',visible:nativeTabs},location.origin);
}
function saveReady() { localStorage.setItem('switchboard-ready', JSON.stringify(ready)); }
const dismissedStatus=new Set();
const dismissedOffline=load('switchboard-dismissed-offline');
let statusErrors=[];
function setStatus(message,isError=false,errors=null) {
  // Only the full error list can confirm that a dismissed outage ended.
  if(errors)for(const message of dismissedStatus)if(!errors.some(error=>error.message===message))dismissedStatus.delete(message);
  statusErrors=(errors||(isError?[{message}]:[])).filter(error=>!dismissedStatus.has(error.message)&&!(error.host&&dismissedOffline[error.host]>Date.now()));
  const daily=statusErrors.some(error=>error.host),dismiss=$('dismiss-status');
  dismiss.textContent=daily?'Dismiss for today':'×';
  dismiss.classList.toggle('for-today',daily);
  dismiss.setAttribute('aria-label',daily?'Dismiss offline warnings for today':'Dismiss notification');
  dismiss.title=daily?'Hide offline warnings for these computers until tomorrow':'Dismiss notification';
  $('status-message').textContent=isError?statusErrors.map(error=>error.message).join(' · '):message;
  $('status').classList.toggle('has-error',isError&&statusErrors.length>0);
  $('notifications').title=`${$('notifications').textContent}\n${message}`;
}
$('dismiss-status').onclick=()=>{
  const until=new Date();until.setHours(24,0,0,0);
  for(const error of statusErrors){
    if(error.host)dismissedOffline[error.host]=until.getTime();
    else dismissedStatus.add(error.message);
  }
  if(statusErrors.some(error=>error.host))localStorage.setItem('switchboard-dismissed-offline',JSON.stringify(dismissedOffline));
  $('status').classList.remove('has-error');
  if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();else if($('artifact-preview').hidden)$('terminals').querySelector('iframe.active')?.focus();
};
// Work only or Home only, so a browser opens on its own group: Settings → Show tabs from.
function focusGroup(){
  const group=localStorage.getItem('switchboard-focus-group');
  return group==='home'||group==='work'?group:'';
}
function requestedFilter(){
  const group=new URLSearchParams(location.search).get('group');
  return group==='home'||group==='work'||group==='all'?group:focusGroup()||'all';
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
  // A missing machine or an unscanned session is not evidence either. Only a
  // completed discovery or a clean scan covering the session proves closure.
  if(!machine)return !hostsLoaded||loading;
  return machine.connecting||!!entry&&(!entry.state||!entry.catalog?.length||!entry.catalogPolls);
}
function catalogUnavailable(host,session){return attentionError(host,session);}
// A relay that is starting or has not scanned a computer yet keeps its last status.
function statusUnavailable(host,session){return attentionError(host,session,false);}
function attentionError(host,session,pending){
  return attentionErrors.some(error=>(error.host==='Switchboard'||error.host===host)&&(!error.session||error.session===session)&&(pending===undefined||!!error.pending===pending));
}
function updateTabUrl(item){
  if(!item&&(restoringTab||waitingForRequestedTab()))return;
  if(item?.tab.pending&&!Number.isInteger(item.tab.id))return;
  const url=new URL(location.href);
  for(const key of ['host','session','tab','pane'])url.searchParams.delete(key);
  if(item){url.searchParams.set('host',item.entry.host);url.searchParams.set('session',item.entry.name);url.searchParams.set(item.tab.pending?'pane':'tab',item.tab.id);}
  if(url.href!==location.href)history.replaceState(history.state,'',url);
}
function sessionKey(host, name) { return JSON.stringify([host, name]); }
// The session + starts on a computer with no shared session, or null when it has one.
// Its unshared sessions stay private, so the new one takes the first free name.
function firstSessionName(host){
  if(!host||host.error||!Array.isArray(host.sessions)||host.sessions.some(session=>session.web_clients_allowed))return null;
  const taken=new Set(host.sessions.map(session=>session.name));
  for(let i=1;;i++){const name=i===1?'main':`main-${i}`;if(!taken.has(name))return name;}
}
function tabKey(entry, tab) { return JSON.stringify([entry.host, entry.name, tab.pending?'pane':'tab', tab.id]); }
// Tabs created after this browser first saw their session go last, oldest first.
// Native tab IDs only grow within a session, so a higher ID is a newer tab.
let newTabState;
function lateTabs(){
  if(!newTabState){try{newTabState=JSON.parse(localStorage.getItem('switchboard-new-tabs'));}catch(_){}newTabState??={keys:[],ids:{}};}
  return newTabState;
}
function markNewTabs(entry,tabs){
  const state=lateTabs(),session=JSON.stringify([entry.host,entry.name]),ids=tabs.map(tab=>tab.id).filter(Number.isInteger);
  if(!ids.length)return;
  const seen=state.ids[session],newest=Math.max(...ids);
  // A lower newest ID means the session was recreated; start counting again.
  if(seen!==undefined&&newest>=seen)for(const tab of tabs)if(tab.id>seen&&!state.keys.includes(tabKey(entry,tab)))state.keys.push(tabKey(entry,tab));
  state.ids[session]=newest;
  // ponytail: capped list instead of pruning closed tabs; prune if 200 is ever reached in practice.
  state.keys=state.keys.slice(-200);
  localStorage.setItem('switchboard-new-tabs',JSON.stringify(state));
}
// The group shares one tab order, keyed alike in every browser; this browser keeps a
// copy for when no group or relay shares it. A save in flight outranks older polls.
let localHost=null,orderUpdated=0,savingOrder=0,orderReady=false,orderShared=false;
try{localHost=JSON.parse(localStorage.getItem('switchboard-local-host'));}catch(_){}
// Peers know this computer as mesh-<member id>, so its tabs get that key everywhere.
function canonKey(key){const [host,...rest]=JSON.parse(key);return host===localHost?.id?JSON.stringify(['mesh-'+localHost.member,...rest]):key;}
// Forget tabs a clean scan no longer lists; tabs on unreachable hosts keep their places.
// ponytail: tabs of whole closed sessions stay listed; prune by host session lists if a list grows large.
function stillListed(keys){
  const live=new Set([...sessions.values()].flatMap(entry=>sessionTabs(entry).map(tab=>canonKey(tabKey(entry,tab)))));
  const scanned=new Set([...sessions.values()].filter(entry=>entry.catalogPolls&&!entry.catalogUnavailable).map(entry=>canonKey(JSON.stringify([entry.host,entry.name]))));
  return keys.filter(key=>live.has(key)||isLayout(key)||!scanned.has(JSON.stringify(JSON.parse(key).slice(0,2))));
}
function saveOrder(order){
  tabOrder=stillListed(order);
  localStorage.setItem('switchboard-tab-order',JSON.stringify(tabOrder));
  if(!orderShared)return;
  savingOrder++;
  fetch('/api/mesh/tab-order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keys:tabOrder})})
    .then(r=>r.ok?r.json():null).then(saved=>{if(saved)orderUpdated=Math.max(orderUpdated,saved.updated);}).catch(()=>{}).finally(()=>savingOrder--);
}
function applyTabOrder(mesh,member){
  const shared=mesh?.tab_order;
  const host=[...hosts.keys()].find(id=>hosts.get(id).local);
  if(member&&host){localHost={id:host,member:member.id};localStorage.setItem('switchboard-local-host',JSON.stringify(localHost));}
  orderShared=!!member&&shared!==undefined;
  if(shared&&!savingOrder&&shared.updated>orderUpdated){
    orderUpdated=shared.updated;tabOrder=shared.keys;localStorage.setItem('switchboard-tab-order',JSON.stringify(tabOrder));
  }
  // An order saved before sharing existed moves to the group once this computer's tabs can be keyed.
  else if(orderShared&&shared===null&&!savingOrder&&tabOrder.length&&localHost)saveOrder([...new Set(tabOrder.map(canonKey))]);
  orderReady=true;flushNewTabs();
}
function isHidden(key){return !!(hidden[key]||hidden[canonKey(key)]);}
let hiddenUpdated=0,savingHidden=0,hiddenShared=false;
function replaceHidden(keys){
  for(const key of Object.keys(hidden))delete hidden[key];
  for(const key of keys)hidden[key]=1;
}
function saveHidden(keys=Object.keys(hidden)){
  replaceHidden([...new Set(keys.map(canonKey))]);
  localStorage.setItem('switchboard-hidden',JSON.stringify(hidden));
  if(!hiddenShared)return;
  savingHidden++;
  fetch('/api/mesh/hidden-tabs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keys:Object.keys(hidden)})})
    .then(r=>r.ok?r.json():null).then(saved=>{if(saved)hiddenUpdated=Math.max(hiddenUpdated,saved.updated);}).catch(()=>{}).finally(()=>savingHidden--);
}
function setHidden(item,on){
  if(on)hidden[canonKey(item.key)]=1;else{delete hidden[item.key];delete hidden[canonKey(item.key)];}
  saveHidden(stillListed(Object.keys(hidden).map(canonKey)));
}
function applyHidden(mesh,member){
  const shared=mesh?.hidden_tabs;
  hiddenShared=!!member&&shared!==undefined;
  if(shared&&!savingHidden&&shared.updated>hiddenUpdated){
    hiddenUpdated=shared.updated;replaceHidden(shared.keys);localStorage.setItem('switchboard-hidden',JSON.stringify(hidden));
  }
  // Tabs hidden before sharing existed move to the group once this computer's tabs can be keyed.
  else if(hiddenShared&&shared===null&&!savingHidden&&Object.keys(hidden).length&&localHost)saveHidden();
}
// New tabs join the end of the shared order, so they land in the same place in every browser.
// Wait for the shared order first, or a stale local copy would replace it.
function flushNewTabs(){
  const state=lateTabs();
  if(!orderReady||!state.keys.length)return;
  const order=[...new Set([...tabOrder,...allTabs(true).map(item=>item.key),...state.keys].map(canonKey))];
  state.keys=[];localStorage.setItem('switchboard-new-tabs',JSON.stringify(state));
  saveOrder(order);
}
function sessionTabs(entry){return [...(entry.catalog||[]),...(entry.provisionalTabs||[]),...(entry.creatingTab?[entry.creatingTab]:[])];}
function matchesClosingTab(tab,closing){
  return Number.isInteger(closing.pane_id)
    ? tab.panes.some(pane=>!pane.is_plugin&&pane.pane_id===closing.pane_id)
    : !tab.pending&&tab.id===closing.tab_id;
}
function updateCreatedTabs(entry){
  const state=entry.state,active=state?.active_pane,creating=entry.creatingTab;
  if(state?.session_name!==entry.name)return;
  const requested=selected&&JSON.parse(selected);
  let paneId;
  if(entry.starting&&active&&!active.is_plugin){
    paneId=active.pane_id;entry.starting=false;clearTimeout(entry.startTimeout);
    if(entry.selectOnStart){selected=JSON.stringify([entry.host,entry.name,'pane',paneId]);restoringTab=false;entry.needsFocus=true;}
  }
  // Conversation creates tabs without moving the viewer's focus, so its active pane is never the new one.
  else if(creating&&active&&!active.is_plugin&&!entry.pendingNewTab?.api&&!entry.pendingNewTab?.paneIds?.has(active.pane_id))paneId=active.pane_id;
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
    // A tab Conversation just created can reach the viewer after the creation response.
    if(!pane)return tab.id===entry.apiCreationPane&&!tab.confirmed;
    tab.confirmed=true;
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
  if(!item.entry.state&&typeof item.tab.cachedTitle==='string')return item.tab.cachedTitle;
  const live=tabPanes(item.entry,item.tab);
  const panes=item.tab.panes.map(p=>({...p,...live.find(current=>current.pane_id===p.pane_id&&current.is_plugin===p.is_plugin),tab_position:item.tab.position}));
  return SwitchboardTitles.tabTitle({panes,active_pane:item.entry.state?.active_pane},item.tab);
}
// A tab started from New tab with a prompt shows that prompt as its name, and a spinner until
// its agent reports in, instead of a blank "New tab"; Conversation shows the prompt as sent.
const launches=new Map();
function launchFor(item){
  const pane=item.tab.panes.find(p=>!p.is_plugin),key=pane&&JSON.stringify([item.entry.host,item.entry.name,pane.pane_id]);
  const launch=item.tab.launch||key&&launches.get(key);
  if(launch&&Date.now()-launch.at>600000){if(key)launches.delete(key);return null;}
  return launch||null;
}
function launchingTab(item){const launch=launchFor(item);return launch&&!tabAgent(item)?launch:null;}
function displayTitle(item){
  const title=tabTitle(item),launch=launchFor(item);
  if(!launch||!/^(?:New tab|Creating tab…|Tab #\d+|Claude(?: Code)?|Codex)$/i.test(title))return title;
  const line=launch.text.trim().split('\n')[0].trim();
  return line?line.length>60?line.slice(0,59)+'…':line:title;
}
function activeTab(entry){
  const active=entry.state?.active_pane;
  return sessionTabs(entry).find(tab=>tab.position===active?.tab_position&&tab.panes.some(p=>p.pane_id===active.pane_id&&p.is_plugin===active.is_plugin));
}
// Zellij numbers a session's tabs from 0 again when the session is recreated, after a
// reboot for example, so saved positions would land on other tabs. The order keeps one
// marker per session with its start time and tab IDs by position; when a different start
// time appears, each saved position passes to the new tab at that session position.
const restartSlack=300;
function isLayout(key){return JSON.parse(key)[2]==='layout';}
function followRestart(entry,tabs){
  if(!orderReady||!entry.catalogPolls||entry.catalogUnavailable)return;
  const created=hosts.get(entry.host)?.sessions?.find(session=>session.name===entry.name)?.created;
  if(!Number.isInteger(created))return;
  const ids=tabs.filter(tab=>Number.isInteger(tab.id)&&!tab.pending).sort((a,b)=>a.position-b.position).map(tab=>tab.id);
  if(!ids.length)return;
  const [host,name]=JSON.parse(canonKey(JSON.stringify([entry.host,entry.name])));
  const mine=key=>{const [h,n]=JSON.parse(key);return h===host&&n===name;};
  const order=tabOrder.map(canonKey),marker=order.filter(key=>mine(key)&&isLayout(key)).map(key=>JSON.parse(key)).at(-1);
  const same=marker&&marker[4].length===ids.length&&marker[4].every((id,index)=>id===ids[index]);
  let next=order;
  if(marker&&Math.abs(marker[3]-created)<=restartSlack){
    if(same)return;
    // A tab ID below the newest known one that the marker lacks means numbering restarted
    // before the new start time arrived (hosts refresh every 15 seconds); wait for it a minute.
    const newest=Math.max(...marker[4]);
    if(ids.some(id=>id<=newest&&!marker[4].includes(id))&&Date.now()-(entry.restartSuspected??=Date.now())<60000)return;
    entry.restartSuspected=null;
  }else if(marker&&!same){
    const moved=new Map(marker[4].map((id,index)=>[id,ids[index]]));
    next=order.flatMap(key=>{
      if(!mine(key))return [key];
      const [,,kind,id]=JSON.parse(key);
      return kind==='tab'&&moved.get(id)!==undefined?[JSON.stringify([host,name,'tab',moved.get(id)])]:[];
    });
    // Tabs beyond the old count follow the session's other tabs.
    const placed=new Set(next.filter(mine)),extra=ids.map(id=>JSON.stringify([host,name,'tab',id])).filter(key=>!placed.has(key));
    const last=next.findLastIndex(mine);
    next.splice(last<0?next.length:last+1,0,...extra);
    // Pins follow the same tab positions when native IDs reset.
    const pinnedKeys=Object.keys(pinned).map(canonKey);
    if(pinnedKeys.some(mine)){
      for(const key of Object.keys(pinned))delete pinned[key];
      for(const key of pinnedKeys){
        if(!mine(key)){pinned[key]=1;continue;}
        const [,,kind,id]=JSON.parse(key);
        if(kind==='tab'&&moved.get(id)!==undefined)pinned[JSON.stringify([host,name,'tab',moved.get(id)])]=1;
      }
      savePinned();
    }
    // Hidden tabs follow their positions the same way.
    const hiddenKeys=Object.keys(hidden).map(canonKey);
    if(hiddenKeys.some(mine))saveHidden(hiddenKeys.flatMap(key=>{
      if(!mine(key))return [key];
      const [,,kind,id]=JSON.parse(key);
      return kind==='tab'&&moved.get(id)!==undefined?[JSON.stringify([host,name,'tab',moved.get(id)])]:[];
    }));
  }
  const key=JSON.stringify([host,name,'layout',created,ids]);
  if(key.length>512)return;
  saveOrder([...next.filter(key=>!(mine(key)&&isLayout(key))),key]);
}
function setCatalog(entry,tabs){
  // Carry browser preferences from the earlier pane keys to native tab IDs.
  const migrations=new Map();
  for(const tab of tabs)for(const pane of tab.panes){
    migrations.set(JSON.stringify([entry.host,entry.name,pane.pane_id,pane.is_plugin]),tabKey(entry,tab));
    if(!pane.is_plugin)migrations.set(JSON.stringify([entry.host,entry.name,'pane',pane.pane_id]),tabKey(entry,tab));
  }
  let changed=false;
  for(const [old,key] of migrations)if(old in ready){ready[key]=ready[old];delete ready[old];changed=true;}
  let hiddenMoved=false;
  for(const [old,key] of migrations)for(const stored of new Set([old,canonKey(old)]))if(stored in hidden){delete hidden[stored];hidden[canonKey(key)]=1;hiddenMoved=true;}
  if(hiddenMoved)saveHidden();
  let pinnedMoved=false;
  for(const [old,key] of migrations)if(isPinned(old)){delete pinned[canonKey(old)];pinned[canonKey(key)]=1;pinnedMoved=true;}
  if(pinnedMoved)savePinned();
  if(migrations.has(selected)){selected=migrations.get(selected);changed=true;}
  const order=tabOrder.map(canonKey),moved=new Map([...migrations].map(([old,key])=>[canonKey(old),canonKey(key)]));
  if(order.some(key=>moved.has(key))){tabOrder=[...new Set(order.map(key=>moved.get(key)||key))];changed=true;}
  if(changed){saveReady();localStorage.setItem('switchboard-tab-order',JSON.stringify(tabOrder));}
  followRestart(entry,tabs);markNewTabs(entry,tabs);
  entry.catalog=tabs;
  if(entry.apiCreationPane!==undefined&&tabs.some(tab=>tab.panes.some(p=>!p.is_plugin&&p.pane_id===entry.apiCreationPane))){entry.starting=false;clearTimeout(entry.startTimeout);delete entry.apiCreationPane;}
  entry.provisionalTabs=entry.provisionalTabs?.filter(tab=>!migrations.has(tabKey(entry,tab)));
  // Keep confirmed closes hidden through snapshots taken before the close finished.
  for(const [key,closing] of [...(entry.closingTabs||[])]){
    if(closing.session!==entry.name||!closing.pending&&!sessionTabs(entry).some(tab=>matchesClosingTab(tab,closing)))entry.closingTabs.delete(key);
    else if(migrations.has(key)){
      entry.closingTabs.delete(key);closing.key=migrations.get(key);entry.closingTabs.set(closing.key,closing);
    }
  }
  syncActiveTab(entry);flushNewTabs();
}
function syncActiveTab(entry){
  const tab=activeTab(entry);
  if(!tab||entry.requestedPane||entry.focusPending)return;
  if(entry.pendingNewTab){
    if(entry.creatingTab)return;
    if(entry.pendingNewTab.has(tabKey(entry,tab)))return;
    entry.pendingNewTab=null;entry.followActiveTab=false;
    if(filter!=='all'&&groups[entry.host]!==filter)setFilter('all');$('tab-search').value='';selected=tabKey(entry,tab);entry.needsFocus=true;
  }else if(entry.followActiveTab&&!entry.needsFocus&&entry.frame.classList.contains('active')){selected=tabKey(entry,tab);entry.followActiveTab=false;}
}
function attentionKey(host,session,pane){return JSON.stringify([host,session,pane]);}
function statesForTab(item){
  return item.tab.panes.filter(p=>!p.is_plugin)
    .map(p=>paneAttention.get(attentionKey(item.entry.host,item.entry.name,p.pane_id))).filter(Boolean);
}
// sudo -A password requests from this computer's panes (askpass.js answers them).
let askpassRequests=[];
function askpassForTab(item){
  const panes=item.tab.panes.filter(p=>!p.is_plugin).map(p=>p.pane_id);
  return askpassRequests.find(r=>r.host===item.entry.host&&r.session===item.entry.name&&panes.includes(r.pane_id));
}
function needsAttention(state){
  return ['approval','input'].includes(state.state) || (state.state==='ready'&&!state.seen&&seenAttention[state.key]!==state.token);
}
function autoLabel(item){
  if(askpassForTab(item))return 'Password needed';
  const states=statesForTab(item);
  if(states.some(s=>s.state==='approval'))return 'Approval needed';
  if(states.some(s=>s.state==='input'))return 'Input needed';
  if(states.some(s=>s.state==='working'))return 'Working';
  // Claude finished its turn but a background shell it started is still running.
  if(states.some(s=>s.state==='waiting'))return 'Waiting on an agent';
  if(states.some(s=>s.state==='ready'))return states.some(needsAttention)?'Ready to review':'Ready';
  return '';
}
const reviewSent=new Map();
function acknowledgeAttention(item,paneId){
  let changed=false;
  // The relay stores the review with the computer running the tab, so other
  // viewers clear it too. The local copy only hides it in this browser, so a
  // review the owner never recorded (it was offline) is sent again later.
  for(const state of statesForTab(item))if((paneId===undefined||state.pane_id===paneId)&&state.state==='ready'&&!state.seen&&Date.now()-(reviewSent.get(state.key+state.token)||0)>10000){
    reviewSent.set(state.key+state.token,Date.now());
    if(seenAttention[state.key]!==state.token){seenAttention[state.key]=state.token;changed=true;}
    fetch('/api/attention/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:state.host,session:state.session,pane_id:state.pane_id,token:state.token})}).catch(()=>{});
  }
  if(changed)localStorage.setItem('switchboard-attention-seen',JSON.stringify(seenAttention));
  return changed;
}
function acknowledgeConversation(view){
  if(!globalThis.SwitchboardConversation?.isOpen?.()||document.hidden||!document.hasFocus()||!$('artifact-preview').hidden||document.querySelector('dialog[open]'))return;
  const item=allTabs().find(item=>item.key===selected);
  if(!item||item.entry.host!==view.host||item.entry.name!==view.session||!item.tab.panes.some(p=>!p.is_plugin&&p.pane_id===view.pane))return;
  const state=paneAttention.get(attentionKey(view.host,view.session,view.pane));
  if(!view.chatId||state?.chat_id!==view.chatId)return;
  if(acknowledgeAttention(item,view.pane))render();
}
function isReady(item){return !systemTab(item.tab)&&!!(ready[item.key] || item.tab.name.startsWith('*') || askpassForTab(item) || statesForTab(item).some(needsAttention));}
// Agents open tabs named System for their own checks: hidden, and never asking for attention.
function systemTab(tab){return tab.name.replace(/^\*\s*/,'')==='System';}
function matchesSearch(item){
  const query=$('tab-search').value.trim().toLowerCase();
  return !query || `${displayTitle(item)} ${hosts.get(item.entry.host)?.name || item.entry.host} ${groups[item.entry.host]||''} ${item.entry.name} ${autoLabel(item)}`.toLowerCase().includes(query);
}
// This computer as its mesh peers know it, so every computer sorts machines alike
// instead of listing itself first or by whichever catalog answered first.
let localMember=null,meshMembers=[];
function machineOrder(item){
  const host=hosts.get(item.entry.host),self=host?.local&&localMember;
  return [self?localMember.name:host?.name??item.entry.host,self?'mesh-'+localMember.id:item.entry.host,item.entry.name].join('\0');
}
// Paired computers share their category through the group; other hosts, and
// relays too old to share it, keep it in this browser.
function memberFor(hostId){
  const member=hosts.get(hostId)?.local?localMember:meshMembers.find(m=>'mesh-'+m.id===hostId);
  return member&&'category' in member?member:null;
}
function setCategory(member,name){
  member.category=name;
  fetch('/api/mesh/category',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({member_id:member.id,name})}).catch(()=>{});
}
function applyCategories(){
  for(const id of hosts.keys()){
    const member=memberFor(id);if(!member)continue;
    if(member.category!=null)groups[id]=member.category;
    // A category chosen before sharing existed moves to the group once.
    else if(groups[id])setCategory(member,groups[id]);
  }
}
// Every tab, with hidden tabs after the rest. Each item says whether it is hidden.
function allTabs(ignoreFilter=false) {
  const ranks=new Map([...new Set([...tabOrder,...(globalThis.SwitchboardStartup?.order()||[])].map(canonKey))].map((key,index)=>[key,index]));
  const late=new Map(lateTabs().keys.map((key,index)=>[key,index]));
  // A tab still being created has no native ID yet; it already belongs at the end.
  const lateness=item=>late.get(item.key)??(item.tab.pending?Infinity:-1);
  // Saved drag positions first; the rest by machine and session, keeping each session's tab order;
  // tabs created since then last.
  const byMachine=(a,b)=>{const x=machineOrder(a),y=machineOrder(b);return x<y?-1:x>y?1:0;};
  return [...sessions.values()].flatMap(entry => sessionTabs(entry).map(tab => {const key=tabKey(entry,tab);return {entry,tab,key,hidden:isHidden(key)||systemTab(tab),rank:ranks.get(canonKey(key))??Infinity};}))
    .filter(({entry,tab}) => ![...(entry.closingTabs?.values()||[])].some(closing=>matchesClosingTab(tab,closing)) && (ignoreFilter || filter === 'all' || groups[entry.host] === filter))
    .sort((a,b) => a.hidden-b.hidden || a.rank-b.rank || lateness(a)-lateness(b) || byMachine(a,b));
}
// Hold shelf placement briefly across gaps between consecutive runs.
const snoozedPlacement=new Map();
let snoozedExitTimer;
function sidebarTabs(){
  const now=Date.now(),tabs=allTabs(),present=new Set(tabs.map(item=>item.key));
  clearTimeout(snoozedExitTimer);
  let next=Infinity;
  for(const key of snoozedPlacement.keys())if(!present.has(key))snoozedPlacement.delete(key);
  const result=tabs.map(item=>{
    const eligible=settingValue('move-working-to-snoozed')==='true'&&!item.hidden&&!isPinned(item.key)&&!isReady(item)
      &&!statusUnavailable(item.entry.host,item.entry.name);
    let snoozed=false;
    // A tab waiting on a background agent resumes on its own, so it folds in too.
    if(eligible&&['Working','Waiting on an agent'].includes(autoLabel(item))){
      snoozedPlacement.set(item.key,{deadline:null});snoozed=true;
    }else if(eligible&&snoozedPlacement.has(item.key)){
      const placement=snoozedPlacement.get(item.key);
      placement.deadline??=now+2000;
      if(placement.deadline>now){snoozed=true;next=Math.min(next,placement.deadline);}
      else snoozedPlacement.delete(item.key);
    }else snoozedPlacement.delete(item.key);
    return {...item,snoozed};
  });
  if(next!==Infinity)snoozedExitTimer=setTimeout(()=>render(),next-now);
  return result.sort((a,b)=>(a.hidden?2:a.snoozed?1:0)-(b.hidden?2:b.snoozed?1:0));
}
// Search includes collapsed groups; keyboard navigation follows the visible rows.
function listedTabs(){
  const searching=!!$('tab-search').value.trim();
  return sidebarTabs().filter(item=>matchesSearch(item)&&(!item.hidden||hiddenOpen||searching)&&(!item.snoozed||snoozedOpen||searching||item.key===selected));
}
function moveTab(key,targetKey,after=false) {
  if(key===targetKey)return;
  const tabs=allTabs(true),source=tabs.find(t=>t.key===key),target=tabs.find(t=>t.key===targetKey);
  if(!source||!target)return;
  // A missing host or catalog is temporary; retain its saved positions when another tab moves.
  const order=[...new Set([...tabOrder,...tabs.map(t=>t.key)].map(canonKey))];
  order.splice(order.indexOf(canonKey(key)),1);
  order.splice(order.indexOf(canonKey(targetKey))+(after?1:0),0,canonKey(key));
  saveOrder(order);render();
  tabButtons.get(key)?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function moveSelected(direction) {
  const tabs=listedTabs(),index=tabs.findIndex(t=>t.key===selected),target=tabs[index+direction];
  if(index<0||!target)return;
  // Moving past the Hidden header hides or shows the tab, next to the tab it passed.
  const crossing=target.hidden!==tabs[index].hidden;
  if(crossing)setHidden(tabs[index],target.hidden);
  moveTab(selected,target.key,crossing?direction<0:direction>0);
}
// True until every reachable machine's terminals have reported once. Polls
// refresh hosts and catalogs; only the first load counts.
function terminalsSettling(){
  const machines=[...hosts.values()];
  return !attentionLoaded||loading&&!machines.length||machines.some(host=>host.connecting&&!host.sessions&&!host.error)
    ||[...sessions.values()].some(entry=>!entry.suspended&&!entry.state&&!entry.disconnected&&!hosts.get(entry.host)?.error);
}
// Says why the tab list is empty, with the one action that fixes it.
function sidebarEmpty(tabs,shown){
  if(shown.length)return null;
  const machines=[...hosts.values()];
  if(tabs.length)return {text:`No tabs match “${$('tab-search').value.trim()}”`,action:'Clear search',run(){$('tab-search').value='';render();$('tab-search').focus();}};
  if(filter!=='all'&&allTabs(true).length)return {text:`No tabs in ${$('filters').querySelector('.selected').textContent}`,action:'Show all',run:()=>setFilter('all')};
  const entries=[...sessions.values()];
  if(machines.length&&machines.every(host=>host.error)||entries.length&&entries.every(entry=>catalogUnavailable(entry.host,entry.name)))
    return {state:'unreachable',text:'Can’t reach your machines',action:'View logs',run:()=>openPanel('logs')};
  if(terminalsSettling())return {state:'loading',text:'Connecting to your machines…'};
  if(!machines.length)return {text:'No machines connected',action:'Add computer',run:()=>openPanel('computers')};
  return {text:'No terminals yet',action:'New tab',run:()=>$('new-tab').click()};
}
function renderSidebarEmpty(tabs,shown){
  const empty=sidebarEmpty(tabs,shown),box=$('tab-empty'),action=$('tab-empty-action');
  box.hidden=!empty;if(!empty)return null;
  box.dataset.state=empty.state||'';
  if($('tab-empty-text').textContent!==empty.text)$('tab-empty-text').textContent=empty.text;
  action.hidden=!empty.action;action.textContent=empty.action||'';action.onclick=empty.run||null;
  return empty;
}
// Opens and closes the Hidden group. It sits in the tab list after the other tabs, pinned to
// the bottom while the list scrolls so hidden tabs are always findable, so a
// tab dragged onto it is hidden, and one dragged above it is shown again.
const hiddenHeader=document.createElement('button');
hiddenHeader.id='hidden-toggle';hiddenHeader._hiddenGroup=true;
hiddenHeader.innerHTML='<span class="chevron" aria-hidden="true">›</span><span>Hidden</span><span class="star attention" aria-hidden="true"></span><span class="count"></span>';
hiddenHeader.onclick=()=>{
  if(dragging||Date.now()<suppressTabClickUntil)return;
  hiddenOpen=!hiddenOpen;localStorage.setItem(`switchboard-hidden-open:${filter}`,String(hiddenOpen));render();
};
function renderHiddenHeader(tabs,shown,searching){
  const expanded=hiddenOpen||searching,attention=tabs.some(isReady),count=searching?`${shown.length} / ${tabs.length}`:String(tabs.length);
  hiddenHeader.setAttribute('aria-expanded',String(expanded));
  hiddenHeader.children[2].hidden=!attention;
  if(hiddenHeader.children[3].textContent!==count)hiddenHeader.children[3].textContent=count;
  hiddenHeader.setAttribute('aria-label',`Hidden tabs, ${tabs.length}${attention?', one needs you':''}`);
  hiddenHeader.title=`${expanded?'Collapse':'Expand'} hidden tabs. They keep running.\nDrag a tab here to hide it, or above here to show it again.`;
}
const snoozedHeader=document.createElement('button');
snoozedHeader.id='snoozed-toggle';
snoozedHeader.innerHTML='<span class="chevron" aria-hidden="true">›</span><span>Working</span><span class="count"></span>';
snoozedHeader.title='Working tabs keep running here and return when they finish or need you.';
snoozedHeader.onclick=()=>{
  if(dragging||Date.now()<suppressTabClickUntil)return;
  snoozedOpen=!snoozedOpen;localStorage.setItem(`switchboard-snoozed-open:${filter}`,String(snoozedOpen));render();
};
// A row's top-right corner: what the tab is doing, or how long ago its state changed.
const statusWords={'Password needed':'Password','Approval needed':'Approve','Input needed':'Answer','Working':'Working','Waiting on an agent':'Waiting','Ready to review':'Done'};
function tabProject(item){
  const dir=item.tab.panes.find(p=>!p.is_plugin&&typeof p.cwd==='string'&&p.cwd)?.cwd;
  if(!dir)return '';
  const path=dir.replace(/[\\/]+$/,'');
  if(/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)$/i.test(path))return '~';
  return path.split(/[\\/]/).pop()||path;
}
function tabAge(item,only){
  const since=Math.max(0,...statesForTab(item).filter(state=>!only||state.state===only).map(state=>Number.isFinite(state.since)?state.since:0));
  if(!since)return '';
  const seconds=Math.max(0,Date.now()/1000-since);
  return seconds<60?'now':seconds<3600?`${Math.floor(seconds/60)}m`:seconds<86400?`${Math.floor(seconds/3600)}h`:`${Math.floor(seconds/86400)}d`;
}
function tabAgent(item){return statesForTab(item).find(state=>state.agent)?.agent||'';}
const agentIcons=window.SwitchboardConversation?.agentIcons||{};
function updateTabTooltips(){
  // Touch users have the actions menu; avoid measuring every row during polling.
  if(mobileSidebar.matches){for(const button of tabButtons.values())button.removeAttribute('title');return;}
  for(const name of $('tabs').querySelectorAll('.tab-name')){
    const button=name.parentElement;
    if(name.scrollWidth>name.clientWidth)button.title=name.textContent;
    else button.removeAttribute('title');
  }
}
new ResizeObserver(updateTabTooltips).observe($('tabs'));
function render() {
  // Live metadata arrives while dragging; keep the source element mounted.
  if(dragging)return;
  const tabs = sidebarTabs();
  const previous = selected,wasRestoring=restoringTab;
  const selection=tabs.find(t=>t.key===selected);
  if(selection){if(selection.entry.state||selection.entry.suspended)restoringTab=false;}
  // Pick the top sidebar tab, not whichever machine's terminal answered first.
  else if(!waitingForRequestedTab()){restoringTab=false;selected=terminalsSettling()?null:tabs[0]?.key||null;}
  const liveKeys=new Set(tabs.map(item=>item.key));
  for(const [key,button] of tabButtons)if(!liveKeys.has(key)){button._row.remove();tabButtons.delete(key);}
  const shown=tabs.filter(matchesSearch),listed=listedTabs(),nodes=[],shownKeys=new Set(listed.map(item=>item.key));
  const searching=!!$('tab-search').value.trim(),hiddenTabs=tabs.filter(item=>item.hidden),hiddenShown=shown.filter(item=>item.hidden);
  const snoozedTabs=tabs.filter(item=>item.snoozed),snoozedShown=shown.filter(item=>item.snoozed);
  const showSnoozedGroup=snoozedTabs.length>0&&(!searching||snoozedShown.length>0);
  const showHiddenGroup=hiddenTabs.length>0&&(!searching||hiddenShown.length>0);
  const titles=new Map(tabs.map(item=>[item.key,displayTitle(item)])),titleCounts=new Map();
  for(const item of tabs){const key=JSON.stringify([item.entry.host,titles.get(item.key)]);titleCounts.set(key,(titleCounts.get(key)||0)+1);}
  for (const item of listed) {
    if((item.snoozed||item.hidden)&&showSnoozedGroup&&!nodes.includes(snoozedHeader))nodes.push(snoozedHeader);
    if(item.hidden&&!nodes.includes(hiddenHeader))nodes.push(hiddenHeader);
    let button=tabButtons.get(item.key);
    if(!button){
      button=document.createElement('button');button.draggable=true;
      const row=document.createElement('div');row.className='tab-row';
      row.onmousedown=event=>{if(event.button===1)event.preventDefault();};
      row.onauxclick=event=>{
        if(event.button!==1)return;
        event.preventDefault();
        if(dragging||Date.now()<suppressTabClickUntil||document.querySelector('dialog[open]'))return;
        contextItem=button._item;$('close-tab').click();
      };
      row.append(button);button._row=row;holdTabForMenu(button);
      button.onkeydown=event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const bounds=button.getBoundingClientRect();openTabMenu(button._item,bounds.right,bounds.top,button);}};
      const where=document.createElement('small');where.className='tab-where';
      const status=document.createElement('span');status.className='tab-status';status.setAttribute('aria-hidden','true');
      const star=document.createElement('span');star.className='star';
      status.append(star,document.createElement('span'));
      const name=document.createElement('span');name.className='tab-name';
      const agent=document.createElement('span');agent.className='tab-agent';agent.setAttribute('aria-hidden','true');
      button.append(where,status,name,agent);
      Object.assign(button,{_where:where,_status:status,_star:star,_name:name,_agent:agent});
      button.ondragstart=event=>{
        dragging=true;
        dragState={key:button._item.key,clientY:event.clientY,target:null};
        event.dataTransfer.setData(dragType,dragState.key);event.dataTransfer.effectAllowed='move';
        button.classList.add('dragging');$('tabs').classList.add('reordering');
      };
      button.ondragend=finishDrag;
      button.oncontextmenu=event=>{event.preventDefault();if(!button._held)openTabMenu(button._item,event.clientX,event.clientY,button);};
      button.onclick=()=>{if(button._held){button._held=false;return;}if(dragging||Date.now()<suppressTabClickUntil)return;activate(button._item);};
      tabButtons.set(item.key,button);
    }
    button._item=item;
    button.draggable=!item.tab.pending||Number.isInteger(item.tab.id);
    const title=titles.get(item.key);
    const machine=hosts.get(item.entry.host)?.name || item.entry.host;
    const stateLabel=autoLabel(item);
    const unavailable=statusUnavailable(item.entry.host,item.entry.name);
    const flagged=!!ready[item.key]||item.tab.name.startsWith('*');
    const starred=isReady(item);
    // The web server names tabs opened with Run as administrator.
    const elevated=item.tab.name.replace(/^\*\s*/,'')==='Administrator';
    const starting=!unavailable&&!!launchingTab(item);
    const status=unavailable?'Status unavailable':starting?'Starting':stateLabel==='Ready'?'':stateLabel;
    const duplicate=titleCounts.get(JSON.stringify([item.entry.host,title]))>1;
    const project=tabProject(item);
    const subtitle=`${project?project+' · ':''}${machine}${duplicate?' · '+item.entry.name:''}${isPinned(item.key)?' · Pinned':''}`;
    button.className='tab-select'+(item.key===selected?' selected':'')+(starred?' needs-attention':'')+(elevated?' elevated':'')+(systemTab(item.tab)?' system':'');
    button.setAttribute('aria-pressed',String(item.key===selected));
    button.setAttribute('aria-label',`${title}${elevated&&title!=='Administrator'?', Administrator':''}${systemTab(item.tab)?', System tab opened by an agent':''}, ${project?project+', ':''}${machine}, ${item.entry.name}${status?', '+status:''}${flagged?', Flagged for review':''}${isPinned(item.key)?', Pinned':''}`);
    button._star.className='star '+(unavailable?'unavailable':starting?'starting':starred?'attention':stateLabel==='Working'?'working':stateLabel.startsWith('Waiting')?'waiting':'quiet');
    const working=stateLabel==='Working'?tabAge(item,'working'):'';
    const short=unavailable?'Unavailable':starting?'Starting':working&&working!=='now'?`Working ${working}`:statusWords[stateLabel]||(flagged?'Review':tabAge(item));
    button._status.dataset.tone=unavailable?'':starting?'working':stateLabel==='Ready to review'?'done':starred?'attention':stateLabel==='Working'?'working':'';
    if(button._status.lastChild.textContent!==short)button._status.lastChild.textContent=short;
    if(button._name.textContent!==title)button._name.textContent=title;
    button.dataset.agentState=unavailable?'Status unavailable':starting?'Starting':stateLabel;
    if(button._where.textContent!==subtitle)button._where.textContent=subtitle;
    const agentName=tabAgent(item);
    if(button._agent.dataset.agent!==agentName){button._agent.dataset.agent=agentName;button._agent.innerHTML=agentIcons[agentName]||'';}
    const row=button._row;row._item=item;
    row.classList.toggle('active',item.key===selected);
    row.classList.toggle('hidden-tab',item.hidden);
    nodes.push(row);
  }
  if(showSnoozedGroup){
    if(!nodes.includes(snoozedHeader))nodes.push(snoozedHeader);
    snoozedHeader.setAttribute('aria-expanded',String(snoozedOpen||searching));
    snoozedHeader.setAttribute('aria-label',`Working tabs, ${snoozedTabs.length}`);
    snoozedHeader.lastElementChild.textContent=searching?`${snoozedShown.length} / ${snoozedTabs.length}`:String(snoozedTabs.length);
  }else snoozedHeader.remove();
  if(showHiddenGroup&&!nodes.includes(hiddenHeader))nodes.push(hiddenHeader);
  if(showHiddenGroup)renderHiddenHeader(hiddenTabs,hiddenShown,searching);else hiddenHeader.remove();
  for(const button of tabButtons.values())if(!shownKeys.has(button._item.key))button._row.remove();
  let cursor=$('tabs').firstChild;
  for(const node of nodes){if(node!==cursor)$('tabs').insertBefore(node,cursor);else cursor=cursor.nextSibling;}
  updateTabTooltips();
  const visibleCount=tabs.length-hiddenTabs.length,visibleShown=shown.length-hiddenShown.length;
  $('tab-count').textContent=`${visibleShown}${visibleShown!==visibleCount?' / '+visibleCount:''} tabs`;
  const emptyHint=renderSidebarEmpty(tabs,shown);

  const current=tabs.find(t=>t.key===selected);
  updateTabUrl(current);
  const notifications=allTabs(true).filter(isReady).length;
  $('notifications').textContent=`${notifications} notification${notifications===1?'':'s'}`;
  $('notifications').classList.toggle('has-notifications',notifications>0);
  $('notifications').hidden=notifications===0;
  document.title=`${notifications?'('+notifications+') ':''}`+(current?`${tabTitle(current)} · ${hosts.get(current.entry.host)?.name} · Switchboard`:'Switchboard');
  globalThis.SwitchboardNotifications?.check(allTabs(true).filter(isReady));
  const startingEntry=[...sessions.values()].find(entry=>entry.starting&&(filter==='all'||groups[entry.host]===filter));
  const currentEntry=current?.entry||(waitingForRequestedTab()?sessions.get(sessionKey(...JSON.parse(selected).slice(0,2))):startingEntry);
  for (const entry of sessions.values()) entry.frame.classList.toggle('active',entry===currentEntry);
  // Selecting another computer's tab in Conversation connects its terminal in the background.
  if(globalThis.SwitchboardConversation?.wantsConversation?.())for(const entry of sessions.values())syncTerminalConnection(entry);
  updateSelectionTools(current);
  window.SwitchboardConversation?.update?.();
  updateMobileTerminalViewport();
  if(!$('tab-menu').hidden)updateTabMenu();
  if(!current){$('artifact-preview').hidden=true;$('artifact-frame').contentWindow?.location.replace('about:blank');}
  // The sidebar says why nothing is selected; the main area repeats only its
  // action, which matters on phones where the sidebar is a closed drawer.
  $('empty').hidden=!!current?.entry.state||!!globalThis.SwitchboardConversation?.isOpen?.();
  if(!current?.entry.state){
    const hint=restoringTab||startingEntry?null:emptyHint,action=$('empty-action');
    $('empty-text').textContent=restoringTab?'Connecting to the requested terminal…':startingEntry?'Starting a terminal…':current||terminalsSettling()?'Connecting…':'No terminal selected';
    action.hidden=!hint?.action;action.textContent=hint?.action||'';action.onclick=hint?.run||null;
  }
  const errors=[...hosts.values()].filter(h=>h.error).map(h=>({host:h.id,message:`${h.name}: ${h.error}`}));
  for(const entry of sessions.values())if(entry.closeError)errors.push({message:entry.closeError});
  for(const error of attentionErrors)if(!error.pending)errors.push({host:hosts.has(error.host)?error.host:null,message:`${hosts.get(error.host)?.name||error.host}: attention status unavailable`});
  if(currentEntry?.disconnected)errors.push({message:`${hosts.get(currentEntry.host)?.name||currentEntry.host}: reconnecting…`});
  setStatus(errors.length?errors.map(error=>error.message).join(' · '):`${hosts.size} machines · ${tabs.length} tabs${current?' · '+hosts.get(current.entry.host)?.name:''}`,errors.length>0,errors);
  showRetirementStatus();
  if(hostsLoaded&&attentionLoaded&&!terminalsSettling())globalThis.SwitchboardStartup?.save([...hosts.values()],allTabs(true).map(item=>({...item,title:tabTitle(item),states:statesForTab(item)})),groups);
  if ((selected !== previous || wasRestoring&&!restoringTab) && current) focus(current,true);
  if(selected!==previous) $('tabs').querySelector('.selected')?.scrollIntoView({block:'nearest',inline:'nearest'});
  globalThis.SwitchboardAskpass?.update();
}
function updateDragTarget() {
  if(!dragState)return;
  const strip=$('tabs'),bounds=strip.getBoundingClientRect();
  const candidates=[...strip.children].filter(row=>row._hiddenGroup||row._item&&row._item.key!==dragState.key);
  const next=candidates.find(button=>{const rect=button.getBoundingClientRect();return dragState.clientY<rect.top+rect.height/2;});
  const target=next||candidates.at(-1);
  if(!target){dragState.target=null;strip.classList.remove('drop-target');return;}
  const after=!next,rect=target.getBoundingClientRect();
  // Above the Hidden header: shown, after the last shown tab. Below it: hidden, in its own place.
  if(target._hiddenGroup)dragState.target=after?{hidden:true}:{key:candidates.filter(row=>row._item&&!row._item.hidden).at(-1)?._item.key,after:true,hidden:false};
  else dragState.target={key:target._item.key,after,hidden:target._item.hidden};
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
  finishDrag();if(!target)return;
  const item=allTabs(true).find(item=>item.key===key);
  if(item&&item.hidden!==target.hidden){setHidden(item,target.hidden);render();}
  if(target.key)moveTab(key,target.key,target.after);
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
// Passive chrome should not interrupt typing. Cancel the default focus transfer;
// clicks still run, and keyboard navigation keeps normal focus. Conversation
// also preserves its composer and soft keyboard through passive touch taps.
let chromePointerType='mouse';
document.addEventListener('pointerdown',event=>{chromePointerType=event.pointerType;},true);
document.addEventListener('mousedown',event=>{
  const conversationOpen=globalThis.SwitchboardConversation?.isOpen?.()||false;
  if(event.defaultPrevented||event.button!==0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!conversationOpen&&(chromePointerType!=='mouse'||event.sourceCapabilities?.firesTouchEvents))return;
  const frame=$('terminals').querySelector('iframe.active');
  const input=conversationOpen?$('terminals').querySelector('.conversation-compose textarea'):frame;
  if(!input||document.activeElement!==input||!document.hasFocus()||document.hidden||
    !$('artifact-preview').hidden||!$('tab-menu').hidden||document.querySelector('dialog[open]'))return;
  const target=event.target;
  if(!target.closest('#sidebar,#sidebar-toggle,#sidebar-backdrop,#status,#terminals')||target.closest('#selection-tools'))return;
  const control=target.closest('a,button,input,textarea,select,label,[contenteditable],[tabindex],[role="button"]');
  if(control&&!control.matches('#hidden-toggle,#snoozed-toggle,#sidebar-toggle,#sidebar-backdrop,#dismiss-status,#filters [data-filter]'))return;
  event.preventDefault();
},true);
function focus(item,background=false) {
  if(item.entry.suspending||item.entry.retirementUnresolved){item.entry.needsFocus=true;return;}
  const conversationOpen=globalThis.SwitchboardConversation?.isOpen?.()||false;
  if(conversationOpen&&!background)globalThis.SwitchboardConversation.focus();
  const activeElement=document.activeElement;
  // A sidebar click may wait for metadata with its button still focused.
  const fromTabButton=!!activeElement&&activeElement===tabButtons.get(tabKey(item.entry,item.tab));
  // Behind Conversation the terminal focuses its pane without taking keyboard focus,
  // so it is already on the right pane when Terminal is shown.
  if(background&&(document.hidden||!document.hasFocus()||!$('artifact-preview').hidden||document.querySelector('dialog[open]')||!conversationOpen&&activeElement&&activeElement!==document.body&&activeElement!==item.entry.frame&&!fromTabButton)){
    item.entry.needsFocus=true;return;
  }
  // A polling retry must not blur/disable a terminal while its control socket
  // lacks current metadata. The next native state performs the reconnect focus.
  if(!item.entry.state||item.entry.disconnected){
    item.entry.needsFocus=true;
    // Do not strand sidebar shortcuts in the previous, now hidden terminal.
    if(!background&&activeElement?.tagName==='IFRAME')activeElement.blur();
    return;
  }
  if(item.entry.pendingNewTab||item.tab.pending&&!item.tab.panes.length)return;
  $('artifact-preview').hidden=true;
  $('artifact-frame').contentWindow?.location.replace('about:blank');
  const active=item.entry.state.active_pane;
  const panes=tabPanes(item.entry,item.tab);
  const preferred=item.entry.resumePane||active;
  const pane=panes.find(p=>p.pane_id===preferred?.pane_id && p.is_plugin===preferred?.is_plugin)||panes[0];
  if(!pane){const waiting=item.entry.needsFocus;item.entry.needsFocus=true;setStatus('Waiting for terminal metadata…');if(!waiting)refreshAttention(true);return;}
  item.entry.needsFocus=false;
  if(active?.pane_id!==pane.pane_id||active?.is_plugin!==pane.is_plugin)item.entry.frame.contentWindow.SwitchboardClipboard?.clearSelection();
  const focusId=item.entry.focusId=(item.entry.focusId||0)+1;
  if(item.entry.frame.inert || item.entry.requestedPane || active?.pane_id!==pane.pane_id||active?.is_plugin!==pane.is_plugin)item.entry.requestedPane={pane_id:pane.pane_id,is_plugin:pane.is_plugin,focus_id:focusId};
  const preserveFocus=conversationOpen||(background&&!!item.entry.focusInitialized&&!fromTabButton);
  item.entry.focusInitialized=true;
  item.entry.frame.contentWindow.postMessage({type:'zellij-focus',pane_id:pane.pane_id,is_plugin:pane.is_plugin,focus_id:focusId,preserve_focus:preserveFocus},location.origin);
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
  const tabs=listedTabs();
  if(!tabs.length)return;
  const index=tabs.findIndex(t=>t.key===selected);
  activate(tabs[index<0?(direction>0?0:tabs.length-1):(index+direction+tabs.length)%tabs.length]);
}
function closeSelectedTab(){
  const item=allTabs().find(item=>item.key===selected);
  if(!item||document.querySelector('dialog[open]')||!$('artifact-preview').hidden)return;
  contextItem=item;
  $('close-tab').click();
}
window.addEventListener('keydown',sidebarKeydown,true);
function sidebarKeydown(event){
  if((navigator.platform.startsWith('Mac')?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey)&&!event.altKey&&!event.shiftKey&&event.code==='KeyK'&&!document.querySelector('dialog[open]')){event.preventDefault();showTabSearch();return;}
  const number=tabNumber(event);
  if(number&&!document.querySelector('dialog[open]')){event.preventDefault();event.stopImmediatePropagation();selectTabNumber(number);return;}
  if(event.key==='Escape'&&event.target===$('tab-search')){
    event.preventDefault();
    if($('tab-search').value){$('tab-search').value='';render();}else{sidebarOpen=false;updateSidebar();if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();else allTabs().find(item=>item.key===selected)?.entry.frame.focus();}
    return;
  }
  if(document.querySelector('dialog[open]'))return;
  if(event.code==='KeyT'&&!event.ctrlKey&&!event.metaKey&&event.altKey&&!event.shiftKey&&!event.isComposing){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)$('new-tab').click();return;}
  const closeShortcut=event.code==='KeyD'&&event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&!event.isComposing;
  // The Conversation draft keeps the tab shortcuts the terminal has: Ctrl+D and Alt+H/L.
  const tabShortcut=closeShortcut||event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.isComposing&&['KeyH','KeyL'].includes(event.code);
  if(event.target.closest?.('input,textarea,select,[contenteditable="true"]')&&!(tabShortcut&&event.target.matches?.('.conversation-compose textarea')))return;
  if(closeShortcut){
    event.preventDefault();event.stopImmediatePropagation();
    if(!event.repeat)closeSelectedTab();
    return;
  }
  if(!$('tab-menu').hidden && event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeTabMenu(true);return;}
  if(event.key==='Escape'&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){
    if(mobileSidebar.matches&&sidebarOpen){event.preventDefault();sidebarOpen=false;updateSidebar();$('sidebar-toggle').focus();return;}
    if(!$('artifact-preview').hidden){event.preventDefault();$('artifact-back').click();return;}
    if(globalThis.SwitchboardConversation?.isOpen?.()){event.preventDefault();event.stopImmediatePropagation();globalThis.SwitchboardConversation.showTerminal();return;}
    const current=allTabs().find(item=>item.key===selected);
    if(current){event.preventDefault();event.stopImmediatePropagation();current.entry.frame.contentWindow.postMessage({type:'zellij-escape'},location.origin);current.entry.frame.focus();}
    return;
  }
  if(!event.altKey||event.ctrlKey||event.metaKey)return;
  const direction=event.code==='KeyH'?-1:event.code==='KeyL'?1:0;
  if(!direction)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(event.shiftKey)moveSelected(direction);else stepTab(direction);
}
// Alt+1–8 pick the visible sidebar tab and Alt+9 picks the last on every platform.
function tabNumber(event){
  if(event.metaKey||event.shiftKey||!/^Digit[1-9]$/.test(event.code))return 0;
  return event.altKey&&!event.ctrlKey?+event.code.slice(5):0;
}
function selectTabNumber(number){
  const tabs=listedTabs(),item=number===9?tabs.at(-1):tabs[number-1];
  if(item)activate(item);
}
function renderMachines() {
  const container=$('machines'),rows=new Map([...container.children].map(label=>[label.dataset.host,label])),nodes=[];
  for(const host of hosts.values()) {
    let label=rows.get(host.id);
    if(!label){
      label=document.createElement('label');label.dataset.host=host.id;label.append(document.createTextNode(host.name));
      const select=document.createElement('select');
      for(const [value,text] of [['','Ungrouped'],['work','Work'],['home','Home']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}
      select.onchange=()=>{groups[host.id]=select.value;const member=memberFor(host.id);if(member)setCategory(member,select.value);else localStorage.setItem('switchboard-groups',JSON.stringify(groups));render();};label.append(select);
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
  renderChatCost(settingScope==='browser'?settingValue('chat-cost'):sharedValue('chat-cost'));
}
// Conversation reads the catalog/transcript APIs. An older engine's terminal socket
// attaches with a physical size and constrains the native tab before its first resize,
// and a phone viewer can force-resize shared tabs. So Conversation disconnects phone
// viewers and attaches no viewer on those engines. A desktop viewer that is already
// connected stays connected (its resizes are suppressed). Where viewers attach hidden,
// the selected terminal also connects (or reconnects) behind Conversation, so
// switching back never reloads it.
function syncTerminalConnection(entry) {
  const live=`/hosts/${encodeURIComponent(entry.host)}/${encodeURIComponent(entry.name)}`;
  const suspended=!!globalThis.SwitchboardConversation?.wantsConversation?.()&&
    !(!mobileSidebar.matches&&!entry.hideUnsupported&&!entry.cached&&!entry.suspending&&
      (!!entry.state&&entry.frame.getAttribute('src')===live||
        entry.frame.classList.contains('active')&&!!hosts.get(entry.host)?.sessions?.find(session=>session.name===entry.name)?.hidden_attach));
  const src=entry.cached||suspended?'about:blank':live;
  if(suspended&&entry.state?.active_pane)entry.resumePane=entry.state.active_pane;
  entry.suspended=suspended;
  if(!suspended)entry.suspendFailure=false;
  if(entry.suspending||entry.retirementUnresolved)return;
  if(entry.frame.getAttribute('src')===src)return;
  const retire=entry.frame.contentWindow?.__zjSuspendTerminal;
  if(suspended&&retire){
    if(entry.suspendFailure)return;
    retireTerminal(entry,retire);
    return;
  }
  entry.state=null;entry.disconnected=false;entry.requestedPane=null;entry.focusPending=false;entry.needsFocus=true;entry.hideUnsupported=false;
  entry.frame.src=src;
}
function terminalTransition(entry,busy) {
  entry.frame.inert=busy;
  entry.frame.style.opacity=busy?'0.45':'';
  entry.frame.setAttribute('aria-busy',String(busy));
  if(busy)entry.frame.blur();
}
function showRetirementStatus() {
  const entries=[...sessions.values()];
  const unresolved=entries.find(entry=>entry.retirementUnresolved);
  $('status').classList.toggle('terminal-transition',entries.some(entry=>entry.retirementUnresolved||entry.suspending||!entry.suspended&&entry.frame.inert));
  if(unresolved){
    setStatus(unresolved.retirementError||'Terminal disconnect is unconfirmed. Recover this viewer before typing.',true);
    if(unresolved.retirementRetryable===false)return;
    const retry=document.createElement('button');retry.textContent='Retry terminal connection';
    retry.onclick=()=>retireTerminal(unresolved,unresolved.frame.contentWindow.__zjSuspendTerminal);
    $('status-message').append(' ',retry);
  }else if([...sessions.values()].some(entry=>entry.suspending)){
    setStatus('Finishing terminal input before disconnecting the hidden viewer…');
  }else if([...sessions.values()].some(entry=>!entry.suspended&&entry.frame.inert)){
    setStatus('Connecting terminal before enabling typing…');
  }
}
function restoreRetainedTerminal(entry) {
  // Cancellation may also own a partial paste. Restore its native selection
  // without sending a focus control into that unfinished sequence.
  if(entry.retirementState)entry.state=entry.retirementState.payload;
  const tab=activeTab(entry),current=allTabs().find(item=>item.key===selected);
  if(tab&&current?.entry===entry)selected=tabKey(entry,tab);
  entry.needsFocus=false;entry.requestedPane=null;
  entry.focusPending=!!entry.retirementState?.focus_pending;
  entry.followActiveTab=false;
  terminalTransition(entry,entry.focusPending);
}
function retireTerminal(entry,retire) {
  if(!entry.retirementUnresolved)entry.retirementState=null;
  entry.suspending=true;entry.retirementUnresolved=false;
  terminalTransition(entry,true);
  showRetirementStatus();
  retire(()=>entry.suspended).then(retired=>{
    entry.suspending=false;
    if(retired){
      entry.state=null;entry.disconnected=false;entry.requestedPane=null;entry.focusPending=false;entry.needsFocus=true;
      entry.frame.src='about:blank';
    }else restoreRetainedTerminal(entry);
    if($('status-message').textContent==='Finishing terminal input before disconnecting the hidden viewer…')setStatus('');
    syncTerminalConnection(entry);render();
  }).catch(error=>{
    entry.suspending=false;entry.suspendFailure=true;
    entry.retirementUnresolved=!!error.unresolvedRetirement;
    entry.retirementError=error.message;entry.retirementRetryable=error.retryableRetirement;
    if(!entry.retirementUnresolved)restoreRetainedTerminal(entry);
    else terminalTransition(entry,true);
    render();setStatus(error.message,true);
    showRetirementStatus();
  });
}
function connectSession(host,name,starting=false,cached=false) {
  const key=sessionKey(host.id,name);
  const existing=sessions.get(key);
  if(existing){
    if(existing.cached&&!cached){existing.cached=false;syncTerminalConnection(existing);}
    return existing;
  }
  const frame=document.createElement('iframe');frame.title=`${host.name}: ${name}`;
  frame.onload=()=>{
    const doc=frame.contentDocument;
    if(!doc){setStatus('Terminal page unavailable. Use the sidebar to choose another tab.',true);return;}
    // Blank and failed terminal pages have no bridge to forward sidebar shortcuts.
    doc.addEventListener('keydown',event=>{
      if(!frame.classList.contains('active')||doc.querySelector('dialog[open], .security-modal, [aria-modal="true"]'))return;
      sidebarKeydown(event);
    },true);
  };
  frame.allow='clipboard-read; clipboard-write';
  const entry={host:host.id,name,frame,state:null,starting,cached,catalogUnavailable:catalogUnavailable(host.id,name)};sessions.set(key,entry);syncTerminalConnection(entry);
  setCatalog(entry,tabCatalog.filter(tab=>tab.host===entry.host&&tab.session===entry.name));$('terminals').append(frame);
  if(starting)entry.startTimeout=setTimeout(()=>{
    if(entry.starting){entry.starting=false;entry.closeError='Terminal did not start. Check the machine connection and use + to try again.';render();}
  },30000);
  return entry;
}
function pruneSessions(listed=null,hostId=null){
  if(globalThis.SwitchboardStartup?.active())return;
  if(listed)for(const id of [...hosts.keys()])if(!listed.has(id))hosts.delete(id);
  for(const [key,entry] of sessions){
    const host=hosts.get(entry.host);
    if(!host||entry.host===hostId&&!host.error&&Array.isArray(host.sessions)&&!entry.starting&&!host.sessions.some(session=>session.name===entry.name)){
      clearTimeout(entry.startTimeout);entry.frame.remove();sessions.delete(key);
    }
  }
}
async function refresh() {
  if(loading)return;loading=true;
  try {
    fetch('/api/mesh',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(mesh=>{meshMembers=mesh?.members||[];localMember=meshMembers.find(m=>m.local)||null;applyCategories();applyTabOrder(mesh,localMember);applyHidden(mesh,localMember);applySettings(mesh,localMember);render();}).catch(()=>{});
    const response=await fetch('/api/hosts?summary=1');if(!response.ok)throw Error('Cannot reach local relay');
    const data=await response.json();hostsLoaded=true;
    globalThis.SwitchboardStartup?.discover(data);
    for(const host of data)hosts.set(host.id,{...hosts.get(host.id),...host,connecting:true});
    // A host the relay stops listing must not linger until reload.
    const listed=new Set(data.map(host=>host.id));
    pruneSessions(listed);
    renderMachines();render();
    await Promise.all(data.map(async summary=>{
      try{
        const response=await fetch(`/api/hosts/${encodeURIComponent(summary.id)}`);if(!response.ok)throw Error('Cannot list sessions');
        const host=await response.json(),fetched=Date.now()/1000;hosts.set(host.id,host);
        for(const session of host.sessions||[])if(Number.isInteger(session.creation_secs_ago))session.created=Math.round(fetched-session.creation_secs_ago);
        for(const session of host.sessions||[]) {
          if(!session.web_clients_allowed)continue;
          connectSession(host,session.name);
        }
        pruneSessions(null,host.id);
      }catch(error){hosts.set(summary.id,{...hosts.get(summary.id),connecting:false,error:error.message});if(error instanceof TypeError)relayLost();}
      renderMachines();render();
    }));
  }catch(error){setStatus(error.message,true);relayLost();}finally{loading=false;}
}
function failNewTab(entry,requestId,message){
  if(!entry.pendingNewTab||entry.pendingNewTab.requestId!==requestId)return;
  const waiting=entry.creatingTab&&selected===tabKey(entry,entry.creatingTab);
  entry.pendingNewTab=null;entry.creatingTab=null;entry.followActiveTab=false;
  if(waiting){const active=activeTab(entry);selected=active?tabKey(entry,active):null;}
  render();setStatus(message,true);
}
function recordTerminalDiagnostic(entry,type,diagnostic){
  // A switch that resized its tab makes the agent redraw, even when nothing else was slow.
  const resized=type==='terminal-switch'&&(diagnostic?.viewport_size_changes>0||diagnostic?.first_native_cols>0&&(diagnostic.first_native_cols!==diagnostic.native_cols||diagnostic.first_native_rows!==diagnostic.native_rows));
  if(!diagnostic || type==='terminal-switch' && diagnostic.expected_render!==true && diagnostic.slow!==true && diagnostic.oversized_viewport!==true && !resized)return;
  const fields=type==='terminal-switch'?['focus_id','pane_id','is_plugin','expected_render','outcome','elapsed_ms','ack_ms','first_frame_ms','first_parse_ms','last_frame_ms','last_parse_ms','frames','bytes','writes_pending','max_parse_lag_ms','physical_cols','physical_rows','native_cols','native_rows','viewport_claims','terminal_resizes','scroll_height_px','client_height_px','scroll_top_px','xterm_rows','buffer_rows',
    'render_tracking','first_render_ms','last_render_ms','render_events','max_render_lag_ms','render_pending','first_animation_ms','last_animation_ms','max_animation_lag_ms','animation_pending','first_quiet_ms','late_frames','hidden_at_start','document_hidden','browser_focused','viewport_size_changes','first_native_cols','first_native_rows','first_owner_active','first_is_owner','min_native_cols','min_native_rows','max_native_cols','max_native_rows','xterm_cols','buffer_scroll_events','line_feed_events','wheel_events','wheel_reports','wheel_delta_mode','max_wheel_delta','xterm_size_changes','first_xterm_cols','first_xterm_rows','min_xterm_cols','min_xterm_rows','max_xterm_cols','max_xterm_rows','clipped_bottom_rows','max_clipped_bottom_rows',
    'control_tracking','focus_commands','terminal_metrics','cell_size_changes','first_cell_width_px','first_cell_height_px','last_cell_width_px','last_cell_height_px','min_cell_width_px','min_cell_height_px','max_cell_width_px','max_cell_height_px']:
    type==='new-tab'?['request_id','outcome','elapsed_ms','delivery_ms','sent_ms','pane_id','control_socket']:
    type==='terminal-load'?['outcome','elapsed_ms','page_ms','socket_ms','frame_ms','render_ms','visible']:
    type==='clipboard'?['outcome','chars','attempt','selection_mode','mouse_tracking','focused','secure','clipboard_api']:
    type==='instant-typing'?['outcome','pane_id','is_plugin','pending','typed','confirmed','frames','age_ms','srtt_ms','since_input_ms','since_write_ms','run_row','cursor_row','cursor_col','expected_col','cursor_hidden']:
    ['pane_id','is_plugin','shift','ctrl','alt','meta','repeat','held_ms','released_ms'];
  const body={host:entry.host};
  for(const field of fields){const value=diagnostic[field];if(value===null||typeof value==='boolean'||typeof value==='string'&&field==='outcome'||typeof value==='number'&&Number.isFinite(value)&&value>=0)body[field]=value;}
  fetch('/api/diagnostics/'+type,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(()=>{});
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin)return;
  const entry=[...sessions.values()].find(e=>e.frame.contentWindow===event.source);
  if(!entry)return;
  if(entry.suspending||entry.retirementUnresolved){
    if(event.data?.type==='zellij-state')entry.retirementState=event.data;
    return;
  }
  if(entry.suspended)return;
  if(event.data?.type==='zellij-state') {
    entry.disconnected=false;
    const previousPosition=entry.state?.active_pane?.tab_position;
    const previousPane=entry.state?.active_pane;
    entry.state=event.data.payload;
    if(entry.state.active_pane?.pane_id===entry.resumePane?.pane_id&&entry.state.active_pane?.is_plugin===entry.resumePane?.is_plugin)entry.resumePane=null;
    updateCreatedTabs(entry);
    if(entry.launchOnStart&&entry.state.active_pane&&sessionTabs(entry).length&&!event.data.focus_pending){
      const launch=entry.launchOnStart;delete entry.launchOnStart;
      createNewTab(sessionKey(entry.host,entry.name),launch);return;
    }
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
    if(!globalThis.SwitchboardConversation?.isOpen?.() && current?.entry===entry && entry.acknowledgeTab===selected && !entry.requestedPane && !entry.focusPending && activeTab(entry)?.id===current.tab.id){acknowledgeAttention(current);entry.acknowledgeTab=null;}
    render();
    if(entry.needsFocus && entry.frame.classList.contains('active')){
      const current=allTabs().find(item=>item.key===selected);if(current)focus(current,true);
    }
    if(entry.frame.inert&&!entry.needsFocus&&!entry.requestedPane&&!entry.focusPending)terminalTransition(entry,false);
  }else if(event.data?.type==='zellij-focus-failed'){
    if(entry.requestedPane?.focus_id!==event.data.focus_id)return;
    entry.requestedPane=null;
    entry.focusPending=false;
    if(!entry.frame.classList.contains('active'))return;
    const state=event.data.payload || entry.state;
    entry.state=state;const tab=activeTab(entry);
    if(tab){selected=tabKey(entry,tab);render();focus({entry,tab},true);}
    setStatus(event.data.message || 'That terminal is unavailable. Choose another tab.',true);
  }else if(event.data?.type==='zellij-new-tab-failed'){
    failNewTab(entry,event.data.request_id,event.data.message);
  }else if(event.data?.type==='zellij-load-diagnostic'){
    recordTerminalDiagnostic(entry,'terminal-load',event.data.diagnostic);
  }else if(event.data?.type==='zellij-predict-diagnostic'){
    recordTerminalDiagnostic(entry,'instant-typing',event.data.diagnostic);
  }else if(event.data?.type==='zellij-new-tab-diagnostic'){
    recordTerminalDiagnostic(entry,'new-tab',event.data.diagnostic);
  }else if(event.data?.type==='zellij-switch-diagnostic'){
    recordTerminalDiagnostic(entry,'terminal-switch',event.data.diagnostic);
  }else if(event.data?.type==='zellij-key-diagnostic'){
    recordTerminalDiagnostic(entry,'modified-enter',event.data.diagnostic);
  }else if(event.data?.type==='zellij-browser-resume-diagnostic'||event.data?.type==='zellij-browser-resume-received'){
    browserDiagnostics?.terminal(event.data.diagnostic);
  }else if(event.data?.type==='zellij-open-new-tab'){
    if(entry.frame.classList.contains('active')&&!document.querySelector('dialog[open]'))$('new-tab').click();
  }else if(event.data?.type==='zellij-close-tab'){
    if(entry.frame.classList.contains('active'))closeSelectedTab();
  }else if(event.data?.type==='zellij-tab-search'){
    if(entry.frame.classList.contains('active'))showTabSearch();
  }else if(event.data?.type==='zellij-tab-number'){
    if(entry.frame.classList.contains('active'))selectTabNumber(event.data.number);
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
  }else if(event.data?.type==='zellij-clipboard-diagnostic'){
    recordTerminalDiagnostic(entry,'clipboard',event.data.diagnostic);
  }else if(event.data?.type==='zellij-clipboard'){
    setStatus(event.data.ok?'Copied to this browser.':event.data.error||'Copy failed; use the terminal’s clipboard panel.',!event.data.ok);
  }else if(event.data?.type==='zellij-hide-unsupported'){
    // This engine still sizes tabs for hidden viewers. Disconnect it during Conversation.
    entry.hideUnsupported=true;syncTerminalConnection(entry);render();
  }else if(event.data?.type==='zellij-disconnected'){
    entry.disconnected=true;entry.needsFocus=true;
    // A hidden viewer's reconnect would attach again, sized while hidden. Stop it;
    // Terminal reconnects when it is shown.
    if(globalThis.SwitchboardConversation?.wantsConversation?.()){
      if(entry.state?.active_pane)entry.resumePane=entry.state.active_pane;
      entry.state=null;syncTerminalConnection(entry);
    }
    render();
  }
});
$('artifact-back').onclick=()=>{const current=allTabs().find(item=>item.key===selected);if(current)focus(current);else $('artifact-preview').hidden=true;};
// The open preview owns one history entry. Back closes the preview; closing it any other way drops the entry.
window.addEventListener('popstate',()=>{if(!$('artifact-preview').hidden&&!history.state?.switchboardPreview)$('artifact-back').click();});
new MutationObserver(()=>{if($('artifact-preview').hidden&&history.state?.switchboardPreview)history.back();})
  .observe($('artifact-preview'),{attributes:true,attributeFilter:['hidden']});
// A reload starts with the preview closed, so its entry no longer has a preview to close.
if(history.state?.switchboardPreview)history.replaceState({...history.state,switchboardPreview:false},'');
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
  if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.showTerminal();
  api.setSelectionMode(true);updateSelectionTools();
  sidebarOpen=false;updateSidebar();item.entry.frame.focus();
};
$('copy-title').onclick=async()=>{
  const item=contextItem;if(!item)return;
  const title=tabTitle(item);
  closeTabMenu(true);
  if(!navigator.clipboard?.writeText){setStatus('Copy title is unavailable in this browser.',true);return;}
  try{
    await navigator.clipboard.writeText(title);
    setStatus('Tab title copied.');
  }catch(error){
    setStatus(`Could not copy the tab title: ${error.message||'Clipboard access was denied.'}`,true);
  }
};
$('exit-selection').onclick=()=>{
  if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.showTerminal();
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
function renderFilter(){
  const focus=focusGroup(),more=$('filter-more');
  for(const b of $('filters').querySelectorAll('[data-filter]')){b.classList.toggle('selected',b.dataset.filter===filter);b.hidden=!!focus&&b.dataset.filter!==focus;}
  more.hidden=!focus;
  if(focus){
    const others=[...$('filters').querySelectorAll('[data-filter]')].filter(b=>b.hidden);
    // The focused group's option only labels the closed dropdown.
    const label=new Option('Show more',focus);label.hidden=true;
    more.replaceChildren(label,...others.map(b=>new Option(b.textContent,b.dataset.filter)));
    more.value=filter;more.classList.toggle('selected',filter!==focus);
  }
  const url=new URL(location.href);
  if(filter===(focus||'all'))url.searchParams.delete('group');else url.searchParams.set('group',filter);
  if(url.href!==location.href)history.replaceState(history.state,'',url);
}
// The tab last used in each group, restored when returning to that group.
const filterSelection={};
function setFilter(value){
  const previous=selected;
  if(selected)filterSelection[filter]=selected;
  filter=value;
  snoozedOpen=sectionExpanded('snoozed');hiddenOpen=sectionExpanded('hidden');
  const tabs=allTabs();
  if(!tabs.some(t=>t.key===selected)&&tabs.some(t=>t.key===filterSelection[value]))selected=filterSelection[value];
  renderFilter();render();
  // Keyboard and select controls may keep focus, so render can defer the switch.
  // Show the newly selected tab now.
  const current=allTabs().find(t=>t.key===selected);
  if(selected!==previous&&current)focus(current);
}
$('filters').onclick=event=>{const button=event.target.closest('[data-filter]');if(button)setFilter(button.dataset.filter);};
// claude.ai links from each group's tabs can open in another browser on this computer, such as
// the one signed into a work account: Settings → Links.
// Terminal frames call this on Cmd/Ctrl-click; true means the link was handled here.
window.SwitchboardOpenInApp=(host,href)=>{
  const app=groups[host]?settingValue('link-app-'+groups[host]):'',url=new URL(href);
  if(!app||!/(^|\.)claude\.ai$/.test(url.hostname))return false;
  fetch('/api/open-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url.href,app})})
    .then(async response=>{if(!response.ok)throw Error(await response.text());})
    .catch(error=>setStatus(`Could not open the link in ${app}: ${error.message}`,true));
  return true;
};
// Web pages may not open chrome://settings and the like, so the relay asks the
// browser itself. chrome:// pages open in whichever Chromium browser is viewing.
window.SwitchboardOpenBrowserPage=url=>{
  const brands=(navigator.userAgentData?.brands||[]).map(brand=>brand.brand);
  const viewer=brands.includes('Microsoft Edge')?'edge':brands.includes('Brave')?'brave':brands.includes('Google Chrome')?'chrome':brands.includes('Chromium')?'chromium':'chrome';
  const scheme=url.split(':')[0],browser=scheme==='chrome'?viewer:scheme;
  fetch('/api/open-browser-page',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,browser})})
    .then(async response=>{if(!response.ok)throw Error(await response.text());})
    .catch(async error=>{
      // The click's user activation outlasts a local request, so copying still works here.
      const copied=await navigator.clipboard?.writeText(url).then(()=>true,()=>false);
      setStatus(`Could not open ${url}: ${error.message}.${copied?' The link is copied; paste it into the address bar.':''}`,true);
    });
};
// Terminal frames call this on a modified click of a file path.
window.SwitchboardOpenFile=(host,path)=>{
  if(/\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v)$/i.test(path)&&window.SwitchboardOpenMedia){
    window.SwitchboardOpenMedia(host,path);return;
  }
  const local=!!hosts.get(host)?.local;
  $('artifact-open-local').hidden=!local;
  $('artifact-open-local').onclick=()=>{
    if(!local)return;
    fetch('/api/open-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})})
      .then(async response=>{if(!response.ok)throw Error(await response.text());})
      .catch(error=>setStatus(`Could not open ${path}: ${error.message}`,true));
  };
  // Files from every computer share the preview, which closes on the next tab switch.
  const url=`/api/hosts/${encodeURIComponent(host)}/file?path=${encodeURIComponent(path)}`;
  $('artifact-url').textContent=`${hosts.get(host)?.name||host}: ${path}`;
  // Replacing the frame's page keeps file switches out of the browser history, so
  // Back (including a mouse's back button) leaves the preview in one step.
  $('artifact-external').href=url;$('artifact-frame').contentWindow.location.replace(url);
  if(!history.state?.switchboardPreview)history.pushState({...history.state,switchboardPreview:true},'');
  $('artifact-preview').hidden=false;$('artifact-back').focus();
};
$('filter-more').onchange=event=>setFilter(event.target.value);
renderFilter();
let newTabElevated=false,newTabHandover=null;
function clearNewTabHandover(){newTabHandover?.request?.abort();newTabHandover=null;$('handover-preview').hidden=true;$('new-tab-prompt-label').textContent='Prompt';$('new-tab-prompt').placeholder='What would you like to work on?';$('new-tab-dialog').classList.remove('handover-mode');newTabSubmitText();}
// The submit button names what it will do, and what it is doing while busy.
let newTabRetrying=false;
function newTabSubmitText(text,announce=true){
  const button=$('new-tab-submit'),unknown=!newTabTargetBlocked&&$('new-tab-project-field').dataset.state==='unknown'&&$('new-tab-project').getAttribute('aria-expanded')==='false';
  const label=text||(newTabHandover?'Switch model':newTabRetrying?'Retry':unknown?(newTabElevated?'Create administrator tab anyway':'Create anyway'):newTabElevated?'Create administrator tab':'Create tab');
  button.classList.toggle('busy',!!text);button.setAttribute('aria-label',label);button.title=text?label:label+' · Enter';
  $('new-tab-status').textContent=text||(newTabRetrying?'Enter to retry':unknown?'Enter creates anyway':'');
  if(announce)$('new-tab-progress').textContent=text||'';
}
// The owner's shell shortcuts come first. Any other model starts `claude` or `codex`
// directly as `claude:<model>` or `codex:<model>`, with the same bypass flags as the shortcuts.
const NEW_TAB_MODELS=[['csol','Codex · Sol'],['castra','Codex · Astra'],['c','Claude Code']];let newTabModelValue='csol';
const NEW_TAB_CLAUDE_MODELS=[['claude-fable-5-1','Fable 5.1'],['claude-opus-5-5','Opus 5.5'],['claude-sonnet-5-5','Sonnet 5.5'],['claude-haiku-5-5','Haiku 5.5'],['claude-fable-5','Fable 5'],['claude-opus-5','Opus 5'],['claude-sonnet-5','Sonnet 5'],['claude-opus-4-8','Opus 4.8'],['claude-opus-4-7','Opus 4.7'],['claude-opus-4-6','Opus 4.6'],['claude-sonnet-4-6','Sonnet 4.6'],['claude-haiku-4-5','Haiku 4.5']];
const NEW_TAB_PROVIDERS={claude:'Claude Code',codex:'Codex'};
// Codex lists its own models on each computer; until that arrives, the menu says so.
const newTabCodexModels=new Map();
function newTabModelParts(value){
  const match=/^(claude|codex):([A-Za-z0-9][A-Za-z0-9._\-[\]/:@]{0,99})$/.exec(String(value||''));
  return match?{provider:match[1],model:match[2]}:null;
}
function newTabModelProvider(value){return value==='c'?'claude':NEW_TAB_MODELS.some(([alias])=>alias===value)?'codex':newTabModelParts(value)?.provider||'';}
function newTabModel(){return newTabModelValue;}
function setNewTabModel(value){
  const parts=newTabModelParts(value),[alias,name]=parts?[parts.model,NEW_TAB_PROVIDERS[parts.provider]]:NEW_TAB_MODELS.find(([v])=>v===value)||NEW_TAB_MODELS[0];
  newTabModelValue=parts?value:alias;
  $('new-tab-model-alias').textContent=alias;$('new-tab-model-name').textContent=name;$('new-tab-model').setAttribute('aria-label',`Model: ${alias}, ${name}`);
}
function newTabModelOptions(){
  const host=$('new-tab-target').value?JSON.parse($('new-tab-target').value)[0]:'',codex=newTabCodexModels.get(host);
  const options=[...NEW_TAB_MODELS.map(([alias,name])=>[alias,alias,name,false,'Shortcuts']),...NEW_TAB_CLAUDE_MODELS.map(([id,name])=>['claude:'+id,id,name,false,'Claude Code'])];
  if(Array.isArray(codex))options.push(...codex.map(({id,name})=>['codex:'+id,id,name===id?'':name,false,'Codex']));
  // A remembered model that is not listed stays visible, so arrows never lose it. While searching, typed names offer both agents instead.
  if(!$('new-tab-model-search').value.trim()&&!options.some(option=>option[0]===newTabModelValue)){const parts=newTabModelParts(newTabModelValue);if(parts)options.push([newTabModelValue,parts.model,'',false,NEW_TAB_PROVIDERS[parts.provider]]);}
  return options;
}
function newTabModelNote(){
  const host=$('new-tab-target').value?JSON.parse($('new-tab-target').value)[0]:'',codex=newTabCodexModels.get(host);
  return codex==='failed'?'Codex models unavailable on this computer. Type a model name.':!codex?'Loading Codex models…':'';
}
// A typed name that is not listed can start with either agent.
function newTabCustomModels(query){
  query=query.trim();if(!newTabModelParts('codex:'+query))return [];
  const claudeFirst=/^(claude|opus|sonnet|haiku|fable)/i.test(query);
  const rows=[['claude:'+query,query,'Claude Code',false,'Other model'],['codex:'+query,query,'Codex',false,'Other model']];
  return claudeFirst?rows:rows.reverse();
}
async function loadNewTabCodexModels(){
  const host=$('new-tab-target').value?JSON.parse($('new-tab-target').value)[0]:'';
  if(!host||Array.isArray(newTabCodexModels.get(host)))return;
  newTabCodexModels.delete(host);
  try{
    const response=await fetch('/hosts/'+encodeURIComponent(host)+'/model-list',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('Models unavailable');
    const data=await response.json(),models=(Array.isArray(data?.codex)?data.codex:[]).filter(model=>typeof model?.id==='string'&&newTabModelParts('codex:'+model.id)).map(({id,name})=>({id,name:typeof name==='string'?name:id}));
    newTabCodexModels.set(host,models.length?models:'failed');
  }catch(_){newTabCodexModels.set(host,'failed');}
  newTabModelMenu.refresh();
}
function paintNewTabMachine(){
  const name=$('new-tab-target').selectedOptions[0]?.textContent||'';
  $('new-tab-machine-name').textContent=name;$('new-tab-machine').setAttribute('aria-label','Computer: '+(name||'none'));
}
// A focused chip shows its choices. Arrows or a digit change the value at once;
// Enter, Escape or a click on a choice return to the prompt. Options are [value, label, detail, disabled, group].
// With a search box, typing on the chip filters the list; the first match is chosen at once,
// a name nobody listed comes from custom(query), and Escape restores the choice from before the search.
function newTabChipMenu(chip,menu,options,current,set,{search=null,custom=()=>[],note=()=>''}={}){
  const list=menu.querySelector('[role=listbox]')||menu;let before=null;
  const query=()=>search?.value.trim().toLowerCase()||'';
  function shown(){
    const text=query();if(!text)return options();
    const matches=options().filter(([value,label,detail])=>[value,label,detail].some(field=>String(field||'').toLowerCase().includes(text)));
    return matches.some(([,label])=>label.toLowerCase()===text)?matches:[...matches,...custom(search.value)];
  }
  function paint(){
    list.replaceChildren();let group;
    shown().forEach(([value,label,detail,disabled,heading],index)=>{
      if(heading&&heading!==group){group=heading;const title=document.createElement('div');title.className='new-tab-menu-group';title.setAttribute('role','presentation');title.textContent=heading;list.append(title);}
      const option=document.createElement('div');option.id=list.id+'-'+index;option.setAttribute('role','option');option.setAttribute('aria-selected',String(value===current()));
      if(disabled)option.setAttribute('aria-disabled','true');
      const key=document.createElement('kbd'),text=document.createElement('span');key.setAttribute('aria-hidden','true');if(index<9&&!query())key.textContent=index+1;else key.className='blank';text.textContent=label;option.append(key,text);
      if(detail){const small=document.createElement('small');small.textContent=detail;option.append(small);}
      option.onmousedown=event=>event.preventDefault();
      option.onclick=()=>{if(disabled)return;set(value);before=null;paint();$('new-tab-prompt').focus();};
      list.append(option);
    });
    const message=search&&query()&&!shown().length?'Model names use letters, digits and . - _ [ ] / : @':!query()&&note();
    if(message){const small=document.createElement('p');small.className='new-tab-menu-note';small.textContent=message;list.append(small);}
    const selected=list.querySelector('[aria-selected=true]');
    if(selected){chip.setAttribute('aria-activedescendant',selected.id);search?.setAttribute('aria-activedescendant',selected.id);if(!menu.hidden)selected.scrollIntoView({block:'nearest'});}
    else{chip.removeAttribute('aria-activedescendant');search?.removeAttribute('aria-activedescendant');}
  }
  function open(){
    if(chip.disabled)return;menu.hidden=false;
    // A long list opens upward only as far as the window allows; the rest scrolls.
    if(list!==menu)list.style.maxHeight=Math.max(120,Math.min(360,chip.getBoundingClientRect().top-(search?.offsetHeight||0)-32))+'px';
    paint();chip.setAttribute('aria-expanded','true');
  }
  function close(){menu.hidden=true;chip.setAttribute('aria-expanded','false');chip.removeAttribute('aria-activedescendant');if(search){search.value='';before=null;}}
  function pick(value){set(value);paint();}
  function step(delta){const usable=shown().filter(option=>!option[3]),index=usable.findIndex(option=>option[0]===current()),next=usable[(index+delta+usable.length)%usable.length];if(next)pick(next[0]);}
  // Focus moving between the chip and its search box keeps the menu open.
  const leave=event=>{if(event.relatedTarget!==chip&&!menu.contains(event.relatedTarget))close();};
  chip.addEventListener('focus',open);chip.addEventListener('blur',leave);
  // Safari does not focus a clicked button, so a click focuses it to show the list.
  chip.addEventListener('click',()=>{if(document.activeElement!==chip)chip.focus();else if(menu.hidden)open();});
  function keys(event){
    if(event.altKey||event.ctrlKey||event.metaKey)return;
    const typing=event.target===search;
    if(event.key==='ArrowDown'||(!typing&&event.key==='ArrowRight')){event.preventDefault();step(1);}
    else if(event.key==='ArrowUp'||(!typing&&event.key==='ArrowLeft')){event.preventDefault();step(-1);}
    else if(!typing&&/^[1-9]$/.test(event.key)){const option=options()[+event.key-1];if(option&&!option[3]){event.preventDefault();pick(option[0]);}}
    else if(!typing&&search&&event.key.length===1&&event.key!==' '){event.preventDefault();before=current();search.value=event.key;search.focus();filter();}
    else if(event.key==='Escape'&&typing&&before!==null){event.preventDefault();event.stopPropagation();set(before);before=null;$('new-tab-prompt').focus();}
    else if(event.key==='Enter'||(!typing&&event.key===' ')||event.key==='Escape'){event.preventDefault();event.stopPropagation();before=null;$('new-tab-prompt').focus();}
  }
  function filter(){
    if(before===null)before=current();
    const first=query()?shown().find(option=>!option[3]):null;set(first?first[0]:before);paint();
  }
  chip.addEventListener('keydown',keys);
  if(search){search.addEventListener('keydown',keys);search.addEventListener('input',filter);search.addEventListener('blur',leave);search.addEventListener('focus',()=>{if(menu.hidden)open();});}
  return {close,refresh(){if(!menu.hidden)paint();}};
}
const newTabModelMenu=newTabChipMenu($('new-tab-model'),$('new-tab-model-menu'),newTabModelOptions,()=>newTabModelValue,value=>{setNewTabModel(value);$('new-tab-progress').textContent='Model: '+$('new-tab-model-alias').textContent;},{search:$('new-tab-model-search'),custom:newTabCustomModels,note:newTabModelNote});
const newTabMachineMenu=newTabChipMenu($('new-tab-machine'),$('new-tab-machine-menu'),()=>[...$('new-tab-target').options].map(option=>[option.value,option.textContent.replace(/ · no session$/,''),option.disabled?'no session':'',option.disabled]),()=>$('new-tab-target').value,value=>{$('new-tab-target').value=value;$('new-tab-target').dispatchEvent(new Event('change'));$('new-tab-progress').textContent='Computer: '+$('new-tab-target').selectedOptions[0].textContent;});
// Project: a chip that opens the folder search.
function openNewTabProjectPicker(){
  if($('new-tab-project-chip').disabled)return;
  $('new-tab-project-popover').hidden=false;$('new-tab-project-chip').setAttribute('aria-expanded','true');
  const input=$('new-tab-project');input.focus();input.select();newTabProjectLookup.open(true);
}
function closeNewTabProjectPicker(focusPrompt){
  if($('new-tab-project-popover').hidden)return;
  newTabProjectLookup.close();$('new-tab-project-popover').hidden=true;$('new-tab-project-chip').setAttribute('aria-expanded','false');
  if(focusPrompt)$('new-tab-prompt').focus();
}
$('new-tab-project-chip').onclick=()=>$('new-tab-project-popover').hidden?openNewTabProjectPicker():closeNewTabProjectPicker(true);
$('new-tab-project-popover').addEventListener('focusout',event=>{if(!$('new-tab-project-popover').contains(event.relatedTarget)&&event.relatedTarget!==$('new-tab-project-chip'))closeNewTabProjectPicker(false);});
function paintNewTabProjectChip(){
  const project=$('new-tab-project').value.trim();
  $('new-tab-project-chip-prefix').hidden=!project||/^(?:[A-Za-z]:[\\/]|\/)/.test(project);$('new-tab-project-chip-name').textContent=project||'choose a folder';
}
// Each browser remembers the last project per computer; switchboard is the default.
function newTabSavedProject(host){try{return JSON.parse(localStorage.getItem('switchboard-new-tab-projects')||'{}')[host]||'switchboard';}catch(_){return 'switchboard';}}
function saveNewTabProject(host,project){try{const saved=JSON.parse(localStorage.getItem('switchboard-new-tab-projects')||'{}');saved[host]=project;localStorage.setItem('switchboard-new-tab-projects',JSON.stringify(saved));}catch(_){}}
let newTabProjectEdited=false;
$('new-tab-close').onclick=()=>$('new-tab-dialog').close();
// Focus order: Shift+Tab from the prompt walks back through model, project and computer;
// Tab from any of them returns to the prompt. Tab from the prompt reaches attach, send and close.
$('new-tab-dialog').addEventListener('keydown',event=>{
  if(event.key!=='Tab'||event.altKey||event.ctrlKey||event.metaKey)return;
  const picker=$('new-tab-project-popover'),inPicker=picker.contains(document.activeElement);
  // In the project search, Tab is the lookup's own (fill, then back to the prompt).
  if(inPicker&&!event.shiftKey)return;
  const chips=['new-tab-machine','new-tab-project-chip','new-tab-model'];
  const ring=[...chips,'new-tab-prompt','new-tab-attach','new-tab-submit','new-tab-close'].map($).filter(element=>!element.disabled&&element.getClientRects().length);
  const from=inPicker?$('new-tab-project-chip'):document.activeElement===$('new-tab-model-search')?$('new-tab-model'):document.activeElement,index=ring.indexOf(from);if(index<0)return;
  const next=!event.shiftKey&&chips.includes(from.id)?$('new-tab-prompt'):ring[(index+(event.shiftKey?-1:1)+ring.length)%ring.length];
  event.preventDefault();
  if(next===$('new-tab-project-chip'))openNewTabProjectPicker();else{closeNewTabProjectPicker(false);next.focus();}
},true);
// The prompt grows with its text, up to a limit where it scrolls.
function fitNewTabPrompt(){const input=$('new-tab-prompt');input.style.height='';input.style.height=Math.min(input.scrollHeight+2,Math.max(innerHeight*.4,160))+'px';}
$('new-tab-prompt').addEventListener('input',fitNewTabPrompt);
$('new-tab').onclick=()=>openNewTabDialog(false);
$('new-admin-tab').onclick=()=>openNewTabDialog(true);
function openNewTabDialog(elevated){
  clearNewTabHandover();
  newTabElevated=elevated;
  $('new-tab-title').textContent=elevated?'New administrator tab':'New tab';
  // A fresh dialog cancels any submission still uploading for the previous one.
  $('new-tab-form').pendingSubmission=null;newTabBusy(false);
  $('new-tab-prompt').value='';clearNewTabFiles();newTabProjectLookup.close();
  // Each browser remembers its last model, listed or typed; Sol is the default.
  let model='csol';try{model=localStorage.getItem('switchboard-new-tab-model')||model;}catch(_){}
  setNewTabModel(model);newTabSubmitText();
  $('new-tab-dialog').classList.toggle('elevated',elevated);
  $('new-tab-note').textContent=elevated?'Runs as administrator. Someone at that computer must approve it (UAC on Windows, sudo elsewhere).':'';
  const select=$('new-tab-target');select.replaceChildren();
  const current=allTabs().find(t=>t.key===selected)?.entry;
  for(const [key,entry] of [...sessions].sort((a,b)=>Number(b[1]===current)-Number(a[1]===current)||Number(b[1].name==='main')-Number(a[1].name==='main'))){
    if([...select.options].some(option=>JSON.parse(option.value)[0]===entry.host))continue;
    if(!sessionTabs(entry).length)continue;
    const option=document.createElement('option');option.value=key;option.textContent=hosts.get(entry.host)?.name||entry.host;option.selected=entry===current;select.append(option);
  }
  // A machine's first session starts a plain shell, so it cannot be elevated.
  if(!elevated)for(const host of hosts.values()){
    const name=firstSessionName(host);
    if(!name||[...select.options].some(option=>option.value===sessionKey(host.id,name)))continue;
    const option=document.createElement('option');option.value=sessionKey(host.id,name);option.textContent=host.name;select.append(option);
  }
  if(!select.options.length){setStatus(elevated&&hosts.size?'Open a regular tab on the machine first, then an administrator tab.':'No machines are connected. Check your machines in Settings.',true);return;}
  // A computer without a terminal session is shown but cannot be chosen.
  for(const option of select.options){const problem=newTabTargetProblem(option.value);if(problem?.[1]==='target'){option.disabled=true;option.textContent+=' · no session';}}
  if(select.selectedOptions[0]?.disabled){const usable=[...select.options].find(option=>!option.disabled);if(usable)select.value=usable.value;}
  newTabRetrying=false;newTabSubmitText();paintNewTabMachine();closeNewTabProjectPicker(false);
  newTabProjectEdited=false;clearNewTabFieldProblem();$('new-tab-project').value=newTabSavedProject(JSON.parse(select.value)[0]);updateNewTabProject();
  loadNewTabProjects();loadNewTabCodexModels();
  $('new-tab-dialog').showModal();fitNewTabPrompt();fitNewTabDialog();
  $('new-tab-prompt').focus();
}
function newTabLookup(inputId,listId,buttonId,items,emptyText,onChange=()=>{},next=null){
  const input=$(inputId),list=$(listId),button=$(buttonId),popup=list.parentElement;let index=-1,showAll=false;
  const status=popup.querySelector('.new-tab-options-status'),hint=popup.querySelector('.new-tab-options-hint');
  function showHint(){const name=list.querySelectorAll('[role=option] span')[index]?.textContent;hint.replaceChildren();if(!name){hint.textContent='Choose a folder, or type a full path';return;}const enter=document.createElement('kbd'),tab=document.createElement('kbd');enter.textContent='↵';tab.textContent='Tab';hint.append(enter,' Open tab in '+name+'  ·  ',tab,' Fill');}
  function close(){popup.hidden=true;index=-1;input.setAttribute('aria-expanded','false');button.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');input.dispatchEvent(new Event('lookuptoggle'));}
  function highlight(next){index=next;showHint();[...list.querySelectorAll('[role=option]')].forEach((option,i)=>option.setAttribute('aria-selected',String(i===index)));const option=list.querySelectorAll('[role=option]')[index];if(option)input.setAttribute('aria-activedescendant',option.id);}
  // A tapped or clicked suggestion moves on to the next field; the keyboard keeps its place.
  function choose(value,pointer=false){input.value=value;onChange();close();if(pointer&&next)$(next).focus();else{input.focus();input.select();}}
  function open(all=false){
    showAll=all;const query=all?'':input.value.toLowerCase();list.replaceChildren();index=-1;input.removeAttribute('aria-activedescendant');
    const matches=items().filter(([name,detail])=>(name+' '+detail).toLowerCase().includes(query));
    const rank=([name])=>name.toLowerCase()===query?2:name.toLowerCase().startsWith(query)?1:0;
    matches.sort((a,b)=>rank(b)-rank(a));
    for(const [name,detail] of matches){
      const option=document.createElement('div');option.id=listId+'-'+list.children.length;option.setAttribute('role','option');option.setAttribute('aria-selected','false');
      const text=document.createElement('span'),description=document.createElement('small');const at=query?name.toLowerCase().indexOf(query):-1;
      if(at<0)text.textContent=name;else{const match=document.createElement('b');match.textContent=name.slice(at,at+query.length);text.append(name.slice(0,at),match,name.slice(at+query.length));}
      description.textContent=detail;option.append(text,description);
      option.onmousedown=event=>event.preventDefault();option.onclick=()=>choose(name,true);list.append(option);
    }
    status.textContent=!matches.length&&emptyText?emptyText():'';
    hint.hidden=!matches.length||matchMedia('(pointer:coarse)').matches;showHint();
    popup.hidden=!matches.length&&!status.textContent;input.setAttribute('aria-expanded',String(!popup.hidden));button.setAttribute('aria-expanded',String(!popup.hidden));input.dispatchEvent(new Event('lookuptoggle'));
    if(matches.length&&query)highlight(0);
  }
  input.oninput=()=>{onChange();open();};input.onblur=close;input.onclick=()=>{if(popup.hidden)open(true);};button.onmousedown=event=>event.preventDefault();
  button.onclick=()=>{const shown=!popup.hidden;input.focus();if(shown)close();else open(true);};
  input.onkeydown=event=>{
    if(event.isComposing)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();if(popup.hidden)open(true);const count=list.querySelectorAll('[role=option]').length;
      if(count)highlight(index<0?(event.key==='ArrowDown'?0:count-1):(index+(event.key==='ArrowDown'?1:count-1))%count);
      list.querySelectorAll('[role=option]')[index]?.scrollIntoView({block:'nearest'});
    }else if(event.key==='Escape'&&!popup.hidden){event.preventDefault();event.stopPropagation();close();
    }else if((event.key==='Enter'||(event.key==='Tab'&&!event.shiftKey))&&!popup.hidden&&index>=0){
      // Tab fills the suggestion and moves on; Enter fills it before the form submits.
      choose(list.querySelectorAll('[role=option]')[index].firstChild.textContent);
    }
  };
  return {close,open,refresh(){if(!popup.hidden)open(showAll);}};
}
function updateNewTabProject(){
  const project=$('new-tab-project').value.trim(),folder=/^(?:[A-Za-z]:[\\/]|\/)/.test(project)?project:'~/git/'+project;
  $('new-tab-project-help').textContent=project?folder:'';$('new-tab-project').title=project?folder:'';paintNewTabProjectChip();
  // The folder is shown only for names the computer did not list, as a check before launching.
  const state=$('new-tab-project-help').dataset.state=!project||/^(?:[A-Za-z]:[\\/]|\/)/.test(project)?'path':newTabProjects.includes(project)?'known':newTabProjects.length?'unknown':'pending';
  $('new-tab-project-field').dataset.state=state;if(!$('new-tab-form').pendingSubmission)newTabSubmitText();
  const guess=state==='unknown'?closestNewTabProject(project):'';
  const computer=$('new-tab-target').selectedOptions[0]?.textContent||'this computer';
  $('new-tab-project-warning-text').textContent=state==='unknown'?folder+' isn’t on '+computer+'. The tab would open in the session’s starting folder instead.':'';
  $('new-tab-project-guess-row').hidden=!guess;$('new-tab-project-guess').textContent=guess;$('new-tab-project-guess').dataset.name=guess;
}
let newTabProjects=[],newTabProjectMessage='',newTabProjectRequest;
const newTabProjectLookup=newTabLookup('new-tab-project','new-tab-projects','new-tab-project-lookup',()=>newTabProjects.map(name=>[name,'']),()=>newTabProjectMessage||'No matching folders in ~/git. Type a name or a full path.',()=>{newTabProjectEdited=true;updateNewTabProject();},'new-tab-prompt');
// Registered after the lookup's own keys: Tab fills the name, then returns to the prompt.
$('new-tab-project').addEventListener('keydown',event=>{if(event.key==='Tab'&&!event.shiftKey){event.preventDefault();closeNewTabProjectPicker(true);}});
// The closest listed name, by containment or a small edit distance.
function closestNewTabProject(project){
  const query=project.toLowerCase();let best='',bestScore=Infinity;
  for(const name of newTabProjects){
    const lower=name.toLowerCase();let score;
    if(lower.includes(query)||query.includes(lower))score=Math.abs(lower.length-query.length)/10;
    else{let row=Array.from({length:lower.length+1},(_,i)=>i);for(let i=1;i<=query.length;i++){let previous=row[0];row[0]=i;for(let j=1;j<=lower.length;j++){const current=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,previous+(query[i-1]===lower[j-1]?0:1));previous=current;}}score=row[lower.length];}
    if(score<bestScore){best=name;bestScore=score;}
  }
  return bestScore<=Math.max(2,query.length/3)?best:'';
}
$('new-tab-project-guess').onclick=()=>{$('new-tab-project').value=$('new-tab-project-guess').dataset.name;newTabProjectEdited=true;updateNewTabProject();$('new-tab-prompt').focus();};
$('new-tab-project').addEventListener('lookuptoggle',()=>{if(!$('new-tab-form').pendingSubmission)newTabSubmitText();});
function newTabProjectStatus(state){$('new-tab-project-field').dataset.list=state;}
$('new-tab-project-retry').onclick=()=>{loadNewTabProjects();$('new-tab-project').focus();};
async function loadNewTabProjects(){
  newTabProjectRequest?.abort();const request=newTabProjectRequest=new AbortController();
  newTabProjects=[];newTabProjectMessage='Loading projects…';newTabProjectStatus('loading');newTabProjectLookup.refresh();
  const host=JSON.parse($('new-tab-target').value)[0];
  const timeout=setTimeout(()=>request.abort(),10000);
  try{
    const response=await fetch('/hosts/'+encodeURIComponent(host)+'/project-list',{signal:request.signal,cache:'no-store'});
    if(!response.ok)throw new Error('Projects unavailable');
    const names=await response.json();if(!Array.isArray(names)||!names.every(name=>typeof name==='string'))throw new Error('Invalid projects');
    if(request!==newTabProjectRequest)return;
    newTabProjects=names;newTabProjectMessage='';newTabProjectStatus('');updateNewTabProject();
  }catch(_){if(request!==newTabProjectRequest)return;newTabProjectMessage='Projects unavailable. Type a project name.';newTabProjectStatus('failed');}
  finally{clearTimeout(timeout);}
  newTabProjectLookup.refresh();
}
$('new-tab-target').onchange=()=>{
  closeNewTabProjectPicker(false);newTabProjectLookup.close();clearNewTabFieldProblem();paintNewTabMachine();
  for(const item of newTabFiles){delete item.uploaded;delete item.state;}paintNewTabFiles();
  if(!newTabProjectEdited&&!newTabHandover){$('new-tab-project').value=newTabSavedProject(JSON.parse($('new-tab-target').value)[0]);updateNewTabProject();}
  loadNewTabProjects();loadNewTabCodexModels();
};
function setHandoverProject(){
  const source=newTabHandover?.context?.source;if(!source?.project)return;
  $('new-tab-project').value=source.project;updateNewTabProject();
}
async function loadNewTabHandover(){
  const handover=newTabHandover;if(!handover)return;
  handover.request?.abort();const request=handover.request=new AbortController();handover.context=null;
  $('handover-summary').textContent='Loading context from '+handover.source.title+'…';$('handover-retry').hidden=true;newTabBusy(false);
  try{
    const context=await SwitchboardHandover.load(handover.source,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(60000)])});
    if(newTabHandover!==handover||handover.request!==request||!$('new-tab-dialog').open)return;
    handover.context=context;setHandoverProject();
    const coverage=context.coverage;
    $('handover-summary').textContent=`From ${handover.source.title} on ${handover.source.computer}`+(handover.source.project?` in ${handover.source.project}`:'')+` · ${coverage.included_messages} messages included`+(coverage.omitted_messages?` · ${coverage.omitted_messages} history entries omitted`:'')+(coverage.partial_history?' · Some source history is unavailable.':'.');
    $('handover-retry').textContent='Reload context';$('handover-retry').hidden=false;
    newTabBusy(false);
  }catch(error){if(newTabHandover!==handover||handover.request!==request)return;$('handover-summary').textContent=error.name==='TimeoutError'?'Loading context timed out. Retry when the source computer is connected.':error.message;$('handover-retry').textContent='Retry loading context';$('handover-retry').hidden=false;}
}
$('handover-retry').onclick=loadNewTabHandover;
// A click on the backdrop closes a dialog. Both press and release must land
// outside, so selecting text inside and releasing outside keeps it open.
for(const dialog of document.querySelectorAll('dialog')){
  let pressedOutside=false;
  const outside=event=>{
    const bounds=dialog.getBoundingClientRect();
    return event.target===dialog&&(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom);
  };
  dialog.addEventListener('pointerdown',event=>{pressedOutside=outside(event);});
  dialog.addEventListener('click',event=>{if(pressedOutside&&outside(event))dialog.close();pressedOutside=false;});
}
// Native creation uses a short CLI request, never a terminal viewer. This keeps
// Conversation open without letting a phone constrain an existing tab's size.
async function createConversationTab(key,launch,typed=launch.prompt){
  const [hostId,name]=JSON.parse(key),host=hosts.get(hostId);if(!host||host.error)return;
  const entry=sessions.get(key)||connectSession(host,name,true);
  if(entry.pendingNewTab){setStatus('A tab is already being created on this computer.',true);return;}
  const pending=entry.pendingNewTab=new Set(sessionTabs(entry).map(tab=>tabKey(entry,tab)));
  pending.requestId=entry.newTabRequestId=(entry.newTabRequestId||0)+1;pending.api=true;
  const text=typeof typed==='string'?typed:'',images=launch.images?.length||0;
  const started=text.trim()||images?{text:text.trim()?text:images===1?'Image attached':`${images} images attached`,agent:newTabModelProvider(launch.command),at:Date.now()}:null;
  entry.creatingTab={id:'creating',pending:true,name:'Creating tab…',position:Infinity,panes:[],launch:started};
  const placeholder=selected=tabKey(entry,entry.creatingTab);restoringTab=false;entry.followActiveTab=false;
  if(filter!=='all'&&groups[hostId]!==filter)setFilter('all');$('tab-search').value='';
  sidebarOpen=false;updateSidebar();$('new-tab-dialog').close();render();globalThis.SwitchboardConversation.focus();
  try{
    const response=await fetch(`/hosts/${encodeURIComponent(hostId)}/new-tab`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:name,...launch})});
    if(!response.ok)throw Error(response.status===404?'Update Switchboard on this computer to create tabs from Conversation.':await response.text());
    const result=await response.json();if(!Number.isInteger(result.pane_id)||result.pane_id<0)throw Error('The new tab did not return its identity. Check the tab list before retrying.');
    if(entry.pendingNewTab!==pending)return;
    entry.apiCreationPane=result.pane_id;
    if(started)launches.set(JSON.stringify([hostId,name,result.pane_id]),started);
    const tab={id:result.pane_id,pending:true,name:'New tab',position:Infinity,panes:[{pane_id:result.pane_id,is_plugin:false,tab_position:Infinity}],launch:started};
    entry.provisionalTabs??=[];entry.provisionalTabs.push(tab);entry.creatingTab=null;entry.pendingNewTab=null;
    if(selected===placeholder)selected=tabKey(entry,tab);
    render();refreshAttention(true);refresh();
  }catch(error){failNewTab(entry,pending.requestId,error.message||'Could not confirm tab creation. Check the tab list before retrying.');}
}
let newTabFiles=[];
function clearNewTabFiles(){
  for(const item of newTabFiles)if(item.preview)URL.revokeObjectURL(item.preview);
  newTabFiles=[];paintNewTabFiles();$('new-tab-error').textContent='';
}
function newTabBusy(busy){
  $('new-tab-close').title=busy?'Stop and close · Esc':'Close · Esc';$('new-tab-close').setAttribute('aria-label',busy?'Stop upload and close':'Close');$('new-tab-form').classList.toggle('busy',busy);
  for(const control of $('new-tab-form').querySelectorAll('input,textarea,select,button'))control.disabled=busy&&control.id!=='new-tab-close';
  if(newTabHandover){$('new-tab-target').disabled=true;$('new-tab-project').disabled=true;}
  $('new-tab-submit').disabled=busy||newTabTargetBlocked||!!newTabHandover&&!newTabHandover.context;
}
function paintNewTabFiles(){
  const files=$('new-tab-files');files.replaceChildren();
  for(const item of newTabFiles){
    const chip=document.createElement('div');chip.className='new-tab-file';chip.title=item.file.name;chip.setAttribute('role','listitem');
    if(item.preview){const img=document.createElement('img');img.src=item.preview;img.alt='';chip.append(img);}
    else{const icon=document.createElement('i');icon.setAttribute('aria-hidden','true');icon.textContent=(item.file.name.match(/\.([a-z0-9]{1,4})$/i)?.[1]||'file').toLowerCase();chip.append(icon);}
    const name=document.createElement('span'),full=item.file.name;name.textContent=full.length>24?full.slice(0,13)+'…'+full.slice(-8):full;
    const size=document.createElement('small');size.textContent=formatNewTabSize(item.file.size);chip.append(name,size);
    if(item.state){
      chip.classList.add(item.state);
      const state=document.createElement('b');state.className='new-tab-file-state '+item.state;state.setAttribute('role','img');state.setAttribute('aria-label',{done:'Uploaded',failed:'Upload failed',uploading:'Uploading'}[item.state]);chip.append(state);
      if(item.state==='uploading'){files.append(chip);continue;}
    }
    const remove=document.createElement('button');remove.type='button';remove.disabled=!!$('new-tab-form').pendingSubmission;remove.textContent='×';remove.setAttribute('aria-label','Remove '+item.file.name);
    remove.onclick=()=>{
      const index=newTabFiles.indexOf(item);newTabFiles=newTabFiles.filter(file=>file!==item);if(item.preview)URL.revokeObjectURL(item.preview);paintNewTabFiles();
      $('new-tab-progress').textContent='Removed '+item.file.name;
      ($('new-tab-files').querySelectorAll('button')[Math.min(index,newTabFiles.length-1)]||$('new-tab-attach')).focus();
    };chip.append(remove);files.append(chip);
  }
}
function newTabUploadStatus(text){$('new-tab-close').title=text||'Close · Esc';}
function uploadNewTabFile(host,item,signal,onProgress){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/api/hosts/'+encodeURIComponent(host)+'/attachments?'+new URLSearchParams({name:item.file.name}));
    xhr.setRequestHeader('Content-Type','application/octet-stream');
    xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(event.loaded);};
    xhr.onload=()=>resolve({ok:xhr.status>=200&&xhr.status<300,text:xhr.responseText});
    xhr.onerror=()=>reject(Error('Could not upload '+item.file.name+'. Check the connection, then retry; uploaded files are kept.'));
    xhr.onabort=()=>reject(new DOMException('Upload cancelled','AbortError'));
    if(signal.aborted)return reject(new DOMException('Upload cancelled','AbortError'));
    signal.addEventListener('abort',()=>xhr.abort(),{once:true});xhr.send(item.file);
  });
}
function formatNewTabSize(bytes){return bytes<1024?bytes+' B':bytes<1048576?Math.round(bytes/1024)+' KB':(bytes/1048576).toFixed(1)+' MB';}
function addNewTabFiles(files){
  $('new-tab-error').textContent='';
  if(newTabHandover){$('new-tab-error').textContent='Switch models first, then attach files in the conversation.';return;}
  const added=[];
  for(const file of files){
    if(newTabFiles.length>=8){$('new-tab-error').textContent=`Attach up to 8 files. ${file.name} was not attached.`;break;}
    if(!file.size||file.size>20*1024*1024){$('new-tab-error').textContent=`${file.name} is ${file.size?'over 20 MB':'empty'}, so it was not attached.`;continue;}
    newTabFiles.push({file,preview:file.type.startsWith('image/')?URL.createObjectURL(file):null});added.push(file.name);
  }
  paintNewTabFiles();if(added.length)$('new-tab-progress').textContent='Attached '+added.join(', ');
}
$('new-tab-attach').onclick=()=>$('new-tab-picker').click();
$('new-tab-picker').onchange=()=>{addNewTabFiles([...$('new-tab-picker').files]);$('new-tab-picker').value='';};
$('new-tab-prompt').addEventListener('paste',event=>{
  const files=[...(event.clipboardData?.files||[])];if(files.length){event.preventDefault();addNewTabFiles(files);const text=event.clipboardData.getData('text/plain');if(text){const input=$('new-tab-prompt');input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');}}
});
// Dragging files over the dialog highlights the prompt, where they land.
let newTabDragDepth=0;
function newTabDragging(on){$('new-tab-form').querySelector('.new-tab-composer').classList.toggle('dragging',on&&!newTabHandover);}
$('new-tab-form').addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')){newTabDragDepth++;newTabDragging(true);}});
$('new-tab-form').addEventListener('dragleave',()=>{if(newTabDragDepth&&!--newTabDragDepth)newTabDragging(false);});
$('new-tab-form').addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
$('new-tab-form').addEventListener('drop',event=>{newTabDragDepth=0;newTabDragging(false);if(event.dataTransfer?.files.length){event.preventDefault();addNewTabFiles([...event.dataTransfer.files]);}});
$('new-tab-prompt').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!(matchMedia('(pointer:coarse)').matches&&!matchMedia('(any-pointer:fine)').matches)){event.preventDefault();$('new-tab-form').requestSubmit();}};
// On a phone the sheet rests on the on-screen keyboard, so Create stays in reach.
function fitNewTabDialog(){
  const dialog=$('new-tab-dialog'),view=globalThis.visualViewport,fit=dialog.open&&view&&matchMedia('(max-width:700px), (pointer:coarse)').matches;
  dialog.style.marginBottom=fit?Math.max(0,innerHeight-view.offsetTop-view.height)+'px':'';dialog.style.maxHeight=fit?view.height-12+'px':'';
}
globalThis.visualViewport?.addEventListener('resize',fitNewTabDialog);globalThis.visualViewport?.addEventListener('scroll',fitNewTabDialog);
// The close event is queued; a reopen before it arrives owns the dialog, so leave its draft alone.
$('new-tab-dialog').addEventListener('close',()=>{if($('new-tab-dialog').open)return;$('new-tab-form').pendingSubmission?.uploads?.abort();$('new-tab-form').pendingSubmission=null;clearNewTabHandover();newTabBusy(false);clearNewTabFiles();runPendingSwitches();});
$('new-tab-form').onsubmit=async event=>{
  event.preventDefault();const form=$('new-tab-form');if(form.pendingSubmission)return;
  const key=$('new-tab-target').value,project=$('new-tab-project').value.trim(),command=newTabModel(),text=$('new-tab-prompt').value,files=[...newTabFiles],elevated=newTabElevated;
  const handover=newTabHandover?.context,source=newTabHandover?.source;if(newTabHandover&&!handover)return;
  if(/[\x00-\x08\x0b-\x1f\x7f]/.test(text)||new TextEncoder().encode(text).length>16000){$('new-tab-error').textContent='Use a prompt up to 16 KB without control characters.';return;}
  // Check the computer before spending time on uploads.
  $('new-tab-error').textContent='';clearNewTabFieldProblem();
  // A busy agent is never interrupted; the switch waits for its turn to end.
  if(handover&&!switchNow(source)){queueSwitch(source,command,text);return;}
  if(!handover){const problem=newTabTargetProblem(key);if(problem){newTabProblem(...problem);return;}}
  const request={};form.pendingSubmission=request;newTabBusy(true);
  const isCurrent=()=>form.pendingSubmission===request&&$('new-tab-dialog').open;
  const host=JSON.parse(key)[0],pending=files.filter(item=>item.uploaded?.host!==host);let uploadedCount=0;
  for(const item of pending)item.state='uploading';paintNewTabFiles();
  newTabRetrying=false;
  const uploadLabel=pending.length===1?'Uploading file':`Uploading ${pending.length} files`,total=pending.reduce((sum,item)=>sum+item.file.size,0),sent=new Map();
  const showProgress=()=>newTabSubmitText(`Uploading ${Math.floor([...sent.values()].reduce((sum,bytes)=>sum+bytes,0)*100/(total||1))}%…`,false);
  if(pending.length){showProgress();$('new-tab-progress').textContent=uploadLabel+'…';newTabUploadStatus(matchMedia('(pointer:coarse)').matches?'Closing cancels and discards the upload':'Esc closes the dialog and discards the upload');}
  else newTabSubmitText(handover?'Switching…':'Creating…');
  const uploads=request.uploads=new AbortController();
  try{
    const images=[],others=[];
    // Upload together: each one is a round trip to the destination computer.
    // A file the computer already confirmed is not sent again on retry.
    const uploaded=await Promise.all(files.map(async item=>{
      if(item.uploaded?.host===host)return item.uploaded.path;
      const fail=message=>{item.state='failed';paintNewTabFiles();return Error(message);};
      let response;
      try{response=await uploadNewTabFile(host,item,uploads.signal,bytes=>{sent.set(item,bytes);showProgress();});}
      catch(error){throw error.name==='AbortError'?error:fail(error.message);}
      if(!isCurrent())return null;
      if(!response.ok)throw fail('Could not upload '+item.file.name+'. Retry sends it again; uploaded files are kept.');
      let data={};try{data=JSON.parse(response.text);}catch(_){}
      if(typeof data.path!=='string'||!data.path||/[\x00-\x1f]/.test(data.path))throw fail('Invalid response for '+item.file.name+'. Retry sends it again.');
      item.uploaded={host,path:data.path};item.state='done';paintNewTabFiles();
      uploadedCount++;if(uploadedCount<pending.length)$('new-tab-progress').textContent=`Uploaded ${uploadedCount} of ${pending.length} files…`;
      return data.path;
    }));
    if(!isCurrent())return;
    newTabUploadStatus('');if(pending.length)newTabSubmitText(handover?'Switching…':'Creating…');
    files.forEach((item,index)=>(item.file.type.startsWith('image/')?images:others).push(uploaded[index]));
    if(handover){
      newTabSubmitText('Preparing handover…');
      // Context reloads so a turn that ended while the dialog was open is included.
      if(!await switchAgentModel(source,command,text,null,isCurrent))return;
      pendingSwitches.delete(source.tab);
      try{localStorage.setItem('switchboard-new-tab-model',command);}catch(_){}
      if(isCurrent())$('new-tab-dialog').close();
      await refreshAttention(true);setStatus('Continuing with '+(newTabModelProvider(command)==='claude'?'Claude':'Codex')+' in the same tab.');return;
    }
    const prompt=text+(others.length?'\n\nAttached files:\n'+others.join('\n'):'');
    if(new TextEncoder().encode(prompt).length>16000)throw Error('The prompt and file paths must fit within 16 KB.');
    try{localStorage.setItem('switchboard-new-tab-model',command);}catch(_){}
    saveNewTabProject(host,project);
    await createNewTab(key,{project,command,prompt,images,elevated},isCurrent,text);
  }catch(error){if(isCurrent()){uploads.abort();newTabRetrying=true;newTabProblem(error.message);}}
  finally{if(form.pendingSubmission===request){form.pendingSubmission=null;newTabUploadStatus('');for(const item of files)if(item.state==='uploading')delete item.state;paintNewTabFiles();newTabBusy(false);newTabSubmitText();}}
};
async function createNewTab(key,launch,isCurrent=()=>true,typed){
  if(!launch.project||(!launch.command&&typeof launch.prompt!=='string'))return;
  if(globalThis.SwitchboardConversation?.wantsConversation?.())return createConversationTab(key,launch,typed??launch.prompt);
  let entry=sessions.get(key);
  // A recently resumed Terminal may still be connecting. Keep the dialog
  // usable without mistaking that session for an empty host.
  if(entry&&!entry.state&&sessionTabs(entry).length){
    const deadline=Date.now()+10000;
    while(isCurrent()&&sessions.get(key)===entry&&!entry.state&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    if(!isCurrent())return;
    if(sessions.get(key)!==entry||!entry.state){newTabProblem('That computer’s terminal is still connecting. Retry in a moment.');return;}
  }
  if(!entry?.state){
    const [id,name]=JSON.parse(key),host=hosts.get(id);
    if(firstSessionName(host)!==name){newTabProblem(noSessionMessage(id),'target');return;}
    if(entry&&!entry.starting){entry.frame.remove();sessions.delete(key);}
    const created=connectSession(host,name,true);created.selectOnStart=true;created.launchOnStart=launch;
    if(filter!=='all'&&groups[id]!==filter)setFilter('all');$('tab-search').value='';
    // Closing the dialog returns focus to +; restore the current viewing surface.
    $('new-tab-dialog').close();render();if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();else created.frame.focus();return;
  }
  if(!sessionTabs(entry).length){newTabProblem(noSessionMessage(entry.host),'target');return;}
  if(entry.pendingNewTab||entry.requestedPane||entry.focusPending){newTabProblem('Another tab is still opening on '+(hosts.get(entry.host)?.name||'that computer')+'. Retry in a moment.');return;}
  const pending=entry.pendingNewTab=new Set(sessionTabs(entry).map(tab=>tabKey(entry,tab)));
  pending.requestId=entry.newTabRequestId=(entry.newTabRequestId||0)+1;
  pending.startedAt=performance.timeOrigin+performance.now();
  pending.paneIds=new Set((entry.state.panes||[]).filter(p=>!p.is_plugin).map(p=>p.pane_id));
  if(entry.state.active_pane&&!entry.state.active_pane.is_plugin)pending.paneIds.add(entry.state.active_pane.pane_id);
  entry.creatingTab={id:'creating',pending:true,name:'Creating tab…',position:Infinity,panes:[]};
  selected=tabKey(entry,entry.creatingTab);
  restoringTab=false;entry.followActiveTab=true;
  if(filter!=='all'&&groups[entry.host]!==filter)setFilter('all');$('tab-search').value='';
  sidebarOpen=false;updateSidebar();$('artifact-preview').hidden=true;$('artifact-frame').contentWindow?.location.replace('about:blank');
  $('new-tab-dialog').close();render();
  // Keyboard dismissal can leave focus on the hidden session selector, then
  // move it to the body. Restore the viewing surface before creation records it.
  if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();else entry.frame.focus();
  entry.frame.contentWindow.postMessage({type:'zellij-new-tab',...launch,request_id:pending.requestId,started_at:pending.startedAt},location.origin);
  setStatus(`Creating a tab on ${hosts.get(entry.host)?.name}…`);
  setTimeout(()=>failNewTab(entry,pending.requestId,'No new tab received. Check the connection and try again.'),30000);
};
// A problem while the dialog is open shows in the dialog; the status bar sits under its backdrop.
// The checks createNewTab makes, run before uploads; [message, field] or null.
function newTabTargetProblem(key){
  const entry=sessions.get(key),[id,name]=JSON.parse(key);
  if(entry&&!entry.state&&sessionTabs(entry).length)return null;
  if(!entry?.state)return firstSessionName(hosts.get(id))===name?null:[noSessionMessage(id),'target'];
  if(!sessionTabs(entry).length)return [noSessionMessage(id),'target'];
  if(entry.pendingNewTab||entry.requestedPane||entry.focusPending)return ['Another tab is still opening on '+(hosts.get(id)?.name||'that computer')+'. Retry in a moment.'];
  return null;
}
function newTabProblem(message,field='prompt'){
  if(!$('new-tab-dialog').open){setStatus(message,true);return;}
  if(field!=='target'&&!$('new-tab-form').pendingSubmission){newTabRetrying=true;newTabSubmitText();}
  if(field==='target'){$('new-tab-target-error').textContent=message;$('new-tab-target').setAttribute('aria-invalid','true');newTabTargetBlocked=true;$('new-tab-submit').disabled=true;newTabSubmitText();}
  else $('new-tab-error').textContent=message;
  setTimeout(()=>(field==='target'?$('new-tab-machine'):$('new-tab-prompt')).focus());
}
let newTabTargetBlocked=false;
function clearNewTabFieldProblem(){
  $('new-tab-target-error').textContent='';$('new-tab-target').removeAttribute('aria-invalid');
  if(newTabTargetBlocked){newTabTargetBlocked=false;if(!$('new-tab-form').pendingSubmission){newTabBusy(false);newTabSubmitText();}}
}
function noSessionMessage(id){return (hosts.get(id)?.name||'That computer')+' has no terminal session to open a tab in. Choose another computer.';}
$('ready').onclick=()=>{
  const item=contextItem;if(!item)return;
  ready[item.key]=Date.now();saveReady();
  closeTabMenu(true);render();
};
$('settings').onclick=()=>openPanel('settings');
$('size-owner').onclick=()=>{
  const item=contextItem;
  if(!item || $('size-owner').disabled)return;
  item.entry.frame.contentWindow.postMessage({type:'zellij-size-owner',tab_position:item.tab.position,owned:true},location.origin);
  closeTabMenu(true);
};
// One panel holds Messages, Computers, Updates, Logs and Settings over the
// terminals, so terminal iframes and their sockets stay connected. Messages and
// Computers stay standalone pages, embedded per section; their links to each
// other are hidden there, since each is a tab. Modified clicks still open a real page.
const panel=$('panel'),panelTabs=[...$('panel-tabs').querySelectorAll('[role=tab]')];
const panelPages={'/messages.html':'messages','/computers.html':'computers'};
function sectionLink(event){
  const link=event.target.closest?.('a[href="/messages.html"],a[href="/computers.html"]');
  if(!link||event.defaultPrevented||event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return null;
  event.preventDefault();
  return panelPages[link.pathname];
}
function showSection(name,focusTab=false){
  for(const tab of panelTabs){
    const on=tab.dataset.section===name,section=$(tab.getAttribute('aria-controls'));
    tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;section.hidden=!on;
    if(!on)continue;
    $('panel-title').textContent=tab.textContent;
    const frame=section.querySelector('iframe');
    if(frame&&frame.getAttribute('src')!==frame.dataset.src)frame.src=frame.dataset.src;
    if(focusTab)tab.focus();
  }
  if(name==='logs')loadLogs();
  if(name==='health')globalThis.SwitchboardTasks?.load();
}
function openPanel(name){
  showSection(name);
  if(!panel.open)panel.showModal();
  panelTabs.find(tab=>tab.dataset.section===name).focus();
}
document.addEventListener('click',event=>{const name=sectionLink(event);if(name)openPanel(name);});
$('panel-tabs').onclick=event=>{const tab=event.target.closest('[role=tab]');if(tab)showSection(tab.dataset.section,true);};
$('panel-tabs').onkeydown=event=>{
  const tabs=panelTabs.filter(tab=>!tab.hidden),index=tabs.indexOf(document.activeElement),last=tabs.length-1;
  const next={ArrowDown:index+1,ArrowRight:index+1,ArrowUp:index-1,ArrowLeft:index-1,Home:0,End:last}[event.key];
  if(next===undefined||index<0)return;
  event.preventDefault();
  showSection(tabs[(next+last+1)%(last+1)].dataset.section,true);
};
for(const frame of panel.querySelectorAll('iframe'))frame.onload=()=>{
  const doc=frame.contentDocument;
  if(!doc||!panelPages[frame.contentWindow.location.pathname])return;
  // The panel header and tabs replace the page's title, back link and links to
  // other sections; align the page with the panel's content edge and background.
  const style=doc.createElement('style');style.textContent='a[href="/"],a[href="/messages.html"],a[href="/computers.html"],h1{display:none!important}:root{background:#111318}body{margin-left:0;margin-right:0}';doc.head.append(style);
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented)panel.close();});
};
$('close-panel').onclick=()=>panel.close();
panel.onclose=()=>{
  for(const frame of panel.querySelectorAll('iframe'))frame.src='about:blank';
  const item=allTabs().find(item=>item.key===selected);
  if(item&&$('artifact-preview').hidden&&!document.querySelector('dialog[open]'))focus(item);
};
$('refresh').onclick=async()=>{
  const button=$('refresh');button.disabled=true;button.textContent='Refreshing…';
  try{await refresh();}finally{button.disabled=false;button.textContent='Refresh';}
};
async function loadLogs(){
  const list=$('logs'),button=$('refresh-logs');
  const element=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;node.textContent=text;return node;};
  button.disabled=true;list.setAttribute('aria-busy','true');
  try{
    const response=await fetch('/api/logs',{cache:'no-store'});
    if(!response.ok)throw new Error('Logs unavailable');
    const {computers=[]}=await response.json();
    list.replaceChildren(...computers.map(computer=>{
      const group=element('section','log-computer','');group.append(element('h4','',computer.name));
      const entries=computer.error?[]:computer.entries||[];
      // Timing samples outnumber failures; list failures and fold the samples away.
      const timing=entry=>/^(Terminal (transport|switch(?! slow)|viewport|control|scrolling|new tab ready|load ready)|Browser Shift\+Enter|Browser tab resumed) /.test(entry.message);
      const errors=entries.filter(entry=>!timing(entry)),samples=entries.filter(timing);
      if(computer.error)group.append(element('p','log-note',computer.error));
      else if(!errors.length)group.append(element('p','log-note','No recent errors'));
      const row=entry=>{
        const row=element('div','log-entry',''),when=new Date(entry.time);
        const meta=element('small','',[entry.source,when.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}),entry.count>1?`×${entry.count}`:''].filter(Boolean).join(' · '));
        meta.title=humanTime(when);row.append(element('span','',entry.message),meta);return row;
      };
      group.append(...errors.map(row));
      if(samples.length){
        const details=element('details','log-timing',''),summary=element('summary','',`${samples.length} performance ${samples.length===1?'sample':'samples'}`);
        details.append(summary,...samples.map(row));group.append(details);
      }
      return group;
    }));
  }catch(_){list.replaceChildren(element('p','log-note','Logs unavailable; refresh to try again.'));}
  finally{button.disabled=false;list.setAttribute('aria-busy','false');}
}
$('refresh-logs').onclick=loadLogs;
// Settings, like VS Code's User and Workspace settings: each has a value shared by every browser
// on every paired computer, and this browser may override it. Terminal frames, the Messages page
// and this page read the result from switchboard-<key>, so they need not know which one won.
// Frames share this origin and follow storage events; native tabs reach them by message; fine
// scrolling is read when a terminal connects, so a change reloads the page.
const settingDefs={
  'move-working-to-snoozed':{toggle:true,default:'true',apply:()=>render()},
  'native-tabs':{toggle:true,apply:()=>{nativeTabs=settingValue('native-tabs')==='true';updateNativeTabs();}},
  'media-previews':{toggle:true},
  'media-thumbnails':{toggle:true},
  'predictive-echo':{toggle:true},
  'fine-scroll':{toggle:true,apply:remote=>remote?reloadWhenHidden():location.reload()},
  // Another computer changing the shared group must not switch the tabs someone is looking at.
  'focus-group':{apply:remote=>{if(!remote)setFilter(focusGroup()||'all');}},
  'link-app-work':{},
  'link-app-home':{},
  // Computers whose chats show their API cost, as the first 12 characters of each mesh ID.
  'chat-cost':{apply:()=>window.SwitchboardConversation?.update?.(),render:renderChatCost,describe:value=>{
    const names=[...hosts].filter(([id])=>chatCostIds(value).has(chatCostId(id))).map(([,host])=>host.name);
    return names.join(', ')||'None';
  }},
};
// A host's ID differs on each computer ("windows" here is "mesh-<id>" elsewhere); its mesh ID does not.
function chatCostId(hostId){
  const id=hosts.get(hostId)?.local?localMember?.id||hostId:String(hostId).replace(/^mesh-/,'');
  return id.slice(0,12);
}
const chatCostIds=value=>new Set(String(value||'').split(',').filter(Boolean));
function chatCostShown(hostId){return chatCostIds(settingValue('chat-cost')).has(chatCostId(hostId));}
function renderChatCost(value){
  const container=$('chat-cost'),ids=chatCostIds(value),rows=new Map([...container.children].map(row=>[row.dataset.host,row])),nodes=[];
  for(const host of hosts.values()){
    let row=rows.get(host.id);
    if(!row){
      row=document.createElement('button');row.type='button';row.className='setting-toggle';row.dataset.host=host.id;
      row.append(document.createTextNode(''),Object.assign(document.createElement('span'),{className:'toggle-state'}));
      row.lastChild.setAttribute('aria-hidden','true');
      row.onclick=()=>{
        const current=chatCostIds(settingScope==='browser'?settingValue('chat-cost'):sharedValue('chat-cost')),id=chatCostId(host.id);
        current.has(id)?current.delete(id):current.add(id);
        setSetting('chat-cost',[...current].sort().join(','));
      };
    }
    const on=ids.has(chatCostId(host.id));
    if(row.firstChild.textContent!==host.name)row.firstChild.textContent=host.name;
    row.setAttribute('aria-pressed',String(on));
    nodes.push(row);rows.delete(host.id);
  }
  for(const row of rows.values())row.remove();
  // Move rows in place rather than replacing them, so the toggle just pressed keeps focus.
  let cursor=container.firstChild;
  for(const row of nodes){if(row!==cursor)container.insertBefore(row,cursor);else cursor=cursor.nextSibling;}
}
const settingDefault=key=>settingDefs[key].default??(settingDefs[key].toggle?'false':'');
let sharedSettings=load('switchboard-shared-settings'),settingOverrides=load('switchboard-setting-overrides');
let settingsShared=false,settingScope='shared';const savingSetting={};
// Before scopes, each browser kept its own values: toggles move to the group once, and the
// group filter and link browsers, which were always per browser, become this browser's overrides.
if(localStorage.getItem('switchboard-shared-settings')===null){
  for(const key in settingDefs){
    const old=localStorage.getItem('switchboard-'+key);
    if(settingDefs[key].toggle&&old!==null)sharedSettings[key]={value:old,updated:0};
  }
  if(focusGroup())settingOverrides['focus-group']=focusGroup();
  const apps=load('switchboard-link-apps');
  for(const group of ['work','home'])if(apps[group])settingOverrides['link-app-'+group]=apps[group];
  saveSettings();
}
function saveSettings(){
  try{
    localStorage.setItem('switchboard-shared-settings',JSON.stringify(sharedSettings));
    localStorage.setItem('switchboard-setting-overrides',JSON.stringify(settingOverrides));
  }catch(_){}
}
function sharedValue(key){return sharedSettings[key]?.value??settingDefault(key);}
function settingValue(key){return key in settingOverrides?settingOverrides[key]:sharedValue(key);}
// Store the resolved value where readers look, and act only when it changed.
function resolveSetting(key,remote=false,starting=false){
  const value=settingValue(key);
  let stored=null;try{stored=localStorage.getItem('switchboard-'+key);}catch(_){}
  if(stored!==value&&!(stored===null&&value===settingDefault(key))){
    try{localStorage.setItem('switchboard-'+key,value);}catch(_){}
    if(!starting)settingDefs[key].apply?.(remote);
  }
  renderSettings();
}
function pushSetting(key){
  if(!settingsShared)return;
  const value=sharedValue(key);
  savingSetting[key]=(savingSetting[key]||0)+1;
  fetch('/api/mesh/setting',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({key,value})})
    .then(r=>r.ok?r.json():null)
    // The relay's time is the group's clock, so a browser whose clock runs ahead does not resend forever.
    .then(saved=>{if(saved&&sharedSettings[key]?.value===value){sharedSettings[key].updated=saved.updated;saveSettings();}})
    .catch(()=>{}).finally(()=>savingSetting[key]--);
}
function setSetting(key,value){
  if(settingScope==='browser')settingOverrides[key]=value;
  else sharedSettings[key]={value,updated:Math.max(Math.floor(Date.now()/1000),(sharedSettings[key]?.updated||0)+1)};
  saveSettings();
  if(settingScope==='shared')pushSetting(key);
  resolveSetting(key);
}
function resetSetting(key){delete settingOverrides[key];saveSettings();resolveSetting(key);}
// The group's value wins unless this browser holds a newer one it has not shared yet,
// such as one set before this computer was paired. Older relays keep settings here.
function applySettings(mesh,member){
  const group=mesh?.settings;
  settingsShared=!!member&&group!=null;
  if(!settingsShared)return;
  for(const key in settingDefs){
    const theirs=group[key],mine=sharedSettings[key];
    if(savingSetting[key])continue;
    if(theirs&&(!mine||theirs.updated>=mine.updated)){
      if(mine?.value===theirs.value&&mine.updated===theirs.updated)continue;
      sharedSettings[key]={value:theirs.value,updated:theirs.updated};saveSettings();resolveSetting(key,true);
    }
    else if(mine)pushSetting(key);
  }
}
// Reloading under someone who is using this browser would lose their place; wait until they leave it.
function reloadWhenHidden(){
  if(document.hidden)location.reload();
  else document.addEventListener('visibilitychange',()=>{if(document.hidden)location.reload();});
}
const settingNotes={};
// A setting's box, or its own line where one box holds several (Links).
function settingRow(key){const control=$(key),label=control.closest('#link-apps label');return label||control.closest('.settings-group');}
function describeSetting(key,value){
  if(settingDefs[key].toggle)return value==='true'?'On':'Off';
  if(settingDefs[key].describe)return settingDefs[key].describe(value);
  if(key==='focus-group')return [...$(key).options].find(option=>option.value===value)?.textContent||value;
  return value||'Default browser';
}
function renderSettings(){
  const browser=settingScope==='browser';
  for(const button of $('setting-scopes').querySelectorAll('[data-scope]')){
    const on=button.dataset.scope===settingScope;button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;
  }
  $('setting-scope-help').textContent=browser?'Set here, a setting overrides All computers in this browser only.':'Every browser on your paired computers uses these, unless it overrides them.';
  $('machines-shared').hidden=browser;
  for(const key in settingDefs){
    const control=$(key),value=browser?settingValue(key):sharedValue(key),overridden=browser&&key in settingOverrides;
    if(settingDefs[key].toggle){control.setAttribute('aria-pressed',String(value==='true'));control.classList.toggle('selected',value==='true');}
    else if(settingDefs[key].render)settingDefs[key].render(value);
    else if(control!==document.activeElement||control.tagName==='SELECT')control.value=value;
    settingRow(key).classList.toggle('overridden',overridden);
    let note=settingNotes[key];
    if(!note){
      note=settingNotes[key]=document.createElement('p');note.className='setting-override';note.id=key+'-override';
      const text=document.createElement('span'),reset=document.createElement('button');
      reset.type='button';reset.textContent='Reset';reset.title='Use the All computers value in this browser';reset.onclick=()=>{resetSetting(key);control.focus();};
      note.append(text,reset);($(key+'-help')||control.closest('label')).after(note);
      control.setAttribute('aria-describedby',[control.getAttribute('aria-describedby'),note.id].filter(Boolean).join(' '));
    }
    note.hidden=!overridden;
    note.firstChild.textContent=`Overrides All computers (${describeSetting(key,sharedValue(key))}). `;
  }
}
for(const key in settingDefs){
  const control=$(key);
  if(settingDefs[key].toggle)control.onclick=()=>setSetting(key,control.getAttribute('aria-pressed')==='true'?'false':'true');
  else if(!settingDefs[key].render)control.onchange=()=>setSetting(key,control.value.trim());
}
$('setting-scopes').onclick=event=>{const button=event.target.closest('[data-scope]');if(button){settingScope=button.dataset.scope;renderSettings();}};
$('setting-scopes').onkeydown=event=>{
  if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
  event.preventDefault();settingScope=settingScope==='shared'?'browser':'shared';renderSettings();
  $('setting-scopes').querySelector('[aria-selected="true"]').focus();
};
for(const key in settingDefs)resolveSetting(key,false,true);
setInterval(refresh,15000);

function closeTabMenu(restore=false){
  $('tab-menu').hidden=true;$('close-tab').disabled=false;contextItem=null;
  menuTrigger?.setAttribute('aria-expanded','false');
  if(restore===true&&menuTrigger?.isConnected)menuTrigger.focus();
  menuTrigger=null;
}
const restartingAgents=new Set();
function agentChatTarget(item,paneId){
  if(!item||item.tab.pending||!Number.isInteger(item.tab.id))return null;
  const panes=(item.entry.state?tabPanes(item.entry,item.tab):item.tab.panes).filter(p=>!p.is_plugin);
  // A tab with several panes must be selected so its active pane is unambiguous.
  const active=item.key===selected?item.entry.state?.active_pane||(Number.isInteger(paneId)?{pane_id:paneId}:null):null;
  const pane=panes.length===1?panes[0]:panes.find(p=>p.pane_id===active?.pane_id);
  if(!pane)return null;
  const state=paneAttention.get(attentionKey(item.entry.host,item.entry.name,pane.pane_id));
  if(!state?.chat_id)return null;
  return {pane,state};
}
function restartAgentTarget(item){
  const target=agentChatTarget(item);if(!target)return null;
  const {pane,state}=target;
  if(!state.restart_available||!['ready','working'].includes(state.state))return null;
  return {session:item.entry.name,pane_id:pane.pane_id,tab_id:item.tab.id,chat_id:state.chat_id,working:state.state==='working'};
}
// A model switch is offered in every agent state. One chosen while the agent is busy waits
// for its turn to end (see runPendingSwitches); an idle agent that cannot restart has none.
const pendingSwitches=new Map();
function switchPossible(state){return !!state?.chat_id&&(!!state.restart_available||!['ready','working'].includes(state.state));}
function newTabModelLabel(value){return NEW_TAB_MODELS.find(([alias])=>alias===value)?.[1]||NEW_TAB_CLAUDE_MODELS.find(([id])=>'claude:'+id===value)?.[1]||[...newTabCodexModels.values()].flatMap(list=>Array.isArray(list)?list:[]).find(({id})=>'codex:'+id===value)?.name||newTabModelParts(value)?.model||value;}
function openAgentHandover(item,paneId){
  const target=agentChatTarget(item,paneId);if(!target||!switchPossible(target.state)||!globalThis.SwitchboardHandover)return;
  const queued=pendingSwitches.get(item.key);if(queued?.running){closeTabMenu();setStatus('The model switch is already running.');return;}
  const host=item.entry.host,chatHost=hosts.get(host)?.local?'local':host;
  const historyUrl=new URL('/api/chats/'+encodeURIComponent(target.state.chat_id),location.origin);historyUrl.search=new URLSearchParams({host:chatHost,context:'true',limit:50});
  const source={host,chatHost,chatId:target.state.chat_id,agent:target.state.agent,title:tabTitle(item),computer:hosts.get(host)?.name||host,project:target.pane.cwd,historyUrl:historyUrl.href,target:{session:item.entry.name,pane_id:target.pane.pane_id,tab_id:item.tab.id,chat_id:target.state.chat_id},tab:item.key};
  closeTabMenu();openNewTabDialog(false);if(!$('new-tab-dialog').open)return;
  const option=[...$('new-tab-target').options].find(option=>JSON.parse(option.value)[0]===host);
  if(!option){$('new-tab-dialog').close();setStatus('The source computer is unavailable.',true);return;}
  $('new-tab-target').value=option.value;paintNewTabMachine();loadNewTabProjects();loadNewTabCodexModels();
  const files=globalThis.SwitchboardConversation?.handoverFiles?.(source).length||0;
  $('new-tab-title').textContent='Switch model with context';$('new-tab-note').textContent='Continue in this tab with the selected model. Recent messages carry across, as counted below; attachments and tool state stay in the original history.'+(files?` ${files===1?'The file attached in the composer goes':'The '+files+' files attached in the composer go'} with your instructions.`:'')+(target.state.state==='ready'?'':' The agent is busy, so the switch waits for its turn to end.');
  setNewTabModel(queued?.model||(source.agent==='claude'?'csol':'c'));
  $('new-tab-prompt').value=queued?queued.text:globalThis.SwitchboardConversation?.handoverDraft?.(source)||'';fitNewTabPrompt();
  $('new-tab-dialog').classList.add('handover-mode');
  $('new-tab-prompt-label').textContent='Additional instructions';$('new-tab-prompt').placeholder='Leave blank to carry on where the conversation left off';
  newTabHandover={source};newTabSubmitText();$('handover-preview').hidden=false;loadNewTabHandover();
}
// Restarts the agent in its tab with the model, carrying recent history, the
// instructions and the files uploaded in its composer. Context loads now unless given.
async function switchAgentModel(source,model,text,context,isCurrent=()=>true){
  context||=await SwitchboardHandover.load(source,{signal:AbortSignal.timeout(60000)});
  const response=await fetch('/api/hosts/'+encodeURIComponent(source.host)+'/attachments?'+new URLSearchParams({name:'switchboard-context-handover.json'}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:JSON.stringify(context)});
  if(!isCurrent())return null;
  if(!response.ok)throw Error('Could not transfer context to the destination computer. Try again.');
  const data=await response.json();if(typeof data.path!=='string'||!data.path||/[\x00-\x1f]/.test(data.path))throw Error('Invalid handover file response. Try again.');
  const files=globalThis.SwitchboardConversation?.handoverFiles?.(source)||[],prompt=SwitchboardHandover.prompt(data.path,text)+(files.length?'\n\nAttached files:\n'+files.join('\n'):'');
  if(new TextEncoder().encode(prompt).length>16000)throw Error('The prompt and file paths must fit within 16 KB.');
  const restart=await fetch('/api/hosts/'+encodeURIComponent(source.host)+'/restart-agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...source.target,handover:{model,prompt,source_messages:context.coverage.total_messages}}),signal:AbortSignal.timeout(120000)});
  if(!restart.ok)throw Error(await restart.text()||'Could not switch models.');
  const result=await restart.json();
  if(!Number.isInteger(result.pane_id)||result.tab_id!==source.target.tab_id)throw Error('The switch was not confirmed. Check the terminal before trying again.');
  globalThis.SwitchboardConversation?.handoverSent?.(source,text,result.pane_id,files);
  return result;
}
// Switch at once only when the agent is idle and Conversation has nothing in flight for it.
function switchNow(source){
  const state=paneAttention.get(attentionKey(source.host,source.target.session,source.target.pane_id));
  return state?.state==='ready'&&!!state.restart_available&&state.chat_id===source.chatId&&globalThis.SwitchboardConversation?.canHandover?.(source)!==false;
}
function queueSwitch(source,model,text){
  const label=newTabModelLabel(model);pendingSwitches.set(source.tab,{source,model,text,label});
  globalThis.SwitchboardConversation?.handoverQueued?.(source,text);
  $('new-tab-dialog').close();render();setStatus(`Switching to ${label} when this turn ends.`);
}
// The queued instructions go back to the composer, the new agent's when it changed; a closed tab takes them along.
function cancelSwitch(key,message,into){
  const pending=pendingSwitches.get(key);if(!pending||pending.running)return;pendingSwitches.delete(key);
  if(into!==null)globalThis.SwitchboardConversation?.handoverCancelled?.(into||pending.source,pending.text);
  render();setStatus(message||'Model switch cancelled.',!!message);
}
// A queued switch runs once its agent is ready and no send is in flight. Approval
// and input prompts are left to the person. It ends with its tab or its agent.
async function runPendingSwitches(){
  for(const [key,pending] of pendingSwitches){
    if(pending.running||$('new-tab-dialog').open&&newTabHandover?.source.tab===key)continue;
    const {source}=pending,item=allTabs().find(item=>item.key===key),state=paneAttention.get(attentionKey(source.host,source.target.session,source.target.pane_id));
    const gone=!item||!(item.entry.state?tabPanes(item.entry,item.tab):item.tab.panes).some(p=>p.pane_id===source.target.pane_id);
    if(gone||state&&state.chat_id!==source.chatId){cancelSwitch(key,'The model switch was cancelled because its tab or agent changed.',gone?null:{...source,chatId:state.chat_id});continue;}
    if(state?.state==='ready'&&!state.restart_available){cancelSwitch(key,'This agent can no longer switch models.');continue;}
    if(!switchNow(source)){
      // Sends from a tab not on screen are confirmed by nothing; read its transcript once the agent is ready.
      if(state?.state==='ready'&&!pending.checking&&Date.now()-(pending.checked||0)>=2000){pending.checking=true;Promise.resolve(globalThis.SwitchboardConversation?.acknowledgeSends?.(source)).finally(()=>{pending.checking=false;pending.checked=Date.now();runPendingSwitches();setTimeout(runPendingSwitches,2000);});}
      continue;
    }
    pending.running=true;render();
    try{if(await switchAgentModel(source,pending.model,pending.text)){await refreshAttention(true);setStatus('Continuing with '+(newTabModelProvider(pending.model)==='claude'?'Claude':'Codex')+' in the same tab.');}}
    catch(error){globalThis.SwitchboardConversation?.handoverCancelled?.(source,pending.text);setStatus('Could not switch models: '+(error.name==='TimeoutError'?'the source computer did not answer in time.':error.message),true);}
    finally{if(pendingSwitches.get(key)===pending)pendingSwitches.delete(key);render();}
  }
}
$('handover-context').onclick=()=>openAgentHandover(contextItem);
$('restart-agent').onclick=async()=>{
  const item=contextItem,target=restartAgentTarget(item);if(!target||restartingAgents.has(item.key))return;
  if(target.working){
    closeTabMenu();
    const dialog=$('restart-agent-dialog');
    dialog.returnValue='';
    dialog.showModal();
    const confirmed=await new Promise(resolve=>{
      dialog.addEventListener('close',()=>resolve(dialog.returnValue==='restart'),{once:true});
    });
    if(!confirmed)return;
  }
  restartingAgents.add(item.key);closeTabMenu();setStatus(`Restarting ${tabTitle(item)}…`);
  try{
    const {working,...request}=target;
    if(working)request.confirm_interrupt=true;
    const response=await fetch(`/api/hosts/${encodeURIComponent(item.entry.host)}/restart-agent`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error(await response.text()||'Agent restart failed');
    setStatus(`Resuming ${tabTitle(item)} in the same tab`);await refreshAttention(true);
  }catch(error){setStatus(error.name==='TimeoutError'?'No restart confirmation. Check the terminal before trying again.':error.message);}
  finally{restartingAgents.delete(item.key);if(!$('tab-menu').hidden)updateTabMenu();}
};
function updateTabMenu(){
  const item=allTabs().find(tab=>tab.key===contextItem?.key);
  if(!item){closeTabMenu(true);return;}
  contextItem=item;
  $('tab-menu-target').textContent=tabTitle(item);
  $('tab-menu-details').textContent=`${hosts.get(item.entry.host)?.name||item.entry.host} · ${item.entry.name} · ${tabButtons.get(item.key)?.dataset.agentState||autoLabel(item)||'No pending attention'}`;
  $('ready').disabled=!!item.tab.pending&&!Number.isInteger(item.tab.id);
  const pin=$('pin-tab'),isPin=isPinned(item.key);
  pin.disabled=!!item.tab.pending&&!Number.isInteger(item.tab.id);
  pin.textContent=isPin?'Unpin':'Pin';
  pin.title=isPin?'Allow automatic grouping':'Keep in the list while working';
  const hide=$('hide-tab');
  hide.disabled=!!item.tab.pending&&!Number.isInteger(item.tab.id);
  hide.textContent=item.hidden?'Show in list':'Hide';
  hide.title=item.hidden?'Move back among your tabs':'Move to Hidden; keep processes running';
  $('restart-agent').disabled=!restartAgentTarget(item)||restartingAgents.has(item.key);
  const switchTarget=agentChatTarget(item);
  $('handover-context').disabled=!switchPossible(switchTarget?.state)||!globalThis.SwitchboardHandover;
  $('handover-context').title=$('handover-context').disabled?'Available when Claude or Codex has reported its conversation and can restart.':'Switch between Claude and Codex in this tab with conversation context';
  $('restart-agent').title=$('restart-agent').disabled?'Available after Codex or Claude reports its conversation. Select the tab to choose among multiple panes.':'Restart only this agent and resume the same conversation';
  $('close-tab').disabled=!closeTabTarget(item);
  $('close-tab').title=$('close-tab').disabled?'Waiting for the terminal to finish connecting':'Close this tab and stop its processes · Ctrl+D';
  $('select-text').disabled=!item.entry.frame.contentWindow.SwitchboardClipboard;
  $('select-text').setAttribute('aria-pressed',String(!!item.entry.frame.contentWindow.SwitchboardClipboard?.selectionMode));
  const viewport=item.entry.state?.tab_viewport,sizeOwner=$('size-owner');
  const focused=item.key===selected&&activeTab(item.entry)?.id===item.tab.id&&!item.entry.requestedPane&&!item.entry.focusPending&&!item.entry.pendingNewTab;
  sizeOwner.disabled=!focused||!viewport||!item.entry.frame.contentWindow.__zjSupportsTabViewport;
  sizeOwner.setAttribute('aria-pressed',String(!!viewport?.is_owner&&focused));
  sizeOwner.textContent=viewport?.is_owner&&focused?'Using this window’s size':'Use this window’s size';
  sizeOwner.title=!focused?'Select this tab first.':!viewport?'Available in new sessions after updating Switchboard.':viewport.constrained?'A smaller plain terminal is keeping this tab within its screen.':'The last focused browser window sets the size.';
}
// Touch screens open a tab's menu with a long press. Moving the finger first scrolls or drags instead.
// The browser's own contextmenu and click events from that same press are then ignored.
function holdTabForMenu(button){
  let timer=0,start=null;button._held=false;
  const cancel=()=>{clearTimeout(timer);timer=0;};
  button.addEventListener('pointerdown',event=>{
    cancel();button._held=false;if(event.pointerType==='mouse'||!event.isPrimary)return;
    start={x:event.clientX,y:event.clientY};
    timer=setTimeout(()=>{
      timer=0;button._held=true;
      navigator.vibrate?.(10);openTabMenu(button._item,start.x,start.y,button);
    },500);
  });
  button.addEventListener('pointermove',event=>{if(timer&&Math.hypot(event.clientX-start.x,event.clientY-start.y)>10)cancel();});
  for(const type of ['pointerup','pointercancel','dragstart'])button.addEventListener(type,cancel);
}
function openTabMenu(item,x,y,trigger=tabButtons.get(item.key)){
  closeTabMenu();contextItem=item;menuTrigger=trigger;
  const menu=$('tab-menu');menu.hidden=false;updateTabMenu();
  if(menu.hidden)return;
  trigger?.setAttribute('aria-expanded','true');
  menu.style.left=`${Math.max(4,Math.min(x,innerWidth-menu.offsetWidth-4))}px`;
  menu.style.top=`${Math.max(4,Math.min(y,innerHeight-menu.offsetHeight-4))}px`;
  menu.querySelector('button:not(:disabled):not([hidden])')?.focus();
}
$('tab-menu').onkeydown=event=>{
  const items=[...$('tab-menu').querySelectorAll('button:not(:disabled):not([hidden])')],index=items.indexOf(document.activeElement);
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }else if(event.key==='Tab')closeTabMenu(true);
};
$('pin-tab').onclick=()=>{
  const item=contextItem;if(!item)return;
  setPinned(item,!isPinned(item.key));
  closeTabMenu();render();
  tabButtons.get(item.key)?.scrollIntoView({block:'nearest',inline:'nearest'});
  if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();else allTabs().find(t=>t.key===selected)?.entry.frame.focus();
};
$('hide-tab').onclick=()=>{
  const item=contextItem;if(!item)return;
  setHidden(item,!item.hidden);
  closeTabMenu();render();
  tabButtons.get(item.key)?.scrollIntoView({block:'nearest',inline:'nearest'});
  if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();else allTabs().find(t=>t.key===selected)?.entry.frame.focus();
};
document.addEventListener('pointerdown',event=>{if(!$('tab-menu').contains(event.target))closeTabMenu();},true);
window.addEventListener('blur',closeTabMenu);
$('tabs').addEventListener('scroll',closeTabMenu);

function updateSidebar(){
  document.body.classList.toggle('sidebar-collapsed',sidebarCollapsed);
  document.body.classList.toggle('sidebar-open',sidebarOpen&&mobileSidebar.matches);
  const visible=mobileSidebar.matches?sidebarOpen:!sidebarCollapsed;
  $('sidebar-toggle').setAttribute('aria-expanded',String(visible));
  $('sidebar-backdrop').hidden=!(mobileSidebar.matches&&sidebarOpen);
  $('panel-tabs').setAttribute('aria-orientation',mobileSidebar.matches?'horizontal':'vertical');
}
function showTabSearch(){
  if(mobileSidebar.matches)sidebarOpen=true;else{sidebarCollapsed=false;localStorage.setItem('switchboard-sidebar-collapsed','false');}
  updateSidebar();$('tab-search').focus();$('tab-search').select();
}
$('sidebar-toggle').onclick=()=>{
  if(mobileSidebar.matches)sidebarOpen=!sidebarOpen;
  else{sidebarCollapsed=!sidebarCollapsed;localStorage.setItem('switchboard-sidebar-collapsed',String(sidebarCollapsed));}
  updateSidebar();
  // Blur the draft or the terminal's input so the on-screen keyboard closes while the drawer is open.
  if(mobileSidebar.matches&&sidebarOpen&&document.activeElement!==$('sidebar-toggle')){const active=document.activeElement;try{active?.contentWindow?.__zjSoftKbdCapture?.element?.blur();}catch{}active?.blur();}
};
$('sidebar-backdrop').onclick=()=>{sidebarOpen=false;updateSidebar();};
mobileSidebar.addEventListener('change',()=>{sidebarOpen=false;updateSidebar();for(const entry of sessions.values())syncTerminalConnection(entry);render();});
$('tab-search').oninput=render;
$('tab-search').onkeydown=event=>{if(event.key==='Enter'){const item=listedTabs()[0];if(item){event.preventDefault();activate(item);if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();else item.entry.frame.focus();}}};
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

const startup=globalThis.SwitchboardStartup;
if(startup){
  tabCatalog=startup.snapshot.tabs;
  for(const host of startup.snapshot.hosts){hosts.set(host.id,{...host,connecting:true});if(host.group!==undefined)groups[host.id]=host.group;}
  for(const tab of tabCatalog){const host=hosts.get(tab.host);if(host)connectSession(host,tab.session,false,true);}
  renderMachines();render();
  setTimeout(()=>{
    const fresh=startup.finish();
    if(fresh.tabs){
      tabCatalog=fresh.tabs;
      for(const entry of sessions.values()){setCatalog(entry,tabCatalog.filter(tab=>tab.host===entry.host&&tab.session===entry.name));updateCreatedTabs(entry);}
    }
    pruneSessions(fresh.listed);
    for(const host of hosts.values())pruneSessions(null,host.id);
    renderMachines();render();
  },5000);
}
refresh();

async function refreshAttention(immediate=false,watch=false){
  if(!watch){if(attentionLoading){attentionRefreshPending ||= immediate;return;}attentionLoading=true;}
  try{
    const response=await fetch(watch?`/api/attention?after=${attentionVersion}`:'/api/attention');if(!response.ok)throw Error('Attention monitor unavailable');
    const data=await response.json();attentionLoaded=true;
    // Answers can overlap; an older one must not undo a newer one.
    if(data.version<attentionVersion)return true;
    attentionVersion=data.version??attentionVersion;
    if(relayLostAt){relayLostAt=0;refresh();}
    askpassRequests=data.askpass||[];
    attentionErrors=data.errors||[];
    const previous=paneAttention;
    paneAttention=keyedAttention(data.panes||[]);
    for(const [key,state] of previous)if(!paneAttention.has(key)&&attentionError(state.host,state.session,true))paneAttention.set(key,state);
    // The relay also preserves catalogs during failed scans. Use those on a
    // fresh page, and retain browser entries the failed scan could not supply.
    const incoming=data.tabs||[],identity=tab=>JSON.stringify([tab.host,tab.session,tab.id]);
    const supplied=new Set(incoming.map(identity));
    const retained=[...incoming,...tabCatalog.filter(tab=>catalogUnavailable(tab.host,tab.session)&&!supplied.has(identity(tab)))];
    tabCatalog=globalThis.SwitchboardStartup?.merge(retained)||retained;
    for(const entry of sessions.values()){
      entry.catalogUnavailable=catalogUnavailable(entry.host,entry.name);
      entry.catalogPolls=(entry.catalogPolls||0)+1;
      setCatalog(entry,tabCatalog.filter(tab=>tab.host===entry.host&&tab.session===entry.name));
      updateCreatedTabs(entry);
    }
    const current=allTabs().find(item=>item.key===selected);
    if(!globalThis.SwitchboardConversation?.isOpen?.() && current && document.hasFocus() && !document.hidden && $('artifact-preview').hidden && !document.querySelector('dialog[open]') && !current.entry.requestedPane && !current.entry.focusPending && activeTab(current.entry)?.id===current.tab.id)acknowledgeAttention(current);
    render();
    const selectedTab=allTabs().find(item=>item.key===selected);if(selectedTab?.entry.needsFocus)focus(selectedTab,true);
    // A relay without versions answers at once, so wait before asking again.
    return data.version!==undefined;
  }catch(_){attentionLoaded=true;paneAttention.clear();askpassRequests=[];attentionErrors=[{host:'Switchboard'}];render();relayLost();return false;}
  finally{if(!watch){attentionLoading=false;if(attentionRefreshPending){attentionRefreshPending=false;refreshAttention();}}}
}
function keyedAttention(states){
  return new Map(states.map(state=>{const key=attentionKey(state.host,state.session,state.pane_id);return [key,{...state,key}];}));
}
// An upgrade restarts the relay for about a second. Retry every 250 ms for 10 s
// instead of waiting for the next poll, and reload hosts once it answers.
let relayLostAt=0;
function relayLost(){
  relayLostAt||=Date.now();
  if(Date.now()-relayLostAt<10000)setTimeout(refreshAttention,250);
}
// The relay answers as soon as status changes, so tabs update without polling.
refreshAttention();
(async()=>{for(;;)if(!await refreshAttention(false,true))await new Promise(resolve=>setTimeout(resolve,2000));})();

const browserDiagnostics=window.SwitchboardBrowserDiagnostics?.(diagnostic=>{
  fetch('/api/diagnostics/browser-resume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(diagnostic),keepalive:true})
    .then(response=>{if(!response.ok)throw Error(`HTTP ${response.status}`);})
    .catch(error=>console.warn('Browser resume diagnostics unavailable:',error));
},(id,started_at)=>{
  const current=allTabs().find(item=>item.key===selected);
  if(!current||!$('artifact-preview').hidden||document.querySelector('dialog[open]'))return false;
  current.entry.frame.contentWindow.postMessage({type:'zellij-browser-resume',id,started_at},location.origin);
  return true;
});

window.SwitchboardConversation?.install({
  viewed:acknowledgeConversation,
  switchModel(view){openAgentHandover(allTabs().find(item=>item.key===selected),view?.pane);},
  cancelSwitch(){cancelSwitch(selected);},
  idle(){if(pendingSwitches.size)queueMicrotask(runPendingSwitches);},
  modeChanged(){
    for(const entry of sessions.values())syncTerminalConnection(entry);render();
    // A viewer kept connected through Conversation reclaims its tab size, which
    // another computer may have taken meanwhile.
    const current=allTabs().find(item=>item.key===selected);
    if(!globalThis.SwitchboardConversation.wantsConversation()&&current?.entry.state&&document.hasFocus())current.entry.frame.contentWindow?.postMessage({type:'zellij-window-focus'},location.origin);
  },
  selection(){
    const item=allTabs().find(item=>item.key===selected);if(!item)return null;
    const active=item.entry.state?.active_pane,panes=(!item.entry.state?item.tab.panes:tabPanes(item.entry,item.tab)).filter(p=>!p.is_plugin);
    const preferred=item.entry.resumePane||active;
    const pane=panes.find(p=>p.pane_id===preferred?.pane_id)||panes.find(p=>p.is_focused)||panes[0];if(!pane)return {key:item.key,host:item.entry.host,frame:item.entry.frame,title:displayTitle(item),starting:!!item.tab.pending,launch:launchFor(item)};

    const state=paneAttention.get(attentionKey(item.entry.host,item.entry.name,pane.pane_id)),queued=pendingSwitches.get(item.key);
    return {key:JSON.stringify([item.entry.host,item.entry.name,pane.pane_id]),host:item.entry.host,showCost:chatCostShown(item.entry.host),chatHost:hosts.get(item.entry.host)?.local?'local':item.entry.host,session:item.entry.name,tab:item.tab.id,pane:pane.pane_id,frame:item.entry.frame,terminalReady:!item.entry.suspended&&!item.entry.disconnected&&!item.entry.needsFocus&&!item.entry.focusPending&&active?.pane_id===pane.pane_id,title:displayTitle(item),agent:state?.agent,state:state?.state,chatId:state?.chat_id,since:state?.since,computer:hosts.get(item.entry.host)?.name,switchAvailable:switchPossible(state),pendingSwitch:queued?.source.target.pane_id===pane.pane_id?queued:null,starting:!!item.tab.pending,launch:launchFor(item)};
  },
  terminal(target){const item=allTabs().find(item=>item.key===selected);if(item&&item.entry.frame===target.frame){item.entry.frame.focus();focus(item);}}
});

new MutationObserver(updateMobileTerminalViewport).observe($('terminals'),{attributes:true,attributeFilter:['class']});
updateMobileTerminalViewport();
