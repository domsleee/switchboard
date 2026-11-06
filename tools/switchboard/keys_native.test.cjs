const secure = require('./tls-fixture.cjs')(() => env);
const fetch = secure.fetch;
// Keys typed in Switchboard reach the program exactly as in a terminal window:
// the same bytes, in order, promptly, with no Zellij mode in between. Uses a private recovered terminal only.
// PLAYWRIGHT_MODULE=/path/to/playwright node keys_native.test.cjs BINARY
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const binary=path.resolve(process.argv[2]);
const dir=fs.mkdtempSync('/tmp/switchboard-keys-');
const installed=path.join(dir,'zellij'),config=path.join(dir,'config.kdl');
const name='keys-'+crypto.randomBytes(8).toString('hex');
const env={...process.env,HOME:dir,USERPROFILE:dir,ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),TERM:'xterm-256color',ZELLIJ_CONFIG_FILE:config};
for(const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_DIR'])delete env[key];
const cli=(...args)=>execFileSync(installed,['--config',config,...args],{env,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const p=server.address().port;await new Promise(resolve=>server.close(resolve));return p;}
async function until(check,message){for(let n=0;n<150;n++){try{if(await check())return;}catch{}await delay(100);}throw Error(message);}
async function stop(child){if(!child||child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([done,delay(3000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);}
// Records each byte the program reads, with its arrival time, like a raw-mode TUI.
const recorder=`import os,sys,time,tty
tty.setraw(0)
with open(sys.argv[1],'w',buffering=1) as out:
    while True:
        b=os.read(0,1)
        if not b:break
        out.write('%.1f %d\\n'%(time.time()*1000,b[0]))
`;
let native,relay,browser,tokenName,created=false;
(async()=>{
  try{
    fs.copyFileSync(binary,installed);fs.chmodSync(installed,0o755);
    fs.writeFileSync(path.join(dir,'record.py'),recorder);
    fs.writeFileSync(config,'web_sharing "off"\ndefault_shell "/bin/bash"\nshow_startup_tips false\nsession_serialization false\ndisable_session_metadata false\n');
    cli('attach','--create-background',name,'--','/bin/bash','--noprofile','--norc');created=true;
    let pane;
    await until(()=>{pane=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).find(p=>!p.is_plugin);return !!pane;},'Private terminal did not start');
    fs.writeFileSync(config,fs.readFileSync(config,'utf8').replace('web_sharing "off"','web_sharing "on"'));
    const tokenLine=cli('web','--create-token').split('\n').find(line=>line.includes(': '));
    assert.ok(tokenLine);tokenName=tokenLine.split(': ')[0];
    const token=path.join(dir,'token');fs.writeFileSync(token,tokenLine.slice(tokenName.length+2).trim(),{mode:0o600});
    const nativePort=await port(),relayPort=await port(),url='https://127.0.0.1:'+relayPort;
    const hosts=path.join(dir,'hosts.json');fs.writeFileSync(hosts,JSON.stringify({hosts:[{id:'fixture',name:'Private fixture',url:'https://127.0.0.1:'+nativePort,token_file:token,zellij_binary:installed}]}),{mode:0o600});
    native=spawn(installed,['--config',config,'web','--port',String(nativePort)],{env:{...env,SWITCHBOARD_RECOVER_UNSHARED_SESSION:name},stdio:['ignore',fs.openSync(path.join(dir,'native.log'),'a'),fs.openSync(path.join(dir,'native-error.log'),'a')]});
    relay=spawn(installed,['serve','--host-config',hosts,'--port',String(relayPort)],{env,stdio:['ignore',fs.openSync(path.join(dir,'relay.log'),'a'),fs.openSync(path.join(dir,'relay-error.log'),'a')]});
    await until(async()=>{const data=await (await fetch(url+'/api/hosts/fixture')).json();return data.sessions?.some(s=>s.name===name&&s.sharing_recovery&&s.web_clients_allowed);},'Private recovered session did not start');
    browser=await secure.launch(chromium,{headless:true});
    const page=await browser.newPage({viewport:{width:1200,height:800}});page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url+'/?host=fixture&session='+name+'&tab='+pane.tab_id);
    await page.waitForFunction(id=>{const f=document.querySelector('iframe.active'),w=f?.contentWindow;return w?.__zjLastMobileState?.active_pane?.pane_id===id&&!w.term.options.disableStdin&&f.contentDocument.activeElement===w.term.textarea;},pane.id);
    const log=path.join(dir,'bytes.log');
    await page.keyboard.type(`PS1='KEYS_READY> '; clear; python3 ${path.join(dir,'record.py')} ${log}`);await page.keyboard.press('Enter');
    await until(()=>fs.existsSync(log),'Byte recorder did not start');
    await delay(300);
    const sent=[];
    const press=async(key,byte)=>{sent.push({byte,time:Date.now()});await page.keyboard.press(key);};
    // A lone Escape, as when interrupting an agent.
    await press('a',97);await delay(300);
    await press('Escape',27);await delay(300);
    // Escape then typing at once: the reply must not overtake the Escape.
    await press('Escape',27);await press('b',98);await delay(300);
    // A double Escape, as for an agent's history menu.
    await press('Escape',27);await press('Escape',27);await delay(300);
    await press('c',99);await delay(300);
    // Keys Claude Code uses that Zellij's defaults bind to modes (Ctrl+Q quits the
    // session). The browser must deliver them to the program as a terminal does.
    const controls=['h','o','g','b','s','p','n','t',...(process.platform==='darwin'?['k']:[]),'q'];
    for(const letter of controls){await press('Control+'+letter,letter.charCodeAt(0)&0x1f);await delay(150);}
    await press('d',100);
    // Compare whatever arrived, so a lost key shows in the assertion.
    for(let n=0;n<30&&fs.readFileSync(log,'utf8').trim().split('\n').length<sent.length;n++)await delay(100);
    await delay(300);
    const received=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>{const [time,byte]=line.split(' ');return{time:+time,byte:+byte};});
    const latency=received[1].time-sent[1].time;
    console.log(JSON.stringify({binary_sha256:crypto.createHash('sha256').update(fs.readFileSync(installed)).digest('hex'),sent:sent.map(s=>s.byte),received:received.map(r=>r.byte),lone_escape_ms:Math.round(latency)},null,2));
    assert.deepEqual(received.map(r=>r.byte),sent.map(s=>s.byte),'The program reads the same bytes in the same order as typed');
    // The web server holds a bare ESC 50 ms to tell it from a key sequence.
    assert.ok(latency<200,`A lone Escape arrives within 200 ms on loopback (took ${Math.round(latency)} ms)`);
    assert.deepEqual(errors,[]);
  }catch(error){console.error('Private fixture logs:',dir);throw error;}
  finally{if(browser)await browser.close();if(created)try{cli('kill-session',name);}catch{}await stop(relay);await stop(native);if(tokenName)try{cli('web','--revoke-token',tokenName);}catch{}fs.rmSync(path.join(dir,'token'),{force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
