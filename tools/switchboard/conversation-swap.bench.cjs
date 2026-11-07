// Time the Terminal <-> Conversation swap on a long chat, using the shipped sidebar
// against fixtures. Never opens the live sidebar or a real terminal.
// Opt-in (not run in CI):
//   PLAYWRIGHT_MODULE=/path/to/playwright node tools/switchboard/conversation-swap.bench.cjs [options]
//   --messages N   messages in the transcript (default 2000)
//   --loaded N     messages loaded into the view before measuring, by scrolling up (default 400)
//   --swaps N      Terminal -> Conversation round trips to time (default 20)
//   --max-p95 MS   exit 1 when either direction's p95 exceeds MS
//   --json         print only the JSON result
//   --screenshot F save Conversation after the last round trip to F
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
if(!process.env.PLAYWRIGHT_MODULE){console.log('conversation-swap.bench.cjs: skipped (set PLAYWRIGHT_MODULE)');return;}
const total=Number(option('messages',2000)),wanted=Number(option('loaded',400)),swaps=Number(option('swaps',20)),maxP95=option('max-p95');
const stats=values=>{const s=[...values].sort((a,b)=>a-b),q=p=>s[Math.min(s.length-1,Math.floor(p*s.length))];return s.length?{n:s.length,p50:+q(0.5).toFixed(1),p95:+q(0.95).toFixed(1),max:+s.at(-1).toFixed(1)}:{n:0};};

// Deterministic transcript shaped like real agent work: short prompts, prose
// answers with lists and inline code, and occasional long tool output.
function transcript(count){
  let seed=1;const random=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
  const words='the relay sidebar terminal pane agent conversation renders cursor stream history message browser layout session tab focus resize'.split(' ');
  const sentence=n=>Array.from({length:n},()=>words[Math.floor(random()*words.length)]).join(' ')+'.';
  const paragraph=()=>Array.from({length:2+Math.floor(random()*4)},()=>sentence(8+Math.floor(random()*12))).join(' ');
  const messages=[];
  for(let i=0;i<count;i++){
    if(i%4===0){const text=paragraph();messages.push({role:'user',text,timestamp:'2026-11-07T00:00:00Z'});continue;}
    const markdown=[],text=[];
    for(let p=0;p<1+Math.floor(random()*4);p++){
      const body=paragraph();text.push(body);
      markdown.push({type:'start',tag:'p'},{type:'text',text:body.slice(0,body.length>>1)},{type:'code',text:'conversation.js'},{type:'text',text:body.slice(body.length>>1)},{type:'end'});
    }
    if(random()<0.5){markdown.push({type:'start',tag:'ul',start:null});for(let n=0;n<3;n++)markdown.push({type:'start',tag:'li'},{type:'text',text:sentence(10)},{type:'end'});markdown.push({type:'end'});}
    if(random()<0.25){
      const lines=Array.from({length:20+Math.floor(random()*(random()<0.2?400:60))},(_,n)=>`${String(n).padStart(4)}  ${sentence(9)}`).join('\n');
      markdown.push({type:'start',tag:'pre'},{type:'text',text:lines},{type:'end'});text.push('```\n'+lines+'\n```');
    }
    messages.push({role:'assistant',phase:random()<0.3?'commentary':'final_answer',model:'claude-opus-5-5',text:text.join('\n\n'),markdown,timestamp:'2026-11-07T00:00:00Z'});
  }
  return messages;
}

(async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch();
  const history=transcript(total);
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(30000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // Polls run only when the benchmark fires them, so they never land inside a timed swap.
  await page.addInitScript(()=>{localStorage.setItem('switchboard-view-mode','conversation');window.benchIntervals=[];window.setInterval=fn=>{benchIntervals.push(fn);return benchIntervals.length;};});
  const pane={pane_id:1,is_plugin:false,tab_id:1,tab_position:0,title:'Long chat',is_focused:true};
  // A stand-in terminal: a full screen of text that counts the viewport changes
  // a real terminal would answer with a refit and a server resize.
  const terminal=`<!doctype html><style>body{margin:0;background:#000;color:#ccc;font:13px monospace;white-space:pre}</style><body><script>
    const active=${JSON.stringify(pane)};
    document.body.textContent=Array.from({length:60},(_,n)=>String(n).padStart(3)+' '+'terminal output '.repeat(14)).join('\\n');
    window.benchResizes=[];addEventListener('resize',()=>benchResizes.push(innerWidth+'x'+innerHeight));
    const state=id=>parent.postMessage({type:'zellij-state',focus_id:id,payload:{session_name:'main',active_pane:active,panes:[active],tab_viewport:{hidden:true}}},location.origin);
    addEventListener('message',event=>{if(event.data?.type==='zellij-focus-tab')state(event.data.id);});
    window.__zjSuspendTerminal=async()=>false;state(null);
  </script>`;
  await page.route('http://conversation-bench.test/**',async route=>{
    const url=new URL(route.request().url()),p=url.pathname,json=value=>route.fulfill({json:value}).catch(()=>{});
    if(p==='/api/mesh')return json({members:[]});
    if(p==='/api/hosts')return json([{id:'fixture',name:'Fixture desktop',local:true}]);
    if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Fixture desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
    if(p==='/api/attention')return json({tabs:[{host:'fixture',session:'main',id:1,position:0,name:'Long chat',panes:[pane]}],panes:[{host:'fixture',session:'main',pane_id:1,agent:'claude',state:'ready',chat_id:'chat-1'}]});
    if(p.startsWith('/api/chats/')){
      const q=url.searchParams,limit=Math.min(50,Number(q.get('limit')||10));
      const start=q.get('tail')?Math.max(0,total-limit):q.has('before')?Math.max(0,Number(q.get('before'))-limit):Math.min(total,Number(q.get('cursor')));
      const end=q.has('before')?Number(q.get('before')):Math.min(total,start+limit);
      return json({id:'chat-1',agent:'claude',model:'claude-opus-5-5',session_id:null,messages:history.slice(start,end),start_cursor:start,next_cursor:end<total?end:null,stream:false});
    }
    if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:terminal});
    if(p.startsWith('/api/'))return json({});
    const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
    return fs.existsSync(file)?route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
  });
  await page.goto('http://conversation-bench.test/?host=fixture&session=main&tab=1',{waitUntil:'domcontentloaded'});
  const button=name=>page.getByRole('button',{name,exact:true});
  const settled=()=>page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);
  await page.locator('.conversation-message').first().waitFor();await settled();

  // Read back through the chat the way a person would: scroll to the top and
  // let Conversation fetch each older page.
  for(let previous=-1;;){
    const count=await page.locator('.conversation-message').count();
    if(count>=wanted||count===previous)break;previous=count;
    await page.evaluate(()=>{const list=document.querySelector('.conversation-messages');list.scrollTop=0;list.dispatchEvent(new Event('scroll'));});
    await page.waitForFunction(count=>document.querySelectorAll('.conversation-message').length>count,count,{timeout:3000}).catch(()=>{});
    await settled();
  }
  await page.evaluate(()=>{const list=document.querySelector('.conversation-messages');list.scrollTop=list.scrollHeight;});
  // Terminal stays connected through Conversation on desktop only after it has
  // been shown once, so start the round trips from Terminal.
  await button('Terminal').click();
  await page.waitForFunction(()=>[...sessions.values()].every(entry=>entry.state&&!entry.suspended));
  const loaded=await page.locator('.conversation-message').count(),domNodes=await page.evaluate(()=>document.querySelector('.conversation-messages').getElementsByTagName('*').length);

  const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
  const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  const phases=['LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration'];
  const timing={toConversation:[],toTerminal:[],poll:[]},work={toConversation:{},toTerminal:{},poll:{}};
  const add=(kind,before,after)=>{for(const name of phases)(work[kind][name]??=[]).push((after[name]-before[name])*1000);};
  // Time from the click to the frame after it has painted.
  const swap=name=>page.evaluate(name=>new Promise(resolve=>{
    const control=[...document.querySelectorAll('.conversation-modes button')].find(node=>node.textContent===name),start=performance.now();
    control.click();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));
  }),name);
  const frameResizes=()=>page.evaluate(()=>[...sessions.values()][0].frame.contentWindow.benchResizes.length);
  const resizesBefore=await frameResizes();
  for(let n=0;n<swaps;n++){
    for(const [name,kind] of [['Conversation','toConversation'],['Terminal','toTerminal']]){
      const before=await metrics();timing[kind].push(await swap(name));
      // Let the load and the observers the swap started finish before reading metrics.
      await settled();await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));add(kind,before,await metrics());
    }
  }
  const resizes=await frameResizes()-resizesBefore;
  if(option('screenshot')){await button('Conversation').click();await settled();await page.screenshot({path:option('screenshot')});await button('Terminal').click();await settled();}
  // A background poll while reading: the transcript has not changed.
  await button('Conversation').click();await settled();
  for(let n=0;n<swaps;n++){
    const before=await metrics();
    const elapsed=await page.evaluate(()=>new Promise(resolve=>{const start=performance.now();benchIntervals.forEach(fn=>fn());const wait=()=>document.querySelector('[aria-label="Refresh"]').disabled?setTimeout(wait,0):resolve(performance.now()-start);setTimeout(wait,0);}));
    timing.poll.push(elapsed);add('poll',before,await metrics());
  }
  const result={messages:total,loaded,conversation_dom_nodes:domNodes,swaps,terminal_viewport_changes_per_round_trip:+(resizes/swaps).toFixed(2),
    ms:Object.fromEntries(Object.entries(timing).map(([kind,values])=>[kind,stats(values)])),
    main_thread_ms_p50:Object.fromEntries(Object.entries(work).map(([kind,byPhase])=>[kind,Object.fromEntries(Object.entries(byPhase).map(([name,values])=>[name.replace('Duration',''),stats(values).p50]))])),
    errors};
  console.log(args.includes('--json')?JSON.stringify(result):JSON.stringify(result,null,2));
  await browser.close();
  if(errors.length)process.exitCode=1;
  if(maxP95&&Math.max(result.ms.toConversation.p95,result.ms.toTerminal.p95)>Number(maxP95)){console.error(`p95 swap exceeds ${maxP95} ms`);process.exitCode=1;}
})().catch(error=>{console.error(error);process.exitCode=1;});
