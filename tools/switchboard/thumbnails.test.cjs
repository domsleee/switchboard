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
assert.deepEqual(place(rows),[],'Less than 3 free rows shows no thumbnail; hover still works');
rows=screen(['x'.repeat(cols-10)+' /a/b.png']);
assert.deepEqual(place(rows),[],'No blank room beside the path shows no thumbnail');

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
    const page=await browser.newPage({viewport:{width:1000,height:400}});
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/api/hosts/laptop/file'))return url.searchParams.get('path').includes('missing')?route.fulfill({status:404}):route.fulfill({contentType:'image/png',body:png});
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
    console.log('Headless browser: thumbnails appear beside media paths, follow the setting, open on click and leave with the text.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
