// Instant typing against the real bundled xterm parser, using screens captured from Claude Code.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
global.self=global;
const {Terminal}=require(__dirname+'/../../zellij-client/assets/xterm.js');
const Predict=require('./static/predict.js');

// Claude Code's prompt row as it draws it: "❯", a no-break space, then a dim placeholder under the cursor.
const PLACEHOLDER='Try "create a util logging.py that..."';
const PROMPT=`\x1b[2J\x1b[27;1H\x1b[39m❯\u00a0\x1b[2m${PLACEHOLDER}\x1b[22m\x1b[27;3H\x1b[?25h`;
// Claude Code's echo of a typed character (captured for "h"): the cursor is hidden while it redraws and
// visits the bottom row before settling after the character.
const echo=(x,ch)=>`\x1b[?25l\x1b[H\r\x1b[${x}C\x1b[26B${ch}\x1b[K\x1b[30;1H\x1b[27;${x+2}H\x1b[?25h`;

function harness({on=true}={}){
  const term=new Terminal({cols:100,rows:30,allowProposedApi:true});
  let now=0,id=0,enabled=on;const timers=new Map(),draws=[];
  const core=Predict.create({term,now:()=>now,enabled:()=>enabled,draw:model=>draws.push(model),
    setTimer:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimer:key=>timers.delete(key)});
  const write=data=>new Promise(resolve=>term.write(data,resolve));
  const advance=ms=>{now+=ms;for(const [key,timer] of [...timers])if(timer.at<=now){timers.delete(key);timer.fn();}};
  const shown=()=>{const model=core.model();return model&&{row:model.row,from:model.cells[0].x,text:model.cells.map(cell=>cell.ch).join('').trimEnd(),width:model.cells.length,cursor:model.cursor};};
  return {term,core,write,advance,shown,draws,setEnabled:value=>enabled=value,time:()=>now};
}

test('a typed character covers the placeholder at once and the echo confirms it',async()=>{
  const h=harness();await h.write(PROMPT);
  h.core.sent('h');
  assert.deepEqual(h.shown(),{row:26,from:2,text:'h',width:PLACEHOLDER.length,cursor:3});
  assert.equal(h.draws.at(-1).cells[0].ch,'h','Drawn as soon as it is sent');
  h.advance(120);await h.write(echo(2,'h'));
  assert.equal(h.shown(),null);assert.equal(h.draws.at(-1),null);
  assert.equal(h.core.state().srtt,120);
});

test('echoes confirm guesses in order and later guesses stay drawn',async()=>{
  const h=harness();await h.write(PROMPT);
  for(const ch of 'hey')h.core.sent(ch);
  assert.equal(h.shown().text,'hey');assert.equal(h.shown().cursor,5);
  h.advance(80);await h.write(echo(2,'h'));
  assert.deepEqual({...h.shown(),width:undefined},{row:26,from:3,text:'ey',width:undefined,cursor:5});
  await h.write(echo(3,'e')+echo(4,'y'));
  assert.equal(h.shown(),null);
});

test('a frame still being drawn, with the cursor hidden, confirms nothing until the cursor returns',async()=>{
  const h=harness();await h.write(PROMPT);
  h.core.sent('h');
  await h.write('\x1b[?25l\x1b[27;3Hh');
  assert.equal(h.shown().text,'h');
  await h.write('\x1b[?25h');
  assert.equal(h.shown(),null);
});

test('a wrong guess is removed at its deadline and guessing pauses',async()=>{
  const h=harness();await h.write(PROMPT);
  h.core.sent('h');
  await h.write(echo(2,'x'));
  assert.equal(h.shown().text,'h','A mismatch waits for the deadline in case the frame is partial');
  h.advance(1000);
  assert.equal(h.shown(),null);
  h.core.sent('a');
  assert.equal(h.shown(),null,'Paused after a wrong guess');
  h.advance(300);h.core.sent('b');
  assert.deepEqual([h.shown().from,h.shown().text],[3,'b']);
});

test('Enter and other keys pause guessing while the screen settles',async()=>{
  const h=harness();await h.write(PROMPT);
  for(const key of ['\r','\x1b','\t','\x1b[A','\x03','\x1b[200~pasted\x1b[201~',new Uint8Array([1])]){
    h.core.sent(key);h.core.sent('h');
    assert.equal(h.shown(),null,JSON.stringify(key));
    h.advance(260);
  }
  h.core.sent('h');
  assert.equal(h.shown().text,'h');
});

test('a key sent while a guess is unconfirmed keeps the guess but adds nothing after it',async()=>{
  const h=harness();await h.write(PROMPT);
  h.core.sent('h');h.core.sent('\r');h.core.sent('i');
  assert.equal(h.shown().text,'h');
  h.advance(260);
  assert.equal(h.shown(),null,'An unconfirmed guess before Enter leaves once the screen should have settled');
});

test('Backspace erases guesses and typed text but never the prompt',async()=>{
  const h=harness();await h.write(PROMPT);
  h.core.sent('h');h.core.sent('\x7f');
  assert.deepEqual([h.shown().from,h.shown().text,h.shown().cursor],[2,'',2]);
  h.advance(100);await h.write(echo(2,'h'));
  assert.equal(h.shown().cursor,2,'The echo of "h" alone is not the state after Backspace');
  await h.write(`\x1b[27;3H\x1b[2m${PLACEHOLDER}\x1b[22m\x1b[27;3H`);
  assert.equal(h.shown(),null,'The returning placeholder confirms the erased cell');
  h.core.sent('\x7f');
  assert.equal(h.shown(),null,'The no-break space after ❯ is part of the prompt');
  assert.ok(h.core.state().pausedUntil>h.time());

  const typed=harness();await typed.write('\x1b[2J\x1b[27;1H❯\u00a0hi\x1b[27;5H\x1b[?25h');
  typed.core.sent('\x7f\x7f');
  assert.deepEqual([typed.shown().from,typed.shown().text,typed.shown().cursor],[2,'',2]);
  typed.core.sent('\x7f');
  assert.equal(typed.shown().cursor,2,'Stops at the prompt');
  await typed.write('\x1b[27;3H\x1b[K');
  assert.equal(typed.shown(),null);
});

test('typing in the middle of a line is not guessed',async()=>{
  const h=harness();await h.write('\x1b[2J\x1b[27;1H❯\u00a0hello world\x1b[27;5H\x1b[?25h');
  h.core.sent('x');
  assert.equal(h.shown(),null);
});

test('a shell prompt is guessed after, and stops short of the right edge',async()=>{
  const h=harness();await h.write('\x1b[2J\x1b[1;1Hdom@box:~$ \x1b[?25h');
  h.core.sent('ls');
  assert.deepEqual([h.shown().from,h.shown().text],[11,'ls']);
  const edge=harness();await edge.write('\x1b[2J\x1b[1;98H\x1b[?25h');
  edge.core.sent('abc');
  assert.equal(edge.shown().text,'a','The last two columns are where programs wrap differently');
});

test('in a framed or split pane the border is the right edge',async()=>{
  const h=harness();
  await h.write(`\x1b[2J\x1b[27;1H│❯\u00a0\x1b[2m${PLACEHOLDER}\x1b[22m\x1b[27;50H│ other pane\x1b[27;4H\x1b[?25h`);
  h.core.sent('hi');
  assert.deepEqual([h.shown().from,h.shown().text,h.shown().width],[3,'hi',PLACEHOLDER.length]);
  const edge=harness();await edge.write('\x1b[2J\x1b[27;1H│$ \x1b[27;50H│\x1b[27;47H\x1b[?25h');
  edge.core.sent('abc');
  assert.equal(edge.shown().text,'a','Stops two columns short of the border');
});

test('focus reports and mouse motion do not pause guessing but clicks do',async()=>{
  const h=harness();await h.write(PROMPT);
  h.core.sent('\x1b[I');h.core.sent('\x1b[<35;10;5M');h.core.sent('h');
  assert.equal(h.shown().text,'h');
  h.core.sent('\x1b[<0;10;5M');h.core.sent('e');
  assert.equal(h.shown().text,'h');
});

test('quick echoes stop showing guesses but keep measuring',async()=>{
  const h=harness();await h.write(PROMPT);
  let x=2;
  for(const ch of 'abcdefghij'){h.core.sent(ch);h.advance(5);await h.write(echo(x++,ch));}
  assert.ok(h.core.state().srtt<20);
  h.core.sent('k');
  assert.equal(h.shown(),null);assert.ok(h.core.state().run,'Still guessing to keep measuring');
  for(const ch of 'klmnopqrstuvwxyz'){if(ch!=='k')h.core.sent(ch);h.advance(200);await h.write(echo(x++,ch));}
  h.core.sent('!');
  assert.equal(h.shown().text,'!','A slower link shows guesses again');
});

test('the setting off guesses nothing, and turning it off removes guesses',async()=>{
  const off=harness({on:false});await off.write(PROMPT);
  off.core.sent('h');
  assert.equal(off.shown(),null);assert.deepEqual(off.draws.filter(Boolean),[]);
  const h=harness();await h.write(PROMPT);
  h.core.sent('h');h.setEnabled(false);h.core.sent('e');
  assert.equal(h.shown(),null);
});

test('switching screens or resizing drops guesses',async()=>{
  const h=harness();await h.write(PROMPT);
  h.core.sent('h');await h.write('\x1b[?1049h');
  assert.equal(h.shown(),null);
  await h.write('\x1b[?1049l'+PROMPT);h.advance(300);
  h.core.sent('h');h.term.resize(90,30);
  assert.equal(h.shown(),null);
});

test('the sidebar setting reaches terminal frames, and the relay serves the script to them',()=>{
  const fs=require('node:fs'),root=path.join(__dirname,'../..');
  const relay=fs.readFileSync(path.join(root,'zellij-client/src/switchboard_relay.rs'),'utf8');
  assert.match(relay,/<script src=\\"\/predict\.js\\"><\/script><script src=\\"\/bridge\.js\\">/);
  const app=fs.readFileSync(path.join(__dirname,'static/app.js'),'utf8');
  assert.ok(app.includes(`'${Predict.FLAG}'`));
});

test('the overlay draws each guess over its cell with the cell background',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://switchboard.test/',route=>route.fulfill({contentType:'text/html',body:'<div id="terminal" style="width:800px;height:540px"></div>'}));
    await page.goto('http://switchboard.test/');
    for(const file of ['zellij-client/assets/xterm.js','tools/switchboard/static/predict.js'])await page.addScriptTag({path:path.join(__dirname,'../..',file)});
    const result=await page.evaluate(async({prompt})=>{
      localStorage.setItem('switchboard-predictive-echo','true');
      const term=new Terminal({cols:100,rows:30,fontSize:12,theme:{background:'#101010',foreground:'#eeeeee'}});term.open(document.getElementById('terminal'));
      const predict=SwitchboardPredictiveEcho.install();predict.attach(term);
      await new Promise(resolve=>term.write(prompt+'\x1b[48;2;1;2;3m \x1b[49m\x1b[27;3H',resolve));
      predict.sent('h');
      const spans=[...document.querySelectorAll('.switchboard-prediction span')],cell=term._core._renderService.dimensions.css.cell;
      return {count:spans.length,first:spans[0].textContent,left:parseFloat(spans[0].style.left),top:parseFloat(spans[0].style.top),
        cellWidth:cell.width,cellHeight:cell.height,background:spans[0].style.background,cursorBackground:spans[1].style.background,
        plainBackground:spans[2].style.background};
    },{prompt:PROMPT});
    assert.equal(result.first,'h');
    assert.equal(result.left,2*result.cellWidth);assert.equal(result.top,26*result.cellHeight);
    assert.equal(result.background,'rgb(1, 2, 3)','The cell keeps the background the program gave it');
    assert.equal(result.cursorBackground,'rgb(238, 238, 238)','The cursor moves to after the guess');
    assert.equal(result.plainBackground,'rgb(16, 16, 16)');
    assert.equal(result.count,PLACEHOLDER.length);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
