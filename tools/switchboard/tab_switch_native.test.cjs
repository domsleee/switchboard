// Real terminal timing in a private recovered session; never attach to user terminals.
// PLAYWRIGHT_MODULE=/path/to/playwright node tab_switch_native.test.cjs BINARY [--measure]
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const binary=path.resolve(process.argv[2]);
const measureOnly=process.argv.includes('--measure');
const dir=fs.mkdtempSync('/tmp/switchboard-tab-switch-');
const installed=path.join(dir,'zellij'),config=path.join(dir,'config.kdl');
const name='tab-switch-'+crypto.randomBytes(8).toString('hex');
const env={...process.env,ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),TERM:'xterm-256color',ZELLIJ_CONFIG_FILE:config};
for(const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_DIR'])delete env[key];
const cli=(...args)=>execFileSync(installed,['--config',config,...args],{env,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const p=server.address().port;await new Promise(resolve=>server.close(resolve));return p;}
async function until(check,message){for(let n=0;n<150;n++){try{if(await check())return;}catch{}await delay(100);}throw Error(message);}
async function stop(child){if(!child||child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([done,delay(3000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);}
let native,relay,browser,tokenName,created=false;
(async()=>{
  try{
    fs.copyFileSync(binary,installed);fs.chmodSync(installed,0o755);
    fs.writeFileSync(config,'web_sharing "off"\ndefault_shell "/bin/bash"\nshow_startup_tips false\nsession_serialization false\ndisable_session_metadata false\n');
    cli('attach','--create-background',name,'--','/bin/bash','--noprofile','--norc');created=true;
    let first;
    await until(()=>{first=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).find(p=>!p.is_plugin);return !!first;},'Private first terminal did not start');
    cli('-s',name,'action','rename-tab','--tab-id',String(first.tab_id),'Switchboard fixture');
    cli('-s',name,'action','new-tab','--name','Shopping fixture','--','/bin/bash','--noprofile','--norc');
    let panes;
    await until(()=>{panes=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).filter(p=>!p.is_plugin).sort((a,b)=>a.tab_position-b.tab_position);return panes.length===2;},'Private terminal tabs did not start');
    // Change only the web service configuration; the existing private engine stays Off.
    fs.writeFileSync(config,fs.readFileSync(config,'utf8').replace('web_sharing "off"','web_sharing "on"'));
    const tokenLine=cli('web','--create-token').split('\n').find(line=>line.includes(': '));
    assert.ok(tokenLine);tokenName=tokenLine.split(': ')[0];
    const token=path.join(dir,'token');fs.writeFileSync(token,tokenLine.slice(tokenName.length+2).trim(),{mode:0o600});
    const nativePort=await port(),relayPort=await port(),url='http://127.0.0.1:'+relayPort;
    const hosts=path.join(dir,'hosts.json');fs.writeFileSync(hosts,JSON.stringify({hosts:[{id:'fixture',name:'Private fixture',url:'http://127.0.0.1:'+nativePort,token_file:token,zellij_binary:installed}]}),{mode:0o600});
    native=spawn(installed,['--config',config,'web','--port',String(nativePort)],{env:{...env,SWITCHBOARD_RECOVER_UNSHARED_SESSION:name},stdio:['ignore',fs.openSync(path.join(dir,'native.log'),'a'),fs.openSync(path.join(dir,'native-error.log'),'a')]});
    relay=spawn(installed,['serve','--host-config',hosts,'--port',String(relayPort)],{env,stdio:['ignore',fs.openSync(path.join(dir,'relay.log'),'a'),fs.openSync(path.join(dir,'relay-error.log'),'a')]});
    await until(async()=>{const data=await (await fetch(url+'/api/hosts/fixture')).json();return data.sessions?.some(s=>s.name===name&&s.sharing_recovery&&s.web_clients_allowed);},'Private recovered session did not start');
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1200,height:800}});page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      const now=()=>performance.timeOrigin+performance.now();
      window.__switchEvents=[];window.__metadataSequence=0;
      const Original=window.WebSocket;
      window.WebSocket=class extends Original{
        constructor(...args){super(...args);if(String(args[0]).includes('/ws/control'))this.addEventListener('message',event=>{try{const m=JSON.parse(event.data);if(m.type==='MobileState'){window.__metadataSequence++;window.__switchEvents.push({type:'metadata',pane:m.payload.active_pane?.pane_id,time:now()});}}catch{}});}
        send(data){try{const m=JSON.parse(data);if(m.payload?.type==='FocusPane')window.__switchEvents.push({type:'focus-sent',pane:m.payload.pane_id,time:now()});}catch{}return super.send(data);}
      };
    });
    await page.goto(url+'/?host=fixture&session='+name+'&tab='+panes[0].tab_id);
    const selectedPane=id=>page.waitForFunction(pane=>{const f=document.querySelector('iframe.active'),w=f?.contentWindow;return w?.__zjLastMobileState?.active_pane?.pane_id===pane&&!w.term.options.disableStdin&&f.contentDocument.activeElement===w.term.textarea;},id);
    const choose=async pane=>{const index=await page.evaluate(id=>[...document.querySelectorAll('#tabs button')].findIndex(b=>b._item?.tab.id===id),pane.tab_id);assert.ok(index>=0);await page.locator('#tabs button').nth(index).click();await selectedPane(pane.id);};
    await page.waitForSelector('#tabs button');await selectedPane(panes[0].id);
    const screen=()=>page.evaluate(()=>{const term=document.querySelector('iframe.active').contentWindow.term;return Array.from({length:term.rows},(_,n)=>term.buffer.active.getLine(term.buffer.active.viewportY+n)?.translateToString()).join('\n');});
    for(const [index,pane]of panes.entries()){
      await choose(pane);
      // Unique prompts prove a real terminal redraw, without matching echoed commands.
      await page.keyboard.type(`SB_FIXTURE_TAB=${index}; PS1='FIXTURE_${index}_READY> '; clear`);await page.keyboard.press('Enter');
      await until(async()=>(await screen()).trimEnd().endsWith('FIXTURE_'+index+'_READY>'),'Private shell prompt did not render');
    }
    await page.evaluate(()=>{
      const f=document.querySelector('iframe.active'),w=f.contentWindow,now=()=>performance.timeOrigin+performance.now();
      document.addEventListener('click',event=>{if(event.target.closest('#tabs button')&&window.__switchSample)window.__switchSample.click=now();},true);
      document.addEventListener('click',()=>{const sample=window.__switchSample;if(sample?.click&&document.querySelector('#tabs .selected')?._item.tab.panes.some(p=>p.pane_id===sample.pane&&!p.is_plugin))sample.selected=now();});
      w.term.onRender(()=>{const sample=window.__switchSample;if(!sample||sample.render)return;const text=Array.from({length:w.term.rows},(_,n)=>w.term.buffer.active.getLine(w.term.buffer.active.viewportY+n)?.translateToString()).join('\n');if(text.includes(sample.prompt))sample.render=now();});
      function ready(){const sample=window.__switchSample;if(sample?.click&&!sample.input&&w.__zjLastMobileState?.active_pane?.pane_id===sample.pane&&!w.term.options.disableStdin&&f.contentDocument.activeElement===w.term.textarea)sample.input=now();requestAnimationFrame(ready);}ready();
    });
    const timings=[];
    for(let index=0;index<6;index++){
      const pane=panes[index%2];
      // Exercise the expensive phase just after a background metadata poll, not
      // a lucky click immediately before the next scheduled poll.
      const sequence=await page.evaluate(()=>document.querySelector('iframe.active').contentWindow.__metadataSequence);
      await page.waitForFunction(previous=>document.querySelector('iframe.active').contentWindow.__metadataSequence>previous,sequence);
      await page.evaluate(({pane,prompt})=>{window.__switchSample={pane,prompt};document.querySelector('iframe.active').contentWindow.__switchEvents=[];},{pane:pane.id,prompt:'FIXTURE_'+index%2+'_READY>'});
      await choose(pane);
      await page.waitForFunction(()=>window.__switchSample.render&&window.__switchSample.input);
      const timing=await page.evaluate(()=>{const s=window.__switchSample,events=document.querySelector('iframe.active').contentWindow.__switchEvents;return{selected_ms:s.selected-s.click,focus_sent_ms:events.find(e=>e.type==='focus-sent')?.time-s.click,render_ms:s.render-s.click,metadata_ms:events.find(e=>e.type==='metadata'&&e.pane===s.pane)?.time-s.click,input_ready_ms:s.input-s.click};});
      timings.push(timing);
      const marker=crypto.randomBytes(8).toString('hex');
      await page.keyboard.type(`printf '%s%s%s\\n' 'INPUT_${index}_' "$SB_FIXTURE_TAB" '_${marker}'`);await page.keyboard.press('Enter');
      await until(async()=>(await screen()).includes('INPUT_'+index+'_'+index%2+'_'+marker),'Typing immediately after focus did not reach the selected shell');
    }
    // Repeated choices can replace a command while its acknowledgment is in
    // flight. The existing bridge must still gate input until the final pane.
    await page.evaluate(ids=>{window.__switchSample=null;for(const id of ids)[...document.querySelectorAll('#tabs button')].find(b=>b._item.tab.id===id).click();},[panes[0].tab_id,panes[1].tab_id]);
    await selectedPane(panes[1].id);
    const rapidMarker=crypto.randomBytes(8).toString('hex');
    await page.keyboard.type(`printf '%s%s%s\\n' 'RAPID_' "$SB_FIXTURE_TAB" '_${rapidMarker}'`);await page.keyboard.press('Enter');
    await until(async()=>(await screen()).includes('RAPID_1_'+rapidMarker),'Rapid switching must route input to the final selected shell');
    console.log(JSON.stringify({kind:'disposable real recovered terminal',binary_sha256:crypto.createHash('sha256').update(fs.readFileSync(installed)).digest('hex'),timings},null,2));
    assert.deepEqual(errors,[]);
    if(!measureOnly)for(const timing of timings){assert.ok(timing.selected_ms<100,'Selected row responds within 100 ms');assert.ok(timing.render_ms<500,'Native terminal redraw completes within 500 ms on loopback');assert.ok(timing.input_ready_ms<500,'Focus and input do not wait for the 1 s metadata poll');}
  }catch(error){console.error('Private fixture logs:',dir);throw error;}
  finally{if(browser)await browser.close();if(created)try{cli('kill-session',name);}catch{}await stop(relay);await stop(native);if(tokenName)try{cli('web','--revoke-token',tokenName);}catch{}fs.rmSync(path.join(dir,'token'),{force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
