const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

// The sidebar page stays open for days, so every retired terminal frame must be collectable.
test('removed and blanked terminal frames are garbage collected',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the retired frame check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/bridge.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(__dirname+'/static/bridge.js','utf8')});
      if(pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><div id="terminals"></div>'});
      return route.fulfill({contentType:'text/html',body:`<!doctype html><div id="terminal"></div><script>
        window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
        window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){},blur(){},
          _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
      </script><script src="/bridge.js"></script>`});
    });
    await page.goto('https://switchboard.test/');
    const cdp=await page.context().newCDPSession(page);
    const retained=()=>page.evaluate(()=>window.retired.filter(ref=>ref.deref()).length);
    await page.evaluate(async()=>{
      window.retired=[];window.blanked=[];
      const loaded=frame=>new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));
      for(let i=0;i<6;i++){
        const frame=document.createElement('iframe');frame.src=`/hosts/mac/main?frame=${i}`;
        document.getElementById('terminals').append(frame);await loaded(frame);
        window.retired.push(new WeakRef(frame.contentDocument));
        if(i%2)frame.remove();
        else{const done=loaded(frame);frame.src='about:blank';await done;window.blanked.push(frame);}
      }
    });
    for(let i=0;i<8&&await retained();i++){
      await cdp.send('HeapProfiler.collectGarbage');
      await page.waitForTimeout(100);
    }
    assert.equal(await retained(),0,'No retired terminal document survives garbage collection');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
