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
  window.SwitchboardConversation={install({selection,terminal}){
    const root=document.getElementById('terminals'),drafts=new Map(),attachments=new Map(),retryKeys=new Map();
    const mobile=matchMedia('(max-width:700px), (pointer:coarse) and (max-width:1000px)').matches;
    const modeKey=mobile?'switchboard-mobile-view-mode':'switchboard-view-mode';
    let savedMode;try{savedMode=localStorage.getItem(modeKey);}catch{}
    let target=null,open=savedMode? savedMode==='conversation':mobile,generation=0,startCursor=0,tailCursor=0,nextCursor=null,messages=[],pending=null,loading=false,loaded=false,lastPaint=null;
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
    function busy(value){loading=value;older.disabled=refresh.disabled=value;}
    function focusSurface(){if(!panel.hidden&&!panel.contains(document.activeElement))panel.focus({preventScroll:true});}
    function show(value){if(!value){window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();}open=value;root.classList.toggle('conversation-open',open);try{localStorage.setItem(modeKey,value?'conversation':'terminal');}catch{}panel.hidden=!value;toggle.setAttribute('aria-pressed',String(value));back.setAttribute('aria-pressed',String(!value));if(value){document.getElementById('artifact-preview').hidden=true;update();if(binding()&&!messages.length)load('initial');focusSurface();}else if(target)terminal(target);viewport();}
    toggle.onclick=()=>show(true);back.onclick=()=>show(false);
    async function get(url){const response=await fetch(url);if(!response.ok)throw Error(`Request failed (${response.status})`);const data=await response.json();if(data.error)throw Error(data.error);return data;}
    const rendered=new Map();
    function setupMessage(item){return item.role==='user'&&/^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<skills_instructions>)/.test((item.text||'').trimStart());}
    function nearBottom(){return list.scrollHeight-list.scrollTop-list.clientHeight<80;}
    function updateLatest(){latest.hidden=nearBottom();actions.hidden=latest.hidden&&refresh.hidden;}
    list.addEventListener('scroll',()=>{updateLatest();if(loaded&&startCursor>0&&list.scrollTop<80&&!loading&&older.hidden)load('older');},{passive:true});
    function paint(prepend=false,initial=false){
      const snapshot=JSON.stringify(messages);if(snapshot===lastPaint)return;
      lastPaint=snapshot;
      const follow=initial||nearBottom(),height=list.scrollHeight,position=list.scrollTop,keys=new Set();
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
      if(prepend)list.scrollTop=position+list.scrollHeight-height;
      else if(follow)list.scrollTop=list.scrollHeight;
      updateLatest();
    }
    async function load(kind='poll'){
      if(!target||!binding()||loading)return;if(!loaded)kind='initial';const version=generation,chat=binding();let catchUp=false;busy(true);
      const initial=kind==='initial',prepend=kind==='older',cursor=nextCursor??tailCursor;
      historyStatus.hidden=!prepend;historyStatus.textContent='Loading earlier messages…';
      const params={host:target.chatHost||target.host,limit:50};
      if(initial)params.tail=true;else if(prepend)params.before=startCursor;else params.cursor=cursor;
      try{const data=await get('/api/chats/'+encodeURIComponent(chat.id)+'?'+new URLSearchParams(params));if(version!==generation)return;
        chat.project=data.project||chat.project;chat.thread=data.session_id||chat.thread;const page=data.messages||[],start=data.start_cursor??(initial?0:prepend?Math.max(0,startCursor-page.length):cursor);
        if(initial){messages=page;startCursor=start;tailCursor=start;nextCursor=data.next_cursor??null;}
        else if(prepend){messages=page.concat(messages);startCursor=start;}
        else{messages=messages.slice(0,Math.max(0,start-startCursor)).concat(page);tailCursor=start;nextCursor=data.next_cursor??null;}
        loaded=true;refresh.hidden=true;paint(prepend,initial);status('Some messages could not be loaded.',!data.partial);updateLatest();catchUp=nextCursor!==null&&!prepend;
      }catch(error){if(version===generation){if(prepend){older.textContent='Retry earlier messages';older.hidden=false;}else{status(error.message);refresh.hidden=false;updateLatest();}}}finally{if(version===generation){busy(false);historyStatus.hidden=true;if(catchUp)setTimeout(()=>{if(version===generation)load();},0);else if(loaded&&startCursor>0&&older.hidden&&list.scrollHeight<=list.clientHeight)setTimeout(()=>{if(version===generation)load('older');},0);}}
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
        const item={name:file.name,preview:file.type.startsWith('image/')?URL.createObjectURL(file):null};attachments.set(key,[...fileList(key),item]);if(identity(target)===key)paintFiles();
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
      }
      if(identity(target)===sent.key){sendStatus(message);if(ok)load();}paintFiles();
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
      const key=identity(target),id='conversation-'+Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');
      const sent={id,key,frame:target.frame,text,files:[...selected],native};pending=sent;insert.disabled=true;paintFiles();sendStatus('Sending…');
      if(native){
        const prior=retryKeys.get(key),sendKey=prior?.payload===payload?prior.id:id;retryKeys.set(key,{payload,id:sendKey});
        try{const response=await fetch('/api/hosts/'+encodeURIComponent(target.host)+'/codex/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:chat.thread,message:payload,send_key:sendKey})});
          const result=await response.json();complete(sent,response.ok&&result.status==='queued',response.ok&&result.status==='queued'?'Queued':result.detail||'Could not confirm delivery. Retry to check its status.');
        }catch{complete(sent,false,'Could not confirm delivery. Retry to check its status.');}return;
      }
      target.frame.contentWindow.postMessage({type:'zellij-conversation-paste',id,pane_id:target.pane,agent:current.agent,submit:true,text:payload},location.origin);
      setTimeout(()=>complete(sent,false,'No confirmation from the terminal. Check it before trying again; your draft is kept.'),4000);
    };
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||!pending||pending.native||event.source!==pending.frame.contentWindow||event.data?.type!=='zellij-conversation-paste-result'||event.data.id!==pending.id)return;
      complete(pending,event.data.ok,event.data.ok?'Sent':event.data.error||'Open the terminal and try again.');
    });
    function update(){
      root.classList.toggle('conversation-open',open);
      const current=selection();modes.hidden=!current;
      title.textContent=current?.title||'Conversation';
      activity.textContent=current?.state==='working'?'Working…':current?.state==='approval'?'Approval needed in Terminal':current?.state==='input'?'Input needed in Terminal':current?.agent||'';
      activity.classList.toggle('working',current?.state==='working');
      if(identity(current)===identity(target)){target=current;return;}
      if(target)drafts.set(identity(target),draft.value);
      window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();
      target=current;sendStatus('');generation++;loaded=false;lastPaint=null;busy(false);messages=[];startCursor=tailCursor=0;nextCursor=null;rendered.clear();list.replaceChildren(older);older.hidden=true;historyStatus.hidden=true;latest.hidden=refresh.hidden=true;
      chat=target?.chatId?{id:target.chatId,agent:target.agent,title:target.title}:null;
      form.hidden=!chat;actions.hidden=true;
      if(!target){panel.hidden=true;viewport();return;}draft.value=drafts.get(identity(target))||'';
      panel.hidden=!open;paintFiles();viewport();
      status(chat?'Loading conversation…':'This terminal has not reported its conversation yet. Continue in Terminal; this view will connect automatically when the agent reports it.');
      if(open){focusSurface();if(chat)load('initial');}
    }
    // Open at the latest messages; older history is fetched only on request.
    setInterval(()=>{if(open&&!document.hidden)load();},2000);
    window.SwitchboardConversation.update=update;window.SwitchboardConversation.isOpen=()=>open&&!panel.hidden;window.SwitchboardConversation.focus=focusSurface;window.SwitchboardConversation.showTerminal=()=>show(false);update();
  }};
})();
