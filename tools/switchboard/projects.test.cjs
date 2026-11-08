const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

for(const mode of ['terminal','conversation'])test(`project choices keep distinct workspace names and select full paths in ${mode} mode`,
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(5000);
 const baseline=process.env.PROJECT_SCREENSHOTS==='before';
 const projects=['C:/projects/GitHub/ExampleOrganization/Tools.Inspector','C:/projects/GitHub/ExampleOrganization/Tools.Inspector2','C:/projects/GitHub/ExampleOrganization/Glow/DotNet','C:/projects/GitHub/ExampleOrganization/Glow2/DotNet'];
 try{
  await page.addInitScript(mode=>{localStorage.setItem('switchboard-view-mode',mode);window.setInterval=()=>0;},mode);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://projects.test/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname,json=value=>route.fulfill({json:value}).catch(()=>{});
   if(p==='/api/hosts')return json([{id:'fixture',name:'Desktop',local:true}]);
   if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
   if(p==='/api/attention'){
    if(url.searchParams.has('after'))return;
    return json({version:1,tabs:[{host:'fixture',session:'main',id:1,position:0,name:'Example',panes:[{pane_id:1,is_plugin:false,tab_position:0}]}],panes:[],errors:[]});
   }
   if(p==='/hosts/fixture/project-list')return json(projects);
   if(p==='/hosts/fixture/model-list')return json({codex:[]});
   if(p.startsWith('/api/'))return json({});
   if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:'<body>Fixture terminal</body>'});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   if(baseline&&['/app.js','/style.css'].includes(p))return route.fulfill({contentType:p.endsWith('.js')?'text/javascript':'text/css',body:execFileSync('git',['show','HEAD:tools/switchboard/static'+p],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'})});
   return fs.existsSync(file)?route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
  });
  await page.goto('http://projects.test/?host=fixture&session=main&tab=1');
  await page.locator('#tabs .tab-select').waitFor({state:'attached'});
  await page.keyboard.press('Alt+KeyT');await page.locator('#new-tab-project-chip').click();
  await page.locator('#new-tab-project').fill('inspector');
  const choices=page.locator('#new-tab-projects [role=option]');
  await choices.first().waitFor();
  if(process.env.PROJECT_SCREENSHOTS){
   const target=path.join(process.env.PROJECT_SCREENSHOT_DIR,process.env.PROJECT_SCREENSHOTS+'.png');
   await page.locator('#new-tab-projects').evaluate((node,before)=>{node.style.outline='2px solid '+(before?'#e65b5b':'#55ba80');const label=document.querySelector('label[for="new-tab-project"]');label.textContent=before?'Path hides repository names':'Repository names first';label.style.color=before?'#e65b5b':'#55ba80';},baseline);
   await page.locator('#new-tab-project-popover').screenshot({path:target});
  }
  if(baseline)return;
  assert.deepEqual(await choices.locator('span').allTextContents(),['Tools.Inspector','Tools.Inspector2']);
  assert.deepEqual(await choices.locator('small').allTextContents(),['C:/projects/GitHub/ExampleOrganization','C:/projects/GitHub/ExampleOrganization']);
  for(const option of await choices.all())assert.equal(await option.locator('span').evaluate(node=>node.scrollWidth<=node.clientWidth),true,'Repository names fit at mobile width');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#new-tab-project').inputValue(),projects[0]);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
  await page.locator('#new-tab-project-chip').click();await page.locator('#new-tab-project').fill('dotnet');
  assert.deepEqual(await choices.locator('span').allTextContents(),['Glow/DotNet','Glow2/DotNet']);
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Tab');
  assert.equal(await page.locator('#new-tab-project').inputValue(),projects[3]);
  assert.equal(await page.locator('#new-tab-project-chip-name').textContent(),'Glow2/DotNet');
  await page.locator('#new-tab-project-chip').click();await page.locator('#new-tab-project').fill('Glow\\DotNet');
  assert.deepEqual(await choices.locator('span').allTextContents(),['Glow/DotNet']);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#new-tab-project').inputValue(),projects[2]);
  await page.locator('#new-tab-project-chip').click();await page.locator('#new-tab-project').fill('inspector2');
  await choices.first().click();
  assert.equal(await page.locator('#new-tab-project').inputValue(),projects[1]);
  assert.deepEqual(errors,[]);
 }finally{await page.unrouteAll({behavior:'ignoreErrors'});await browser.close();}
});
