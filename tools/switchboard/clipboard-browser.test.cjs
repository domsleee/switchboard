const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');

test('plain drags copy locally while clicks and modified drags reach mouse-tracking apps',
  {skip: !process.env.PLAYWRIGHT_MODULE && 'Set PLAYWRIGHT_MODULE for the isolated browser check'}, async () => {
  const {chromium} = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    await page.setContent('<input id="other"><div id="terminal"></div>');
    await page.addStyleTag({path: path.join(__dirname, '../../zellij-client/assets/xterm.css')});
    await page.addScriptTag({path: path.join(__dirname, '../../zellij-client/assets/xterm.js')});
    await page.evaluate(() => {
      window.copies = []; window.input = [];
      Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => copies.push(text)}});
    });
    await page.addScriptTag({path: path.join(__dirname, 'static/clipboard.js')});
    await page.addScriptTag({path: path.join(__dirname, '../../zellij-client/assets/addon-clipboard.js')});
    const box = await page.evaluate(async () => {
      window.term = new Terminal({cols: 60, rows: 10});
      term.loadAddon(new ClipboardAddon.ClipboardAddon());
      term.open(document.getElementById('terminal'));
      term.onData(data => input.push(data));
      await new Promise(done => term.write('remote answer to copy\r\nsecond line\x1b[?1000h\x1b[?1002h\x1b[?1006h', done));
      const rect = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      return {x: rect.x, y: rect.y, cell: rect.width / term.cols, row: rect.height / term.rows};
    });
    const start = {x: box.x + box.cell * .2, y: box.y + box.row * .5};
    const end = {x: box.x + box.cell * 13.2, y: start.y};
    // Changing focus to the terminal must not cancel this first drag.
    await page.locator('#other').focus();
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, {steps: 10}); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => copies), ['remote answer']);
    assert.deepEqual(await page.evaluate(() => input), []);
    await page.evaluate(() => { copies.length = 0; input.length = 0; SwitchboardClipboard.clearSelection(); });
    await page.locator('#other').focus();
    await page.mouse.click(start.x, start.y);
    assert.match(await page.evaluate(() => input.join('')), /\x1b\[<0;1;1M\x1b\[<0;1;1m/);
    assert.deepEqual(await page.evaluate(() => copies), []);
    await page.evaluate(() => { input.length = 0; });
    await page.keyboard.down('Control');
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, {steps: 5}); await page.mouse.up();
    await page.keyboard.up('Control');
    assert.ok((await page.evaluate(() => input.join(''))).includes('\x1b[<48;'));
    assert.deepEqual(await page.evaluate(() => copies), []);
    await page.evaluate(() => { input.length = 0; });
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(100);
    assert.match(await page.evaluate(() => input.join('')), /\x1b\[<65;/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
