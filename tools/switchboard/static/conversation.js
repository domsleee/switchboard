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
  window.SwitchboardConversation={install({selection,terminal,modeChanged=()=>{}}){
    const root=document.getElementById('terminals'),drafts=new Map(),attachments=new Map(),retryKeys=new Map();
    const mobile=matchMedia('(max-width:700px), (pointer:coarse) and (max-width:1000px)').matches;
    const modeKey=mobile?'switchboard-mobile-view-mode':'switchboard-view-mode';
    let savedMode;try{savedMode=localStorage.getItem(modeKey);}catch{}
    let target=null,open=savedMode? savedMode==='conversation':mobile,generation=0,startCursor=0,tailCursor=0,nextCursor=null,messages=[],pending=null,loading=false,loaded=false,lastPaint=null;
    const outgoing=new Map(),consumedTranscript=new Map();
    const conversations=new Map();
    let stream=null,streamReady=false,streamSupported=false,streamPages=[],restorePosition=null;
    let preparing=false,lastPrepare='',lastPrepareAt=0;
    async function prepare(){
      if(!open||document.hidden||!target||target.agent!=='codex'||!target.session||!Number.isInteger(target.tab)||preparing)return;
      if(target.chatId&&['ready','working'].includes(target.state))return;
      const key=identity(target);if(key===lastPrepare&&Date.now()-lastPrepareAt<5000)return;
      lastPrepare=key;lastPrepareAt=Date.now();preparing=true;
      try{await fetch('/api/hosts/'+encodeURIComponent(target.host)+'/conversation/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:target.session,tab_id:target.tab,pane_id:target.pane}),signal:AbortSignal.timeout(20000)});}catch{}finally{preparing=false;}
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
    const header=el('header'),heading=el('div',undefined,'conversation-heading'),title=el('strong'),activity=el('span',undefined,'conversation-activity');activity.setAttribute('role','status');heading.append(title,activity);header.append(heading);
    const notice=el('p','Loading this terminal’s conversation…','conversation-notice');notice.setAttribute('role','status');
    const list=el('div',undefined,'conversation-messages'),older=el('button','Load older messages'),refresh=el('button','↻'),latest=el('button','↓');refresh.setAttribute('aria-label','Refresh');refresh.title='Refresh conversation';latest.setAttribute('aria-label','Scroll to bottom');latest.title='Scroll to bottom';older.hidden=true;
    const historyStatus=el('span',undefined,'conversation-history-status');historyStatus.hidden=true;historyStatus.setAttribute('role','status');
    const actions=el('div',undefined,'conversation-actions');actions.append(refresh,latest);list.append(older);latest.hidden=refresh.hidden=true;
    const form=el('form',undefined,'conversation-compose'),draft=el('textarea'),insert=el('button','↑');draft.rows=1;draft.maxLength=16000;draft.placeholder='Message…';draft.setAttribute('aria-label','Reply draft');insert.type='submit';insert.setAttribute('aria-label','Send');insert.title='Send message';const attach=el('button','+','conversation-attach'),picker=el('input'),files=el('div',undefined,'conversation-attachments');attach.type='button';attach.setAttribute('aria-label','Attach files');attach.title='Attach photos or files';picker.type='file';picker.multiple=true;picker.hidden=true;files.hidden=true;form.append(files,attach,draft,insert,picker);
    const sendNotice=el('small',undefined,'conversation-send-notice');sendNotice.hidden=true;sendNotice.setAttribute('role','status');form.append(sendNotice);
    function sendStatus(text){const follow=nearBottom();sendNotice.textContent=text;sendNotice.hidden=!text;if(form.isConnected){sizeDraft();if(follow){list.scrollTop=list.scrollHeight;updateLatest();}}}
    panel.append(header,notice,list,historyStatus,actions,form);root.append(panel);
    const identity=t=>t?JSON.stringify([t.key,t.chatId]):null;
    let chat=null;
    const binding=()=>chat;
    function status(text,quiet=false){notice.textContent=text;notice.hidden=quiet;}
    function unboundNotice(){return target?.starting?'Starting agent…':target?.agent?'This agent has not reported its conversation yet. This view will connect automatically.':'No agent';}
    function busy(value){loading=value;older.disabled=refresh.disabled=value;}
    function focusSurface(){if(!panel.hidden)(form.hidden?panel:draft).focus({preventScroll:true});}
    function show(value){if(!value){stopStream();loadRequest?.abort();window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();}open=value;root.classList.toggle('conversation-open',open);modeChanged();try{localStorage.setItem(modeKey,value?'conversation':'terminal');}catch{}panel.hidden=!value;toggle.setAttribute('aria-pressed',String(value));back.setAttribute('aria-pressed',String(!value));if(value){document.getElementById('artifact-preview').hidden=true;update();if(loaded){paint(false,restorePosition===null&&lastPaint===null);if(restorePosition!==null){list.scrollTop=restorePosition.follow?list.scrollHeight:restorePosition.position;restorePosition=null;updateLatest();}}if(binding())load(loaded?'poll':'initial');startStream();focusSurface();}else if(target)terminal(target);viewport();}

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
    function outgoingLabel(state){return state==='sending'?'Sending…':state==='queued'||state==='sent'?'Waiting for agent…':'Could not confirm sending';}
    function sendItem(sent,state,detail){sent.state=state;sent.detail=detail||'';if(identity(target)===sent.key)paint();}
    function nearBottom(){return list.scrollHeight-list.scrollTop-list.clientHeight<80;}
    function updateLatest(){latest.hidden=nearBottom();if(latest.hidden)newOutput=false;latest.textContent=newOutput?'↓ New messages':'↓ Latest';actions.hidden=latest.hidden&&refresh.hidden;}
    list.addEventListener('scroll',()=>{list.classList.add('scrolling');clearTimeout(scrollIdle);scrollIdle=setTimeout(()=>list.classList.remove('scrolling'),700);updateLatest();if(loaded&&startCursor>0&&list.scrollTop<80&&!loading&&older.hidden)load('older');},{passive:true});
    function paint(prepend=false,initial=false){
      const key=identity(target),sentItems=outgoing.get(key)||[],used=consumedTranscript.get(key)||new Set();
      for(const sent of sentItems){
        if(sent.transcriptCursor!==undefined)continue;
        const match=messages.findIndex((item,offset)=>startCursor+offset>sent.baseline&&item.role==='user'&&!used.has(startCursor+offset)&&sameMessage(item.text||'',sent.payload));
        if(match>=0){sent.transcriptCursor=startCursor+match;used.add(sent.transcriptCursor);}
      }
      consumedTranscript.set(key,used);
      outgoing.set(key,sentItems.filter(item=>item.transcriptCursor===undefined));
      const visibleOutgoing=sentItems.filter(item=>item.transcriptCursor===undefined);
      const snapshot=JSON.stringify([messages,visibleOutgoing.map(({id,text,files,state,detail})=>({id,text,files:files.map(file=>file.name),state,detail}))]);if(snapshot===lastPaint)return;
      lastPaint=snapshot;
      const follow=initial||nearBottom(),height=list.scrollHeight,position=list.scrollTop,keys=new Set();
      if(!follow&&!prepend&&!initial)newOutput=true;
      older.hidden=true;
      let previous=older,previousRole=null;
      for(const [offset,item] of messages.entries()){
        if(setupMessage(item))continue;
        const key=startCursor+offset,signature=JSON.stringify(item);keys.add(key);
        let entry=rendered.get(key);
        if(!entry||entry.signature!==signature){
          const article=el('article',undefined,'conversation-message '+item.role+(item.phase==='commentary'?' commentary':'')),label=el('div',item.role==='user'?'You':binding()?.agent||'Assistant','conversation-label');article.append(label);
          if(window.SwitchboardConversationMedia&&(item.markdown||item.attachments))window.SwitchboardConversationMedia.render(article,item,{host:target.host,project:binding()?.project});else textBlocks(article,item.text||'');
          if(item.truncated)article.append(el('small','Message truncated by history API. Open the terminal for full context.'));
          entry?.node.remove();entry={signature,node:article};rendered.set(key,entry);
        }
        entry.node.classList.toggle('continuation',previousRole==='assistant'&&item.role==='assistant');previousRole=item.role;
        if(previous.nextSibling!==entry.node)previous.after(entry.node);
        previous=entry.node;
      }
      for(const [key,entry] of rendered)if(!keys.has(key)){entry.node.remove();rendered.delete(key);}
      for(const sent of visibleOutgoing){
        const signature=JSON.stringify([sent.text,sent.files.map(file=>file.name),sent.state,sent.detail]);let entry=renderedOutgoing.get(sent.id);
        if(!entry||entry.signature!==signature){
          const article=el('article',undefined,'conversation-message user conversation-outgoing '+sent.state),label=el('div','You','conversation-label');article.append(label);textBlocks(article,sent.text||'');
          const mediaFiles=sent.files.filter(file=>file.kind==='image'||file.kind==='video');
          if(window.SwitchboardConversationMedia&&mediaFiles.length)window.SwitchboardConversationMedia.render(article,{attachments:mediaFiles.map(file=>({kind:file.kind,name:file.name,url:file.path}))},{host:sent.host});
          for(const file of sent.files.filter(file=>!window.SwitchboardConversationMedia||!mediaFiles.includes(file)))article.append(el('div',file.name,'conversation-outgoing-file'));
          const footer=el('div',undefined,'conversation-outgoing-status');footer.append(el('span',sent.detail||outgoingLabel(sent.state)));
          if(sent.state==='failed'&&sent.native){
            const retry=el('button','Retry');retry.type='button';retry.onclick=()=>retrySend(sent);footer.append(retry);
          }
          article.append(footer);entry?.node.remove();entry={signature,node:article};renderedOutgoing.set(sent.id,entry);
        }
        if(previous.nextSibling!==entry.node)previous.after(entry.node);previous=entry.node;
      }
      const outgoingIds=new Set(visibleOutgoing.map(item=>item.id));for(const [id,entry] of renderedOutgoing)if(!outgoingIds.has(id)){entry.node.remove();renderedOutgoing.delete(id);}
      if(prepend)list.scrollTop=position+list.scrollHeight-height;
      else if(follow)list.scrollTop=list.scrollHeight;
      updateLatest();
    }
    function applyPage(data,kind,cursor){
      const initial=kind==='initial',prepend=kind==='older',page=data.messages||[],start=data.start_cursor??(initial?0:prepend?Math.max(0,startCursor-page.length):cursor);
      chat.project=data.project||chat.project;chat.thread=data.session_id||chat.thread;
      if(initial){messages=page;startCursor=start;tailCursor=start+Math.max(0,page.length-1);nextCursor=data.next_cursor??null;}
      else if(prepend){messages=page.concat(messages);startCursor=start;}
      else{if(start<startCursor){messages=page;startCursor=start;}else messages=messages.slice(0,Math.max(0,start-startCursor)).concat(page);tailCursor=start+Math.max(0,page.length-1);nextCursor=data.next_cursor??null;}
      loaded=true;refresh.hidden=true;if(open)paint(prepend,initial);
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
        const remove=el('button','×');remove.type='button';remove.setAttribute('aria-label','Remove '+item.name);remove.disabled=!!pending;
        remove.onclick=()=>{attachments.set(identity(target),fileList().filter(file=>file!==item));if(item.preview)URL.revokeObjectURL(item.preview);paintFiles();};chip.append(remove);files.append(chip);
      }
      attach.disabled=!!pending;sizeDraft();if(follow){list.scrollTop=list.scrollHeight;updateLatest();}
    }
    let pickerTarget=null;
    attach.onclick=()=>{pickerTarget=target;picker.click();};
    async function addFiles(selected,destination=target){
      if(!destination||pending)return;const key=identity(destination),host=destination.host;
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
    draft.oninput=()=>{if(target)drafts.set(identity(target),draft.value);sizeDraft();if(!pending)sendStatus('');};
    draft.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!matchMedia('(pointer:coarse)').matches){event.preventDefault();form.requestSubmit();}};
    function complete(sent,ok,message){
      if(pending!==sent)return;pending=null;insert.disabled=false;
      if(ok){
        retryKeys.delete(sent.key);if(drafts.get(sent.key)===sent.text)drafts.delete(sent.key);
        attachments.set(sent.key,fileList(sent.key).filter(item=>!sent.files.includes(item)));for(const item of sent.files)if(item.preview)URL.revokeObjectURL(item.preview);
        if(identity(target)===sent.key&&draft.value===sent.text)draft.value='';
        sendItem(sent,sent.native?'queued':'sent');
      }else sendItem(sent,'failed',message);
      if(identity(target)===sent.key){sendStatus(ok?'':message);if(ok)load();}paintFiles();
    }
    async function retrySend(sent){
      if(pending||sent.state!=='failed'||!sent.native)return;
      const destination=selection();if(identity(destination)!==sent.key)return;
      pending=sent;insert.disabled=true;sent.state='sending';sent.detail='';paintFiles();sendStatus('');paint();
      const sendKey=sent.sendKey;
      try{
        const response=await fetch('/api/hosts/'+encodeURIComponent(sent.host)+'/codex/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:sent.thread,message:sent.payload,send_key:sendKey})});
        const result=await response.json();complete(sent,response.ok&&result.status==='queued',response.ok&&result.status==='queued'?'Waiting for agent…':result.detail||'Could not confirm sending. Retry to check its status.');
      }catch{complete(sent,false,'Could not confirm sending. Retry to check its status.');}
    }
    form.onsubmit=async event=>{
      event.preventDefault();const current=selection();if(!target||identity(current)!==identity(target)||!binding()||(!draft.value.trim()&&!fileList().length)||pending)return;
      if(!['ready','working'].includes(current.state)){sendStatus('The agent needs attention in Terminal. Your draft is kept.');return;}
      const selected=fileList();if(selected.some(item=>!item.path)){sendStatus(selected.some(item=>item.error)?'Remove failed attachments before sending.':'Wait for attachments to finish uploading.');return;}
      const text=draft.value,payload=text+(selected.length?'\n\nAttached files:\n'+selected.map(item=>item.path).join('\n'):'');
      if(/[\x00-\x08\x0b-\x1f\x7f]/.test(payload)){sendStatus('The draft contains terminal control characters. Remove them first.');return;}
      const native=current.agent==='codex'&&/^[0-9a-f-]{36}$/.test(chat.thread||'');
      if(current.state==='working'&&!native&&current.agent!=='claude'){sendStatus('Still connecting to this conversation. Try sending again in a moment.');return;}
      if(new TextEncoder().encode(payload).length>(native?8192:16000)){sendStatus('This message is too long. Shorten it before sending.');return;}
      const retry=native&&(outgoing.get(identity(target))||[]).find(item=>item.state==='failed'&&item.native&&sameMessage(item.payload,payload));
      if(retry){retrySend(retry);return;}
      const key=identity(target),id='conversation-'+Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');
      const items=outgoing.get(key)||[],failedBridge=!native&&items.find(item=>item.state==='failed'&&!item.native&&sameMessage(item.payload,payload));
      const sent={id,key,frame:target.frame,text,payload,files:[...selected],native,host:target.host,thread:chat.thread,baseline:failedBridge?failedBridge.baseline:startCursor+messages.length-1,sendKey:id,state:'sending'};
      if(failedBridge)items[items.indexOf(failedBridge)]=sent;else items.push(sent);
      outgoing.set(key,items);pending=sent;insert.disabled=true;paintFiles();sendStatus('');paint();
      if(native){
        const prior=retryKeys.get(key),sendKey=prior?.payload===payload?prior.id:id;sent.sendKey=sendKey;retryKeys.set(key,{payload,id:sendKey});
        try{const response=await fetch('/api/hosts/'+encodeURIComponent(target.host)+'/codex/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:chat.thread,message:payload,send_key:sendKey})});
          sent.sendKey=sendKey;const result=await response.json();complete(sent,response.ok&&result.status==='queued',response.ok&&result.status==='queued'?'Waiting for agent…':result.detail||'Could not confirm sending. Retry to check its status.');
        }catch{complete(sent,false,'Could not confirm sending. Retry to check its status.');}return;
      }
      // Agents without a native reply API need the visible terminal connection.
      // Attach only after leaving Conversation, then wait for the selected pane.
      if(current.terminalReady===false){
        show(false);
        const deadline=Date.now()+10000;
        while(pending===sent&&identity(selection())===key&&!selection()?.terminalReady&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
        if(pending!==sent)return;
        if(identity(selection())!==key||!selection()?.terminalReady){complete(sent,false,'Terminal is not ready. Your draft is kept.');return;}
      }
      sent.frame.contentWindow.postMessage({type:'zellij-conversation-paste',id,pane_id:current.pane,agent:current.agent,submit:true,text:payload},location.origin);
      setTimeout(()=>complete(sent,false,'No confirmation from the terminal. Check it before trying again; your draft is kept.'),4000);
    };
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||!pending||pending.native||event.source!==pending.frame.contentWindow||event.data?.type!=='zellij-conversation-paste-result'||event.data.id!==pending.id)return;
      complete(pending,event.data.ok,event.data.ok?'Waiting for agent…':event.data.error||'Open the terminal and try again.');
    });
    function update(){
      root.classList.toggle('conversation-open',open);
      const current=selection();modes.hidden=!current;
      title.textContent=current?.title||'Conversation';
      activity.textContent=current?.state==='working'?'Working…':current?.state==='approval'?'Approval needed in Terminal':current?.state==='input'?'Input needed in Terminal':current?.agent||'';
      activity.classList.toggle('working',current?.state==='working');
      if(identity(current)===identity(target)){target=current;if(!chat)status(unboundNotice());prepare();return;}
      if(target)drafts.set(identity(target),draft.value);
      if(target&&loaded){conversations.delete(identity(target));conversations.set(identity(target),{chat,messages,startCursor,tailCursor,nextCursor,streamSupported,position:restorePosition?.position??list.scrollTop,follow:restorePosition?.follow??nearBottom()});if(conversations.size>8)conversations.delete(conversations.keys().next().value);}
      window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();
      stopStream();streamSupported=false;restorePosition=null;target=current;loadRequest?.abort();lastFailure=null;lastDiagnostic='';newOutput=false;sendStatus('');generation++;loaded=false;lastPaint=null;busy(false);messages=[];startCursor=tailCursor=0;nextCursor=null;rendered.clear();renderedOutgoing.clear();list.replaceChildren(older);older.hidden=true;historyStatus.hidden=true;latest.hidden=refresh.hidden=true;
      chat=target?.chatId?{id:target.chatId,agent:target.agent,title:target.title}:null;
      const cached=conversations.get(identity(target));if(cached){({chat,messages,startCursor,tailCursor,nextCursor,streamSupported}=cached);loaded=true;}
      form.hidden=!chat;actions.hidden=true;
      if(!target){panel.hidden=true;viewport();return;}draft.value=drafts.get(identity(target))||'';
      panel.hidden=!open;paintFiles();viewport();
      status(chat?'Loading conversation…':unboundNotice(),loaded);
      if(cached){if(open){paint();list.scrollTop=cached.follow?list.scrollHeight:cached.position;updateLatest();}else restorePosition=cached;}if(open)focusSurface();if(chat){load(loaded?'poll':'initial');startStream();}prepare();
    }
    // Open at the latest messages; older history is fetched only on request.
    setInterval(()=>{if(open&&!document.hidden){prepare();if(!streamReady)load();}},2000);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stopStream();else if(open){load();startStream();}});
    window.addEventListener('pagehide',()=>{stopStream();loadRequest?.abort();});
    window.SwitchboardConversation.hasUnsentWork=()=>!!pending||[...outgoing.values()].some(items=>items.length)||!!draft.value||[...drafts.values()].some(Boolean)||[...attachments.values()].some(files=>files.length);
    window.SwitchboardConversation.wantsConversation=()=>open;window.SwitchboardConversation.update=update;window.SwitchboardConversation.isOpen=()=>open&&!panel.hidden;window.SwitchboardConversation.focus=focusSurface;window.SwitchboardConversation.showTerminal=()=>show(false);update();
  }};
})();
