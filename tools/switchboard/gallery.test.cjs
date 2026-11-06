const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const enabled=!!process.env.PLAYWRIGHT_MODULE;
const source=name=>fs.readFileSync(__dirname+'/static/'+name,'utf8');
const htmlPath='out/vh-20261106-162703/chart/index.html';
const rows=[`Interactive graph (${htmlPath})`,'/tmp/first.png','out/second.png','/tmp/first.png','/tmp/loop.gif'];
const art='http://127.0.0.1:8091/html/test-ticket/';
async function fixture(run){
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage(),calls=[],errors=[];
    page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url()),path=url.pathname;
      const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
      if(path.endsWith('/resolve-file')){
        calls.push(url.searchParams.get('path'));
        return json({path:'/home/dom/project/'+url.searchParams.get('path')});
      }
      if(path.endsWith('/html')){
        assert.equal(request.method(),'POST');calls.push(request.postDataJSON());
        return json({url:art+'index.html'});
      }
      if(path.endsWith('/file')){
        return route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"><rect width="900" height="500" fill="#1d3348"/><circle cx="450" cy="220" r="120" fill="#53c0b1"/><text x="450" y="410" fill="white" text-anchor="middle" font-size="26">${url.searchParams.get('path')}</text></svg>`});
      }
      if(request.url().startsWith(art)){
        if(path.endsWith('data.json'))return json({best:'46.358227'});
        if(path.endsWith('style.css'))return route.fulfill({contentType:'text/css',body:'body{background:rgb(12, 34, 56)}'});
        if(path.endsWith('chart.js'))return route.fulfill({contentType:'text/javascript',body:`fetch('data.json').then(r=>r.json()).then(data=>document.querySelector('#best').textContent=data.best);`});
        return route.fulfill({contentType:'text/html',headers:{'referrer-policy':'no-referrer'},body:'<link rel="stylesheet" href="style.css"><h1>VH improvements</h1><p id="best">Loading…</p><button onclick="this.textContent=\'Zoomed\'">Last 30 minutes</button><script src="chart.js"></script>'});
      }
      if(path==='/hosts/linux/main')return route.fulfill({contentType:'text/html',body:'<div id="terminal" tabindex="0" style="width:800px;height:400px">Terminal output</div>'});
      if(path==='/')return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><link rel="stylesheet" href="/gallery.css"><script src="/gallery.js"></script><iframe id="terminal-frame" src="/hosts/linux/main" style="width:100%;height:90vh"></iframe>'});
      if(['/gallery.js','/gallery.css'].includes(path))return route.fulfill({contentType:path.endsWith('css')?'text/css':'text/javascript',body:source(path.slice(1))});
      return route.fulfill({status:404,body:''});
    });
    await page.goto('http://switchboard.test/');
    const frame=page.frame({url:'http://switchboard.test/hosts/linux/main'});
    await frame.evaluate(rows=>{
      window.__switchboardLinkHosts={linux:{local:true,origin:'http://127.0.0.1:8082'}};
      window.term={cols:160,element:document.querySelector('#terminal'),options:{},
        buffer:{active:{length:rows.length,getLine:index=>rows[index]===undefined?undefined:{isWrapped:false,translateToString:()=>rows[index]}}},
        registerLinkProvider(provider){window.provider=provider;},
        _core:{_mouseService:{},linkifier:{_positionFromMouseEvent:()=>({x:3,y:1}),_currentLink:{link:{text:'',range:{start:{x:1,y:1},end:{x:150,y:1}}}}}}};
      parent.openedFiles=[];parent.SwitchboardOpenFile=(host,path)=>parent.openedFiles.push({host,path});
    },rows);
    await frame.addScriptTag({content:source('links.js')});
    await frame.waitForFunction(()=>window.provider);
    const click=async(path,modifier='Control')=>{
      await frame.evaluate(path=>{window.term._core.linkifier._currentLink.link.text=path;},path);
      await frame.locator('#terminal').focus();
      await frame.locator('#terminal').click({modifiers:[modifier],position:{x:20,y:20}});
    };
    await run({page,frame,context,click,calls});assert.deepEqual(errors,[]);
  }finally{await browser.close();}
}
test('Ctrl/Cmd-click on relative HTML opens an interactive page with sibling assets', {skip:!enabled},()=>fixture(async({context,click,calls,page})=>{
  for(const modifier of ['Control','Meta']){
    const popupReady=context.waitForEvent('page');await click(htmlPath,modifier);
    const popup=await popupReady;await popup.waitForURL(art+'index.html');
    await popup.waitForFunction(()=>document.querySelector('#best')?.textContent==='46.358227');
    assert.equal(await popup.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(12, 34, 56)');
    await popup.getByRole('button',{name:'Last 30 minutes'}).click();
    assert.equal(await popup.getByRole('button').textContent(),'Zoomed');
    assert.equal(await popup.evaluate(()=>window.opener),null);
    await popup.close();
  }
  assert.equal(calls.filter(call=>call===htmlPath).length,1,'Resolved relative paths are cached');
  assert.deepEqual(calls.filter(call=>typeof call==='object'),[{path:'/home/dom/project/'+htmlPath},{path:'/home/dom/project/'+htmlPath}]);
  assert.deepEqual(await page.evaluate(()=>window.openedFiles),[],'HTML stays in the viewing browser even for a local terminal');
}));
test('image clicks open a carousel with relative images, keys, wraparound, errors and focus restoration', {skip:!enabled},()=>fixture(async({page,frame,click,context})=>{
  await click('/tmp/first.png');
  const gallery=page.getByRole('dialog',{name:'Image carousel'}),image=gallery.locator('img');
  await gallery.waitFor();await page.waitForFunction(()=>document.querySelector('.gallery-count')?.textContent==='1 / 3');
  assert.equal(await image.getAttribute('alt'),'/tmp/first.png');
  await page.keyboard.press('ArrowRight');assert.equal(await image.getAttribute('alt'),'/home/dom/project/out/second.png');
  await gallery.getByRole('button',{name:'Next image'}).click();assert.equal(await image.getAttribute('alt'),'/tmp/loop.gif');
  await page.keyboard.press('ArrowRight');assert.equal(await image.getAttribute('alt'),'/tmp/first.png');
  await page.keyboard.press('ArrowLeft');assert.equal(await image.getAttribute('alt'),'/tmp/loop.gif');
  await page.keyboard.press('Home');await image.waitFor({state:'visible'});
  if(process.env.GALLERY_SCREENSHOT)await page.screenshot({path:process.env.GALLERY_SCREENSHOT});
  await page.keyboard.press('Escape');await gallery.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement.id==='terminal-frame');
  assert.equal(context.pages().length,1,'Images do not open extra browser tabs');
  // A plain thumbnail click follows the same path, with a single-image gallery when needed.
  await frame.evaluate(()=>window.__switchboardMedia.open('/tmp/only.png',{button:0}));
  await gallery.waitFor();await page.waitForFunction(()=>document.querySelector('.gallery-count')?.textContent==='4 / 4');
  await gallery.getByRole('button',{name:'Close image carousel'}).click();
  await page.route('**/api/hosts/linux/file?path=%2Ftmp%2Fmissing.png',route=>route.fulfill({status:404,body:''}));
  await page.evaluate(()=>window.SwitchboardOpenImages('linux','/tmp/missing.png'));
  await page.waitForFunction(()=>document.querySelector('#image-gallery [role="status"]').textContent.includes('Could not load'));
  assert.equal(await gallery.getByRole('button',{name:'Next image'}).isDisabled(),true);
}));
