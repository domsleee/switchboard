// A transcript reader over existing terminals. No provider process is started here.
(() => {
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
  function textBlocks(parent,text){
    text.split('```').forEach((block,i)=>{
      if(i%2){const pre=el('pre');pre.append(el('code',block.replace(/^\w*\n/,'')));parent.append(pre);return;}
      for(const paragraph of block.trim().split(/\n\s*\n/)){
        if(!paragraph)continue;const p=el('p');paragraph.split('`').forEach((part,j)=>p.append(j%2?el('code',part):document.createTextNode(part)));parent.append(p);
      }
    });
  }
  window.SwitchboardConversation={install({selection,terminal,modeChanged=()=>{},viewed=()=>{}}){
    const root=document.getElementById('terminals'),drafts=new Map(),attachments=new Map(),retryKeys=new Map();
    const mobile=matchMedia('(max-width:700px), (pointer:coarse) and (max-width:1000px)').matches;
    const modeKey=mobile?'switchboard-mobile-view-mode':'switchboard-view-mode';
    let savedMode;try{savedMode=localStorage.getItem(modeKey);}catch{}
    let target=null,open=savedMode? savedMode==='conversation':mobile,generation=0,startCursor=0,tailCursor=0,nextCursor=null,messages=[],loading=false,loaded=false,lastPaint=null,modeRevision=0,navigationRevision=0;
    const outgoing=new Map(),consumedTranscript=new Map(),pendingSends=new Map(),startups=new Map(),draftVersions=new Map();
    const conversations=new Map();
    let stream=null,streamReady=false,streamSupported=false,streamPages=[],restorePosition=null;
    async function prepare(){
      if(!open||document.hidden||!target||target.agent!=='codex'||!target.session||!Number.isInteger(target.tab))return;
      if(target.chatId&&['ready','working'].includes(target.state))return;
      const destination=target,key=identity(destination),startup=startupState();
      if(!startup||startup.pending||startup.error||Date.now()-startup.started>=30000||Date.now()-(startup.at||0)<5000)return;
      startup.at=Date.now();startup.pending=true;
      try{const response=await fetch('/api/hosts/'+encodeURIComponent(destination.host)+'/conversation/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:destination.session,tab_id:destination.tab,pane_id:destination.pane}),signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error(response.status===404?'Update Switchboard on this computer to prepare the agent.':'Could not prepare this agent. Retry or open Terminal.');}
      catch(error){startup.error=error.name==='TimeoutError'?'Agent preparation timed out. Retry or open Terminal.':error.message||'Could not reach this agent. Retry or open Terminal.';}
      finally{startup.pending=false;if(identity(target)===key&&!chat){status(unboundNotice());updateActivity();}}
    }
    function stopStream(){stream?.close();stream=null;streamReady=false;streamPages=[];}
    function streamPage(data){applyPage(data,'poll',nextCursor??tailCursor);status(partialNotice(data),!data.partial);}
    function startStream(){
      if(stream||!streamSupported||!open||document.hidden||!target||!chat||!loaded)return;
      const version=generation,source=new EventSource('/api/chats/'+encodeURIComponent(chat.id)+'/stream?'+new URLSearchParams({host:target.chatHost||target.host,cursor:nextCursor??tailCursor,limit:50}));stream=source;
      source.addEventListener('page',event=>{
        if(version!==generation||source!==stream)return;
        try{const data=JSON.parse(event.data);if(data.error||!Array.isArray(data.messages))throw Error();streamReady=true;if(loading)streamPages.push(data);else streamPage(data);}
        catch{stopStream();load();}
      });
      source.onopen=()=>{if(source===stream)streamReady=true;};
      source.onerror=()=>{if(source===stream){streamReady=false;load();}};
    }
    const modes=el('div',undefined,'conversation-modes');modes.hidden=true;modes.setAttribute('role','group');modes.setAttribute('aria-label','View mode');
    const back=el('button','Terminal'),toggle=el('button','Conversation','conversation-toggle');back.type=toggle.type='button';back.setAttribute('aria-pressed',String(!open));toggle.setAttribute('aria-pressed',String(open));modes.append(back,toggle);root.append(modes);
    const panel=el('section',undefined,'conversation-panel');panel.hidden=true;panel.tabIndex=-1;panel.setAttribute('aria-label','Agent conversation');
    const header=el('header'),heading=el('div',undefined,'conversation-heading'),title=el('strong'),model=el('span',undefined,'conversation-model'),activity=el('span',undefined,'conversation-activity'),terminalAction=el('button','Open Terminal','conversation-terminal-action');model.title='Last reported model';activity.setAttribute('role','status');terminalAction.type='button';terminalAction.hidden=true;terminalAction.onclick=()=>show(false);heading.append(title);header.append(heading,activity,terminalAction);
    const notice=el('p','Loading this terminal’s conversation…','conversation-notice');notice.setAttribute('role','status');
    const list=el('div',undefined,'conversation-messages'),older=el('button','Load older messages'),refresh=el('button','↻'),latest=el('button','↓');refresh.setAttribute('aria-label','Refresh');refresh.title='Refresh conversation';latest.setAttribute('aria-label','Scroll to bottom');latest.title='Scroll to bottom';older.hidden=true;
    const working=el('div',undefined,'conversation-working');working.append(el('span'),el('span'),el('span'));working.hidden=true;working.setAttribute('aria-hidden','true');
    const recovery=el('div',undefined,'conversation-recovery'),retryConnection=el('button','Retry connection');recovery.hidden=true;retryConnection.type='button';retryConnection.onclick=()=>{if(target)startups.delete(identity(target));status(unboundNotice());updateActivity();prepare();};recovery.append(retryConnection);
    const historyStatus=el('span',undefined,'conversation-history-status');historyStatus.hidden=true;historyStatus.setAttribute('role','status');
    const actions=el('div',undefined,'conversation-actions');actions.append(refresh,latest);list.append(older,working);latest.hidden=refresh.hidden=true;
    const form=el('form',undefined,'conversation-compose'),draft=el('textarea'),insert=el('button','↑');draft.rows=1;draft.maxLength=16000;draft.placeholder='Message…';draft.setAttribute('aria-label','Reply draft');insert.type='submit';insert.setAttribute('aria-label','Send');insert.title='Send message';const attach=el('button','+','conversation-attach'),picker=el('input'),files=el('div',undefined,'conversation-attachments');attach.type='button';attach.setAttribute('aria-label','Attach files');attach.title='Attach photos or files';picker.type='file';picker.multiple=true;picker.hidden=true;files.hidden=true;form.append(files,attach,draft,model,insert,picker);
    const sendNotice=el('small',undefined,'conversation-send-notice');sendNotice.hidden=true;sendNotice.setAttribute('role','status');form.append(sendNotice);
    const transportNotice=el('small','Replies use Terminal briefly, then return here.','conversation-transport-notice');transportNotice.hidden=true;form.append(transportNotice);
    let sendNoticeReceipt=null;
    function sendStatus(text,receipt=null){const follow=nearBottom();sendNoticeReceipt=receipt;if(sendNotice.textContent!==text)sendNotice.textContent=text;sendNotice.hidden=!text;if(form.isConnected){sizeDraft();if(follow){list.scrollTop=list.scrollHeight;updateLatest();}}}
    panel.append(header,notice,recovery,list,historyStatus,actions,form);root.append(panel);
    const identity=t=>t?JSON.stringify([t.key,t.chatId]):null;
    let chat=null;
    const binding=()=>chat;
    const pendingFor=(key=identity(target))=>pendingSends.get(key);
    function status(text,quiet=false){if(notice.textContent!==text)notice.textContent=text;notice.hidden=quiet;}
    function modelLabel(value){
      const raw=String(value?.model||'');
      const name=/^gpt-\d+(?:\.\d+)?-(?:sol|astra|luna|terra)(?:-codex)?$/i.test(raw)?raw.replace(/^gpt-/i,'').replace(/-/g,' ').replace(/\b[a-z]/g,char=>char.toUpperCase()):/^claude-(opus|sonnet|haiku)-\d+(?:-\d+)?(?:-\d{8})?$/i.test(raw)?raw.replace(/^claude-/i,'').replace(/-\d{8}$/,'').replace(/^(opus|sonnet|haiku)-(\d+)-(\d+)$/i,'$1 $2.$3').replace(/-/g,' ').replace(/^\w/,char=>char.toUpperCase()):raw;
      return name?[name,value.reasoning_effort].filter(Boolean).join(' · '):'';
    }
    function providerLabel(){const agent=target?.agent||chat?.agent;return agent?agent[0].toUpperCase()+agent.slice(1):'Assistant';}
    function agentLabel(){return modelLabel(chat)||providerLabel();}
    function updateActivity(){
      const state=target?.state,label=state==='working'?'Working…':state==='approval'?'Approval needed':state==='input'?'Input needed':state==='waiting'?'Waiting on an agent':state==='ready'?'Ready':'';
      const name=chat||target?.agent?agentLabel():'';if(model.textContent!==name)model.textContent=name;
      if(activity.textContent!==label)activity.textContent=label;
      activity.classList.toggle('working',state==='working');
      const follow=nearBottom();working.hidden=state!=='working'||!chat;
      if(follow)list.scrollTop=list.scrollHeight;
      const startup=startupState(),stalled=!!startup&&(!!startup.error||Date.now()-startup.started>=30000);
      terminalAction.hidden=!['approval','input'].includes(state)&&!stalled;recovery.hidden=!stalled||!!chat;
      insert.disabled=!!pendingFor();
      transportNotice.hidden=!chat||!(target?.terminalReady===false&&target?.agent!=='claude'&&!(target?.agent==='codex'&&/^[0-9a-f-]{36}$/.test(chat.thread||'')));
      insert.setAttribute('aria-label',transportNotice.hidden?'Send':'Send via Terminal');insert.title=transportNotice.hidden?'Send message':'Send via Terminal and return to Conversation';
    }
    function startupState(){if(!target||chat||!target.agent&&!target.starting)return null;const key=identity(target);if(!startups.has(key)&&open&&!document.hidden)startups.set(key,{started:Date.now()});return startups.get(key);}
    function unboundNotice(){const startup=startupState();return startup?.error||(startup&&Date.now()-startup.started>=30000?'The agent has not connected. Retry or open Terminal.':target?.starting?'Starting agent…':target?.agent?'Connecting to this agent’s conversation…':'No agent');}
    function busy(value){loading=value;older.disabled=refresh.disabled=value;}
    function focusSurface(){if(!panel.hidden)(form.hidden?panel:draft).focus({preventScroll:true});}
    function show(value,transient=false){if(!transient)modeRevision++;if(!value){stopStream();loadRequest?.abort();window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();}open=value;root.classList.toggle('conversation-open',open);modeChanged();if(!transient)try{localStorage.setItem(modeKey,value?'conversation':'terminal');}catch{}panel.hidden=!value;toggle.setAttribute('aria-pressed',String(value));back.setAttribute('aria-pressed',String(!value));if(value){document.getElementById('artifact-preview').hidden=true;update();if(loaded){paint(false,restorePosition===null&&lastPaint===null);if(restorePosition!==null){list.scrollTop=restorePosition.follow?list.scrollHeight:restorePosition.position;restorePosition=null;updateLatest();}}if(binding())load(loaded?'poll':'initial');startStream();focusSurface();}else if(target)terminal(target);viewport();}

    toggle.onclick=()=>show(true);back.onclick=()=>show(false);
    let loadRequest=null,lastFailure=null,lastDiagnostic='',lastDiagnosticAt=0,newOutput=false,scrollIdle;
    function reportLoad(phase,outcome,started){
      const now=Date.now(),key=phase+':'+outcome;
      if(key===lastDiagnostic&&now-lastDiagnosticAt<60000)return;
      lastDiagnostic=key;lastDiagnosticAt=now;
      void fetch('/api/diagnostics/conversation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase,outcome,elapsed_ms:Math.min(120000,Math.round(performance.now()-started))})}).catch(()=>{});
    }
    async function get(url,signal){
      const response=await fetch(url,{signal});
      if(!response.ok)throw Object.assign(Error('The conversation could not be loaded. Retrying…'),{code:'http'});
      let data;try{data=await response.json();}catch{throw Object.assign(Error('The conversation response was incomplete. Retrying…'),{code:'invalid_response'});}
      if(data.error)throw Object.assign(Error('The conversation is temporarily unavailable. Retrying…'),{code:'http'});
      if(!Array.isArray(data.messages))throw Object.assign(Error('The conversation response was incomplete. Retrying…'),{code:'invalid_response'});
      return data;
    }
    function partialNotice(data){
      if(!data.partial)return '';
      const reasons=data.partial_reasons||[];
      if(reasons.includes('file_limit')||reasons.includes('message_limit'))return 'Update the conversation’s computer to read its complete history.';
      if(reasons.includes('record_limit'))return 'An oversized history record was skipped. Later messages can still load.';
      if(reasons.includes('malformed_record'))return 'An unreadable history record was skipped. Other messages are still available.';
      return 'Some history is unavailable. Showing the messages that could be read.';
    }
    const rendered=new Map(),renderedOutgoing=new Map();
    function setupMessage(item){return item.role==='user'&&/^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<skills_instructions>)/.test((item.text||'').trimStart());}
    function normalizeMessage(value){return String(value||'').replace(/\r\n/g,'\n');}
    function sameMessage(a,b){return normalizeMessage(a)===normalizeMessage(b);}
    function outgoingLabel(state){return state==='sending'?'Sending…':state==='queued'?'Queued':state==='sent'?'Sent':'Could not confirm sending';}
    function sendItem(sent,state,detail){sent.state=state;sent.detail=detail||'';if(identity(target)===sent.key)paint();}
    function nearBottom(){return list.scrollHeight-list.scrollTop-list.clientHeight<80;}
    let following=true,readingAnchor=null,resizeFrame=null;
    function rememberReading(){
      following=nearBottom();
      if(following){readingAnchor=null;return;}
      const top=list.getBoundingClientRect().top,node=[...list.querySelectorAll('.conversation-message')].find(node=>node.getBoundingClientRect().bottom>top);
      readingAnchor=node?{node,id:node.dataset.conversationEntry,offset:node.getBoundingClientRect().top-top}:null;
    }
    const contentResize=globalThis.ResizeObserver?new ResizeObserver(()=>{
      if(resizeFrame!==null)return;
      resizeFrame=requestAnimationFrame(()=>{resizeFrame=null;if(panel.hidden||!loaded)return;
        if(following)list.scrollTop=list.scrollHeight;
        else if(readingAnchor){const node=readingAnchor.node.isConnected?readingAnchor.node:[...list.querySelectorAll('.conversation-message')].find(node=>node.dataset.conversationEntry===readingAnchor.id);if(node)list.scrollTop+=node.getBoundingClientRect().top-list.getBoundingClientRect().top-readingAnchor.offset;}
        updateLatest();rememberReading();
      });
    }):null;
    contentResize?.observe(list);contentResize?.observe(working);
    if(globalThis.ResizeObserver)new ResizeObserver(()=>panel.style.setProperty('--conversation-header-height',header.offsetHeight+'px')).observe(header);
    function updateLatest(){latest.hidden=nearBottom();if(latest.hidden)newOutput=false;latest.textContent=newOutput?'↓ New messages':'↓ Latest';actions.hidden=latest.hidden&&refresh.hidden;}
    list.addEventListener('scroll',()=>{rememberReading();list.classList.add('scrolling');clearTimeout(scrollIdle);scrollIdle=setTimeout(()=>list.classList.remove('scrolling'),700);updateLatest();if(loaded&&startCursor>0&&list.scrollTop<80&&!loading&&older.hidden)load('older');},{passive:true});
    function paint(prepend=false,initial=false){
      const key=identity(target),sentItems=outgoing.get(key)||[],used=consumedTranscript.get(key)||new Set();
      for(const sent of sentItems){
        if(sent.transcriptCursor!==undefined)continue;
        const match=messages.findIndex((item,offset)=>startCursor+offset>sent.baseline&&item.role==='user'&&!used.has(startCursor+offset)&&sameMessage(item.receipt_text??item.text??'',sent.payload));
        if(match>=0){sent.transcriptCursor=startCursor+match;used.add(sent.transcriptCursor);if(pendingFor(sent.key)===sent){pendingSends.delete(sent.key);sent.request?.abort();}clearSentDraft(sent);}
      }
      consumedTranscript.set(key,used);
      outgoing.set(key,sentItems.filter(item=>item.transcriptCursor===undefined));
      const visibleOutgoing=sentItems.filter(item=>item.transcriptCursor===undefined);
      const snapshot=JSON.stringify([messages,visibleOutgoing.map(({id,text,files,state,detail})=>({id,text,files:files.map(file=>file.name),state,detail}))]);if(snapshot===lastPaint)return;
      lastPaint=snapshot;
      const follow=initial||nearBottom(),height=list.scrollHeight,position=list.scrollTop,keys=new Set();
      if(!follow&&!prepend&&!initial)newOutput=true;
      older.hidden=true;
      let previous=older,previousRole=null,previousSpeaker=null;
      for(const [offset,item] of messages.entries()){
        if(setupMessage(item))continue;
        const key=startCursor+offset,signature=JSON.stringify(item),speaker=item.role==='user'?'You':providerLabel();keys.add(key);
        let entry=rendered.get(key);
        if(!entry||entry.signature!==signature){
          const article=el('article',undefined,'conversation-message '+item.role+(item.phase==='commentary'?' commentary':'')),label=el('div',speaker,'conversation-label');article.append(label);
          article.dataset.conversationEntry='message-'+key;contentResize?.observe(article);
          if(window.SwitchboardConversationMedia&&(item.markdown||item.attachments))window.SwitchboardConversationMedia.render(article,item,{host:target.host,project:binding()?.project});else textBlocks(article,item.text||'');
          if(item.truncated)article.append(el('small','Message truncated by history API. Open the terminal for full context.'));
          if(entry){contentResize?.unobserve(entry.node);entry.node.remove();}entry={signature,node:article};rendered.set(key,entry);
        }
        entry.node.classList.toggle('continuation',previousRole==='assistant'&&item.role==='assistant'&&previousSpeaker===speaker);previousRole=item.role;previousSpeaker=speaker;
        if(previous.nextSibling!==entry.node)previous.after(entry.node);
        previous=entry.node;
      }
      for(const [key,entry] of rendered)if(!keys.has(key)){contentResize?.unobserve(entry.node);entry.node.remove();rendered.delete(key);}
      for(const sent of visibleOutgoing){
        const signature=JSON.stringify([sent.text,sent.files.map(file=>file.name),sent.state,sent.detail]);let entry=renderedOutgoing.get(sent.id);
        if(!entry||entry.signature!==signature){
          const article=el('article',undefined,'conversation-message user conversation-outgoing '+sent.state),label=el('div','You','conversation-label');article.append(label);textBlocks(article,sent.text||'');
          article.dataset.conversationEntry='outgoing-'+sent.id;contentResize?.observe(article);
          const mediaFiles=sent.files.filter(file=>file.kind==='image'||file.kind==='video');
          if(window.SwitchboardConversationMedia&&mediaFiles.length)window.SwitchboardConversationMedia.render(article,{attachments:mediaFiles.map(file=>({kind:file.kind,name:file.name,url:file.path}))},{host:sent.host});
          for(const file of sent.files.filter(file=>!window.SwitchboardConversationMedia||!mediaFiles.includes(file)))article.append(el('div',file.name,'conversation-outgoing-file'));
          const footer=el('div',undefined,'conversation-outgoing-status');footer.append(el('span',sent.detail||outgoingLabel(sent.state)));
          if(['failed','uncertain'].includes(sent.state)&&sent.native){
            const retry=el('button','Retry');retry.type='button';retry.onclick=()=>retrySend(sent);footer.append(retry);
          }
          article.append(footer);if(entry){contentResize?.unobserve(entry.node);entry.node.remove();}entry={signature,node:article};renderedOutgoing.set(sent.id,entry);
        }
        if(previous.nextSibling!==entry.node)previous.after(entry.node);previous=entry.node;
      }
      const outgoingIds=new Set(visibleOutgoing.map(item=>item.id));for(const [id,entry] of renderedOutgoing)if(!outgoingIds.has(id)){contentResize?.unobserve(entry.node);entry.node.remove();renderedOutgoing.delete(id);}
      if(list.lastChild!==working)list.append(working);
      if(prepend)list.scrollTop=position+list.scrollHeight-height;
      else if(follow)list.scrollTop=list.scrollHeight;
      updateLatest();rememberReading();paintFiles();
    }
    function applyPage(data,kind,cursor){
      const initial=kind==='initial',prepend=kind==='older',page=data.messages||[],start=data.start_cursor??(initial?0:prepend?Math.max(0,startCursor-page.length):cursor);
      chat.project=data.project||chat.project;chat.thread=data.session_id||chat.thread;
      if('model' in data)chat.model=data.model;
      if('reasoning_effort' in data)chat.reasoning_effort=data.reasoning_effort;
      updateActivity();
      if(initial){messages=page;startCursor=start;tailCursor=start+Math.max(0,page.length-1);nextCursor=data.next_cursor??null;}
      else if(prepend){messages=page.concat(messages);startCursor=start;}
      else{if(start<startCursor){messages=page;startCursor=start;}else messages=messages.slice(0,Math.max(0,start-startCursor)).concat(page);tailCursor=start+Math.max(0,page.length-1);nextCursor=data.next_cursor??null;}
      loaded=true;refresh.hidden=true;if(open)paint(prepend,initial);
      // Conversation has no terminal focus acknowledgement. Review only output
      // that has loaded and is visible at the end of the selected transcript.
      if(open&&!panel.hidden&&!document.hidden&&document.hasFocus()&&nextCursor===null&&nearBottom())viewed(target);
    }
    async function load(kind='poll'){
      if(!target||!binding()||loading||(!open&&kind!=='initial'))return;if(!loaded)kind='initial';const version=generation,chat=binding(),started=performance.now(),request=new AbortController();loadRequest=request;let timedOut=false,catchUp=false;busy(true);const timeout=setTimeout(()=>{timedOut=true;request.abort();},15000);
      const initial=kind==='initial',prepend=kind==='older',cursor=nextCursor??tailCursor;
      historyStatus.hidden=!prepend;historyStatus.textContent='Loading earlier messages…';
      const params={host:target.chatHost||target.host,limit:initial&&(mobile||navigator.connection?.saveData)?15:50};
      if(initial)params.tail=true;else if(prepend)params.before=startCursor;else params.cursor=cursor;
      try{const data=await get('/api/chats/'+encodeURIComponent(chat.id)+'?'+new URLSearchParams(params),request.signal);if(version!==generation)return;
        applyPage(data,kind,cursor);streamSupported=data.stream===true;startStream();const warning=partialNotice(data);status(warning,!warning);if(warning){reportLoad(kind,'partial',started);lastFailure='partial';}else if(lastFailure){reportLoad(kind,'recovered',started);lastFailure=null;}updateLatest();catchUp=nextCursor!==null&&!prepend;
      }catch(error){if(version===generation&&!(!timedOut&&request.signal.aborted)){const outcome=timedOut?'timeout':error.code||'network';lastFailure=outcome;reportLoad(kind,outcome,started);const message=timedOut?'Loading took too long. Retrying…':error.code?error.message:'Connection interrupted. Retrying…';if(prepend){older.textContent='Retry earlier messages';older.hidden=false;}else{status(message);refresh.hidden=false;updateLatest();}}}finally{clearTimeout(timeout);if(loadRequest===request)loadRequest=null;if(version===generation){busy(false);historyStatus.hidden=true;for(const data of streamPages)streamPage(data);streamPages=[];if(catchUp)setTimeout(()=>{if(version===generation)load();},0);else if(open&&loaded&&startCursor>0&&older.hidden&&list.scrollHeight<=list.clientHeight)setTimeout(()=>{if(version===generation)load('older');},0);}}
    }
    older.onclick=()=>load('older');refresh.onclick=()=>load(messages.length?'poll':'initial');latest.onclick=()=>{list.scrollTop=list.scrollHeight;updateLatest();};
    let draftSizeKey;
    function sizeDraft(){
      if(panel.hidden||form.hidden)return;
      const key=JSON.stringify([draft.value,draft.clientWidth,window.visualViewport?.height||innerHeight]);
      const follow=nearBottom(),limit=Math.min(144,Math.max(60,(window.visualViewport?.height||innerHeight)*.25));
      if(key!==draftSizeKey){draftSizeKey=key;draft.style.height='0px';const height=draft.scrollHeight;draft.style.height=Math.min(height,limit)+'px';draft.style.overflowY=height>limit?'auto':'hidden';}
      panel.style.setProperty('--composer-height',form.offsetHeight+'px');if(follow)list.scrollTop=list.scrollHeight;updateLatest();
    }
    function viewport(){
      const mobile=matchMedia('(max-width:700px), (pointer:coarse) and (max-width:1000px)').matches;
      document.body.classList.toggle('conversation-open',open&&!!target&&mobile);
      const view=window.visualViewport,follow=nearBottom();
      if(view&&view.scale===1){panel.style.setProperty('--chat-height',view.height+'px');document.body.style.setProperty('--chat-top',view.offsetTop+'px');}
      sizeDraft();if(follow)list.scrollTop=list.scrollHeight;updateLatest();
    }
    window.visualViewport?.addEventListener('resize',viewport);window.visualViewport?.addEventListener('scroll',viewport);window.addEventListener('resize',viewport);
    function fileList(key=identity(target)){return attachments.get(key)||[];}
    function paintFiles(){
      const follow=nearBottom();files.replaceChildren();files.hidden=!fileList().length;
      for(const item of fileList()){
        const chip=el('div',undefined,'conversation-attachment');
        if(item.preview){const img=el('img');img.src=item.preview;img.alt='';chip.append(img);}
        chip.append(el('span',item.name),el('small',item.error?'Upload failed':item.path?'Ready':'Uploading…'));
        const remove=el('button','×');remove.type='button';remove.setAttribute('aria-label','Remove '+item.name);remove.disabled=!!pendingFor();
        remove.onclick=()=>{attachments.set(identity(target),fileList().filter(file=>file!==item));if(item.preview)URL.revokeObjectURL(item.preview);paintFiles();};chip.append(remove);files.append(chip);
      }
      attach.disabled=insert.disabled=!!pendingFor();sizeDraft();if(follow){list.scrollTop=list.scrollHeight;updateLatest();}
    }
    let pickerTarget=null;
    attach.onclick=()=>{pickerTarget=target;picker.click();};
    async function addFiles(selected,destination=target){
      if(!destination||pendingFor(identity(destination)))return;const key=identity(destination),host=destination.host;
      for(const file of selected){
        if(fileList(key).length>=8){if(identity(target)===key)sendStatus('Attach up to 8 files per message.');break;}
        if(!file.size||file.size>20*1024*1024){if(identity(target)===key)sendStatus('Choose a non-empty file up to 20 MB.');continue;}
        const item={name:file.name,kind:file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':'file',preview:file.type.startsWith('image/')?URL.createObjectURL(file):null};attachments.set(key,[...fileList(key),item]);if(identity(target)===key)paintFiles();
        try{const response=await fetch('/api/hosts/'+encodeURIComponent(host)+'/attachments?'+new URLSearchParams({name:file.name}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
          if(!response.ok)throw Error('Could not upload '+file.name+'. Remove it and try again.');const data=await response.json();if(typeof data.path!=='string'||!data.path||/[\x00-\x1f]/.test(data.path))throw Error('Invalid attachment response');item.path=data.path;
        }catch(error){item.error=true;if(identity(target)===key)sendStatus(error.message);}
        if(identity(target)===key)paintFiles();
      }
    }
    picker.onchange=()=>{const selected=[...picker.files],destination=pickerTarget;picker.value='';pickerTarget=null;void addFiles(selected,destination);};
    draft.addEventListener('paste',event=>{const selected=[...(event.clipboardData?.files||[])];if(selected.length){event.preventDefault();void addFiles(selected);}});
    draft.oninput=()=>{if(target){const key=identity(target);drafts.set(key,draft.value);draftVersions.set(key,(draftVersions.get(key)||0)+1);}sizeDraft();if(!pendingFor())sendStatus('');};
    draft.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!matchMedia('(pointer:coarse)').matches){event.preventDefault();form.requestSubmit();}};
    function clearSentDraft(sent){
      if(sent.draftCleared)return;sent.draftCleared=true;
      if(retryKeys.get(sent.key)?.id===sent.sendKey)retryKeys.delete(sent.key);
      const ownsDraft=(draftVersions.get(sent.key)||0)===sent.draftRevision;
      if(ownsDraft&&drafts.get(sent.key)===sent.text)drafts.delete(sent.key);
      attachments.set(sent.key,fileList(sent.key).filter(item=>!sent.files.includes(item)));for(const item of sent.files)if(item.preview){URL.revokeObjectURL(item.preview);item.preview=null;}
      if(ownsDraft&&identity(target)===sent.key&&draft.value===sent.text)draft.value='';
      if(sendNoticeReceipt===sent&&identity(target)===sent.key)sendStatus('');
    }
    function returnToConversation(sent){if(sent.returnHere&&!open&&modeRevision===sent.modeRevision&&navigationRevision===sent.navigationRevision&&identity(selection())===sent.key)show(true,true);}
    function complete(sent,ok,message,uncertain=false){
      if(pendingFor(sent.key)!==sent)return;pendingSends.delete(sent.key);
      if(ok){clearSentDraft(sent);sendItem(sent,sent.native||sent.relay?'queued':'sent');}
      else sendItem(sent,uncertain?'uncertain':'failed',message);
      returnToConversation(sent);
      if(identity(target)===sent.key){sendStatus(ok?'':message,sent);if(ok)load();}paintFiles();
    }
    async function sendNative(sent){
      const request=new AbortController();sent.request=request;
      const timeout=setTimeout(()=>request.abort(),30000);
      try{
        const response=await fetch('/api/hosts/'+encodeURIComponent(sent.host)+'/codex/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:sent.thread,message:sent.payload,send_key:sent.sendKey}),signal:request.signal});
        const result=await response.json(),ok=response.ok&&result.status==='queued';
        complete(sent,ok,ok?'':result.detail||'Could not confirm sending. Retry to check its status.',result.status!=='failed');
      }catch{complete(sent,false,request.signal.aborted?'Sending timed out. Delivery is not confirmed. Retry to check its status.':'Could not confirm sending. Retry to check its status.',true);}
      finally{clearTimeout(timeout);if(sent.request===request)sent.request=null;}
    }
    async function retrySend(sent,claimDraft=false){
      if(pendingFor(sent.key)||!['failed','uncertain'].includes(sent.state)||!sent.native)return;
      const destination=selection();if(identity(destination)!==sent.key)return;
      if(claimDraft){sent.draftRevision=draftVersions.get(sent.key)||0;sent.text=draft.value;sent.draftCleared=false;}
      pendingSends.set(sent.key,sent);insert.disabled=true;sent.state='sending';sent.detail='';paintFiles();sendStatus('');paint();
      await sendNative(sent);
    }
    form.onsubmit=async event=>{
      event.preventDefault();const current=selection();if(!target||identity(current)!==identity(target)||!binding()||(!draft.value.trim()&&!fileList().length)||pendingFor())return;
      if(!['ready','working'].includes(current.state)){sendStatus('The agent needs attention in Terminal. Your draft is kept.');return;}
      const selected=fileList();if(selected.some(item=>!item.path)){sendStatus(selected.some(item=>item.error)?'Remove failed attachments before sending.':'Wait for attachments to finish uploading.');return;}
      const text=draft.value,payload=text+(selected.length?'\n\nAttached files:\n'+selected.map(item=>item.path).join('\n'):'');
      if(/[\x00-\x08\x0b-\x1f\x7f]/.test(payload)){sendStatus('The draft contains terminal control characters. Remove them first.');return;}
      const native=current.agent==='codex'&&/^[0-9a-f-]{36}$/.test(chat.thread||'');
      if(current.state==='working'&&!native&&current.agent!=='claude'){sendStatus('Still connecting to this conversation. Try sending again in a moment.');return;}
      if(new TextEncoder().encode(payload).length>(native?8192:16000)){sendStatus('This message is too long. Shorten it before sending.');return;}
      const retry=native&&(outgoing.get(identity(target))||[]).find(item=>['failed','uncertain'].includes(item.state)&&item.native&&sameMessage(item.payload,payload));
      if(retry){retrySend(retry,true);return;}
      const key=identity(target),id='conversation-'+Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');
      const items=outgoing.get(key)||[],failedBridge=!native&&items.find(item=>item.state==='failed'&&!item.native&&sameMessage(item.payload,payload));
      const sent={id,key,frame:target.frame,text,payload,files:[...selected],native,host:target.host,thread:chat.thread,draftRevision:draftVersions.get(key)||0,baseline:failedBridge?failedBridge.baseline:startCursor+messages.length-1,sendKey:id,state:'sending'};
      if(failedBridge)items[items.indexOf(failedBridge)]=sent;else items.push(sent);
      outgoing.set(key,items);pendingSends.set(key,sent);insert.disabled=true;paintFiles();sendStatus('');paint();
      if(native){
        const prior=retryKeys.get(key),sendKey=prior?.payload===payload?prior.id:id;sent.sendKey=sendKey;retryKeys.set(key,{payload,id:sendKey});
        await sendNative(sent);return;
      }
      // The relay types Claude replies into the pane, so Conversation stays on screen.
      // Older relays answer 404 and use the terminal below.
      if(current.agent==='claude'){
        try{
          const response=await fetch('/api/hosts/'+encodeURIComponent(sent.host)+'/conversation/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:current.session,tab_id:current.tab,pane_id:current.pane,text:payload}),signal:AbortSignal.timeout(20000)});
          if(response.status!==404){sent.relay=true;complete(sent,response.ok,response.ok?'':(await response.text())||'Could not send the reply. Your draft is kept.');return;}
        }catch(error){const timeout=error.name==='TimeoutError';complete(sent,false,timeout?'No confirmation from the terminal. Check it before trying again; your draft is kept.':'Could not reach this computer. Your draft is kept.',timeout);return;}
      }
      // Agents without a native reply API need the visible terminal connection.
      // Attach only after leaving Conversation, then wait for the selected pane.
      if(current.terminalReady===false){
        sent.returnHere=true;sent.modeRevision=modeRevision;sent.navigationRevision=navigationRevision;show(false,true);
        const deadline=Date.now()+10000;
        while(pendingFor(key)===sent&&identity(selection())===key&&!selection()?.terminalReady&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
        if(pendingFor(key)!==sent)return;
        if(identity(selection())!==key||!selection()?.terminalReady){complete(sent,false,'Terminal is not ready. Your draft is kept.');return;}
      }
      sent.frame.contentWindow.postMessage({type:'zellij-conversation-paste',id,pane_id:current.pane,agent:current.agent,submit:true,text:payload},location.origin);
      setTimeout(()=>complete(sent,false,'No confirmation from the terminal. Check it before trying again; your draft is kept.'),4000);
    };
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||event.data?.type!=='zellij-conversation-paste-result')return;
      const sent=[...pendingSends.values()].find(sent=>!sent.native&&event.source===sent.frame?.contentWindow&&event.data.id===sent.id);if(!sent)return;
      complete(sent,event.data.ok,event.data.ok?'':event.data.error||'Open the terminal and try again.');
    });
    function update(){
      root.classList.toggle('conversation-open',open);
      const current=selection();modes.hidden=!current;
      title.textContent=current?.title||'Conversation';
      if(identity(current)===identity(target)){target=current;updateActivity();if(!chat)status(unboundNotice());prepare();return;}
      navigationRevision++;
      if(target)drafts.set(identity(target),draft.value);
      if(target&&loaded){conversations.delete(identity(target));conversations.set(identity(target),{chat,messages,startCursor,tailCursor,nextCursor,streamSupported,position:restorePosition?.position??list.scrollTop,follow:restorePosition?.follow??nearBottom()});if(conversations.size>8)conversations.delete(conversations.keys().next().value);}
      window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();
      stopStream();streamSupported=false;restorePosition=null;target=current;loadRequest?.abort();lastFailure=null;lastDiagnostic='';newOutput=false;sendStatus('');generation++;loaded=false;lastPaint=null;busy(false);messages=[];startCursor=tailCursor=0;nextCursor=null;following=true;readingAnchor=null;for(const entry of [...rendered.values(),...renderedOutgoing.values()])contentResize?.unobserve(entry.node);rendered.clear();renderedOutgoing.clear();list.replaceChildren(older,working);older.hidden=true;historyStatus.hidden=true;latest.hidden=refresh.hidden=true;
      chat=target?.chatId?{id:target.chatId,agent:target.agent,title:target.title}:null;
      const cached=conversations.get(identity(target));if(cached){({chat,messages,startCursor,tailCursor,nextCursor,streamSupported}=cached);loaded=true;}
      updateActivity();
      form.hidden=!chat;actions.hidden=true;
      if(!target){panel.hidden=true;viewport();return;}draft.value=drafts.get(identity(target))||'';
      panel.hidden=!open;paintFiles();viewport();
      status(chat?'Loading conversation…':unboundNotice(),loaded);
      if(cached){if(open){paint();list.scrollTop=cached.follow?list.scrollHeight:cached.position;updateLatest();}else restorePosition=cached;}if(open)focusSurface();if(chat){load(loaded?'poll':'initial');startStream();}prepare();
    }
    // Open at the latest messages; older history is fetched only on request.
    setInterval(()=>{if(open&&!document.hidden){if(!chat){status(unboundNotice());updateActivity();}prepare();if(!streamReady)load();}},2000);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stopStream();else if(open){load();startStream();}});
    window.addEventListener('focus',()=>{if(open&&!document.hidden)load();});
    window.addEventListener('pagehide',()=>{stopStream();loadRequest?.abort();});
    window.SwitchboardConversation.hasUnsentWork=()=>!!pendingSends.size||[...outgoing.values()].some(items=>items.length)||!!draft.value||[...drafts.values()].some(Boolean)||[...attachments.values()].some(files=>files.length);
    window.SwitchboardConversation.wantsConversation=()=>open;window.SwitchboardConversation.update=update;window.SwitchboardConversation.isOpen=()=>open&&!panel.hidden;window.SwitchboardConversation.focus=focusSurface;window.SwitchboardConversation.showTerminal=()=>show(false);update();
  }};
})();
