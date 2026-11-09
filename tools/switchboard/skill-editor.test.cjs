const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

for(const mobile of [false,true])test(`Inline skill editing preserves prompt text, selections, clipboard and history on ${mobile?'phone':'desktop'}`,
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1000,height:700},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(5000);
  const errors=[];let releaseSkills;page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://editor.test/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/conversation/skills')){if(p.includes('/late/'))await new Promise(resolve=>releaseSkills=resolve);return route.fulfill({json:{skills:p.includes('/other/')?[]:[{name:'tools:council',description:'Review with several models.'}]}});}
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><dialog id="new-tab-dialog"><label id="new-tab-prompt-label" for="new-tab-prompt">Prompt</label><div class="new-tab-composer"><textarea id="new-tab-prompt" placeholder="Write a prompt"></textarea></div></dialog><script src="/skill-editor.js"></script><script src="/conversation.js"></script><script>
    window.skillDraft=SwitchboardSkillEditor.install(document.getElementById('new-tab-prompt'));
    window.current={host:'fixture',agent:'codex',cwd:'/work/project',owner:'fixture'};
    window.completions=SwitchboardConversation.attachCompletions({draft:skillDraft,parent:skillDraft.parentElement,id:'skills-menu',surface:()=>current,changed(){}});
    skillDraft.addEventListener('input',()=>completions.paint());skillDraft.addEventListener('keydown',event=>completions.key(event),true);
    document.getElementById('new-tab-dialog').showModal();skillDraft.focus();
   </script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('https://editor.test/');const editor=page.getByRole('textbox',{name:'Prompt'}),chips=editor.locator('.conversation-skill'),value=()=>editor.evaluate(node=>node.value);
  assert.equal(await editor.getAttribute('contenteditable'),'true');
  await editor.fill('$cou');await page.getByRole('option',{name:'$tools:council Review with several models.'}).waitFor();await editor.press('Tab');
  assert.equal(await value(),'$tools:council ');await chips.waitFor();
  await editor.pressSequentially('confirm');assert.equal(await value(),'$tools:council confirm');
  const [chipBox,argumentBox]=await editor.evaluate(node=>{
   const chip=node.querySelector('.conversation-skill'),text=[...node.childNodes].find(child=>child.nodeType===3&&child.textContent.includes('confirm')),range=document.createRange();range.selectNodeContents(text);
   return [chip.getBoundingClientRect().toJSON(),range.getBoundingClientRect().toJSON()];
  });
  assert.ok(argumentBox.x>chipBox.x+chipBox.width&&Math.abs(argumentBox.y-chipBox.y)<8,'The chip and its argument are adjacent on the same line');
  assert.equal(await page.locator('.conversation-draft-skills').count(),0,'There is no separate badge row');
  const caret=await editor.evaluate(node=>{node.setSelectionRange('$tools:council'.length);return getSelection().getRangeAt(0).getBoundingClientRect().height;});
  assert.ok(caret>10,'The native caret beside a chip keeps normal font height');
  await editor.evaluate(node=>node.setSelectionRange('$tools:council'.length));await editor.press('ArrowLeft');assert.equal(await editor.evaluate(node=>node.selectionStart),0);
  await editor.press('Shift+ArrowRight');assert.deepEqual(await editor.evaluate(node=>[node.selectionStart,node.selectionEnd]),[0,'$tools:council'.length]);
  assert.equal(await chips.getAttribute('class').then(value=>value.includes('ProseMirror-selectednode')),true,'An atomically selected chip is highlighted');

  // Selecting or copying a chip uses the original invocation, not its short label.
  await editor.evaluate(node=>node.setSelectionRange(0,node.value.length));
  const copied=await editor.evaluate(node=>{const data=new DataTransfer();node.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain');});
  assert.equal(copied,'$tools:council confirm');
  await editor.evaluate(node=>{const data=new DataTransfer();node.dispatchEvent(new ClipboardEvent('cut',{clipboardData:data,bubbles:true,cancelable:true}));});
  assert.equal(await value(),'');await editor.press('Control+z');assert.equal(await value(),'$tools:council confirm');assert.equal(await chips.count(),1);
  await editor.press('Control+Shift+z');assert.equal(await value(),'');

  await editor.evaluate(node=>{node.value='$tools:council';node.setSelectionRange(node.value.length);});
  assert.ok(await editor.evaluate(()=>getSelection().getRangeAt(0).getBoundingClientRect().height)>10,'The caret is visible when the chip is the final token');

  await editor.fill('$tools:council confirm');await chips.waitFor();await editor.evaluate(node=>node.setSelectionRange('$tools:council'.length));await editor.press('Backspace');
  assert.equal(await value(),' confirm','Backspace removes a whole chip');await editor.press('Control+z');assert.equal(await value(),'$tools:council confirm');
  await editor.evaluate(node=>node.setSelectionRange(0));await editor.press('Delete');assert.equal(await value(),' confirm','Delete removes a whole chip');
  await editor.press('Control+z');assert.equal(await value(),'$tools:council confirm');

  await editor.evaluate(node=>{node.value='';node.focus();const data=new DataTransfer();data.setData('text/plain','  $tools:council confirm\n\nsecond line  ');data.setData('text/html','<img src=x onerror="window.injected=true">');node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  assert.equal(await value(),'  $tools:council confirm\n\nsecond line  ');assert.equal(await chips.count(),1);assert.equal(await editor.locator('img:not(.ProseMirror-separator)').count(),0);
  await editor.evaluate(node=>node.setSelectionRange(node.value.length));await editor.press('Shift+Enter');await editor.pressSequentially('last');
  assert.equal(await value(),'  $tools:council confirm\n\nsecond line  \nlast');

  // Real Chromium composition: the unfinished IME text must not be replaced with a chip.
  await editor.evaluate(node=>{node.value='';node.focus();});await editor.pressSequentially('x ');const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'$tools:council',selectionStart:14,selectionEnd:14});assert.equal(await chips.count(),0);
  await cdp.send('Input.insertText',{text:'$tools:council'});await chips.waitFor();assert.equal(await value(),'x $tools:council');
  await editor.evaluate(node=>node.setSelectionRange(node.value.length));await editor.pressSequentially(' ');
  await cdp.send('Input.imeSetComposition',{text:'確認',selectionStart:2,selectionEnd:2});assert.equal(await chips.count(),1,'Composing another word keeps existing chips stable');
  await cdp.send('Input.insertText',{text:'確認'});
  for(let i=0;i<3&&await value();i++)await editor.press('Control+z');assert.equal(await value(),'','IME chip formatting preserves all prior undo steps');
  await editor.press('Control+Shift+z');assert.notEqual(await value(),'','IME formatting preserves redo');
  await cdp.detach();

  // A late catalog formats text without consuming or invalidating typing history.
  await page.evaluate(()=>{skillDraft.value='';current={...current,host:'late',owner:'late'};completions.paint();skillDraft.focus();});
  await editor.pressSequentially('$tools:council more');assert.equal(await chips.count(),0);assert.ok(releaseSkills);releaseSkills();await chips.waitFor();
  await editor.press('Control+z');assert.equal(await value(),'','The first undo still removes typing that preceded catalog arrival');
  await editor.press('Control+Shift+z');assert.equal(await value(),'$tools:council more');assert.equal(await chips.count(),1);

  // Changing the target catalog unwraps a mention while retaining its complete source.
  await editor.evaluate(node=>{node.value='$tools:council';node.setSelectionRange(node.value.length);node.focus();});await editor.pressSequentially(' more');
  await page.evaluate(()=>{current={...current,host:'other',owner:'other'};completions.paint();});
  await page.waitForFunction(()=>!skillDraft.querySelector('.conversation-skill'));assert.equal(await value(),'$tools:council more');
  await editor.press('Control+z');assert.equal(await value(),'$tools:council','Unwrapping a chip retains later typing history');
  await editor.press('Control+Shift+z');assert.equal(await value(),'$tools:council more');
  const dropped=await editor.evaluate(node=>{const data=new DataTransfer();data.items.add(new File(['image'],'picture.png',{type:'image/png'}));data.setData('text/plain','https://example.test/picture.png');let files=0;const handler=event=>{files=event.dataTransfer.files.length;event.preventDefault();};node.parentElement.addEventListener('drop',handler,{once:true});const rect=node.getBoundingClientRect();node.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));return files;});
  assert.equal(dropped,1);assert.equal(await value(),'$tools:council more','File drops do not insert an accompanying URL');
  await editor.evaluate(node=>{node.disabled=true;});assert.equal(await editor.getAttribute('contenteditable'),'false');
  await editor.evaluate(node=>{node.disabled=false;});assert.equal(await editor.getAttribute('contenteditable'),'true');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
