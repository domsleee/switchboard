const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

// Actual xterm in a standalone page. No network or user terminal connections.
test('terminal diagnostics distinguish bottom-row wrapping, linefeeds and transient widths',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async t=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',route=>route.abort());
    await page.setContent('<div id="terminal"></div>');
    await page.addStyleTag({path:path.join(__dirname,'../../zellij-client/assets/xterm.css')});
    await page.addScriptTag({path:path.join(__dirname,'../../zellij-client/assets/xterm.js')});
    await page.addScriptTag({path:path.join(__dirname,'static/terminal-diagnostics.js')});
    await page.evaluate(()=>{
      window.fixture=async({frame,narrow=false})=>{
        const term=new Terminal({cols:10,rows:3,scrollback:0}),reports=[];
        term.open(document.getElementById('terminal'));
        const write=data=>new Promise(done=>term.write(data,done));
        const rendered=()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
        await write('\x1b[1;1Htop\x1b[2;1Hmiddle\x1b[3;1Hbottom');
        await rendered();
        const diagnostic=SwitchboardTerminalDiagnostics(report=>reports.push(report),()=>({
          physical_cols:10,physical_rows:3,native_cols:10,native_rows:3,
          xterm_cols:term.cols,xterm_rows:term.rows,buffer_rows:term.buffer.active.length,
        }));
        diagnostic.start({focus_id:1,pane_id:30,is_plugin:false},term);
        diagnostic.ack();
        if(narrow)term.resize(8,3);
        diagnostic.frame(frame);await write(frame);await rendered();
        if(narrow){term.resize(10,3);await rendered();}
        diagnostic.finish('superseded');
        const rows=Array.from({length:term.rows},(_,row)=>term.buffer.active.getLine(row).translateToString(true));
        const report=reports[0];term.dispose();
        return {report,rows};
      };
    });
    const run=options=>page.evaluate(options=>fixture(options),options);
    await t.test('a frame that exactly fills the last row leaves the viewport in place',async()=>{
      const {report,rows}=await run({frame:'\x1b[3;1H1234567890'});
      assert.equal(report.buffer_scroll_events,0);assert.equal(report.line_feed_events,0);
      assert.equal(report.buffer_rows,3);assert.deepEqual(rows,['top','middle','1234567890']);
      assert.equal(report.frames,1);assert.equal(report.writes_pending,0);
      assert.doesNotMatch(JSON.stringify(report),/top|middle|1234567890/);
    });
    await t.test('an extra cell wraps and scrolls despite having no scrollback or linefeed',async()=>{
      const {report,rows}=await run({frame:'\x1b[3;1H12345678901'});
      assert.equal(report.buffer_scroll_events,1);assert.equal(report.line_feed_events,0);
      assert.equal(report.buffer_rows,3);assert.deepEqual(rows,['middle','1234567890','1']);
    });
    await t.test('a literal linefeed distinguishes scrolling from bottom-row wrapping',async()=>{
      const {report,rows}=await run({frame:'\x1b[3;1H123\n'});
      assert.equal(report.buffer_scroll_events,1);assert.equal(report.line_feed_events,1);
      assert.equal(report.buffer_rows,3);assert.deepEqual(rows,['middle','123tom','']);
    });
    await t.test('temporary column shrink is recorded even when final native and browser sizes agree',async()=>{
      const {report}=await run({frame:'\x1b[3;1H1234567890',narrow:true});
      assert.equal(report.xterm_size_changes,2);assert.equal(report.first_xterm_cols,10);
      assert.equal(report.min_xterm_cols,8);assert.equal(report.max_xterm_cols,10);
      assert.equal(report.first_xterm_rows,3);assert.equal(report.min_xterm_rows,3);assert.equal(report.max_xterm_rows,3);
      assert.equal(report.native_cols,10);assert.equal(report.physical_cols,10);assert.equal(report.xterm_cols,10);
      assert.ok(report.buffer_scroll_events>=1);assert.equal(report.line_feed_events,0);
    });
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
