// A transcript reader over existing terminals. No provider process is started here.
(() => {
  // Provider marks, shared with the sidebar tab rows.
  const agentIcons={
    claude:'<svg viewBox="0 0 24 24" fill="#d97757"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
    codex:'<svg viewBox="0 0 24 24" fill="#c9d1dc"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
    copilot:'<svg viewBox="0 0 16 16" fill="none" stroke="#a3aec0" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="4" width="12" height="9" rx="4"/><path d="M6 8v1.5M10 8v1.5"/></svg>',
  };
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;};
  function textBlocks(parent,text){
    text.split('```').forEach((block,i)=>{
      if(i%2){const pre=el('pre'),lang=block.match(/^([\w+#.-]{1,24})\n/)?.[1];if(lang)pre.dataset.lang=lang;pre.append(el('code',block.replace(/^[\w+#.-]*\n/,'')));parent.append(pre);return;}
      for(const paragraph of block.trim().split(/\n\s*\n/)){
        if(!paragraph)continue;const p=el('p');paragraph.split('`').forEach((part,j)=>p.append(j%2?el('code',part):document.createTextNode(part)));parent.append(p);
      }
    });
  }
  // Light highlighting for common languages. Builds text nodes only; transcript text is untrusted.
  const keywords=/^(?:as|async|await|break|case|catch|class|const|continue|def|default|defer|do|elif|else|enum|export|extends|false|fn|for|from|func|function|go|if|impl|import|in|interface|let|loop|match|mod|mut|new|nil|None|null|package|pub|raise|return|self|static|struct|super|switch|this|throw|trait|true|True|False|try|type|typeof|undefined|use|var|where|while|with|yield)$/;
  const hashComments=/^(?:sh|bash|zsh|shell|console|py|python|rb|ruby|toml|yaml|yml|ps1|powershell|dockerfile|make|makefile)$/i;
  const plainLanguages=/^(?:text|txt|plain|log|output|diff|patch|md|markdown)$/i;
  function highlight(code,lang){
    if(!lang||plainLanguages.test(lang)||code.length>20000)return false;
    const hash=hashComments.test(lang),rust=/^(?:rs|rust)$/i.test(lang);
    const pattern=new RegExp(String.raw`(\/\*[\s\S]*?\*\/|\/\/[^\n]*${hash?String.raw`|#[^\n]*`:''})|("(?:\\.|[^"\\\n])*"|${rust?String.raw`'(?:\\.|[^'\\\n]){1,2}'`:String.raw`'(?:\\.|[^'\\\n])*'`}|\x60(?:\\.|[^\x60\\])*\x60)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|([{}()[\];,])`,'g');
    const out=document.createDocumentFragment();let last=0;
    for(const m of code.matchAll(pattern)){
      const cls=m[1]?'tok-c':m[2]?'tok-s':m[3]?'tok-n':m[4]?(keywords.test(m[4])?'tok-k':'tok-f'):m[6]?'tok-p':keywords.test(m[5])?'tok-k':null;
      if(!cls)continue;
      out.append(code.slice(last,m.index),el('span',m[0],cls));last=m.index+m[0].length;
    }
    out.append(code.slice(last));return out;
  }
  // A tool call on the rail: a quiet verb and what it acted on. The live row reads it in progress.
  const toolVerbs={run:['Ran','Running'],read:['Read','Reading'],edit:['Edited','Editing'],write:['Wrote','Writing'],search:['Searched','Searching'],fetch:['Fetched','Fetching'],agent:['Delegated','Delegating'],plan:['Updated the plan','Updating the plan'],tool:['Used','Using']};
  const codeTools=new Set(['run','read','edit','write','search']);
  function toolStep(article,item){
    const tool=Object.hasOwn(toolVerbs,item.tool)?item.tool:'tool',[past,present]=toolVerbs[tool],detail=String(item.detail||''),line=el('div',undefined,'conversation-tool');
    line.append(el('span',past,'conversation-tool-verb'));if(detail)line.append(' ',el(codeTools.has(tool)?'code':'span',detail,'conversation-tool-detail'));
    article.dataset.tool=tool;article.dataset.live=present+(detail?' '+detail:'')+'…';article.title=past+(detail?' '+detail:'');article.append(line);
  }
  const duration=seconds=>{seconds=Math.round(seconds);if(seconds<60)return seconds+'s';const minutes=Math.floor(seconds/60);if(minutes<60)return `${minutes}m ${seconds%60}s`;return `${Math.floor(minutes/60)}h ${minutes%60}m`;};
  function copyText(text){
    if(navigator.clipboard&&window.isSecureContext)return navigator.clipboard.writeText(text);
    const area=el('textarea');area.value=text;area.style.cssText='position:fixed;opacity:0';document.body.append(area);area.select();
    try{document.execCommand('copy');}finally{area.remove();}return Promise.resolve();
  }
  // Give each code block a card with its language and a copy button.
  function decorateCode(article){
    // Long inline paths break at separators instead of mid-word.
    for(const code of article.querySelectorAll('code')){
      if(code.closest('pre')||code.textContent.length<16||code.querySelector('wbr'))continue;
      const parts=code.textContent.split(/(?<=[\/\\])/);code.replaceChildren();
      parts.forEach((part,i)=>{if(i)code.append(el('wbr'));code.append(part);});
    }
    for(const pre of article.querySelectorAll('pre')){
      if(pre.parentNode.classList?.contains('conversation-code'))continue;
      const text=pre.textContent.replace(/\n$/,''),lang=pre.dataset.lang||'';
      const highlighted=highlight(text,lang);if(highlighted){const code=el('code');code.append(highlighted);pre.replaceChildren(code);}
      const card=el('div',undefined,'conversation-code'),bar=el('div',undefined,'conversation-code-bar'),copy=el('button','Copy');
      copy.type='button';copy.setAttribute('aria-label','Copy code');let reset;
      copy.onclick=()=>copyText(text).then(()=>{copy.textContent='Copied';clearTimeout(reset);reset=setTimeout(()=>{copy.textContent='Copy';},1500);},()=>{copy.textContent='Copy failed';});
      bar.append(el('span',lang||'code'),copy);pre.replaceWith(card);card.append(bar,pre);
      requestAnimationFrame(()=>pre.classList.toggle('fits',pre.scrollWidth<=pre.clientWidth+1));
    }
  }
  window.SwitchboardConversation={agentIcons,install({selection,terminal,modeChanged=()=>{},viewed=()=>{},switchModel=null}){
    const root=document.getElementById('terminals'),drafts=new Map(),attachments=new Map(),retryKeys=new Map();
    const mobile=matchMedia('(max-width:700px), (pointer:coarse) and (max-width:1000px)').matches;
    const modeKey=mobile?'switchboard-mobile-view-mode':'switchboard-view-mode';
    let savedMode;try{savedMode=localStorage.getItem(modeKey);}catch{}
    let target=null,open=savedMode? savedMode==='conversation':mobile,generation=0,startCursor=0,tailCursor=0,nextCursor=null,messages=[],loading=false,loaded=false,lastPaint=null,modeRevision=0,navigationRevision=0;
    const outgoing=new Map(),consumedTranscript=new Map(),pendingSends=new Map(),bridgeSends=new Map(),startups=new Map(),draftVersions=new Map(),firstSends=new Set();
    const conversations=new Map(),handoverDrafts=new Map();
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
      const version=generation,source=new EventSource('/api/chats/'+encodeURIComponent(chat.id)+'/stream?'+new URLSearchParams({host:target.chatHost||target.host,context:'true',cursor:nextCursor??tailCursor,limit:50}));stream=source;
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
    const panel=el('section',undefined,'conversation-panel');
    // CSS keeps a hidden panel laid out (see conversation.css), so hide it from assistive technology here.
    const setPanelHidden=value=>{panel.hidden=value;panel.setAttribute('aria-hidden',String(value));};setPanelHidden(true);panel.tabIndex=-1;panel.setAttribute('aria-label','Agent conversation');
    const header=el('header'),heading=el('div',undefined,'conversation-heading'),title=el('strong'),model=el(switchModel?'button':'span',undefined,'conversation-model'),activity=el('span',undefined,'conversation-activity'),terminalAction=el('button','Open Terminal','conversation-terminal-action');model.title=switchModel?'Switch between Claude and Codex with context':'Last reported model';if(switchModel){model.type='button';model.setAttribute('aria-label','Switch model with context');model.onclick=()=>switchModel(target);}activity.setAttribute('role','status');terminalAction.type='button';terminalAction.hidden=true;terminalAction.onclick=()=>show(false);const context=el('span',undefined,'conversation-context'),subtitle=el('div',undefined,'conversation-subtitle');subtitle.append(context,activity);heading.append(title,subtitle);header.append(heading,terminalAction);
    const notice=el('p','Loading this terminal’s conversation…','conversation-notice');notice.setAttribute('role','status');
    const list=el('div',undefined,'conversation-messages'),older=el('button','Load older messages'),refresh=el('button','↻'),latest=el('button','↓');refresh.setAttribute('aria-label','Refresh');refresh.title='Refresh conversation';latest.setAttribute('aria-label','Scroll to bottom');latest.title='Scroll to bottom';older.hidden=true;
    // One live row: a pulsing marker, the step in progress (or "Working"), and the elapsed time.
    // With earlier steps in this turn it is also their disclosure, showing them in place.
    const working=el('button',undefined,'conversation-working'),workingStep=el('span',undefined,'conversation-working-step'),workingTime=el('span',undefined,'conversation-working-time'),workingCount=el('span',undefined,'conversation-working-count');
    working.type='button';working.disabled=true;working.append(el('span',undefined,'conversation-working-dot'),workingStep,workingTime,workingCount);working.hidden=true;workingStep.dataset.step='Working';let liveStep=null,liveRun=null;working.setAttribute('aria-hidden','true');
    working.onclick=()=>{if(!liveRun||!liveStep)return;const id=identity(target)+':'+liveRun.start;expandedRuns.has(id)?expandedRuns.delete(id):expandedRuns.add(id);lastPaint=null;paint();};
    // Background agents that outlive the reply, one row each: the Claude mark ringed while it runs, its task, model and age.
    const claudeMark='<svg viewBox="0 0 256 257" aria-hidden="true"><path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"/></svg>';
    const background=el('div',undefined,'conversation-background');background.hidden=true;
    const recovery=el('div',undefined,'conversation-recovery'),retryConnection=el('button','Retry connection');recovery.hidden=true;retryConnection.type='button';retryConnection.onclick=()=>{if(target)startups.delete(identity(target));status(unboundNotice());updateActivity();prepare();};recovery.append(retryConnection);
    const historyStatus=el('span',undefined,'conversation-history-status');historyStatus.hidden=true;historyStatus.setAttribute('role','status');
    const actions=el('div',undefined,'conversation-actions');actions.append(refresh,latest);list.append(older,working,background);latest.hidden=refresh.hidden=true;
    const form=el('form',undefined,'conversation-compose'),draft=el('textarea'),insert=el('button','↑');draft.rows=1;draft.maxLength=16000;draft.placeholder='Message…';draft.setAttribute('aria-label','Reply draft');insert.type='submit';insert.setAttribute('aria-label','Send');insert.title='Send message';const attach=el('button','+','conversation-attach'),picker=el('input'),files=el('div',undefined,'conversation-attachments');attach.type='button';attach.setAttribute('aria-label','Attach files');attach.title='Attach photos or files';picker.type='file';picker.multiple=true;picker.hidden=true;files.hidden=true;
    const stop=el('button',undefined,'conversation-stop');stop.type='button';stop.setAttribute('aria-label','Stop');stop.title='Interrupt the agent (sends Esc)';
    stop.onclick=async()=>{
      const destination=target;if(!destination?.session||!Number.isInteger(destination.pane))return;stop.disabled=true;
      try{const response=await fetch('/api/hosts/'+encodeURIComponent(destination.host)+'/escape',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:destination.session,pane_id:destination.pane}),signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error();}
      catch{if(identity(target)===identity(destination))sendStatus('Could not interrupt the agent. Open Terminal and press Esc.');}
      finally{stop.disabled=false;}
    };
    form.append(files,attach,draft,model,insert,stop,picker);
    const sendNotice=el('small',undefined,'conversation-send-notice');sendNotice.hidden=true;sendNotice.setAttribute('role','status');form.append(sendNotice);
    const transportNotice=el('small','Replies use Terminal briefly, then return here.','conversation-transport-notice');transportNotice.hidden=true;form.append(transportNotice);
    const completions=el('div',undefined,'conversation-completions');completions.id='conversation-completions';completions.hidden=true;completions.setAttribute('role','listbox');completions.setAttribute('aria-label','Commands and skills');form.prepend(completions);
    draft.setAttribute('aria-autocomplete','list');draft.setAttribute('aria-controls',completions.id);draft.setAttribute('aria-expanded','false');
    const commands={codex:[['rename','Rename this conversation'],['compact','Compact conversation context'],['model','Choose a model'],['permissions','Change permissions'],['status','Show session status'],['skills','Browse skills'],['diff','Show changes'],['review','Review changes'],['resume','Resume a conversation'],['fork','Fork this conversation'],['new','Start a new conversation']],claude:[['rename','Rename this conversation'],['compact','Compact conversation context'],['model','Choose a model'],['permissions','Change permissions'],['status','Show session status'],['help','Show commands'],['clear','Clear conversation context'],['resume','Resume a conversation']]};
    const skillLists=new Map();let completionItems=[],completionIndex=0,completionToken=null;
    function completionContext(){
      if(!open||!target||document.activeElement!==draft||draft.selectionStart!==draft.selectionEnd)return null;
      const before=draft.value.slice(0,draft.selectionStart),slash=/^\/[\w:.-]*$/.exec(before),skill=/(?:^|\s)(\$[\w:.-]*)$/.exec(before);
      return slash?{prefix:'/',query:before.slice(1),start:0,end:before.length}:skill&&target.agent==='codex'?{prefix:'$',query:skill[1].slice(1),start:before.length-skill[1].length,end:before.length}:null;
    }
    function closeCompletions(){completions.hidden=true;completionItems=[];draft.setAttribute('aria-expanded','false');draft.removeAttribute('aria-activedescendant');}
    function selectCompletion(index){
      const item=completionItems[index],context=completionContext();if(!item||!context)return;
      draft.setRangeText(context.prefix+item.name+' ',context.start,context.end,'end');closeCompletions();draft.oninput();draft.focus({preventScroll:true});
    }
    function paintCompletions(reset=true){
      const context=completionContext();if(!context){closeCompletions();return;}
      const token=JSON.stringify([identity(target),context]);if(reset&&token!==completionToken)completionIndex=0;completionToken=token;
      const key=JSON.stringify([target.host,chat?.project||'']),skills=skillLists.get(key);
      const source=context.prefix==='/'?(commands[target.agent]||[]).map(([name,description])=>({name,description})):skills?.items||[];
      completionItems=source.filter(item=>item.name.toLowerCase().startsWith(context.query.toLowerCase())).slice(0,30);
      completions.replaceChildren();completionIndex=Math.min(completionIndex,Math.max(0,completionItems.length-1));
      completionItems.forEach((item,index)=>{const option=el('button',undefined,'conversation-completion');option.type='button';option.id='conversation-completion-'+index;option.setAttribute('role','option');option.setAttribute('aria-selected',String(index===completionIndex));option.append(el('strong',context.prefix+item.name),el('span',item.description));option.onpointerdown=event=>event.preventDefault();option.onclick=()=>selectCompletion(index);completions.append(option);});
      if(context.prefix==='$'&&!completionItems.length)completions.append(el('small',skills?.error||(!skills||skills.pending?'Loading skills…':'No matching skills')));
      completions.hidden=!completionItems.length&&context.prefix!=='$';draft.setAttribute('aria-expanded',String(!completions.hidden));
      if(completionItems.length){draft.setAttribute('aria-activedescendant','conversation-completion-'+completionIndex);completions.children[completionIndex].scrollIntoView({block:'nearest'});}else draft.removeAttribute('aria-activedescendant');
      if(context.prefix==='$'&&(!skills||Date.now()-skills.at>60000)&&!skills?.pending)void loadSkills(key,target.host,chat?.project||'');
    }
    async function loadSkills(key,host,cwd){
      const entry={pending:true,at:Date.now()};skillLists.set(key,entry);
      try{const response=await fetch('/api/hosts/'+encodeURIComponent(host)+'/conversation/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cwd}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error();const result=await response.json();if(!Array.isArray(result.skills))throw Error();entry.items=result.skills.filter(item=>typeof item.name==='string'&&typeof item.description==='string');}
      catch{entry.error='Skills unavailable. You can still type a skill name.';}
      finally{entry.pending=false;if(key===JSON.stringify([target?.host,chat?.project||'']))paintCompletions();}
    }
    draft.addEventListener('focus',()=>paintCompletions());draft.addEventListener('click',()=>paintCompletions());draft.addEventListener('blur',closeCompletions);
    let sendNoticeReceipt=null;
    function sendStatus(text,receipt=null){const follow=nearBottom();sendNoticeReceipt=receipt;if(sendNotice.textContent!==text)sendNotice.textContent=text;sendNotice.hidden=!text;if(form.isConnected){sizeDraft();if(follow){list.scrollTop=list.scrollHeight;updateLatest();}}}
    // Claude's numbered menus (permission prompts, questions), read from the pane by
    // the relay and answered with the keys Claude Code takes. Older relays answer 404.
    const question=el('section',undefined,'conversation-question'),questionStatus=el('small',undefined,'conversation-question-status');question.hidden=true;question.setAttribute('aria-label','Agent question');questionStatus.setAttribute('role','status');
    const promptHosts=new Set();let prompt=null,promptKey=null,promptSignature='',promptRequest=null,promptAt=0,answering=false,answered=null,promptError='',otherDraft='';
    panel.append(header,notice,recovery,list,historyStatus,actions,question,form);root.append(panel);
    const identity=t=>t?JSON.stringify([t.key,t.chatId]):null;
    let chat=null;
    const binding=()=>chat;
    const pendingFor=(key=identity(target))=>pendingSends.get(key);
    function status(text,quiet=false){if(launchShown()&&transitional.has(text))quiet=true;if(notice.textContent!==text)notice.textContent=text;notice.hidden=quiet;}
    // A tab started from New tab shows its prompt as sent, with a starting row under it, until the
    // transcript has it, instead of a run of connection notices and an empty page.
    const transitional=new Set(['Starting agent…','Connecting to this agent’s conversation…','Loading conversation…','Loading this terminal’s conversation…','No agent']);
    const launchNode=el('article',undefined,'conversation-message user conversation-outgoing conversation-launch sent');launchNode.dataset.conversationEntry='launch';
    function launchShown(){return !!target?.launch&&!messages.some(item=>item.role==='user'&&!setupMessage(item));}
    function paintLaunch(){
      if(!launchShown()){launchNode.remove();return;}
      const text=target.launch.text;if(launchNode.dataset.text!==text){launchNode.dataset.text=text;launchNode.replaceChildren(el('div','You','conversation-label'));textBlocks(launchNode,text);}
      if(launchNode.nextSibling!==working)working.before(launchNode);
    }
    function modelName(value){
      const raw=String(value?.model||'');
      return /^gpt-\d+(?:\.\d+)?-(?:sol|astra|luna|terra)(?:-codex)?$/i.test(raw)?raw.replace(/^gpt-/i,'').replace(/-/g,' ').replace(/\b[a-z]/g,char=>char.toUpperCase()):/^claude-(opus|sonnet|haiku|fable)-\d+(?:-\d+)?(?:-\d{8})?$/i.test(raw)?raw.replace(/^claude-/i,'').replace(/-\d{8}$/,'').replace(/^(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/i,'$1 $2.$3').replace(/-/g,' ').replace(/^\w/,char=>char.toUpperCase()):raw;
    }
    function effortName(value){const raw=String(value||'').trim();return /^xhigh$/i.test(raw)?'Extra High':raw.replace(/^\w/,char=>char.toUpperCase());}
    function providerLabel(){const agent=target?.agent||chat?.agent;return agent?agent[0].toUpperCase()+agent.slice(1):'Assistant';}
    // The model, then its effort as a dimmer word, the way T3 Code labels its model button.
    function paintModel(){
      const name=modelName(chat),label=name||(chat||target?.agent?providerLabel():''),effort=name?effortName(chat.reasoning_effort):'',agent=label?target?.agent||chat?.agent||'':'',signature=JSON.stringify([agent,label,effort]);
      if(model.dataset.painted===signature)return;model.dataset.painted=signature;
      const icon=agentIcons[agent]?el('span',undefined,'conversation-model-icon'):null;if(icon){icon.innerHTML=agentIcons[agent];icon.setAttribute('aria-hidden','true');}
      model.replaceChildren(...(icon?[icon]:[]),effort?`${label} `:label,...(effort?[el('span',effort,'conversation-effort')]:[]));
    }
    // The in-transcript indicator counts up from when the agent started this turn.
    let workingTimer=null;
    function backgroundAgents(){return target?.state==='waiting'&&Array.isArray(chat?.background)?chat.background:[];}
    function paintBackground(){
      const agents=chat?backgroundAgents():[],signature=JSON.stringify(agents.map(agent=>[agent.description,agent.model,agent.started]));
      background.hidden=!agents.length;
      if(background.dataset.signature!==signature){
        background.dataset.signature=signature;
        background.replaceChildren(...agents.map(agent=>{
          const row=el('div',undefined,'conversation-agent'),avatar=el('span',undefined,'conversation-agent-avatar'),model=modelLabel({model:agent.model}),time=el('span',undefined,'conversation-agent-time');
          avatar.innerHTML=claudeMark;time.dataset.started=agent.started||'';
          row.append(avatar,el('span',agent.description||'Background agent','conversation-agent-title'));if(model)row.append(el('span',model,'conversation-agent-model'));row.append(time);
          row.setAttribute('aria-label',`Background agent running: ${agent.description||'unnamed'}${model?`, ${model}`:''}`);return row;
        }));
      }
      for(const time of background.querySelectorAll('.conversation-agent-time')){const started=Date.parse(time.dataset.started)/1000,text=started>0?duration(Math.max(0,Date.now()/1000-started)):'';if(time.textContent!==text)time.textContent=text;}
    }
    function tickWorking(){
      clearTimeout(workingTimer);syncLiveStep();paintBackground();if((working.hidden&&background.hidden)||panel.hidden)return;
      const since=launchShown()?target.launch.at/1000:Number(target?.since),time=since>0?duration(Math.max(0,Date.now()/1000-since)):'';
      if(workingTime.textContent!==time)workingTime.textContent=time;workingTimer=setTimeout(tickWorking,1000);
    }
    // The newest progress update moves into the live row, so the step in progress
    // and the timer read as one line instead of two indicators.
    // After the reply ends, a background agent the transcript does not name keeps the row, without a step.
    function syncLiveStep(){
      const waiting=target?.state==='waiting',last=working.hidden||waiting?null:working.previousElementSibling,step=last?.classList.contains('commentary')&&!last.hidden?last:null;
      if(step!==liveStep){
        liveStep?.classList.remove('live');liveStep=step;
        // Shown through CSS content so the step's text stays in the transcript only once.
        if(step){step.classList.add('live');workingStep.dataset.step=step.dataset.live||[...step.childNodes].filter(node=>!node.classList?.contains('conversation-label')).map(node=>node.textContent).join(' ').replace(/\s+/g,' ').trim();}
        working.classList.toggle('has-step',!!step);
      }
      if(!step)workingStep.dataset.step=waiting?'Waiting on a background agent':launchShown()&&!target.agent?`Starting ${target.launch.agent==='codex'?'Codex':'Claude'}…`:'Working';
      const run=step&&liveRun,expanded=!!run&&!run.collapsed,count=run?`· ${run.count} steps`:'';
      working.classList.toggle('has-run',!!run);working.disabled=!run;if(workingCount.textContent!==count)workingCount.textContent=count;
      if(run){working.removeAttribute('aria-hidden');working.setAttribute('aria-expanded',String(expanded));working.setAttribute('aria-label',`${expanded?'Hide':'Show'} ${run.count-1} earlier step${run.count===2?'':'s'}`);}
      else{working.setAttribute('aria-hidden','true');working.removeAttribute('aria-expanded');working.removeAttribute('aria-label');}
    }
    function updateActivity(){
      const state=target?.state,label=state==='working'?'Working…':state==='approval'?'Approval needed':state==='input'?'Input needed':state==='waiting'?'Waiting on an agent':state==='ready'?'Ready':'';
      paintModel();
      if(switchModel)model.disabled=!target?.switchAvailable||!chat||!!pendingFor()||!!(outgoing.get(identity(target))||[]).length||!!(attachments.get(identity(target))||[]).length;
      if(activity.textContent!==label)activity.textContent=label;
      activity.classList.toggle('working',state==='working');
      const follow=nearBottom();paintLaunch();working.hidden=!launchShown()&&(!chat||!(state==='working'||state==='waiting'&&!backgroundAgents().length));tickWorking();
      if(follow)list.scrollTop=list.scrollHeight;
      const startup=startupState(),stalled=!!startup&&(!!startup.error||Date.now()-startup.started>=30000);
      terminalAction.hidden=!['approval','input'].includes(state)&&!stalled;recovery.hidden=!stalled||!!chat;
      const noComposer=!chat&&!firstMessage();if(form.hidden!==noComposer){form.hidden=noComposer;sizeDraft();}
      insert.disabled=!!pendingFor();
      // While the agent works, an empty composer offers Stop in the send button's place.
      form.classList.toggle('can-stop',state==='working'&&!!chat&&!!target?.session&&Number.isInteger(target?.pane));
      const project=String(chat?.project||'').replace(/[\\/]+$/,'').split(/[\\/]/).pop();
      const where=[project,target?.computer].filter(Boolean).join(' · ');if(context.textContent!==where)context.textContent=where;
      const placeholder=target?.agent?`Ask ${providerLabel()} a follow-up…`:'Message…';if(draft.placeholder!==placeholder)draft.placeholder=placeholder;
      transportNotice.hidden=!chat||!(target?.terminalReady===false&&target?.agent!=='claude'&&!(target?.agent==='codex'&&/^[0-9a-f-]{36}$/.test(chat.thread||'')));
      insert.setAttribute('aria-label',transportNotice.hidden?'Send':'Send via Terminal');insert.title=transportNotice.hidden?'Send message':'Send via Terminal and return to Conversation';
      paintPrompt();void loadPrompt();
    }
    function promptTarget(){const t=target;return open&&!panel.hidden&&!document.hidden&&t?.agent==='claude'&&['approval','input'].includes(t.state)&&!!t.session&&Number.isInteger(t.pane)&&Number.isInteger(t.tab)&&!promptHosts.has(t.host)?t:null;}
    const fits=(value,limit)=>typeof value==='string'&&value.length<=limit;
    function validPrompt(value){
      if(!value||!fits(value.question,4000)||!fits(value.token,64)||!Array.isArray(value.detail)||value.detail.length>80||!value.detail.every(line=>fits(line,2000))||!Array.isArray(value.choices)||value.choices.length<2||value.choices.length>20)return null;
      return value.choices.every(c=>fits(c.label,4000)&&(c.description===undefined||fits(c.description,8000))&&(c.number===null||Number.isInteger(c.number))&&(c.checked===null||typeof c.checked==='boolean')&&typeof c.text==='boolean')?value:null;
    }
    async function loadPrompt(force=false){
      const destination=promptTarget(),key=identity(destination);
      if(!destination){if(promptKey!==null){prompt=null;promptKey=null;promptError='';answered=null;paintPrompt();}return;}
      if(promptRequest||answering||(!force&&promptKey===key&&Date.now()-promptAt<1500))return;
      promptAt=Date.now();const request=promptRequest={};
      try{
        const response=await fetch('/api/hosts/'+encodeURIComponent(destination.host)+'/conversation/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:destination.session,tab_id:destination.tab,pane_id:destination.pane}),signal:AbortSignal.timeout(10000)});
        if(response.status===404){promptHosts.add(destination.host);return;}
        if(!response.ok)return;const data=await response.json();if(identity(target)!==key)return;
        const menu=validPrompt(data.prompt);
        // The screen can still show the menu just answered; keep it inert until it changes.
        if(answered&&(menu?.token!==answered.token||Date.now()-answered.at>3000))answered=null;
        if(promptKey!==key){otherDraft='';answered=null;}
        if(promptKey!==key||menu?.token!==prompt?.token)promptError='';
        prompt=menu;promptKey=key;paintPrompt();
      }catch{}
      finally{if(promptRequest===request)promptRequest=null;}
    }
    async function answer(menu,choice,reply){
      const destination=target,key=identity(destination);if(answering||answered||!destination)return;
      answering=true;promptError='';paintPrompt();let ok=false;
      try{
        const response=await fetch('/api/hosts/'+encodeURIComponent(destination.host)+'/conversation/answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:destination.session,tab_id:destination.tab,pane_id:destination.pane,token:menu.token,choice,...(reply===undefined?{}:{text:reply})}),signal:AbortSignal.timeout(10000)});
        ok=response.ok;if(!ok)promptError=(await response.text().catch(()=>''))||'Could not answer here. Open Terminal to answer.';
      }catch{promptError='No confirmation from this computer. Check Terminal before answering again.';}
      finally{
        answering=false;if(ok){answered={token:menu.token,at:Date.now()};if(reply!==undefined)otherDraft='';}
        if(identity(target)===key){paintPrompt();setTimeout(()=>loadPrompt(true),300);}
      }
    }
    function paintPrompt(){
      const menu=promptKey===identity(target)&&promptTarget()?prompt:null,signature=menu?JSON.stringify(menu):'',follow=nearBottom();
      if(signature!==promptSignature){
        promptSignature=signature;question.replaceChildren();
        if(menu){
          if(menu.detail.length){const detail=el('div',undefined,'conversation-question-detail');for(const line of menu.detail)detail.append(el('div',line));question.append(detail);}
          const choices=el('div',undefined,'conversation-question-choices');choices.setAttribute('role','group');
          const heading=el('p',menu.question,'conversation-question-text');heading.id='conversation-question-text';choices.setAttribute('aria-labelledby',heading.id);
          menu.choices.forEach((choice,index)=>{
            if(choice.text){
              const other=el('form',undefined,'conversation-question-other'),input=el('input'),send=el('button','Send');
              input.type='text';input.maxLength=4000;input.placeholder='Type something…';input.setAttribute('aria-label','Type your own answer');input.value=otherDraft;input.oninput=()=>{otherDraft=input.value;};
              send.type='submit';other.append(input,send);other.onsubmit=event=>{event.preventDefault();const reply=input.value.trim();if(reply&&!/[\x00-\x1f\x7f]/.test(reply))void answer(menu,index,reply);};
              choices.append(other);return;
            }
            const button=el('button',undefined,'conversation-question-choice');button.type='button';
            if(choice.checked!==null){button.classList.add('checkbox');button.setAttribute('aria-pressed',String(choice.checked));}
            if(choice.number===null)button.classList.add('submit');
            const body=el('span',undefined,'conversation-question-label');body.append(el('strong',choice.label));if(choice.description)body.append(el('span',choice.description));
            button.append(el('span',choice.number===null?'':String(choice.number),'conversation-question-number'),body);
            button.onclick=()=>void answer(menu,index);choices.append(button);
          });
          question.append(heading,choices,questionStatus);
        }
      }
      question.hidden=!menu;
      const inert=answering||!!answered;question.classList.toggle('answering',inert);
      for(const control of question.querySelectorAll('button,input'))control.disabled=inert;
      const note=promptError||(answering?'Answering…':'');if(questionStatus.textContent!==note)questionStatus.textContent=note;questionStatus.hidden=!note;
      if(!panel.hidden&&!form.hidden)sizeDraft();if(follow){list.scrollTop=list.scrollHeight;updateLatest();}
    }
    // A new Claude at its empty prompt has no transcript until its first message, which
    // the relay types into the prompt. Its connection timer starts after that message.
    // A launched prompt is the first message; offer the composer if it has not shown up within 30s.
    function firstMessage(){return !chat&&!(launchShown()&&Date.now()-target.launch.at<30000)&&target?.agent==='claude'&&target.state==='ready'&&!!target.session&&Number.isInteger(target.pane)&&!firstSends.has(target.key);}
    function startupState(){if(!target||chat||!target.agent&&!target.starting)return null;const key=identity(target);if(firstMessage()){startups.delete(key);return null;}if(!startups.has(key)&&open&&!document.hidden)startups.set(key,{started:Date.now()});return startups.get(key);}
    function unboundNotice(){if(firstMessage())return 'Send a message to start the conversation.';const startup=startupState();return startup?.error||(startup&&Date.now()-startup.started>=30000?'The agent has not connected. Retry or open Terminal.':target?.starting?'Starting agent…':target?.agent?'Connecting to this agent’s conversation…':'No agent');}
    function busy(value){loading=value;older.disabled=refresh.disabled=value;}
    // Touch screens open the on-screen keyboard over the conversation when the draft gains focus, so
    // there navigation focuses the panel for reading and only a tap on the draft starts a reply. A
    // draft already in use keeps focus unless the selected conversation changes.
    function focusSurface(navigated=false){if(panel.hidden||!navigated&&document.activeElement===draft)return;(form.hidden||matchMedia('(pointer:coarse)').matches?panel:draft).focus({preventScroll:true});}
    function show(value,transient=false){if(!transient)modeRevision++;if(!value){closeCompletions();stopStream();loadRequest?.abort();window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();}open=value;root.classList.toggle('conversation-open',open);modeChanged();if(!transient)try{localStorage.setItem(modeKey,value?'conversation':'terminal');}catch{}setPanelHidden(!value);toggle.setAttribute('aria-pressed',String(value));back.setAttribute('aria-pressed',String(!value));if(value){document.getElementById('artifact-preview').hidden=true;update();if(loaded){paint(false,restorePosition===null&&lastPaint===null);if(restorePosition!==null){list.scrollTop=restorePosition.follow?list.scrollHeight:restorePosition.position;restorePosition=null;updateLatest();}}if(binding())load(loaded?'poll':'initial');startStream();focusSurface();}else if(target)terminal(target);viewport();}

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
    const rendered=new Map(),renderedOutgoing=new Map(),summaries=new Map(),expandedRuns=new Set();
    const isCommentary=item=>item.role==='assistant'&&item.phase==='commentary';
    // A finished run of two or more progress updates folds behind one summary line.
    // A run still in progress shows only its newest update; earlier ones fold the same
    // way, under the same key, so expanding one keeps it open once the answer lands.
    function activityRuns(){
      const visible=[],runs=new Map();
      for(const [offset,item] of messages.entries())if(!setupMessage(item))visible.push({key:startCursor+offset,item});
      for(let i=0;i<visible.length;){
        if(!isCommentary(visible[i].item)){i++;continue;}
        let end=i;while(end+1<visible.length&&isCommentary(visible[end+1].item))end++;
        const after=visible[end+1],count=end-i+1;
        if(after&&count>=2){
          const before=visible[i-1]?.item.role==='user'?visible[i-1].item:visible[i].item;
          const elapsed=(Date.parse(after.item.timestamp)-Date.parse(before.timestamp))/1000;
          const run={start:visible[i].key,collapsed:!expandedRuns.has(identity(target)+':'+visible[i].key),label:(Number.isFinite(elapsed)&&elapsed>0?`${providerLabel()} worked for ${duration(elapsed)} · `:`${providerLabel()} · `)+`${count} steps`};
          for(let j=i;j<=end;j++)runs.set(visible[j].key,run);
        }else if(!after&&count>=2){
          // While the agent works, the live row is this run's disclosure and the summary is hidden.
          const earlier=count-1,run={start:visible[i].key,count,inProgress:true,collapsed:!expandedRuns.has(identity(target)+':'+visible[i].key),label:`${earlier} earlier step${earlier===1?'':'s'}`};
          for(let j=i;j<end;j++)runs.set(visible[j].key,run);
        }
        i=end+1;
      }
      return runs;
    }
    // Each message is serialized once. Polls replace only the newest page, so a
    // long transcript's earlier messages keep their objects and signatures.
    const signatures=new WeakMap();
    function signatureOf(item){let signature=signatures.get(item);if(signature===undefined){signature=JSON.stringify(item);signatures.set(item,signature);}return signature;}
    const uuid='[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
    // The native queue stores generated mailbox wake-ups as ordinary user input.
    // Match the generated envelope, not general discussion of Switchboard mail.
    const mailboxNotice=new RegExp('^New Switchboard messages: ('+uuid+'(?:, '+uuid+')*)\\. Read them with `zellij message --agent-session '+uuid+' unread --json` and `zellij message unread --computer [0-9a-f]{64} --json`\\. Reply using this agent identity when an answer is needed, and explicitly acknowledge receipt\\.(?: |$)','i');
    function mailboxCount(item){return item.role==='user'?(mailboxNotice.exec((item.receipt_text??item.text??'').trimStart())?.[1].split(', ').length||0):0;}
    function setupMessage(item){return item.role==='user'&&/^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<skills_instructions>)/.test((item.text||'').trimStart());}
    function normalizeMessage(value){return String(value||'').replace(/\r\n/g,'\n');}
    function sameMessage(a,b){return normalizeMessage(a)===normalizeMessage(b);}
    // Claude swaps an attached image's path for an image block and leaves "[Image #N]",
    // so its transcript entry lacks the file list the composer sent; compare what remains.
    const attachedList=/\n*Attached (?:files|images):(?:\n[^\n]*)*\n*$/,withoutFiles=value=>normalizeMessage(value).replace(/\[Image #\d+\]/g,'').replace(attachedList,'').trim();
    function sameTranscript(entry,payload){return sameMessage(entry,payload)||withoutFiles(entry)===withoutFiles(payload)&&attachedList.test(normalizeMessage(entry))&&attachedList.test(normalizeMessage(payload));}
    function outgoingLabel(state){return state==='sending'?'Sending…':state==='queued'?'Queued':state==='sent'?'Sent':'Could not confirm sending';}
    function sendItem(sent,state,detail){sent.state=state;sent.detail=detail||'';if(identity(target)===sent.key)paint();}
    function nearBottom(){return list.scrollHeight-list.scrollTop-list.clientHeight<80;}
    let following=true,readingAnchor=null;
    function rememberReading(){
      following=nearBottom();
      if(following){readingAnchor=null;return;}
      const top=list.getBoundingClientRect().top,node=[...list.querySelectorAll('.conversation-message')].find(node=>node.getBoundingClientRect().bottom>top);
      readingAnchor=node?{node,id:node.dataset.conversationEntry,offset:node.getBoundingClientRect().top-top}:null;
    }
    // Resize observers run after layout and before paint, so correcting here keeps the
    // reader's place in the same frame an image or code block above them grows.
    const contentResize=globalThis.ResizeObserver?new ResizeObserver(()=>{
      if(panel.hidden||!loaded)return;
      if(following)list.scrollTop=list.scrollHeight;
      else if(readingAnchor){const node=readingAnchor.node.isConnected?readingAnchor.node:[...list.querySelectorAll('.conversation-message')].find(node=>node.dataset.conversationEntry===readingAnchor.id);if(node)list.scrollTop+=node.getBoundingClientRect().top-list.getBoundingClientRect().top-readingAnchor.offset;}
      updateLatest();rememberReading();
    }):null;
    contentResize?.observe(list);contentResize?.observe(working);
    if(globalThis.ResizeObserver)new ResizeObserver(()=>panel.style.setProperty('--conversation-header-height',header.offsetHeight+'px')).observe(header);
    function updateLatest(){latest.hidden=nearBottom();if(latest.hidden)newOutput=false;latest.textContent=newOutput?'↓ New messages':'↓ Latest';actions.hidden=latest.hidden&&refresh.hidden;}
    // The scrollbar shows only while the reader scrolls, not when new output, the composer
    // growing or a resize moves the list.
    let scrollInput=0;for(const type of ['wheel','touchmove','pointerdown','keydown'])list.addEventListener(type,()=>{scrollInput=Date.now();},{passive:true});
    list.addEventListener('scroll',()=>{rememberReading();if(Date.now()-scrollInput<1000){list.classList.add('scrolling');clearTimeout(scrollIdle);scrollIdle=setTimeout(()=>list.classList.remove('scrolling'),700);}updateLatest();if(loaded&&startCursor>0&&list.scrollTop<80&&!loading&&older.hidden)load('older');},{passive:true});
    function paint(prepend=false,initial=false){
      const key=identity(target),sentItems=outgoing.get(key)||[],used=consumedTranscript.get(key)||new Set();
      for(const sent of sentItems){
        if(sent.transcriptCursor!==undefined)continue;
        // Cursors can shift down when the relay hides records that settle (interrupts, local
        // command output), so an entry written after the send also counts by its timestamp.
        const after=(item,offset)=>startCursor+offset>sent.baseline||Date.parse(item.timestamp)>=sent.at-30000&&!sent.earlier.has(item.timestamp);
        const match=messages.findIndex((item,offset)=>after(item,offset)&&item.role==='user'&&!used.has(startCursor+offset)&&sameTranscript(item.receipt_text??item.text??'',sent.payload));
        if(match>=0){sent.transcriptCursor=startCursor+match;used.add(sent.transcriptCursor);if(pendingFor(sent.key)===sent){pendingSends.delete(sent.key);sent.request?.abort();}clearSentDraft(sent);}
      }
      consumedTranscript.set(key,used);
      outgoing.set(key,sentItems.filter(item=>item.transcriptCursor===undefined));
      const visibleOutgoing=sentItems.filter(item=>item.transcriptCursor===undefined);
      const snapshot={start:startCursor,messages:messages.map(signatureOf),outgoing:JSON.stringify(visibleOutgoing.map(({id,text,files,state,detail})=>({id,text,files:files.map(file=>file.name),state,detail})))};
      if(lastPaint&&lastPaint.start===snapshot.start&&lastPaint.outgoing===snapshot.outgoing&&lastPaint.messages.length===snapshot.messages.length&&snapshot.messages.every((signature,i)=>signature===lastPaint.messages[i]))return;
      lastPaint=snapshot;
      // The transcript now has the launched prompt: drop the stand-in and its starting row.
      if(launchNode.isConnected&&!launchShown())updateActivity();
      const follow=initial||nearBottom(),height=list.scrollHeight,position=list.scrollTop,keys=new Set();
      if(!follow&&!prepend&&!initial)newOutput=true;
      older.hidden=true;
      let previous=older,previousRole=null,previousSpeaker=null;
      const runs=activityRuns(),summaryKeys=new Set();liveRun=[...runs.values()].find(run=>run.inProgress)||null;
      for(const [offset,item] of messages.entries()){
        if(setupMessage(item))continue;
        const notices=mailboxCount(item),key=startCursor+offset,signature=snapshot.messages[offset],speaker=notices?'Switchboard':item.role==='user'?'You':providerLabel();keys.add(key);
        const run=runs.get(key);
        if(run?.start===key){
          let summary=summaries.get(key);
          if(!summary){summary=el('button',undefined,'conversation-steps');summary.type='button';summary.onclick=()=>{const id=identity(target)+':'+key;expandedRuns.has(id)?expandedRuns.delete(id):expandedRuns.add(id);lastPaint=null;paint();};summaries.set(key,summary);}
          if(summary.textContent!==run.label)summary.textContent=run.label;summary.setAttribute('aria-expanded',String(!run.collapsed));summary.classList.toggle('in-progress',!!run.inProgress);summaryKeys.add(key);
          if(previous.nextSibling!==summary)previous.after(summary);previous=summary;
        }
        let entry=rendered.get(key);
        if(!entry||entry.signature!==signature){
          const article=el(notices?'details':'article',undefined,'conversation-message '+(notices?'conversation-notification':item.role+(item.phase==='commentary'?' commentary':'')+(item.kind==='tool'?' tool':'')));
          article.dataset.conversationEntry='message-'+key;contentResize?.observe(article);
          if(notices){
            article.append(el('summary','Switchboard · '+notices+' message'+(notices===1?'':'s')));
            const body=el('div',undefined,'conversation-notification-body');textBlocks(body,item.text||'');article.append(body);article.open=entry?.node.open||false;
          }else{
            article.append(el('div',speaker,'conversation-label'));
            if(item.kind==='tool')toolStep(article,item);
            else{if(window.SwitchboardConversationMedia&&(item.markdown||item.attachments))window.SwitchboardConversationMedia.render(article,item,{host:target.host,project:binding()?.project});else textBlocks(article,item.text||'');
              decorateCode(article);}
          }
          if(item.truncated)article.append(el('small','Message truncated by history API. Open the terminal for full context.'));
          if(entry){contentResize?.unobserve(entry.node);entry.node.remove();}entry={signature,node:article};rendered.set(key,entry);
        }
        entry.node.classList.toggle('continuation',previousRole==='assistant'&&item.role==='assistant'&&previousSpeaker===speaker);previousRole=notices?'notification':item.role;previousSpeaker=speaker;
        entry.node.hidden=!!run?.collapsed;
        if(previous.nextSibling!==entry.node)previous.after(entry.node);
        previous=entry.node;
      }
      for(const [key,entry] of rendered)if(!keys.has(key)){contentResize?.unobserve(entry.node);entry.node.remove();rendered.delete(key);}
      for(const [key,summary] of summaries)if(!summaryKeys.has(key)){summary.remove();summaries.delete(key);}
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
      if(list.lastChild!==background||background.previousSibling!==working)list.append(working,background);
      if(prepend)list.scrollTop=position+list.scrollHeight-height;
      else if(follow)list.scrollTop=list.scrollHeight;
      syncLiveStep();updateLatest();rememberReading();paintFiles();
    }
    function applyPage(data,kind,cursor){
      const initial=kind==='initial',prepend=kind==='older',page=data.messages||[],start=data.start_cursor??(initial?0:prepend?Math.max(0,startCursor-page.length):cursor);
      chat.project=data.project||chat.project;chat.thread=data.session_id||chat.thread;
      if('model' in data)chat.model=data.model;
      if('reasoning_effort' in data)chat.reasoning_effort=data.reasoning_effort;
      if(Array.isArray(data.background_agents))chat.background=data.background_agents;
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
      const params={host:target.chatHost||target.host,context:'true',limit:initial&&(mobile||navigator.connection?.saveData)?15:50};
      if(initial)params.tail=true;else if(prepend)params.before=startCursor;else params.cursor=cursor;
      try{const data=await get('/api/chats/'+encodeURIComponent(chat.id)+'?'+new URLSearchParams(params),request.signal);if(version!==generation)return;
        applyPage(data,kind,cursor);streamSupported=data.stream===true;startStream();const warning=partialNotice(data);status(warning,!warning);if(warning){reportLoad(kind,'partial',started);lastFailure='partial';}else if(lastFailure){reportLoad(kind,'recovered',started);lastFailure=null;}updateLatest();catchUp=nextCursor!==null&&!prepend;
      }catch(error){if(version===generation&&!(!timedOut&&request.signal.aborted)){const outcome=timedOut?'timeout':error.code||'network';lastFailure=outcome;reportLoad(kind,outcome,started);const message=timedOut?'Loading took too long. Retrying…':error.code?error.message:'Connection interrupted. Retrying…';if(prepend){older.textContent='Retry earlier messages';older.hidden=false;}else{status(message);refresh.hidden=false;updateLatest();}}}finally{clearTimeout(timeout);if(loadRequest===request)loadRequest=null;if(version===generation){busy(false);historyStatus.hidden=true;for(const data of streamPages)streamPage(data);streamPages=[];if(catchUp)setTimeout(()=>{if(version===generation)load();},0);else if(open&&loaded&&startCursor>0&&older.hidden&&list.scrollHeight<=list.clientHeight)setTimeout(()=>{if(version===generation)load('older');},0);}}
    }
    older.onclick=()=>load('older');refresh.onclick=()=>load(messages.length?'poll':'initial');latest.onclick=()=>{list.scrollTop=list.scrollHeight;rememberReading();updateLatest();};
    let draftSizeKey;
    function sizeDraft(){
      if(panel.hidden||form.hidden)return;
      const key=JSON.stringify([draft.value,draft.clientWidth,window.visualViewport?.height||innerHeight]);
      const follow=nearBottom(),limit=Math.min(144,Math.max(60,(window.visualViewport?.height||innerHeight)*.25));
      if(key!==draftSizeKey){draftSizeKey=key;draft.style.height='0px';const height=draft.scrollHeight;draft.style.height=Math.min(height,limit)+'px';draft.style.overflowY=height>limit?'auto':'hidden';}
      panel.style.setProperty('--composer-height',form.offsetHeight+(question.hidden?0:question.offsetHeight+8)+'px');if(follow)list.scrollTop=list.scrollHeight;updateLatest();
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
      if(switchModel)updateActivity();
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
    draft.oninput=()=>{if(target){const key=identity(target);drafts.set(key,draft.value);draftVersions.set(key,(draftVersions.get(key)||0)+1);}sizeDraft();if(!pendingFor())sendStatus('');paintCompletions();};
    draft.onkeydown=event=>{
      if(event.isComposing)return;
      if(!completions.hidden&&!event.ctrlKey&&!event.altKey&&!event.metaKey){
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeCompletions();return;}
        if(completionItems.length&&['ArrowDown','ArrowUp','Tab','Enter'].includes(event.key)&&!event.shiftKey){event.preventDefault();event.stopPropagation();if(event.key==='Tab'||event.key==='Enter')selectCompletion(completionIndex);else{completionIndex=(completionIndex+(event.key==='ArrowDown'?1:-1)+completionItems.length)%completionItems.length;paintCompletions(false);}return;}
      }
      if(event.key==='Enter'&&!event.shiftKey&&!matchMedia('(pointer:coarse)').matches){event.preventDefault();form.requestSubmit();}
    };
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
      // The transcript can acknowledge a send before the relay answers; still say
      // where a terminal draft set aside for it went.
      if(pendingFor(sent.key)!==sent){if(ok&&message&&!pendingFor(sent.key)&&identity(target)===sent.key)sendStatus(message,sent);return;}
      pendingSends.delete(sent.key);
      if(ok){clearSentDraft(sent);if(sent.command){outgoing.set(sent.key,(outgoing.get(sent.key)||[]).filter(item=>item!==sent));if(identity(target)===sent.key)paint();}else sendItem(sent,sent.native||sent.relay?'queued':'sent');}
      else sendItem(sent,uncertain?'uncertain':'failed',message);
      returnToConversation(sent);
      if(identity(target)===sent.key){sendStatus(message,sent);if(ok)load();}paintFiles();
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
      event.preventDefault();const current=selection();if(!target||identity(current)!==identity(target)||!binding()&&!firstMessage()||(!draft.value.trim()&&!fileList().length)||pendingFor())return;
      // Waiting: the turn ended while background work runs; the prompt still takes input.
      if(!['ready','waiting','working'].includes(current.state)){sendStatus(question.hidden?'The agent needs attention in Terminal. Your draft is kept.':'Answer the agent’s question first. Your draft is kept.');return;}
      const selected=fileList();if(selected.some(item=>!item.path)){sendStatus(selected.some(item=>item.error)?'Remove failed attachments before sending.':'Wait for attachments to finish uploading.');return;}
      const text=draft.value,payload=text+(selected.length?'\n\nAttached files:\n'+selected.map(item=>item.path).join('\n'):'');
      if(/[\x00-\x08\x0b-\x1f\x7f]/.test(payload)){sendStatus('The draft contains terminal control characters. Remove them first.');return;}
      const command=/^\/[a-z][\w:.-]*(?:\s|$)/i.test(text),native=!command&&current.agent==='codex'&&/^[0-9a-f-]{36}$/.test(chat?.thread||'');
      if(command&&selected.length){sendStatus('Send commands without attachments. Your draft is kept.');return;}
      // Claude queues a command typed while it works; Codex refuses most of them.
      if(command&&current.agent!=='claude'&&!['ready','waiting'].includes(current.state)){sendStatus('Wait for the agent to finish before sending a command. Your draft is kept.');return;}
      if(current.state==='working'&&!native&&current.agent!=='claude'){sendStatus('Still connecting to this conversation. Try sending again in a moment.');return;}
      if(new TextEncoder().encode(payload).length>(native?8192:16000)){sendStatus('This message is too long. Shorten it before sending.');return;}
      const retry=native&&(outgoing.get(identity(target))||[]).find(item=>['failed','uncertain'].includes(item.state)&&item.native&&sameMessage(item.payload,payload));
      if(retry){retrySend(retry,true);return;}
      const key=identity(target),id='conversation-'+Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');
      const items=outgoing.get(key)||[],failedBridge=!native&&items.find(item=>item.state==='failed'&&!item.native&&sameMessage(item.payload,payload));
      const sent={id,key,pane:target.key,unbound:!chat,frame:target.frame,text,payload,files:[...selected],native,command,host:target.host,thread:chat?.thread,draftRevision:draftVersions.get(key)||0,baseline:failedBridge?failedBridge.baseline:startCursor+messages.length-1,at:failedBridge?failedBridge.at:Date.now(),earlier:failedBridge?failedBridge.earlier:new Set(messages.filter(item=>item.role==='user'&&item.timestamp).map(item=>item.timestamp)),sendKey:id,state:'sending'};
      if(failedBridge)items[items.indexOf(failedBridge)]=sent;else items.push(sent);
      outgoing.set(key,items);pendingSends.set(key,sent);insert.disabled=true;paintFiles();sendStatus('');paint();
      if(native){
        const prior=retryKeys.get(key),sendKey=prior?.payload===payload?prior.id:id;sent.sendKey=sendKey;retryKeys.set(key,{payload,id:sendKey});
        await sendNative(sent);return;
      }
      // The relay types Claude replies into the pane, so Conversation stays on screen.
      // Older relays answer 404 and use the terminal below.
      if(current.agent==='claude'&&!command){
        try{
          const response=await fetch('/api/hosts/'+encodeURIComponent(sent.host)+'/conversation/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:current.session,tab_id:current.tab,pane_id:current.pane,text:payload}),signal:AbortSignal.timeout(20000)});
          // An accepted first message starts the connection timer, whatever the pane reads next.
          if(response.ok&&sent.unbound){firstSends.add(sent.pane);if(identity(selection())===sent.key){updateActivity();status(unboundNotice(),loaded);}}
          // A draft typed in Terminal is set aside and restored; the relay says if it was not.
          if(response.status!==404){sent.relay=true;complete(sent,response.ok,response.ok?(await response.json().catch(()=>({}))).notice||'':(await response.text())||'Could not send the reply. Your draft is kept.');return;}
        }catch(error){const timeout=error.name==='TimeoutError';complete(sent,false,timeout?'No confirmation from the terminal. Check it before trying again; your draft is kept.':'Could not reach this computer. Your draft is kept.',timeout);return;}
      }
      // Agents without a native reply API need the visible terminal connection.
      // Attach only after leaving Conversation, then wait for the selected pane.
      if(command||current.terminalReady===false){
        sent.returnHere=!command;sent.modeRevision=modeRevision;sent.navigationRevision=navigationRevision;show(false,true);
        const deadline=Date.now()+10000;
        while(pendingFor(key)===sent&&identity(selection())===key&&!selection()?.terminalReady&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
        if(pendingFor(key)!==sent)return;
        if(identity(selection())!==key||!selection()?.terminalReady){complete(sent,false,'Terminal is not ready. Your draft is kept.');return;}
      }
      // Found by id until its result arrives, even once the transcript acknowledged it.
      bridgeSends.set(id,sent);
      sent.frame.contentWindow.postMessage({type:'zellij-conversation-paste',id,pane_id:current.pane,agent:current.agent,submit:true,text:payload},location.origin);
      setTimeout(()=>complete(sent,false,'No confirmation from the terminal. Check it before trying again; your draft is kept.'),4000);
    };
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||event.data?.type!=='zellij-conversation-paste-result')return;
      const sent=bridgeSends.get(event.data.id);if(!sent||event.source!==sent.frame?.contentWindow)return;bridgeSends.delete(sent.id);
      complete(sent,event.data.ok,event.data.ok?event.data.notice||'':event.data.error||'Open the terminal and try again.');
    });
    function update(){
      root.classList.toggle('conversation-open',open);
      const current=selection();modes.hidden=!current;
      title.textContent=current?.title||'Conversation';
      if(identity(current)===identity(target)){target=current;updateActivity();if(!chat)status(unboundNotice());prepare();return;}
      closeCompletions();navigationRevision++;
      if(target)drafts.set(identity(target),draft.value);
      if(target&&loaded){conversations.delete(identity(target));conversations.set(identity(target),{chat,messages,startCursor,tailCursor,nextCursor,streamSupported,position:restorePosition?.position??list.scrollTop,follow:restorePosition?.follow??nearBottom()});if(conversations.size>8)conversations.delete(conversations.keys().next().value);}
      window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();
      stopStream();streamSupported=false;restorePosition=null;target=current;loadRequest?.abort();lastFailure=null;lastDiagnostic='';newOutput=false;sendStatus('');generation++;loaded=false;lastPaint=null;busy(false);messages=[];startCursor=tailCursor=0;nextCursor=null;following=true;readingAnchor=null;for(const entry of [...rendered.values(),...renderedOutgoing.values()])contentResize?.unobserve(entry.node);rendered.clear();renderedOutgoing.clear();summaries.clear();list.replaceChildren(older,working);older.hidden=true;historyStatus.hidden=true;latest.hidden=refresh.hidden=true;
      chat=target?.chatId?{id:target.chatId,agent:target.agent,title:target.title}:null;
      // A first message sent before the pane had a chat moves to the chat it started.
      if(chat){const unbound=JSON.stringify([target.key,null]),bound=identity(target);
        for(const map of [outgoing,pendingSends,drafts,draftVersions,consumedTranscript,attachments])if(map.has(unbound)&&!map.has(bound)){map.set(bound,map.get(unbound));map.delete(unbound);}
        for(const item of outgoing.get(bound)||[])item.key=bound;}
      if(target&&chat&&handoverDrafts.has(target.key)){drafts.set(identity(target),handoverDrafts.get(target.key));handoverDrafts.delete(target.key);}
      const cached=conversations.get(identity(target));if(cached){({chat,messages,startCursor,tailCursor,nextCursor,streamSupported}=cached);loaded=true;}
      updateActivity();actions.hidden=true;
      if(!target){setPanelHidden(true);viewport();return;}draft.value=drafts.get(identity(target))||'';
      setPanelHidden(!open);paintFiles();viewport();
      status(chat?'Loading conversation…':unboundNotice(),loaded);
      if(cached){if(open){paint();list.scrollTop=cached.follow?list.scrollHeight:cached.position;updateLatest();}else restorePosition=cached;}if(open)focusSurface(true);if(chat){load(loaded?'poll':'initial');startStream();}prepare();
    }
    // Open at the latest messages; older history is fetched only on request.
    setInterval(()=>{if(open&&!document.hidden){if(!chat){status(unboundNotice());updateActivity();}prepare();void loadPrompt();if(!streamReady)load();}},2000);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stopStream();else if(open){load();startStream();}});
    window.addEventListener('focus',()=>{if(open&&!document.hidden)load();});
    window.addEventListener('pagehide',()=>{stopStream();loadRequest?.abort();});
    window.SwitchboardConversation.hasUnsentWork=()=>!!pendingSends.size||[...outgoing.values()].some(items=>items.length)||!!draft.value||[...drafts.values()].some(Boolean)||[...attachments.values()].some(files=>files.length);
    const handoverKey=source=>JSON.stringify([JSON.stringify([source.host,source.target.session,source.target.pane_id]),source.chatId]);
    window.SwitchboardConversation.canHandover=source=>{const key=handoverKey(source);return !pendingFor(key)&&!(outgoing.get(key)||[]).length&&!(attachments.get(key)||[]).length;};
    window.SwitchboardConversation.handoverDraft=source=>identity(target)===handoverKey(source)?draft.value:drafts.get(handoverKey(source))||'';
    window.SwitchboardConversation.handoverSent=(source,text,pane)=>{
      const key=handoverKey(source),original=identity(target)===key?draft.value:drafts.get(key)||'',next=JSON.stringify([source.host,source.target.session,pane]);
      if(identity(target)===key)draft.value='';drafts.delete(key);
      if(original&&original!==text){if(target?.key===next&&!draft.value){draft.value=original;drafts.set(identity(target),original);}else handoverDrafts.set(next,original);}
    };
    window.SwitchboardConversation.wantsConversation=()=>open;window.SwitchboardConversation.update=update;window.SwitchboardConversation.isOpen=()=>open&&!panel.hidden;window.SwitchboardConversation.focus=focusSurface;window.SwitchboardConversation.showTerminal=()=>show(false);update();
  }};
})();
