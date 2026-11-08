const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('uploaded images remain expandable previews while sending, after acknowledgement and in history',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const root='/home/fixture/.local/share/switchboard/attachments/11111111-2222-4333-8444-555555555555/',image=root+'screenshot.svg',document=root+'notes.txt';
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" fill="#364d70"/><text x="40" y="130" fill="white" font-size="32">Screenshot fixture</text></svg>';
 const portrait=svg.replace('width="640" height="240"','width="240" height="640"');
 const history=[],requests=[],files=[],errors=[];let hold=true,held;
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{revoked.push(url);revoke(url);};});
  await page.route('http://preview.test/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname;
   if(p.endsWith('/codex/reply')){requests.push(route.request().postDataJSON());if(hold)await new Promise(resolve=>held=resolve);return route.fulfill({json:{status:'queued'}});}
   if(p.endsWith('/attachments'))return route.fulfill({json:{path:root+url.searchParams.get('name')}});
   if(p.endsWith('/file')){files.push({host:p,path:url.searchParams.get('path')});return route.fulfill({contentType:'image/svg+xml',body:url.searchParams.get('path').endsWith('portrait.svg')?portrait:svg});}
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{session_id:'00000000-0000-4000-8000-000000000001',messages:history,start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{height:100dvh;position:relative}</style><main id="terminals"><section id="artifact-preview" hidden></section></main><script src="/conversation-media.js"></script><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'peer',pane:1,agent:'codex',state:'working',chatId:'chat-1'};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://preview.test/');await page.getByLabel('Reply draft').waitFor();
  const upload=async files=>{const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Attach files',exact:true}).click();await (await choosing).setFiles(files);await page.waitForFunction(()=>[...document.querySelectorAll('.conversation-attachment small')].every(node=>node.textContent==='Ready'));};
  const poll=async()=>{await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);};
  await upload([{name:'screenshot.svg',mimeType:'image/svg+xml',buffer:Buffer.from(svg)},{name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('Notes')}]);
  const blob=await page.locator('.conversation-attachment img').getAttribute('src');
  await page.getByLabel('Reply draft').fill('Please inspect this screenshot.');await page.getByRole('button',{name:'Send',exact:true}).click();
  const outgoing=page.locator('.conversation-outgoing'),preview=outgoing.getByRole('button',{name:'Preview screenshot.svg',exact:true});
  await preview.waitFor();await page.waitForFunction(()=>document.querySelector('.conversation-outgoing img')?.naturalWidth===640);
  assert.ok(files.some(file=>file.host==='/api/hosts/peer/file'&&file.path===image),'The preview loads from the conversation computer');
  assert.equal(await outgoing.locator('.conversation-outgoing-file').count(),1,'Only the text file uses a file card');
  assert.equal(await outgoing.locator('.conversation-media-caption').isVisible(),false,'No duplicate filename or open link below the image');
  await preview.click();await page.getByRole('dialog',{name:'Media viewer'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.conversation-media-stage img')?.naturalWidth===640);
  assert.match(await page.getByRole('link',{name:'Open original',exact:true}).getAttribute('href'),/hosts\/peer\/file/);
  await page.getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await page.getByLabel('Reply draft').inputValue(),'','The draft empties as soon as it is sent');
  hold=false;held();await page.waitForFunction(blob=>revoked.includes(blob),blob);
  assert.equal(await page.evaluate(blob=>revoked.includes(blob),blob),true,'The composer releases its local object URL');
  assert.equal(await preview.locator('img').evaluate(img=>img.naturalWidth),640,'The sent preview survives that release');
  for(const width of [360,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);const outer=await outgoing.boundingBox(),inner=await preview.boundingBox();assert.ok(inner.x>=outer.x&&inner.x+inner.width<=outer.x+outer.width);}
  history.push({role:'user',text:requests[0].message,markdown:[{type:'start',tag:'p'},{type:'text',text:'Please inspect this screenshot.'},{type:'end'}],attachments:[{kind:'image',name:'screenshot.svg',url:image},{kind:'file',name:'notes.txt',url:document}]});
  await poll();assert.equal(await outgoing.count(),0);assert.equal(await page.locator('.conversation-message.user img').count(),1);
  await page.getByRole('button',{name:'Preview screenshot.svg',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await page.getByText('Attached files:',{exact:false}).count(),0);assert.equal(await page.getByRole('link',{name:'notes.txt',exact:true}).count(),1);
  // An image-only message has a preview rather than an empty text/file card.
  await upload([{name:'portrait.svg',mimeType:'image/svg+xml',buffer:Buffer.from(portrait)}]);await page.getByRole('button',{name:'Send',exact:true}).click();
  await outgoing.locator('img').waitFor();assert.equal(await outgoing.locator('.conversation-outgoing-file').count(),0);assert.equal(await outgoing.locator('p').count(),0);
  await page.waitForFunction(()=>document.querySelector('.conversation-outgoing img')?.naturalHeight===640);
  const photo=await outgoing.locator('img').boundingBox(),bubble=await outgoing.boundingBox();
  assert.ok(Math.abs(photo.width/photo.height-240/640)<.01,'Portrait previews preserve their aspect ratio');
  assert.ok(photo.height<=320&&bubble.width-photo.width<45,'Image-only bubbles fit the preview without a large empty area');
  assert.deepEqual(errors,[]);
 }finally{held?.();await browser.close();}
});
