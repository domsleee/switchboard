const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('Close confirms the clicked tab, preserves its target, and shows errors without closing',async()=>{
  const elements=new Map(),calls=[];
  const $=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,open:false,
      focus(){},showModal(){this.open=true;},close(){this.open=false;this.onclose?.();},
      addEventListener(type,handler){this['on'+type]=handler;}});
    return elements.get(id);
  };
  const entry={host:'win',name:'main',state:{panes:[{tab_position:2,pane_id:17,is_plugin:false}]}};
  const item={entry,tab:{position:2,name:'Clicked tab'},key:'clicked'};
  const context={$,contextItem:item,hosts:new Map([['win',{name:'Windows'}]]),
    SwitchboardTitles:{tabTitle:(_,tab)=>tab.name},closeTabMenu(){context.contextItem=null;},
    setStatus(){},ready:{clicked:1},archived:{clicked:1},saveReady(){},localStorage:{setItem(){}},refresh:async()=>{},
    fetch:async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return {ok:true};}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/static/close.js','utf8'),context);
  $('close-tab').onclick();
  assert.equal($('close-tab-dialog').open,true);assert.equal(calls.length,0);
  $('cancel-close-tab').onclick();await $('confirm-close-tab').onclick();assert.equal(calls.length,0);
  context.contextItem=item;$('close-tab').onclick();entry.name='elsewhere';entry.state.panes=[];
  await $('confirm-close-tab').onclick();
  assert.deepEqual(calls[0],['/api/hosts/win/close-tab',{session:'main',pane_id:17,is_plugin:false}]);
  assert.equal($('close-tab-dialog').open,false);assert.equal(context.ready.clicked,undefined);
  entry.name='main';entry.state.panes=[{tab_position:2,pane_id:17,is_plugin:false}];
  context.contextItem=item;$('close-tab').onclick();
  context.fetch=async()=>({ok:false,text:async()=>'That tab is no longer available'});
  await $('confirm-close-tab').onclick();
  assert.equal($('close-tab-dialog').open,true);assert.match($('close-tab-error').textContent,/no longer available/);
});
