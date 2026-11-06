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
    const root=document.getElementById('terminals'),bindings=new Map(),drafts=new Map();
    let target=null,open=false,generation=0,searchCursor=0,readCursor=0,tailCursor=0,messages=[],pending=null,loading=false;
    const toggle=el('button','Conversation','conversation-toggle');toggle.type='button';toggle.hidden=true;root.append(toggle);
    const panel=el('section',undefined,'conversation-panel');panel.hidden=true;panel.setAttribute('aria-label','Agent conversation');
    const header=el('header'),back=el('button','Terminal'),title=el('strong','Conversation'),change=el('button','Choose chat');header.append(back,title,change);
    const notice=el('p','Choose the conversation running in this terminal.','conversation-notice');notice.setAttribute('role','status');
    const picker=el('form',undefined,'conversation-picker'),query=el('input'),agent=el('select'),search=el('button','Search'),more=el('button','Search next page');
    query.placeholder='Search chat text or title';query.setAttribute('aria-label','Search conversations');query.maxLength=512;
    for(const name of ['codex','claude','muse','copilot','opencode']){const option=el('option',name);option.value=name;agent.append(option);}agent.setAttribute('aria-label','Agent');
    search.type='submit';more.type='button';more.hidden=true;picker.append(query,agent,search,more);
    const results=el('div',undefined,'conversation-results'),list=el('div',undefined,'conversation-messages'),older=el('button','Load next messages'),refresh=el('button','↻'),latest=el('button','↓');refresh.setAttribute('aria-label','Refresh');refresh.title='Refresh conversation';latest.setAttribute('aria-label','Scroll to bottom');latest.title='Scroll to bottom';older.hidden=true;
    const actions=el('div',undefined,'conversation-actions');actions.append(older,refresh,latest);
    const form=el('form',undefined,'conversation-compose'),draft=el('textarea'),insert=el('button','Reply in terminal'),help=el('small','Review in the terminal, then press Enter.');draft.rows=2;draft.maxLength=16000;draft.placeholder='Reply to this conversation…';draft.setAttribute('aria-label','Reply draft');insert.type='submit';form.append(draft,insert,help);
    panel.append(header,notice,picker,results,list,actions,form);root.append(panel);
    const binding=()=>target&&bindings.get(target.key);
    function status(text,quiet=false){notice.textContent=text;notice.hidden=quiet;}
    function busy(value){loading=value;query.disabled=agent.disabled=value;search.disabled=more.disabled=older.disabled=refresh.disabled=value;}
    function show(value){open=value;panel.hidden=!value;toggle.setAttribute('aria-expanded',String(value));if(value){document.getElementById('artifact-preview').hidden=true;update();if(binding()&&!messages.length)load(false);}else if(target)terminal(target);}
    toggle.onclick=()=>show(true);back.onclick=()=>show(false);
    change.onclick=()=>{picker.hidden=false;results.hidden=false;query.focus();};
    async function get(url){const response=await fetch(url);if(!response.ok)throw Error(`Request failed (${response.status})`);const data=await response.json();if(data.error)throw Error(data.error);return data;}
    async function find(reset){
      if(!target||loading)return;if(reset){searchCursor=0;results.replaceChildren();}const version=generation,host=target.host;busy(true);status('Searching this computer…');
      try{const data=await get('/api/chats/search?'+new URLSearchParams({host,agent:agent.value,q:query.value,cursor:searchCursor,limit:20}));if(version!==generation)return;
        const computer=data.computers?.find(c=>c.host===host)||data.computers?.[0];if(computer?.error)throw Error(computer.error);
        const source=computer?.sources?.find(s=>s.agent===agent.value);if(!source)throw Error('Chat history unavailable on this computer. It may need updating.');
        for(const chat of source.results||[]){const button=el('button',undefined,'conversation-result');button.type='button';button.append(el('strong',chat.title||chat.session_id),el('small',`${chat.project||''} · ${String(chat.timestamp||'')}`),el('span',chat.excerpt||''));button.onclick=()=>{if(loading)return;bindings.set(target.key,{id:chat.id,agent:source.agent,title:chat.title});picker.hidden=true;results.hidden=true;messages=[];readCursor=tailCursor=0;load(false);};results.append(button);}
        searchCursor=source.next_cursor;more.hidden=searchCursor==null;
        status(`${source.status==='ok'?'':`Coverage: ${source.status}. `}${results.childElementCount} chats found.${searchCursor!=null?' More history is available on the next search page.':''}`);
      }catch(error){if(version===generation)status(error.message);}finally{if(version===generation)busy(false);}
    }
    picker.onsubmit=event=>{event.preventDefault();find(true);};more.onclick=()=>find(false);
    function paint(){
      const nearEnd=list.scrollHeight-list.scrollTop-list.clientHeight<80,position=list.scrollTop;list.replaceChildren();
      let progress;
      for(const item of messages){
        const article=el('article',undefined,'conversation-message '+item.role),label=el('div',item.role==='user'?'You':binding()?.agent||'Assistant','conversation-label');article.append(label);textBlocks(article,item.text||'');if(item.truncated)article.append(el('small','Message truncated by history API. Open the terminal for full context.'));
        if(item.role==='user'&&/^# AGENTS\.md instructions|^<environment_context>/.test(item.text||'')){progress=null;const context=el('details');context.append(el('summary','Session instructions'),article);list.append(context);}
        else if(item.phase==='commentary'){if(!progress){progress=el('details');progress.append(el('summary','Progress updates'));list.append(progress);}progress.append(article);}else{progress=null;list.append(article);}
      }
      if(nearEnd)list.scrollTop=list.scrollHeight;else list.scrollTop=position;
    }
    async function load(poll){
      if(!target||!binding()||loading)return;const version=generation,chat=binding();busy(true);
      const cursor=poll?tailCursor:readCursor;
      try{const data=await get('/api/chats/'+encodeURIComponent(chat.id)+'?'+new URLSearchParams({host:target.host,cursor,limit:50}));if(version!==generation)return;
        const page=data.messages||[];messages=messages.slice(0,cursor).concat(page);tailCursor=cursor;readCursor=data.next_cursor??messages.length;older.hidden=data.next_cursor==null;
        paint();status(`${data.title||chat.title||'Conversation'}${data.partial?' · History is incomplete':''}${data.next_cursor!=null?' · More messages available':''}. Replies go through the terminal.`,!data.partial&&data.next_cursor==null);
      }catch(error){if(version===generation)status(error.message);}finally{if(version===generation)busy(false);}
    }
    older.onclick=()=>load(false);refresh.onclick=()=>load(true);latest.onclick=()=>{list.scrollTop=list.scrollHeight;};
    draft.oninput=()=>{if(target)drafts.set(target.key,draft.value);};
    form.onsubmit=event=>{
      event.preventDefault();const current=selection();if(!target||current?.key!==target.key||!draft.value.trim()||pending)return;
      // Never silently submit a terminal prompt or inject terminal control sequences.
      if(/[\x00-\x08\x0b-\x1f\x7f]/.test(draft.value)){status('The draft contains terminal control characters. Remove them first.');return;}
      const id=crypto.randomUUID();pending={id,key:target.key,frame:target.frame,text:draft.value};insert.disabled=true;
      target.frame.contentWindow.postMessage({type:'zellij-conversation-paste',id,pane_id:target.pane, text:draft.value},location.origin);
      setTimeout(()=>{if(pending?.id===id){pending=null;insert.disabled=false;if(target?.key===current.key)status('No confirmation from the terminal. Check it before trying again; your draft is kept.');}},4000);
    };
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||!pending||event.source!==pending.frame.contentWindow||event.data?.type!=='zellij-conversation-paste-result'||event.data.id!==pending.id)return;
      const sent=pending;pending=null;insert.disabled=false;
      if(event.data.ok){if(drafts.get(sent.key)===sent.text)drafts.delete(sent.key);if(target?.key===sent.key){if(draft.value===sent.text)draft.value='';show(false);}}
      else if(target?.key===sent.key)status(event.data.error||'Open the terminal and try again.');
    });
    function update(){
      const current=selection();toggle.hidden=!current;
      if(current?.key===target?.key){target=current;return;}
      if(target)drafts.set(target.key,draft.value);target=current;generation++;busy(false);messages=[];readCursor=tailCursor=0;list.replaceChildren();results.replaceChildren();more.hidden=older.hidden=true;
      if(!target){panel.hidden=true;return;}title.textContent=target.title;draft.value=drafts.get(target.key)||'';
      picker.hidden=!!binding();results.hidden=!!binding();panel.hidden=!open;agent.value=target.agent||'codex';
      status(binding()?'Loading conversation…':'Choose the chat running in this pane. Replies are inserted into this terminal.');if(open&&binding())load(false);
    }
    // Poll only the visible transcript's last loaded page; never scan all history on a timer.
    setInterval(()=>{if(open&&!document.hidden&&panel.contains(document.activeElement)===false)load(true);},5000);
    window.SwitchboardConversation.update=update;update();
  }};
})();
