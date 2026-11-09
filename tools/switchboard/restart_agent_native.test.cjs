// Private native engine + real restart endpoint + browser menu; no model calls or user sessions.
// PLAYWRIGHT_MODULE=/path/to/playwright node restart_agent_native.test.cjs BINARY
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const binary=path.resolve(process.argv[2]);

const dir=fs.mkdtempSync('/tmp/switchboard-restart-agent-');
const installed=path.join(dir,'zellij'),config=path.join(dir,'config.kdl');
const name='restart-agent-'+crypto.randomBytes(8).toString('hex');
const env={...process.env,PATH:dir+path.delimiter+process.env.PATH,HOME:dir,CODEX_HOME:path.join(dir,'.codex'),CLAUDE_CONFIG_DIR:path.join(dir,'.claude'),ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),TERM:'xterm-256color',ZELLIJ_CONFIG_FILE:config};
for(const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_PANE_ID','ZELLIJ_CONFIG_DIR'])delete env[key];
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
    const fixture=path.join(dir,'codex'),c=path.join(dir,'agent.c'),queue=path.join(dir,'queue.cjs');
    fs.writeFileSync(queue,`const fs=require('node:fs'),readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id===undefined)return;let result={};if(request.method==='thread/queue/list')result={data:[],nextCursor:null};if(request.method==='thread/queue/add'){const p=request.params;fs.writeFileSync(${JSON.stringify(path.join(dir,'queued'))},['--thread',p.threadId,'--message='+p.input[0].text].join('\\n')+'\\n');result={queuedSubmission:{id:'fixture-item',clientUserMessageId:p.clientUserMessageId,input:p.input}};}process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');});`);
    fs.writeFileSync(c,`#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <fcntl.h>
int main(int argc,char**argv){if(argc>1&&strcmp(argv[1],"queue")==0){if(argc!=5)return 2;FILE*q=fopen(${JSON.stringify(path.join('/PLACEHOLDER','queued'))},"a");if(!q)return 3;for(int i=2;i<argc;i++)fprintf(q,"%s\\n",argv[i]);fclose(q);return 0;}fcntl(0,F_SETFL,O_NONBLOCK);FILE*f=fopen(${JSON.stringify(path.join('/PLACEHOLDER','launches'))},"a");fprintf(f,"%d",getpid());for(int i=1;i<argc;i++)fprintf(f,"|%s",argv[i]);fprintf(f,"\\n");fclose(f);char previous[64]="";for(;;){char input[4096];int count=read(0,input,sizeof(input));if(count>0){f=fopen(${JSON.stringify(path.join('/PLACEHOLDER','input'))},"a");fwrite(input,1,count,f);fclose(f);previous[0]=0;}char mode[64]="ready";f=fopen(${JSON.stringify(path.join('/PLACEHOLDER','mode'))},"r");if(f){fgets(mode,64,f);fclose(f);}if(strcmp(mode,previous)){printf("\\033[2J\\033[H\\033]0;codex - Restart fixture\\007Worked for 1s\\r\\n\\r\\n› %s\\r\\nGPT-6 · ? for shortcuts\\r\\n",strcmp(mode,"draft")==0?"unsent draft":strcmp(mode,"multiline")==0?"\\r\\n  unsent draft":"Ask Codex to do anything");fflush(stdout);strcpy(previous,mode);}usleep(100000);}}`.replaceAll('/PLACEHOLDER',dir));
    fs.writeFileSync(c,fs.readFileSync(c,'utf8').replace('if(argc>1&&strcmp(argv[1],"queue")==0)',`if(argc>1&&strcmp(argv[1],"app-server")==0){execl(${JSON.stringify(process.execPath)},${JSON.stringify(process.execPath)},${JSON.stringify(queue)},(char*)NULL);return 3;}if(argc>1&&strcmp(argv[1],"queue")==0)`));
    execFileSync(process.platform==='darwin'?'xcrun':'cc',process.platform==='darwin'?['clang','-isysroot',execFileSync('xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim(),c,'-o',fixture]:[c,'-o',fixture]);
    cli('attach','--create-background',name,'--','/bin/bash','--noprofile','--norc','-c','exec codex --model fixture "initial prompt"');created=true;
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
    const sid='11111111-2222-4333-8444-555555555555';
    const transcript=path.join(env.CODEX_HOME,'sessions','fixture.jsonl');fs.mkdirSync(path.dirname(transcript),{recursive:true});
    fs.writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{id:sid,cwd:dir}})+'\n');
    const hook=async (event,paneId=first.id)=>{const response=await fetch(url+'/api/agent-hook',{method:'POST',headers:{'Content-Type':'application/json','x-agent':'codex','x-zellij-session':name,'x-zellij-pane':String(paneId)},body:JSON.stringify({hook_event_name:event,session_id:sid,transcript_path:transcript,cwd:dir})});assert.equal(response.status,204);};
    await hook('Stop');
    let state;await until(async()=>{const data=await(await fetch(url+'/api/attention')).json();state=data.panes.find(p=>p.pane_id===first.id&&p.session===name);return state?.restart_available;},'Agent process was not bound to its pane');
    const target={session:name,pane_id:first.id,tab_id:first.tab_id,chat_id:state.chat_id};
    const restart=body=>fetch(url+'/api/hosts/fixture/restart-agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await restart({...target,chat_id:'wrong'})).status,409);
    await hook('UserPromptSubmit');assert.equal((await restart(target)).status,409);await hook('Stop');
    fs.writeFileSync(path.join(dir,'mode'),'draft');
    await until(()=>cli('-s',name,'action','dump-screen','-p',String(first.id)).includes('unsent draft'),'Draft did not render');
    assert.equal((await restart(target)).status,409);
    fs.writeFileSync(path.join(dir,'mode'),'multiline');
    await until(()=>/› *\n +unsent draft/.test(cli('-s',name,'action','dump-screen','-p',String(first.id))),'Multiline draft did not render');
    assert.equal((await restart(target)).status,409);
    fs.writeFileSync(path.join(dir,'mode'),'ready');
    await until(()=>!cli('-s',name,'action','dump-screen','-p',String(first.id)).includes('unsent draft'),'Draft did not clear');
    const untouched=panes[1],launches=()=>fs.readFileSync(path.join(dir,'launches'),'utf8').trim().split('\n');
    assert.equal(launches().length,1);
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1200,height:800}});
    await page.goto(url+'/?host=fixture&session='+name+'&tab='+first.tab_id);
    await page.waitForSelector('#tabs .tab-select');
    await page.evaluate(id=>activate(allTabs().find(i=>i.tab.id===id)),first.tab_id);
    await until(()=>page.evaluate(id=>allTabs().find(i=>i.key===selected)?.entry.state?.active_pane?.pane_id===id,first.id),'Fixture agent was not selected');
    await page.evaluate(id=>openTabMenu(allTabs().find(i=>i.tab.id===id),220,70),first.tab_id);
    await until(()=>page.locator('#restart-agent').isEnabled(),'Menu restart did not enable');
    await page.locator('#tab-menu').screenshot({path:path.join(dir,'restart-menu.png')});
    await page.locator('#restart-agent').evaluate(el=>el.hidden=true);
    await page.locator('#tab-menu').screenshot({path:path.join(dir,'restart-menu-before.png')});
    await page.locator('#restart-agent').evaluate(el=>el.hidden=false);
    const response=page.waitForResponse(r=>r.url().endsWith('/restart-agent'));
    await page.getByRole('menuitem',{name:'Restart & resume'}).click();
    const result=await response;assert.equal(result.status(),200);
    // The restart response can precede the replacement's first pane snapshot.
    let replacement;
    await until(()=>{replacement=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).find(p=>!p.is_plugin&&p.tab_id===first.tab_id&&p.id!==first.id);return replacement;},'Replacement pane was not published');
    assert.ok(replacement);const restarted={pane_id:replacement.id,tab_id:replacement.tab_id};assert.notEqual(restarted.pane_id,first.id);
    await until(()=>launches().length===2,'Replacement did not start');
    assert.equal(launches()[1].split('|').slice(1).join('|'),'--model|fixture|resume|'+sid);
    assert.notEqual(launches()[1].split('|')[0],launches()[0].split('|')[0]);
    const after=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).filter(p=>!p.is_plugin);
    assert.equal(after.length,2);assert.ok(after.some(p=>p.id===untouched.id&&p.tab_id===untouched.tab_id));
    assert.ok(after.some(p=>p.id===restarted.pane_id&&p.tab_id===first.tab_id));
    assert.equal((await restart(target)).status,409,'Duplicate stale request cannot restart the replacement');
    await hook('Stop',restarted.pane_id);
    await until(async()=>{await page.evaluate(()=>refreshAttention(true));return page.evaluate(id=>[...paneAttention.values()].some(p=>p.pane_id===id&&p.chat_id),restarted.pane_id);},'Resumed agent did not bind its conversation');
    await page.getByRole('button',{name:'Conversation',exact:true}).click();
    // The initial transcript response supplies the native thread ID used for replies.
    await page.locator('.conversation-notice').waitFor({state:'hidden'});
    await page.getByLabel('Reply draft').fill('native conversation reply');
    await until(()=>page.getByRole('button',{name:'Send',exact:true}).isEnabled(),'Conversation reply did not become ready');
    const replyResponse=page.waitForResponse(r=>r.url().endsWith('/codex/reply'));
    await page.getByLabel('Reply draft').press('Enter');
    const reply=await replyResponse;assert.equal(reply.status(),200);assert.equal((await reply.json()).status,'queued');
    await until(()=>fs.existsSync(path.join(dir,'queued')),'Saved reply did not reach the structured native queue');
    assert.deepEqual(fs.readFileSync(path.join(dir,'queued'),'utf8').trimEnd().split('\n'),['--thread',sid,'--message=native conversation reply']);
    assert.equal(launches().length,2,'Queueing must not start another interactive agent');
    assert.equal(fs.existsSync(path.join(dir,'input')),false,'Native replies must not type into the terminal');
    await until(async()=>await page.getByLabel('Reply draft').inputValue()==='','Sent draft did not clear');
    assert.equal(await page.locator('.conversation-panel').isVisible(),true);
    // A provider switch reuses the guarded replacement path. Fake aliases keep
    // this an isolated process/argv test without contacting either provider.
    fs.appendFileSync(transcript,JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'Original task',images:[],local_images:[]}})+'\n');
    await hook('Stop',restarted.pane_id);
    let switchState;await until(async()=>{const data=await(await fetch(url+'/api/attention')).json();switchState=data.panes.find(p=>p.pane_id===restarted.pane_id);return switchState?.restart_available;},'Source agent did not bind before handover');
    const switchTarget={session:name,pane_id:restarted.pane_id,tab_id:first.tab_id,chat_id:switchState.chat_id};
    const handoverPrompt='Read the context file and continue. Literal $(text)\nKeep the current worktree.';
    const handover={model:'c',prompt:handoverPrompt,source_messages:1};
    assert.equal((await restart({...switchTarget,handover:{...handover,source_messages:0}})).status,409,'A changed transcript must be reloaded');
    await hook('UserPromptSubmit',restarted.pane_id);
    assert.equal((await restart({...switchTarget,handover,confirm_interrupt:true})).status,409,'Provider switches never interrupt working agents');
    await hook('Stop',restarted.pane_id);
    fs.writeFileSync(path.join(dir,'.bashrc'),'');
    assert.equal((await restart({...switchTarget,handover})).status,409,'Unavailable model aliases leave the source intact');
    assert.equal(launches().length,2);
    fs.writeFileSync(path.join(dir,'.bashrc'),"c() { exec '"+fixture.replaceAll("'","'\\''")+"' \"$@\"; }\n");
    const switched=await restart({...switchTarget,handover});assert.equal(switched.status,200,await switched.clone().text());
    const switchedTarget=await switched.json();assert.equal(switchedTarget.tab_id,first.tab_id);
    await until(()=>launches().length===4,'The destination provider did not launch');
    assert.equal(launches()[2].split('|').slice(1).join('|'),'--|'+handoverPrompt.split('\n')[0]);
    // The fixture records argv with newlines unchanged, so the second prompt
    // line occupies the following log line rather than a new shell command.
    assert.ok(fs.readFileSync(path.join(dir,'launches'),'utf8').includes(handoverPrompt));
    assert.ok(JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).some(p=>p.id===untouched.id),'The other terminal remains running');
    console.log('PASS: real menu + endpoint restarted only the intended agent, retained tab and other pane, resumed exact UUID and flags, rejected busy/draft/stale targets. Screenshots: '+dir);
  }catch(error){console.error('Private fixture logs:',dir);throw error;}
  finally{if(browser)await browser.close();if(created)try{cli('kill-session',name);}catch{}await stop(relay);await stop(native);if(tokenName)try{cli('web','--revoke-token',tokenName);}catch{}fs.rmSync(path.join(dir,'token'),{force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
