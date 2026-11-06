const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');

// Real HTTP is important: browser Fetch Metadata changes when a sandbox loses its
// origin. Request mocks and direct HTTP client tests miss this navigation failure.
test('Markdown preview links, images and Raw retain the file origin without enabling scripts',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const source=fs.readFileSync(path.join(__dirname,'../../zellij-client/src/switchboard_relay/artifacts.rs'),'utf8');
  const policy=source.match(/const FILE_MARKDOWN: &str = "([^"]+)";/)[1];
  const requests=[];
  const fileRoute='/api/hosts/paired-linux/file';
  const href=name=>`${fileRoute}?path=${encodeURIComponent('/repo/docs/'+name)}`;
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');
    if(url.pathname==='/'){
      res.setHeader('content-type','text/html');
      res.end(`<iframe src="${href('ideas.md')}"></iframe>`);return;
    }
    if(url.pathname==='/untrusted'){
      res.setHeader('content-type','text/html');res.setHeader('content-security-policy','sandbox');
      res.end(`<a href="${href('plan.md')}">Read file</a>`);return;
    }
    if(url.pathname!==fileRoute){res.writeHead(404);res.end();return;}
    const file=url.searchParams.get('path'),site=req.headers['sec-fetch-site'];
    requests.push({file,site});
    // Same guard as the relay's file route. Never loosen it for opaque origins.
    if(site&&site!=='same-origin'&&site!=='none'){
      res.writeHead(403);res.end('Untrusted file request');return;
    }
    if(file.endsWith('.svg')){
      res.setHeader('content-type','image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');return;
    }
    if(url.searchParams.has('raw')){
      res.setHeader('content-type','text/plain');res.end('# One scheduler, several machines');return;
    }
    res.setHeader('content-type','text/html');
    res.setHeader('content-security-policy',file.endsWith('.md')?policy:'sandbox');
    if(file.endsWith('unsafe.html')){
      res.end('<h1>HTML document</h1><script>parent.document.body.dataset.executed="yes"</script>');return;
    }
    res.end(file.endsWith('ideas.md')
      ?`<h1>Next plan</h1><a href="${href('plan.md')}">the plan</a>`
      :`<h1>One scheduler, several machines</h1><a href="${href('ideas.md')}">Backlog</a>
        <a href="${href('plan.md')}&amp;raw">Raw</a><a href="${href('unsafe.html')}">HTML</a>
        <img src="${href('diagram.svg')}" alt="Diagram">
        <script>parent.document.body.dataset.executed="yes"</script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage();page.setDefaultTimeout(5000);
    const origin=`http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    const frame=page.frameLocator('iframe');
    await frame.getByRole('link',{name:'the plan',exact:true}).click();
    await frame.getByRole('heading',{name:'One scheduler, several machines'}).waitFor();
    await frame.locator('img').evaluate(img=>img.decode());
    assert.equal(await page.locator('body').getAttribute('data-executed'),null);
    await frame.getByRole('link',{name:'Backlog',exact:true}).click();
    await frame.getByRole('link',{name:'the plan',exact:true}).click();
    await frame.getByRole('link',{name:'Raw',exact:true}).click();
    await frame.getByText('# One scheduler, several machines',{exact:true}).waitFor();
    assert.ok(requests.some(r=>r.file.endsWith('diagram.svg')));
    assert.ok(requests.every(r=>r.site==='same-origin'),JSON.stringify(requests));
    // Following a link to arbitrary HTML still cannot execute its script.
    await page.goto(origin);
    await frame.getByRole('link',{name:'the plan',exact:true}).click();
    await frame.getByRole('link',{name:'HTML',exact:true}).click();
    await frame.getByRole('heading',{name:'HTML document'}).waitFor();
    assert.equal(await page.locator('body').getAttribute('data-executed'),null);
    // An unrelated opaque document still cannot read the file route.
    await page.goto(origin+'/untrusted');
    await page.getByRole('link',{name:'Read file',exact:true}).click();
    await page.getByText('Untrusted file request',{exact:true}).waitFor();
    assert.equal(requests.at(-1).site,'cross-site');
  }finally{
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
