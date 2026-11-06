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
    let target=null,open=savedMode? savedMode==='conversation':matchMedia('(max-width:700px)').matches,generation=0,readCursor=0,tailCursor=0,messages=[],pending=null,loading=false,lastPaint=null,requestId=0;
    const modes=el('div',undefined,'conversation-modes');modes.hidden=true;modes.setAttribute('role','group');modes.setAttribute('aria-label','View mode');
    const back=el('button','Terminal'),toggle=el('button','Conversation','conversation-toggle');back.type=toggle.type='button';back.setAttribute('aria-pressed',String(!open));toggle.setAttribute('aria-pressed',String(open));modes.append(back,toggle);root.append(modes);
    const panel=el('section',undefined,'conversation-panel');panel.hidden=true;panel.tabIndex=-1;panel.setAttribute('aria-label','Agent conversation');
    const header=el('header');header.setAttribute('aria-hidden','true');
    const notice=el('p','Loading this terminal’s conversation…','conversation-notice');notice.setAttribute('role','status');
    const list=el('div',undefined,'conversation-messages'),older=el('button','Load next messages'),refresh=el('button','↻'),latest=el('button','↓');refresh.setAttribute('aria-label','Refresh');refresh.title='Refresh conversation';latest.setAttribute('aria-label','Scroll to bottom');latest.title='Scroll to bottom';older.hidden=true;
    const actions=el('div',undefined,'conversation-actions');actions.append(older,refresh,latest);
    const form=el('form',undefined,'conversation-compose'),draft=el('textarea'),insert=el('button','Send'),help=el('small','Enter to send · Shift+Enter for a new line');draft.rows=2;draft.maxLength=16000;draft.placeholder='Reply to this conversation…';draft.setAttribute('aria-label','Reply draft');insert.type='submit';form.append(draft,insert,help);
    const sendNotice=el('small',undefined,'conversation-send-notice');sendNotice.hidden=true;sendNotice.setAttribute('role','status');form.append(sendNotice);
    function sendStatus(text){sendNotice.textContent=text;sendNotice.hidden=!text;}
    panel.append(header,notice,list,actions,form);root.append(panel);
    const identity=t=>t?JSON.stringify([t.key,t.chatId]):null;
    let chat=null;
    const binding=()=>chat;
    function status(text,quiet=false){notice.textContent=text;notice.hidden=quiet;}
    function busy(value){loading=value;older.disabled=refresh.disabled=value;}
    function focusSurface(){if(!panel.hidden&&!panel.contains(document.activeElement))panel.focus({preventScroll:true});}
    function show(value){if(!value){window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();}open=value;try{localStorage.setItem('switchboard-view-mode',value?'conversation':'terminal');}catch{}panel.hidden=!value;toggle.setAttribute('aria-pressed',String(value));back.setAttribute('aria-pressed',String(!value));if(value){document.getElementById('artifact-preview').hidden=true;update();if(binding()&&!messages.length)load(false);focusSurface();}else if(target)terminal(target);}
    toggle.onclick=()=>show(true);back.onclick=()=>show(false);
    async function get(url){const response=await fetch(url);if(!response.ok)throw Error(`Request failed (${response.status})`);const data=await response.json();if(data.error)throw Error(data.error);return data;}
    function paint(){
      const snapshot=JSON.stringify(messages);if(snapshot===lastPaint)return;
      if([...list.querySelectorAll('video')].some(video=>!video.paused))return;
      lastPaint=snapshot;
      const expanded=new Set([...list.querySelectorAll('details[open]')].map(node=>node.dataset.messageIndex));
      const nearEnd=list.scrollHeight-list.scrollTop-list.clientHeight<80,position=list.scrollTop;list.replaceChildren();
      let progress;
      for(const [messageIndex,item] of messages.entries()){
        const article=el('article',undefined,'conversation-message '+item.role),label=el('div',item.role==='user'?'You':binding()?.agent||'Assistant','conversation-label');article.append(label);if(window.SwitchboardConversationMedia&&(item.markdown||item.attachments))window.SwitchboardConversationMedia.render(article,item,{host:target.host,project:binding()?.project});else textBlocks(article,item.text||'');if(item.truncated)article.append(el('small','Message truncated by history API. Open the terminal for full context.'));
        if(item.role==='user'&&/^# AGENTS\.md instructions|^<environment_context>/.test(item.text||'')){progress=null;const context=el('details');context.dataset.messageIndex=String(messageIndex);context.open=expanded.has(String(messageIndex));context.append(el('summary','Session instructions'),article);list.append(context);}
        else if(item.phase==='commentary'){if(!progress){progress=el('details');progress.dataset.messageIndex=String(messageIndex);progress.open=expanded.has(String(messageIndex));progress.append(el('summary','Progress updates'));list.append(progress);}progress.append(article);}else{progress=null;list.append(article);}
      }
      if(nearEnd)list.scrollTop=list.scrollHeight;else list.scrollTop=position;
    }
    async function load(poll){
      if(!target||!binding()||loading)return;const version=generation,chat=binding();busy(true);
      const cursor=poll?tailCursor:readCursor;
      try{const data=await get('/api/chats/'+encodeURIComponent(chat.id)+'?'+new URLSearchParams({host:target.chatHost||target.host,cursor,limit:50}));if(version!==generation)return;
        chat.project=data.project||chat.project;const page=data.messages||[];messages=messages.slice(0,cursor).concat(page);tailCursor=cursor;readCursor=data.next_cursor??messages.length;older.hidden=data.next_cursor==null;
        paint();status('History is incomplete.',!data.partial);
      }catch(error){if(version===generation)status(error.message);}finally{if(version===generation)busy(false);}
    }
    older.onclick=()=>load(false);refresh.onclick=()=>load(true);latest.onclick=()=>{list.scrollTop=list.scrollHeight;};
    draft.oninput=()=>{if(target)drafts.set(identity(target),draft.value);};
    draft.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();form.requestSubmit();}};
    form.onsubmit=event=>{
      event.preventDefault();const current=selection();if(!target||identity(current)!==identity(target)||!binding()||!draft.value.trim()||pending)return;
      if(current.state!=='ready'){sendStatus(current.state==='working'?'The agent is working. Your reply is kept; press Enter when it finishes.':'The agent is not ready for a reply. Check Terminal; your draft is kept.');return;}
      // Submit only the selected agent and reject terminal control sequences.
      if(/[\x00-\x08\x0b-\x1f\x7f]/.test(draft.value)){sendStatus('The draft contains terminal control characters. Remove them first.');return;}
      const id=`conversation-${++requestId}`;pending={id,key:identity(target),frame:target.frame,text:draft.value};insert.disabled=true;sendStatus('Sending…');
      target.frame.contentWindow.postMessage({type:'zellij-conversation-paste',id,pane_id:target.pane,agent:current.agent,submit:true,text:draft.value},location.origin);
      setTimeout(()=>{if(pending?.id===id){pending=null;insert.disabled=false;if(identity(target)===identity(current))sendStatus('No confirmation from the terminal. Check it before trying again; your draft is kept.');}},4000);
    };
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||!pending||event.source!==pending.frame.contentWindow||event.data?.type!=='zellij-conversation-paste-result'||event.data.id!==pending.id)return;
      const sent=pending;pending=null;insert.disabled=false;
      if(event.data.ok){if(drafts.get(sent.key)===sent.text)drafts.delete(sent.key);if(identity(target)===sent.key){if(draft.value===sent.text)draft.value='';sendStatus('Sent');load(older.hidden);}}
      else if(identity(target)===sent.key)sendStatus(event.data.error||'Open the terminal and try again.');
    });
    function update(){
      const current=selection();modes.hidden=!current;
      if(identity(current)===identity(target)){target=current;return;}
      if(target)drafts.set(identity(target),draft.value);
      window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();
      target=current;sendStatus('');generation++;lastPaint=null;busy(false);messages=[];readCursor=tailCursor=0;list.replaceChildren();older.hidden=true;
      chat=target?.chatId?{id:target.chatId,agent:target.agent,title:target.title}:null;
      form.hidden=actions.hidden=!chat;
      if(!target){panel.hidden=true;return;}draft.value=drafts.get(identity(target))||'';
      panel.hidden=!open;
      status(chat?'Loading conversation…':'This terminal has not reported its conversation yet. Continue in Terminal; this view will connect automatically when the agent reports it.');
      if(open){focusSurface();if(chat)load(false);}
    }
    // Catch up one page at a time, then refresh the tail, including while composing.
    setInterval(()=>{if(open&&!document.hidden)load(older.hidden);},2000);
    window.SwitchboardConversation.update=update;window.SwitchboardConversation.isOpen=()=>open&&!panel.hidden;window.SwitchboardConversation.focus=focusSurface;window.SwitchboardConversation.showTerminal=()=>show(false);update();
  }};
})();
