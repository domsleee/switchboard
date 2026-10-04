const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');

function workspace(initial){
  let catalog=initial;
  const mounted=[],timeouts=[],elements=new Map();
  const context={loading:false,hosts:new Map(),startedHosts:new Set(),sessions:new Map(),tabCatalog:[],ready:{},archived:{},tabOrder:[],selected:null,filter:'all',
    catalogUnavailable:()=>false,saveReady(){},localStorage:{setItem(){}},renderMachines(){},render(){},setStatus(){},clearTimeout(){},setTimeout:fn=>timeouts.push(fn),
    document:{createElement:()=>({remove(){this.removed=true;}})},$:id=>elements.get(id),
    fetch:async url=>({ok:true,json:async()=>url==='/api/hosts?summary=1'?[{id:'windows',name:'Windows'}]:catalog})};
  elements.set('terminals',{append:frame=>mounted.push(frame)});
  elements.set('new-tab-form',{});elements.set('new-tab-target',{value:JSON.stringify(['windows','main'])});elements.set('new-tab-dialog',{close(){}});elements.set('tab-search',{value:''});
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function sessionKey('),source.indexOf('function attentionKey(')),context);
  vm.runInContext(source.slice(source.indexOf('function connectSession('),source.indexOf("window.addEventListener('message'")),context);
  const submit=source.indexOf("$('new-tab-form').onsubmit=");
  vm.runInContext(source.slice(submit,source.indexOf("$('ready').onclick=",submit)),context);
  return {context,mounted,timeouts,elements,catalog:value=>catalog=value};
}

test('an empty machine starts one shell automatically, survives delayed catalogs, and stays closed after its last tab exits',async()=>{
  const host={id:'windows',name:'Windows',sessions:[]},w=workspace(host),c=w.context;
  await c.refresh();
  assert.equal(w.mounted.length,1);assert.equal(w.mounted[0].src,'/hosts/windows/main');
  const entry=c.sessions.get(JSON.stringify(['windows','main']));assert.equal(entry.starting,true);
  await c.refresh();assert.equal(c.sessions.size,1);assert.equal(w.mounted.length,1);
  const pane={pane_id:7,is_plugin:false,tab_position:0};
  entry.state={session_name:'main',active_pane:pane,panes:[pane],tabs:[{position:0,name:'Shell'}]};
  c.updateCreatedTabs(entry);
  assert.equal(entry.starting,false);assert.equal(c.sessionTabs(entry).length,1);assert.equal(c.activeTab(entry).name,'Shell');
  w.catalog({...host,sessions:[{name:'main',web_clients_allowed:true}]});await c.refresh();assert.equal(w.mounted.length,1);
  w.catalog(host);await c.refresh();assert.equal(c.sessions.size,0);assert.equal(entry.frame.removed,true);
  await c.refresh();assert.equal(w.mounted.length,1);
  // Explicit New tab remains available once the workspace is empty again.
  w.elements.get('new-tab-form').onsubmit({preventDefault(){}});
  assert.equal(w.mounted.length,2);assert.equal(c.sessions.size,1);assert.equal(c.sessions.values().next().value.selectOnStart,true);
});

test('existing and unshared sessions are never replaced, while an offline machine starts after it first connects',async()=>{
  const host={id:'windows',name:'Windows'};
  const existing=workspace({...host,sessions:[{name:'work',web_clients_allowed:true}]});
  await existing.context.refresh();await existing.context.refresh();
  assert.deepEqual(existing.mounted.map(frame=>frame.src),['/hosts/windows/work']);
  const unshared=workspace({...host,sessions:[{name:'private',web_clients_allowed:false}]});
  await unshared.context.refresh();assert.equal(unshared.mounted.length,0);
  const offline=workspace({...host,error:'Offline'});
  await offline.context.refresh();assert.equal(offline.mounted.length,0);
  offline.catalog({...host,sessions:[]});await offline.context.refresh();assert.equal(offline.mounted.length,1);
});

test('a failed startup times out without retry loops and can be retried explicitly',async()=>{
  const w=workspace({id:'windows',name:'Windows',sessions:[]});await w.context.refresh();
  w.timeouts[0]();const failed=w.context.sessions.values().next().value;
  assert.match(failed.closeError,/Terminal did not start/);
  w.elements.get('new-tab-form').onsubmit({preventDefault(){}});
  assert.equal(failed.frame.removed,true);assert.equal(w.mounted.length,2);
  await w.context.refresh();assert.equal(w.mounted.length,2);
});
