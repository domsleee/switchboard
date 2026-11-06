const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
function harness(){
 const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,showModal(){this.open=true;},addEventListener(event,handler){this.onclose=handler;},close(value){if(value!==undefined)this.returnValue=value;this.open=false;this.onclose?.();}});return elements.get(id);};
 const entry={host:'peer',name:'main',state:{active_pane:{pane_id:7}}};
 const item={key:'peer-main-tab42',entry,tab:{id:42,panes:[{pane_id:7,is_plugin:false}]}};
 let finish;const calls=[];
 const ctx={$,contextItem:item,selected:item.key,paneAttention:new Map(),attentionKey:(h,s,p)=>JSON.stringify([h,s,p]),tabPanes:(e,t)=>t.panes,tabTitle:()=> 'Current chat',closeTabMenu(){ctx.contextItem=null;},setStatus:s=>ctx.status=s,refreshAttention:async()=>{},updateTabMenu(){},AbortSignal,
 fetch:(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Promise(r=>finish=r);}};
 ctx.paneAttention.set(ctx.attentionKey('peer','main',7),{agent:'codex',state:'ready',chat_id:'codex-one',restart_available:true});
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('const restartingAgents='),source.indexOf('function updateTabMenu(){')),ctx);
 return {ctx,item,$,calls,finish:value=>finish(value)};
}
test('restart targets the menu tab and exact conversation, deduplicates requests and never sends terminal text',async()=>{
 const h=harness(),{ctx,item,$}=h;
 ctx.selected='some-other-tab';
 const request=$('restart-agent').onclick();
 assert.deepEqual(h.calls,[{url:'/api/hosts/peer/restart-agent',body:{session:'main',pane_id:7,tab_id:42,chat_id:'codex-one'}}]);
 ctx.contextItem=item;await $('restart-agent').onclick();assert.equal(h.calls.length,1);
 h.finish({ok:true});await request;assert.match(ctx.status,/Resuming/);assert.equal(ctx.selected,'some-other-tab');
});
test('restart is available for working agents but not unknown identities, ambiguous panes and provisional tabs',()=>{
 const {ctx,item}=harness();const key=ctx.attentionKey('peer','main',7),state=ctx.paneAttention.get(key);
 state.state='working';assert.equal(ctx.restartAgentTarget(item).working,true);state.state='ready';
 state.restart_available=false;assert.equal(ctx.restartAgentTarget(item),null);state.restart_available=true;
 item.tab.pending=true;assert.equal(ctx.restartAgentTarget(item),null);item.tab.pending=false;
 item.tab.panes.push({pane_id:8,is_plugin:false});ctx.selected='elsewhere';assert.equal(ctx.restartAgentTarget(item),null);
 ctx.selected=item.key;assert.equal(ctx.restartAgentTarget(item).pane_id,7);
});
test('restart failures are shown without automatic retry or selecting another tab',async()=>{
 const h=harness();const pending=h.$('restart-agent').onclick();h.finish({ok:false,text:async()=> 'Clear your unsent prompt first'});await pending;
 assert.equal(h.ctx.status,'Clear your unsent prompt first');assert.equal(h.calls.length,1);
});
test('working restart waits for confirmation and marks the interruption explicitly',async()=>{
 const h=harness(),state=h.ctx.paneAttention.get(h.ctx.attentionKey('peer','main',7));state.state='working';
 let pending=h.$('restart-agent').onclick();assert.equal(h.calls.length,0);assert.equal(h.$('restart-agent-dialog').open,true);
 h.$('restart-agent-dialog').close('cancel');await pending;assert.equal(h.calls.length,0);
 h.ctx.contextItem=h.item;pending=h.$('restart-agent').onclick();h.$('restart-agent-dialog').close('restart');
 await new Promise(setImmediate);
 assert.deepEqual(h.calls,[{url:'/api/hosts/peer/restart-agent',body:{session:'main',pane_id:7,tab_id:42,chat_id:'codex-one',confirm_interrupt:true}}]);
 h.finish({ok:true});await pending;
 h.ctx.contextItem=h.item;pending=h.$('restart-agent').onclick();
 h.$('restart-agent-dialog').close();await pending;
 assert.equal(h.calls.length,1,'Escape after a prior confirmation must cancel');
});
