const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8').split('const hosts =')[0];
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(stamp='aaaaaaa'){
  const events={},timers=new Map(),label={},state={hidden:false,draft:false,dialog:false,viewer:false,commit:'aaaaaaa',reloads:0,fail:false};
  let timer=0,poll;
  const document={getElementById:()=>label,get hidden(){return state.hidden;},querySelector:selector=>selector.startsWith('meta')?{content:stamp}:(selector.startsWith('#terminals')?state.viewer:state.dialog)?{}:null,addEventListener:(name,fn)=>events[name]=fn};
  const context={document,window:{addEventListener:(name,fn)=>events[name]=fn},SwitchboardConversation:{hasUnsentWork:()=>state.draft},location:{reload:()=>state.reloads++},fetch:async(url,options)=>{assert.equal(url,'/api/health');assert.equal(options.cache,'no-store');if(state.fail)throw Error('offline');return {ok:true,json:async()=>({commit:state.commit,commit_date:'2026-11-07'})};},setInterval:fn=>{poll=fn;},setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),Intl,Date};
  vm.runInNewContext(source,context);await settle();
  return {state,label,timers,check:async()=>{await poll();},visibility:async(hidden)=>{state.hidden=hidden;events.visibilitychange();await settle();},fire:()=>{for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}
test('stale sidebar refreshes in the background, preserving the loaded version until then',async()=>{
  const f=await fixture();f.state.commit='bbbbbbb';await f.check();f.fire();assert.equal(f.state.reloads,0);
  assert.match(f.label.textContent,/aaaaaaa/);
  await f.visibility(true);assert.equal(f.timers.size,1);f.fire();assert.equal(f.state.reloads,1);
  await f.check();f.fire();assert.equal(f.state.reloads,1);
});
test('returning to the tab, unsent work, or an open dialog postpones refresh',async()=>{
  const f=await fixture();f.state.commit='bbbbbbb';await f.visibility(true);await f.visibility(false);f.fire();assert.equal(f.state.reloads,0);
  f.state.draft=true;await f.visibility(true);f.fire();assert.equal(f.state.reloads,0);
  f.state.draft=false;f.state.dialog=true;await f.check();f.fire();assert.equal(f.state.reloads,0);
  f.state.dialog=false;await f.check();f.state.draft=true;f.fire();assert.equal(f.state.reloads,0);
  f.state.draft=false;await f.check();f.fire();assert.equal(f.state.reloads,1);
});
test('live or retiring terminal viewers block refresh even with no browser input pending',async()=>{
  const f=await fixture();f.state.commit='bbbbbbb';f.state.viewer=true;
  await f.visibility(true);f.fire();assert.equal(f.state.reloads,0);
  f.state.viewer=false;await f.check();f.state.viewer=true;f.fire();assert.equal(f.state.reloads,0,'A viewer opened during the delay must prevent refresh');
  f.state.viewer=false;await f.check();f.fire();assert.equal(f.state.reloads,1,'Refresh can proceed after every iframe is blank');
});
test('failures, unknown versions, matching hashes and rollbacks do not cause refresh loops',async()=>{
  const f=await fixture();await f.visibility(true);f.state.commit='aaaaaaa'+'0'.repeat(33);await f.check();f.fire();assert.equal(f.state.reloads,0);
  f.state.commit='unknown';await f.check();f.fire();assert.equal(f.state.reloads,0);
  f.state.commit='bbbbbbb';await f.check();f.state.fail=true;await f.check();f.fire();assert.equal(f.state.reloads,0);
  f.state.fail=false;f.state.commit='aaaaaaa';await f.check();f.fire();assert.equal(f.state.reloads,0);
});
test('HTML stamp detects an update before the first health response',async()=>{
  const f=await fixture('bbbbbbb');await f.visibility(true);f.fire();assert.equal(f.state.reloads,1);
});

test('browser reloads the same URL once and loads the new HTML stamp',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  try{
    const page=await browser.newPage();let commit='aaaaaaa',loads=0;
    await page.addInitScript(()=>Object.defineProperty(document,'hidden',{get:()=>true}));
    await page.route('https://switchboard.test/**',route=>{
      if(new URL(route.request().url()).pathname==='/api/health')return route.fulfill({json:{commit,commit_date:'2026-11-07'}});
      loads++;return route.fulfill({contentType:'text/html',body:`<head><meta name="switchboard-build" content="${commit}"></head><p id="build-version"></p><script>${source}</script>`});
    });
    const url='https://switchboard.test/?host=fixture&session=main&tab=7&group=work';
    await page.goto(url);await page.waitForFunction(()=>document.getElementById('build-version').textContent.startsWith('aaaaaaa'));
    await page.evaluate(()=>{const root=document.createElement('div');root.id='terminals';const frame=document.createElement('iframe');frame.srcdoc='<p>Legacy terminal</p>';root.append(frame);document.body.append(root);});
    commit='bbbbbbb';
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(2200);assert.equal(loads,1,'A legacy viewer also prevents background reload');
    await page.evaluate(()=>{const frame=document.querySelector('#terminals>iframe');frame.removeAttribute('srcdoc');frame.src='about:blank';});
    await Promise.all([page.waitForEvent('domcontentloaded'),page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))]);
    await page.waitForFunction(()=>document.getElementById('build-version').textContent.startsWith('bbbbbbb'));
    assert.equal(page.url(),url);assert.equal(loads,2);
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(2200);assert.equal(loads,2);
  }finally{await browser.close();}
});
