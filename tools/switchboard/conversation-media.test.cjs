const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
test('Markdown media uses the owning host, expands galleries, and blocks active content',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),requests=[];
 const server=http.createServer((req,res)=>{requests.push(req.url);if(req.url.startsWith('/api/hosts/')){if(req.url.includes('missing')){res.writeHead(404);return res.end();}res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#468"/></svg>');}
 if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><div class="conversation-panel"><article class="conversation-message" id="message"></article></div><script src="/conversation-media.js"></script>');}
 const file=path.join(__dirname,'static',path.basename(req.url));res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/css');res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>{
 const events=[{type:'start',tag:'strong'},{type:'text',text:'Screenshots'},{type:'end'},...['out/first.png','C:\\repo\\second.png','out/missing.png'].flatMap(url=>[{type:'start',tag:'image',url},{type:'text',text:url},{type:'end'}]),{type:'start',tag:'a',url:'out/demo.mp4'},{type:'text',text:'Demo video'},{type:'end'},{type:'start',tag:'a',url:'javascript:alert(1)'},{type:'text',text:'Bad link'},{type:'end'},{type:'text',text:'<img src=x onerror="window.injected=1">'}];
 SwitchboardConversationMedia.render(document.getElementById('message'),{markdown:events,attachments:[{name:'Missing attachment',unavailable:'Not retained'}]},{host:'ubuntu',project:'/repo'});
 });
 await page.locator('img').first().waitFor();await page.waitForFunction(()=>document.querySelector('img').naturalWidth===320);
 assert.ok(requests.some(url=>url.includes('/api/hosts/ubuntu/file?path=%2Frepo%2Fout%2Ffirst.png')));
 assert.ok(requests.some(url=>url.includes('path=C%3A%2Frepo%2Fsecond.png')));
 assert.equal(await page.locator('video').getAttribute('controls'),'');assert.equal(await page.locator('video').getAttribute('playsinline'),'');
 assert.equal(await page.locator('a[href^="javascript:"]').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
 assert.equal(await page.evaluate(()=>SwitchboardConversationMedia.resolve('http://localhost:8000/shot.png',{host:'ubuntu',project:'/repo'})),null);
 assert.equal(await page.evaluate(()=>SwitchboardConversationMedia.resolve('//evil.example/shot.png',{host:'ubuntu',project:'/repo'})),null);
 assert.equal(await page.evaluate(()=>SwitchboardConversationMedia.resolve('data:image/svg+xml;base64,AAAA',{host:'ubuntu',project:'/repo'},true)),null);
 await page.getByRole('button',{name:'Preview out/first.png',exact:true}).click();await page.getByRole('dialog').waitFor();
 await page.getByRole('button',{name:'Zoom in',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Fit image'}).count(),1);
 await page.evaluate(()=>{window.staleError=document.querySelector('.conversation-media-stage img').onerror;});
 await page.getByRole('button',{name:'Next →'}).click();
 await page.evaluate(()=>staleError());assert.equal(await page.locator('.conversation-media-stage img').count(),1);assert.match(await page.locator('.conversation-media-dialog header span').textContent(),/2 \/ 4/);
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.waitForFunction(()=>document.querySelector('[aria-label="Preview out/missing.png"]').textContent==='Image unavailable');
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
