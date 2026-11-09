const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const FIXTURE='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><div class="conversation-panel"><div class="conversation-messages" style="height:100vh;overflow:auto"><div id="message" style="width:min(760px,100%)"></div></div></div><script src="/conversation-media.js"></script><script src="/conversation-html.js"></script>';
const SVG='<style>svg{width:100%;height:auto}.b{fill:var(--card);stroke:var(--destructive)}text{fill:var(--foreground)}</style><svg viewBox="0 0 700 300"><rect class="b" width="700" height="300"/><text x="20" y="40">Relay</text></svg>';
const HOSTILE=`<img src="/attack-img"><link rel="stylesheet" href="/attack-css"><script src="/attack-script"></script><script>parent.document.title='pwned';fetch('/attack-fetch')</script><meta http-equiv="refresh" content="0;url=/attack-refresh">
<a id="link" style="display:block;width:300px;height:60px" href="/attack-link">go</a>
<svg width="300" height="60" style="display:block"><a href="/attack-svg" xlink:href="/attack-svg"><rect width="300" height="60"/></a></svg>
<svg width="300" height="60" style="display:block"><a><animate attributeName="href" to="/attack-animate" fill="freeze"/><rect width="300" height="60"/></a></svg>
<link rel="dns-prefetch" href="https://attacker.example/"><math href="/attack-math" style="display:block;font-size:40px"><mtext>go</mtext></math>
<div id="host"><template shadowrootmode="open"><a id="inner" style="display:block;width:300px;height:40px" href="/attack-shadow">go</a></template></div>`;
const artifact=name=>`/Users/me/.switchboard/artifacts/${name}/page.html`;
async function open(browser,pages,options={}){
 const origin=options.origin||'http://html.test',page=await browser.newPage({viewport:{width:options.width||900,height:options.height||800}}),requests=[];page.setDefaultTimeout(20000);
 await page.context().route(origin+'/**',route=>{
  const url=new URL(route.request().url()),{pathname}=url;
  if(pathname==='/')return route.fulfill({contentType:'text/html',body:FIXTURE});
  if(/\.(?:js|css|woff2)$/.test(pathname))return route.fulfill({path:path.join(__dirname,'static',path.basename(pathname))});
  requests.push(pathname);
  if(pathname.endsWith('/html'))return route.fulfill({json:{url:origin+'/opened'}});
  if(pathname.endsWith('/file')){const body=pages[url.searchParams.get('path').split('/').at(-2)];return body===undefined?route.fulfill({status:404,body:'gone'}):route.fulfill({contentType:'text/html',body});}
  return route.fulfill({body:'x'});
 });
 await page.goto(origin+'/');
 await page.evaluate(()=>{window.say=text=>{const box=document.createElement('p');document.getElementById('message').append(box);SwitchboardConversationMedia.render(box,{text},{host:'mac'});};});
 return {page,requests};
}
const attacks=requests=>requests.filter(url=>!url.endsWith('/file'));
const browse=async run=>{const module=require(process.env.PLAYWRIGHT_MODULE),browser=await module[process.env.PLAYWRIGHT_BROWSER||'chromium'].launch();try{await run(browser);}finally{await browser.close();}};
const skip=!process.env.PLAYWRIGHT_MODULE;
const frameOf=async page=>{await page.waitForFunction(()=>document.querySelector('.conversation-html iframe'));return page.waitForFunction(()=>true).then(()=>page.frames().find(f=>f!==page.mainFrame()));};

test('a published diagram draws in the transcript with the theme, at its own shape',{skip},()=>browse(async browser=>{
 const {page}=await open(browser,{arch:SVG});
 await page.evaluate(path=>say(path),artifact('arch'));
 const frame=await frameOf(page);await frame.waitForSelector('svg',{state:'attached'});
 assert.equal(await page.locator('.conversation-html iframe').getAttribute('sandbox'),'');
 assert.equal(await page.locator('.conversation-html-body').evaluate(node=>getComputedStyle(node.firstChild).visibility),'visible');
 const box=await page.locator('.conversation-html iframe').boundingBox();
 assert.ok(box.width>700);assert.ok(Math.abs(box.height-box.width*3/7)<2,`${box.width}x${box.height}`);
 const style=await frame.evaluate(()=>{const rect=getComputedStyle(document.querySelector('.b'));return {fill:rect.fill,stroke:rect.stroke,overflow:document.documentElement.scrollHeight-innerHeight};});
 assert.deepEqual(style,{fill:'rgb(22, 23, 26)',stroke:'rgb(248, 113, 113)',overflow:0});
 assert.match(await page.locator('.conversation-html .conversation-code-bar').innerText(),/page\.html/);
 if(process.env.CARD_SCREENSHOT)await page.screenshot({path:process.env.CARD_SCREENSHOT});
}));

test('a hostile page runs nothing, loads nothing and cannot navigate its frame',{skip},()=>browse(async browser=>{
 const {page,requests}=await open(browser,{evil:HOSTILE});
 await page.evaluate(path=>say(path),artifact('evil'));
 const frame=await frameOf(page);await frame.waitForSelector('#link',{state:'attached'});
 await page.waitForTimeout(600);
 const box=await page.locator('.conversation-html iframe').boundingBox();
 for(const y of [30,90,150]){await page.mouse.click(box.x+50,box.y+y);await page.waitForTimeout(150);}
 const math=await frame.evaluate(()=>{const box=document.querySelector('math').getBoundingClientRect();return {x:box.x+5,y:box.y+box.height/2};});
 await page.mouse.click(box.x+math.x,box.y+math.y);
 const shadow=await frame.evaluate(()=>{const area=document.querySelector('#host').getBoundingClientRect();return {x:area.x+5,y:area.y+area.height/2};});
 await page.mouse.click(box.x+shadow.x,box.y+shadow.y);
 for(let i=0;i<6;i++){await page.keyboard.press('Tab');await page.keyboard.press('Enter');}
 await page.waitForTimeout(300);
 assert.deepEqual(attacks(requests),[]);
 assert.equal(await frame.evaluate(()=>document.querySelectorAll('link,template').length+(document.querySelector('#host').shadowRoot?1:0)),0,'Resource hints are outside the policy, even in a shadow root');
 assert.equal(await page.title(),'');
 assert.equal(frame.url(),'about:srcdoc');
 // The same content without the card's protections does reach the network, so the count means something.
 await page.evaluate(()=>{const control=document.createElement('iframe');control.setAttribute('sandbox','');control.srcdoc='<img src="/control-img">';document.body.append(control);});
 await page.waitForTimeout(400);assert.deepEqual(attacks(requests),['/control-img']);
}));

test('only published pages become cards, and failures say so',{skip},()=>browse(async browser=>{
 const {page,requests}=await open(browser,{big:'x'.repeat(2*1024*1024+1)});
 await page.evaluate(()=>say('/Users/me/project/page.html'));
 assert.equal(await page.locator('.conversation-html').count(),0);
 assert.deepEqual(requests,[]);
 await page.evaluate(path=>say(path),artifact('big'));
 await page.getByText('too large to show here').waitFor();
 await page.evaluate(path=>say(path),artifact('missing'));
 await page.getByText('HTML page unavailable').waitFor();
 assert.equal(await page.locator('.conversation-html iframe').count(),0);
}));

test('frames are capped and leave the page once far from view, keeping their space',{skip},()=>browse(async browser=>{
 const names=['a','b','c','d','e'],pages=Object.fromEntries(names.map(name=>[name,SVG]));
 const {page}=await open(browser,pages,{height:2600});
 await page.evaluate(paths=>paths.forEach(say),names.map(artifact));
 await page.waitForFunction(()=>document.querySelectorAll('.conversation-html iframe').length===3);
 await page.waitForTimeout(500);
 assert.equal(await page.locator('.conversation-html iframe').count(),3);
 await page.setViewportSize({width:900,height:400});
 await page.evaluate(()=>{const message=document.getElementById('message');message.style.paddingBottom='9000px';document.querySelector('.conversation-messages').scrollTop=7000;});
 await page.waitForFunction(()=>document.querySelectorAll('.conversation-html iframe').length===0);
 const heights=await page.locator('.conversation-html-body').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
 assert.ok(heights.every(height=>height>300),String(heights));
}));

test('a nearby card left out by the cap appears when it comes into view',{skip},()=>browse(async browser=>{
 const names=['a','b','c','d','e'],pages=Object.fromEntries(names.map(name=>[name,SVG]));
 const {page}=await open(browser,pages,{height:400});
 await page.evaluate(paths=>paths.forEach(say),names.map(artifact));
 // Chromium clips the early-loading band at the panel, so only the first cards may have frames here.
 await page.waitForFunction(()=>document.querySelectorAll('.conversation-html iframe').length>=2);
 await page.waitForTimeout(400);
 const fourth=page.locator('.conversation-html').nth(3);
 assert.equal(await fourth.locator('iframe').count(),0,'The cap or the distance keeps the fourth card empty');
 await fourth.evaluate(node=>node.scrollIntoView());
 await fourth.locator('iframe').waitFor({state:'attached',timeout:3000});
 assert.ok(await page.locator('.conversation-html iframe').count()<=3);
}));

test('a phone fits the card and gets no Open button for an origin it cannot reach',{skip},()=>browse(async browser=>{
 const fixed='<svg width="700" height="300" viewBox="0 0 700 300"><rect width="700" height="300"/></svg>';
 const {page}=await open(browser,{arch:fixed},{width:360,height:700});
 await page.evaluate(path=>say(path),artifact('arch'));
 const frame=await frameOf(page);await frame.waitForSelector('svg',{state:'attached'});
 assert.equal(await frame.evaluate(()=>document.querySelector('svg').getBoundingClientRect().width===innerWidth),true,'A fixed-size diagram scales to the card');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.getByRole('button',{name:/^Open/}).count(),0);
}));

test('Open hands the page to the isolated preview on this computer',{skip},()=>browse(async browser=>{
 const {page,requests}=await open(browser,{arch:SVG},{origin:'http://localhost:8199'});let posted;
 page.on('request',request=>{if(request.method()==='POST')posted=request.postDataJSON();});
 await page.evaluate(path=>say(path),artifact('arch'));
 const [tab]=await Promise.all([page.waitForEvent('popup'),page.getByRole('button',{name:'Open page.html'}).click()]);
 await tab.waitForURL('**/opened');
 assert.deepEqual(posted,{path:artifact('arch')});
 assert.ok(requests.includes('/api/hosts/mac/html'));
}));
