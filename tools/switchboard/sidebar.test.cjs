const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
test('Copy title uses the menu tab display title, including cached offline titles, without switching tabs',async()=>{
  const pane={pane_id:8,is_plugin:false,tab_position:2,title:'\u2733 caf\u00e9 task'};
  for(const item of [
    {key:'other',entry:{state:{panes:[pane],active_pane:{pane_id:1,tab_position:0}}},tab:{name:'Tab #3',position:2,panes:[pane]}},
    {key:'offline',entry:{state:null},tab:{cachedTitle:'caf\u00e9 task',panes:[]}},
  ]){
    const button={},writes=[],statuses=[];
    const context={contextItem:item,selected:'current',SwitchboardTitles:require('./static/titles.js'),
      $:()=>button,navigator:{clipboard:{writeText:async text=>writes.push(text)}},
      closeTabMenu(restore){assert.equal(restore,true);context.contextItem=null;},
      setStatus:(...args)=>statuses.push(args),activate(){assert.fail('Copying a title must not activate its tab');}};
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function tabPanes('),source.indexOf('function activeTab(')),context);
    vm.runInContext(source.slice(source.indexOf("$('copy-title').onclick="),source.indexOf("$('exit-selection').onclick=")),context);
    await button.onclick();
    assert.deepEqual(writes,['caf\u00e9 task']);assert.deepEqual(statuses,[['Tab title copied.']]);
    assert.equal(context.selected,'current');assert.equal(context.contextItem,null);
  }
});
test('Copy title reports denied or unavailable clipboard access instead of claiming success',async()=>{
  for(const clipboard of [undefined,{writeText:async()=>{throw Error('Write permission denied.');}}]){
    const button={},statuses=[];
    const context={contextItem:{},tabTitle:()=> 'Title',navigator:{clipboard},$:()=>button,closeTabMenu(){},
      setStatus:(...args)=>statuses.push(args)};
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf("$('copy-title').onclick="),source.indexOf("$('exit-selection').onclick=")),context);
    await button.onclick();
    assert.equal(statuses.length,1);assert.equal(statuses[0][1],true);
    assert.match(statuses[0][0],clipboard?/Write permission denied/:/unavailable/);
  }
});
// Exercise stable order and attention acknowledgment without connecting terminals.
test('attention acknowledgment never moves tabs; search, filters, archive and cross-machine reorder preserve order',()=>{
  const hosts=new Map([['mac',{name:'Mac'}],['win',{name:'Windows'}]]);
  function session(host,names){return {host,name:'main',state:{panes:[]},catalog:names.map((name,position)=>({id:position+40,name,position,panes:[]}))};}
  const sessions=new Map([['mac',session('mac',['home-a','home-b'])],['win',session('win',['work-a','work-b','*ready'])]]);
  const search={value:''},stored={},reviews=[];
  const context={fetch:(url,options)=>{reviews.push([url,JSON.parse(options.body)]);return Promise.resolve();},hosts,sessions,groups:{mac:'home',win:'work'},ready:{},archived:{},paneAttention:new Map(),seenAttention:{},filter:'all',tabOrder:[],
    selected:null,saveReady(){},SwitchboardTitles:{tabTitle:(_,tab)=>tab.name},
    $:()=>search,localStorage:{setItem:(key,value)=>stored[key]=value},render(){},tabButtons:new Map()};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
  const keys=()=>Array.from(context.allTabs(),item=>item.entry.host+':'+item.tab.position);
  const key=(host,position)=>context.tabKey(sessions.get(host),sessions.get(host).catalog[position]);
  assert.deepEqual(keys(),['mac:0','mac:1','win:0','win:1','win:2']);
  context.moveTab(key('win',1),key('win',0));
  assert.deepEqual(keys(),['mac:0','mac:1','win:1','win:0','win:2']);
  context.moveTab(key('win',1),key('mac',0));
  assert.deepEqual(keys(),['win:1','mac:0','mac:1','win:0','win:2']);
  context.filter='home';assert.deepEqual(keys(),['mac:0','mac:1']);
  search.value='mac';assert.equal(context.matchesSearch(context.allTabs()[0]),true);
  search.value='work-a';assert.equal(context.matchesSearch(context.allTabs()[0]),false);
  context.archived[key('mac',0)]=123;assert.deepEqual(keys(),['mac:1']);
  assert.equal(context.allTabs(true,true).length,5);
  context.filter='all';context.ready[key('mac',1)]=123;
  assert.deepEqual(keys(),['win:1','mac:1','win:0','win:2']);
  delete context.ready[key('mac',1)];
  const entry=sessions.get('mac');entry.catalog[1].panes=[{pane_id:7,tab_position:1,is_plugin:false}];
  const attentionKey=context.attentionKey('mac','main',7),item=context.allTabs().find(t=>t.key===key('mac',1));
  const pane={host:'mac',session:'main',pane_id:7};
  context.paneAttention.set(attentionKey,{...pane,key:attentionKey,state:'ready',token:'result:1'});
  const before=keys();
  assert.equal(context.isReady(item),true);
  context.acknowledgeAttention(item);assert.equal(context.isReady(item),false);
  context.acknowledgeAttention(item);
  assert.deepEqual(reviews,[['/api/attention/ack',{...pane,token:'result:1'}]],'one review reaches the relay');
  assert.deepEqual(keys(),before);
  // A review from another computer arrives through the relay, not this browser.
  context.paneAttention.set(attentionKey,{...pane,key:attentionKey,state:'ready',token:'result:3',seen:true});assert.equal(context.isReady(item),false);
  context.acknowledgeAttention(item);assert.equal(reviews.length,1);
  context.paneAttention.set(attentionKey,{key:attentionKey,state:'ready',token:'result:2'});assert.equal(context.isReady(item),true);
  context.paneAttention.set(attentionKey,{key:attentionKey,state:'approval'});context.acknowledgeAttention(item);assert.equal(context.isReady(item),true);
  // Hidden in this browser, but the computer running the tab never recorded it.
  context.paneAttention.set(attentionKey,{...pane,key:attentionKey,state:'ready',token:'result:1'});
  assert.equal(context.isReady(item),false);
  vm.runInContext('Date.now=(now=>()=>now+11000)(Date.now())',context);
  context.acknowledgeAttention(item);assert.equal(reviews.length,2,'an unrecorded review is sent again');

});

test('Flag for review targets the menu tab without changing saved order or selection',()=>{
  const button={},stored={};
  const originalOrder=['win:1','mac:0','mac:1'];
  let renders=0;
  const context={selected:'mac:0',contextItem:{key:'mac:1',tab:{id:1}},closeTabMenu(){},ready:{},tabOrder:[...originalOrder],
    $:()=>button,allTabs:()=>originalOrder.map(key=>({key})),
    localStorage:{setItem:(key,value)=>stored[key]=value},
    render(){renders++;},saveReady(){stored['switchboard-ready']=JSON.stringify(context.ready);}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("$('ready').onclick="),source.indexOf("$('settings').onclick=")),context);
  button.onclick();
  assert.ok(context.ready['mac:1']);
  assert.equal(context.selected,'mac:0');
  assert.deepEqual(context.tabOrder,originalOrder);
  assert.equal(stored['switchboard-tab-order'],undefined);
  assert.equal(renders,1);
});

test('reordering while Windows connects preserves saved positions through reload and delayed catalogs',()=>{
  const session=(host,ids)=>({host,name:'main',state:{panes:[]},catalog:ids.map(id=>({id,name:String(id),position:id,panes:[]}))});
  const mac=session('mac',[1,2,3]),windows=session('win',[4,5]),stored={};
  const key=(host,id)=>JSON.stringify([host,'main','tab',id]);
  const initial=[key('mac',1),key('win',4),key('mac',2),key('mac',3),key('win',5)];
  const context={sessions:new Map([['mac',mac]]),tabOrder:[...initial],archived:{},filter:'all',groups:{},ready:{},selected:null,
    localStorage:{setItem:(name,value)=>stored[name]=value},render(){},tabButtons:new Map()};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
  context.moveTab(key('mac',3),key('mac',2));
  const expected=[key('mac',1),key('win',4),key('mac',3),key('mac',2),key('win',5)];
  assert.deepEqual(JSON.parse(stored['switchboard-tab-order']),expected);
  context.tabOrder=JSON.parse(stored['switchboard-tab-order']);
  const keys=()=>Array.from(context.allTabs(),item=>item.key);
  assert.deepEqual(keys(),[key('mac',1),key('mac',3),key('mac',2)]);
  context.sessions.set('win',windows);windows.state=null;
  assert.deepEqual(keys(),expected,'Known tabs remain visible before the terminal connects');
  windows.state={panes:[]};const catalog=windows.catalog;windows.catalog=[];
  assert.deepEqual(keys(),[key('mac',1),key('mac',3),key('mac',2)]);
  context.setCatalog(windows,catalog);
  assert.deepEqual(keys(),expected);
  // Reordering still includes newly discovered tabs without discarding an offline host.
  context.sessions.delete('win');mac.catalog.push({id:6,name:'new',position:6,panes:[]});
  context.moveTab(key('mac',6),key('mac',2),true);
  const withNew=[key('mac',1),key('win',4),key('mac',3),key('mac',2),key('mac',6),key('win',5)];
  assert.deepEqual(JSON.parse(stored['switchboard-tab-order']),withNew);
  context.sessions.set('win',windows);assert.deepEqual(keys(),withNew);
  context.sessions.delete('mac');assert.deepEqual(keys(),[key('win',4),key('win',5)]);
  context.sessions.set('mac',mac);assert.deepEqual(keys(),withNew);
});

test('every browser on every paired computer shares one tab order, including new tabs',async()=>{
  // The Mac calls itself mac; Windows knows it as mesh-d1. Both reach Windows as a mesh peer or locally.
  const view=(hosts,self,local)=>{
    const sessions=new Map(hosts.map(([host,{name}])=>[host,{host,name:'main',state:{panes:[]},catalogPolls:1,catalog:[0,1].map(id=>({id,name:`${name}-${id}`,position:id,panes:[]}))}]));
    const posted=[],stored={'switchboard-tab-order':JSON.stringify(local)};
    const context={hosts:new Map(hosts),sessions,archived:{},ready:{},selected:null,saveReady(){},filter:'all',groups:{},render(){},tabButtons:new Map(),
      localStorage:{getItem:key=>stored[key]??null,setItem:(key,value)=>stored[key]=value},
      fetch:(url,options)=>{posted.push(JSON.parse(options.body).keys);return Promise.resolve({ok:true,json:()=>({updated:posted.length+100})});}};
    vm.createContext(context);context.tabOrder=local;
    vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
    vm.runInContext(`localMember=${JSON.stringify(self)}`,context);
    const names=()=>Array.from(context.allTabs(),item=>item.tab.name);
    return {context,sessions,posted,stored,names};
  };
  const mac={name:'Mac',id:'d1',local:true},win={name:'Windows',id:'24',local:true};
  const onMac=view([['mac',{name:'Mac',local:true}],['mesh-24',{name:'Windows'}]],mac,[JSON.stringify(['mesh-24','main','tab',1]),JSON.stringify(['mac','main','tab',1])]);
  const onWindows=view([['win',{name:'Windows',local:true}],['mesh-d1',{name:'Mac'}]],win,[]);
  // The Mac's order, saved before sharing, moves to the group once with its own tabs keyed by member.
  onMac.context.applyTabOrder({tab_order:null},mac);
  assert.deepEqual(onMac.posted[0].slice(0,2),[JSON.stringify(['mesh-24','main','tab',1]),JSON.stringify(['mesh-d1','main','tab',1])]);
  onWindows.context.applyTabOrder({tab_order:{keys:onMac.posted[0],updated:1}},win);
  assert.deepEqual(onWindows.names(),onMac.names());
  assert.deepEqual(onMac.names(),['Windows-1','Mac-1','Mac-0','Windows-0']);
  // A drag on Windows reaches the Mac; a poll older than a save in flight cannot undo it.
  onWindows.context.moveTab(JSON.stringify(['mesh-d1','main','tab',0]),JSON.stringify(['win','main','tab',1]));
  await new Promise(setImmediate);
  onMac.context.applyTabOrder({tab_order:{keys:onWindows.posted[0],updated:150}},mac);
  assert.deepEqual(onMac.names(),onWindows.names());
  assert.deepEqual(onMac.names(),['Mac-0','Windows-1','Mac-1','Windows-0']);
  onMac.context.moveTab(JSON.stringify(['mac','main','tab',1]),JSON.stringify(['mac','main','tab',0]));
  onMac.context.applyTabOrder({tab_order:{keys:onWindows.posted[0],updated:160}},mac);
  assert.deepEqual(onMac.names(),['Mac-1','Mac-0','Windows-1','Windows-0'],'the stale poll is ignored');
  // A new Windows tab goes last in every browser, wherever its machine sorts.
  const entry=onWindows.sessions.get('win'),catalog=[...entry.catalog,{id:2,name:'Windows-2',position:2,panes:[]}];
  onWindows.context.setCatalog(entry,entry.catalog);onWindows.context.setCatalog(entry,catalog);
  const shared=onWindows.posted.at(-1);
  assert.equal(shared.at(-1),JSON.stringify(['mesh-24','main','tab',2]));
  onMac.sessions.get('mesh-24').catalog.push({id:2,name:'Windows-2',position:2,panes:[]});
  await new Promise(setImmediate);
  onMac.context.applyTabOrder({tab_order:{keys:shared,updated:200}},mac);
  assert.deepEqual(onMac.names(),onWindows.names());
  assert.equal(onMac.names().at(-1),'Windows-2');
  assert.deepEqual(JSON.parse(onMac.stored['switchboard-tab-order']),shared,'this browser keeps a copy');
  // A browser that has not heard the shared order yet holds new tabs back instead of replacing it.
  const later=view([['win',{name:'Windows',local:true}],['mesh-d1',{name:'Mac'}]],win,[]),own=later.sessions.get('win');
  later.context.setCatalog(own,own.catalog);later.context.setCatalog(own,catalog);
  assert.equal(later.posted.length,0);
  later.context.applyTabOrder({tab_order:{keys:shared,updated:300}},win);
  assert.deepEqual(later.names(),onWindows.names());
});

test('every computer in a mesh lists unsorted tabs in the same machine order',()=>{
  // Each computer calls itself by a local ID and lists itself first; catalogs arrive in any order.
  const view=(hosts,arrival,self)=>{
    const sessions=new Map(arrival.map(([host,name])=>[host,{host,name:'main',state:{panes:[]},catalog:[0,1].map(id=>({id,name:`${name}-${id}`,position:id,panes:[]}))}]));
    const context={hosts:new Map(hosts),sessions,tabOrder:[],archived:{},filter:'all',groups:{}};
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
    vm.runInContext(`localMember=${JSON.stringify(self)}`,context);
    return Array.from(context.allTabs(),item=>item.tab.name);
  };
  const mac={name:'Doms-MacBook-Pro',id:'d1'},win={name:'Windows',id:'24'};
  const onMac=view([['mac',{name:'Mac',local:true}],['mesh-24',{name:'Windows'}]],[['mesh-24','Windows'],['mac','Doms-MacBook-Pro']],mac);
  const onWindows=view([['win',{name:'Windows',local:true}],['mesh-d1',{name:'Doms-MacBook-Pro'}]],[['win','Windows'],['mesh-d1','Doms-MacBook-Pro']],win);
  assert.deepEqual(onMac,['Doms-MacBook-Pro-0','Doms-MacBook-Pro-1','Windows-0','Windows-1']);
  assert.deepEqual(onWindows,onMac);
});


test('a new tab goes to the bottom on every computer and stays there after reload',()=>{
  const stored={};
  const view=()=>{
    const context={hosts:new Map([['mac',{name:'Doms-MacBook-Pro'}],['win',{name:'Windows'}]]),sessions:new Map(),tabOrder:[],ready:{},archived:{},selected:null,
      filter:'all',groups:{},saveReady(){},localStorage:{getItem:key=>stored[key]??null,setItem:(key,value)=>stored[key]=value}};
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
    const catalog=(host,ids)=>{
      const entry=context.sessions.get(host)??{host,name:'main',state:{panes:[]}};context.sessions.set(host,entry);
      context.setCatalog(entry,ids.map(id=>({id,name:`${host}-${id}`,position:id,panes:[]})));
    };
    return {catalog,names:()=>Array.from(context.allTabs(),item=>item.tab.name)};
  };
  const first=view();
  first.catalog('win',[0,1]);first.catalog('mac',[0,1]);
  assert.deepEqual(first.names(),['mac-0','mac-1','win-0','win-1'],'first sight keeps the shared machine order');
  first.catalog('mac',[0,1,2]);first.catalog('win',[0,1,3]);
  assert.deepEqual(first.names(),['mac-0','mac-1','win-0','win-1','mac-2','win-3']);
  const reloaded=view();
  reloaded.catalog('win',[0,1,3]);reloaded.catalog('mac',[0,1,2]);
  assert.deepEqual(reloaded.names(),['mac-0','mac-1','win-0','win-1','mac-2','win-3']);
  // A recreated session restarts its IDs; its tabs are not new tabs.
  reloaded.catalog('win',[0]);
  assert.deepEqual(reloaded.names(),['mac-0','mac-1','win-0','mac-2']);
});

test('paired computers share their category; a browser-only category moves to the group once',()=>{
  const posted=[];
  const context={hosts:new Map([['mac',{name:'Mac',local:true}],['mesh-24',{name:'Windows'}],['old',{name:'Old'}]]),
    groups:{mac:'home',old:'work'},fetch:(url,options)=>{posted.push([url,JSON.parse(options.body)]);return Promise.resolve();}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
  vm.runInContext(`meshMembers=[{id:'d1',local:true,category:null},{id:'24',category:'work'}];localMember=meshMembers[0];applyCategories()`,context);
  assert.deepEqual(context.groups,{mac:'home','mesh-24':'work',old:'work'});
  assert.deepEqual(posted,[['/api/mesh/category',{member_id:'d1',name:'home'}]]);
  // Already shared: no second migration, and the group's value wins over this browser's.
  vm.runInContext(`groups.mac='work';applyCategories()`,context);
  assert.equal(context.groups.mac,'home');
  assert.equal(posted.length,1);
  // An unpaired host, or a relay without shared categories, stays in this browser.
  assert.equal(context.memberFor('old'),null);
  vm.runInContext(`meshMembers=[{id:'24'}]`,context);
  assert.equal(context.memberFor('mesh-24'),null);
});

test('each group returns to and shows its own last selected tab, even across computers',()=>{
  const tab=(host,id)=>({id,name:`${host}-${id}`,position:id,panes:[]});
  const sessions=new Map(['w1','w2','h1','h2'].map(host=>[host,{host,name:'main',state:{panes:[]},catalog:[tab(host,0)]}]));
  const focused=[];
  const context={hosts:new Map([...sessions.keys()].map(host=>[host,{name:host}])),sessions,tabOrder:[],archived:{},ready:{},
    filter:'work',groups:{w1:'work',w2:'work',h1:'home',h2:'home'},selected:null,localStorage:{setItem(){}},renderFilter(){},
    focus:item=>focused.push(item.key)};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
  vm.runInContext(source.slice(source.indexOf('function setFilter('),source.indexOf("$('filters').onclick")),context);
  vm.runInContext(source.slice(source.indexOf('// The tab last used in each group'),source.indexOf('function setFilter(')),context);
  // render() re-selects the first visible tab when the selection is filtered out.
  vm.runInContext(`function render(){if(!allTabs().some(t=>t.key===selected))selected=allTabs()[0]?.key??null;}`,context);
  const key=host=>JSON.stringify([host,'main','tab',0]);
  const go=group=>{vm.runInContext(`setFilter('${group}')`,context);return context.selected;};
  context.selected=key('w2');
  assert.equal(go('home'),key('h1'),'nothing remembered yet: first home tab');
  context.selected=key('h2');
  assert.equal(go('work'),key('w2'),'work returns to its second tab');
  assert.equal(go('home'),key('h2'),'home returns to its second tab');
  assert.deepEqual(focused,[key('h1'),key('w2'),key('h2')],'every switch shows the highlighted tab');
  // A remembered tab that has closed falls back to the first visible tab.
  sessions.delete('h2');
  go('work');
  assert.equal(go('home'),key('h1'));
  assert.equal(focused.at(-1),key('h1'));
  // Showing every group keeps a visible selection without refocusing.
  const count=focused.length;
  assert.equal(go('all'),key('h1'));
  assert.equal(focused.length,count);
});

test('native tab identity preserves selection, archive and order through pane removal, floating and reordered positions',()=>{
  const entry={host:'win',name:'main',state:{panes:[]}},stored={};
  const context={ready:{},archived:{},selected:null,tabOrder:[],saveReady(){},localStorage:{setItem:(key,val)=>stored[key]=val},SwitchboardTitles:{tabTitle:(_,tab)=>tab.name}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function attentionKey(')),context);
  const pane=(pane_id,position,is_floating=false)=>({pane_id,is_plugin:false,tab_position:position,is_floating});
  context.setCatalog(entry,[{id:42,position:0,name:'A',panes:[pane(7,0),pane(8,0)]},{id:90,position:1,name:'B',panes:[pane(9,1)]}]);
  const key=context.tabKey(entry,entry.catalog[0]);context.selected=key;context.archived[key]=123;context.tabOrder=[key];
  context.setCatalog(entry,[{id:90,position:0,name:'B',panes:[pane(9,0)]},{id:42,position:1,name:'A',panes:[pane(8,1,true)]}]);
  assert.equal(context.tabKey(entry,entry.catalog[1]),key);assert.equal(context.selected,key);assert.equal(context.archived[key],123);assert.equal(context.tabOrder[0],key);
  // A pane moved to another tab must never be used for focus while the catalog is stale.
  entry.state.panes=[pane(8,0,true)];assert.equal(context.tabPanes(entry,entry.catalog[1]).length,0);
  entry.state.panes=[pane(8,1,true)];assert.equal(context.tabPanes(entry,entry.catalog[1]).length,1);
});

test('existing pane-key preferences migrate once to native tab IDs',()=>{
  const entry={host:'mac',name:'main',state:{panes:[]}},old=JSON.stringify(['mac','main',7,false]);
  const context={ready:{[old]:321},archived:{[old]:123},selected:old,tabOrder:[old],saveReady(){},localStorage:{setItem(){}}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function attentionKey(')),context);
  const tabs=[{id:42,position:0,name:'A',panes:[{pane_id:7,is_plugin:false}]}];context.setCatalog(entry,tabs);
  const key=JSON.stringify(['mac','main','tab',42]);
  assert.equal(context.selected,key);assert.equal(context.ready[key],321);assert.equal(context.archived[key],123);assert.equal(context.archived[old],undefined);assert.equal(context.tabOrder[0],key);
  context.setCatalog(entry,[{...tabs[0],panes:[{pane_id:8,is_plugin:false}]}]);assert.equal(context.archived[key],123);
});

test('Cmd/Ctrl+Alt+T opens the New tab dialog once outside inputs and open dialogs',()=>{
  let handler,clicks=0,modal=false;
  const context={window:{addEventListener:(_,fn)=>handler=fn},document:{querySelector:()=>modal?{}:null},$:()=>({click(){clicks++;}})};
  vm.createContext(context);const start=source.indexOf("window.addEventListener('keydown'");
  vm.runInContext(source.slice(start,source.indexOf('function renderMachines()',start)),context);
  const key=extra=>{const event={code:'KeyT',ctrlKey:true,altKey:true,metaKey:false,shiftKey:false,target:{closest:()=>null},preventDefault(){this.prevented=true;},stopImmediatePropagation(){},...extra};handler(event);return event;};
  assert.equal(key().prevented,true);assert.equal(clicks,1);key({repeat:true});assert.equal(clicks,1);
  for(const extra of [{ctrlKey:false},{altKey:false},{metaKey:true},{shiftKey:true},{isComposing:true},{target:{closest:()=>({})}}])assert.equal(key(extra).prevented,undefined);
  assert.equal(key({ctrlKey:false,metaKey:true}).prevented,true);assert.equal(clicks,2);
  assert.equal(key({code:'KeyN'}).prevented,undefined);
  modal=true;assert.equal(key().prevented,undefined);assert.equal(clicks,2);
});


test('a native new tab arriving before its catalog follows its active pane after the next scan',()=>{
  const pane={pane_id:9,is_plugin:false,tab_position:1};
  const entry={host:'win',name:'main',state:{panes:[pane],active_pane:pane},followActiveTab:true,frame:{classList:{contains:()=>true}}};
  const key=id=>JSON.stringify(['win','main','tab',id]);
  const context={ready:{},archived:{},selected:key(42),tabOrder:[],saveReady(){},localStorage:{setItem(){}}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function attentionKey(')),context);
  context.setCatalog(entry,[{id:42,position:0,name:'A',panes:[]}]);assert.equal(context.selected,key(42));
  const tabs=[{id:42,position:0,name:'A',panes:[]},{id:90,position:1,name:'B',panes:[pane]}];
  context.setCatalog(entry,tabs);assert.equal(context.selected,key(90));assert.equal(entry.followActiveTab,false);
  context.selected=key(42);entry.followActiveTab=true;entry.requestedPane={pane_id:7,is_plugin:false};
  context.setCatalog(entry,tabs);assert.equal(context.selected,key(42));
  entry.requestedPane=null;entry.frame.classList.contains=()=>false;context.selected='other-host';context.setCatalog(entry,tabs);assert.equal(context.selected,'other-host');
});

test('new tab focus and catalog resolve selection in either arrival order without waiting for another scan',()=>{
  for(const order of ['catalog-first','focus-first']){
    const oldPane={pane_id:7,is_plugin:false,tab_position:0},newPane={pane_id:9,is_plugin:false,tab_position:1};
    const oldTab={id:42,position:0,name:'A',panes:[oldPane]},newTab={id:90,position:1,name:'B',panes:[newPane]};
    const entry={host:'win',name:'main',state:{session_name:'main',panes:[oldPane],active_pane:oldPane},catalog:[oldTab],
      frame:{classList:{contains:()=>true},contentWindow:{postMessage(){}}},followActiveTab:true};
    const key=id=>JSON.stringify(['win','main','tab',id]);
    entry.pendingNewTab=new Set([key(42)]);
    const search={value:'old search'};let handler,scans=0,highlight,focused;
    const context={sessions:new Map([[JSON.stringify(['win','main']),entry]]),ready:{},archived:{},selected:key(42),tabOrder:[],
      filter:'work',groups:{win:'home'},nativeTabs:false,saveReady(){},localStorage:{setItem(){}},$:()=>search,location:{origin:'http://localhost'},
      window:{addEventListener:(_,fn)=>handler=fn},setFilter(value){context.filter=value;},
      allTabs:()=>entry.catalog.map(tab=>({entry,tab,key:key(tab.id)})),acknowledgeAttention(){},
      render(){highlight=context.selected;},focus(item){focused=item.key;entry.needsFocus=false;},
      refreshAttention(){scans++;}};
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function sessionKey('),source.indexOf('function attentionKey(')),context);
    const start=source.indexOf("window.addEventListener('message'");
    vm.runInContext(source.slice(start,source.indexOf("}else if(event.data?.type==='zellij-focus-failed')",start))+'}});',context);
    const state=()=>handler({origin:'http://localhost',source:entry.frame.contentWindow,data:{type:'zellij-state',payload:{session_name:'main',panes:[oldPane,newPane],active_pane:newPane},focus_pending:false}});
    if(order==='catalog-first'){
      context.setCatalog(entry,[oldTab,newTab]);
      assert.equal(context.selected,key(42));assert.ok(entry.pendingNewTab);
      state();assert.equal(scans,0);
    }else{
      state();assert.equal(scans,1,'Native focus requests an immediate catalog scan');
      assert.equal(highlight,key(42));assert.ok(entry.pendingNewTab);
      context.setCatalog(entry,[oldTab,newTab]);context.render();
      context.focus(context.allTabs().find(item=>item.key===context.selected));
    }
    assert.equal(entry.pendingNewTab,null,order);
    assert.equal(entry.followActiveTab,false,order);
    assert.equal(highlight,key(90),order);assert.equal(focused,key(90),order);
    assert.equal(context.filter,'all');assert.equal(search.value,'');
    // Repeated metadata does not start additional creation scans.
    state();assert.equal(scans,order==='focus-first'?1:0);
  }
});

test('new tab requests one immediate catalog refresh after an in-flight scan',async()=>{
  let release,requests=0;
  const response=new Promise(resolve=>release=resolve);
  const context={attentionLoading:false,attentionRefreshPending:false,tabCatalog:[],catalogUnavailable:()=>false,sessions:new Map(),allTabs:()=>[],render(){},
    selected:null,attentionKey(){},updateCreatedTabs(){},setInterval(){},
    fetch:async()=>{requests++;if(requests===1)await response;return {ok:true,json:async()=>({tabs:[],panes:[]})};}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function refreshAttention('),source.indexOf('refreshAttention();setInterval')),context);
  const first=context.refreshAttention();
  await context.refreshAttention();assert.equal(context.attentionRefreshPending,false);
  await context.refreshAttention(true);await context.refreshAttention(true);
  assert.equal(context.attentionRefreshPending,true);assert.equal(requests,1);
  release();await first;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests,2);assert.equal(context.attentionLoading,false);assert.equal(context.attentionRefreshPending,false);
});


test('New tab cannot snapshot an unscanned or empty catalog',()=>{
  const elements=new Map(),$=id=>elements.get(id);
  const entry={host:'mac',name:'main',state:{tabs:[{position:0}]},catalog:[]};let sent=0;
  entry.frame={contentWindow:{postMessage(){sent++;}}};
  elements.set('new-tab-form',{});elements.set('new-tab-target',{value:'main'});
  elements.set('new-tab-dialog',{close(){}});
  const context={$,sessions:new Map([['main',entry]]),sessionTabs:entry=>[...(entry.catalog||[]),...(entry.provisionalTabs||[])],location:{origin:'https://switchboard.localhost'},hosts:new Map([['mac',{name:'Mac'}]]),setStatus(){},setTimeout(){}};
  vm.createContext(context);const start=source.indexOf("$('new-tab-form').onsubmit=");
  vm.runInContext(source.slice(start,source.indexOf("$('ready').onclick=",start)),context);
  elements.get('new-tab-form').onsubmit({preventDefault(){}});assert.equal(sent,0);assert.equal(entry.pendingNewTab,undefined);
  entry.catalog=null;elements.get('new-tab-form').onsubmit({preventDefault(){}});assert.equal(sent,0);
});


test('early catalog data is applied immediately and one delayed host does not block other terminals',async()=>{
  let releaseSlow;const delayed=new Promise(resolve=>releaseSlow=resolve),mounted=[];
  const catalog=[{host:'mac',session:'main',id:42,position:0,name:'A',panes:[]}];
  const context={loading:false,hosts:new Map(),startedHosts:new Set(),sessions:new Map(),tabCatalog:catalog,ready:{},archived:{},tabOrder:[],selected:null,catalogUnavailable:()=>false,saveReady(){},localStorage:{setItem(){}},clearTimeout(){},
    document:{createElement:()=>({remove(){}})},$:()=>({append:frame=>mounted.push(frame)}),renderMachines(){},render(){},setStatus(){},
    fetch:async url=>{if(url==='/api/hosts?summary=1')return {ok:true,json:async()=>[{id:'mac',name:'Mac'},{id:'slow',name:'Slow'}]};
      if(url==='/api/hosts/slow')return delayed;
      return {ok:true,json:async()=>({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]})};}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function sessionKey('),source.indexOf('function attentionKey(')),context);
  vm.runInContext(source.slice(source.indexOf('function connectSession('),source.indexOf("window.addEventListener('message'")),context);
  const refresh=context.refresh();await new Promise(resolve=>setImmediate(resolve));
  const entry=context.sessions.get(JSON.stringify(['mac','main']));assert.equal(entry.catalog[0].id,42);assert.equal(mounted.length,1);assert.equal(context.loading,true);
  releaseSlow({ok:true,json:async()=>({id:'slow',name:'Slow',error:'Offline'})});await refresh;assert.equal(context.loading,false);
});


test('a host the relay stops listing leaves the sidebar without a reload',async()=>{
  let summary=[{id:'windows',name:'Windows'},{id:'mesh-twin',name:'Windows'}];const removed=[];
  const context={loading:false,hosts:new Map(),startedHosts:new Set(),sessions:new Map(),tabCatalog:[],ready:{},archived:{},tabOrder:[],selected:null,catalogUnavailable:()=>false,saveReady(){},localStorage:{setItem(){}},clearTimeout(){},setTimeout(){},
    document:{createElement:()=>({remove(){removed.push(this.src);}})},$:()=>({append(){}}),renderMachines(){},render(){},setStatus(){},
    fetch:async url=>url==='/api/hosts?summary=1'?{ok:true,json:async()=>summary}
      :{ok:true,json:async()=>({id:decodeURIComponent(url.split('/').pop()),name:'Windows',sessions:[{name:'main',web_clients_allowed:true}]})}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function sessionKey('),source.indexOf('function attentionKey(')),context);
  vm.runInContext(source.slice(source.indexOf('function connectSession('),source.indexOf("window.addEventListener('message'")),context);
  await context.refresh();
  assert.deepEqual([...context.hosts.keys()],['windows','mesh-twin']);assert.equal(context.sessions.size,2);
  summary=[{id:'windows',name:'Windows'}];await context.refresh();
  assert.deepEqual([...context.hosts.keys()],['windows']);
  assert.deepEqual([...context.sessions.values()].map(entry=>entry.host),['windows']);
  assert.deepEqual(removed,['/hosts/mesh-twin/main']);
});

test('terminal URLs round-trip names and wait for the requested machine and tab',()=>{
  const location={href:'https://switchboard.localhost/?host=windows&session=work+%3F%23&tab=42',search:'?host=windows&session=work+%3F%23&tab=42'};
  const saved=[];const context={location,URL,URLSearchParams,history:{replaceState:(_,title,url)=>saved.push(String(url))},hosts:new Map(),sessions:new Map(),attentionErrors:[],loading:true,restoringTab:true,hostsLoaded:false};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function requestedTab('),source.indexOf('function tabKey(')),context);
  context.selected=context.requestedTab();assert.equal(context.selected,JSON.stringify(['windows','work ?#','tab',42]));assert.equal(context.waitingForRequestedTab(),true);
  context.hosts.set('mac',{name:'Mac'});context.hosts.set('windows',{name:'Windows',connecting:true});assert.equal(context.waitingForRequestedTab(),true);
  context.updateTabUrl(null);assert.deepEqual(saved,[]);
  const entry={host:'windows',name:'work ?#',state:null,catalog:[],catalogPolls:0};context.sessions.set(JSON.stringify(['windows','work ?#']),entry);context.hosts.set('windows',{name:'Windows'});context.loading=false;
  assert.equal(context.waitingForRequestedTab(),true);entry.state={panes:[]};assert.equal(context.waitingForRequestedTab(),true);
  entry.catalog=[{id:90}];assert.equal(context.waitingForRequestedTab(),true,'A catalog seeded before the first scan is not proof the tab closed');
  entry.catalogPolls=1;assert.equal(context.waitingForRequestedTab(),false);
  entry.catalog=[{id:42}];assert.equal(context.waitingForRequestedTab(),false);
  context.updateTabUrl({entry,tab:{id:42}});assert.deepEqual(saved,[]);
  context.updateTabUrl({entry,tab:{id:90}});assert.equal(new URL(saved[0]).searchParams.get('tab'),'90');assert.equal(new URL(saved[0]).searchParams.get('session'),'work ?#');
  context.hosts.set('windows',{error:'Offline'});assert.equal(context.waitingForRequestedTab(),true);
  context.hosts.set('windows',{sessions:[]});assert.equal(context.waitingForRequestedTab(),false);
  context.hosts.delete('windows');context.hostsLoaded=false;context.loading=true;
  assert.equal(context.waitingForRequestedTab(),true);
  context.hostsLoaded=true;assert.equal(context.waitingForRequestedTab(),true,'A refresh in flight may still list the machine');
  context.loading=false;assert.equal(context.waitingForRequestedTab(),false,'Completed discovery without the machine abandons an unknown host');
  location.search='?host=windows&session=main&tab=-1';assert.equal(context.requestedTab(),null);
  location.search='?host=windows&session=main&tab=4294967296';assert.equal(context.requestedTab(),null);
});

test('failed switch clears pending state and restores the actual active tab, ignoring stale failures',()=>{
  const tab={id:42,position:0},pane={pane_id:7,is_plugin:false,tab_position:0};
  const entry={requestedPane:{focus_id:9},focusPending:true,state:{active_pane:pane},frame:{contentWindow:{},classList:{contains:()=>true}}};
  let handler,status,focused;
  const context={sessions:new Map([['main',entry]]),location:{origin:'http://localhost'},window:{addEventListener:(_,fn)=>handler=fn},
    selected:'requested',activeTab:()=>tab,tabKey:()=> 'actual',render(){},focus:item=>focused=item,setStatus:message=>status=message};
  vm.createContext(context);
  const start=source.indexOf("window.addEventListener('message'");
  const branch=source.indexOf("}else if(event.data?.type==='zellij-focus-failed')",start);
  const end=source.indexOf("}else if(event.data?.type==='zellij-open-new-tab')",branch);
  const preamble=source.slice(start,source.indexOf("  if(event.data?.type==='zellij-state')",start));
  vm.runInContext(preamble+'  if(false){'+source.slice(branch,end)+'}});',context);
  const fail=id=>handler({origin:'http://localhost',source:entry.frame.contentWindow,data:{type:'zellij-focus-failed',focus_id:id,payload:entry.state,message:'Terminal switch timed out.'}});
  fail(8);assert.equal(entry.focusPending,true);assert.equal(context.selected,'requested');
  fail(9);assert.equal(entry.focusPending,false);assert.equal(entry.requestedPane,null);
  assert.equal(context.selected,'actual');assert.equal(focused.tab,tab);assert.match(status,/timed out/);
});

test('a clicked tab waiting for metadata retries from its button without stealing focus from other controls',()=>{
  const pane={pane_id:9,is_plugin:false,tab_position:2},active={pane_id:7,is_plugin:false,tab_position:0};
  const tab={id:90,position:1,name:'B',panes:[{...pane,tab_position:1}]},button={},messages=[];
  const entry={host:'mac',name:'main',state:{panes:[active,pane],active_pane:active},focusInitialized:true,
    frame:{contentWindow:{postMessage:message=>messages.push(message)}}};
  const item={entry,tab,key:JSON.stringify(['mac','main','tab',90])};
  const preview={hidden:true},artifact={},body={};let scans=0;
  const context={document:{activeElement:button,body,hidden:false,hasFocus:()=>true,querySelector:()=>null},
    $:id=>id==='artifact-preview'?preview:artifact,tabButtons:new Map([[item.key,button]]),location:{origin:'http://localhost'},
    setStatus(){},refreshAttention:()=>scans++};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function tabTitle(')),context);
  vm.runInContext(source.slice(source.indexOf('function focus('),source.indexOf('function activate(')),context);
  context.focus(item);assert.equal(messages.length,0);assert.equal(entry.needsFocus,true);
  context.focus(item,true);assert.equal(messages.length,0);
  tab.position=2;tab.panes=[pane];context.focus(item,true);
  assert.equal(messages.length,1,'Metadata arrival completes the original sidebar click');
  assert.equal(scans,1,'Missing metadata requests one catalog scan, without a retry loop');
  assert.equal(messages[0].pane_id,9);assert.equal(messages[0].preserve_focus,false);
  assert.equal(entry.needsFocus,false);
  for(const control of [{tagName:'INPUT'},{tagName:'BUTTON'},{}]){
    context.document.activeElement=control;context.focus(item,true);
    assert.equal(messages.length,1,'Other focused controls keep their focus');
  }
  context.document.activeElement=button;
  context.document.hidden=true;context.focus(item,true);assert.equal(messages.length,1);
  context.document.hidden=false;context.document.querySelector=()=>({});context.focus(item,true);assert.equal(messages.length,1);
});

test('a late native catalog cannot replace a selected tab waiting for focus',()=>{
  const pane={pane_id:7,is_plugin:false,tab_position:0};
  const entry={host:'mac',name:'main',state:{panes:[pane],active_pane:pane},needsFocus:true,followActiveTab:true,
    frame:{classList:{contains:()=>true}}};
  const key=id=>JSON.stringify(['mac','main','tab',id]);
  const context={ready:{},archived:{},selected:key(90),tabOrder:[],saveReady(){},localStorage:{setItem(){}}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function attentionKey(')),context);
  context.setCatalog(entry,[{id:42,position:0,panes:[pane]},{id:90,position:1,panes:[]}]);
  assert.equal(context.selected,key(90));assert.equal(entry.followActiveTab,true);
  entry.needsFocus=false;context.syncActiveTab(entry);
  assert.equal(context.selected,key(42));assert.equal(entry.followActiveTab,false);
});
