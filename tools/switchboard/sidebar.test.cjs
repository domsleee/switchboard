const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8').replace(/\r\n/g,'\n');
function initPins(context){
  context.pinned={};
  context.parkedTabs={};context.saveParkedTabs=()=>{};
  vm.runInContext(source.slice(source.indexOf('function isPinned('),source.indexOf('// Tabs in the Hidden')),context);
}
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
test('attention acknowledgment never moves tabs; search, filters, hiding and cross-machine reorder preserve order',()=>{
  const hosts=new Map([['mac',{name:'Mac'}],['win',{name:'Windows'}]]);
  function session(host,names){return {host,name:'main',state:{panes:[]},catalog:names.map((name,position)=>({id:position+40,name,position,panes:[]}))};}
  const sessions=new Map([['mac',session('mac',['home-a','home-b'])],['win',session('win',['work-a','work-b','*ready'])]]);
  const search={value:''},stored={},reviews=[];
  const context={fetch:(url,options)=>{reviews.push([url,JSON.parse(options.body)]);return Promise.resolve();},hosts,sessions,groups:{mac:'home',win:'work'},ready:{},hidden:{},paneAttention:new Map(),seenAttention:{},filter:'all',tabOrder:[],
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
  // A hidden tab keeps its filter and goes after the others.
  context.hidden[key('mac',0)]=1;assert.deepEqual(keys(),['mac:1','mac:0']);
  assert.deepEqual(Array.from(context.allTabs(),item=>item.hidden),[false,true]);
  assert.equal(context.allTabs(true).length,5);
  context.filter='all';context.ready[key('mac',1)]=123;
  assert.deepEqual(keys(),['win:1','mac:1','win:0','win:2','mac:0']);
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

test('conversation review only acknowledges the visible selected chat pane',()=>{
  const reviews=[],item={key:'selected',entry:{host:'mac',name:'main'},tab:{panes:[{pane_id:7,is_plugin:false},{pane_id:8,is_plugin:false}]}},view={host:'mac',session:'main',pane:7,chatId:'chat-seven'};
  let focused=true,open=true,dialog=false,artifact=false,renders=0;
  const context={selected:item.key,allTabs:()=>[item],SwitchboardConversation:{isOpen:()=>open},
    document:{hidden:false,hasFocus:()=>focused,querySelector:()=>dialog?{}:null},$:()=>({hidden:!artifact}),
    paneAttention:new Map([['mac/main/7',{chat_id:'chat-seven'}]]),attentionKey:(host,session,pane)=>`${host}/${session}/${pane}`,
    acknowledgeAttention:(target,pane)=>{reviews.push([target.key,pane]);return true;},render:()=>renders++};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function acknowledgeConversation('),source.indexOf('function isReady(')),context);
  context.acknowledgeConversation(view);
  assert.deepEqual(reviews,[['selected',7]]);assert.equal(renders,1);
  for(const change of [{host:'other'},{session:'other'},{pane:9},{chatId:'replaced'},{chatId:null}])context.acknowledgeConversation({...view,...change});
  context.selected='other';context.acknowledgeConversation(view);context.selected=item.key;
  context.document.hidden=true;context.acknowledgeConversation(view);context.document.hidden=false;
  focused=false;context.acknowledgeConversation(view);focused=true;
  open=false;context.acknowledgeConversation(view);open=true;
  dialog=true;context.acknowledgeConversation(view);dialog=false;
  artifact=true;context.acknowledgeConversation(view);
  assert.equal(reviews.length,1,'Hidden, unfocused, covered and superseded chats stay unread');
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
  const context={sessions:new Map([['mac',mac]]),tabOrder:[...initial],hidden:{},filter:'all',groups:{},ready:{},selected:null,
    localStorage:{setItem:(name,value)=>stored[name]=value},render(){},tabButtons:new Map()};
  vm.createContext(context);initPins(context);
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
    const context={hosts:new Map(hosts),sessions,hidden:{},ready:{},selected:null,saveReady(){},filter:'all',groups:{},render(){},tabButtons:new Map(),
      localStorage:{getItem:key=>stored[key]??null,setItem:(key,value)=>stored[key]=value},
      fetch:(url,options)=>{posted.push(JSON.parse(options.body).keys);return Promise.resolve({ok:true,json:()=>({updated:posted.length+100})});}};
    vm.createContext(context);initPins(context);context.tabOrder=local;
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

test('hidden tabs are shared by every paired computer and go after the other tabs',async()=>{
  const view=(hosts,self,local)=>{
    const sessions=new Map(hosts.map(([host,{name}])=>[host,{host,name:'main',state:{panes:[]},catalogPolls:1,catalog:[0,1].map(id=>({id,name:`${name}-${id}`,position:id,panes:[]}))}]));
    const posted=[],stored={'switchboard-hidden':JSON.stringify(local)};
    const context={hosts:new Map(hosts),sessions,ready:{},selected:null,saveReady(){},filter:'all',groups:{},render(){},tabButtons:new Map(),
      localStorage:{getItem:key=>stored[key]??null,setItem:(key,value)=>stored[key]=value},
      fetch:(url,options)=>{posted.push([url,JSON.parse(options.body).keys]);return Promise.resolve({ok:true,json:()=>({updated:posted.length+100})});}};
    vm.createContext(context);context.tabOrder=[];context.hidden={...local};
    vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
    vm.runInContext(`localMember=${JSON.stringify(self)}`,context);
    const names=()=>Array.from(context.allTabs(),item=>item.tab.name+(item.hidden?' (hidden)':''));
    return {context,sessions,posted,stored,names};
  };
  const mac={name:'Mac',id:'d1',local:true},win={name:'Windows',id:'24',local:true};
  // The Mac archived its own tab before sharing existed.
  const onMac=view([['mac',{name:'Mac',local:true}],['mesh-24',{name:'Windows'}]],mac,{[JSON.stringify(['mac','main','tab',0])]:123});
  const onWindows=view([['win',{name:'Windows',local:true}],['mesh-d1',{name:'Mac'}]],win,{});
  assert.deepEqual(onMac.names(),['Mac-1','Windows-0','Windows-1','Mac-0 (hidden)']);
  onMac.context.applyTabOrder({tab_order:null},mac);onMac.context.applyHidden({hidden_tabs:null},mac);
  assert.deepEqual(onMac.posted.at(-1),['/api/mesh/hidden-tabs',[JSON.stringify(['mesh-d1','main','tab',0])]],'it joins the group keyed by member');
  onWindows.context.applyTabOrder({tab_order:null},win);
  onWindows.context.applyHidden({hidden_tabs:{keys:onMac.posted.at(-1)[1],updated:1}},win);
  assert.deepEqual(onWindows.names(),['Mac-1','Windows-0','Windows-1','Mac-0 (hidden)']);
  // Windows hides its own admin tab; the Mac sees it, and an older poll cannot undo it.
  const admin=onWindows.context.allTabs().find(item=>item.tab.name==='Windows-1');
  onWindows.context.setHidden(admin,true);await new Promise(setImmediate);
  const shared=onWindows.posted.at(-1)[1];
  assert.deepEqual(shared,[JSON.stringify(['mesh-d1','main','tab',0]),JSON.stringify(['mesh-24','main','tab',1])]);
  onMac.context.applyHidden({hidden_tabs:{keys:shared,updated:150}},mac);
  onMac.context.applyHidden({hidden_tabs:{keys:onMac.posted.at(-1)[1],updated:120}},mac);
  assert.deepEqual(onMac.names(),['Mac-1','Windows-0','Mac-0 (hidden)','Windows-1 (hidden)']);
  // Shown again from the Mac, keyed the way Windows knows it.
  onMac.context.setHidden(onMac.context.allTabs().find(item=>item.tab.name==='Mac-0'),false);
  assert.deepEqual(onMac.posted.at(-1)[1],[JSON.stringify(['mesh-24','main','tab',1])]);
  assert.deepEqual(JSON.parse(onMac.stored['switchboard-hidden']),{[JSON.stringify(['mesh-24','main','tab',1])]:1},'this browser keeps a copy');
});

test('every computer in a mesh lists unsorted tabs in the same machine order',()=>{
  // Each computer calls itself by a local ID and lists itself first; catalogs arrive in any order.
  const view=(hosts,arrival,self)=>{
    const sessions=new Map(arrival.map(([host,name])=>[host,{host,name:'main',state:{panes:[]},catalog:[0,1].map(id=>({id,name:`${name}-${id}`,position:id,panes:[]}))}]));
    const context={hosts:new Map(hosts),sessions,tabOrder:[],hidden:{},filter:'all',groups:{}};
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
    const context={hosts:new Map([['mac',{name:'Doms-MacBook-Pro'}],['win',{name:'Windows'}]]),sessions:new Map(),tabOrder:[],ready:{},hidden:{},selected:null,
      filter:'all',groups:{},saveReady(){},localStorage:{getItem:key=>stored[key]??null,setItem:(key,value)=>stored[key]=value}};
    vm.createContext(context);initPins(context);
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
  const context={hosts:new Map([...sessions.keys()].map(host=>[host,{name:host}])),sessions,tabOrder:[],hidden:{},ready:{},
    filter:'work',groups:{w1:'work',w2:'work',h1:'home',h2:'home'},selected:null,localStorage:{getItem:()=>null,setItem(){}},renderFilter(){},
    focus:item=>focused.push(item.key)};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function sectionExpanded('),source.indexOf('const seenAttention')),context);
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

test('native tab identity preserves selection, hiding and order through pane removal, floating and reordered positions',()=>{
  const entry={host:'win',name:'main',state:{panes:[]}},stored={};
  const context={ready:{},hidden:{},selected:null,tabOrder:[],saveReady(){},localStorage:{setItem:(key,val)=>stored[key]=val},SwitchboardTitles:{tabTitle:(_,tab)=>tab.name}};
  vm.createContext(context);initPins(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function attentionKey(')),context);
  const pane=(pane_id,position,is_floating=false)=>({pane_id,is_plugin:false,tab_position:position,is_floating});
  context.setCatalog(entry,[{id:42,position:0,name:'A',panes:[pane(7,0),pane(8,0)]},{id:90,position:1,name:'B',panes:[pane(9,1)]}]);
  const key=context.tabKey(entry,entry.catalog[0]);context.selected=key;context.hidden[key]=1;context.tabOrder=[key];
  context.setCatalog(entry,[{id:90,position:0,name:'B',panes:[pane(9,0)]},{id:42,position:1,name:'A',panes:[pane(8,1,true)]}]);
  assert.equal(context.tabKey(entry,entry.catalog[1]),key);assert.equal(context.selected,key);assert.equal(context.isHidden(key),true);assert.equal(context.tabOrder[0],key);
  // A pane moved to another tab must never be used for focus while the catalog is stale.
  entry.state.panes=[pane(8,0,true)];assert.equal(context.tabPanes(entry,entry.catalog[1]).length,0);
  entry.state.panes=[pane(8,1,true)];assert.equal(context.tabPanes(entry,entry.catalog[1]).length,1);
});

test('existing pane-key preferences migrate once to native tab IDs',()=>{
  const entry={host:'mac',name:'main',state:{panes:[]}},old=JSON.stringify(['mac','main',7,false]);
  const context={ready:{[old]:321},hidden:{[old]:123},selected:old,tabOrder:[old],saveReady(){},localStorage:{setItem(){}}};
  vm.createContext(context);initPins(context);vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function attentionKey(')),context);
  const tabs=[{id:42,position:0,name:'A',panes:[{pane_id:7,is_plugin:false}]}];context.setCatalog(entry,tabs);
  const key=JSON.stringify(['mac','main','tab',42]);
  assert.equal(context.selected,key);assert.equal(context.ready[key],321);assert.deepEqual(Object.keys(context.hidden),[key]);assert.equal(context.tabOrder[0],key);
  context.setCatalog(entry,[{...tabs[0],panes:[{pane_id:8,is_plugin:false}]}]);assert.deepEqual(Object.keys(context.hidden),[key]);
});

test('Alt+T opens the New tab dialog once from editable fields but respects open dialogs',()=>{
  let handler,clicks=0,modal=false;
  const context={window:{addEventListener:(_,fn)=>handler=fn},navigator:{platform:'MacIntel'},document:{querySelector:()=>modal?{}:null},$:()=>({click(){clicks++;}})};
  vm.createContext(context);const start=source.indexOf("window.addEventListener('keydown',sidebarKeydown,true);");
  vm.runInContext(source.slice(start,source.indexOf('function renderMachines()',start)),context);
  const key=extra=>{const event={code:'KeyT',ctrlKey:false,altKey:true,metaKey:false,shiftKey:false,target:{closest:()=>null},preventDefault(){this.prevented=true;},stopImmediatePropagation(){},...extra};handler(event);return event;};
  assert.equal(key().prevented,true);assert.equal(clicks,1);key({repeat:true});assert.equal(clicks,1);
  assert.equal(key({target:{closest:()=>({})}}).prevented,true);assert.equal(clicks,2);
  for(const extra of [{ctrlKey:true},{altKey:false},{metaKey:true},{shiftKey:true},{isComposing:true}])assert.equal(key(extra).prevented,undefined);
  assert.equal(key({code:'KeyN'}).prevented,undefined);
  modal=true;assert.equal(key().prevented,undefined);assert.equal(clicks,2);
});


test('a native new tab arriving before its catalog follows its active pane after the next scan',()=>{
  const pane={pane_id:9,is_plugin:false,tab_position:1};
  const entry={host:'win',name:'main',state:{panes:[pane],active_pane:pane},followActiveTab:true,frame:{classList:{contains:()=>true}}};
  const key=id=>JSON.stringify(['win','main','tab',id]);
  const context={ready:{},hidden:{},selected:key(42),tabOrder:[],saveReady(){},localStorage:{setItem(){}}};
  vm.createContext(context);initPins(context);vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function attentionKey(')),context);
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
    const context={sessions:new Map([[JSON.stringify(['win','main']),entry]]),ready:{},hidden:{},selected:key(42),tabOrder:[],
      filter:'work',groups:{win:'home'},nativeTabs:false,saveReady(){},localStorage:{setItem(){}},$:()=>search,location:{origin:'http://localhost'},
      window:{addEventListener:(_,fn)=>handler=fn},setFilter(value){context.filter=value;},
      allTabs:()=>entry.catalog.map(tab=>({entry,tab,key:key(tab.id)})),acknowledgeAttention(){},
      restoreTerminalKeyboard(){},render(){highlight=context.selected;},focus(item){focused=item.key;entry.needsFocus=false;},
      refreshAttention(){scans++;}};
    vm.createContext(context);initPins(context);
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
  const context={attentionLoading:false,attentionRefreshPending:false,attentionVersion:0,tabCatalog:[],paneAttention:new Map(),catalogUnavailable:()=>false,sessions:new Map(),allTabs:()=>[],render(){},
    selected:null,attentionKey(){},updateCreatedTabs(){},setInterval(){},
    fetch:async()=>{requests++;if(requests===1)await response;return {ok:true,json:async()=>({tabs:[],panes:[]})};}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function refreshAttention('),source.indexOf('// The relay answers as soon as status changes')),context);
  const first=context.refreshAttention();
  await context.refreshAttention();assert.equal(context.attentionRefreshPending,false);
  await context.refreshAttention(true);await context.refreshAttention(true);
  assert.equal(context.attentionRefreshPending,true);assert.equal(requests,1);
  release();await first;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests,2);assert.equal(context.attentionLoading,false);assert.equal(context.attentionRefreshPending,false);
});


test('New tab cannot snapshot an unscanned or empty catalog',async()=>{
  const elements=new Map(),$=id=>elements.get(id);
  const entry={host:'mac',name:'main',state:{tabs:[{position:0}]},catalog:[]};let sent=0;
  entry.frame={contentWindow:{postMessage(){sent++;}}};
  elements.set('new-tab-form',{});elements.set('new-tab-target',{value:'main'});elements.set('new-tab-project',{value:'switchboard'});elements.set('new-tab-prompt',{value:'',addEventListener(){}});
  elements.set('new-tab-dialog',{close(){}});
  const context={$,newTabElevated:false,sessions:new Map([['main',entry]]),sessionTabs:entry=>[...(entry.catalog||[]),...(entry.provisionalTabs||[])],location:{origin:'https://switchboard.localhost'},hosts:new Map([['mac',{name:'Mac'}]]),setStatus(){},setTimeout(){}};
  vm.createContext(context);const start=source.indexOf("async function createNewTab(");
  vm.runInContext(source.slice(start,source.indexOf("$('ready').onclick=",start)),context);
  await context.createNewTab('main',{project:'switchboard',prompt:''});assert.equal(sent,0);assert.equal(entry.pendingNewTab,undefined);
  entry.catalog=null;await context.createNewTab('main',{project:'switchboard',prompt:''});assert.equal(sent,0);
});


test('early catalog data is applied immediately and one delayed host does not block other terminals',async()=>{
  let releaseSlow;const delayed=new Promise(resolve=>releaseSlow=resolve),mounted=[];
  const catalog=[{host:'mac',session:'main',id:42,position:0,name:'A',panes:[]}];
  const context={loading:false,hosts:new Map(),startedHosts:new Set(),sessions:new Map(),tabCatalog:catalog,ready:{},hidden:{},parkedTabs:{},saveParkedTabs(){},tabOrder:[],selected:null,catalogUnavailable:()=>false,saveReady(){},localStorage:{setItem(){}},clearTimeout(){},
    document:{createElement:()=>({getAttribute(name){return this[name];},remove(){}})},$:()=>({append:frame=>mounted.push(frame)}),renderMachines(){},render(){},setStatus(){},
    fetch:async url=>{if(url==='/api/hosts?summary=1')return {ok:true,json:async()=>[{id:'mac',name:'Mac'},{id:'slow',name:'Slow'}]};
      if(url==='/api/hosts/slow')return delayed;
      return {ok:true,json:async()=>({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]})};}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function sessionKey('),source.indexOf('function attentionKey(')),context);
  vm.runInContext(source.slice(source.indexOf('function syncTerminalConnection('),source.indexOf("window.addEventListener('message'")),context);
  const refresh=context.refresh();await new Promise(resolve=>setImmediate(resolve));
  const entry=context.sessions.get(JSON.stringify(['mac','main']));assert.equal(entry.catalog[0].id,42);assert.equal(mounted.length,1);assert.equal(context.loading,true);
  releaseSlow({ok:true,json:async()=>({id:'slow',name:'Slow',error:'Offline'})});await refresh;assert.equal(context.loading,false);
});


test('a host the relay stops listing leaves the sidebar without a reload',async()=>{
  let summary=[{id:'windows',name:'Windows'},{id:'mesh-twin',name:'Windows'}];const removed=[];
  const context={loading:false,hosts:new Map(),startedHosts:new Set(),sessions:new Map(),tabCatalog:[],ready:{},hidden:{},tabOrder:[],selected:null,catalogUnavailable:()=>false,saveReady(){},localStorage:{setItem(){}},clearTimeout(){},setTimeout(){},
    document:{createElement:()=>({getAttribute(name){return this[name];},remove(){removed.push(this.src);}})},$:()=>({append(){}}),renderMachines(){},render(){},setStatus(){},
    fetch:async url=>url==='/api/hosts?summary=1'?{ok:true,json:async()=>summary}
      :{ok:true,json:async()=>({id:decodeURIComponent(url.split('/').pop()),name:'Windows',sessions:[{name:'main',web_clients_allowed:true}]})}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function sessionKey('),source.indexOf('function attentionKey(')),context);
  vm.runInContext(source.slice(source.indexOf('function syncTerminalConnection('),source.indexOf("window.addEventListener('message'")),context);
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
  const preamble=source.slice(start,source.indexOf("\n  if(event.data?.type==='zellij-state')",start));
  vm.runInContext(preamble+'  if(false){'+source.slice(branch,end)+'}});',context);
  const fail=id=>handler({origin:'http://localhost',source:entry.frame.contentWindow,data:{type:'zellij-focus-failed',focus_id:id,payload:entry.state,message:'Terminal switch timed out.'}});
  fail(8);assert.equal(entry.focusPending,true);assert.equal(context.selected,'requested');
  fail(9);assert.equal(entry.focusPending,false);assert.equal(entry.requestedPane,null);
  assert.equal(context.selected,'actual');assert.equal(focused.tab,tab);assert.match(status,/timed out/);
});

test('failed creation restores the active tab immediately without clearing newer requests or a deliberate selection',()=>{
  const tab={id:42,position:0},creating={id:'creating',pending:true},entry={pendingNewTab:{requestId:9},creatingTab:creating,followActiveTab:true};
  const statuses=[],context={selected:'creating',activeTab:()=>tab,tabKey:(_,tab)=>String(tab.id),render(){},setStatus:(...args)=>statuses.push(args)};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function failNewTab('),source.indexOf('function recordTerminalDiagnostic(')),context);
  context.failNewTab(entry,8,'Old failure');
  assert.equal(entry.pendingNewTab.requestId,9);assert.equal(context.selected,'creating');assert.equal(statuses.length,0);
  context.failNewTab(entry,9,'Connection lost');
  assert.equal(entry.pendingNewTab,null);assert.equal(entry.creatingTab,null);assert.equal(entry.followActiveTab,false);
  assert.equal(context.selected,'42');assert.deepEqual(statuses,[['Connection lost',true]]);
  entry.pendingNewTab={requestId:10};entry.creatingTab=creating;context.selected='another tab';
  context.failNewTab(entry,10,'Disconnected');
  assert.equal(context.selected,'another tab');
});

test('new-tab diagnostic forwarding sends only bounded metadata fields',()=>{
  const requests=[],context={fetch:(url,options)=>{requests.push([url,JSON.parse(options.body)]);return Promise.resolve();}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function recordTerminalDiagnostic('),source.indexOf("window.addEventListener('message'")),context);
  context.recordTerminalDiagnostic({host:'windows'},'new-tab',{request_id:4,outcome:'ready',elapsed_ms:300,delivery_ms:2,sent_ms:20,pane_id:7,control_socket:1,contents:'private screen',title:'private title'});
  assert.deepEqual(requests,[['/api/diagnostics/new-tab',{host:'windows',request_id:4,outcome:'ready',elapsed_ms:300,delivery_ms:2,sent_ms:20,pane_id:7,control_socket:1}]]);
});

test('a clicked tab waiting for metadata retries from its button without stealing focus from other controls',()=>{
  const pane={pane_id:9,is_plugin:false,tab_position:2},active={pane_id:7,is_plugin:false,tab_position:0};
  const tab={id:90,position:1,name:'B',panes:[{...pane,tab_position:1}]},button={closest:()=>null},messages=[];
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
  const context={ready:{},hidden:{},selected:key(90),tabOrder:[],saveReady(){},localStorage:{setItem(){}}};
  vm.createContext(context);initPins(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function attentionKey(')),context);
  context.setCatalog(entry,[{id:42,position:0,panes:[pane]},{id:90,position:1,panes:[]}]);
  assert.equal(context.selected,key(90));assert.equal(entry.followActiveTab,true);
  entry.needsFocus=false;context.syncActiveTab(entry);
  assert.equal(context.selected,key(42));assert.equal(entry.followActiveTab,false);
});

test('a recreated session keeps its tabs where they were dragged, though Zellij numbers them from 0 again',async()=>{
  const view=(winTabs,created)=>{
    const tabs=ids=>ids.map((id,position)=>({id,name:'Windows-'+'ABCD'[position],position,panes:[]}));
    const sessions=new Map([['mesh-24',{host:'mesh-24',name:'main',state:{panes:[]},catalogPolls:1,catalog:tabs(winTabs)}],
      ['mesh-d1',{host:'mesh-d1',name:'main',state:{panes:[]},catalogPolls:1,catalog:[0,1].map(id=>({id,name:'Mac-'+id,position:id,panes:[]}))}]]);
    const hosts=new Map([['mesh-24',{name:'Windows',sessions:[{name:'main',created}]}],['mesh-d1',{name:'Mac',sessions:[{name:'main',created:50}]}]]);
    const posted=[],stored={};
    const context={hosts,sessions,hidden:{},ready:{},selected:null,saveReady(){},filter:'all',groups:{},render(){},tabButtons:new Map(),
      localStorage:{getItem:key=>stored[key]??null,setItem:(key,value)=>stored[key]=value},
      fetch:(url,options)=>{posted.push(JSON.parse(options.body).keys);return Promise.resolve({ok:true,json:()=>({updated:1000+posted.length})});}};
    vm.createContext(context);initPins(context);context.tabOrder=[];
    vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
    const names=()=>Array.from(context.allTabs(),item=>item.tab.name);
    const restart=(ids,at)=>{const entry=sessions.get('mesh-24');if(at)hosts.get('mesh-24').sessions[0].created=at;context.setCatalog(entry,tabs(ids));};
    return {context,sessions,posted,names,restart};
  };
  const key=(host,id)=>JSON.stringify([host,'main','tab',id]);
  const before=view([5,7,9],1000);
  before.context.hidden[key('mesh-24',7)]=1;
  before.context.setPinned({key:key('mesh-24',9)},true);
  before.context.setPinned({key:key('mesh-d1',0)},true);
  before.context.parkedTabs[key('mesh-24',5)]={state:'snoozed',until:90000};
  before.context.parkedTabs[key('mesh-24',9)]={state:'snoozed',until:60000};
  before.context.applyTabOrder({tab_order:{keys:[key('mesh-24',9),key('mesh-d1',0),key('mesh-24',5),key('mesh-d1',1),key('mesh-24',7)],updated:1}},{id:'me'});
  for(const entry of before.sessions.values())before.context.setCatalog(entry,entry.catalog);
  const dragged=['Windows-C','Mac-0','Windows-A','Mac-1','Windows-B'];
  assert.deepEqual(before.names(),dragged);
  await new Promise(setImmediate);
  // Windows reboots: the same tabs come back as 0, 1 and 2, and their catalog may beat the new start time.
  before.restart([0,1,2]);
  const waiting=before.posted.length;before.restart([0,1,2]);assert.equal(before.posted.length,waiting,'a catalog ahead of the start time waits');
  before.restart([0,1,2],9000);
  assert.deepEqual(before.names(),dragged);
  assert.equal(before.context.isPinned(key('mesh-24',2)),true);
  assert.equal(before.context.isPinned(key('mesh-24',9)),false);
  assert.equal(before.context.isPinned(key('mesh-d1',0)),true);
  assert.equal(before.context.parkedTabs[key('mesh-24',0)].until,90000);
  assert.equal(before.context.parkedTabs[key('mesh-24',2)].state,'snoozed');
  assert.equal(before.context.parkedTabs[key('mesh-24',5)],undefined);
  // The hidden tab stays hidden under its new number, and no other tab takes its place.
  assert.deepEqual(Object.keys(before.context.hidden),[key('mesh-24',1)]);
  assert.deepEqual(Array.from(before.context.allTabs().filter(item=>item.hidden),item=>item.tab.name),['Windows-B']);
  const shared=before.posted.at(-1);
  // Overlapping old/new IDs must migrate from a snapshot, without moving a pin twice.
  before.restart([1,2,3],18000);
  assert.equal(before.context.parkedTabs[key('mesh-24',1)].until,90000);
  assert.equal(before.context.parkedTabs[key('mesh-24',3)].state,'snoozed');
  assert.equal(before.context.isPinned(key('mesh-24',3)),true);
  assert.equal(before.context.isPinned(key('mesh-24',2)),false);
  assert.equal(before.context.isPinned(key('mesh-d1',0)),true);
  // Another browser that hears the remapped order after the restart leaves it alone.
  const after=view([0,1,2],9000);
  after.context.applyTabOrder({tab_order:{keys:shared,updated:2000}},{id:'me'});
  for(const entry of after.sessions.values())after.context.setCatalog(entry,entry.catalog);
  assert.deepEqual(after.names(),dragged);assert.equal(after.posted.length,0);
  // A session that comes back with an extra tab keeps the others in place and lists the new one with them.
  after.restart([0,1,2,3],20000);
  assert.deepEqual(after.names(),['Windows-C','Mac-0','Windows-A','Mac-1','Windows-B','Windows-D']);
});

test('chat cost shows only on the computers chosen, by mesh ID wherever the sidebar runs',async()=>{
  const start=source.indexOf('const settingDefs={'),end=source.indexOf("for(const key in settingDefs){\n  const control=$(key);");
  const view=(hosts,localMember)=>{
    const stored={},posted=[],updates=[];
    const context={posted,updates,hosts,localMember,window:{SwitchboardConversation:{update:()=>updates.push(1)}},document:{hidden:false,addEventListener(){}},
      render(){},load:()=>({}),focusGroup:()=>'',
      localStorage:{getItem:key=>stored[key]??null,setItem:(key,value)=>stored[key]=value},
      fetch:(url,options)=>{posted.push(JSON.parse(options.body));return Promise.resolve({ok:true,json:()=>({updated:500})});}};
    vm.createContext(context);vm.runInContext(source.slice(start,end)+';renderSettings=()=>{};',context);
    return context;
  };
  const windowsId='a1b2c3d4e5f6a7b8c9d0',macId='0f1e2d3c4b5a69788796';
  // Windows calls itself "windows"; the Mac knows it as "mesh-<id>".
  const onWindows=view(new Map([['windows',{name:'Windows',local:true}],['mesh-'+macId,{name:'Mac'}]]),{id:windowsId,local:true});
  const onMac=view(new Map([['mac',{name:'Mac',local:true}],['mesh-'+windowsId,{name:'Windows'}]]),{id:macId,local:true});
  assert.equal(onWindows.chatCostShown('windows'),false);
  onWindows.applySettings({settings:{}},{id:windowsId,local:true});
  onWindows.setSetting('chat-cost',onWindows.chatCostId('windows'));
  assert.deepEqual(onWindows.posted.at(-1),{key:'chat-cost',value:windowsId.slice(0,12)});
  assert.equal(onWindows.updates.length,1,'an open conversation repaints');
  assert.equal(onWindows.chatCostShown('windows'),true);
  assert.equal(onWindows.chatCostShown('mesh-'+macId),false);
  onMac.applySettings({settings:{'chat-cost':{value:windowsId.slice(0,12),updated:500}}},{id:macId,local:true});
  assert.equal(onMac.chatCostShown('mesh-'+windowsId),true);
  assert.equal(onMac.chatCostShown('mac'),false);
  assert.equal(onMac.describeSetting('chat-cost',windowsId.slice(0,12)),'Windows');
  assert.equal(onMac.describeSetting('chat-cost',''),'None');
});

test('settings are shared by every paired computer, and a browser can override any of them',async()=>{
  const start=source.indexOf('const settingDefs={'),end=source.indexOf("for(const key in settingDefs){\n  const control=$(key);");
  const view=stored=>{
    const posted=[],filters=[],reloads=[];
    const context={posted,filters,reloads,location:{reload:()=>reloads.push(1)},document:{hidden:false,addEventListener(){}},
      render(){},nativeTabs:false,updateNativeTabs(){},setFilter:value=>filters.push(value),
      load:key=>{try{return JSON.parse(stored[key])||{};}catch(_){return {};}},
      focusGroup:()=>['work','home'].includes(stored['switchboard-focus-group'])?stored['switchboard-focus-group']:'',
      localStorage:{getItem:key=>stored[key]??null,setItem:(key,value)=>stored[key]=value},
      fetch:(url,options)=>{const body=JSON.parse(options.body);posted.push([url,body]);return Promise.resolve({ok:true,json:()=>({updated:500})});}};
    vm.createContext(context);vm.runInContext(source.slice(start,end)+';renderSettings=()=>{};',context);
    return context;
  };
  const member={id:'d1',local:true},settle=()=>new Promise(setImmediate);
  // Before scopes: toggles move to the group once; the group filter and link browsers stay this browser's own.
  const stored={'switchboard-media-previews':'true','switchboard-focus-group':'work','switchboard-link-apps':JSON.stringify({work:'Google Chrome Canary'})};
  const mac=view(stored);
  assert.equal(mac.settingValue('focus-group'),'work');
  assert.equal(mac.settingValue('link-app-work'),'Google Chrome Canary');
  mac.applySettings({settings:{}},member);
  assert.deepEqual(mac.posted,[['/api/mesh/setting',{key:'media-previews',value:'true'}]]);
  await settle();
  // The group's value reaches readers of switchboard-<key>, unless this browser overrides it.
  const group={'media-previews':{value:'true',updated:500},'native-tabs':{value:'true',updated:600},'focus-group':{value:'home',updated:600}};
  mac.applySettings({settings:group},member);
  assert.equal(stored['switchboard-native-tabs'],'true');assert.equal(mac.nativeTabs,true);
  assert.equal(stored['switchboard-focus-group'],'work','this browser still opens on Work');
  assert.deepEqual(mac.filters,[]);
  // Reset falls back to the group's value.
  mac.resetSetting('focus-group');
  assert.equal(stored['switchboard-focus-group'],'home');assert.deepEqual(mac.filters,['home']);
  // An override in This browser never reaches the group.
  vm.runInContext(`settingScope='browser'`,mac);
  mac.setSetting('media-previews','false');
  assert.equal(stored['switchboard-media-previews'],'false');assert.equal(mac.sharedValue('media-previews'),'true');
  assert.equal(mac.posted.length,1);
  // A shared change is sent; a poll older than the save in flight cannot undo it.
  vm.runInContext(`settingScope='shared'`,mac);
  mac.setSetting('native-tabs','false');
  mac.applySettings({settings:group},member);
  assert.equal(stored['switchboard-native-tabs'],'false');
  assert.deepEqual(mac.posted.at(-1),['/api/mesh/setting',{key:'native-tabs',value:'false'}]);
  await settle();
  // Fine scrolling from another computer waits until nobody is looking before it reloads.
  mac.applySettings({settings:{...group,'native-tabs':{value:'false',updated:650},'fine-scroll':{value:'true',updated:700}}},member);
  assert.equal(stored['switchboard-fine-scroll'],'true');assert.equal(mac.reloads.length,0);
  assert.equal(mac.posted.length,2,'nothing is sent twice');
  // An unpaired computer, or a relay without shared settings, keeps them in this browser.
  const alone=view({});
  alone.applySettings({settings:{}},null);alone.applySettings({},member);
  alone.setSetting('media-thumbnails','true');
  assert.deepEqual(alone.posted,[]);
  assert.equal(alone.sharedValue('media-thumbnails'),'true');
  // Snoozing defaults on, follows the group, and supports a browser override.
  assert.equal(mac.settingValue('move-working-to-snoozed'),'true');
  mac.setSetting('move-working-to-snoozed','false');
  assert.deepEqual(mac.posted.at(-1),['/api/mesh/setting',{key:'move-working-to-snoozed',value:'false'}]);
  await settle();
  alone.applySettings({settings:{'move-working-to-snoozed':{value:'false',updated:500}}},member);
  assert.equal(alone.settingValue('move-working-to-snoozed'),'false');
  vm.runInContext("settingScope='browser'",alone);
  alone.setSetting('move-working-to-snoozed','true');
  assert.equal(alone.settingValue('move-working-to-snoozed'),'true');
  assert.equal(alone.sharedValue('move-working-to-snoozed'),'false');
  assert.ok(!alone.posted.some(([,body])=>body.key==='move-working-to-snoozed'));
  alone.resetSetting('move-working-to-snoozed');
  assert.equal(alone.settingValue('move-working-to-snoozed'),'false');
});
