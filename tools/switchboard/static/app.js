const $ = id => document.getElementById(id);
globalThis.SwitchboardSkillEditor?.install($('new-tab-prompt'));
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
let terminalInputTransient=null;
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
// Manual parking is a browser preference, like pins. Keep it separate from the
// automatic Working shelf and from Hidden tabs.
// Settling closes a tab now, so a Settled entry from an earlier build returns to the list.
function loadParkedTabs(){return Object.fromEntries(Object.entries(load('switchboard-parked-tabs')).filter(([,parked])=>parked.state!=='settled'));}
let parkedTabs=loadParkedTabs();
function parkedTab(item){return parkedTabs[canonKey(item.key)];}
function saveParkedTabs(){localStorage.setItem('switchboard-parked-tabs',JSON.stringify(parkedTabs));}
function urgentTokens(item){return statesForTab(item).filter(s=>['approval','input'].includes(s.state)).map(s=>JSON.stringify([s.key,s.state,s.token,s.since]));}
function parkTab(item,state,until){
  if(state)parkedTabs[canonKey(item.key)]={state,until,urgent:urgentTokens(item)};
  else delete parkedTabs[canonKey(item.key)];
  saveParkedTabs();
  if(state){setPinned(item,false);if(item.hidden)setHidden(item,false);}
  render();
  focusSelectedView();
}
// Return keyboard focus to the open view, including when the action removed the focused button.
function focusSelectedView(){
  if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();
  else allTabs().find(t=>t.key===selected)?.entry.frame.focus();
}
// Settling frees the tab's memory by closing it. A snoozed tab offers Wake in the same place.
function settleTab(item){
  closeTabMenu();
  if(parkedTab(item)){parkTab(item,null);return;}
  contextItem=item;$('close-tab').click();
  focusSelectedView();
}
window.addEventListener('storage',event=>{
  if(event.key==='switchboard-parked-tabs'){parkedTabs=loadParkedTabs();render();}
});
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
const ATTENTION_WARNING_GRACE_MS=5000,attentionWarningSince=new Map();
let attentionWarningTimer;
function attentionWarnings(){
  const now=performance.now(),active=new Set(),warnings=[];
  let next=Infinity;
  for(const error of attentionErrors){
    if(error.pending)continue;
    const key=JSON.stringify([error.host,error.session]);active.add(key);
    if(!attentionWarningSince.has(key))attentionWarningSince.set(key,now);
    const remaining=ATTENTION_WARNING_GRACE_MS-(now-attentionWarningSince.get(key));
    if(remaining<=0)warnings.push({host:hosts.has(error.host)?error.host:null,message:`${hosts.get(error.host)?.name||error.host}: attention status unavailable`});
    else next=Math.min(next,remaining);
  }
  for(const key of attentionWarningSince.keys())if(!active.has(key))attentionWarningSince.delete(key);
  clearTimeout(attentionWarningTimer);
  // A watch can remain pending throughout an outage; show a persistent warning even
  // when no further snapshot arrives. Redraws must not count as failed checks.
  attentionWarningTimer=Number.isFinite(next)?setTimeout(()=>render(),next):null;
  return warnings;
}
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
// A chat the viewer picks adds a browser history entry, so Back returns to the
// last one. Selections the page makes itself only rewrite the current entry.
let pushTabHistory=false,leavingNewTabEntry=false;
function tabHistoryIndex(){return history.state?.switchboardTabIndex||0;}
let tabHistoryPosition=0;
function updateTabUrl(item){
  if(!item&&(restoringTab||waitingForRequestedTab()))return;
  if(item?.tab.pending&&!Number.isInteger(item.tab.id))return;
  const url=new URL(location.href);
  for(const key of ['host','session','tab','pane'])url.searchParams.delete(key);
  if(item){url.searchParams.set('host',item.entry.host);url.searchParams.set('session',item.entry.name);url.searchParams.set(item.tab.pending?'pane':'tab',item.tab.id);}
  if(url.href===location.href){if(item)pushTabHistory=false;return;}
  if(item&&pushTabHistory){
    pushTabHistory=false;
    // An open preview or new-chat dialog already holds an entry; the chat takes it over.
    const {switchboardPreview,switchboardNewTab,...rest}=history.state||{},state={...rest,switchboardMedia:false,switchboardTabIndex:++tabHistoryPosition};
    if(switchboardPreview||switchboardNewTab)history.replaceState(state,'',url);
    else history.pushState(state,'',url);
  }else history.replaceState(history.state,'',url);
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
function remapParkedTabs(remap){
  const next={};let changed=false;
  for(const [old,value] of Object.entries(parkedTabs)){
    const key=remap(canonKey(old));
    if(key)next[key]=value;
    if(key!==old)changed=true;
  }
  if(changed){parkedTabs=next;saveParkedTabs();}
}
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
    if(entry.selectOnStart){selected=JSON.stringify([entry.host,entry.name,'pane',paneId]);pushTabHistory=true;restoringTab=false;entry.needsFocus=true;}
  }
  // Conversation creates tabs without moving the viewer's focus, so its active pane is never the new one.
  else if(creating&&active&&!active.is_plugin&&!entry.pendingNewTab?.api&&!entry.pendingNewTab?.paneIds?.has(active.pane_id))paneId=active.pane_id;
  else if(requested?.[0]===entry.host&&requested[1]===entry.name&&requested[2]==='pane'&&Number.isInteger(requested[3]))paneId=requested[3];
  if(Number.isInteger(paneId)&&state.panes?.some(p=>!p.is_plugin&&p.pane_id===paneId)){
    entry.provisionalTabs??=[];
    if(!entry.provisionalTabs.some(tab=>tab.id===paneId))entry.provisionalTabs.push({id:paneId,pending:true,name:'New tab',panes:[]});
    if(creating){
      entry.provisionalTabs.find(tab=>tab.id===paneId).project=creating.project;requestedProjects.set(JSON.stringify([entry.host,entry.name,paneId]),creating.project);entry.provisionalTabs.find(tab=>tab.id===paneId).requestedModel=creating.requestedModel;requestedModels.set(JSON.stringify([entry.host,entry.name,paneId]),creating.requestedModel);
      if(creating.launch){entry.provisionalTabs.find(tab=>tab.id===paneId).launch=creating.launch;launches.set(JSON.stringify([entry.host,entry.name,paneId]),creating.launch);}
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
const launches=new Map(),requestedProjects=new Map(),requestedModels=new Map();
// What the New tab picker asked for. Conversation shows it until the transcript names a model.
function requestedModel(launch){const parts=ModelPicker.parse(launch.command);return parts&&{agent:parts.provider,model:parts.model,reasoning_effort:parts.effort};}
function promptLaunch(launch,typed=launch.prompt){const text=typeof typed==='string'?typed:'',attachments=(launch.images||[]).map(url=>({kind:'image',name:url.split(/[\\/]/).pop(),url}));return text.trim()||attachments.length?{text:text.trim()?text:attachments.length===1?'Image attached':`${attachments.length} images attached`,attachments,agent:newTabModelProvider(launch.command),at:Date.now()}:null;}
function launchFor(item){
  const pane=item.tab.panes.find(p=>!p.is_plugin),key=pane&&JSON.stringify([item.entry.host,item.entry.name,pane.pane_id]);
  const launch=item.tab.launch||key&&launches.get(key);
  if(launch&&Date.now()-launch.at>600000){if(key)launches.delete(key);return null;}
  return launch||null;
}
function launchingTab(item){
  const launch=launchFor(item);if(!launch||launch.reported)return null;
  // A starting agent can flicker Working and report Ready at its empty prompt ("idle:0") before
  // the launch text is submitted. A question, a wait or a finished turn hands over to the task's
  // own status; an agent still idle after a minute never received the launch text.
  const states=statesForTab(item).filter(state=>state.agent);
  launch.worked||=states.some(state=>state.state==='working');
  const stale=Date.now()-launch.at>60000;
  if(states.some(state=>['waiting','approval','input'].includes(state.state)||state.state==='ready'&&(stale||state.token!=='idle:0'&&(state.chat_id||launch.worked)))){launch.reported=true;return null;}
  return launch;
}
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
    remapParkedTabs(key=>{
      if(!mine(key))return key;
      const [,,kind,id]=JSON.parse(key);
      return kind==='tab'&&moved.get(id)!==undefined?JSON.stringify([host,name,'tab',moved.get(id)]):null;
    });
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
  remapParkedTabs(key=>moved.get(key)||key);
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
  if(launchingTab(item))return 'Working';
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
function isReady(item){return !systemTab(item.tab)&&!!(ready[item.key] || item.tab.name.startsWith('*') || askpassForTab(item) || !launchingTab(item)&&statesForTab(item).some(needsAttention));}
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
  for(const item of allTabs(true)){
    const parked=parkedTab(item);if(!parked)continue;
    // Completion and background work do not cancel an explicit snooze. A new
    // question does; an existing question can be snoozed until later.
    if(parked.state==='snoozed'&&parked.until<=now||urgentTokens(item).some(token=>!parked.urgent?.includes(token))||askpassForTab(item)){
      delete parkedTabs[canonKey(item.key)];saveParkedTabs();
    }else if(parked.state==='snoozed')next=Math.min(next,parked.until);
  }
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
    const parked=parkedTab(item);
    const shelf=!item.hidden&&parked?.state;
    return {...item,snoozed:snoozed&&!shelf,shelf};
  });
  if(next!==Infinity)snoozedExitTimer=setTimeout(()=>render(),Math.min(next-now,2147483647));
  const rank=item=>item.hidden?4:item.shelf==='snoozed'?2:item.snoozed?1:0;
  return result.sort((a,b)=>rank(a)-rank(b));
}
// Search includes collapsed groups; keyboard navigation follows the visible rows.
function listedTabs(){
  const searching=!!$('tab-search').value.trim();
  return sidebarTabs().filter(item=>matchesSearch(item)&&(!item.hidden||hiddenOpen||searching||item.key===selected)&&(!item.snoozed||snoozedOpen||searching||item.key===selected)&&(!item.shelf||sectionExpanded('manual-'+item.shelf)||searching||item.key===selected));
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
}
const snoozedHeader=document.createElement('button');
snoozedHeader.id='snoozed-toggle';
snoozedHeader.innerHTML='<span class="chevron" aria-hidden="true">›</span><span>Working</span><span class="count"></span>';
snoozedHeader.onclick=()=>{
  if(dragging||Date.now()<suppressTabClickUntil)return;
  snoozedOpen=!snoozedOpen;localStorage.setItem(`switchboard-snoozed-open:${filter}`,String(snoozedOpen));render();
};
const parkedHeaders=new Map(['snoozed'].map(shelf=>{
  const header=document.createElement('button');header.id=`manual-${shelf}-toggle`;header.className='parked-header';
  header.innerHTML=`<span class="chevron" aria-hidden="true">›</span><span>Snoozed</span><span class="count"></span>`;
  header.onclick=()=>{localStorage.setItem(`switchboard-manual-${shelf}-open:${filter}`,String(!sectionExpanded('manual-'+shelf)));render();};
  return [shelf,header];
}));
const settleTitle='Settle: close this tab and stop its processes to free memory';
const parkIcons={clock:'<circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/>',check:'<path d="m3 8 3 3 7-7"/>',wake:'<path d="M3 7a5 5 0 1 1 0 4M3 3v4h4"/>'};
function parkAction(label,icon){
  const button=document.createElement('button');button.type='button';
  button.innerHTML=`<svg viewBox="0 0 16 16" aria-hidden="true">${parkIcons[icon]}</svg>`;
  button.setAttribute('aria-label',label);button.title=label;return button;
}
let snoozeItem=null,snoozeTrigger=null;
function closeSnoozeMenu(restore=false){
  $('snooze-menu').hidden=true;snoozeTrigger?.setAttribute('aria-expanded','false');
  if(restore&&snoozeTrigger?.isConnected)snoozeTrigger.focus();
}
function tomorrowMorning(){const date=new Date();date.setDate(date.getDate()+1);date.setHours(9,0,0,0);return date.getTime();}
function openSnooze(item,trigger){
  if(!$('snooze-menu').hidden&&snoozeItem?.key===item.key){closeSnoozeMenu(true);return;}
  closeSnoozeMenu();
  snoozeItem=item;snoozeTrigger=trigger;closeTabMenu();
  const menu=$('snooze-menu'),now=Date.now(),time=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'});
  menu.setAttribute('aria-label',`Snooze ${tabTitle(item)}`);
  for(const button of menu.querySelectorAll('[data-minutes]'))button.lastElementChild.textContent=time.format(new Date(now+Number(button.dataset.minutes)*60000));
  $('snooze-tomorrow').lastElementChild.textContent=time.format(new Date(tomorrowMorning()));
  menu.hidden=false;trigger?.setAttribute('aria-expanded','true');
  const bounds=(trigger||tabButtons.get(item.key)).getBoundingClientRect();
  menu.style.left=`${Math.max(8,Math.min(bounds.right-menu.offsetWidth,innerWidth-menu.offsetWidth-8))}px`;
  const top=bounds.bottom+6;
  menu.style.top=`${Math.max(8,Math.min(top+menu.offsetHeight>innerHeight-8?bounds.top-menu.offsetHeight-6:top,innerHeight-menu.offsetHeight-8))}px`;
  menu.querySelector('button').focus();
}
$('snooze-custom').onclick=()=>{
  closeSnoozeMenu();
  const item=snoozeItem;if(!item)return;
  $('snooze-title').textContent=`Snooze ${tabTitle(item)}`;
  $('snooze-error').textContent='';$('snooze-until').value='';$('snooze-dialog').showModal();
};
function snoozeUntil(until){
  if(!Number.isFinite(until)||until<=Date.now()){$('snooze-error').textContent='Choose a future date and time.';return;}
  const item=allTabs().find(item=>item.key===snoozeItem?.key);
  closeSnoozeMenu();
  if(!item){$('snooze-dialog').close();return;}
  $('snooze-dialog').close();parkTab(item,'snoozed',until);
}
$('snooze-dialog').addEventListener('close',()=>{snoozeTrigger?.isConnected&&snoozeTrigger.focus();snoozeTrigger=null;});
for(const button of $('snooze-menu').querySelectorAll('[data-minutes]'))button.onclick=()=>snoozeUntil(Date.now()+Number(button.dataset.minutes)*60000);
$('snooze-tomorrow').onclick=()=>snoozeUntil(tomorrowMorning());
$('snooze-form').onsubmit=event=>{event.preventDefault();snoozeUntil(new Date($('snooze-until').value).getTime());};
$('snooze-cancel').onclick=()=>$('snooze-dialog').close();
window.addEventListener('keydown',event=>{
  if($('snooze-menu').hidden)return;
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeSnoozeMenu(true);}
  else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();event.stopImmediatePropagation();
    const items=[...$('snooze-menu').querySelectorAll('button')],index=items.indexOf(document.activeElement);
    items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
  }else if(event.key==='Tab')closeSnoozeMenu();
},true);
document.addEventListener('pointerdown',event=>{if(!$('snooze-menu').hidden&&!$('snooze-menu').contains(event.target)&&!snoozeTrigger?.contains(event.target))closeSnoozeMenu();},true);
window.addEventListener('blur',()=>closeSnoozeMenu());
window.addEventListener('resize',()=>closeSnoozeMenu());
$('tabs').addEventListener('scroll',()=>closeSnoozeMenu());
// A row's top-right corner: what the tab is doing, or how long ago its state changed.
const statusWords={'Password needed':'Password','Approval needed':'Approve','Input needed':'Answer','Working':'Working','Waiting on an agent':'Waiting','Ready to review':'Done'};
function tabPaneWithCwd(item){return item.tab.panes.find(p=>!p.is_plugin&&typeof p.cwd==='string'&&p.cwd);}
// Known before the agent reports a chat: what New tab asked for, until the pane reports where it is.
function launchedProject(item,pane){const known=pane||item.tab.panes.find(p=>!p.is_plugin);return item.tab.project||pane?.cwd||tabPaneWithCwd(item)?.cwd||known&&requestedProjects.get(JSON.stringify([item.entry.host,item.entry.name,known.pane_id]))||'';}
function tabProject(item){
  const dir=tabPaneWithCwd(item)?.cwd;
  if(!dir)return '';
  const path=dir.replace(/[\\/]+$/,'');
  if(/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)$/i.test(path))return '~';
  return path.split(/[\\/]/).pop()||path;
}
// Amber, green and red are left out: they already mean attention, done and failure in the row.
const projectTileColors=['#a3e635','#2dd4bf','#22d3ee','#38bdf8','#60a5fa','#818cf8','#a78bfa','#e879f9','#f472b6','#fb7185','#fb923c'];
// Two letters and a colour derived from the repository, so its worktrees match on every computer.
// A relay without repository names falls back to the folder name.
function projectTile(item){
  const project=tabProject(item);
  if(!project||project==='~')return null;
  const name=(tabPaneWithCwd(item).repo||project).normalize('NFKC');
  const words=name.match(/[\p{L}\p{N}]+/gu);
  if(!words)return null;
  const glyphs=[...words[0]];
  const second=glyphs.slice(1).find(glyph=>/\p{N}/u.test(glyph))??(words.length>1?[...words.at(-1)][0]:glyphs.at(-1));
  let index=0;
  for(const glyph of name.toLowerCase())index=(index*31+glyph.codePointAt(0))%projectTileColors.length;
  return {text:[...`${glyphs[0]}${second}`.toUpperCase()].slice(0,2).join(''),color:projectTileColors[index]};
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
  const parkedGroups=[...parkedHeaders].map(([shelf,header])=>({shelf,header,tabs:tabs.filter(item=>item.shelf===shelf),shown:shown.filter(item=>item.shelf===shelf)}));
  const ensureHeaders=rank=>{
    if(rank>=1&&showSnoozedGroup&&!nodes.includes(snoozedHeader))nodes.push(snoozedHeader);
    for(const [index,group] of parkedGroups.entries())if(rank>=index+2&&group.tabs.length&&(!searching||group.shown.length)&&!nodes.includes(group.header))nodes.push(group.header);
    if(rank>=4&&showHiddenGroup&&!nodes.includes(hiddenHeader))nodes.push(hiddenHeader);
  };
  const titles=new Map(tabs.map(item=>[item.key,displayTitle(item)])),titleCounts=new Map();
  for(const item of tabs){const key=JSON.stringify([item.entry.host,titles.get(item.key)]);titleCounts.set(key,(titleCounts.get(key)||0)+1);}
  for (const item of listed) {
    ensureHeaders(item.hidden?4:item.shelf==='snoozed'?2:item.snoozed?1:0);
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
      let warm;row.onpointerenter=event=>{if(event.pointerType==='mouse')warm=setTimeout(()=>globalThis.SwitchboardConversation?.warm?.(row._item),100);};row.onpointerleave=()=>clearTimeout(warm);
      row.append(button);button._row=row;holdTabForMenu(button);
      const actions=document.createElement('div');actions.className='tab-hover-actions';
      const snooze=parkAction('Snooze thread','clock'),settle=parkAction('Settle thread','check');
      snooze.setAttribute('aria-haspopup','menu');snooze.setAttribute('aria-controls','snooze-menu');snooze.setAttribute('aria-expanded','false');
      snooze.onclick=()=>openSnooze(button._item,snooze);
      settle.onclick=()=>settleTab(button._item);
      actions.append(snooze,settle);row.append(actions);button._parkActions=actions;button._snooze=snooze;button._settle=settle;
      button.onkeydown=event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const bounds=button.getBoundingClientRect();openTabMenu(button._item,bounds.right,bounds.top,button);}};
      const where=document.createElement('small');where.className='tab-where';
      const status=document.createElement('span');status.className='tab-status';status.setAttribute('aria-hidden','true');
      const star=document.createElement('span');star.className='star';
      status.append(star,document.createElement('span'));
      const name=document.createElement('span');name.className='tab-name';
      const agent=document.createElement('span');agent.className='tab-agent';agent.setAttribute('aria-hidden','true');
      const tile=document.createElement('span');tile.className='project-tile';tile.setAttribute('aria-hidden','true');
      button.append(tile,where,status,name,agent);
      Object.assign(button,{_tile:tile,_where:where,_status:status,_star:star,_name:name,_agent:agent});
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
    const parking=parkedTab(item),restoreLabel=parking?'Wake thread':'Settle thread';
    button._parkActions.hidden=systemTab(item.tab)||!!item.tab.pending;
    button._snooze.hidden=!!parking;
    button._settle.setAttribute('aria-label',restoreLabel);button._settle.title=parking?restoreLabel:settleTitle;
    button._settle.innerHTML=`<svg viewBox="0 0 16 16" aria-hidden="true">${parkIcons[parking?'wake':'check']}</svg><span>${parking?'': 'Settle'}</span>`;
    button.draggable=!item.tab.pending||Number.isInteger(item.tab.id);
    const title=titles.get(item.key);
    const machine=hosts.get(item.entry.host)?.name || item.entry.host;
    const stateLabel=autoLabel(item);
    const unavailable=statusUnavailable(item.entry.host,item.entry.name);
    const flagged=!!ready[item.key]||item.tab.name.startsWith('*');
    const starred=isReady(item);
    // The web server names tabs opened with Run as administrator.
    const elevated=item.tab.name.replace(/^\*\s*/,'')==='Administrator';
    const status=unavailable?'Status unavailable':stateLabel==='Ready'?'':stateLabel;
    const duplicate=titleCounts.get(JSON.stringify([item.entry.host,title]))>1;
    const project=tabProject(item);
    const subtitle=`${project?project+' · ':''}${machine}${duplicate?' · '+item.entry.name:''}${isPinned(item.key)?' · Pinned':''}`;
    const tile=projectTile(item);
    button.className='tab-select'+(item.key===selected?' selected':'')+(starred?' needs-attention':'')+(elevated?' elevated':'')+(systemTab(item.tab)?' system':'')+(tile?' has-tile':'');
    button.setAttribute('aria-pressed',String(item.key===selected));
    button.setAttribute('aria-label',`${title}${elevated&&title!=='Administrator'?', Administrator':''}${systemTab(item.tab)?', System tab opened by an agent':''}, ${project?project+', ':''}${machine}, ${item.entry.name}${status?', '+status:''}${flagged?', Flagged for review':''}${isPinned(item.key)?', Pinned':''}`);
    button._star.className='star '+(unavailable?'unavailable':starred?'attention':stateLabel==='Working'?'working':stateLabel.startsWith('Waiting')?'waiting':'quiet');
    const working=stateLabel==='Working'?tabAge(item,'working'):'';
    const short=unavailable?'Unavailable':working&&working!=='now'?`Working ${working}`:statusWords[stateLabel]||(flagged?'Review':tabAge(item));
    button._status.dataset.tone=unavailable?'':stateLabel==='Ready to review'?'done':starred?'attention':stateLabel==='Working'?'working':'';
    if(button._status.lastChild.textContent!==short)button._status.lastChild.textContent=short;
    if(button._name.textContent!==title)button._name.textContent=title;
    button.dataset.agentState=unavailable?'Status unavailable':stateLabel;
    if(button._where.textContent!==subtitle)button._where.textContent=subtitle;
    if(tile&&button._tile.textContent!==tile.text)button._tile.textContent=tile.text;
    if(tile&&button._tile.dataset.color!==tile.color){button._tile.dataset.color=tile.color;button._tile.style.color=tile.color;}
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
  ensureHeaders(3);
  for(const group of parkedGroups){
    if(!group.tabs.length||(searching&&!group.shown.length)){group.header.remove();continue;}
    group.header.setAttribute('aria-expanded',String(sectionExpanded('manual-'+group.shelf)||searching));
    group.header.lastElementChild.textContent=String(group.tabs.length);
  }
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
  const notifications=allTabs(true).filter(item=>!parkedTab(item)&&isReady(item)).length;
  $('notifications').textContent=`${notifications} notification${notifications===1?'':'s'}`;
  $('notifications').classList.toggle('has-notifications',notifications>0);
  $('notifications').hidden=notifications===0;
  document.title=`${notifications?'('+notifications+') ':''}`+(current?`${tabTitle(current)} · ${hosts.get(current.entry.host)?.name} · Switchboard`:'Switchboard');
  globalThis.SwitchboardNotifications?.check(allTabs(true).filter(item=>!parkedTab(item)&&isReady(item)));
  const startingEntry=[...sessions.values()].find(entry=>entry.starting&&(filter==='all'||groups[entry.host]===filter));
  const currentEntry=current?.entry||(waitingForRequestedTab()?sessions.get(sessionKey(...JSON.parse(selected).slice(0,2))):startingEntry);
  for (const entry of sessions.values()) entry.frame.classList.toggle('active',entry===currentEntry);
  // Selecting another computer's tab in Conversation connects its terminal in the background.
  // A viewer whose engine cannot be hidden follows the selection in Terminal too.
  for(const entry of sessions.values())if(entry.hideUnsupported||globalThis.SwitchboardConversation?.wantsConversation?.())syncTerminalConnection(entry);
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
  errors.push(...attentionWarnings());
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
  if(current)restoreTerminalKeyboard(current.entry);
});
document.addEventListener('close',()=>queueMicrotask(()=>{
  const current=allTabs().find(item=>item.key===selected);if(current)restoreTerminalKeyboard(current.entry);
}),true);
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
  if(control&&!control.matches('#hidden-toggle,#snoozed-toggle,#sidebar-toggle,#sidebar-backdrop,#dismiss-status,#filters [data-filter],#filter-more'))return;
  event.preventDefault();
},true);
function focus(item,background=false) {
  if(!background){
    const origin=document.activeElement;
    item.entry.keyboardIntent=origin?.closest('input,textarea,select,[contenteditable]')?null:origin;
  }
  if(item.entry.suspending||item.entry.retirementUnresolved){item.entry.needsFocus=true;return;}
  const conversationOpen=globalThis.SwitchboardConversation?.isOpen?.()||false;
  if(conversationOpen&&!background)globalThis.SwitchboardConversation.focus();
  const activeElement=document.activeElement;
  // A sidebar click may wait for metadata with its button still focused.
  const fromTabButton=!!activeElement&&activeElement===tabButtons.get(tabKey(item.entry,item.tab));
  // Behind Conversation the terminal focuses its pane without taking keyboard focus,
  // so it is already on the right pane when Terminal is shown.
  const deferKeyboardFocus=background&&(document.hidden||!document.hasFocus()||!$('artifact-preview').hidden||document.querySelector('dialog[open]')||!conversationOpen&&activeElement&&activeElement!==document.body&&activeElement!==item.entry.frame&&!fromTabButton);
  // Reconnecting an inert viewer must confirm its pane even when search, a
  // dialog or another window owns the keyboard. Keep that focus where it is.
  if(deferKeyboardFocus&&!item.entry.frame.inert){
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
  if(!deferKeyboardFocus){
    $('artifact-preview').hidden=true;
    $('artifact-frame').contentWindow?.location.replace('about:blank');
  }
  const active=item.entry.state.active_pane;
  const panes=tabPanes(item.entry,item.tab);
  const preferred=item.entry.resumePane||active;
  const pane=panes.find(p=>p.pane_id===preferred?.pane_id && p.is_plugin===preferred?.is_plugin)||panes[0];
  if(!pane){const waiting=item.entry.needsFocus;item.entry.needsFocus=true;setStatus('Waiting for terminal metadata…');if(!waiting)refreshAttention(true);return;}
  item.entry.needsFocus=false;
  if(active?.pane_id!==pane.pane_id||active?.is_plugin!==pane.is_plugin)item.entry.frame.contentWindow.SwitchboardClipboard?.clearSelection();
  const focusId=item.entry.focusId=(item.entry.focusId||0)+1;
  if(item.entry.frame.inert || item.entry.requestedPane || active?.pane_id!==pane.pane_id||active?.is_plugin!==pane.is_plugin)item.entry.requestedPane={pane_id:pane.pane_id,is_plugin:pane.is_plugin,focus_id:focusId};
  const preserveFocus=item.entry.frame.inert||!!deferKeyboardFocus||conversationOpen||(background&&!!item.entry.focusInitialized&&!fromTabButton);
  item.entry.focusInitialized=true;
  item.entry.frame.contentWindow.postMessage({type:'zellij-focus',pane_id:pane.pane_id,is_plugin:pane.is_plugin,focus_id:focusId,preserve_focus:preserveFocus},location.origin);
}
function restoreTerminalKeyboard(entry,unlocked=false){
  if(!entry.keyboardIntent&&!unlocked)return;
  if(entry.suspending||entry.retirementUnresolved||entry.suspended||entry.frame.inert||entry.needsFocus||entry.requestedPane||entry.focusPending||
    !entry.frame.classList.contains('active')||globalThis.SwitchboardConversation?.isOpen?.()||mobileSidebar.matches&&sidebarOpen||document.hidden||!document.hasFocus()||!$('artifact-preview').hidden||document.querySelector('dialog[open]'))return;
  const active=document.activeElement;
  if(active!==document.body&&active!==entry.frame&&active!==entry.keyboardIntent)return;
  entry.keyboardIntent=null;
  entry.frame.focus();
  entry.frame.contentWindow.postMessage({type:'zellij-restore-focus'},location.origin);
}
function activate(item, clear=true, addHistory=true) {
  terminalInputTransient=null;
  if(addHistory&&item.key!==selected)pushTabHistory=true;
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
// Registered before sidebarKeydown, which otherwise takes Escape to mean leaving Conversation.
window.addEventListener('keydown',event=>{
  if($('filter-menu').hidden)return;
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeFilterMenu(true);}
  else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();event.stopImmediatePropagation();
    const items=[...$('filter-menu').children],index=items.indexOf(document.activeElement);
    items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
  }else if(event.key==='Tab')closeFilterMenu();
},true);
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
  if(event.code==='KeyT'&&!event.ctrlKey&&!event.metaKey&&event.altKey&&!event.shiftKey&&!event.isComposing&&!document.querySelector('dialog[open]:not(.conversation-task.subagent)')){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)$('new-tab').click();return;}
  if(document.querySelector('dialog[open]'))return;
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
    if(globalThis.SwitchboardConversationGithub?.isOpen()){event.preventDefault();event.stopImmediatePropagation();globalThis.SwitchboardConversationGithub.close();return;}
    if(mobileSidebar.matches&&sidebarOpen){event.preventDefault();sidebarOpen=false;updateSidebar();$('sidebar-toggle').focus();return;}
    if(!$('artifact-preview').hidden){event.preventDefault();$('artifact-back').click();return;}
    if(globalThis.SwitchboardConversation?.isOpen?.()){event.preventDefault();event.stopImmediatePropagation();if(!globalThis.SwitchboardConversation.interrupt())globalThis.SwitchboardConversation.showTerminal();return;}
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
// switching back never reloads it. A viewer whose engine never confirmed hidden would
// keep sizing the tab from behind another sidebar tab too, so it disconnects until selected.
function syncTerminalConnection(entry) {
  const live=`/hosts/${encodeURIComponent(entry.host)}/${encodeURIComponent(entry.name)}`;
  const suspended=!!entry.hideUnsupported&&!entry.frame.classList.contains('active')||!!globalThis.SwitchboardConversation?.wantsConversation?.()&&
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
  entry.state=null;entry.disconnected=false;entry.requestedPane=null;entry.focusPending=false;entry.needsFocus=true;
  // Stay disconnected once an engine fails to confirm hidden, rather than retrying the attach.
  if(!suspended)entry.hideUnsupported=false;
  replaceFrameSrc(entry.frame,src);
}
// Assigning a loaded iframe's src adds a browser history entry, which Back would
// spend undoing it. A frame inserted with its src replaces that entry instead.
function replaceFrameSrc(frame,src){
  const parent=frame.isConnected&&frame.parentNode,next=frame.nextSibling;
  if(parent)frame.remove();
  frame.src=src;
  if(parent)parent.insertBefore(frame,next);
}
function terminalTransition(entry,busy) {
  entry.frame.inert=busy;
  entry.frame.style.opacity=busy?'0.45':'';
  entry.frame.setAttribute('aria-busy',String(busy));
  if(busy)entry.frame.blur();
  else if(entry.inputTiming){
    entry.inputTiming.end('ready',{stages:terminalInputStages(entry)});
    entry.inputTiming=null;
  }
}
function terminalInputStages(entry){
  const elapsed=performance.now()-entry.inputStarted,metadata=entry.inputMetadata;
  return metadata==null?{metadata:elapsed}:{metadata,focus:elapsed-metadata};
}
function showRetirementStatus() {
  const entries=[...sessions.values()];
  if(terminalInputTransient!==selected)terminalInputTransient=null;
  const connecting=entries.find(entry=>entry.frame.classList.contains('active')&&!entry.suspended&&!entry.suspending&&!entry.retirementUnresolved&&entry.frame.inert&&!globalThis.SwitchboardConversation?.isOpen?.());
  for(const entry of entries){
    if(entry.inputTiming&&(entry!==connecting||terminalInputTransient)){entry.inputTiming.end('left');entry.inputTiming=null;}
  }
  if(connecting&&!connecting.inputTiming&&!terminalInputTransient){
    connecting.inputStarted=performance.now();connecting.inputMetadata=connecting.state?0:null;
    connecting.inputTiming=window.SwitchboardTiming?.begin('terminal_input_ready',{host:connecting.host,timeoutStages:()=>terminalInputStages(connecting)})||null;
  }
  const unresolved=entries.find(entry=>entry.retirementUnresolved);
  $('status').classList.toggle('terminal-transition',!!connecting||entries.some(entry=>entry.retirementUnresolved||entry.suspending));
  if(unresolved){
    setStatus(unresolved.retirementError||'Terminal disconnect is unconfirmed. Recover this viewer before typing.',true);
    if(unresolved.retirementRetryable===false)return;
    const retry=document.createElement('button');retry.textContent='Retry terminal connection';
    retry.onclick=()=>retireTerminal(unresolved,unresolved.frame.contentWindow.__zjSuspendTerminal);
    $('status-message').append(' ',retry);
  }else if([...sessions.values()].some(entry=>entry.suspending)){
    setStatus('Finishing terminal input before disconnecting the hidden viewer…');
  }else if(connecting){
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
      replaceFrameSrc(entry.frame,'about:blank');
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
      clearTimeout(entry.startTimeout);entry.inputTiming?.end('left');entry.frame.remove();sessions.delete(key);
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
      }catch(error){
        // A network error means the local relay itself is down, usually restarting.
        if(error instanceof TypeError)relayLost();
        if(!(error instanceof TypeError&&relayRestarting()))hosts.set(summary.id,{...hosts.get(summary.id),connecting:false,error:error.message});
      }
      renderMachines();render();
    }));
  }catch(error){relayLost();if(!relayRestarting())setStatus(error.message,true);}finally{loading=false;}
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
    type==='terminal-load'?['outcome','elapsed_ms','page_ms','socket_ms','frame_ms','render_ms','visible','after']:
    type==='clipboard'?['outcome','chars','attempt','selection_mode','mouse_tracking','focused','secure','clipboard_api']:
    type==='instant-typing'?['outcome','pane_id','is_plugin','pending','typed','confirmed','frames','age_ms','srtt_ms','since_input_ms','since_write_ms','run_row','cursor_row','cursor_col','expected_col','cursor_hidden']:
    ['pane_id','is_plugin','shift','ctrl','alt','meta','repeat','held_ms','released_ms'];
  const body={host:entry.host};
  for(const field of fields){const value=diagnostic[field];if(value===null||typeof value==='boolean'||typeof value==='string'&&(field==='outcome'||field==='after')||typeof value==='number'&&Number.isFinite(value)&&value>=0)body[field]=value;}
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
    if(entry.inputTiming&&entry.inputMetadata==null)entry.inputMetadata=performance.now()-entry.inputStarted;
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
      if(duplicate&&duplicate!==entry){duplicate.inputTiming?.end('left');duplicate.frame.remove();}
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
    const unlocked=entry.frame.inert&&!entry.needsFocus&&!entry.requestedPane&&!entry.focusPending;
    if(unlocked){
      if(entry.frame.classList.contains('active'))terminalInputTransient=null;
      terminalTransition(entry,false);render();
    }
    // An inert frame cannot receive keyboard focus until its acknowledgement.
    restoreTerminalKeyboard(entry,unlocked);
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
    // A load that Terminal started when leaving Conversation is the time that switch took.
    const after=entry.loadAfter,load=event.data.diagnostic;entry.loadAfter=null;
    entry.loadTiming?.end(load.outcome==='ready'?'ready':'failed',{stages:{page:load.page_ms,socket:load.socket_ms,frame:load.frame_ms,render:load.render_ms}});entry.loadTiming=null;
    recordTerminalDiagnostic(entry,'terminal-load',after?{...load,after}:load);
  }else if(event.data?.type==='zellij-predict-diagnostic'){
    recordTerminalDiagnostic(entry,'instant-typing',event.data.diagnostic);
  }else if(event.data?.type==='zellij-new-tab-diagnostic'){
    recordTerminalDiagnostic(entry,'new-tab',event.data.diagnostic);
  }else if(event.data?.type==='zellij-switch-diagnostic'){
    recordTerminalDiagnostic(entry,'terminal-switch',event.data.diagnostic);
  }else if(event.data?.type==='zellij-prompt-submit'){
    submittedTurn(entry.host,entry.name,event.data.pane_id);
  }else if(event.data?.type==='zellij-escape-sent'){
    settleInterrupt(entry.host,entry.name,event.data.pane_id);
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
    // This engine still sizes tabs for hidden viewers. Disconnect it while it is out of view.
    entry.hideUnsupported=true;syncTerminalConnection(entry);render();
  }else if(event.data?.type==='zellij-terminal-failed'){
    // Frame identity selects the host; never accept a host supplied by the frame.
    fetch('/api/diagnostics/terminal-failure',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({host:entry.host,failure:event.data.failure}),keepalive:true}).catch(()=>{});
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
window.addEventListener('popstate',()=>{
  if($('artifact-preview').hidden||history.state?.switchboardPreview)return;
  // The dialog's own Back landed after this preview opened; the preview keeps an entry.
  if(leavingNewTabEntry)history.pushState({...history.state,switchboardPreview:true},'');
  else $('artifact-back').click();
});
window.addEventListener('popstate',()=>{
  const direction=Math.sign(tabHistoryIndex()-tabHistoryPosition),dialog=$('new-tab-dialog');
  leavingNewTabEntry=false;
  tabHistoryPosition=tabHistoryIndex();
  if(dialog.open&&!history.state?.switchboardNewTab)dialog.close();
  // A chat still being created owns the next entry; this one only closed an overlay.
  if(pushTabHistory)return;
  if(!dialog.open&&history.state?.switchboardNewTab)history.replaceState({...history.state,switchboardNewTab:false},'');
  if(requestedFilter()!==filter)renderFilter();
  const key=requestedTab();
  if(!key||key===selected)return;
  const [host,session,kind,id]=JSON.parse(key),tabs=allTabs(true);
  // An entry saved while a new chat was pending names its pane, not its finished tab.
  const item=tabs.find(item=>item.key===key)||kind==='pane'&&tabs.find(item=>item.entry.host===host&&item.entry.name===session&&item.tab.panes?.some(pane=>!pane.is_plugin&&pane.pane_id===id));
  if(item){
    if(!allTabs().some(tab=>tab.key===item.key))setFilter('all');
    activate(item,true,false);
    return;
  }
  const previous=selected,wasRestoring=restoringTab;
  selected=key;restoringTab=false;
  if(waitingForRequestedTab()){render();return;}
  selected=previous;restoringTab=wasRestoring;
  // The chat has closed: step over it, but never back out of Switchboard.
  if(direction>0||direction<0&&tabHistoryPosition>0)history.go(direction);else render();
});
new MutationObserver(()=>{if($('artifact-preview').hidden&&history.state?.switchboardPreview)history.back();})
  .observe($('artifact-preview'),{attributes:true,attributeFilter:['hidden']});
// A reload starts with the preview closed, so its entry no longer has a preview to close.
if(history.state?.switchboardPreview)history.replaceState({...history.state,switchboardPreview:false},'');
tabHistoryPosition=tabHistoryIndex();
if(history.state?.switchboardNewTab)history.replaceState({...history.state,switchboardNewTab:false},'');
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
// The groups a focused browser keeps out of its filter bar.
function filterMenuGroups(){return [...$('filters').querySelectorAll('[data-filter]')].filter(b=>b.hidden);}
let filterMenuReturn=null;
function closeFilterMenu(restore=false){
  if($('filter-menu').hidden)return;
  $('filter-menu').hidden=true;$('filter-more').setAttribute('aria-expanded','false');
  if(restore)filterMenuReturn?.focus();
  filterMenuReturn=null;
}
function openFilterMenu(){
  const menu=$('filter-menu'),trigger=$('filter-more'),tabs=allTabs(true);
  filterMenuReturn=document.activeElement;
  menu.replaceChildren(...filterMenuGroups().map(group=>{
    const value=group.dataset.filter,count=tabs.filter(({entry})=>value==='all'||groups[entry.host]===value).length;
    const item=document.createElement('button');item.setAttribute('role','menuitemradio');item.setAttribute('aria-checked',String(value===filter));
    item.setAttribute('aria-label',`${group.textContent}, ${count} ${count===1?'tab':'tabs'}`);
    item.innerHTML='<span class="check" aria-hidden="true"></span><span></span><span class="count"></span>';
    item.children[1].textContent=group.textContent;item.children[2].textContent=count;
    item.onclick=()=>{closeFilterMenu(true);setFilter(value);};
    return item;
  }));
  menu.hidden=false;trigger.setAttribute('aria-expanded','true');
  const rect=trigger.getBoundingClientRect();
  menu.style.top=`${rect.bottom+6}px`;menu.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-menu.offsetWidth-8))}px`;
  // Focusing the menu on a phone would close the on-screen keyboard.
  if(chromePointerType!=='touch')(menu.querySelector('[aria-checked=true]')||menu.firstElementChild)?.focus();
}
function renderFilter(){
  const focus=focusGroup(),more=$('filter-more');
  for(const b of $('filters').querySelectorAll('[data-filter]')){b.classList.toggle('selected',b.dataset.filter===filter);b.hidden=!!focus&&b.dataset.filter!==focus;}
  more.hidden=!focus;closeFilterMenu();
  if(focus){
    $('filter-more-label').textContent=filterMenuGroups().find(b=>b.dataset.filter===filter)?.textContent||'Show more';
    more.classList.toggle('selected',filter!==focus);
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
$('filter-more').onclick=()=>{if($('filter-menu').hidden)openFilterMenu();else closeFilterMenu(true);};
document.addEventListener('pointerdown',event=>{if(!$('filter-menu').contains(event.target)&&!$('filter-more').contains(event.target))closeFilterMenu();},true);
// Shortcuts such as Ctrl+K move focus without a pointer event.
document.addEventListener('focusin',event=>{if(!$('filter-menu').contains(event.target)&&!$('filter-more').contains(event.target))closeFilterMenu();});
window.addEventListener('blur',()=>closeFilterMenu());
window.addEventListener('resize',()=>closeFilterMenu());
renderFilter();
let newTabElevated=false,newTabHandover=null;
function clearNewTabHandover(){
  newTabHandover?.request?.abort();newTabHandover=null;newTabModelMenu.embed(null);
  for(const id of ['handover-picker','handover-preview','handover-actions'])$(id).hidden=true;
  for(const property of ['left','top','bottom','width','max-height'])$('new-tab-dialog').style.removeProperty(property);
  $('new-tab-form').querySelector('.new-tab-composer-bar').append($('new-tab-submit'));
  $('new-tab-prompt-label').textContent='Prompt';$('new-tab-prompt-label').classList.add('sr-only');
  $('new-tab-prompt').rows=3;
  $('new-tab-prompt').placeholder='What would you like to work on?';$('new-tab-dialog').classList.remove('handover-mode');newTabSubmitText();
}
// The submit button names what it will do, and what it is doing while busy.
let newTabRetrying=false;
function newTabSubmitText(text,announce=true){
  const button=$('new-tab-submit'),unknown=!newTabTargetBlocked&&$('new-tab-project-field').dataset.state==='unknown'&&$('new-tab-project').getAttribute('aria-expanded')==='false';
  const label=text||(newTabHandover?'Switch model':newTabRetrying?'Retry':unknown?(newTabElevated?'Create administrator tab anyway':'Create anyway'):newTabElevated?'Create administrator tab':'Create tab');
  button.classList.toggle('busy',!!text);button.setAttribute('aria-label',label);button.title=text?label:label+' · Enter';
  $('new-tab-submit-label').textContent=text||(newTabHandover&&!switchNow(newTabHandover.source)?'Switch after this turn':label);
  $('new-tab-status').textContent=text||(newTabRetrying?'Enter to retry':unknown?'Enter creates anyway':'');
  if(announce)$('new-tab-progress').textContent=text||'';
}
// A model and its effort, as `claude:<model>#<effort>` or `codex:<model>#<effort>` (see model-picker.js).
// The owner's shell shortcuts from older choices become the model and effort they run.
const ModelPicker=globalThis.SwitchboardModelPicker;let newTabModelValue=ModelPicker.DEFAULT;
// Each computer lists its agents' current models and efforts. Older relays omit Claude's list.
const newTabModels=new Map(),newTabModelRequests=new Set();
function newTabModelHost(){return $('new-tab-target').value?JSON.parse($('new-tab-target').value)[0]:'';}
function newTabHostCodexModels(){return newTabModels.get(newTabModelHost())?.codex;}
function newTabHostClaudeModels(){return newTabModels.get(newTabModelHost())?.claude;}
function newTabModelProvider(value){return ModelPicker.parse(value)?.provider||'';}
function newTabModel(){return newTabModelValue;}
function setNewTabModel(value){
  newTabModelValue=ModelPicker.normalize(value);
  const choice=ModelPicker.describe(newTabModelValue,newTabHostCodexModels(),newTabHostClaudeModels()),icon=globalThis.SwitchboardConversation?.agentIcons?.[choice.provider];
  $('new-tab-model-icon').innerHTML=icon||'';$('new-tab-model-icon').hidden=!icon;
  $('new-tab-model-name').textContent=choice.name;$('new-tab-model-effort').textContent=choice.effort?choice.effortName:'';
  const effort=choice.effort?choice.effortName+' effort':'effort from the agent setting';
  $('new-tab-model').setAttribute('aria-label',`Model: ${choice.name}, ${choice.providerName}, ${effort}`);
  $('new-tab-model').title=`${choice.providerName} · ${choice.model} · ${effort}`;
}
// A remembered effort the destination's model does not offer is dropped for the agent setting, and the picker says why.
let newTabEffortWarning='';
function fitNewTabModel(){
  const fitted=ModelPicker.fit(newTabModelValue,newTabHostCodexModels(),newTabHostClaudeModels());if(fitted===newTabModelValue)return;
  const before=ModelPicker.describe(newTabModelValue,newTabHostCodexModels(),newTabHostClaudeModels());
  newTabEffortWarning=`${before.effortName} isn't offered for ${before.name} on this computer, so the agent setting is used.`;
  setNewTabModel(fitted);$('new-tab-progress').textContent=newTabEffortWarning;
}
// Each browser remembers its last choice per agent, so a handover offers the other agent's.
function newTabSavedModel(provider){
  try{const saved=localStorage.getItem('switchboard-new-tab-model');if(!provider)return saved||ModelPicker.DEFAULT;
    const last=JSON.parse(localStorage.getItem('switchboard-new-tab-models')||'{}')[provider];if(last)return last;
    if(saved&&newTabModelProvider(saved)===provider)return saved;}catch(_){}
  return provider==='claude'?'claude:claude-opus-5-5':provider==='codex'?ModelPicker.DEFAULT:ModelPicker.DEFAULT;
}
function newTabRecentModels(){try{const recent=JSON.parse(localStorage.getItem('switchboard-new-tab-recent')||'[]');return Array.isArray(recent)?recent.filter(value=>typeof value==='string'):[];}catch(_){return [];}}
function saveNewTabModel(value){
  try{localStorage.setItem('switchboard-new-tab-recent',JSON.stringify([value,...newTabRecentModels().filter(other=>other!==value)].slice(0,4)));}catch(_){}
  try{localStorage.setItem('switchboard-new-tab-model',value);const saved=JSON.parse(localStorage.getItem('switchboard-new-tab-models')||'{}');saved[newTabModelProvider(value)]=value;localStorage.setItem('switchboard-new-tab-models',JSON.stringify(saved));}catch(_){}
}
async function loadNewTabModels(){
  const host=newTabModelHost();if(!host)return;
  // Refresh for each new chat or computer choice. Keep the last good list usable while
  // waiting, and share an outstanding request rather than starting agents twice.
  const previous=newTabModels.get(host)||{};
  if(previous.codex==='failed')delete previous.codex;
  setNewTabModel(newTabModelValue);newTabModelMenu.refresh();
  if(newTabModelRequests.has(host))return;
  newTabModelRequests.add(host);
  try{
    const response=await fetch('/hosts/'+encodeURIComponent(host)+'/model-list',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('Models unavailable');
    const data=await response.json(),catalog={...previous};
    for(const provider of ['codex','claude']){
      const models=(Array.isArray(data?.[provider])?data[provider]:[]).filter(model=>typeof model?.id==='string'&&ModelPicker.parse(provider+':'+model.id)).map(({id,name,default:isDefault,efforts,default_effort})=>({id,name:typeof name==='string'?name:id,default:isDefault===true,
      // No levels from an older relay stays unknown; an empty list means the model has none.
      efforts:Array.isArray(efforts)?efforts.filter(effort=>typeof effort?.id==='string'&&/^[a-z]+$/.test(effort.id)).map(({id,description})=>({id,description:typeof description==='string'?description:''})):undefined,
      default_effort:typeof default_effort==='string'&&/^[a-z]+$/.test(default_effort)?default_effort:''}));
      if(models.length)catalog[provider]=models;
    }
    if(!Array.isArray(catalog.codex))catalog.codex='failed';
    newTabModels.set(host,catalog);
  }catch(_){newTabModels.set(host,{...previous,codex:Array.isArray(previous.codex)?previous.codex:'failed'});}
  finally{newTabModelRequests.delete(host);}
  // An answer from a previous computer must not change the current choice or focus.
  if(host!==newTabModelHost()||!$('new-tab-dialog').open)return;
  setNewTabModel(newTabModelValue);fitNewTabModel();newTabModelMenu.refresh();
}
function paintNewTabMachine(){
  const name=$('new-tab-target').selectedOptions[0]?.textContent||'';
  $('new-tab-machine-name').textContent=name;$('new-tab-machine').setAttribute('aria-label','Computer: '+(name||'none'));
}
// A focused chip shows its choices. Arrows or a digit change the value at once;
// Enter, Escape or a click on a choice return to the prompt. Options are [value, label, detail, disabled, group].
// With a search box, typing on the chip filters by name; the first match is chosen at once,
// a name nobody listed comes from custom(query), and Escape restores the choice from before the search.
// A digit still picks its row, and letters after it join the search, so "1fern" finds a computer named 1fern.
function newTabChipMenu(chip,menu,options,current,set,{search=null,custom=()=>[],note=()=>''}={}){
  const list=menu.querySelector('[role=listbox]')||menu;let before=null,typed='';
  const query=()=>search?.value.trim().toLowerCase()||'';
  function shown(){
    const text=query();if(!text)return options();
    const matches=options().filter(([,label])=>label.toLowerCase().includes(text));
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
    const message=search&&query()&&!shown().length?'No computer matches':!query()&&note();
    if(message){const small=document.createElement('p');small.className='new-tab-menu-note';small.textContent=message;list.append(small);}
    const selected=list.querySelector('[aria-selected=true]');
    if(selected){chip.setAttribute('aria-activedescendant',selected.id);search?.setAttribute('aria-activedescendant',selected.id);if(!menu.hidden)selected.scrollIntoView({block:'nearest'});}
    else{chip.removeAttribute('aria-activedescendant');search?.removeAttribute('aria-activedescendant');}
  }
  function open(){
    if(chip.disabled)return;menu.hidden=false;
    paint();chip.setAttribute('aria-expanded','true');
  }
  function close(){menu.hidden=true;chip.setAttribute('aria-expanded','false');chip.removeAttribute('aria-activedescendant');typed='';if(search){search.value='';search.hidden=true;before=null;}}
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
    const delta=event.key==='ArrowDown'||(!typing&&event.key==='ArrowRight')?1:event.key==='ArrowUp'||(!typing&&event.key==='ArrowLeft')?-1:0;
    const row=!typing&&/^[1-9]$/.test(event.key)?options()[+event.key-1]:null;
    if(delta){event.preventDefault();if(!typing){typed='';before=null;}step(delta);}
    else if(row&&!row[3]){event.preventDefault();if(before===null)before=current();typed+=event.key;pick(row[0]);}
    else if(!typing&&search&&event.key.length===1&&event.key!==' '){event.preventDefault();if(before===null)before=current();search.hidden=false;search.value=typed+event.key;typed='';search.focus();filter();}
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
const newTabModelMenu=ModelPicker.create({chip:$('new-tab-model'),menu:$('new-tab-model-menu'),value:()=>newTabModelValue,codex:newTabHostCodexModels,claude:newTabHostClaudeModels,recent:newTabRecentModels,warning:()=>newTabEffortWarning,icons:globalThis.SwitchboardConversation?.agentIcons||{},
  set(value){newTabEffortWarning='';setNewTabModel(value);},
  reload:loadNewTabModels,
  // The choice is announced once, when the picker closes, not on every arrow.
  done(){if(newTabHandover){$('new-tab-form').requestSubmit();return;}$('new-tab-progress').textContent=$('new-tab-model').getAttribute('aria-label');$('new-tab-prompt').focus();}});
const newTabMachineMenu=newTabChipMenu($('new-tab-machine'),$('new-tab-machine-menu'),()=>[...$('new-tab-target').options].map(option=>[option.value,option.textContent.replace(/ · no session$/,''),option.disabled?'no session':'',option.disabled]),()=>$('new-tab-target').value,value=>{$('new-tab-target').value=value;$('new-tab-target').dispatchEvent(new Event('change'));$('new-tab-progress').textContent='Computer: '+$('new-tab-target').selectedOptions[0].textContent;},{search:$('new-tab-machine-search')});
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
  const full=/^(?:[A-Za-z]:[\\/]|\/)/.test(project);
  // Keep the distinguishing folder names visible in the narrow chip too.
  $('new-tab-project-chip-prefix').hidden=!project||full;$('new-tab-project-chip-name').textContent=full?newTabProjectLabel(project):project||'~/git or ~';
  $('new-tab-project-chip').title=full?project:'Choose project';
}
// Each browser remembers the last project per computer; switchboard is the default.
function newTabSavedProject(host){try{return JSON.parse(localStorage.getItem('switchboard-new-tab-projects')||'{}')[host]??'switchboard';}catch(_){return 'switchboard';}}
function saveNewTabProject(host,project){try{const saved=JSON.parse(localStorage.getItem('switchboard-new-tab-projects')||'{}');saved[host]=project;localStorage.setItem('switchboard-new-tab-projects',JSON.stringify(saved));}catch(_){}}
let newTabProjectEdited=false;
$('new-tab-close').onclick=()=>$('new-tab-dialog').close();
$('handover-cancel').onclick=()=>$('new-tab-dialog').close();
function focusNewTabField(next){newTabModelMenu.close();if(next===$('new-tab-project-chip'))openNewTabProjectPicker();else{closeNewTabProjectPicker(false);next.focus();if(next===$('new-tab-model'))newTabModelMenu.open();}}
// Focus order: Tab walks computer, project, model and prompt, then attach, send and close;
// Shift+Tab walks the same order backwards.
$('new-tab-dialog').addEventListener('keydown',event=>{
  if(newTabHandover)return;
  if(event.key!=='Tab'||event.altKey||event.ctrlKey||event.metaKey)return;
  // This runs before the prompt's own handler, so an open menu claims Tab here.
  if(document.activeElement===$('new-tab-prompt')&&newTabCompletions?.key(event))return;
  const picker=$('new-tab-project-popover'),inPicker=picker.contains(document.activeElement);
  // In the project search, Tab is the lookup's own (fill, then on to the model).
  if(inPicker&&!event.shiftKey)return;
  const inModels=$('new-tab-model-menu').contains(document.activeElement);
  // A phone's picker is a modal sheet that keeps Tab to itself.
  if(inModels&&(newTabModelMenu.modal()||document.activeElement!==newTabModelMenu.search))return;
  const inMachines=$('new-tab-machine-menu').contains(document.activeElement);
  const ring=['new-tab-machine','new-tab-project-chip','new-tab-model','new-tab-prompt','new-tab-attach','new-tab-submit','new-tab-close'].map($).filter(element=>!element.disabled&&element.getClientRects().length);
  const from=inPicker?$('new-tab-project-chip'):inModels?$('new-tab-model'):inMachines?$('new-tab-machine'):document.activeElement,index=ring.indexOf(from);if(index<0)return;
  const next=ring[(index+(event.shiftKey?-1:1)+ring.length)%ring.length];
  // The picker's search has its own Tab, which must not run after this move.
  event.preventDefault();event.stopPropagation();
  if(inModels&&!event.shiftKey)newTabModelMenu.commit();
  focusNewTabField(next);
},true);
// The prompt grows with its text, up to a limit where it scrolls.
function fitNewTabPrompt(){const input=$('new-tab-prompt');input.style.height='';input.style.height=Math.min(input.scrollHeight+2,Math.max(innerHeight*.4,160))+'px';}
$('new-tab-prompt').addEventListener('input',()=>{fitNewTabPrompt();newTabCompletions?.paint();});
// A single-line /command, which the agent runs instead of reading it as text.
const newTabCommand=text=>/^\/[a-z][\w:.-]*(?:[ \t][^\n]*)?$/i.test(text.trim());
function newTabAgent(model=newTabModel()){return newTabModelProvider(model)||(model==='c'?'claude':'codex');}
let newTabCompletions=null;
function attachNewTabCompletions(){newTabCompletions??=globalThis.SwitchboardConversation?.attachCompletions?.({draft:$('new-tab-prompt'),parent:$('new-tab-form').querySelector('.new-tab-composer'),id:'new-tab-completions',changed:fitNewTabPrompt,surface(){const host=newTabModelHost();return host&&!newTabHandover&&$('new-tab-dialog').open?{agent:newTabAgent(),host,cwd:$('new-tab-project').value.trim(),owner:host}:null;}})||null;}
$('new-tab').onclick=()=>openNewTabDialog(false);
$('new-admin-tab').onclick=()=>openNewTabDialog(true);
// place names a machine and folder to start from instead of the machine's remembered folder.
function openNewTabDialog(elevated,place={}){
  clearNewTabHandover();
  newTabElevated=elevated;
  $('new-tab-title').textContent=elevated?'New administrator tab':'New tab';
  // A fresh dialog cancels any submission still uploading for the previous one.
  $('new-tab-form').pendingSubmission=null;newTabBusy(false);
  $('new-tab-prompt').value='';clearNewTabFiles();newTabProjectLookup.close();
  // Each browser remembers its last model and effort, listed or typed; Sol at high effort is the default.
  newTabModelMenu.close();newTabEffortWarning='';setNewTabModel(newTabSavedModel());newTabSubmitText();
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
  // The folder only applies on its own machine; an unavailable machine falls back like the + button.
  const placed=place.host&&[...select.options].find(option=>!option.disabled&&JSON.parse(option.value)[0]===place.host);
  if(placed)select.value=placed.value;
  newTabRetrying=false;newTabSubmitText();paintNewTabMachine();closeNewTabProjectPicker(false);
  newTabProjectEdited=false;clearNewTabFieldProblem();$('new-tab-project').value=placed&&place.project||newTabSavedProject(JSON.parse(select.value)[0]);updateNewTabProject();
  loadNewTabProjects();loadNewTabModels();
  if(!history.state?.switchboardNewTab)history.pushState({...history.state,switchboardNewTab:true},'');
  attachNewTabCompletions();$('new-tab-dialog').showModal();fitNewTabPrompt();fitNewTabDialog();
  $('new-tab-prompt').focus();
}
function lastFolder(path){return path.split(/[\\/]/).filter(Boolean).pop()||path;}
function newTabProjectLabel(path){
  const parts=path.replaceAll('\\','/').split('/').filter(Boolean);
  for(let count=1;count<parts.length;count++){
    const label=parts.slice(-count).join('/'),suffix='/'+label.toLowerCase();
    if(!newTabProjects.some(other=>other!==path&&('/'+other.replaceAll('\\','/')).toLowerCase().endsWith(suffix)))return label;
  }
  return path;
}
function newTabLookup(inputId,listId,buttonId,items,emptyText,onChange=()=>{},next=null){
  const input=$(inputId),list=$(listId),button=$(buttonId),popup=list.parentElement;let index=-1,showAll=false;
  const status=popup.querySelector('.new-tab-options-status'),hint=popup.querySelector('.new-tab-options-hint');
  function showHint(){const name=list.querySelectorAll('[role=option] span')[index]?.textContent;hint.replaceChildren();if(!name){hint.textContent='Choose a folder, or type a full path';return;}const enter=document.createElement('kbd'),tab=document.createElement('kbd');enter.textContent='↵';tab.textContent='Tab';hint.append(enter,' Select '+name+'  ·  ',tab,' Fill');}
  function close(){popup.hidden=true;index=-1;input.setAttribute('aria-expanded','false');button.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');input.dispatchEvent(new Event('lookuptoggle'));}
  function highlight(next){index=next;showHint();[...list.querySelectorAll('[role=option]')].forEach((option,i)=>option.setAttribute('aria-selected',String(i===index)));const option=list.querySelectorAll('[role=option]')[index];if(option)input.setAttribute('aria-activedescendant',option.id);}
  // A tapped or clicked suggestion moves on to the next field; the keyboard keeps its place.
  function choose(value,pointer=false){input.value=value;onChange();close();if(pointer&&next)$(next).focus();else{input.focus();input.select();}}
  function open(all=false){
    showAll=all;const query=all?'':input.value.toLowerCase().replaceAll('\\','/');list.replaceChildren();index=-1;input.removeAttribute('aria-activedescendant');
    const matches=items().filter(([name,detail,label=''])=>(name+' '+detail+' '+label).toLowerCase().replaceAll('\\','/').includes(query));
    // A full path ranks by its last folder too, so typing a repository name finds it.
    const rank=([name,,label=name])=>Math.max(...[name,lastFolder(name),label].map(text=>{text=text.toLowerCase().replaceAll('\\','/');return text===query?2:text.startsWith(query)?1:0;}));
    matches.sort((a,b)=>rank(b)-rank(a));
    for(const [name,detail,label=name] of matches){
      const option=document.createElement('div');option.id=listId+'-'+list.children.length;option.setAttribute('role','option');option.setAttribute('aria-selected','false');
      option.dataset.value=name;option.title=name;
      const text=document.createElement('span'),description=document.createElement('small');const at=query?label.toLowerCase().indexOf(query):-1;
      if(at<0)text.textContent=label;else{const match=document.createElement('b');match.textContent=label.slice(at,at+query.length);text.append(label.slice(0,at),match,label.slice(at+query.length));}
      description.textContent=detail;description.hidden=!detail;option.append(text,description);
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
      // Tab fills the suggestion and moves on to the model; Enter fills it and moves on to the prompt.
      choose(list.querySelectorAll('[role=option]')[index].dataset.value);
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
  newTabCompletions?.paint();
}
let newTabProjects=[],newTabProjectMessage='',newTabProjectRequest;
const newTabProjectLookup=newTabLookup('new-tab-project','new-tab-projects','new-tab-project-lookup',()=>newTabProjects.map(name=>{const path=name.replaceAll('\\','/');return [name,path.includes('/')?path.slice(0,path.lastIndexOf('/')):'',newTabProjectLabel(name)];}),()=>newTabProjectMessage||'No matching folders. Type a name in ~/git or a full path.',()=>{newTabProjectEdited=true;updateNewTabProject();},'new-tab-prompt');
// Registered after the lookup's own keys: Tab fills the name, then moves on to the model.
// Enter only settles the folder and never submits the form.
$('new-tab-project').addEventListener('keydown',event=>{if(event.key==='Tab'&&!event.shiftKey){event.preventDefault();focusNewTabField($('new-tab-model'));}else if(event.key==='Enter'){event.preventDefault();if(!event.isComposing)closeNewTabProjectPicker(true);}});
// The closest listed name, by containment or a small edit distance.
function closestNewTabProject(project){
  const query=project.toLowerCase();let best='',bestScore=Infinity;
  for(const name of newTabProjects)for(const lower of new Set([name.toLowerCase(),lastFolder(name).toLowerCase()])){
    let score;
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
  loadNewTabProjects();loadNewTabModels();
};
function setHandoverProject(){
  const source=newTabHandover?.context?.source;if(!source?.project)return;
  $('new-tab-project').value=source.project;updateNewTabProject();
}
async function loadNewTabHandover(){
  const handover=newTabHandover;if(!handover)return;
  handover.request?.abort();const request=handover.request=new AbortController();handover.context=null;
  $('handover-preview').hidden=false;$('handover-summary').textContent='Loading conversation…';$('handover-retry').hidden=true;newTabBusy(false);
  try{
    const context=await SwitchboardHandover.load(handover.source,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(60000)])});
    if(newTabHandover!==handover||handover.request!==request||!$('new-tab-dialog').open)return;
    handover.context=context;setHandoverProject();
    $('handover-preview').hidden=true;
    $('handover-summary').textContent='Context ready';
    newTabBusy(false);placeModelSwitch();
  }catch(error){if(newTabHandover!==handover||handover.request!==request)return;$('handover-summary').textContent=error.name==='TimeoutError'?'Loading context timed out. Retry when the source computer is connected.':error.message;$('handover-retry').textContent='Retry loading context';$('handover-preview').hidden=false;$('handover-retry').hidden=false;placeModelSwitch();}
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
  // Only a skill's turn appears in Conversation, so no message waits for other commands.
  const route=newTabCommand(typed)?globalThis.SwitchboardConversation.commandRoute(newTabAgent(launch.command),typed):null,started=route&&route!=='turn'?null:promptLaunch(launch,typed);
  entry.creatingTab={id:'creating',pending:true,name:'Creating tab…',position:Infinity,panes:[],project:launch.project,launch:started,requestedModel:requestedModel(launch)};
  const placeholder=selected=tabKey(entry,entry.creatingTab);pushTabHistory=true;restoringTab=false;entry.followActiveTab=false;
  if(filter!=='all'&&groups[hostId]!==filter)setFilter('all');$('tab-search').value='';
  sidebarOpen=false;updateSidebar();$('new-tab-dialog').close();render();globalThis.SwitchboardConversation.focus();
  try{
    const response=await fetch(`/hosts/${encodeURIComponent(hostId)}/new-tab`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:name,...launch})});
    if(!response.ok)throw Error(response.status===404?'Update Switchboard on this computer to create tabs from Conversation.':await response.text());
    const result=await response.json();if(!Number.isInteger(result.pane_id)||result.pane_id<0)throw Error('The new tab did not return its identity. Check the tab list before retrying.');
    if(entry.pendingNewTab!==pending)return;
    entry.apiCreationPane=result.pane_id;
    requestedProjects.set(JSON.stringify([hostId,name,result.pane_id]),launch.project);requestedModels.set(JSON.stringify([hostId,name,result.pane_id]),requestedModel(launch));
    if(started)launches.set(JSON.stringify([hostId,name,result.pane_id]),started);
    const tab={id:result.pane_id,pending:true,name:'New tab',position:Infinity,panes:[{pane_id:result.pane_id,is_plugin:false,tab_position:Infinity}],project:launch.project,launch:started,requestedModel:requestedModel(launch)};
    entry.provisionalTabs??=[];entry.provisionalTabs.push(tab);entry.creatingTab=null;entry.pendingNewTab=null;
    if(selected===placeholder)selected=tabKey(entry,tab);
    render();if(route==='terminal')globalThis.SwitchboardConversation.showTerminal();refreshAttention(true);refresh();
  }catch(error){failNewTab(entry,pending.requestId,error.message||'Could not confirm tab creation. Check the tab list before retrying.');}
}
let newTabFiles=[];
function clearNewTabFiles(){
  for(const item of newTabFiles)if(item.preview)URL.revokeObjectURL(item.preview);
  newTabFiles=[];paintNewTabFiles();$('new-tab-error').textContent='';
}
function newTabBusy(busy){
  $('new-tab-close').title=busy?'Stop and close · Esc':'Close · Esc';$('new-tab-close').setAttribute('aria-label',busy?'Stop upload and close':'Close');$('new-tab-form').classList.toggle('busy',busy);
  for(const control of $('new-tab-form').querySelectorAll('input,textarea,select,button,[role="textbox"]'))control.disabled=busy&&control.id!=='new-tab-close'&&control.id!=='handover-cancel';
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
  const files=[...(event.clipboardData?.files||[])];if(files.length){event.preventDefault();event.stopPropagation();addNewTabFiles(files);const text=event.clipboardData.getData('text/plain');if(text){const input=$('new-tab-prompt');input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');}}
},true);
// Dragging files over the dialog highlights the prompt, where they land.
let newTabDragDepth=0;
function newTabDragging(on){$('new-tab-form').querySelector('.new-tab-composer').classList.toggle('dragging',on&&!newTabHandover);}
$('new-tab-form').addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')){newTabDragDepth++;newTabDragging(true);}});
$('new-tab-form').addEventListener('dragleave',()=>{if(newTabDragDepth&&!--newTabDragDepth)newTabDragging(false);});
$('new-tab-form').addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
$('new-tab-form').addEventListener('drop',event=>{newTabDragDepth=0;newTabDragging(false);if(event.dataTransfer?.files.length){event.preventDefault();addNewTabFiles([...event.dataTransfer.files]);}});
$('new-tab-prompt').addEventListener('keydown',event=>{if(newTabCompletions?.key(event))return;if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!(matchMedia('(pointer:coarse)').matches&&!matchMedia('(any-pointer:fine)').matches)){event.preventDefault();$('new-tab-form').requestSubmit();}},true);
// On a phone the sheet rests on the on-screen keyboard, so Create stays in reach.
function fitNewTabDialog(){
  if(newTabHandover){placeModelSwitch();return;}
  const dialog=$('new-tab-dialog'),view=globalThis.visualViewport,fit=dialog.open&&view&&matchMedia('(max-width:700px), (pointer:coarse)').matches;
  dialog.style.marginBottom=fit?Math.max(0,innerHeight-view.offsetTop-view.height)+'px':'';dialog.style.maxHeight=fit?view.height-12+'px':'';
}
addEventListener('resize',fitNewTabDialog);globalThis.visualViewport?.addEventListener('resize',fitNewTabDialog);globalThis.visualViewport?.addEventListener('scroll',fitNewTabDialog);
// The close event is queued; a reopen before it arrives owns the dialog, so leave its draft alone.
$('new-tab-dialog').addEventListener('close',()=>{if($('new-tab-dialog').open)return;$('new-tab-form').pendingSubmission?.uploads?.abort();$('new-tab-form').pendingSubmission=null;clearNewTabHandover();newTabBusy(false);clearNewTabFiles();runPendingSwitches();if(history.state?.switchboardNewTab&&!pushTabHistory){leavingNewTabEntry=true;history.back();}});
$('new-tab-form').onsubmit=async event=>{
  event.preventDefault();const form=$('new-tab-form');if(form.pendingSubmission)return;
  if(newTabHandover)newTabModelMenu.commit();
  const key=$('new-tab-target').value,project=$('new-tab-project').value.trim(),command=ModelPicker.fit(newTabModel(),newTabHostCodexModels(),newTabHostClaudeModels()),text=newTabHandover?newTabHandover.text:newTabCompletions?.expand($('new-tab-prompt').value)??$('new-tab-prompt').value,files=[...newTabFiles],elevated=newTabElevated;
  const handover=newTabHandover?.context,source=newTabHandover?.source;if(newTabHandover&&!handover)return;
  if(!newTabHandover&&!text.trim()&&!files.length){$('new-tab-error').textContent='Type a prompt to start this chat.';$('new-tab-prompt').focus();return;}
  if(/[\x00-\x08\x0b-\x1f\x7f]/.test(text)||new TextEncoder().encode(text).length>16000){$('new-tab-error').textContent='Use a prompt up to 16 KB without control characters.';return;}
  if(!newTabHandover&&files.length&&newTabAgent(command)!=='claude'&&newTabCommand(text)){$('new-tab-error').textContent='Send commands without attachments.';return;}
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
      saveNewTabModel(command);
      if(isCurrent())$('new-tab-dialog').close();
      await refreshAttention(true);setStatus('Continuing with '+(newTabModelProvider(command)==='claude'?'Claude':'Codex')+' in the same tab.');return;
    }
    const prompt=text+(others.length?'\n\nAttached files:\n'+others.join('\n'):'');
    if(new TextEncoder().encode(prompt).length>16000)throw Error('The prompt and file paths must fit within 16 KB.');
    saveNewTabModel(command);
    saveNewTabProject(host,project);
    await createNewTab(key,{project,command,prompt,images,elevated},isCurrent,text);
  }catch(error){if(isCurrent()){uploads.abort();newTabRetrying=true;newTabProblem(error.message);}}
  finally{if(form.pendingSubmission===request){form.pendingSubmission=null;newTabUploadStatus('');for(const item of files)if(item.state==='uploading')delete item.state;paintNewTabFiles();newTabBusy(false);newTabSubmitText();}}
};
async function createNewTab(key,launch,isCurrent=()=>true,typed){
  if(!launch.command&&typeof launch.prompt!=='string')return;
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
    if(entry&&!entry.starting){entry.inputTiming?.end('left');entry.frame.remove();sessions.delete(key);}
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
  entry.creatingTab={id:'creating',pending:true,name:'Creating tab…',position:Infinity,panes:[],project:launch.project,launch:promptLaunch(launch,typed??launch.prompt),requestedModel:requestedModel(launch)};
  selected=tabKey(entry,entry.creatingTab);pushTabHistory=true;
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
  setTimeout(()=>(newTabHandover?$('new-tab-submit'):field==='target'?$('new-tab-machine'):$('new-tab-prompt')).focus());
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
    if(frame&&frame.getAttribute('src')!==frame.dataset.src)replaceFrameSrc(frame,frame.dataset.src);
    if(focusTab)tab.focus();
  }
  if(name==='logs')loadLogs();
  if(name==='performance')loadTimings();
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
  for(const frame of panel.querySelectorAll('iframe'))replaceFrameSrc(frame,'about:blank');
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
      const timing=entry=>/^(Terminal (transport|switch(?! slow)|viewport|control|scrolling|new tab ready|load ready)|Browser Shift\+Enter|Browser tab resumed|Conversation shown ready) /.test(entry.message);
      const errors=entries.filter(entry=>!timing(entry)),samples=entries.filter(timing);
      if(computer.error)group.append(element('p','log-note',computer.error));
      else if(!errors.length)group.append(element('p','log-note','No recent errors'));
      const row=entry=>{
        const row=element('div','log-entry',''),when=new Date(entry.time);
        const meta=element('small','',[entry.source,when.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}),entry.count>1?`×${entry.count}`:''].filter(Boolean).join(' · '));
        meta.title=humanTime(when);row.append(element('span','',entry.message),meta);
        if(entry.failure){
          const details=element('details','log-failure',''),summary=element('summary','','Failure details');
          details.append(summary,element('pre','',JSON.stringify({...entry.failure,references:entry.references},null,2)));row.append(details);
        }
        return row;
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
const timingJourneys={terminal_to_conversation:'Terminal → Conversation',conversation_to_terminal:'Conversation → Terminal',terminal_input_ready:'Enable terminal typing',conversation_select:'Switch chat',conversation_load:'Load chat',conversation_connect:'Connect to agent’s chat'};
// Below this many samples a p95 is just the slowest one or two.
const timingMinimumForP95=20;
async function loadTimings(){
  const list=$('timings'),button=$('refresh-timings');
  const element=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;node.textContent=text;return node;};
  const ms=value=>value==null?'—':value<1000?`${value} ms`:`${(value/1000).toFixed(1)} s`;
  const stat=(label,value,title)=>{const node=element('span','timing-stat',`${label} ${value}`);if(title)node.title=title;return node;};
  const sample=item=>{
    const row=element('div','timing-sample','');
    row.append(element('small','',`${ms(item.elapsed_ms)} · ${item.outcome} · ${new Date(item.time).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`));
    for(const [name,value] of item.stages){
      const stage=element('div','timing-stage',''),bar=element('i','','');
      bar.style.width=`${Math.min(100,item.elapsed_ms?value/item.elapsed_ms*100:0)}%`;
      const track=element('span','timing-track','');track.append(bar);
      stage.append(element('span','',name),track,element('span','',ms(value)));row.append(stage);
    }
    return row;
  };
  const series=item=>{
    const details=element('details','timing-series',''),summary=element('summary','',''),title=element('span','timing-title',timingJourneys[item.journey]||item.journey);
    const enough=item.count>=timingMinimumForP95;
    summary.append(title,element('small','',`${item.target} · ${item.build}`),stat('n',item.count),stat('p50',ms(item.p50_ms)),
      stat('p95',enough?ms(item.p95_ms):'—',enough?'':`Needs ${timingMinimumForP95} samples`),stat('max',item.max_ms?ms(item.max_ms):'—'));
    const outcomes=Object.entries(item.outcomes).map(([name,count])=>`${name} ${count}`);
    details.append(summary,element('p','log-note',[...outcomes,item.hidden?`${item.hidden} left out because the page was hidden`:''].filter(Boolean).join(' · ')),...item.slowest.map(sample));
    return details;
  };
  button.disabled=true;list.setAttribute('aria-busy','true');
  try{
    const response=await fetch('/api/timings',{cache:'no-store'});
    if(!response.ok)throw new Error('Timings unavailable');
    const {computers=[]}=await response.json();
    list.replaceChildren(...computers.map(computer=>{
      const group=element('section','log-computer','');group.append(element('h4','',computer.name));
      if(computer.error)group.append(element('p','log-note',computer.error));
      else if(!computer.series?.length)group.append(element('p','log-note','No timings yet'));
      else group.append(...computer.series.map(series));
      return group;
    }));
  }catch(_){list.replaceChildren(element('p','log-note','Timings unavailable; refresh to try again.'));}
  finally{button.disabled=false;list.setAttribute('aria-busy','false');}
}
$('refresh-timings').onclick=loadTimings;
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
function newTabModelLabel(value){const choice=ModelPicker.describe(value,newTabHostCodexModels(),newTabHostClaudeModels());return choice.name+(choice.effort?' '+choice.effortName:'');}
function openAgentHandover(item,paneId){
  const target=agentChatTarget(item,paneId);if(!target||!switchPossible(target.state)||!globalThis.SwitchboardHandover)return;
  const queued=pendingSwitches.get(item.key);if(queued?.running){closeTabMenu();setStatus('The model switch is already running.');return;}
  const host=item.entry.host,chatHost=hosts.get(host)?.local?'local':host;
  const historyUrl=new URL('/api/chats/'+encodeURIComponent(target.state.chat_id),location.origin);historyUrl.search=new URLSearchParams({host:chatHost,context:'true',limit:50});
  const source={host,chatHost,chatId:target.state.chat_id,agent:target.state.agent,title:tabTitle(item),computer:hosts.get(host)?.name||host,project:target.pane.cwd,historyUrl:historyUrl.href,target:{session:item.entry.name,pane_id:target.pane.pane_id,tab_id:item.tab.id,chat_id:target.state.chat_id},tab:item.key};
  closeTabMenu();openNewTabDialog(false);if(!$('new-tab-dialog').open)return;
  const option=[...$('new-tab-target').options].find(option=>JSON.parse(option.value)[0]===host);
  if(!option){$('new-tab-dialog').close();setStatus('The source computer is unavailable.',true);return;}
  $('new-tab-target').value=option.value;paintNewTabMachine();loadNewTabProjects();loadNewTabModels();
  $('new-tab-title').textContent='Switch model';$('new-tab-note').textContent='';
  setNewTabModel(queued?.model||newTabSavedModel(source.agent==='claude'?'codex':'claude'));
  $('new-tab-dialog').classList.add('handover-mode');
  const anchor=globalThis.SwitchboardConversation?.isOpen?.()?document.querySelector('.conversation-model'):null;
  newTabHandover={source,anchor,text:queued?.text||''};
  fitNewTabModel();
  for(const id of ['handover-picker','handover-actions'])$(id).hidden=false;
  $('handover-actions').append($('new-tab-submit'));
  newTabSubmitText();newTabModelMenu.embed($('handover-picker'));loadNewTabHandover();placeModelSwitch();
  if(matchMedia('(max-width:700px),(pointer:coarse)').matches)$('new-tab-model-menu').focus({preventScroll:true});else newTabModelMenu.search.focus({preventScroll:true});
}
function placeModelSwitch(){
  const dialog=$('new-tab-dialog');if(!newTabHandover||!dialog.open)return;
  const view=globalThis.visualViewport,compact=matchMedia('(max-width:700px),(pointer:coarse)').matches;
  if(compact){
    Object.assign(dialog.style,{left:'0px',top:'auto',bottom:Math.max(0,innerHeight-(view?.height||innerHeight)-(view?.offsetTop||0))+'px',width:'100vw',maxHeight:((view?.height||innerHeight)-12)+'px',marginBottom:'0px'});return;
  }
  const width=Math.min(560,innerWidth-24),height=Math.min(dialog.scrollHeight,innerHeight-24),anchor=newTabHandover.anchor;
  const rect=anchor?.isConnected?anchor.getBoundingClientRect():null;
  Object.assign(dialog.style,{width:width+'px',maxHeight:(innerHeight-24)+'px',bottom:'auto',marginBottom:'0px',left:Math.max(12,Math.min(rect?.left??innerWidth-width-24,innerWidth-width-12))+'px',top:Math.max(12,Math.min((rect?.top||innerHeight-16)-height-8,innerHeight-height-12))+'px'});
}
// Restarts the agent in its tab with the model, carrying recent history and
// any previously queued instructions. Drafts and attachments stay in the composer.
async function switchAgentModel(source,model,text,context,isCurrent=()=>true){
  context||=await SwitchboardHandover.load(source,{signal:AbortSignal.timeout(60000)});
  const response=await fetch('/api/hosts/'+encodeURIComponent(source.host)+'/attachments?'+new URLSearchParams({name:'switchboard-context-handover.json'}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:JSON.stringify(context)});
  if(!isCurrent())return null;
  if(!response.ok)throw Error('Could not transfer context to the destination computer. Try again.');
  const data=await response.json();if(typeof data.path!=='string'||!data.path||/[\x00-\x1f]/.test(data.path))throw Error('Invalid handover file response. Try again.');
  const prompt=SwitchboardHandover.prompt(data.path,text);
  if(new TextEncoder().encode(prompt).length>16000)throw Error('The prompt and file paths must fit within 16 KB.');
  const restart=await fetch('/api/hosts/'+encodeURIComponent(source.host)+'/restart-agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...source.target,handover:{model,prompt,source_messages:context.coverage.total_messages}}),signal:AbortSignal.timeout(120000)});
  if(!restart.ok)throw Error(await restart.text()||'Could not switch models.');
  const result=await restart.json();
  if(!Number.isInteger(result.pane_id)||result.tab_id!==source.target.tab_id)throw Error('The switch was not confirmed. Check the terminal before trying again.');
  requestedModels.set(JSON.stringify([source.host,source.target.session,result.pane_id]),requestedModel({command:model}));
  globalThis.SwitchboardConversation?.handoverSent?.(source,text,result.pane_id);
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
  const parking=parkedTab(item);
  $('snooze-tab').hidden=!!parking;
  $('snooze-tab').disabled=!!item.tab.pending||systemTab(item.tab);
  $('settle-tab').textContent=parking?'Wake thread':'Settle thread';
  $('settle-tab').title=parking?'':settleTitle;
  $('settle-tab').disabled=!!item.tab.pending||systemTab(item.tab)||!parking&&!closeTabTarget(item);
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
  if(parkedTab(item)){delete parkedTabs[canonKey(item.key)];saveParkedTabs();}
  setPinned(item,!isPinned(item.key));
  closeTabMenu();render();
  tabButtons.get(item.key)?.scrollIntoView({block:'nearest',inline:'nearest'});
  if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();else allTabs().find(t=>t.key===selected)?.entry.frame.focus();
};
$('hide-tab').onclick=()=>{
  const item=contextItem;if(!item)return;
  if(parkedTab(item)){delete parkedTabs[canonKey(item.key)];saveParkedTabs();}
  setHidden(item,!item.hidden);
  closeTabMenu();render();
  tabButtons.get(item.key)?.scrollIntoView({block:'nearest',inline:'nearest'});
  if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();else allTabs().find(t=>t.key===selected)?.entry.frame.focus();
};
$('snooze-tab').onclick=()=>{if(contextItem)openSnooze(contextItem,menuTrigger);};
$('settle-tab').onclick=()=>{const item=contextItem;if(!item)return;settleTab(item);};
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
$('tab-search').onkeydown=event=>{if(event.key==='Enter'){const item=listedTabs()[0];if(item){event.preventDefault();activate(item);if(globalThis.SwitchboardConversation?.isOpen?.())globalThis.SwitchboardConversation.focus();else{if(item.entry.frame.inert)$('tab-search').blur();item.entry.frame.focus();}}}};
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
    showSubmittedTurns();
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
  }catch(_){
    attentionLoaded=true;relayLost();
    // A relay restart (an update) takes a few seconds. Keep every tab's last
    // status meanwhile instead of flipping them all to Unavailable and back.
    if(relayRestarting())attentionErrors=[{host:'Switchboard',pending:true}];
    else{paneAttention.clear();askpassRequests=[];attentionErrors=[{host:'Switchboard'}];}
    render();return false;
  }
  finally{if(!watch){attentionLoading=false;if(attentionRefreshPending){attentionRefreshPending=false;refreshAttention();}}}
}
function keyedAttention(states){
  return new Map(states.map(state=>{const key=attentionKey(state.host,state.session,state.pane_id);return [key,{...state,key}];}));
}
// An agent reports a new turn only after starting a hook process, so show Working from
// the moment of submission. Anything newer from the relay replaces it; so does the
// timeout, when the submission did not start a turn.
const SUBMITTED_TURN_MS=5000,submittedTurns=new Map();
function showSubmittedTurns(){
  for(const [key,turn] of submittedTurns){
    const state=paneAttention.get(key);
    if(!state||Date.now()>=turn.at+SUBMITTED_TURN_MS||state.state!==turn.state||state.token!==turn.token){submittedTurns.delete(key);continue;}
    paneAttention.set(key,{...state,state:'working',since:turn.at/1000});
  }
}
// Esc goes straight to the terminal and Claude sends no hook for it, so the relay is asked
// to read the pane. Only for a working Claude pane: Esc is a common key and this spawns reads.
const settlingInterrupts=new Set();
function settleInterrupt(host,session,pane){
  const key=attentionKey(host,session,pane),state=paneAttention.get(key);
  if(state?.agent!=='claude'||state.state!=='working'||settlingInterrupts.has(key))return;
  settlingInterrupts.add(key);setTimeout(()=>settlingInterrupts.delete(key),1000);
  fetch(`/api/hosts/${encodeURIComponent(host)}/settle-interrupt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session,pane_id:pane})}).catch(()=>{});
}
function submittedTurn(host,session,pane){
  const key=attentionKey(host,session,pane),state=paneAttention.get(key);
  if(!state?.agent||!['ready','waiting'].includes(state.state))return;
  const at=Date.now();
  submittedTurns.set(key,{state:state.state,token:state.token,at});
  paneAttention.set(key,{...state,state:'working',since:at/1000});render();
  setTimeout(()=>refreshAttention(),SUBMITTED_TURN_MS+50);
}
// An upgrade restarts the relay for about a second. Retry every 250 ms for 10 s
// instead of waiting for the next poll, and reload hosts once it answers.
let relayLostAt=0;
const RELAY_RESTART_GRACE_MS=30000;
function relayRestarting(){return !!relayLostAt&&Date.now()-relayLostAt<RELAY_RESTART_GRACE_MS;}
function relayLost(){
  relayLostAt||=Date.now();
  if(Date.now()-relayLostAt<10000)setTimeout(refreshAttention,250);
}
// The relay answers as soon as status changes, so tabs update without polling.
refreshAttention();
(async()=>{for(;;)if(!await refreshAttention(false,true))await new Promise(resolve=>setTimeout(resolve,2000));})();

// A return to a Terminal viewer kept alive behind Conversation; its report says when the frame painted.
let terminalReturn=null;
function finishTerminalReturn(diagnostic){
  if(!terminalReturn)return;
  const painted=diagnostic.terminal_animation_ms??diagnostic.first_animation_ms;
  // A terminal asked to paint that never answered is a stalled wait, not a fast sidebar frame.
  const stalled=diagnostic.terminal_probe&&diagnostic.terminal_animation_ms===null;
  const outcome=!diagnostic.outcome||diagnostic.outcome==='sampled'?(stalled?'timeout':painted===null?'no_frame':'ready'):diagnostic.outcome;
  terminalReturn.end(outcome,{elapsed:stalled?diagnostic.elapsed_ms:painted??undefined,
    stages:{sidebar_frame:diagnostic.first_animation_ms,terminal_message:diagnostic.terminal_message_ms,terminal_frame:diagnostic.terminal_frame_ms,terminal_render_cycle:diagnostic.terminal_render_cycle_ms,terminal_reply:diagnostic.terminal_reply_ms}});
  terminalReturn=null;
}
const browserDiagnostics=window.SwitchboardBrowserDiagnostics?.(diagnostic=>{
  if(diagnostic.reason==='conversation')finishTerminalReturn(diagnostic);
  fetch('/api/diagnostics/browser-resume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(diagnostic),keepalive:true})
    .then(response=>{if(!response.ok)throw Error(`HTTP ${response.status}`);})
    .catch(error=>console.warn('Browser resume diagnostics unavailable:',error));
},(id,started_at)=>{
  const current=allTabs().find(item=>item.key===selected);
  if(!current||!$('artifact-preview').hidden||document.querySelector('dialog[open]'))return false;
  current.entry.frame.contentWindow.postMessage({type:'zellij-browser-resume',id,started_at},location.origin);
  return true;
});

// When Conversation opened, so a slow switch back to Terminal reports how long it was away.
let conversationSince=null;
window.SwitchboardConversation?.install({
  viewed:acknowledgeConversation,
  newTabHere:place=>openNewTabDialog(false,place),
  notSent(key){if(submittedTurns.delete(key))refreshAttention();},
  sending(view,command){
    if(!command)submittedTurn(view.host,view.session,view.pane);
    const item=allTabs(true).find(item=>item.entry.host===view.host&&item.entry.name===view.session&&item.tab.panes.some(p=>!p.is_plugin&&p.pane_id===view.pane));
    if(item&&parkedTab(item)){delete parkedTabs[canonKey(item.key)];saveParkedTabs();render();}
  },
  switchModel(view){openAgentHandover(allTabs().find(item=>item.key===selected),view?.pane);},
  cancelSwitch(){cancelSwitch(selected);},
  idle(){if(pendingSwitches.size)queueMicrotask(runPendingSwitches);},
  modeChanged(transient){
    const wants=globalThis.SwitchboardConversation.wantsConversation(),shown=allTabs().find(item=>item.key===selected);
    terminalInputTransient=transient&&!wants?shown?.key:null;
    // Terminal either shows the viewer kept through Conversation or loads a new one.
    // Time both, except the brief automatic visit that sends a reply.
    const timed=!wants&&conversationSince!==null&&!!shown&&!transient,blank=shown?.entry.frame.getAttribute('src')==='about:blank';
    // Measure first: replacing an earlier return's sample ends that return, not this one.
    if(timed&&!blank){browserDiagnostics?.measure('conversation',conversationSince,finishTerminalReturn);terminalReturn=window.SwitchboardTiming?.begin('conversation_to_terminal',{host:shown.entry.host})||null;}
    if(wants){terminalReturn?.end('left');terminalReturn=null;}
    for(const entry of sessions.values()){if(wants){entry.loadAfter=null;entry.loadTiming?.end('left');entry.loadTiming=null;}syncTerminalConnection(entry);}render();
    if(timed&&blank&&shown.entry.frame.getAttribute('src')!=='about:blank'){shown.entry.loadAfter='conversation';shown.entry.loadTiming=window.SwitchboardTiming?.begin('conversation_to_terminal',{host:shown.entry.host})||null;}
    conversationSince=wants?conversationSince??performance.now():null;

    // A viewer kept connected through Conversation reclaims its tab size, which
    // another computer may have taken meanwhile.
    const current=allTabs().find(item=>item.key===selected);
    if(!globalThis.SwitchboardConversation.wantsConversation()&&current?.entry.state&&document.hasFocus())current.entry.frame.contentWindow?.postMessage({type:'zellij-window-focus'},location.origin);
  },
  selection(item=allTabs().find(item=>item.key===selected)){
    if(!item)return null;
    const active=item.entry.state?.active_pane,panes=(!item.entry.state?item.tab.panes:tabPanes(item.entry,item.tab)).filter(p=>!p.is_plugin);
    const preferred=item.entry.resumePane||active,launch=launchingTab(item);
    const pane=panes.find(p=>p.pane_id===preferred?.pane_id)||panes.find(p=>p.is_focused)||panes[0];if(!pane)return {key:item.key,host:item.entry.host,computer:hosts.get(item.entry.host)?.name,project:launchedProject(item),frame:item.entry.frame,title:displayTitle(item),state:launch?'working':undefined,since:launch?.at/1000,starting:!!item.tab.pending,launch:launchFor(item),requestedModel:item.tab.requestedModel};

    const state=paneAttention.get(attentionKey(item.entry.host,item.entry.name,pane.pane_id)),queued=pendingSwitches.get(item.key);
    return {key:JSON.stringify([item.entry.host,item.entry.name,pane.pane_id]),host:item.entry.host,showCost:chatCostShown(item.entry.host),chatHost:hosts.get(item.entry.host)?.local?'local':item.entry.host,session:item.entry.name,tab:item.tab.id,pane:pane.pane_id,frame:item.entry.frame,terminalReady:!item.entry.suspended&&!item.entry.disconnected&&!item.entry.needsFocus&&!item.entry.focusPending&&active?.pane_id===pane.pane_id,title:displayTitle(item),agent:state?.agent,state:launch?'working':state?.state,chatId:state?.chat_id,since:launch?launch.at/1000:state?.since,turnState:state?.turn_state,computer:hosts.get(item.entry.host)?.name,project:launchedProject(item,pane),switchAvailable:switchPossible(state),pendingSwitch:queued?.source.target.pane_id===pane.pane_id?queued:null,starting:!!item.tab.pending,launch:launchFor(item),requestedModel:requestedModels.get(JSON.stringify([item.entry.host,item.entry.name,pane.pane_id]))||item.tab.requestedModel};
  },
  openConversation(peer){
    const matches=allTabs(true).filter(item=>statesForTab(item).some(state=>state.chat_id===peer.chat_id));
    const item=matches.find(item=>item.entry.host===peer.host)||(matches.length===1?matches[0]:null);
    if(!item)return false;activate(item);return true;
  },
  terminal(target){const item=allTabs().find(item=>item.key===selected);if(item&&item.entry.frame===target.frame){item.entry.frame.focus();focus(item);}}
});
if(globalThis.SwitchboardConversation?.wantsConversation?.())conversationSince=performance.now();

new MutationObserver(updateMobileTerminalViewport).observe($('terminals'),{attributes:true,attributeFilter:['class']});
updateMobileTerminalViewport();
