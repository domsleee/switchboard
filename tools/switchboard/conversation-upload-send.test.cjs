const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('Enter sends while an attachment uploads and a failed upload returns the message to the composer',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const root='/home/fixture/.local/share/switchboard/attachments/11111111-2222-4333-8444-555555555555/';
 const replies=[],errors=[];let release=()=>{},gate=Promise.resolve(),uploadStatus=200;
 const holdUpload=()=>{gate=new Promise(resolve=>release=resolve);};
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.setInterval=()=>0;});
  await page.route('http://upload.test/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname;
   if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(p.endsWith('/skills'))return route.fulfill({json:{skills:[]}});
   if(p.endsWith('/codex/reply')){replies.push(route.request().postDataJSON());return route.fulfill({json:{status:'queued'}});}
   if(p.endsWith('/attachments')){await gate;return uploadStatus===200?route.fulfill({json:{path:root+url.searchParams.get('name')}}):route.fulfill({status:uploadStatus,body:'failed'});}
   if(p.endsWith('/file'))return route.fulfill({status:404});
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{session_id:'00000000-0000-4000-8000-000000000001',messages:[],start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{height:100dvh;position:relative}</style><main id="terminals"><section id="artifact-preview" hidden></section></main><script src="/conversation-media.js"></script><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'peer',pane:1,agent:'codex',state:'ready',chatId:'chat-1'};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://upload.test/');
  const draft=page.getByLabel('Reply draft'),outgoing=page.locator('.conversation-outgoing'),notice=page.locator('.conversation-send-notice'),chip=page.locator('.conversation-attachment small');
  await draft.waitFor();
  const attach=async name=>{const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Attach files',exact:true}).click();await (await choosing).setFiles({name,mimeType:'text/plain',buffer:Buffer.from('Notes')});await chip.getByText('Uploading…',{exact:true}).waitFor();};

  // Enter during the upload: the message leaves the composer and goes out once the path exists.
  holdUpload();await attach('notes.txt');await draft.fill('Please read this.');await draft.press('Enter');
  await outgoing.getByText('Please read this.',{exact:true}).waitFor();
  assert.equal(await draft.inputValue(),'','The draft empties without waiting for the upload');
  assert.equal(await notice.isVisible(),false,'Enter is not refused while the upload runs');
  assert.equal(replies.length,0,'Nothing is delivered before the upload has a path');
  release();await page.waitForFunction(()=>document.querySelector('.conversation-outgoing.queued'));
  assert.equal(replies.length,1);assert.equal(replies[0].message,'Please read this.\n\nAttached files:\n'+root+'notes.txt');
  await page.waitForFunction(()=>!document.querySelector('.conversation-attachment'));

  // A failed upload undoes the send: nothing is delivered and the message can be fixed and resent.
  holdUpload();uploadStatus=500;await attach('broken.txt');await draft.fill('Second try.');await draft.press('Enter');
  await outgoing.getByText('Second try.',{exact:true}).waitFor();assert.equal(await draft.inputValue(),'');
  release();await chip.getByText('Upload failed',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Reply draft"]').value==='Second try.');
  await notice.getByText('Could not upload broken.txt. Remove it and try again.',{exact:true}).waitFor();
  assert.equal(replies.length,1,'A failed upload delivers nothing');
  assert.equal(await outgoing.getByText('Second try.',{exact:true}).count(),0,'The message is back in the composer, not also in the transcript');
  await draft.press('Enter');await notice.getByText('Remove failed attachments before sending.',{exact:true}).waitFor();

  await page.getByRole('button',{name:'Remove broken.txt',exact:true}).click();uploadStatus=200;await draft.press('Enter');
  await page.waitForFunction(()=>[...document.querySelectorAll('.conversation-outgoing.queued')].some(node=>node.textContent.includes('Second try.')));
  assert.equal(replies[1].message,'Second try.');
  assert.deepEqual(errors,[]);
 }finally{release();await browser.close();}
});
