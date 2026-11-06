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
    const root=document.getElementById('terminals'),drafts=new Map();
    let savedMode;try{savedMode=localStorage.getItem('switchboard-view-mode');}catch{}
    let target=null,open=savedMode? savedMode==='conversation':matchMedia('(max-width:700px)').matches,generation=0,startCursor=0,tailCursor=0,nextCursor=null,messages=[],pending=null,loading=false,loaded=false,lastPaint=null,requestId=0;
    const modes=el('div',undefined,'conversation-modes');modes.hidden=true;modes.setAttribute('role','group');modes.setAttribute('aria-label','View mode');
    const back=el('button','Terminal'),toggle=el('button','Conversation','conversation-toggle');back.type=toggle.type='button';back.setAttribute('aria-pressed',String(!open));toggle.setAttribute('aria-pressed',String(open));modes.append(back,toggle);root.append(modes);
    const panel=el('section',undefined,'conversation-panel');panel.hidden=true;panel.tabIndex=-1;panel.setAttribute('aria-label','Agent conversation');
    const header=el('header'),heading=el('div',undefined,'conversation-heading'),title=el('strong'),activity=el('span',undefined,'conversation-activity');activity.setAttribute('role','status');heading.append(title,activity);header.append(heading);
    const notice=el('p','Loading this terminal’s conversation…','conversation-notice');notice.setAttribute('role','status');
    const list=el('div',undefined,'conversation-messages'),older=el('button','Load older messages'),refresh=el('button','↻'),latest=el('button','↓');refresh.setAttribute('aria-label','Refresh');refresh.title='Refresh conversation';latest.setAttribute('aria-label','Scroll to bottom');latest.title='Scroll to bottom';older.hidden=true;
    const historyStatus=el('span',undefined,'conversation-history-status');historyStatus.hidden=true;historyStatus.setAttribute('role','status');
    const actions=el('div',undefined,'conversation-actions');actions.append(refresh,latest);list.append(older);latest.hidden=refresh.hidden=true;
    const form=el('form',undefined,'conversation-compose'),draft=el('textarea'),insert=el('button','↑');draft.rows=1;draft.maxLength=16000;draft.placeholder='Message…';draft.setAttribute('aria-label','Reply draft');insert.type='submit';insert.setAttribute('aria-label','Send');insert.title='Send message';form.append(draft,insert);
    const sendNotice=el('small',undefined,'conversation-send-notice');sendNotice.hidden=true;sendNotice.setAttribute('role','status');form.append(sendNotice);
    function sendStatus(text){sendNotice.textContent=text;sendNotice.hidden=!text;}
    panel.append(header,notice,list,historyStatus,actions,form);root.append(panel);
    const identity=t=>t?JSON.stringify([t.key,t.chatId]):null;
    let chat=null;
    const binding=()=>chat;
    function status(text,quiet=false){notice.textContent=text;notice.hidden=quiet;}
    function busy(value){loading=value;older.disabled=refresh.disabled=value;}
    function focusSurface(){if(!panel.hidden&&!panel.contains(document.activeElement))panel.focus({preventScroll:true});}
    function show(value){if(!value){window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();}open=value;try{localStorage.setItem('switchboard-view-mode',value?'conversation':'terminal');}catch{}panel.hidden=!value;toggle.setAttribute('aria-pressed',String(value));back.setAttribute('aria-pressed',String(!value));if(value){document.getElementById('artifact-preview').hidden=true;update();if(binding()&&!messages.length)load('initial');focusSurface();}else if(target)terminal(target);}
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
        chat.project=data.project||chat.project;const page=data.messages||[],start=data.start_cursor??(initial?0:prepend?Math.max(0,startCursor-page.length):cursor);
        if(initial){messages=page;startCursor=start;tailCursor=start;nextCursor=data.next_cursor??null;}
        else if(prepend){messages=page.concat(messages);startCursor=start;}
        else{messages=messages.slice(0,Math.max(0,start-startCursor)).concat(page);tailCursor=start;nextCursor=data.next_cursor??null;}
        loaded=true;refresh.hidden=true;paint(prepend,initial);status('Some messages could not be loaded.',!data.partial);updateLatest();catchUp=nextCursor!==null&&!prepend;
      }catch(error){if(version===generation){if(prepend){older.textContent='Retry earlier messages';older.hidden=false;}else{status(error.message);refresh.hidden=false;updateLatest();}}}finally{if(version===generation){busy(false);historyStatus.hidden=true;if(catchUp)setTimeout(()=>{if(version===generation)load();},0);else if(loaded&&startCursor>0&&older.hidden&&list.scrollHeight<=list.clientHeight)setTimeout(()=>{if(version===generation)load('older');},0);}}
    }
    older.onclick=()=>load('older');refresh.onclick=()=>load(messages.length?'poll':'initial');latest.onclick=()=>{list.scrollTop=list.scrollHeight;updateLatest();};
    function sizeDraft(){draft.style.height='auto';draft.style.height=Math.min(draft.scrollHeight,160)+'px';}
    draft.oninput=()=>{if(target)drafts.set(identity(target),draft.value);sizeDraft();if(!pending)sendStatus('');};
    draft.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!matchMedia('(pointer:coarse)').matches){event.preventDefault();form.requestSubmit();}};
    form.onsubmit=event=>{
      event.preventDefault();const current=selection();if(!target||identity(current)!==identity(target)||!binding()||!draft.value.trim()||pending)return;
      if(current.state!=='ready'){sendStatus(current.state==='working'?'The agent is working. Your draft is saved; send it when the agent finishes.':'The agent is not ready for a reply. Check Terminal; your draft is kept.');return;}
      // Submit only the selected agent and reject terminal control sequences.
      if(/[\x00-\x08\x0b-\x1f\x7f]/.test(draft.value)){sendStatus('The draft contains terminal control characters. Remove them first.');return;}
      const id=`conversation-${++requestId}`;pending={id,key:identity(target),frame:target.frame,text:draft.value};insert.disabled=true;sendStatus('Sending…');
      target.frame.contentWindow.postMessage({type:'zellij-conversation-paste',id,pane_id:target.pane,agent:current.agent,submit:true,text:draft.value},location.origin);
      setTimeout(()=>{if(pending?.id===id){pending=null;insert.disabled=false;if(identity(target)===identity(current))sendStatus('No confirmation from the terminal. Check it before trying again; your draft is kept.');}},4000);
    };
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||!pending||event.source!==pending.frame.contentWindow||event.data?.type!=='zellij-conversation-paste-result'||event.data.id!==pending.id)return;
      const sent=pending;pending=null;insert.disabled=false;
      if(event.data.ok){if(drafts.get(sent.key)===sent.text)drafts.delete(sent.key);if(identity(target)===sent.key){if(draft.value===sent.text){draft.value='';sizeDraft();}sendStatus('Sent');load();}}
      else if(identity(target)===sent.key)sendStatus(event.data.error||'Open the terminal and try again.');
    });
    function update(){
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
      if(!target){panel.hidden=true;return;}draft.value=drafts.get(identity(target))||'';
      panel.hidden=!open;sizeDraft();
      status(chat?'Loading conversation…':'This terminal has not reported its conversation yet. Continue in Terminal; this view will connect automatically when the agent reports it.');
      if(open){focusSurface();if(chat)load('initial');}
    }
    // Open at the latest messages; older history is fetched only on request.
    setInterval(()=>{if(open&&!document.hidden)load();},2000);
    window.SwitchboardConversation.update=update;window.SwitchboardConversation.isOpen=()=>open&&!panel.hidden;window.SwitchboardConversation.focus=focusSurface;window.SwitchboardConversation.showTerminal=()=>show(false);update();
  }};
})();
