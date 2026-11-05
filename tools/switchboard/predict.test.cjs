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

function harness({on=true,report}={}){
  const term=new Terminal({cols:100,rows:30,allowProposedApi:true});
  let now=0,id=0,enabled=on;const timers=new Map(),draws=[];
  const core=Predict.create({term,now:()=>now,enabled:()=>enabled,draw:model=>draws.push(model),report,
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
  assert.equal(h.shown(),null,'An unguessed key is not on screen yet, so guessing waits for a frame');
  h.advance(300);await h.write(echo(3,'b'));h.core.sent('c');
  assert.deepEqual([h.shown().from,h.shown().text],[4,'c']);
});

test('Enter and other keys pause guessing while the screen settles',async()=>{
  const h=harness();await h.write(PROMPT);
  for(const key of ['\r','\x1b','\t','\x1b[A','\x03','\x1b[200~pasted\x1b[201~',new Uint8Array([1])]){
    h.core.sent(key);h.core.sent('h');
    assert.equal(h.shown(),null,JSON.stringify(key));
    h.advance(260);
  }
  h.core.sent('h');
  assert.equal(h.shown(),null,'After the settle time guessing still waits for a frame drawn after the key');
  h.advance(260);await h.write(PROMPT);h.core.sent('h');
  assert.equal(h.shown().text,'h');
});

// The prompt row with typed text and the cursor after it, as a redraw of Claude Code's input draws it.
const typedRow=(text,extra='')=>`\x1b[?25l${extra}\x1b[27;1H\x1b[2K❯\u00a0${text}\x1b[27;${text.length+3}H\x1b[?25h`;

test('a frame drawn before any echo never confirms a correction that returns to the same text',async()=>{
  const reports=[];
  const h=harness({report:r=>reports.push(r)});await h.write(typedRow('helo'));
  h.core.sent('\x7f\x7f');h.core.sent('lo');
  assert.deepEqual([h.shown().from,h.shown().text,h.shown().cursor],[4,'lo',6]);
  h.advance(50);await h.write(typedRow('helo','\x1b[1;1Hspinner'));
  assert.equal(h.shown()?.text,'lo','The unchanged screen is the state before the edit, not after it');
  await h.write(typedRow('hel'));
  assert.equal(h.shown().text,'lo','Each echo confirms only the guesses it shows');
  await h.write(typedRow('he')+typedRow('hel')+typedRow('helo'));
  assert.equal(h.shown(),null);
  assert.equal(h.core.state().confirmed,4);assert.deepEqual(reports,[]);
});

test('coalesced echoes that end on the starting text confirm at the deadline, not as a mistake',async()=>{
  const reports=[];
  const h=harness({report:r=>reports.push(r)});await h.write(typedRow('helo'));
  h.core.sent('\x7f');h.core.sent('o');
  h.advance(50);await h.write(typedRow('helo'));
  assert.equal(h.shown().text,'o');
  h.advance(1000);
  assert.equal(h.shown(),null);
  assert.equal(h.core.state().confirmed,2);assert.deepEqual(reports,[]);
  await h.write(typedRow('helo'));h.core.sent('!');
  assert.equal(h.shown().text,'!','Guessing goes on without a pause');
});

test('guesses leave as soon as the input moves to another row after Enter, and the miss is reported without text',async()=>{
  const reports=[];
  const h=harness({report:r=>reports.push(r)});await h.write(PROMPT);
  h.core.sent('hi\r');h.advance(40);
  await h.write('\x1b[?25l\x1b[27;1H\x1b[2K> earlier message\x1b[29;1H❯\u00a0\x1b[29;3H\x1b[?25h');
  assert.equal(h.shown(),null);
  assert.equal(reports.length,1);
  assert.deepEqual({...reports[0],since_input_ms:undefined,since_write_ms:undefined},{outcome:'moved',pending:2,typed:2,confirmed:0,frames:1,age_ms:40,
    srtt_ms:null,since_input_ms:undefined,since_write_ms:undefined,run_row:26,cursor_row:28,cursor_col:2,expected_col:4,cursor_hidden:false});
  assert.ok(!JSON.stringify(reports).includes('hi"'),'what was typed is never reported');
  h.advance(1000);await h.write(echo(2,'x'));h.core.sent('a');h.advance(1000);
  assert.equal(reports.at(-1).outcome,'timeout');
});

// Claude Code streaming a reply: a line of output above the prompt pushes it down a row.
const streamed=(row,text='')=>`\x1b[?25l\x1b[${row-1};1H\x1b[2Kstreamed line\x1b[${row};1H\x1b[2K❯ ${text||`\x1b[2m${PLACEHOLDER}\x1b[22m`}\x1b[${row};${3+text.length}H\x1b[?25h`;

test('guesses follow the prompt when streamed output moves it, even in a frame drawn before the keys arrived',async()=>{
  const reports=[];
  const h=harness({report:r=>reports.push(r)});await h.write(PROMPT);
  h.core.sent('hi');h.advance(40);
  await h.write(streamed(28));
  assert.deepEqual([h.shown()?.row,h.shown()?.text],[27,'hi'],'Still drawn, on the new row');
  h.core.sent('!');
  assert.equal(h.shown().text,'hi!','Guessing goes on without a pause');
  await h.write(streamed(29,'h'));
  assert.deepEqual([h.shown().row,h.shown().from,h.shown().text],[28,3,'i!'],'An echo on yet another row confirms "h"; the rest stays drawn');
  await h.write(streamed(29,'hi!'));
  assert.equal(h.shown(),null,'All confirmed');
  assert.deepEqual(reports,[]);
  assert.deepEqual([h.core.state().confirmed,h.core.state().dropped],[3,0]);
});

test('guesses do not follow the cursor to a row that is not the prompt',async()=>{
  const reports=[];
  const h=harness({report:r=>reports.push(r)});await h.write(PROMPT);
  h.core.sent('hi');h.advance(40);
  await h.write('\x1b[10;1Hstreamed line\x1b[10;3H');
  assert.equal(h.shown(),null);
  assert.equal(reports[0].outcome,'moved');
  const empty=harness();await empty.write(PROMPT);
  empty.core.sent('hi');empty.advance(40);
  await empty.write('\x1b[12;3H');
  assert.equal(empty.shown(),null,'A blank row with the cursor at the same column is not the prompt');
});

test('Backspace keeps guessing across the space between words but not into a prompt',async()=>{
  const h=harness();await h.write(typedRow('hi yo'));
  h.core.sent('\x7f\x7f\x7f\x7f');
  assert.equal(h.shown().cursor,3,'"o", "y", the space after "hi" and "i" are all erased');
  const shell=harness();await shell.write('\x1b[2J\x1b[1;1Hdom@box:~$ ab\x1b[?25h');
  shell.core.sent('\x7f\x7f\x7f');
  assert.equal(shell.shown().cursor,11,'The space after "$" belongs to the prompt');
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

test('Ctrl+W erases the word before the cursor, typed or already on screen',async()=>{
  const h=harness();await h.write(PROMPT);
  h.core.sent('git commit');h.core.sent('\x17');
  assert.deepEqual([h.shown().text,h.shown().cursor],['git',6]);
  h.advance(100);await h.write('\x1b[?25l\x1b[27;3Hgit commit\x1b[K\x1b[?25h');
  assert.deepEqual([h.shown().from,h.shown().text,h.shown().cursor],[6,'',6],'The echo of the word alone is not the state after Ctrl+W');
  await h.write('\x1b[?25l\x1b[27;3Hgit \x1b[K\x1b[27;7H\x1b[?25h');
  assert.equal(h.shown(),null);assert.equal(h.core.state().dropped,0);

  const screen=harness();await screen.write('\x1b[2J\x1b[27;1H❯\u00a0hello wor_1d\x1b[27;15H\x1b[?25h');
  screen.core.sent('\x17');
  assert.deepEqual([screen.shown().from,screen.shown().text,screen.shown().cursor],[8,'',8],'Letters, digits and _ are one word');
  await screen.write('\x1b[27;9H\x1b[K');
  assert.equal(screen.shown(),null);

  const spaces=harness();await spaces.write(PROMPT);
  spaces.core.sent('hi  \x17');
  assert.deepEqual([spaces.shown().text,spaces.shown().cursor],['',2],'Spaces typed after the word go with it');
  const after=harness();await after.write('\x1b[2J\x1b[27;1H❯\u00a0git hello \x1b[?25h');
  after.core.sent('\x17');
  assert.equal(after.shown().cursor,6,'A space after a word goes with it, as Backspace erases it');

  const shell=harness();await shell.write('\x1b[2J\x1b[1;1Hdom@box:~$ ls\x1b[?25h');
  shell.core.sent('\x17');
  assert.deepEqual([shell.shown().from,shell.shown().cursor],[11,11]);
});

test('Ctrl+W pauses where shells and agents delete different amounts',async()=>{
  // readline, Claude Code and Copilot CLI delete back to a space, nushell to a word boundary, Codex to
  // punctuation. A prompt's space follows a symbol.
  for(const line of ['❯\u00a0world-foo','❯\u00a0foo.','❯\u00a0','❯\u00a0café','abc','dom@box:~$ ','> ']){
    const h=harness();await h.write(`\x1b[2J\x1b[27;1H${line}\x1b[?25h`);
    h.core.sent('\x17');
    assert.equal(h.shown(),null,JSON.stringify(line));
    assert.ok(h.core.state().pausedUntil>h.time(),JSON.stringify(line));
  }
});

// nushell (reedline) with a starship prompt, as captured through Zellij: the history hint after the
// cursor is grey (SGR 90), not dim.
const NU=`\x1b[2J\x1b[2;1H\x1b[32m\x1b[1m❯\x1b[m \x1b[36me\x1b[90m\x1b[22mcho hello world\x1b[m\x1b[2;4H\x1b[?25h`;
test('a shell history hint is replaced like a placeholder',async()=>{
  const h=harness();await h.write(NU);
  h.core.sent('c');
  assert.deepEqual([h.shown().from,h.shown().text,h.shown().width],[3,'c','cho hello world'.length]);
  h.advance(30);await h.write('\x1b[?25l\x1b[2;3H\x1b[36mec\x1b[90mho hello world\x1b[m\x1b[2;5H\x1b[?25h');
  assert.equal(h.shown(),null);
  h.core.sent('\x7f');
  await h.write('\x1b[?25l\x1b[2;3H\x1b[36me\x1b[90mcho hello world\x1b[m\x1b[2;4H\x1b[?25h');
  assert.equal(h.shown(),null,'The hint coming back confirms the erased cell');
  assert.equal(h.core.state().dropped,0);

  const right=harness();await right.write('\x1b[2J\x1b[2;1H❯ \x1b[2;90H\x1b[90m12:00\x1b[m\x1b[2;3H\x1b[?25h');
  right.core.sent('l');
  assert.equal(right.shown(),null,'Grey text away from the cursor is not a hint');
});

test('Enter sent before the echo arrives keeps the guesses the new line confirms',async()=>{
  const misses=[],h=harness({report:miss=>misses.push(miss)});await h.write('\x1b[2J\x1b[1;1H$ \x1b[?25h');
  h.core.sent('ls');h.core.sent('\r');
  h.advance(40);await h.write('ls\r\nfile\r\n$ ');
  assert.equal(h.shown(),null);
  assert.deepEqual([h.core.state().confirmed,h.core.state().dropped,misses],[2,0,[]],'Not logged as moved');
  h.advance(300);h.core.sent('x');
  assert.equal(h.shown().text,'x','Not paused by a wrong guess');
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
  // Settings stores each toggle as switchboard-<button id>.
  assert.ok(Predict.FLAG.startsWith('switchboard-')&&app.includes(`'${Predict.FLAG.slice('switchboard-'.length)}'`));
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
