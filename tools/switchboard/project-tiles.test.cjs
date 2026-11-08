const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

// Each row: title, working folder, and the repository name the relay reports (absent on older relays).
const rows=[
  ['Fix volume performance','/home/dev/git/switchboard','switchboard'],
  ['Review the sidebar','/home/dev/git/switchboard/.claude/worktrees/fix-tabs','switchboard'],
  ['Plan the next release','/home/dev/git/switchboard-release','switchboard'],
  ['Read the reference app','/home/dev/git/t3code'],
  ['Tidy the build','C:\\Users\\dev\\git\\my-app\\src','my-app'],
  ['Check disk space','/home/dev'],
  ['Copy a file','/home/dev/---'],
];

test('project tiles identify the repository across worktrees in both view modes',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  const panes=rows.map(([title,cwd,repo],index)=>({pane_id:index+1,is_plugin:false,tab_id:index+1,tab_position:index,title,cwd,...(repo?{repo}:{})}));
  const tabs=panes.map(pane=>({host:'desktop',session:'main',id:pane.tab_id,position:pane.tab_position,name:pane.title,panes:[pane]}));
  async function fixture(mode,viewport){
    const page=await browser.newPage({viewport,deviceScaleFactor:2}),errors=[];
    page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(mode=>{localStorage.setItem('switchboard-view-mode',mode);window.setInterval=()=>0;},mode);
    await page.route('https://tiles.test/**',route=>{
      const url=new URL(route.request().url()),p=url.pathname,json=value=>route.fulfill({json:value});
      if(p==='/api/attention'&&url.searchParams.has('after'))return;
      if(p==='/api/health')return json({commit:'abc123def',commit_date:'2026-11-08'});
      if(p==='/api/hosts')return json([{id:'desktop',name:'Desktop',local:true}]);
      if(p==='/api/hosts/desktop')return json({id:'desktop',name:'Desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
      if(p==='/api/attention')return json({version:1,tabs,panes:panes.map(pane=>({host:'desktop',session:'main',pane_id:pane.pane_id,agent:'codex',state:'ready',chat_id:'chat-'+pane.pane_id,seen:true,since:1794000000})),errors:[]});
      if(p.startsWith('/api/chats/'))return json({id:p.split('/').at(-1),session_id:'00000000-0000-4000-8000-000000000001',messages:[{role:'assistant',text:'The change is ready for review.'}],start_cursor:0,next_cursor:null});
      if(p.startsWith('/api/'))return json({});
      if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<input aria-label="Terminal input"><script>parent.postMessage({type:'zellij-state',payload:{session_name:'main',panes:${JSON.stringify(panes).replaceAll('\\','\\\\')},active_pane:${JSON.stringify(panes[0])}}},location.origin);</script>`});
      const file=p==='/'?'index.html':p.slice(1);
      if(!/^[\w.-]+$/.test(file)||!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file)});
    });
    await page.goto('https://tiles.test/');
    await page.waitForFunction(count=>document.querySelectorAll('.tab-select').length===count,rows.length);
    return {page,errors};
  }
  const tile=(page,title)=>page.locator('.tab-select').filter({has:page.locator('.tab-name',{hasText:title})}).evaluate(row=>{
    const element=row.querySelector('.project-tile'),shown=getComputedStyle(element).display!=='none',where=row.querySelector('.tab-where');
    const textStart=parseFloat(getComputedStyle(where).paddingLeft)+where.getBoundingClientRect().left;
    return {shown,text:shown?element.textContent:'',color:shown?element.style.color:'',where:where.textContent,clear:!shown||textStart>=element.getBoundingClientRect().right};
  });
  try{
    for(const mode of ['terminal','conversation']){
      const {page,errors}=await fixture(mode,{width:1100,height:760});
      const main=await tile(page,'Fix volume performance');
      assert.equal(main.text,'SD');assert.ok(main.color);assert.equal(main.clear,true,'the tile does not cover the project text');
      for(const worktree of ['Review the sidebar','Plan the next release']){
        const shared=await tile(page,worktree);
        assert.deepEqual([shared.text,shared.color],[main.text,main.color],`${worktree} matches its repository`);
      }
      assert.match((await tile(page,'Review the sidebar')).where,/^fix-tabs/,'the row still names the worktree folder');
      assert.equal((await tile(page,'Read the reference app')).text,'T3','older relays fall back to the folder name');
      assert.equal((await tile(page,'Tidy the build')).text,'MA','a subfolder takes the repository name');
      for(const untitled of ['Check disk space','Copy a file'])assert.equal((await tile(page,untitled)).shown,false,`${untitled} has no tile`);
      assert.equal(await page.locator('.tab-select').first().evaluate(row=>row.getAttribute('aria-label').includes('SD')),false,'screen readers keep the project name instead');
      assert.deepEqual(errors,[]);
      if(process.env.SWITCHBOARD_TILE_SCREENSHOTS)await page.locator('#sidebar').screenshot({path:`${process.env.SWITCHBOARD_TILE_SCREENSHOTS}/${mode}.png`});
      await page.close();
    }
    if(process.env.SWITCHBOARD_TILE_SCREENSHOTS){
      const {page}=await fixture('terminal',{width:390,height:760});
      await page.locator('#sidebar-toggle').click();
      await page.locator('.project-tile').first().waitFor();
      await page.screenshot({path:`${process.env.SWITCHBOARD_TILE_SCREENSHOTS}/phone.png`});
      await page.close();
    }
  }finally{await browser.close();}
});
