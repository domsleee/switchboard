const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('Close (menu or Ctrl+D) closes the clicked tab immediately and restores it on failure',async()=>{
  const elements=new Map(),calls=[];
  const $=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,hidden:false,open:false});
    return elements.get(id);
  };
  const entry={host:'win',name:'main',state:{panes:[{tab_position:2,pane_id:17,is_plugin:false}]}};
  const item={entry,tab:{id:42,position:2,name:'Clicked tab'},key:'clicked'};
  const context={$,contextItem:item,hosts:new Map([['win',{name:'Windows'}]]),statuses:[],
    tabTitle:item=>item.tab.name,closeTabMenu(){context.contextItem=null;},
    setStatus(message){context.statuses.push(message);},ready:{clicked:1},archived:{clicked:1},saveReady(){},localStorage:{setItem(){}},render(){},activate(next){context.selected=next.key;},
    fetch:async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return {ok:true};}};
  context.selected='clicked';context.allTabs=()=>[item];
  context.document={querySelector:()=>null};
  $('artifact-preview').hidden=true;
  let clicked;$('close-tab').click=()=>{clicked=$('close-tab').onclick();};
  context.AbortSignal=AbortSignal;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(__dirname+'/static/close.js','utf8'),context);
  const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
  const start=source.indexOf('function closeSelectedTab(){');
  vm.runInContext(source.slice(start,source.indexOf("window.addEventListener('keydown'",start)),context);
  entry.focusPending=true;entry.followActiveTab=true;entry.requestedPane={pane_id:99,is_plugin:false};
  context.closeSelectedTab();await clicked;
  assert.deepEqual(calls[0],['/api/hosts/win/close-tab',{session:'main',tab_id:42}],'no confirmation step');
  assert.equal(context.ready.clicked,undefined);assert.equal(context.archived.clicked,undefined);
  context.contextItem=item;
  context.fetch=async()=>({ok:false,text:async()=>'That tab is no longer available'});
  await $('close-tab').onclick();
  assert.match(context.statuses.at(-1),/no longer available/);
  assert.equal(entry.closingTabs.has(42),false);
});

test('close removes the selected tab before the request finishes, keeps stale catalogs hidden, and rolls back errors',async()=>{
  const elements=new Map(),$=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,open:false});
    return elements.get(id);
  };
  const entry={host:'win',name:'main',state:{panes:[]},catalog:[{id:42,name:'A',panes:[]},{id:90,name:'B',panes:[]}]};
  let finish,requests=0;
  const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
  const context={$,sessions:new Map([['main',entry]]),hosts:new Map(),SwitchboardTitles:{tabTitle:(_,tab)=>tab.name},selected:null,tabOrder:[],filter:'all',groups:{},archived:{},ready:{},
    saveReady(){},localStorage:{setItem(){}},tabTitle:item=>item.tab.name,closeTabMenu(){context.contextItem=null;},render(){},
    activate(item){context.selected=item.key;},setStatus(message){context.status=message;},
    fetch:()=>{requests++;return new Promise(resolve=>finish=resolve);}};
  context.AbortSignal=AbortSignal;
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
  vm.runInContext(fs.readFileSync(__dirname+'/static/close.js','utf8'),context);
  const original=entry.catalog.slice();context.selected=context.tabKey(entry,original[0]);context.contextItem=context.allTabs()[0];
  const pending=$('close-tab').onclick();
  assert.equal(requests,1);assert.equal(context.allTabs().length,1);
  assert.equal(context.selected,context.tabKey(entry,original[1]));
  context.setCatalog(entry,[]);context.setCatalog(entry,original);
  assert.equal(context.allTabs().length,1,'in-flight snapshots cannot undo a confirmed close');
  finish({ok:false,text:async()=>'Unavailable'});await pending;
  assert.equal(context.allTabs().length,2);assert.equal(context.selected,context.tabKey(entry,original[1]),'late failure must not select or focus the restored tab');assert.match(context.status,/Unavailable/);
  context.contextItem=context.allTabs()[0];const success=$('close-tab').onclick();
  finish({ok:true});await success;
  context.setCatalog(entry,original);assert.equal(context.allTabs().length,1,'stale snapshots after acknowledgment stay hidden');
  context.setCatalog(entry,original.slice(1));assert.equal(entry.closingTabs.size,0,'fresh snapshots clear the close marker');
});
