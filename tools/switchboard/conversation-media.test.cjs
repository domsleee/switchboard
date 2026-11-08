const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
test('Markdown media uses the owning host, expands galleries, and blocks active content',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),requests=[];
 const server=http.createServer((req,res)=>{requests.push(req.url);if(req.url.startsWith('/api/hosts/')){if(req.url.includes('missing')){res.writeHead(404);return res.end();}res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#468"/></svg>');}
 if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><div class="conversation-panel"><article class="conversation-message" id="message"></article></div><script src="/conversation-media.js"></script>');}
 const file=path.join(__dirname,'static',path.basename(req.url));res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/css');res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.evaluate(()=>{
 const events=[{type:'start',tag:'strong'},{type:'text',text:'Screenshots'},{type:'end'},...['out/first.png','C:\\repo\\second.png','out/missing.png'].flatMap(url=>[{type:'start',tag:'image',url},{type:'text',text:url},{type:'end'}]),{type:'start',tag:'a',url:'out/demo.mp4'},{type:'text',text:'Demo video'},{type:'end'},{type:'start',tag:'a',url:'javascript:alert(1)'},{type:'text',text:'Bad link'},{type:'end'},{type:'text',text:'<img src=x onerror="window.injected=1">'}];
 SwitchboardConversationMedia.render(document.getElementById('message'),{markdown:events,attachments:[{name:'Missing attachment',unavailable:'Not retained'}]},{host:'ubuntu',project:'/repo'});
 });
 await page.locator('img').first().waitFor();await page.waitForFunction(()=>document.querySelector('img').naturalWidth===320);
 const first=page.locator('.conversation-media').first();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Preview out/missing.png"]').textContent==='Image unavailable');
 for(const width of [390,1280]){
  await page.setViewportSize({width,height:844});
  assert.equal(await first.locator('.conversation-media-caption').isVisible(),false,'Loaded images have no filename beneath them');
  assert.equal(await first.getByRole('link',{name:'Open original',exact:true}).isVisible(),false,'Loaded images have no original-file link beneath them');
  assert.equal(await page.getByRole('button',{name:'Preview out/missing.png',exact:true}).locator('..').getByRole('link',{name:'Open original',exact:true}).isVisible(),true,'Failed images retain their recovery link');
 }
 await page.setViewportSize({width:390,height:844});
 assert.ok(requests.some(url=>url.includes('/api/hosts/ubuntu/file?path=%2Frepo%2Fout%2Ffirst.png')));
 assert.ok(requests.some(url=>url.includes('path=C%3A%2Frepo%2Fsecond.png')));
 assert.equal(await page.locator('video').getAttribute('controls'),'');assert.equal(await page.locator('video').getAttribute('playsinline'),'');
 assert.equal(await page.locator('a[href^="javascript:"]').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
 assert.equal(await page.evaluate(()=>SwitchboardConversationMedia.resolve('http://localhost:8000/shot.png',{host:'ubuntu',project:'/repo'})),null);
 assert.equal(await page.evaluate(()=>SwitchboardConversationMedia.resolve('//evil.example/shot.png',{host:'ubuntu',project:'/repo'})),null);
 assert.equal(await page.evaluate(()=>SwitchboardConversationMedia.resolve('data:image/svg+xml;base64,AAAA',{host:'ubuntu',project:'/repo'},true)),null);
 await page.getByRole('button',{name:'Preview out/first.png',exact:true}).click();await page.getByRole('dialog').waitFor();
 assert.deepEqual(await page.locator('.conversation-media-dialog').evaluate(node=>{const box=node.getBoundingClientRect(),style=getComputedStyle(node);return [box.x,box.y,box.width,box.height,style.borderTopWidth,style.paddingTop];}),[0,0,390,844,'0px','0px'],'The viewer fills the screen with no frame, despite style.css dialog rules');
 await page.getByRole('button',{name:'Zoom in',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Fit image'}).count(),1);
 await page.evaluate(()=>{window.staleError=document.querySelector('.conversation-media-stage img').onerror;});
 await page.keyboard.press('ArrowRight');
 const counter=page.locator('.conversation-media-dialog header span');
 await page.evaluate(()=>staleError());assert.equal(await page.locator('.conversation-media-stage img').count(),1);assert.match(await counter.textContent(),/2 \/ 4/);
 assert.equal(await page.getByRole('button',{name:'Zoom in',exact:true}).count(),1,'Changing item fits the new image');
 await page.waitForFunction(()=>{const img=document.querySelector('.conversation-media-stage img');return img.naturalWidth===320&&!img.getAnimations().length;});
 const fitted=await page.locator('.conversation-media-stage img').boundingBox(),tray=await page.getByRole('navigation',{name:'Gallery'}).boundingBox();
 assert.ok(fitted.x>=0&&fitted.y>=0&&fitted.x+fitted.width<=390&&fitted.y+fitted.height<=tray.y,'The fitted image is whole on screen, above the thumbnail tray');
 assert.equal(fitted.width,320,'A phone gives the image the full width, not desktop side margins');
 await page.getByRole('button',{name:'Show out/first.png',exact:true}).click();assert.match(await counter.textContent(),/1 \/ 4/);
 await page.getByRole('button',{name:'Next',exact:true}).click();assert.match(await counter.textContent(),/2 \/ 4/);
 await page.mouse.click(4,fitted.y+fitted.height/2);assert.equal(await page.getByRole('dialog').count(),0,'Clicking beside the image closes the viewer');
 await page.getByRole('button',{name:'Preview out/first.png',exact:true}).click();await page.getByRole('dialog').waitFor();
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.waitForFunction(()=>document.querySelector('[aria-label="Preview out/missing.png"]').textContent==='Image unavailable');
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('media reconciliation restores focus and unavailable user media keeps visible recovery links',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(7000);
  await page.route('http://media-recovery.test/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/file'))return url.searchParams.get('path').includes('missing')?route.fulfill({status:404,body:''}):route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#468"/></svg>'});
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><section class="conversation-panel" tabindex="-1"><div id="messages"></div><form class="conversation-compose"><textarea aria-label="Reply draft"></textarea></form></section><script src="/conversation-media.js"></script>'});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(url.pathname)),contentType:url.pathname.endsWith('.js')?'application/javascript':'text/css'});
  });
  await page.goto('http://media-recovery.test/');
  await page.evaluate(()=>{
   window.renderMessage=attachments=>{
    const article=document.createElement('article');article.className='conversation-message user';
    SwitchboardConversationMedia.render(article,{attachments},{host:'fixture',project:'/repo'});
    document.getElementById('messages').replaceChildren(article);
   };
   window.photo={kind:'image',name:'Screenshot',url:'/repo/screenshot.png'};renderMessage([photo]);
  });
  const preview=page.getByRole('button',{name:'Preview Screenshot',exact:true});
  await preview.click();await page.getByRole('dialog').waitFor();
  await page.evaluate(()=>renderMessage([photo]));
  await page.getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await preview.evaluate(node=>node===document.activeElement),true,'Acknowledged history replaces the thumbnail and receives focus when its viewer closes');
  await preview.click();await page.evaluate(()=>renderMessage([]));await page.keyboard.press('Escape');
  assert.equal(await page.getByLabel('Reply draft').evaluate(node=>node===document.activeElement),true,'When the thumbnail is gone, focus returns to the draft');
  await page.evaluate(()=>renderMessage([photo]));await preview.click();
  await page.evaluate(()=>{renderMessage([]);document.querySelector('.conversation-compose').hidden=true;});await page.keyboard.press('Escape');
  assert.equal(await page.locator('.conversation-panel').evaluate(node=>node===document.activeElement),true,'When the draft is hidden, the conversation panel receives focus');
  await page.evaluate(()=>renderMessage([{kind:'image',name:'Missing image',url:'/repo/missing.png'},{kind:'video',name:'Missing video',url:'/repo/missing.mp4'}]));
  await page.waitForFunction(()=>document.querySelectorAll('.conversation-media.failed').length===2);
  assert.equal(await page.getByRole('button',{name:'Preview Missing image',exact:true}).textContent(),'Image unavailable');
  assert.equal(await page.getByText('Missing video · Video unavailable',{exact:true}).isVisible(),true,'User-message caption styling must not hide video failure feedback');
  assert.equal(await page.getByRole('link',{name:'Open original',exact:true}).count(),2,'Failed user media keeps a visible original-file recovery link');
  for(const link of await page.getByRole('link',{name:'Open original',exact:true}).all())assert.equal(await link.isVisible(),true);
 }finally{await browser.close();}
});

test('the media viewer swipes between items, zooms on double-tap, and closes on a downward swipe',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});page.setDefaultTimeout(7000);
  await page.route('http://media-touch.test/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/file'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#468"/></svg>'});
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><div class="conversation-panel"><article class="conversation-message" id="message"></article></div><script src="/conversation-media.js"></script>'});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(url.pathname)),contentType:url.pathname.endsWith('.js')?'application/javascript':'text/css'});
  });
  await page.goto('http://media-touch.test/');
  await page.evaluate(()=>SwitchboardConversationMedia.render(document.getElementById('message'),{markdown:['a.png','b.png'].flatMap(url=>[{type:'start',tag:'image',url},{type:'text',text:url},{type:'end'}])},{host:'h',project:'/repo'}));
  const cdp=await page.context().newCDPSession(page),touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y],id)=>({x,y,id}))});
  const swipe=async(from,to)=>{await touch('touchStart',[from]);for(let i=1;i<=8;i++)await touch('touchMove',[[from[0]+(to[0]-from[0])*i/8,from[1]+(to[1]-from[1])*i/8]]);await touch('touchEnd',[]);};
  const tap=async()=>{await touch('touchStart',[[195,420]]);await touch('touchEnd',[]);};
  const dialog=page.locator('.conversation-media-dialog'),counter=page.locator('.conversation-media-dialog header span');
  await page.getByRole('button',{name:'Preview a.png',exact:true}).tap();await page.getByRole('dialog').waitFor();
  await tap();await page.waitForFunction(()=>document.querySelector('.conversation-media-dialog').classList.contains('chrome-hidden'));
  await swipe([300,420],[80,420]);assert.equal(await counter.textContent(),'2 / 2','A leftward swipe shows the next item');
  assert.equal(await dialog.evaluate(node=>node.classList.contains('chrome-hidden')),false,'A new item shows the controls a tap had hidden');
  await tap();await tap();await page.waitForFunction(()=>document.querySelector('.conversation-media-dialog').classList.contains('zoomed'));
  await swipe([195,420],[300,420]);assert.equal(await counter.textContent(),'2 / 2','A zoomed image pans instead of changing item');
  await tap();await tap();await page.waitForFunction(()=>!document.querySelector('.conversation-media-dialog').classList.contains('zoomed'));
  assert.equal(await dialog.evaluate(node=>node.classList.contains('chrome-hidden')),false,'A double-tap does not also hide the controls');
  await swipe([195,420],[200,700]);assert.equal(await page.getByRole('dialog').count(),0,'A downward swipe closes the viewer');
 }finally{await browser.close();}
});
