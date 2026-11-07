// Opt-in real engine/Chromium proof. Does not attach to the user's sessions.
// PLAYWRIGHT_MODULE=... node tools/switchboard/resumable-viewer.test.cjs BINARY
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),net=require('node:net'),crypto=require('node:crypto');
const {execFileSync,fork}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
// Shared CI runners cannot guarantee the local experiment's 250 ms budget.
const latencyLimitMs=Number(process.env.RESUME_PROOF_LATENCY_MS||250);
assert(Number.isFinite(latencyLimitMs)&&latencyLimitMs>0,'RESUME_PROOF_LATENCY_MS must be positive');
const binary=path.resolve(process.argv[2]||'target/debug/zellij');
const dir=fs.mkdtempSync(path.join(process.platform==='win32'?(process.env.RUNNER_TEMP||os.tmpdir()):'/tmp','sbr-'));
const fixture=path.join(__dirname,'resumable-viewer'),endpointFile=path.join(dir,'endpoint.json');
const name='resume-proof-'+crypto.randomBytes(5).toString('hex'),config=path.join(dir,'config.kdl');
const env={...process.env,ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),XDG_CACHE_HOME:path.join(dir,'cache'),SWITCHBOARD_RESUME_PROOF_ENDPOINT:endpointFile,TERM:'xterm-256color'};
for(const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_FILE','ZELLIJ_CONFIG_DIR'])delete env[key];
fs.writeFileSync(config,'show_startup_tips false\nsession_serialization false\n');
let cliSequence=0;
const cli=(...args)=>{
 // Background Windows engines inherit handles: pipes keep spawnSync waiting
 // after the launcher exits. Files also preserve diagnostics on CI failures.
 const prefix=path.join(dir,`cli-${++cliSequence}`),output=prefix+'.log';
 const out=fs.openSync(output,'w'),err=fs.openSync(prefix+'-error.log','w');
 try{execFileSync(binary,['--config',config,...args],{env,windowsHide:true,timeout:15000,stdio:['ignore',out,err]});return fs.readFileSync(output,'utf8')}
 finally{fs.closeSync(out);fs.closeSync(err)}
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(check,label,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await sleep(20)}throw Error(label)}
const access=crypto.randomUUID();let browser,page,server,endpoint,pane,created=false;const children=[],faults=[];
function engine(request){return new Promise((resolve,reject)=>{
 const s=net.connect(endpoint.port,'127.0.0.1');let data='';s.setTimeout(3000,()=>s.destroy(Error('proof endpoint timeout')));
 s.on('connect',()=>s.write(JSON.stringify({...request,capability:endpoint.capability})+'\n'));
 s.on('data',b=>{data+=b;if(data.includes('\n')){s.end();resolve(JSON.parse(data))}});s.on('error',reject);
});}
async function bridge(version,origin,port=0,drop=0){
 const child=fork(path.join(fixture,'bridge.cjs'),[endpointFile,origin,access,version,String(port),String(drop)],{stdio:['ignore','pipe','pipe','ipc']});children.push(child);
 child.stdout.on('data',b=>fs.appendFileSync(path.join(dir,'bridges.log'),b));child.stderr.on('data',b=>fs.appendFileSync(path.join(dir,'bridges.log'),b));
 child.on('message',m=>{if(m.fault)faults.push(m)});
 return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('bridge did not start')),5000);child.on('message',m=>{if(m.port){clearTimeout(timer);resolve({...m,child,url:'http://127.0.0.1:'+m.port})}});child.once('error',reject)});
}
(async()=>{try{
 const python=process.env.PYTHON|| (process.platform==='win32'?'python':'python3');
 cli('attach','--create-background',name,'--',python,'-u',path.join(fixture,'fixture.py'),dir);created=true;
 const startupBegan=Date.now();
 try {await waitFor(()=>fs.existsSync(endpointFile)&&fs.existsSync(path.join(dir,'fixture.json')),'private engine/fixture did not start',process.platform==='win32'?45000:15000);}
 catch(error){
  const diagnostic={elapsedMs:Date.now()-startupBegan,endpointExists:fs.existsSync(endpointFile),fixtureExists:fs.existsSync(path.join(dir,'fixture.json'))};
  try{
   diagnostic.panes=JSON.parse(cli('-s',name,'action','list-panes','--json','--all'));
   diagnostic.screens=diagnostic.panes.filter(p=>!p.is_plugin).map(p=>{try{return {pane:p.id,text:cli('-s',name,'action','dump-screen','-p',String(p.id))};}catch(cause){return {pane:p.id,error:String(cause)};}});
  }catch(cause){diagnostic.error=String(cause);}
  fs.writeFileSync(path.join(dir,'startup-diagnostic.json'),JSON.stringify(diagnostic,null,2));
  throw error;
 }
 endpoint=JSON.parse(fs.readFileSync(endpointFile));
 const panes=JSON.parse(cli('-s',name,'action','list-panes','--json','--all'));pane=panes.find(p=>!p.is_plugin).id;
 const fixturePid=JSON.parse(fs.readFileSync(path.join(dir,'fixture.json'))).pid;
 server=http.createServer((req,res)=>{
  const files={'/':path.join(fixture,'page.html'),'/xterm.js':path.join(__dirname,'../../zellij-client/assets/xterm.js'),'/xterm.css':path.join(__dirname,'../../zellij-client/assets/xterm.css')};
  if(!files[req.url]){res.writeHead(404);return res.end()}
  res.setHeader('Content-Type',req.url.endsWith('.js')?'application/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(files[req.url]));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const first=await bridge('old',origin,0,20),lostResume=await bridge('lost-resume',origin,0,-1),second=await bridge('candidate',origin,0,60);
 browser=await chromium.launch({headless:true});page=await browser.newPage();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
 await page.goto(origin);await page.evaluate(c=>{window.proofLoop=startProof(c)}, {bridges:[first.url,lostResume.url,second.url],access,pane});
 await waitFor(async()=> (await page.evaluate(()=>proofState())).opened,'browser did not attach');
 fs.writeFileSync(path.join(dir,'go'),'');
 // Actual xterm input events; each insertion is one independently numbered record.
 for(let i=1;i<=30;i++){await page.keyboard.insertText(`IN:${String(i).padStart(4,'0')}\n`);await sleep(10)}
 await waitFor(()=>faults.some(f=>f.version==='old'),'candidate handover fault not exercised');
 await waitFor(async()=> (await page.evaluate(()=>proofState())).evidence.bridges.includes('candidate'),'candidate never served viewer');
 // The previous bridge actually died. Recreate its version on the same address
 // for rollback; the browser document and engine attachment remain unchanged.
 await waitFor(()=>first.child.exitCode!==null,'old bridge did not exit');
 const rollback=await bridge('old-rollback',origin,first.port,0);
 for(let i=31;i<=80;i++){await page.keyboard.insertText(`IN:${String(i).padStart(4,'0')}\n`);await sleep(10)}
 await waitFor(()=>faults.some(f=>f.version==='candidate'),'rollback fault not exercised');
 await waitFor(async()=> (await page.evaluate(()=>proofState())).evidence.bridges.includes('old-rollback'),'rollback never served viewer');
 // Raw split escape/paste bytes survive; this does not exercise the production
 // StdinSession parser, which is intentionally outside this experiment.
 for(const bytes of [[27],[91],[65],[27,91,50,48,48,126],[112,97,115,116,101],[27,91,50,48,49,126]])await page.evaluate(bytes=>sendProof(bytes),bytes);
 await waitFor(async()=>{const state=await page.evaluate(()=>proofState());assert.deepEqual(state.evidence.failures,[]);return state.pending===0},'pending input never acknowledged');
 const state=await page.evaluate(()=>proofState());
 fs.writeFileSync(path.join(dir,'browser-state.json'),JSON.stringify(state,null,2));
 await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin')).length>=state.evidence.bytes.length,'fixture did not consume accepted bytes');
 assert.deepEqual(fs.readFileSync(path.join(dir,'input.bin')),Buffer.from(state.evidence.bytes),'application saw lost or duplicated input');
 assert.deepEqual(state.evidence.acks,Array.from({length:state.evidence.acks.length},(_,i)=>i+1));
 assert.deepEqual(state.evidence.outputs,Array.from({length:state.evidence.outputs.length},(_,i)=>i+1));
 assert.deepEqual(pageErrors,[]);assert(state.sameTerm&&state.sameDocument&&state.focused);assert.equal(state.cols,100);assert.equal(state.rows,30);
 assert(state.evidence.maxAckMs<latencyLimitMs,`handover/input stalled ${state.evidence.maxAckMs}ms`);
 assert(state.evidence.resumes>=2);assert.equal(faults.length,3);assert(faults.some(f=>f.fault==='lost-resume-reply'));assert.equal(state.evidence.blurs,0);
 assert.equal(JSON.parse(fs.readFileSync(endpointFile)).engine_pid,endpoint.engine_pid);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'fixture.json'))).pid,fixturePid);process.kill(fixturePid,0);
 assert.deepEqual(JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).map(p=>p.id),panes.map(p=>p.id));
 // Observe every output record in xterm at least once. Zellij keeps its
 // scrollback in the engine, so the browser buffer need not retain old rows.
 await waitFor(()=>fs.readFileSync(path.join(dir,'output.txt'),'utf8').split('\n').length>120,'continuous output fixture stopped');
 fs.writeFileSync(path.join(dir,'stop'),'');await sleep(50);
 const emitted=fs.readFileSync(path.join(dir,'output.txt'),'utf8').trim().split(/\r?\n/);
 await waitFor(async()=>{const s=await page.evaluate(()=>proofState());return emitted.every(line=>s.evidence.seenOutput[line])},'output missing from retained terminal');
 const final=await page.evaluate(()=>proofState());
 const history=cli('-s',name,'action','dump-screen','--full','--pane-id',String(pane));
 for(const line of emitted)assert.equal(history.split(line).length-1,1,`lost/duplicated engine output ${line}`);
 const observed=fs.readFileSync(path.join(dir,'input-times.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const maxInputMs=Math.max(...state.evidence.inputTimes.map(input=>observed.find(chunk=>chunk.end>=input.end).time-input.time));
 const outputTimes=fs.readFileSync(path.join(dir,'output-times.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const maxOutputMs=Math.max(...outputTimes.map(output=>final.evidence.seenOutput[output.line]-output.time));
 assert(maxInputMs<latencyLimitMs,`input delivery froze ${maxInputMs}ms`);assert(maxOutputMs<latencyLimitMs,`output delivery froze ${maxOutputMs}ms`);
 // Stop polling after continuous output is proven so these direct protocol
 // checks cannot race a newer browser output acknowledgment.
 const stopped=await page.evaluate(async()=>{running=false;await window.proofLoop;return proofState()});
 const common={viewer:stopped.viewer,operation:'exchange',generation:stopped.generation,output_ack:stopped.outputAck};
 const last=stopped.evidence.records.at(-1),inputBefore=fs.readFileSync(path.join(dir,'input.bin'));
 const duplicate=await engine({...common,input:last});assert.equal(duplicate.input_ack,last.sequence);assert(!duplicate.error);
 const altered=await engine({...common,input:{...last,bytes:[88]}});assert.match(altered.error,/retry changed/);
 const gap=await engine({...common,input:{sequence:last.sequence+2,bytes:[88]}});assert.match(gap.error,/sequence gap/);
 const stale=await engine({...common,generation:stopped.generation-1,input:{sequence:last.sequence+1,bytes:[88]}});assert.match(stale.error,/stale transport/);
 const staleResume=await engine({...common,operation:'resume',generation:stopped.generation-1,resume_id:crypto.randomUUID()});assert.match(staleResume.error,/stale resume/);
 const unknown=await engine({viewer:crypto.randomUUID(),operation:'resume',generation:1,resume_id:crypto.randomUUID(),output_ack:0});assert.match(unknown.error,/unknown viewer/);
 await sleep(50);assert.deepEqual(fs.readFileSync(path.join(dir,'input.bin')),inputBefore,'rejected/retried input reached fixture');
 const overflowViewer=crypto.randomUUID();await engine({viewer:overflowViewer,operation:'open',pane,rows:30,cols:100,replay_limit:128});
 await waitFor(async()=>{const r=await engine({viewer:overflowViewer,operation:'exchange',generation:1,output_ack:0});return /replay exhausted/.test(r.error||'')},'replay overflow was not explicit');
 const report={latency_limit_ms:latencyLimitMs,engine_pid:endpoint.engine_pid,fixture_pid:fixturePid,bridges:[first.pid,lostResume.pid,second.pid,rollback.pid],accepted_records:state.evidence.acks.length,input_bytes:state.evidence.bytes.length,output_records_checked:emitted.length,max_input_ack_ms:Math.ceil(state.evidence.maxAckMs),max_input_delivery_ms:Math.ceil(maxInputMs),max_output_delivery_ms:Math.ceil(maxOutputMs),faults,platform:process.platform};
 fs.writeFileSync(path.join(dir,'proof.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));console.log('Proof artifacts: '+dir);
}finally{
 if(page){try{fs.writeFileSync(path.join(dir,'browser-final.json'),JSON.stringify(await page.evaluate(()=>proofState()),null,2))}catch{}}
 if(browser)await browser.close();for(const child of children){if(child.exitCode===null)child.kill()}
 if(server)await new Promise(r=>server.close(r));
 if(created){try{cli('kill-session',name);fs.rmSync(endpointFile,{force:true})}catch(e){console.error('Private session cleanup:',e.message)}}
}})().catch(e=>{console.error(e);console.error('Proof artifacts: '+dir);process.exitCode=1});
