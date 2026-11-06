const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Media path matching comes from links.js, as it does in the terminal page.
const window={addEventListener(){},term:null};
const context={window,location:{pathname:'/hosts/laptop/main',href:'http://127.0.0.1:8090/hosts/laptop/main'},URL,console,
  setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},fetch:()=>Promise.resolve({ok:false})};
context.parent=window;
vm.runInNewContext(fs.readFileSync(__dirname+'/static/links.js','utf8'),context);
vm.runInNewContext(fs.readFileSync(__dirname+'/static/thumbnails.js','utf8'),context);
const media=window.__switchboardMedia,thumbnails=window.__switchboardThumbnails;
// Results come from another realm, so copy them before deep comparisons.
const plain=value=>JSON.parse(JSON.stringify(value));
const pathsOnScreen=(...args)=>plain(thumbnails.pathsOnScreen(...args)),layout=(...args)=>plain(thumbnails.layout(...args));
const cell={width:9,height:18},cols=100;
const screen=lines=>{const rows=[...lines];while(rows.length<20)rows.push('');return rows;};
const place=(rows,wrapped=rows.map(()=>false),aspects={})=>
  layout(pathsOnScreen(rows,wrapped,cols,media),rows,cols,cell,path=>aspects[path]);

// Before and after on consecutive rows share one band to the right of the reply.
let rows=screen(['Here are the screenshots:','','- before: /tmp/shots/before.png','- after:  C:\\Users\\me\\My Shots\\after.png','','Both at 640x400.']);
let boxes=place(rows);
assert.deepEqual(boxes.map(box=>box.path),['/tmp/shots/before.png','C:\\Users\\me\\My Shots\\after.png']);
const longest=Math.max(...rows.slice(2,10).map(row=>row.length));
assert.equal(boxes[0].row,2);assert.equal(boxes[1].row,2,'The second thumbnail sits beside the first');
assert.equal(boxes[0].col,longest+2,'Thumbnails start after the longest row they span');
assert.equal(boxes[1].col,boxes[0].col+boxes[0].cols+1);
assert.equal(boxes[0].rows,10,'Half of a 20-row terminal');
assert.ok(boxes.every(box=>box.col+box.cols<=cols-2),'Thumbnails stay inside the screen');

// A thumbnail is as wide as its image's shape needs at its height.
boxes=place(rows,undefined,{'/tmp/shots/before.png':2});
assert.equal(boxes[0].cols,Math.ceil(10*cell.height*2/cell.width));

// A tall terminal gives taller thumbnails, up to 24 rows.
rows=['shot: /tmp/a.png',...Array(59).fill('')];
assert.equal(place(rows)[0].rows,24);

// It never covers text: a full row below the path ends the thumbnail there.
rows=screen(['shot: /tmp/a.png','','','x'.repeat(cols)]);
boxes=place(rows);
assert.equal(boxes[0].rows,3);
rows=screen(['shot: /tmp/a.png','x'.repeat(cols)]);
assert.equal(place(rows)[0].row,2,'A dense reply moves the thumbnail below its text');
rows=screen(['x'.repeat(cols-10)+' /a/b.png']);
assert.equal(place(rows)[0].row,1,'A long path uses the free rows below it');
rows=['shot: /tmp/a.png',...Array(19).fill('x'.repeat(cols))];
assert.deepEqual(place(rows),[],'No thumbnail appears when the screen has no free band');

// A wide comparison video used to fill the only band and silently drop the other five clips.
const clips=['grade/side-by-side.mp4','claude/task/after.avif','claude/task/after.mp4','codex/task/after.avif','codex/task/after.mp4','grade/reference.avif']
  .map(path=>'/home/me/bench-runs/'+path);
rows=[...clips,...Array(34).fill('')];
const aspects=Object.fromEntries(clips.map(path=>[path,path.includes('side-by-side')?3.72:path.endsWith('.mp4')?16/9:1.24]));
boxes=place(rows,undefined,aspects);
assert.deepEqual(boxes.map(box=>box.path),clips,'All six previews remain visible after their dimensions load');
assert.ok(new Set(boxes.map(box=>box.row)).size>1,'Clips wrap into another band');
for(const box of boxes){
  assert.ok(box.row+box.rows<=rows.length&&box.col+box.cols<=cols-2);
  for(let row=box.row;row<box.row+box.rows;row++)assert.ok(box.col>=rows[row].length+2,'A wrapped preview never covers text');
  for(const other of boxes)if(other!==box)assert.ok(box.row+box.rows<=other.row||other.row+other.rows<=box.row||box.col+box.cols<=other.col||other.col+other.cols<=box.col,'Preview bands do not overlap');
}

// A pane frame's right edge is not text.
rows=screen(['│ shot: /tmp/a.png'.padEnd(cols-1)+'│','│'.padEnd(cols-1)+'│','│'.padEnd(cols-1)+'│','│'.padEnd(cols-1)+'│']);
assert.equal(place(rows).length,1);

// A path wrapped by the terminal joins its rows and anchors on the row it ends on.
const long='/home/me/'+'deep/'.repeat(25)+'shot.png';
rows=screen([('see '+long).slice(0,cols),('see '+long).slice(cols)]);
assert.deepEqual(pathsOnScreen(rows,rows.map((_,i)=>i===1),cols,media),[{path:long,relative:false,row:1}]);

// Relative paths are marked, so the page resolves them through the session first; repeats show once.
assert.deepEqual(pathsOnScreen(screen(['out/shot.png and out/shot.png']),screen([]).map(()=>false),cols,media),[{path:'out/shot.png',relative:true,row:0}]);
console.log('Media paths on screen become thumbnails beside them, never over text.');

// Real browser: PLAYWRIGHT_MODULE=/path/to/playwright node thumbnails.test.cjs
if(process.env.PLAYWRIGHT_MODULE)(async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwH4QZGBgAEPYD/WQ/5WMAAAAASUVORK5CYII=','base64');
    const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
    const page=await browser.newPage({viewport:{width:1000,height:400}});
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/api/hosts/laptop/file')){
        const path=url.searchParams.get('path');
        return path.includes('missing')?route.fulfill({status:404}):route.fulfill({contentType:path.endsWith('.gif')?'image/gif':'image/png',body:path.endsWith('.gif')?gif:png});
      }
      if(url.pathname==='/xterm.js')return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(__dirname+'/../../zellij-client/assets/xterm.js')});
      if(url.pathname==='/xterm.css')return route.fulfill({contentType:'text/css',body:fs.readFileSync(__dirname+'/../../zellij-client/assets/xterm.css')});
      if(url.pathname.endsWith('.js'))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(__dirname+'/static'+url.pathname)});
      // Switchboard hosts each terminal in a frame and opens files from the outer page.
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><script>window.opened=[];window.SwitchboardOpenFile=(host,path)=>opened.push([host,path]);</script>
        <iframe src="/hosts/laptop/main" style="width:960px;height:380px;border:0"></iframe>`});
      route.fulfill({contentType:'text/html',body:`<!doctype html><link rel=stylesheet href=/xterm.css><div id=terminal></div><script src=/xterm.js></script>
        <script>window.term=new Terminal({cols:100,rows:20});term.open(document.getElementById('terminal'));</script>
        <script src=/links.js></script><script src=/thumbnails.js></script>`});
    });
    await page.goto('http://127.0.0.1:8090/');
    const frame=await (await page.waitForSelector('iframe')).contentFrame();
    await frame.waitForFunction(()=>window.term);
    const write=text=>frame.evaluate(text=>new Promise(done=>term.write(text,done)),text);
    const thumbnails=()=>frame.evaluate(()=>[...document.querySelectorAll('.switchboard-thumbnails > div')].map(box=>box.title));
    await write('- before: /tmp/before.png\r\n- after: /tmp/after.png\r\n- gone: /tmp/missing.png\r\n');
    await page.waitForTimeout(200);
    assert.deepEqual(await thumbnails(),[],'Thumbnails follow the Terminal thumbnails setting, which starts off');
    await frame.evaluate(()=>{localStorage.setItem('switchboard-media-thumbnails','true');term.refresh(0,term.rows-1);});
    await frame.waitForFunction(()=>document.querySelectorAll('.switchboard-thumbnails img').length===2&&[...document.querySelectorAll('.switchboard-thumbnails img')].every(img=>img.naturalWidth));
    await page.waitForTimeout(200);
    assert.deepEqual(await thumbnails(),['/tmp/before.png','/tmp/after.png'],'A file that fails to load shows no thumbnail');
    const box=await frame.locator('.switchboard-thumbnails > div').first().boundingBox();
    assert.ok(box.width>box.height*1.5,'The thumbnail takes its image\'s 2:1 shape');
    await frame.locator('.switchboard-thumbnails > div').first().click();
    assert.deepEqual(await page.evaluate(()=>window.opened),[['laptop','/tmp/before.png']],'Clicking a thumbnail opens its file');
    await write('\x1b[2J\x1b[H');
    await frame.waitForFunction(()=>!document.querySelector('.switchboard-thumbnails > div'));
    await write('/tmp/loop.gif\r\n');
    await frame.waitForFunction(()=>document.querySelector('.switchboard-thumbnails img')?.naturalWidth);
    const loop=frame.locator('.switchboard-thumbnails > div');
    await loop.click();
    assert.deepEqual(await page.evaluate(()=>window.opened.at(-1)),['laptop','/tmp/loop.gif'],'Plain GIF clicks retain the file viewer');
    for(const modifier of ['Control','Meta']){
      const count=page.context().pages().length,ready=page.context().waitForEvent('page');
      await loop.click({modifiers:[modifier]});
      const popup=await ready;
      await popup.waitForURL('**/api/hosts/laptop/file?path=%2Ftmp%2Floop.gif');
      assert.equal(page.context().pages().length,count+1,'Each modified thumbnail click opens exactly one tab');
      assert.equal(await popup.evaluate(()=>window.opener),null);
      assert.equal(await page.evaluate(()=>window.opened.length),2,'Modified GIF clicks bypass the in-page viewer');
      await popup.close();
    }
    console.log('Headless browser: thumbnails load, follow the setting, open on click and leave with the text; Ctrl/Cmd-click opens a GIF once in a new tab.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
