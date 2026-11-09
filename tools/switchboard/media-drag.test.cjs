const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('media links drag the current original file in Conversation and Terminal, leaving external links alone',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  try{
    const page=await browser.newPage({viewport:{width:1280,height:844}});page.setDefaultTimeout(5000);
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><link rel="stylesheet" href="/gallery.css"><button id="origin">Preview</button><script src="/gallery.js"></script><script src="/conversation-media.js"></script>'});
      if(url.pathname.startsWith('/api/')||url.origin!=='http://media-drag.test')return route.fulfill({status:404,body:''});
      return route.fulfill({path:path.join(__dirname,'static',path.basename(url.pathname))});
    });
    await page.goto('http://media-drag.test/');
    // A real pointer drag checks the links' native draggable behavior as well as the payload.
    await page.evaluate(()=>{
      document.addEventListener('dragstart',event=>{
        window.dragged={trusted:event.isTrusted,download:event.dataTransfer.getData('DownloadURL'),uri:event.dataTransfer.getData('text/uri-list')};
        event.preventDefault();
      });
      // Canceling a native drag can produce a click on release. Keep that fixture click from closing the viewer.
      document.addEventListener('click',event=>{if(window.dragged){event.preventDefault();event.stopPropagation();}},true);
    });
    const drag=async link=>{
      await page.evaluate(()=>window.dragged=null);
      const box=await link.boundingBox();
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      await page.mouse.move(box.x+box.width/2-60,box.y+box.height/2+40,{steps:10});await page.mouse.up();
      await page.waitForFunction(()=>window.dragged!==null);
      return page.evaluate(()=>window.dragged);
    };
    const first='/repo/first image.png',second='C:\\repo\\clip #1.webm';
    for(const mode of ['conversation','terminal']){
      await page.locator('#origin').focus();
      await page.evaluate(async({mode,first,second})=>{
        if(mode==='conversation')SwitchboardConversationMedia.expand([first,second].map((file,i)=>({url:'/api/hosts/peer/file?path='+encodeURIComponent(file),label:file,kind:i?'video':'image'})),0,document.querySelector('#origin'));
        else await SwitchboardOpenMedia('peer',first,[{path:first},{path:second}]);
      },{mode,first,second});
      const dialog=page.getByRole('dialog'),link=mode==='conversation'?dialog.getByRole('link',{name:'Download',exact:true}):dialog.getByRole('link',{name:'Open original',exact:true});
      for(const [index,file] of [first,second].entries()){
        if(index)await page.keyboard.press('ArrowRight');
        const result=await drag(link),url='http://media-drag.test/api/hosts/peer/file?path='+encodeURIComponent(file);
        assert.equal(result.trusted,true);
        assert.equal(result.download,`application/octet-stream:${file.split(/[\\/]/).pop()}:${url}`);
        assert.equal(result.uri,url,'Ordinary link drag remains available');
      }
      await page.keyboard.press('Escape');
      await page.waitForFunction(()=>document.activeElement.id==='origin'&&!history.state?.switchboardMedia);
    }
    await page.evaluate(()=>SwitchboardConversationMedia.expand([{url:'https://external.example/clip.webm',file:'clip.webm',label:'External clip',kind:'video'}],0,document.querySelector('#origin')));
    const external=await drag(page.getByRole('link',{name:'Download',exact:true}));
    assert.equal(external.download,'','External media is not promoted to a file download drag');
    assert.equal(external.uri,'https://external.example/clip.webm');
  }finally{await browser.close();}
});
