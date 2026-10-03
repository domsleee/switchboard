const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
// Exercise stable order and attention acknowledgment without connecting terminals.
test('attention acknowledgment never moves tabs; search, filters, archive and cross-machine reorder preserve order',()=>{
  const hosts=new Map([['mac',{name:'Mac'}],['win',{name:'Windows'}]]);
  function session(host,names){return {host,name:'main',state:{tabs:names.map((name,position)=>({name,position})),panes:[]}};}
  const sessions=new Map([['mac',session('mac',['home-a','home-b'])],['win',session('win',['work-a','work-b','*ready'])]]);
  const search={value:''},stored={};
  const context={hosts,sessions,groups:{mac:'home',win:'work'},ready:{},archived:{},paneAttention:new Map(),seenAttention:{},filter:'all',tabOrder:[],
    tabKey:(entry,tab)=>entry.host+':'+tab.position,SwitchboardTitles:{tabTitle:(_,tab)=>tab.name},
    $:()=>search,localStorage:{setItem:(key,value)=>stored[key]=value},render(){},tabButtons:new Map()};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function attentionKey('),source.indexOf('function moveSelected(')),context);
  const keys=()=>Array.from(context.allTabs(),item=>item.key);
  assert.deepEqual(keys(),['mac:0','mac:1','win:0','win:1','win:2']);
  context.moveTab('win:1','win:0');
  assert.deepEqual(keys(),['mac:0','mac:1','win:1','win:0','win:2']);
  context.moveTab('win:1','mac:0');
  assert.deepEqual(keys(),['win:1','mac:0','mac:1','win:0','win:2']);
  context.filter='home';assert.deepEqual(keys(),['mac:0','mac:1']);
  search.value='mac';assert.equal(context.matchesSearch(context.allTabs()[0]),true);
  search.value='work-a';assert.equal(context.matchesSearch(context.allTabs()[0]),false);
  context.archived['mac:0']=123;assert.deepEqual(keys(),['mac:1']);
  assert.equal(context.allTabs(true,true).length,5);
  context.filter='all';context.ready['mac:1']=123;
  assert.deepEqual(keys(),['win:1','mac:1','win:0','win:2']);
  delete context.ready['mac:1'];
  const entry=sessions.get('mac');entry.state.panes=[{pane_id:7,tab_position:1,is_plugin:false}];
  const key=context.attentionKey('mac','main',7),item=context.allTabs().find(t=>t.key==='mac:1');
  context.paneAttention.set(key,{key,state:'ready',token:'result:1'});
  const before=keys();
  assert.equal(context.isReady(item),true);
  context.acknowledgeAttention(item);assert.equal(context.isReady(item),false);
  assert.deepEqual(keys(),before);
  context.paneAttention.set(key,{key,state:'ready',token:'result:2'});assert.equal(context.isReady(item),true);
  context.paneAttention.set(key,{key,state:'approval'});context.acknowledgeAttention(item);assert.equal(context.isReady(item),true);

});
