const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('GitHub intent prefetch shares reads, expires, isolates hosts and survives navigation',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const reads=[],errors=[];let fail=false,release,delay=400;
 const baseline=!!process.env.GITHUB_BASELINE_SCRIPT;
 try{
  const page=await browser.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
  // Exercise the hover/focus fallback independently of viewport preloading.
  await page.addInitScript(()=>{window.IntersectionObserver=undefined;});
  await page.route('http://github-speed.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/conversation/github')){
    const body=route.request().postDataJSON();reads.push({host:url.pathname.split('/')[3],...body});
    if(body.number===3)await new Promise(resolve=>release=resolve);
    else await new Promise(resolve=>setTimeout(resolve,delay));
    return route.fulfill(fail?{status:503,body:'offline'}:{json:{__typename:'Issue',title:`Reference ${body.number}`,state:'OPEN',body:'Description',author:{login:'reviewer'}}}).catch(()=>{});
   }
   if(url.pathname==='/conversation-github.js')return route.fulfill({path:process.env.GITHUB_BASELINE_SCRIPT||path.join(__dirname,'static/conversation-github.js'),contentType:'text/javascript'});
   return route.fulfill({contentType:'text/html',body:`<main id="terminals"><div id="refs">${[1,2,3,4].map(n=>`<a id="ref${n}" href="https://github.com/example/project/pull/${n}">PR ${n}</a>`).join(' ')}</div><div id="other"><a id="other1" href="https://github.com/example/project/pull/1">Other computer</a></div></main><script src="/conversation-github.js"></script><script>
    const now=Date.now;window.clock=0;Date.now=()=>now()+clock;
    window.completed=[];const fetchOriginal=window.fetch;window.fetch=async(...args)=>{const response=await fetchOriginal(...args);response.clone().json().then(()=>completed.push(JSON.parse(args[1].body).number)).catch(()=>{});return response;};
    SwitchboardConversationGithub.decorate(document.querySelector('#refs'),{host:'fixture'});
    SwitchboardConversationGithub.decorate(document.querySelector('#other'),{host:'other'});
   </script>`});
  });
  await page.goto('http://github-speed.test/');
  const preview=page.getByRole('complementary',{name:'GitHub preview'});
  const paint=()=>page.evaluate(()=>new Promise(resolve=>{
   const start=performance.now();
   const observer=new MutationObserver(()=>{if(document.querySelector('.github-title')?.textContent==='Reference 1'){observer.disconnect();requestAnimationFrame(()=>resolve(performance.now()-start));}});
   observer.observe(document.querySelector('#terminals'),{subtree:true,childList:true});document.querySelector('#ref1').click();
  }));
  // Brief pointer passes must not start reads. A deliberate hover does.
  await page.locator('#ref2').dispatchEvent('pointerenter',{pointerType:'mouse'});
  await page.locator('#ref2').dispatchEvent('pointerleave',{pointerType:'mouse'});
  await page.locator('#ref1').hover();
  if(baseline)await page.waitForTimeout(600);
  else await page.waitForFunction(()=>completed.includes(1));
  assert.equal(reads.some(r=>r.number===2),false);
  const hovered=await paint();
  await page.keyboard.press('Escape');
  const reopened=await paint();
  console.log(JSON.stringify({implementation:baseline?'before':'after',apiDelayMs:delay,hoverClickToPaintMs:Math.round(hovered),reopenToPaintMs:Math.round(reopened),reads:reads.length}));
  if(baseline)return;
  assert.equal(reads.length,1,'hover and repeated clicks share one API read');
  assert.ok(hovered<delay/2&&reopened<delay/2,'cached opens do not wait for the API');
  await page.keyboard.press('Escape');
  // Focus prefetch and a click during that read must also coalesce.
  const focusRead=page.waitForRequest(request=>request.url().endsWith('/conversation/github')&&request.postDataJSON().number===2);
  await page.locator('#ref2').focus();await focusRead;
  await page.locator('#ref2').click();await preview.getByRole('heading',{name:'Reference 2'}).waitFor();
  assert.equal(reads.filter(r=>r.number===2).length,1);
  await page.keyboard.press('Escape');
  await page.locator('#other1').click();await preview.getByRole('heading',{name:'Reference 1'}).waitFor();
  assert.equal(reads.filter(r=>r.number===1).length,2,'same repo on another host has separate credentials/cache');
  await page.keyboard.press('Escape');
  // Expired status must reload; failures must not poison retries.
  await page.evaluate(()=>clock+=31000);fail=true;
  await page.locator('#ref1').click();await preview.getByRole('button',{name:'Retry'}).waitFor();
  fail=false;delay=0;await preview.getByRole('button',{name:'Retry'}).click();await preview.getByRole('heading',{name:'Reference 1'}).waitFor();
  await page.keyboard.press('Escape');
  // Closing a pending read cannot steal focus or overwrite a newer reference.
  await page.locator('#ref3').click();await page.waitForFunction(()=>document.querySelector('.github-loading'));
  await page.keyboard.press('Escape');await page.locator('#ref4').click();await preview.getByRole('heading',{name:'Reference 4'}).waitFor();
  release();await page.waitForFunction(()=>completed.includes(3));
  assert.equal(await preview.locator('.github-title').textContent(),'Reference 4');
  assert.deepEqual(errors,[]);
 }finally{release?.();await browser.close();}
});

test('visible GitHub references preload on touch with bounded reads and skip hidden links',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const baseline=!!process.env.GITHUB_BASELINE_SCRIPT,delay=650,reads=[],errors=[];let active=0,peak=0;
 try{
  const page=await browser.newPage({hasTouch:true,viewport:{width:1400,height:900}});page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://github-visible.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/conversation/github')){
    const body=route.request().postDataJSON();reads.push(body.number);peak=Math.max(peak,++active);
    await new Promise(resolve=>setTimeout(resolve,delay));active--;
    return route.fulfill({json:{__typename:'PullRequest',title:`Reference ${body.number}`,state:'OPEN',body:'A preview ready when you open it.',author:{login:'reviewer'},headRefName:'feature/preview',baseRefName:'main',changedFiles:2,additions:12,deletions:3,reviewDecision:'APPROVED',mergeStateStatus:'CLEAN'}}).catch(()=>{});
   }
   if(url.pathname==='/conversation-github.js')return route.fulfill({path:process.env.GITHUB_BASELINE_SCRIPT||path.join(__dirname,'static/conversation-github.js'),contentType:'text/javascript'});
   if(url.pathname==='/conversation.css')return route.fulfill({path:path.join(__dirname,'static/conversation.css'),contentType:'text/css'});
   return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0;background:#111214;color:#eee;font:14px system-ui}#terminals{height:100vh;position:relative}#refs{padding:24px}a{display:block;color:#aab9ee;margin-bottom:20px}#ref4{display:none}#ref5{margin-top:2000px}</style><main id="terminals"><div id="refs">${[1,2,3,4,5].map(n=>`<a id="ref${n}" href="https://github.com/example/project/pull/${n}">PR ${n}</a>`).join('')}</div></main><script src="/conversation-github.js"></script><script>window.completed=[];const realFetch=fetch;window.fetch=async(...args)=>{const response=await realFetch(...args);response.clone().json().then(()=>completed.push(JSON.parse(args[1].body).number));return response;};SwitchboardConversationGithub.decorate(document.querySelector('#refs'),{host:'fixture'});</script>`});
  });
  await page.goto('http://github-visible.test/');
  if(baseline)await page.waitForTimeout(1500);
  else{
   await page.waitForFunction(()=>completed.includes(1)&&completed.includes(2)&&completed.includes(3));
   assert.deepEqual([...reads].sort(),[1,2,3],'queued visible links load; hidden and offscreen links do not');
   assert.equal(peak,2,'only two speculative API reads run together');
  }
  const measurement=page.evaluate(()=>new Promise(resolve=>{
   const start=performance.now(),observer=new MutationObserver(()=>{
    if(document.querySelector('.github-title')?.textContent==='Reference 1'){
     observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));
    }
   });observer.observe(document.querySelector('#terminals'),{subtree:true,childList:true});
   document.querySelector('#ref1').click();
  }));
  if(process.env.GITHUB_VISIBLE_SCREENSHOT){await page.waitForTimeout(100);await page.screenshot({path:process.env.GITHUB_VISIBLE_SCREENSHOT});}
  const elapsed=await measurement;
  console.log(JSON.stringify({implementation:baseline?'before':'after',apiDelayMs:delay,visibleTouchClickToPaintMs:Math.round(elapsed),reads:reads.length,peak}));
  if(baseline){assert.ok(elapsed>=delay);return;}
  assert.ok(elapsed<delay/2,'a touch click on a visible reference does not wait for GitHub');
  assert.equal(reads.filter(n=>n===1).length,1,'click reuses viewport prefetch');
  await page.keyboard.press('Escape');
  await page.locator('#ref5').scrollIntoViewIfNeeded();await page.waitForFunction(()=>completed.includes(5));
  assert.equal(reads.includes(4),false);assert.equal(reads.filter(n=>n===5).length,1);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('queued GitHub references leave and reenter a scrolling conversation',{skip:!process.env.PLAYWRIGHT_MODULE||!!process.env.GITHUB_BASELINE_SCRIPT,timeout:10000},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const reads=[],pending=[];let twoReads;
 const started=new Promise(resolve=>twoReads=resolve);
 try{
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  await page.route('http://github-scroll.test/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname.endsWith('/conversation/github')){
    const {number}=route.request().postDataJSON();reads.push(number);if(reads.length===2)twoReads();
    if(number<3)await new Promise(resolve=>pending.push(resolve));
    return route.fulfill({json:{__typename:'Issue',title:`Reference ${number}`,state:'OPEN',body:'Description'}}).catch(()=>{});
   }
   if(pathname==='/conversation-github.js')return route.fulfill({path:path.join(__dirname,'static/conversation-github.js'),contentType:'text/javascript'});
   return route.fulfill({contentType:'text/html',body:`<style>#refs{margin-top:200px;height:100px;overflow:auto}a{display:block;height:30px}</style><main id="terminals"><div id="refs">${[1,2,3].map(n=>`<a href="https://github.com/example/project/pull/${n}">PR ${n}</a>`).join('')}<div style="height:500px"></div></div></main><script src="/conversation-github.js"></script><script>window.completed=[];const realFetch=fetch;window.fetch=async(...args)=>{const response=await realFetch(...args);response.clone().json().then(()=>completed.push(JSON.parse(args[1].body).number));return response;};SwitchboardConversationGithub.decorate(document.querySelector('#refs'),{host:'fixture'});</script>`});
  });
  await page.goto('http://github-scroll.test/');await started;
  assert.deepEqual(reads,[1,2]);
  await page.evaluate(()=>{document.querySelector('#refs').scrollTop=150;});
  // Drain rendering/observer notifications before completing the two held reads.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
  pending.splice(0).forEach(resolve=>resolve());
  await page.waitForFunction(()=>completed.includes(1)&&completed.includes(2));
  assert.deepEqual(reads,[1,2],'a link clipped by the scroll container stays unread');
  await page.evaluate(()=>{document.querySelector('#refs').scrollTop=0;});
  await page.waitForFunction(()=>completed.includes(3));
  assert.deepEqual(reads,[1,2,3],'a skipped link preloads when it becomes visible again');
 }finally{pending.splice(0).forEach(resolve=>resolve());await browser.close();}
});
