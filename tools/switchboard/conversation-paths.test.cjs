const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
test('A line that is only an image or video path shows the media; paths inside sentences stay text',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),requests=[];
 const server=http.createServer((req,res)=>{requests.push(req.url);if(req.url.startsWith('/api/hosts/')){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#468"/></svg>');}
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><div class="conversation-panel"><article class="conversation-message" id="message"></article></div><script src="/conversation-media.js"></script>');}
  const file=path.join(__dirname,'static',path.basename(req.url));res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/css');res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(7000);await page.goto(`http://127.0.0.1:${server.address().port}`);
  // The relay sends a soft line break as its own text event, so a path on its own line is one event.
  await page.evaluate(()=>SwitchboardConversationMedia.render(document.getElementById('message'),{markdown:[
   {type:'start',tag:'p'},{type:'text',text:'Before:'},{type:'text',text:'\n'},{type:'text',text:'C:\\Users\\me\\shots\\before.png'},{type:'end'},
   {type:'start',tag:'p'},{type:'text',text:'/home/me/demo.mp4'},{type:'end'},
   {type:'start',tag:'p'},{type:'text',text:'I saved C:\\Users\\me\\inline.png for later.'},{type:'end'},
   {type:'start',tag:'p'},{type:'text',text:'relative/shot.png'},{type:'end'},
   // Fragments of one line: the path follows bold text, so it stays text.
   {type:'start',tag:'p'},{type:'text',text:'See '},{type:'start',tag:'strong'},{type:'text',text:'this'},{type:'end'},{type:'text',text:' /tmp/result.png'},{type:'end'}]},{host:'windows',project:'C:\\repo'}));
  await page.locator('img').first().waitFor();
  assert.equal(await page.locator('img').count(),1);assert.equal(await page.locator('video').count(),1);
  assert.ok(requests.some(url=>url.includes('/api/hosts/windows/file?path=C%3A%2FUsers%2Fme%2Fshots%2Fbefore.png')));
  assert.equal(await page.getByRole('button',{name:'Preview before.png',exact:true}).count(),1);
  assert.match(await page.locator('#message').textContent(),/I saved C:\\Users\\me\\inline\.png for later\./);
  assert.match(await page.locator('#message').textContent(),/relative\/shot\.png/);
  assert.match(await page.locator('#message').textContent(),/See this \/tmp\/result\.png/);
 }finally{await browser.close();server.close();}
});
