const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('Close confirms the clicked tab, preserves its target, and restores it on failure',async()=>{
  const elements=new Map(),calls=[];
  const $=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,open:false,
      focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;this.onclose?.();},
      addEventListener(type,handler){this['on'+type]=handler;}});
    return elements.get(id);
  };
  const entry={host:'win',name:'main',state:{panes:[{tab_position:2,pane_id:17,is_plugin:false}]}};
  const item={entry,tab:{id:42,position:2,name:'Clicked tab'},key:'clicked'};
  const context={$,contextItem:item,hosts:new Map([['win',{name:'Windows'}]]),statuses:[],
    tabTitle:item=>item.tab.name,closeTabMenu(){context.contextItem=null;},
    setStatus(message){context.statuses.push(message);},ready:{clicked:1},archived:{clicked:1},saveReady(){},localStorage:{setItem(){}},render(){},activate(next){context.selected=next.key;},
    fetch:async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return {ok:true};}};
  context.selected='clicked';context.allTabs=()=>[item];
  context.document={querySelector:()=>$('close-tab-dialog').open?{}:null};
  $('artifact-preview').hidden=true;
  $('close-tab').click=()=>$('close-tab').onclick();
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(__dirname+'/static/close.js','utf8'),context);
  const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
  const start=source.indexOf('function closeSelectedTab(){');
  vm.runInContext(source.slice(start,source.indexOf("window.addEventListener('keydown'",start)),context);
  entry.focusPending=true;context.closeSelectedTab();assert.equal($('close-tab-dialog').open,false);
  entry.focusPending=false;entry.followActiveTab=true;context.closeSelectedTab();assert.equal($('close-tab-dialog').open,false);
  entry.followActiveTab=false;context.closeSelectedTab();
  assert.equal($('close-tab-dialog').open,true);assert.equal(calls.length,0);
  assert.equal($('confirm-close-tab').focused,true);
  assert.equal($('close-tab-name').textContent,'Clicked tab · Windows');
  $('cancel-close-tab').onclick();await $('confirm-close-tab').onclick();assert.equal(calls.length,0);
  context.contextItem=item;$('close-tab').onclick();entry.name='elsewhere';entry.state.panes=[];item.tab.id=90;
  await $('confirm-close-tab').onclick();
  assert.deepEqual(calls[0],['/api/hosts/win/close-tab',{session:'main',tab_id:42}]);
  assert.equal($('close-tab-dialog').open,false);assert.equal(context.ready.clicked,undefined);
  entry.name='main';entry.state.panes=[{tab_position:2,pane_id:17,is_plugin:false}];
  context.contextItem=item;$('close-tab').onclick();
  context.fetch=async()=>({ok:false,text:async()=>'That tab is no longer available'});
  await $('confirm-close-tab').onclick();
  assert.equal($('close-tab-dialog').open,false);assert.match(context.statuses.at(-1),/no longer available/);
  assert.equal(entry.closingTabs.has(90),false);
});

test('confirmation removes the selected tab before the request finishes, keeps stale catalogs hidden, and rolls back errors',async()=>{
  const elements=new Map(),$=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,open:false,focus(){},showModal(){this.open=true;},close(){this.open=false;this.onclose?.();},addEventListener(type,handler){this['on'+type]=handler;}});
    return elements.get(id);
  };
  const entry={host:'win',name:'main',state:{panes:[]},catalog:[{id:42,name:'A',panes:[]},{id:90,name:'B',panes:[]}]};
  let finish,requests=0;
  const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
  const context={$,sessions:new Map([['main',entry]]),hosts:new Map(),SwitchboardTitles:{tabTitle:(_,tab)=>tab.name},selected:null,tabOrder:[],filter:'all',groups:{},archived:{},ready:{},
    saveReady(){},localStorage:{setItem(){}},tabTitle:item=>item.tab.name,closeTabMenu(){context.contextItem=null;},render(){},
    activate(item){context.selected=item.key;},setStatus(message){context.status=message;},
    fetch:()=>{requests++;return new Promise(resolve=>finish=resolve);}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
  vm.runInContext(fs.readFileSync(__dirname+'/static/close.js','utf8'),context);
  const original=entry.catalog.slice();context.selected=context.tabKey(entry,original[0]);context.contextItem=context.allTabs()[0];
  $('close-tab').onclick();assert.equal(context.allTabs().length,2);assert.equal(requests,0);
  const pending=$('confirm-close-tab').onclick();
  assert.equal($('close-tab-dialog').open,false);assert.equal(context.allTabs().length,1);
  assert.equal(context.selected,context.tabKey(entry,original[1]));
  context.setCatalog(entry,[]);context.setCatalog(entry,original);
  assert.equal(context.allTabs().length,1,'in-flight snapshots cannot undo a confirmed close');
  finish({ok:false,text:async()=>'Unavailable'});await pending;
  assert.equal(context.allTabs().length,2);assert.equal(context.selected,context.tabKey(entry,original[0]));assert.match(context.status,/Unavailable/);
  context.contextItem=context.allTabs()[0];$('close-tab').onclick();const success=$('confirm-close-tab').onclick();
  finish({ok:true});await success;
  context.setCatalog(entry,original);assert.equal(context.allTabs().length,1,'stale snapshots after acknowledgment stay hidden');
  context.setCatalog(entry,original.slice(1));assert.equal(entry.closingTabs.size,0,'fresh snapshots clear the close marker');
});
