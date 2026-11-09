const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('GitHub intent prefetch shares reads, expires, isolates hosts and survives navigation',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const reads=[],errors=[];let fail=false,release,delay=400;
 const baseline=!!process.env.GITHUB_BASELINE_SCRIPT;
 try{
  const page=await browser.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
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
