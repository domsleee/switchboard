const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
test('conversation links stay pane-local, paginate, escape transcript HTML, and retain rejected drafts',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE);let queries=0;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(url.pathname==='/api/chats/search'){queries++;return json({computers:[{host:'mac',sources:[{agent:'codex',status:'partial',next_cursor:queries===1?100:null,results:[{id:'codex-one',title:'Actual chat',project:'/repo'}]}]}]});}
  if(url.pathname==='/api/chats/codex-one'){assert.equal(url.searchParams.get('host'),'mac');const cursor=Number(url.searchParams.get('cursor'));return json({title:'Actual chat',messages:cursor?[{role:'assistant',text:'Final answer'}]:[{role:'user',text:'<img src=x onerror="window.injected=true">'},{role:'assistant',phase:'commentary',text:'Working on it'}],next_cursor:cursor?null:2});}
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(`<link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100vh}</style><main id="terminals"><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>
  window.sent=[];window.returned=0;window.current={key:'pane1',host:'mac',pane:1,title:'Test agent',agent:'codex',frame:{contentWindow:{postMessage:data=>sent.push(data)}}};
  SwitchboardConversation.install({selection:()=>current,terminal:()=>returned++});
  </script>`);}
  const file=path.join(__dirname,'static',path.basename(url.pathname));res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'Conversation',exact:true}).click();await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByRole('button',{name:'Search next page'}).waitFor();assert.match(await page.locator('.conversation-notice').textContent(),/partial/);
 await page.getByRole('button',{name:'Search next page'}).click();await page.locator('.conversation-result').first().click();await page.locator('.conversation-message').first().waitFor();assert.equal(await page.locator('.conversation-message img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);assert.equal(await page.locator('details').count(),1);
 await page.getByRole('button',{name:'Load next messages'}).click();await page.getByText('Final answer',{exact:true}).waitFor();assert.equal(await page.locator('.conversation-message').count(),3);
 await page.getByLabel('Reply draft').fill('draft one');await page.getByRole('button',{name:'Reply in terminal'}).click();assert.equal(await page.evaluate(()=>sent[0].pane_id),1);
 await page.evaluate(()=>{const m=sent[0];window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:null,data:{type:'zellij-conversation-paste-result',id:m.id,ok:true}}));});assert.equal(await page.getByLabel('Reply draft').inputValue(),'draft one');
 await page.evaluate(()=>{current={...current,key:'pane2',pane:2};SwitchboardConversation.update();});assert.equal(await page.getByLabel('Reply draft').inputValue(),'');assert.equal(await page.locator('.conversation-message').count(),0);
 await page.evaluate(()=>{current={...current,key:'pane1',pane:1};SwitchboardConversation.update();});assert.equal(await page.getByLabel('Reply draft').inputValue(),'draft one');await page.locator('.conversation-message').first().waitFor();
 for(const viewport of [{width:360,height:800},{width:844,height:390}]){await page.setViewportSize(viewport);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.getByRole('button',{name:'Terminal',exact:true}).click();assert.equal(await page.evaluate(()=>returned),1);assert.deepEqual(errors,[]);
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
