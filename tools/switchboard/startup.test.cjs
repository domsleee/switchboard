const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');

function workspace(initial){
  let catalog=initial;
  const mounted=[],timeouts=[],elements=new Map(),creations=[];
  const context={newTabElevated:false,loading:false,hosts:new Map(),sessions:new Map(),tabCatalog:[],ready:{},hidden:{},parkedTabs:{},saveParkedTabs(){},tabOrder:[],selected:null,filter:'all',
    catalogUnavailable:()=>false,saveReady(){},localStorage:{setItem(){}},renderMachines(){},render(){},setStatus(){},clearTimeout(){},setTimeout:fn=>timeouts.push(fn),
    document:{createElement:()=>({getAttribute(name){return this[name];},remove(){this.removed=true;},focus(){}})},$:id=>elements.get(id),
    createNativeTab:async(key,launch)=>creations.push({key,launch}),
    fetch:async url=>({ok:true,json:async()=>url==='/api/hosts?summary=1'?[{id:'windows',name:'Windows'}]:catalog})};
  elements.set('new-tab-project',{value:'switchboard'});elements.set('new-tab-prompt',{value:'c'});
  elements.set('terminals',{append:frame=>mounted.push(frame)});
  elements.set('new-tab-form',{});elements.set('new-tab-target',{value:JSON.stringify(['windows','main'])});elements.set('new-tab-dialog',{close(){}});elements.set('tab-search',{value:''});
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function sessionKey('),source.indexOf('function attentionKey(')),context);
  vm.runInContext(source.slice(source.indexOf('function syncTerminalConnection('),source.indexOf("window.addEventListener('message'")),context);
  const submit=source.indexOf("async function createNewTab(");
  vm.runInContext(source.slice(submit,source.indexOf("$('ready').onclick=",submit)),context);
  return {context,mounted,timeouts,elements,creations,catalog:value=>catalog=value};
}

const create=w=>w.context.createNewTab(w.elements.get('new-tab-target').value,{project:'switchboard',prompt:'',images:[],elevated:false});

test('an empty machine starts nothing on its own; + starts one shell that survives delayed catalogs and stays closed after its last tab exits',async()=>{
  const host={id:'windows',name:'Windows',sessions:[]},w=workspace(host),c=w.context;
  // Every page load and poll sees the empty machine; none of them may create a session.
  await c.refresh();await c.refresh();assert.equal(w.mounted.length,0);assert.equal(c.sessions.size,0);
  await create(w);
  assert.equal(w.mounted.length,0,'The creation API must start the session before attaching a viewer');
  assert.equal(w.creations.length,1);assert.equal(w.creations[0].launch.project,'switchboard');
  // The native creation response is followed by a viewer of the now-live session.
  const entry=c.connectSession(host,'main',true);
  await c.refresh();assert.equal(c.sessions.size,1);assert.equal(w.mounted.length,1);
  const pane={pane_id:7,is_plugin:false,tab_position:0};
  entry.state={session_name:'main',active_pane:pane,panes:[pane],tabs:[{position:0,name:'Shell'}]};
  c.updateCreatedTabs(entry);
  assert.equal(entry.starting,false);assert.equal(c.sessionTabs(entry).length,1);assert.equal(c.activeTab(entry).name,'Shell');
  w.catalog({...host,sessions:[{name:'main',web_clients_allowed:true}]});await c.refresh();assert.equal(w.mounted.length,1);
  w.catalog(host);await c.refresh();assert.equal(c.sessions.size,0);assert.equal(entry.frame.removed,true);
  await c.refresh();assert.equal(w.mounted.length,1);
  // + remains available once the workspace is empty again.
  await create(w);
  assert.equal(w.creations.length,2);assert.equal(w.mounted.length,1);assert.equal(c.sessions.size,0);
});

test('existing and unshared sessions are never replaced, and an offline machine starts nothing when it connects',async()=>{
  const host={id:'windows',name:'Windows'};
  const existing=workspace({...host,sessions:[{name:'work',web_clients_allowed:true}]});
  await existing.context.refresh();await existing.context.refresh();
  assert.deepEqual(existing.mounted.map(frame=>frame.src),['/hosts/windows/work']);
  const unshared=workspace({...host,sessions:[{name:'private',web_clients_allowed:false}]});
  await unshared.context.refresh();assert.equal(unshared.mounted.length,0);
  const offline=workspace({...host,error:'Offline'});
  await offline.context.refresh();assert.equal(offline.mounted.length,0);
  offline.catalog({...host,sessions:[]});await offline.context.refresh();assert.equal(offline.mounted.length,0);
});

test('+ starts a session on a machine whose sessions are all unshared, under a free name',async()=>{
  const host={id:'windows',name:'Windows',sessions:[{name:'adamant-duck',web_clients_allowed:false}]},w=workspace(host),c=w.context;
  await c.refresh();assert.equal(w.mounted.length,0);
  assert.equal(c.firstSessionName(host),'main');
  await create(w);assert.equal(w.creations[0].key,JSON.stringify(['windows','main']));assert.equal(w.mounted.length,0);
  // An unshared main stays the user's; + must not attach to it.
  const privateMain={...host,sessions:[{name:'main',web_clients_allowed:false},{name:'main-2',web_clients_allowed:false}]};
  assert.equal(c.firstSessionName(privateMain),'main-3');
  const taken=workspace(privateMain);await taken.context.refresh();await create(taken);assert.equal(taken.creations.length,0);
  taken.elements.get('new-tab-target').value=JSON.stringify(['windows','main-3']);await create(taken);
  assert.equal(taken.creations[0].key,JSON.stringify(['windows','main-3']));assert.equal(taken.mounted.length,0);
  assert.equal(c.firstSessionName({...host,sessions:[{name:'work',web_clients_allowed:true}]}),null);
  assert.equal(c.firstSessionName({...host,error:'Offline'}),null);
});

test('a failed startup times out without retry loops and can be retried explicitly',async()=>{
  const w=workspace({id:'windows',name:'Windows',sessions:[]});await w.context.refresh();
  w.context.connectSession(w.context.hosts.get('windows'),'main',true);
  w.timeouts[0]();const failed=w.context.sessions.values().next().value;
  assert.match(failed.closeError,/Terminal did not start/);
  await create(w);
  assert.equal(failed.frame.removed,true);assert.equal(w.creations.length,1);assert.equal(w.mounted.length,1);
  await w.context.refresh();assert.equal(w.mounted.length,1);assert.equal(w.creations.length,1);
});
