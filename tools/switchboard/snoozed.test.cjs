const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
function fixture(){
  let now=0,timer;
  const tab={key:'a',tab:{},entry:{host:'mac',name:'main'},working:true,attention:false};
  const context={Date:{now:()=>now},allTabs:()=>[tab],settingValue:()=> 'true',isReady:item=>item.attention,
    parkedTabs:{},parkedTab:item=>context.parkedTabs[item.key],canonKey:key=>key,urgentTokens:()=>[],askpassForTab:()=>null,saveParkedTabs(){},sectionExpanded:()=>false,
    isPinned:key=>!!tab.pinned,autoLabel:item=>item.label??(item.working?'Working':''),attentionErrors:[],statusUnavailable:(host,session)=>context.attentionErrors.some(e=>e.host===host&&e.session===session),setTimeout:fn=>(timer=fn),clearTimeout:()=>{timer=null;},
    render:()=>context.sidebarTabs(),selected:'a',hiddenOpen:false,snoozedOpen:false,$:()=>({value:''}),matchesSearch:()=>true};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('// Hold shelf placement'),source.indexOf('function moveTab(')),context);
  return {context,tab,advance:ms=>{now+=ms;timer?.();},snoozed:()=>context.sidebarTabs()[0].snoozed};
}
test('selected snoozed tab remains visible in a collapsed shelf',()=>{
  const {context,snoozed}=fixture();assert.equal(snoozed(),true);
  assert.equal(context.listedTabs().length,1);
  context.selected='other';assert.equal(context.listedTabs().length,0);
});
test('completion waits two seconds, and resumed work cancels the old deadline',()=>{
  const {tab,snoozed,advance}=fixture();assert.equal(snoozed(),true);
  tab.working=false;assert.equal(snoozed(),true);advance(1999);assert.equal(snoozed(),true);
  tab.working=true;assert.equal(snoozed(),true);advance(1);
  tab.working=false;assert.equal(snoozed(),true);advance(1999);assert.equal(snoozed(),true);
  advance(1);assert.equal(snoozed(),false);
});
test('a tab waiting on a background agent stays folded with working tabs',()=>{
  const {tab,snoozed,advance}=fixture();tab.working=false;tab.label='Waiting on an agent';
  assert.equal(snoozed(),true);advance(5000);assert.equal(snoozed(),true);
  tab.label='Ready to review';tab.attention=true;assert.equal(snoozed(),false);
});
test('attention, errors, hiding and disabling snooze bypass the grace',()=>{
  for(const change of [
    f=>{f.tab.attention=true;},
    f=>{f.context.attentionErrors=[{host:'mac',session:'main'}];},
    f=>{f.tab.hidden=true;},
    f=>{f.context.settingValue=()=> 'false';},
  ]){
    const f=fixture();assert.equal(f.snoozed(),true);f.tab.working=false;assert.equal(f.snoozed(),true);
    change(f);assert.equal(f.snoozed(),false);
  }
});

test('pinning prevents snoozing and unpinning resumes it immediately',()=>{
  const {tab,snoozed}=fixture();
  tab.pinned=true;assert.equal(snoozed(),false);
  tab.working=false;assert.equal(snoozed(),false);
  tab.working=true;assert.equal(snoozed(),false);
  tab.pinned=false;assert.equal(snoozed(),true);
  tab.pinned=true;assert.equal(snoozed(),false);
});

test('manual snooze survives completion and background work until its deadline',()=>{
  const {context,tab,advance}=fixture();
  context.parkedTabs.a={state:'snoozed',until:60000,urgent:[]};
  assert.equal(context.sidebarTabs()[0].shelf,'snoozed');
  assert.equal(context.sidebarTabs()[0].snoozed,false,'manual snooze is separate from Working');
  tab.working=false;tab.attention=true;advance(30000);
  assert.equal(context.sidebarTabs()[0].shelf,'snoozed');
  tab.working=true;advance(29999);assert.equal(context.sidebarTabs()[0].shelf,'snoozed');
  advance(1);assert.equal(context.sidebarTabs()[0].shelf,undefined);
  assert.deepEqual(context.parkedTabs,{});
});

test('snoozing an existing question holds it, and a new question wakes it',()=>{
  const {context}=fixture();
  context.urgentTokens=()=>['question:1'];
  context.parkedTabs.a={state:'snoozed',until:60000,urgent:['question:1']};
  assert.equal(context.sidebarTabs()[0].shelf,'snoozed');
  context.urgentTokens=()=>['approval:2'];
  assert.equal(context.sidebarTabs()[0].shelf,undefined);
});

test('both shelves wake for successive prompts with constant or missing relay tokens',()=>{
  for(const shelf of ['snoozed','settled'])for(const [state,token] of [['approval','approval'],['input','question'],['approval',undefined]]){
    const {context,tab}=fixture(),prompt={key:'pane-1',state,token,since:100};
    context.statesForTab=()=>[prompt];
    vm.runInContext(source.slice(source.indexOf('function urgentTokens('),source.indexOf('function parkTab(')),context);
    context.parkedTabs.a={state:shelf,until:60000,urgent:context.urgentTokens(tab)};
    assert.equal(context.sidebarTabs()[0].shelf,shelf,'an existing prompt can stay parked');
    prompt.state='working';prompt.since=101;assert.equal(context.sidebarTabs()[0].shelf,shelf);
    prompt.state=state;prompt.since=102;
    assert.equal(context.sidebarTabs()[0].shelf,undefined,`${shelf}: a new ${state} with the same token must return`);
  }
});

test('manual shelves obey collapse, search and selection without changing tab order',()=>{
  const {context,tab}=fixture();tab.working=false;
  context.parkedTabs.a={state:'settled'};
  context.selected='other';assert.equal(context.listedTabs().length,0);
  context.selected='a';assert.equal(context.listedTabs()[0].shelf,'settled');
  context.selected='other';context.$=()=>({value:'find me'});
  assert.equal(context.listedTabs()[0].shelf,'settled');
  context.$=()=>({value:''});context.sectionExpanded=()=>true;
  assert.equal(context.listedTabs()[0].key,'a');
  tab.hidden=true;assert.equal(context.sidebarTabs()[0].shelf,false,'Hidden takes precedence');
});

test('pins survive a fresh browser state and can be removed',()=>{
  const stored={};
  function browser(){
    const context={load:key=>JSON.parse(stored[key]||'{}'),canonKey:key=>key,
      localStorage:{setItem:(key,value)=>stored[key]=value}};
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('const pinned ='),source.indexOf('// Tabs in the Hidden')),context);
    return context;
  }
  const item={key:'a'};
  browser().setPinned(item,true);
  const restored=browser();assert.equal(restored.isPinned('a'),true);
  restored.setPinned(item,false);assert.equal(browser().isPinned('a'),false);
});
