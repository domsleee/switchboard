const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
function fixture(){
  let now=0,timer;
  const tab={key:'a',tab:{},entry:{host:'mac',name:'main'},working:true,attention:false};
  const context={Date:{now:()=>now},allTabs:()=>[tab],settingValue:()=> 'true',isReady:item=>item.attention,
    isPinned:key=>!!tab.pinned,autoLabel:item=>item.working?'Working':'',attentionErrors:[],setTimeout:fn=>(timer=fn),clearTimeout:()=>{timer=null;},
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
