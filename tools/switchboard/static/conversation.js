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
  // Match whole skill tokens against this host and project's catalog. Keep the original
  // spelling as the button text (and when copied); CSS supplies its shorter visual label.
  function skillTextNodes(article){
    const walker=document.createTreeWalker(article,NodeFilter.SHOW_TEXT),nodes=[];
    while(walker.nextNode())if(!walker.currentNode.parentElement.closest('pre,code,a,button,.conversation-label,.conversation-outgoing-status'))nodes.push(walker.currentNode);
    return nodes;
  }
  function skillChip(skill,raw){
    const label=skill.displayName?.trim()||skill.name.split(':').pop(),chip=el('button',raw,'conversation-skill');
    chip.type='button';chip.dataset.label=label;chip.title=raw;chip.setAttribute('aria-label','Skill '+label+'. Show details');
    chip.onclick=()=>{
      const popup=el('div',undefined,'conversation-skill-details');popup.setAttribute('popover','auto');
      popup.append(el('strong',label),el('code',raw),el('p',skill.description||'No description is available for this skill.'));
      popup.addEventListener('toggle',()=>{if(!popup.matches(':popover-open'))popup.remove();});
      chip.closest('.conversation-panel,dialog').append(popup);popup.showPopover();
      const rect=chip.getBoundingClientRect(),box=popup.getBoundingClientRect();
      popup.style.left=Math.max(8,Math.min(rect.left,innerWidth-box.width-8))+'px';
      popup.style.top=Math.max(8,rect.top>=box.height+8?rect.top-box.height-6:Math.min(rect.bottom+6,innerHeight-box.height-8))+'px';
    };return chip;
  }
  function decorateSkills(article,skills,agent){
    const names=new Map(skills.map(skill=>[skill.name,skill]));
    for(const node of skillTextNodes(article)){
      const text=node.textContent,out=document.createDocumentFragment();let cursor=0;
      for(const match of text.matchAll(/(^|\s)([$/])([a-zA-Z0-9][\w:.-]*)(?=\s|$)/g)){
        if(match[2]==='/'&&agent!=='claude')continue;
        const skill=names.get(match[3]);if(!skill)continue;
        const start=match.index+match[1].length,raw=match[2]+match[3];
        out.append(text.slice(cursor,start),skillChip(skill,raw));cursor=start+raw.length;
      }
      if(cursor){out.append(text.slice(cursor));node.replaceWith(out);}
    }
  }
  // Light highlighting for common languages. Builds text nodes only; transcript text is untrusted.
  const keywords=/^(?:as|async|await|break|case|catch|class|const|continue|def|default|defer|do|elif|else|enum|export|extends|false|fn|for|from|func|function|go|if|impl|import|in|interface|let|loop|match|mod|mut|new|nil|None|null|package|pub|raise|return|self|static|struct|super|switch|this|throw|trait|true|True|False|try|type|typeof|undefined|use|var|where|while|with|yield)$/;
  const hashComments=/^(?:sh|bash|zsh|shell|console|py|python|rb|ruby|toml|yaml|yml|ps1|powershell|dockerfile|make|makefile)$/i;
  const plainLanguages=/^(?:text|txt|plain|log|output|diff|patch|md|markdown|mermaid)$/i;
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
  const messageTime=value=>typeof value==='number'?value:Date.parse(value);
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
      if(/^mermaid$/i.test(lang))window.SwitchboardConversationMermaid?.attach(card,pre,text);
      requestAnimationFrame(()=>pre.classList.toggle('fits',pre.scrollWidth<=pre.clientWidth+1));
    }
  }
  // The / and $ menu shared by the Conversation draft and the New tab prompt. surface() names what
  // the draft talks to: {agent, host, cwd, owner}, or null while it should stay closed.
  const agentCommands={codex:[['rename','Rename this conversation'],['compact','Compact conversation context'],['model','Choose a model'],['permissions','Change permissions'],['status','Show session status'],['skills','Browse skills'],['diff','Show changes'],['review','Review changes'],['resume','Resume a conversation'],['fork','Fork this conversation'],['new','Start a new conversation']],claude:[['rename','Rename this conversation'],['compact','Compact conversation context'],['model','Choose a model'],['permissions','Change permissions'],['status','Show session status'],['help','Show commands'],['clear','Clear conversation context'],['resume','Resume a conversation']]};
  // As in T3 Code, a command is an ordinary message unless it needs another screen.
  // Claude draws these as dialogs only its terminal can answer. A name not listed here,
  // such as a skill the list has not loaded or a bundled one it cannot see, starts a turn.
  const claudeDialogs=new Set(['add-dir','agents','bashes','bug','config','context','cost','doctor','effort','exit','export','fast','feedback','help','hooks','ide','install-github-app','login','logout','mcp','memory','model','permissions','plugin','privacy-settings','quit','release-notes','resume','rewind','sandbox','stats','status','statusline','tasks','terminal-setup','theme','todos','upgrade','usage','vim']);
  // These change the session without a reply, so no message or Working state waits for them.
  const claudeQuiet=new Set(['clear','compact','rename']);
  function commandRoute(agent,text){
    const [,command,argument]=/^\s*\/([a-z][\w:.-]*)(?:\s+([\s\S]*))?$/i.exec(text)||[],name=command?.toLowerCase();if(!name)return null;
    if(agent!=='claude')return 'terminal';
    // Naming a model sets it directly; only a bare /model opens the picker.
    if(name==='model'&&argument)return 'quiet';
    return claudeDialogs.has(name)?'terminal':claudeQuiet.has(name)?'quiet':'turn';
  }
  function attachCompletions({draft,parent,id,surface,changed}){
    const completions=el('div',undefined,'conversation-completions');completions.id=id;completions.hidden=true;completions.setAttribute('role','listbox');completions.setAttribute('aria-label','Commands and skills');parent.prepend(completions);
    draft.setAttribute('aria-autocomplete','list');draft.setAttribute('aria-controls',id);draft.setAttribute('aria-expanded','false');
    const skillLists=new Map(),skillArticles=new Map();let completionItems=[],completionIndex=0,completionToken=null;
    const skillKey=current=>JSON.stringify([current.host,current.cwd,current.agent==='claude']);
    function completionContext(){
      const current=surface();if(!current||document.activeElement!==draft||draft.selectionStart!==draft.selectionEnd)return null;
      const before=draft.value.slice(0,draft.selectionStart),slash=/^\/[\w:.-]*$/.exec(before),skill=/(?:^|\s)(\$[\w:.-]*)$/.exec(before);
      return slash?{current,prefix:'/',query:before.slice(1),start:0,end:before.length}:skill&&['codex','claude'].includes(current.agent)?{current,prefix:'$',query:skill[1].slice(1),start:before.length-skill[1].length,end:before.length}:null;
    }
    function closeCompletions(){completions.hidden=true;completionItems=[];draft.setAttribute('aria-expanded','false');draft.removeAttribute('aria-activedescendant');}
    function selectCompletion(index){
      const item=completionItems[index],context=completionContext();if(!item||!context)return;
      // Claude Code spells every skill with a slash; $ is only how it was typed here.
      draft.setRangeText((context.current.agent==='claude'?'/':context.prefix)+item.name+' ',context.start,context.end,'end');closeCompletions();changed();draft.focus({preventScroll:true});
    }
    function paintCompletions(reset=true){
      syncSkillEditor();
      const context=completionContext();if(!context){closeCompletions();return;}
      const {current,prefix,query}=context,token=JSON.stringify([current.owner,prefix,query,context.start,context.end]);if(reset&&token!==completionToken)completionIndex=0;completionToken=token;
      const key=skillKey(current),skills=skillLists.get(key),usesSkills=prefix==='$'||current.agent==='claude';
      const builtIn=prefix==='/'?(agentCommands[current.agent]||[]).map(([name,description])=>({name,description})):[],names=new Set(builtIn.map(item=>item.name));
      const source=[...builtIn,...(usesSkills?skills?.items||[]:[]).filter(item=>!names.has(item.name))],typed=query.toLowerCase();
      // A plugin skill is also found by the part after "plugin:".
      completionItems=source.filter(item=>{const name=item.name.toLowerCase();return name.startsWith(typed)||name.slice(name.indexOf(':')+1).startsWith(typed);}).slice(0,30);
      completions.replaceChildren();completionIndex=Math.min(completionIndex,Math.max(0,completionItems.length-1));
      completionItems.forEach((item,index)=>{const option=el('button',undefined,'conversation-completion');option.type='button';option.id=id+'-'+index;option.setAttribute('role','option');option.setAttribute('aria-selected',String(index===completionIndex));
        const label=el('strong',prefix+item.name);if(item.name.includes(':')){label.className='conversation-completion-skill';label.dataset.label=item.displayName?.trim()||item.name.split(':').pop();label.title=prefix+item.name;option.setAttribute('aria-label',prefix+item.name+' '+item.description);}
        option.append(label,el('span',item.description));option.onpointerdown=event=>event.preventDefault();option.onclick=()=>selectCompletion(index);completions.append(option);});
      if(prefix==='$'&&!completionItems.length)completions.append(el('small',skills?.error||(!skills||skills.pending?'Loading skills…':'No matching skills')));
      completions.hidden=!completionItems.length&&prefix!=='$';draft.setAttribute('aria-expanded',String(!completions.hidden));
      if(completionItems.length){draft.setAttribute('aria-activedescendant',id+'-'+completionIndex);completions.children[completionIndex].scrollIntoView({block:'nearest'});}else draft.removeAttribute('aria-activedescendant');
      if(usesSkills)ensureSkills(current);
    }
    function ensureSkills(current){const key=skillKey(current),skills=skillLists.get(key);if((!skills||Date.now()-skills.at>60000)&&!skills?.pending)void loadSkills(key,current);}
    async function loadSkills(key,{host,cwd,agent}){
      const entry={pending:true,at:Date.now(),items:skillLists.get(key)?.items};skillLists.set(key,entry);
      try{const response=await fetch('/api/hosts/'+encodeURIComponent(host)+'/conversation/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(agent==='claude'?{cwd,agent}:{cwd}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error();const result=await response.json();if(!Array.isArray(result.skills))throw Error();entry.items=result.skills.filter(item=>typeof item.name==='string'&&typeof item.description==='string');}
      catch{entry.error='Skills unavailable. You can still type a skill name.';}
      finally{entry.pending=false;const current=surface();if(current&&key===skillKey(current))paintCompletions();for(const article of skillArticles.get(key)||[])if(article.isConnected)decorateSkills(article,entry.items||[],agent);skillArticles.delete(key);}
    }
    function decorate(article){
      const current=surface();if(!current||!['codex','claude'].includes(current.agent))return;
      const pattern=current.agent==='claude'?/(?:^|\s)[$/][a-zA-Z0-9][\w:.-]*(?=\s|$)/:/(?:^|\s)\$[a-zA-Z0-9][\w:.-]*(?=\s|$)/;
      if(!skillTextNodes(article).some(node=>pattern.test(node.textContent)))return;
      const key=skillKey(current),items=skillLists.get(key)?.items;
      if(items)decorateSkills(article,items,current.agent);
      else{if(!skillArticles.has(key))skillArticles.set(key,new Set());skillArticles.get(key).add(article);ensureSkills(current);}
    }
    function syncSkillEditor(){
      if(!draft.setSkillCatalog)return;
      const current=surface(),supported=current&&['codex','claude'].includes(current.agent);
      draft.setSkillCatalog(supported?skillLists.get(skillKey(current))?.items||[]:[],supported?current.agent:'',skillChip);
      if(supported&&/(?:^|\s)[$/][\w:.-]+(?=\s|$)/.test(draft.value))ensureSkills(current);
    }
    // Enter, Tab and the arrows belong to an open menu. True means the key was used.
    function completionKey(event){
      if(event.isComposing||completions.hidden||event.ctrlKey||event.altKey||event.metaKey)return false;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeCompletions();return true;}
      if(!completionItems.length||event.shiftKey||!['ArrowDown','ArrowUp','Tab','Enter'].includes(event.key))return false;
      event.preventDefault();event.stopPropagation();
      if(event.key==='Tab'||event.key==='Enter')selectCompletion(completionIndex);else{completionIndex=(completionIndex+(event.key==='ArrowDown'?1:-1)+completionItems.length)%completionItems.length;paintCompletions(false);}
      return true;
    }
    // A $skill typed out in full and sent to Claude becomes the slash form Claude runs.
    function expandSkills(text){
      const current=surface(),items=current?.agent==='claude'?skillLists.get(skillKey(current))?.items:null;if(!items?.length)return text;
      return text.replace(/(^|\s)\$([\w:.-]+)(?=\s|$)/g,(match,space,name)=>{const short=items.filter(item=>item.name.split(':').pop()===name),item=items.find(item=>item.name===name)||(short.length===1?short[0]:null);return item?space+'/'+item.name:match;});
    }
    // Claude's list is needed even without the menu: a pasted $skill is still rewritten on send.
    function refreshSkills(){const current=surface();if(current?.agent==='claude'&&document.activeElement===draft)ensureSkills(current);}
    draft.addEventListener('focus',()=>{refreshSkills();paintCompletions();});draft.addEventListener('click',()=>paintCompletions());draft.addEventListener('blur',closeCompletions);
    return {paint:paintCompletions,close:closeCompletions,key:completionKey,expand:expandSkills,refresh:refreshSkills,decorate};
  }
  window.SwitchboardConversation={agentIcons,attachCompletions,commandRoute,install({selection,terminal,openConversation=()=>false,modeChanged=()=>{},viewed=()=>{},sending=()=>{},notSent=()=>{},switchModel=null,cancelSwitch=()=>{},idle=()=>{},newTabHere=()=>{}}){
    const root=document.getElementById('terminals'),drafts=new Map(),attachments=new Map(),retryKeys=new Map();
    const mobile=matchMedia('(max-width:700px), (pointer:coarse) and (max-width:1000px)').matches;
    const modeKey=mobile?'switchboard-mobile-view-mode':'switchboard-view-mode';
    let savedMode;try{savedMode=localStorage.getItem(modeKey);}catch{}
    let target=null,open=savedMode? savedMode==='conversation':mobile,generation=0,startCursor=0,tailCursor=0,nextCursor=null,messages=[],loading=false,loaded=false,lastPaint=null,modeRevision=0,navigationRevision=0;
    const outgoing=new Map(),consumedTranscript=new Map(),pendingSends=new Map(),bridgeSends=new Map(),startups=new Map(),draftVersions=new Map(),firstSends=new Set();
    const conversations=new Map(),handoverDrafts=new Map(),handoverAttachments=new Map(),launchKeys=new WeakMap();
    const asyncQuestions=new Map(),trustPreparations=new Map();
    let stream=null,streamReady=false,streamSupported=false,streamPages=[],restorePosition=null;
    async function prepare(){
      if(!open||document.hidden||!target||!['codex','claude'].includes(target.agent)||!target.session||!Number.isInteger(target.tab))return;
      const folderTrust=target.agent==='claude';
      if(folderTrust&&(target.chatId||target.state!=='approval')){trustPreparations.delete(identity(target));return;}
      if(target.chatId&&['ready','working'].includes(target.state))return;
      const destination=target,key=identity(destination);
      if(folderTrust&&!trustPreparations.has(key))trustPreparations.set(key,{started:Date.now()});
      const startup=folderTrust?trustPreparations.get(key):startupState();
      if(!startup||startup.pending||startup.error||Date.now()-startup.started>=30000||Date.now()-(startup.at||0)<5000)return;
      startup.at=Date.now();startup.pending=true;
      try{const response=await fetch('/api/hosts/'+encodeURIComponent(destination.host)+'/conversation/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:destination.session,tab_id:destination.tab,pane_id:destination.pane}),signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error(response.status===404?'Update Switchboard on this computer to prepare the agent.':'Could not prepare this agent. Retry or open Terminal.');}
      catch(error){if(folderTrust)startup.started=Date.now();else startup.error=error.name==='TimeoutError'?'Agent preparation timed out. Retry or open Terminal.':error.message||'Could not reach this agent. Retry or open Terminal.';}
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
      // The browser's own reconnect reuses this URL's old cursor and would roll the transcript back.
      source.onerror=()=>{if(source===stream){stopStream();load();}};
    }
    const modes=el('div',undefined,'conversation-modes');modes.hidden=true;modes.setAttribute('role','group');modes.setAttribute('aria-label','View mode');
    const back=el('button','Terminal'),toggle=el('button','Conversation','conversation-toggle');back.type=toggle.type='button';back.setAttribute('aria-pressed',String(!open));toggle.setAttribute('aria-pressed',String(open));modes.append(back,toggle);root.append(modes);
    const panel=el('section',undefined,'conversation-panel');
    // Links follow Settings → Links, as terminal links do. That browser opens on the relay's
    // computer, so a touch device keeps the link on its own screen.
    const routeLink=event=>{const link=event.button<2&&!matchMedia('(pointer:coarse)').matches&&event.target.closest('a[href]');if(link&&target&&window.SwitchboardOpenInApp?.(target.host,link.href))event.preventDefault();};
    panel.addEventListener('click',routeLink);panel.addEventListener('auxclick',routeLink);
    // CSS keeps a hidden panel laid out (see conversation.css), so hide it from assistive technology here.
    const setPanelHidden=value=>{panel.hidden=value;panel.setAttribute('aria-hidden',String(value));};setPanelHidden(true);panel.tabIndex=-1;panel.setAttribute('aria-label','Agent conversation');
    const header=el('header'),heading=el('div',undefined,'conversation-heading'),title=el('strong'),model=el(switchModel?'button':'span',undefined,'conversation-model'),activity=el('span',undefined,'conversation-activity'),terminalAction=el('button','Open Terminal','conversation-terminal-action');model.title=switchModel?'Switch between Claude and Codex with context':'Last reported model';if(switchModel){model.type='button';model.setAttribute('aria-label','Switch model with context');model.onclick=()=>switchModel(target);}const cancelModel=el('button','×','conversation-model-cancel');cancelModel.type='button';cancelModel.hidden=true;cancelModel.setAttribute('aria-label','Cancel model switch');cancelModel.title='Cancel model switch';cancelModel.onclick=()=>cancelSwitch(target);activity.setAttribute('role','status');terminalAction.type='button';terminalAction.hidden=true;terminalAction.onclick=()=>show(false);const context=el('button',undefined,'conversation-context');context.type='button';context.onclick=()=>{if(target)newTabHere({host:target.host,project:projectPath()});};const cost=el('button',undefined,'conversation-cost'),subtitle=el('div',undefined,'conversation-subtitle');subtitle.append(context,activity);heading.append(title,subtitle);header.append(heading,terminalAction);
    const costDetails=el('div',undefined,'conversation-cost-details');costDetails.popover='auto';costDetails.setAttribute('role','dialog');costDetails.setAttribute('aria-label','API cost breakdown');
    cost.type='button';cost.popoverTargetElement=costDetails;cost.setAttribute('aria-haspopup','dialog');
    const noticeText=el('span','Loading this terminal’s conversation…'),loadingTime=el('span',undefined,'conversation-loading-time');loadingTime.setAttribute('aria-hidden','true');
    const notice=el('p',undefined,'conversation-notice');notice.setAttribute('role','status');notice.append(noticeText,loadingTime);
    const list=el('div',undefined,'conversation-messages'),older=el('button','Load older messages'),refresh=el('button','↻'),latest=el('button','↓');refresh.setAttribute('aria-label','Refresh');refresh.title='Refresh conversation';latest.setAttribute('aria-label','Scroll to bottom');latest.title='Scroll to bottom';older.hidden=true;
    // One live row: a shimmering brain icon, the step in progress (or "Thinking…"), and the elapsed time.
    // With earlier steps in this turn it is also their disclosure, showing them in place.
    const working=el('button',undefined,'conversation-working'),workingStep=el('span',undefined,'conversation-working-step'),workingTime=el('span',undefined,'conversation-working-time'),workingCount=el('span',undefined,'conversation-working-count');
    working.type='button';working.disabled=true;const workingLabel=el('span',undefined,'conversation-working-label');workingLabel.append(el('span',undefined,'conversation-working-icon'),workingStep);working.append(workingLabel,workingTime,workingCount);working.hidden=true;workingStep.dataset.step='Thinking…';let liveStep=null,liveRun=null;working.setAttribute('aria-hidden','true');
    working.onclick=()=>{if(!liveRun||!liveStep)return;const id=identity(target)+':'+liveRun.start;expandedRuns.has(id)?expandedRuns.delete(id):expandedRuns.add(id);lastPaint=null;paint();};
    // Background agents that outlive the reply, one row each: the Claude mark ringed while it runs, its task, model and age.
    const claudeMark='<svg viewBox="0 0 256 257" aria-hidden="true"><path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"/></svg>';
    const background=el('div',undefined,'conversation-background');background.hidden=true;
    const shellMark='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 4 4 4-4 4M8.5 12.5H13" fill="none" stroke="#b4b4bd" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    // What one background task is doing, reread while open and left in place when it ends.
    const taskDialog=el('dialog',undefined,'conversation-task'),taskHeader=el('header'),taskHeading=el('div',undefined,'conversation-task-heading'),taskTitle=el('h3'),taskStatus=el('small',undefined,'conversation-task-status'),taskClose=el('button','Close'),taskBody=el('div',undefined,'conversation-task-body');
    taskStatus.setAttribute('role','status');taskClose.type='button';taskClose.onclick=()=>taskDialog.close();taskDialog.setAttribute('aria-labelledby','conversation-task-title');taskTitle.id='conversation-task-title';
    const taskCrumbs=el('span',undefined,'conversation-task-crumbs'),taskProject=el('span',undefined,'conversation-task-project'),taskParent=el('button',undefined,'conversation-task-parent');taskParent.type='button';taskParent.onclick=()=>taskDialog.close();taskCrumbs.append(taskProject,taskParent);
    taskHeading.append(taskCrumbs,taskTitle,taskStatus);taskHeader.append(taskHeading,taskClose);taskDialog.append(taskHeader,taskBody);
    taskDialog.onclick=event=>{if(event.target===taskDialog)taskDialog.close();};
    let taskView=null;
    // Escape interrupts the agent in Conversation, so a subagent view keeps it to itself.
    taskDialog.tabIndex=-1;taskDialog.addEventListener('keydown',event=>{if(event.key==='Escape'&&taskDialog.classList.contains('subagent')){event.preventDefault();event.stopPropagation();taskDialog.close();}});
    taskDialog.onclose=()=>{clearTimeout(taskView?.timer);const opener=taskView?.opener;taskView=null;if(opener?.isConnected)opener.focus({preventScroll:true});};
    const recovery=el('div',undefined,'conversation-recovery'),retryConnection=el('button','Retry connection');recovery.hidden=true;retryConnection.type='button';retryConnection.onclick=()=>{if(target)startups.delete(identity(target));status(unboundNotice());updateActivity();prepare();};recovery.append(retryConnection);
    const historyStatus=el('span',undefined,'conversation-history-status');historyStatus.hidden=true;historyStatus.setAttribute('role','status');
    const actions=el('div',undefined,'conversation-actions');actions.append(refresh,latest);list.append(older,working,background);latest.hidden=refresh.hidden=true;
    const form=el('form',undefined,'conversation-compose'),draft=el('textarea'),insert=el('button');draft.rows=1;draft.maxLength=16000;draft.placeholder='Message…';draft.setAttribute('aria-label','Reply draft');insert.type='submit';insert.setAttribute('aria-label','Send');insert.title='Send message';const attach=el('button',undefined,'conversation-attach'),picker=el('input'),files=el('div',undefined,'conversation-attachments');attach.type='button';attach.setAttribute('aria-label','Attach files');attach.title='Attach photos or files';picker.type='file';picker.multiple=true;picker.hidden=true;files.hidden=true;
    const stop=el('button',undefined,'conversation-stop');stop.type='button';stop.setAttribute('aria-label','Stop');stop.title='Interrupt the agent (sends Esc)';
    // The open terminal socket skips the relay's CLI round trips. Without a live viewer on
    // that pane the relay sends Esc. The bridge refuses a request past its expiry, well before
    // this page gives up waiting, so a slow answer cannot lead to a second Esc.
    const typedEscapes=new Map();let typedEscapeId=0;
    function typeEscape(destination){
      const frame=destination.frame?.contentWindow;if(!frame||destination.terminalReady===false)return Promise.resolve(false);
      return new Promise(resolve=>{
        const id=++typedEscapeId;typedEscapes.set(id,{frame,resolve});
        frame.postMessage({type:'zellij-interrupt',id,session:destination.session,pane_id:destination.pane,expires:Date.now()+200},location.origin);
        setTimeout(()=>{if(typedEscapes.delete(id))resolve(false);},1000);
      });
    }
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||event.data?.type!=='zellij-interrupt-result')return;
      const typed=typedEscapes.get(event.data.id);if(!typed||event.source!==typed.frame)return;
      typedEscapes.delete(event.data.id);typed.resolve(event.data.ok===true);
    });
    stop.onclick=async()=>{
      const destination=target;if(!destination?.session||!Number.isInteger(destination.pane))return;stop.disabled=true;
      // Esc does nothing once a turn has ended, so a waiting tab stops the tasks it waits on.
      const background=destination.state==='waiting',route=background?'/conversation/stop-background':'/escape',body=background?{session:destination.session,tab_id:destination.tab,pane_id:destination.pane}:{session:destination.session,pane_id:destination.pane};
      try{if(!background&&await typeEscape(destination))return;const response=await fetch('/api/hosts/'+encodeURIComponent(destination.host)+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(background?60000:10000)});if(!response.ok)throw Error();}
      catch{if(identity(target)===identity(destination))sendStatus(background?'Could not stop the background tasks. Open Terminal to stop them.':'Could not interrupt the agent. Open Terminal and press Esc.');}
      finally{stop.disabled=false;}
    };
    form.append(files,attach,draft,cost,cancelModel,model,insert,stop,picker);
    const sendNotice=el('small',undefined,'conversation-send-notice');sendNotice.hidden=true;sendNotice.setAttribute('role','status');form.append(sendNotice);
    const transportNotice=el('small','Replies use Terminal briefly, then return here.','conversation-transport-notice');transportNotice.hidden=true;form.append(transportNotice);
    const completions=attachCompletions({draft,parent:form,id:'conversation-completions',changed:()=>draft.oninput(),surface:()=>open&&target?{agent:target.agent,host:target.host,cwd:chat?.project||'',owner:identity(target)}:null});
    let sendNoticeReceipt=null;
    function sendStatus(text,receipt=null){const follow=nearBottom();sendNoticeReceipt=receipt;if(sendNotice.textContent!==text)sendNotice.textContent=text;sendNotice.hidden=!text;if(form.isConnected){sizeDraft();if(follow){list.scrollTop=list.scrollHeight;updateLatest();}}}
    // Claude's numbered menus (permission prompts, questions), read from the pane by
    // the relay and answered with the keys Claude Code takes. Older relays answer 404.
    const question=el('section',undefined,'conversation-question'),questionStatus=el('small',undefined,'conversation-question-status');question.hidden=true;question.setAttribute('aria-label','Agent question');questionStatus.setAttribute('role','status');
    const promptHosts=new Set();let prompt=null,promptKey=null,promptSignature='',promptRequest=null,promptAt=0,answering=false,answered=null,promptError='',otherDraft='';
    const asyncShortcut=el('button',undefined,'conversation-pending-question');asyncShortcut.type='button';asyncShortcut.hidden=true;
    panel.append(costDetails,header,notice,recovery,list,historyStatus,actions,question,asyncShortcut,form,taskDialog);root.append(panel);
    const identity=t=>t?JSON.stringify([t.key,t.chatId]):null;
    let chat=null;
    const projectPath=()=>String(chat?.project||target?.project||'').replace(/[\\/]+$/,'');
    const binding=()=>chat;
    const pendingFor=(key=identity(target))=>pendingSends.get(key);let queuedSubmit=null;
    let loadingStarted=0,loadingTimer=null;
    function tickLoading(){clearTimeout(loadingTimer);const seconds=Math.floor((performance.now()-loadingStarted)/1000);loadingTime.textContent=seconds?duration(seconds):'';loadingTimer=setTimeout(tickLoading,1000);}
    // Times the wait for a running agent to report its chat, which ends before any transcript loads.
    let connecting=null;
    function endConnecting(outcome){connecting?.timing?.end(outcome);connecting=null;}
    function trackConnecting(text,quiet){
      if(text==='Connecting to this agent’s conversation…'&&open&&!quiet){
        if(connecting&&connecting.key!==target?.key)endConnecting('left');
        connecting??={key:target?.key,timing:window.SwitchboardTiming?.begin('conversation_connect',{host:target?.host,deadline:120000})};
      }else if(connecting)endConnecting(connectOutcome(text));
    }
    function connectOutcome(text){
      if(target?.key!==connecting.key)return 'left';
      if(chat)return 'ready';
      if(/timed out|has not connected/.test(text))return 'timeout';
      return text===startupState()?.error?'failed':'left';
    }
    function status(text,quiet=false){
      if(launchShown()&&transitional.has(text))quiet=true;if(noticeText.textContent!==text)noticeText.textContent=text;notice.hidden=quiet;trackConnecting(text,quiet);
      if(text==='Loading conversation…'&&!quiet){if(loadingTimer===null){loadingStarted=performance.now();tickLoading();}}
      else{clearTimeout(loadingTimer);loadingTimer=null;loadingTime.textContent='';}
    }
    // A tab started from New tab shows its prompt as sent, with a starting row under it, until the
    // transcript has it, instead of a run of connection notices and an empty page.
    const transitional=new Set(['Starting agent…','Connecting to this agent’s conversation…','Loading conversation…','Loading this terminal’s conversation…','No agent']);
    const launchNode=el('article',undefined,'conversation-message user conversation-outgoing conversation-launch sent');launchNode.dataset.conversationEntry='launch';
    function launchShown(){return !!target?.launch&&!messages.some(item=>item.role==='user'&&!setupMessage(item));}
    function paintLaunch(){
      if(!launchShown()){launchNode.remove();return;}
      const {text,attachments}=target.launch,signature=JSON.stringify([target.host,text,attachments]);
      if(launchNode.dataset.signature!==signature){
        launchNode.dataset.signature=signature;launchNode.replaceChildren(el('div','You','conversation-label'));textBlocks(launchNode,text);completions.decorate(launchNode);
        if(attachments?.length&&window.SwitchboardConversationMedia)window.SwitchboardConversationMedia.render(launchNode,{attachments},{host:target.host});
      }
      if(older.nextSibling!==launchNode)older.after(launchNode);
    }

    function modelName(value){
      const raw=String(value?.model||'');
      return /^gpt-\d+(?:\.\d+)?-(?:sol|astra|luna|terra)(?:-codex)?$/i.test(raw)?raw.replace(/^gpt-/i,'').replace(/-/g,' ').replace(/\b[a-z]/g,char=>char.toUpperCase()):/^claude-(opus|sonnet|haiku|fable)-\d+(?:-\d+)?(?:-\d{8})?$/i.test(raw)?raw.replace(/^claude-/i,'').replace(/-\d{8}$/,'').replace(/^(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/i,'$1 $2.$3').replace(/-/g,' ').replace(/^\w/,char=>char.toUpperCase()):raw;
    }
    function effortName(value){const raw=String(value||'').trim();return /^xhigh$/i.test(raw)?'Extra High':raw.replace(/^\w/,char=>char.toUpperCase());}
    function agentName(){return target?.agent||chat?.agent||target?.requestedModel?.agent||'';}
    function providerLabel(){const agent=agentName();return agent?agent[0].toUpperCase()+agent.slice(1):'Assistant';}
    // A transcript names its model with the first reply; until then show what the tab was started with.
    function modelSource(){const requested=target?.requestedModel,agent=target?.agent||chat?.agent;return !chat?.model&&requested&&(!agent||requested.agent===agent)?requested:chat;}
    // The model, then its effort as a dimmer word, the way T3 Code labels its model button.
    // A switch waiting for the turn to end shows where it goes instead of the effort.
    function paintModel(){
      const source=modelSource(),name=modelName(source),pending=target?.pendingSwitch,base=name||(chat||agentName()?providerLabel():''),label=base+(pending?` → ${pending.label} · ${pending.running?'switching…':'after this turn'}`:''),effort=name&&!pending?effortName(source.reasoning_effort):'',agent=base?agentName():'',signature=JSON.stringify([agent,label,effort,!!pending]);
      model.classList.toggle('pending',!!pending);model.title=pending?label+(pending.text?'\nInstructions: '+pending.text:''):switchModel?'Switch between Claude and Codex with context':'Last reported model';
      if(model.dataset.painted===signature)return;model.dataset.painted=signature;
      const icon=agentIcons[agent]?el('span',undefined,'conversation-model-icon'):null;if(icon){icon.innerHTML=agentIcons[agent];icon.setAttribute('aria-hidden','true');}
      model.replaceChildren(...(icon?[icon]:[]),...(pending?[el('span',label,'conversation-model-label')]:[effort?`${label} `:label,...(effort?[el('span',effort,'conversation-effort')]:[])]));
    }
    // The in-transcript indicator counts up from when the agent started this turn.
    let workingTimer=null;
    function backgroundAgents(){return target?.state==='waiting'&&Array.isArray(chat?.background)?chat.background:[];}
    const taskKinds={shell:'Shell',monitor:'Monitor'};
    function taskLabel(agent){return agent.description||(agent.kind==='shell'?'Background shell':agent.kind==='monitor'?'Background monitor':'Background agent');}
    function openTask(agent){
      if(!chat)return;
      clearTimeout(taskView?.timer);
      const view={agent,owner:identity(target),chat:chat.id,host:target.chatHost||target.host,prompt:agent.kind&&agent.kind!=='agent'?'':null,painted:''};taskView=view;
      const subagent=isSubagent(agent),parent=title.textContent||'Conversation';taskDialog.classList.toggle('subagent',subagent);
      taskTitle.textContent=taskLabel(agent);taskStatus.textContent='Loading…';
      if(subagent){
        taskProject.textContent=String(chat.project||'').split(/[\\/]/).filter(Boolean).pop()||'';taskProject.hidden=!taskProject.textContent;taskParent.textContent=parent;taskParent.title='Back to '+parent;
        view.parent=parent;view.divider=subagentDivider(parent);view.opener=document.activeElement;taskBody.replaceChildren(view.divider,taskStatus);
      }else{taskHeading.append(taskStatus);taskBody.replaceChildren();}
      if(!taskDialog.open){if(subagent){taskDialog.show();taskDialog.focus({preventScroll:true});}else taskDialog.showModal();}
      readTask(view);
    }
    function taskUrl(view,params){return '/api/chats/'+encodeURIComponent(view.chat)+'?'+new URLSearchParams({host:view.host,task:view.agent.id,context:'true',...params});}
    async function readTask(view){
      // The dialog shows one tab's task, so leaving the tab or the Conversation ends it.
      if(view!==taskView)return;
      if(identity(target)!==view.owner||panel.hidden){taskDialog.close();return;}
      let data=null;
      try{const response=await fetch(taskUrl(view,{tail:'true',limit:50}),{signal:AbortSignal.timeout(15000)});if(response.ok)data=await response.json();}catch{}
      if(view!==taskView)return;
      if(data?.task&&view.prompt===null){
        // A long run's first message, the task it was given, falls off the tail.
        if(data.start_cursor===0)view.prompt=data.messages?.[0]?.text||'';
        else try{const first=await (await fetch(taskUrl(view,{cursor:0,limit:1}),{signal:AbortSignal.timeout(15000)})).json();view.prompt=first.messages?.[0]?.text||'';}catch{}
        if(view!==taskView)return;
      }
      const running=paintTask(view,data);
      if(running)view.timer=setTimeout(()=>readTask(view),2000);
    }
    function taskPre(text,cls){const pre=el('pre',text,'conversation-task-output'+(cls?' '+cls:''));return pre;}
    // Returns whether the task should be read again.
    function paintTask(view,data){
      const age=()=>{const started=Date.parse(view.agent.started)/1000;return started>0?' · '+duration(Math.max(0,Date.now()/1000-started)):'';};
      if(!data||data.error){taskStatus.textContent='Could not read this task. Retrying…';return true;}
      // A computer on an older build ignores `task` and answers with the chat itself.
      if(!data.task){taskStatus.textContent='This computer needs an update to show this task.';return false;}
      const kind=data.task.kind||view.agent.kind||'agent',model=modelName({model:view.agent.model}),label=taskKinds[kind]||model||'Agent',running=data.task.running;
      taskStatus.textContent=isSubagent(view.agent)?subagentStatus(view,running):running?`${label} · Running${age()}`:`${label} · Finished`;
      if(!running&&!data.messages&&!('output' in data))return false;
      const signature=JSON.stringify([data.messages?.length,data.message_count,data.messages?.at(-1)?.text,data.output,data.task.events,view.prompt]);
      if(signature===view.painted)return running;
      const firstPaint=!view.painted;view.painted=signature;
      const follow=firstPaint||!taskBody.children.length||taskBody.scrollHeight-taskBody.scrollTop-taskBody.clientHeight<48,nodes=[];
      if(isSubagent(view.agent)){
        // A shell delegate has its command as its prompt and printed output as its reply.
        if(!view.prompt&&data.task.command)view.prompt=data.task.command;
        nodes.push(...subagentNodes(view,data));
        if(!data.messages)nodes.push(data.output?taskPre(data.output):el('div','No output yet.','conversation-task-step'));
      }else if(data.messages){
        const opening=view.prompt?el('details',undefined,'conversation-task-prompt'):null;
        if(opening){opening.append(el('summary','Task given to this agent'));textBlocks(opening,view.prompt);opening.open=!!taskBody.querySelector('.conversation-task-prompt[open]');nodes.push(opening);}
        for(const item of data.messages){
          if(item.role==='user'&&item.text===view.prompt)continue;
          if(item.role==='assistant'&&item.phase==='commentary'){nodes.push(el('div',item.text,'conversation-task-step'));continue;}
          const message=el('div',undefined,'conversation-task-message '+item.role);textBlocks(message,item.text||'');nodes.push(message);
        }
        if(!data.messages.length)nodes.push(el('div','Nothing recorded yet.','conversation-task-step'));
      }else{
        if(data.task.command)nodes.push(taskPre(data.task.command,'command'));
        const printed=kind==='monitor'?(data.task.events||[]).join('\n'):data.output;
        nodes.push(printed?taskPre(printed):el('div',kind==='monitor'?'No events yet.':'No output yet.','conversation-task-step'));
      }
      taskBody.replaceChildren(...nodes);if(follow)taskBody.scrollTop=taskBody.scrollHeight;
      return running;
    }
    // An agent's work reads like its own chat, after T3 Code's subagent thread.
    const isSubagent=agent=>agent.delegate||agent.agent||!agent.kind||agent.kind==='agent';
    const subagentIcons={bot:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M9 13v2M15 13v2"/></svg>',chat:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>',chevron:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'};
    function svgIcon(name,cls){const icon=el('span',undefined,'conversation-subagent-icon'+(cls?' '+cls:''));icon.innerHTML=subagentIcons[name];return icon;}
    function subagentDivider(parent){
      const line=el('div',undefined,'conversation-subagent-of'),chip=el('button',undefined,'conversation-subagent-chip');chip.type='button';chip.title='Back to '+parent;chip.onclick=()=>taskDialog.close();
      chip.append(svgIcon('bot'),el('span','Subagent of','conversation-subagent-chip-label'),el('span','· '+parent,'conversation-subagent-chip-parent'));line.append(chip);return line;
    }
    function subagentPrompt(view){
      const pill=el('details',undefined,'conversation-task-prompt conversation-subagent-prompt'),summary=el('summary'),first=String(view.prompt).split('\n').map(line=>line.trim()).find(Boolean)||'',full=el('div',undefined,'conversation-subagent-full');
      summary.append(svgIcon('chat'),el('span',view.parent,'conversation-subagent-from'),el('span',first,'conversation-subagent-first'),svgIcon('chevron','conversation-subagent-chevron'));pill.append(summary,full);
      pill.ontoggle=()=>{if(pill.open&&!full.children.length)textBlocks(full,view.prompt);};return pill;
    }
    function subagentStatus(view,running){
      const delegate=(chat?.delegates||[]).find(item=>item.id===view.agent.id),started=Date.parse(view.agent.started||delegate?.started)/1000,ended=running?Date.now()/1000:Date.parse(delegate?.ended)/1000,time=started>0&&ended>0?duration(Math.max(0,ended-started)):'';
      const source=delegate||view.agent,state=running?(time?'Working for '+time:'Working'):(time?'Worked for '+time:'Finished');
      return [modelName(source),effortName(source.effort),state].filter(Boolean).join(' · ');
    }
    const stepNouns={run:['command','commands'],read:['file','files'],edit:['file','files'],write:['file','files'],search:['time','times'],fetch:['page','pages'],agent:['task','tasks'],tool:['tool','tools']};
    function stepsLabel(steps){
      const counts=new Map();for(const step of steps){const tool=Object.hasOwn(toolVerbs,step.tool)?step.tool:'tool';counts.set(tool,(counts.get(tool)||0)+1);}
      const parts=[...counts].map(([tool,count])=>stepNouns[tool]?`${toolVerbs[tool][0]} ${count} ${stepNouns[tool][count===1?0:1]}`:toolVerbs[tool][0]);
      return parts.map((part,index)=>index?part[0].toLowerCase()+part.slice(1):part).join(', ');
    }
    function subagentSteps(view,steps,key){
      if(steps.length===1)return el('div',steps[0].text,'conversation-task-step');
      const group=el('details',undefined,'conversation-subagent-steps'),summary=el('summary'),mark=el('span','>_','conversation-subagent-mark');summary.append(mark,el('span',stepsLabel(steps)));group.append(summary,...steps.map(step=>el('div',step.text,'conversation-task-step')));
      group.open=view.openSteps?.has(key)||false;group.ontoggle=()=>{view.openSteps??=new Set();group.open?view.openSteps.add(key):view.openSteps.delete(key);};return group;
    }
    function subagentNodes(view,data){
      if(view.prompt&&!view.pill)view.pill=subagentPrompt(view);
      const nodes=[view.divider];if(view.pill)nodes.push(view.pill);nodes.push(taskStatus);
      let steps=[],key=0;const flush=()=>{if(steps.length)nodes.push(subagentSteps(view,steps,key));steps=[];};
      (data.messages||[]).forEach((item,index)=>{
        if(item.role==='user'&&item.text===view.prompt)return;
        if(item.kind==='tool'){if(!steps.length)key=(data.start_cursor||0)+index;steps.push(item);return;}
        flush();const message=el('div',undefined,'conversation-task-message '+item.role);
        if(window.SwitchboardConversationMedia&&(item.markdown||item.attachments))window.SwitchboardConversationMedia.render(message,item,{host:view.host,project:chat?.project});else textBlocks(message,item.text||'');
        decorateCode(message);nodes.push(message);
      });
      flush();if(data.messages&&nodes.at(-1)===taskStatus)nodes.push(el('div','Nothing recorded yet.','conversation-task-step'));return nodes;
    }
    // A delegated agent stays on the page as a card; a tool step folds away with its turn.
    const isDelegate=item=>item.kind==='tool'&&item.tool==='agent'&&!!item.call;
    const delegateEndings={completed:'Finished',failed:'Failed',stopped:'Stopped'};
    function delegateCard(article,item){
      const row=el('button',undefined,'conversation-agent conversation-delegate'),avatar=el('span',undefined,'conversation-agent-avatar'),text=el('span',undefined,'conversation-delegate-text');
      row.type='button';row.dataset.call=item.call;row.dataset.title=item.detail||'a task';avatar.innerHTML=agentIcons[(chat?.delegates||[]).find(delegate=>delegate.call===item.call)?.provider]||claudeMark;
      text.append(el('span',row.dataset.title,'conversation-agent-title'),el('span',undefined,'conversation-delegate-meta'));
      row.append(avatar,text,el('span',undefined,'conversation-agent-time'),el('span','›','conversation-delegate-open'));
      article.dataset.tool='agent';article.dataset.live='Delegating '+row.dataset.title+'…';article.classList.add('delegate');article.append(row);paintDelegate(row);
    }
    function paintDelegate(row){
      const delegate=(chat?.delegates||[]).find(item=>item.call===row.dataset.call),title=row.dataset.title;
      // Only a live chat shows Running. A foreground call can die unrecorded, so it also needs a busy parent.
      const running=delegate?.status==='running'&&!!target?.state&&(!!delegate.id||target.state!=='ready'),status=!delegate?'Delegated':running?'Running':delegateEndings[delegate.status]||'Ended';
      const model=delegate?.model?(modelName({model:delegate.model})||delegate.model):'',meta=[model,effortName(delegate?.effort||''),status].filter(Boolean).join(' · ');
      const started=Date.parse(delegate?.started)/1000,ended=running?Date.now()/1000:Date.parse(delegate?.ended)/1000,time=started>0&&ended>0?duration(Math.max(0,ended-started)):'';
      row.classList.toggle('running',running);row.dataset.status=status.toLowerCase();row.disabled=!delegate?.id;
      row.onclick=delegate?.id?()=>openTask({id:delegate.id,kind:delegate.provider==='codex'?'shell':'agent',delegate:true,description:title,model:delegate.model,effort:delegate.effort,started:delegate.started}):null;
      const metaNode=row.querySelector('.conversation-delegate-meta'),timeNode=row.querySelector('.conversation-agent-time');
      if(metaNode.textContent!==meta)metaNode.textContent=meta;if(timeNode.textContent!==time)timeNode.textContent=time;
      row.title=delegate?.id?'See what this agent did':'';row.setAttribute('aria-label',`Delegated agent: ${title}. ${meta}${time?', '+time:''}`);
    }
    function paintDelegates(){for(const row of list.querySelectorAll('.conversation-delegate'))paintDelegate(row);}
    function paintBackground(){
      const agents=chat?backgroundAgents():[],signature=JSON.stringify(agents.map(agent=>[agent.id,agent.kind,agent.description,agent.model,agent.started]));
      background.hidden=!agents.length;
      if(background.dataset.signature!==signature){
        background.dataset.signature=signature;
        background.replaceChildren(...agents.map(agent=>{
          // A computer on an older build sends no id, so its rows can only be read.
          const row=el(agent.id?'button':'div',undefined,'conversation-agent'),avatar=el('span',undefined,'conversation-agent-avatar'),delegate=agentIcons[agent.agent],plain=!delegate&&taskKinds[agent.kind],model=plain||modelName({model:agent.model}),time=el('span',undefined,'conversation-agent-time'),title=taskLabel(agent);
          avatar.innerHTML=delegate||(plain?shellMark:claudeMark);time.dataset.started=agent.started||'';
          row.append(avatar,el('span',title,'conversation-agent-title'));if(model)row.append(el('span',model,'conversation-agent-model'));row.append(time);
          if(agent.id){row.type='button';row.onclick=()=>openTask(agent);row.title='See what this is doing';}
          row.setAttribute('aria-label',`${agent.id?'Open running':'Running'} ${plain?plain.toLowerCase():'background agent'}: ${title}${model&&!plain?`, ${model}`:''}`);return row;
        }));
      }
      for(const time of background.querySelectorAll('.conversation-agent-time')){const started=Date.parse(time.dataset.started)/1000,text=started>0?duration(Math.max(0,Date.now()/1000-started)):'';if(time.textContent!==text)time.textContent=text;}
    }
    function tickWorking(){
      clearTimeout(workingTimer);syncLiveStep();paintBackground();paintDelegates();if((working.hidden&&background.hidden)||panel.hidden)return;
      // A pane's own `since` restarts whenever the agent pauses and wakes, so a run in progress counts from where its steps do.
      const since=launchShown()?target.launch.at/1000:target?.state==='working'&&liveRun?.since>0?liveRun.since:Number(target?.since),time=since>0?duration(Math.max(0,Date.now()/1000-since)):'';
      if(workingTime.textContent!==time)workingTime.textContent=time;workingTimer=setTimeout(tickWorking,1000);
    }
    // The newest progress update moves into the live row, so the step in progress
    // and the timer read as one line instead of two indicators.
    // After the reply ends, a background agent the transcript does not name keeps the row, without a step.
    function syncLiveStep(){
      const waiting=target?.state==='waiting',last=working.hidden||waiting?null:working.previousElementSibling,step=last?.classList.contains('commentary')&&!last.classList.contains('delegate')&&!last.hidden?last:null;
      if(step!==liveStep){
        liveStep?.classList.remove('live');liveStep=step;
        // Shown through CSS content so the step's text stays in the transcript only once.
        if(step){step.classList.add('live');workingStep.dataset.step=step.dataset.live||[...step.childNodes].filter(node=>!node.classList?.contains('conversation-label')).map(node=>node.textContent).join(' ').replace(/\s+/g,' ').trim();}
        working.classList.toggle('has-step',!!step);
      }
      if(!step)workingStep.dataset.step=waiting?'Waiting on a background task':'Thinking…';
      workingLabel.classList.toggle('thinking',!step&&!waiting);
      const run=step&&liveRun,expanded=!!run&&!run.collapsed,count=run?`· ${run.count} steps`:'';
      working.classList.toggle('has-run',!!run);working.disabled=!run;if(workingCount.textContent!==count)workingCount.textContent=count;
      if(run){working.removeAttribute('aria-hidden');working.setAttribute('aria-expanded',String(expanded));working.setAttribute('aria-label',`${expanded?'Hide':'Show'} ${run.count-1} earlier step${run.count===2?'':'s'}`);}
      else{working.setAttribute('aria-hidden','true');working.removeAttribute('aria-expanded');working.removeAttribute('aria-label');}
    }
    function updateActivity(){
      const state=target?.state,questions=state==='input'&&target.agent==='codex'?messages.filter(item=>item.async_question).map(asyncState).filter(question=>!['answered','dismissed'].includes(question.status)):[];
      const asyncInput=questions.length>0,needsAnswer=questions.some(question=>['draft','failed','uncertain'].includes(question.status)),sendingAnswer=questions.some(question=>question.status==='sending');
      const asyncWorking=asyncInput&&target.turnState==='working',label=state==='working'?'Working…':state==='approval'?'Approval needed':needsAnswer?'Question for you':sendingAnswer?'Sending answer…':asyncInput?(asyncWorking?'Working…':'Answer submitted'):state==='input'?'Input needed':state==='waiting'?'Waiting on an agent':state==='ready'?'Ready':'';
      paintModel();
      // The model stays a control whenever there is an agent chat; a busy agent switches after its turn.
      if(switchModel){model.disabled=!target?.switchAvailable||!chat;cancelModel.hidden=!target?.pendingSwitch||!!target.pendingSwitch.running;}
      if(activity.textContent!==label)activity.textContent=label;
      activity.classList.toggle('working',state==='working'||asyncWorking&&!needsAnswer&&!sendingAnswer);
      activity.classList.toggle('question',needsAnswer);
      const follow=nearBottom();paintLaunch();working.hidden=['approval','ready'].includes(state)||state==='input'&&!asyncWorking||!launchShown()&&(!chat||!(state==='working'||asyncWorking||state==='waiting'&&!backgroundAgents().length));tickWorking();
      if(follow)list.scrollTop=list.scrollHeight;
      const startup=startupState(),stalled=!!startup&&(!!startup.error||Date.now()-startup.started>=30000);
      terminalAction.hidden=(!['approval','input'].includes(state)||state==='input'&&pendingAsyncQuestion())&&!stalled;recovery.hidden=!stalled||!!chat;
      const noComposer=!chat&&!firstMessage()&&!target?.launch&&!firstSends.has(target?.key)&&!pendingFor();if(form.hidden!==noComposer){form.hidden=noComposer;sizeDraft();}
      insert.disabled=!!pendingFor();
      // While the agent works, an empty composer offers Stop in the send button's place.
      form.classList.toggle('can-stop',(state==='working'||state==='waiting'&&target.agent==='claude'||state==='input'&&target.turnState==='working'&&pendingAsyncQuestion())&&!!target?.session&&Number.isInteger(target?.pane));stop.title=state==='waiting'?'Stop background tasks':'Interrupt the agent (sends Esc)';
      const project=projectPath().split(/[\\/]/).pop();
      const where=[project,target?.computer].filter(Boolean).join(' · ');if(context.textContent!==where){context.textContent=where;context.title='New tab in '+where;}
      paintCost();
      const placeholder=target?.agent?`Ask ${providerLabel()} a follow-up…`:'Message…';if(draft.placeholder!==placeholder)draft.placeholder=placeholder;
      // Binding gives us a chat id before its reply transport. Wait for the first
      // page so native Codex startup never grows and shrinks a Terminal footer.
      transportNotice.hidden=!loaded||!chat||!(target?.terminalReady===false&&target?.agent!=='claude'&&!(target?.agent==='codex'&&/^[0-9a-f-]{36}$/.test(chat.thread||'')));
      insert.setAttribute('aria-label',transportNotice.hidden?'Send':'Send via Terminal');insert.title=transportNotice.hidden?'Send message':'Send via Terminal and return to Conversation';
      paintPrompt();void loadPrompt();idle();
    }
    // What the chat has cost at API rates, on computers the user marked as paying for API credits.
    // It sits beside the model, and gives way to a pending model switch.
    function paintCost(){
      const usage=target?.showCost&&!target.pendingSwitch?chat?.usage:null,dollars=Number(usage?.cost_usd);
      const known=!!usage&&Number.isFinite(dollars),text=!known?'':(usage.unpriced_tokens>0?'≥ ':'')+(dollars>0&&dollars<0.01?'<$0.01':'$'+dollars.toFixed(dollars>=100?0:2));
      if(cost.textContent!==text)cost.textContent=text;
      const tokens=value=>Number(value||0).toLocaleString();
      cost.title=!known?'':`Estimated API-equivalent cost ${target?.agent==='codex'?'of this Codex chat at OpenAI list prices':'of this chat and its subagents at Anthropic list prices'}
Input ${tokens(usage.input_tokens)} · cache write ${tokens(usage.cache_write_tokens)} · cache read ${tokens(usage.cache_read_tokens)} · output ${tokens(usage.output_tokens)} tokens`+(usage.unpriced_tokens>0?`
${tokens(usage.unpriced_tokens)} tokens from models without a known price are not counted`:'');
      if(known){
        cost.setAttribute('aria-label','API cost '+text+' — show breakdown');
        const total=Number(usage.input_tokens||0)+Number(usage.cache_write_tokens||0)+Number(usage.cache_read_tokens||0);
        const cached=total?Math.round(Number(usage.cache_read_tokens||0)/total*100):0;
        const heading=el('strong','API cost '+text),rows=el('dl');
        for(const [label,value] of [['Input · cached',tokens(usage.cache_read_tokens)+' tokens ('+cached+'%)'],['Input · not cached',tokens(usage.input_tokens)+' tokens'],['Cache writes',tokens(usage.cache_write_tokens)+' tokens'],['Output',tokens(usage.output_tokens)+' tokens']])rows.append(el('dt',label),el('dd',value));
        costDetails.replaceChildren(heading,rows,el('p','This chat and its subagents at Anthropic list prices. Cache writes are new input stored for reuse; cached input was read from the cache.'));
        if(usage.unpriced_tokens>0)costDetails.append(el('p',tokens(usage.unpriced_tokens)+' tokens from models without a known price are not counted.'));
      }else{cost.removeAttribute('aria-label');costDetails.hidePopover();}

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
          const heading=el('p',menu.question,'conversation-question-text');window.SwitchboardConversationMedia?.linkify(heading,{host:target.host});heading.id='conversation-question-text';choices.setAttribute('aria-labelledby',heading.id);
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
    const asyncDraftKey=state=>'switchboard-question-draft:'+state.key;
    const asyncUnconfirmed='Delivery is not confirmed. Retry to check its status.';
    function saveAsyncDraft(state){
      try{
        if(state.status==='answered'||state.status==='draft'&&!state.answers.some(Boolean)){
          if(state.saved!==null)sessionStorage.removeItem(asyncDraftKey(state));state.saved=null;return;
        }
        const status=state.status==='sending'?'uncertain':state.status;
        const value=JSON.stringify({questions:state.questions,answers:state.answers,custom:state.custom,collapsed:state.collapsed,status,payload:state.payload,sendKey:state.sendKey,error:state.error||(status==='uncertain'?asyncUnconfirmed:'')});
        if(value!==state.saved){sessionStorage.setItem(asyncDraftKey(state),value);state.saved=value;}
      }catch{}
    }
    function asyncState(item){
      const key=identity(target)+':'+item.async_question.id;
      if(!asyncQuestions.has(key)){
        const questions=item.async_question.questions,state={key,status:'draft',collapsed:false,custom:questions.map(q=>!q.options.length),questions,answers:questions.map(()=>''),destination:{host:target.host,thread:chat?.thread,chatKey:identity(target)}};
        try{
          const saved=JSON.parse(sessionStorage.getItem(asyncDraftKey(state)));
          if(saved&&JSON.stringify(saved.questions)===JSON.stringify(questions)&&Array.isArray(saved.answers)&&saved.answers.length===questions.length&&saved.answers.every(answer=>fits(answer,4000))&&Array.isArray(saved.custom)&&saved.custom.length===questions.length&&saved.custom.every(value=>typeof value==='boolean')){
            state.answers=saved.answers;state.custom=saved.custom;state.collapsed=saved.collapsed===true;
            if(saved.status==='dismissed')state.status='dismissed';
            if(['queued','uncertain','failed'].includes(saved.status)&&fits(saved.payload,8192)&&fits(saved.sendKey,128)){
              state.status=saved.status;state.payload=saved.payload;state.sendKey=saved.sendKey;state.error=(fits(saved.error,4000)?saved.error:'')||(saved.status==='uncertain'?asyncUnconfirmed:'');
            }
          }
        }catch{}
        asyncQuestions.set(key,state);
      }
      return asyncQuestions.get(key);
    }
    function pendingAsyncQuestion(){return target?.agent==='codex'&&messages.some(item=>item.async_question&&!['answered','dismissed'].includes(asyncState(item).status));}
    function syncAsyncQuestions(){
      for(const item of messages)if(item.async_question)asyncState(item);
      for(const item of messages)for(const id of new Set((item.question_replies||[]).map(reply=>reply.id))){
        const state=asyncQuestions.get(identity(target)+':'+id),replies=item.question_replies.filter(reply=>reply.id===id);
        if(state&&replies.length===state.questions.length&&replies.every((reply,index)=>reply.question===state.questions[index].title)){
          state.status='answered';state.error='';state.answers=replies.map(reply=>reply.answer);
        }
      }
      for(const card of list.querySelectorAll('.conversation-async-question'))card.sync?.();
      for(const state of asyncQuestions.values())saveAsyncDraft(state);
      updateAsyncShortcut();
    }
    function updateAsyncShortcut(){
      const cards=[...list.querySelectorAll('.conversation-async-question')].filter(card=>['draft','failed','uncertain'].includes(card.questionState?.status));
      const bounds=list.getBoundingClientRect(),away=cards.find(card=>{const r=card.getBoundingClientRect();return card.questionState.collapsed||r.top<bounds.top+8||r.bottom>bounds.bottom-8;});
      const count=cards.reduce((sum,card)=>sum+card.questionState.questions.length,0),hidden=!away,text=count+' question'+(count===1?'':'s')+' to answer';
      const changed=asyncShortcut.hidden!==hidden||asyncShortcut.textContent!==text;
      asyncShortcut.hidden=hidden;asyncShortcut.textContent=text;
      asyncShortcut.setAttribute('aria-label',text);
      if(away)asyncShortcut.setAttribute('aria-controls',away.id);else asyncShortcut.removeAttribute('aria-controls');
      asyncShortcut.onclick=()=>{
        if(!away?.isConnected)return;
        away.questionState.collapsed=false;away.sync();
        list.scrollTop+=away.getBoundingClientRect().top-list.getBoundingClientRect().top-16;
        rememberReading();updateLatest();away.querySelector('.conversation-async-toggle').focus({preventScroll:true});
      };
      if(changed&&!panel.hidden)sizeDraft();
    }
    async function sendAsyncAnswer(item,state,retry=false){
      if(state.status==='sending'||state.status==='queued'||state.status==='answered')return;
      if(!retry){
        if(!state.answers.every(answer=>answer.trim()&&!/[\x00-\x1f\x7f]/.test(answer)))return;
        const answers=item.async_question.questions.map((question,index)=>({questionItemId:item.async_question.id,question:question.title,answer:state.answers[index].trim()}));
        state.payload='<send_user_message_question_reply>\n'+JSON.stringify(answers)+'\n</send_user_message_question_reply>';
        if(new TextEncoder().encode(state.payload).length>8192){state.error='This answer is too long. Shorten it before sending.';syncAsyncQuestions();return;}
        state.sendKey='question-'+Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');
      }
      state.status='sending';state.error='';syncAsyncQuestions();if(identity(target)===state.destination.chatKey)updateActivity();
      try{
        const response=await fetch('/api/hosts/'+encodeURIComponent(state.destination.host)+'/codex/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:state.destination.thread,message:state.payload,send_key:state.sendKey}),signal:AbortSignal.timeout(30000)});
        const result=await response.json();
        state.blockedBy=result.status==='review'?result.blocked_by:null;
        if(state.status!=='answered')state.status=response.ok&&result.status==='queued'?'queued':result.status==='failed'?'failed':'uncertain';
        if(!['queued','answered'].includes(state.status))state.error=result.detail||'Delivery is not confirmed. Retry to check its status.';
      }catch{if(state.status!=='answered'){state.status='uncertain';state.error='Delivery is not confirmed. Retry to check its status.';}}
      finally{syncAsyncQuestions();if(identity(target)===state.destination.chatKey){updateActivity();void load();}idle();}
    }
    let asyncCardId=0;
    function renderAsyncQuestion(article,item){
      const request=item.async_question,state=asyncState(item),card=el('section',undefined,'conversation-question conversation-async-question');
      card.setAttribute('aria-label','Codex question');card.id='async-question-'+(++asyncCardId);card.questionState=state;
      const toggle=el('button',undefined,'conversation-async-toggle'),mark=el('span','?','conversation-async-mark'),copy=el('span',undefined,'conversation-async-copy'),label=el('strong'),preview=el('span'),chevron=el('span',undefined,'conversation-async-chevron');
      toggle.type='button';mark.setAttribute('aria-hidden','true');chevron.setAttribute('aria-hidden','true');label.setAttribute('role','status');copy.append(label,preview);toggle.append(mark,copy,chevron);
      const body=el('div',undefined,'conversation-async-body');body.id=card.id+'-body';toggle.setAttribute('aria-controls',body.id);card.append(toggle,body);
      toggle.onclick=()=>{state.collapsed=!state.collapsed;card.sync();updateAsyncShortcut();};
      const controls=[],groups=[],send=el('button','Send answers','conversation-question-choice submit'),status=el('small',undefined,'conversation-question-status'),retry=el('button','Retry','conversation-question-choice'),checkTerminal=el('button','Check in Terminal','conversation-question-choice');
      for(const [index,question] of request.questions.entries()){
        const group=el('div',undefined,'conversation-async-question-group'),heading=el('p',question.title,'conversation-question-text'),choices=el('div',undefined,'conversation-question-choices');
        window.SwitchboardConversationMedia?.linkify(heading,{host:target.host});
        choices.setAttribute('role','group');choices.setAttribute('aria-label',question.title);
        group.append(heading,choices);body.append(group);const options=[];
        for(const label of question.options){
          const button=el('button',undefined,'conversation-question-choice');button.type='button';
          const mark=el('span',undefined,'conversation-async-option-mark');mark.setAttribute('aria-hidden','true');button.append(mark,el('span',label,'conversation-question-label'));
          button.setAttribute('aria-pressed',String(state.answers[index]===label));
          button.onclick=()=>{state.answers[index]=label;state.custom[index]=false;input.value='';if(request.questions.length===1)void sendAsyncAnswer(item,state);else syncAsyncQuestions();};
          choices.append(button);controls.push(button);options.push({button,label,mark});
        }
        const write=el('button','Write a different answer','conversation-async-write'),other=el('form',undefined,'conversation-question-other'),input=el('input'),submit=el('button','Send');input.type='text';input.maxLength=4000;input.placeholder=question.options.length?'Your answer…':'Type your answer…';input.setAttribute('aria-label',request.questions.length===1?'Type your own answer':'Answer: '+question.title);
        write.type='button';write.onclick=()=>{state.custom[index]=true;card.sync();input.focus({preventScroll:true});};
        input.value=state.custom[index]?state.answers[index]:'';
        input.oninput=()=>{state.answers[index]=input.value;syncAsyncQuestions();};
        submit.type='submit';other.append(input);if(request.questions.length===1)other.append(submit);
        other.onsubmit=event=>{event.preventDefault();state.answers[index]=input.value;if(request.questions.length===1)void sendAsyncAnswer(item,state);};
        choices.append(write,other);controls.push(write,input,submit);groups.push({index,options,write,other,input});
      }
      send.type='button';send.onclick=()=>void sendAsyncAnswer(item,state);if(request.questions.length>1)body.append(send);
      const dismiss=el('button','Dismiss question','conversation-async-write'),reopen=el('button','Answer question','conversation-async-write');
      dismiss.type=reopen.type='button';dismiss.title='Hide this question without sending an answer';
      dismiss.onclick=()=>{state.status='dismissed';state.error='';syncAsyncQuestions();updateActivity();toggle.focus({preventScroll:true});};
      reopen.onclick=()=>{state.status='draft';state.collapsed=false;syncAsyncQuestions();updateActivity();toggle.focus({preventScroll:true});};
      body.append(dismiss);card.append(reopen);
      checkTerminal.type='button';checkTerminal.onclick=()=>show(false);body.append(checkTerminal);
      retry.type='button';retry.onclick=()=>void sendAsyncAnswer(item,state,state.status!=='failed');status.setAttribute('role','status');card.append(status,retry);
      const discard=el('button','Discard saved reply','conversation-question-choice');discard.type='button';discard.onclick=async()=>{
        const blocked=state.blockedBy;discard.disabled=true;
        try{if(await discardSavedReply(state.destination.host,state.destination.thread,blocked)){
          if(blocked.send_key===state.sendKey&&state.status!=='answered'){state.status='draft';state.sendKey=null;state.payload=null;state.error='';state.blockedBy=null;}
          state.receiptChecked=0;await checkSavedReplies();syncAsyncQuestions();
        }}finally{discard.disabled=false;}
      };card.append(discard);
      card.sync=()=>{
        const locked=!['draft','failed'].includes(state.status);
        if(state.status!==state.shownStatus){if(locked&&state.status!=='uncertain')state.collapsed=true;else if(['failed','uncertain'].includes(state.status))state.collapsed=false;state.shownStatus=state.status;}
        const focusInBody=body.contains(document.activeElement);body.hidden=state.collapsed;
        toggle.setAttribute('aria-expanded',String(!state.collapsed));toggle.setAttribute('aria-label',state.collapsed?'Show question and answer':'Hide question and answer');
        card.classList.toggle('collapsed',state.collapsed);card.classList.toggle('settled',['sending','queued','answered'].includes(state.status));
        label.textContent=({sending:'Sending answer…',queued:'Answer submitted',answered:'Answered',dismissed:'Dismissed'}[state.status]||'Question for you');
        label.title=state.status==='queued'?'Codex accepted your answer. Waiting for its conversation receipt.':'';
        const summary=['sending','queued','answered'].includes(state.status);preview.textContent=state.status==='dismissed'?'No answer sent':summary?state.answers.join(' · '):'Reply when you’re ready';preview.title=summary?preview.textContent:'';
        mark.textContent=state.status==='answered'?'✓':summary?'↗':'?';
        if(state.collapsed&&focusInBody&&!panel.hidden)toggle.focus({preventScroll:true});
        for(const control of controls)control.disabled=locked;
        for(const {index,options,write,other,input} of groups){
          for(const {button,label,mark} of options){const selected=state.answers[index]===label;button.setAttribute('aria-pressed',String(selected));mark.textContent=selected?'✓':'';}
          if(locked&&state.answers[index]&&!request.questions[index].options.includes(state.answers[index]))state.custom[index]=true;
          other.hidden=!state.custom[index];write.hidden=state.custom[index]||locked;
          if(locked)input.value=state.custom[index]?state.answers[index]:'';
        }
        send.disabled=locked||!state.answers.every(answer=>answer.trim());
        retry.hidden=!['failed','uncertain'].includes(state.status);
        discard.hidden=state.status!=='uncertain'||!state.blockedBy;
        dismiss.hidden=!['draft','failed'].includes(state.status);reopen.hidden=state.status!=='dismissed';
        checkTerminal.hidden=!['queued','uncertain'].includes(state.status);
        card.classList.toggle('answering',state.status==='sending');
        status.textContent=state.error||'';status.hidden=!status.textContent;saveAsyncDraft(state);
      };
      card.sync();article.append(card);
    }
    // A new Claude at its empty prompt has no transcript until its first message, which
    // the relay types into the prompt. Its connection timer starts after that message.
    // A launched prompt is already the first message; follow-ups wait for its transcript.
    function firstMessage(){return !chat&&!target?.launch&&target?.agent==='claude'&&target.state==='ready'&&!!target.session&&Number.isInteger(target.pane)&&!firstSends.has(target.key);}
    function startupState(){if(!target||chat||!target.agent&&!target.starting)return null;const key=identity(target);if(firstMessage()||target.agent==='claude'&&['approval','input'].includes(target.state)){startups.delete(key);return null;}if(!startups.has(key)&&open&&!document.hidden)startups.set(key,{started:Date.now()});return startups.get(key);}
    function unboundNotice(){if(target?.agent==='claude'&&target.state==='approval')return 'Approval needed before the conversation can start.';if(target?.agent==='claude'&&target.state==='input')return 'Answer the agent’s question to continue.';if(firstMessage())return 'Send a message to start the conversation.';const startup=startupState();return startup?.error||(startup&&Date.now()-startup.started>=30000?'The agent has not connected. Retry or open Terminal.':target?.starting?'Starting agent…':target?.agent?'Connecting to this agent’s conversation…':'No agent');}
    function busy(value){loading=value;older.disabled=refresh.disabled=value;}
    // Touch screens open the on-screen keyboard over the conversation when the draft gains focus, so
    // there navigation focuses the panel for reading and only a tap on the draft starts a reply. A
    // draft already in use keeps focus unless the selected conversation changes.
    function focusSurface(navigated=false){if(panel.hidden||!navigated&&document.activeElement===draft)return;(form.hidden||matchMedia('(pointer:coarse)').matches?panel:draft).focus({preventScroll:true});}
    function show(value,transient=false){if(!transient){modeRevision++;if(value)startShown();else shownProgress('left');}if(!value){endConnecting('left');window.SwitchboardConversationGithub?.close(false);costDetails.hidePopover();completions.close();stopStream();loadRequest?.abort();window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();}open=value;root.classList.toggle('conversation-open',open);modeChanged(transient);if(!transient)try{localStorage.setItem(modeKey,value?'conversation':'terminal');}catch{}setPanelHidden(!value);toggle.setAttribute('aria-pressed',String(value));back.setAttribute('aria-pressed',String(!value));if(value){document.getElementById('artifact-preview').hidden=true;update();if(loaded){paint(false,restorePosition===null&&lastPaint===null);if(restorePosition!==null){list.scrollTop=restorePosition.follow?list.scrollHeight:restorePosition.position;restorePosition=null;updateLatest();}}if(binding())load(loaded?'poll':'initial');startStream();focusSurface();}else if(target)terminal(target);viewport();if(shown&&shown.generation===null)shown.generation=generation;}

    toggle.onclick=()=>show(true);back.onclick=()=>show(false);
    let loadRequest=null,lastFailure=null,lastDiagnostic='',lastDiagnosticAt=0,newOutput=false,scrollIdle,shown=null,settling=false,settleTimer,settleClears=false;
    // A first page too short to fill the list waits for the older messages it fetches next,
    // so it appears once, at the bottom, instead of at the top and then jumping down.
    function settle(value,reveal=true){
      clearTimeout(settleTimer);const was=settling;settling=value;list.classList.toggle('settling',value);
      if(value)settleTimer=setTimeout(()=>settle(false),800);
      else if(was&&reveal){if(settleClears)status('',true);settleClears=false;acknowledgeVisible();if(shown)requestAnimationFrame(()=>setTimeout(()=>shownProgress(),0));}
    }
    // Times each visible chat selection or mode switch until its messages are on screen.
    function startShown(reason='mode'){
      shownProgress('superseded');
      const timing=shown={started:performance.now(),reason,stages:{render_ms:0},remote:target?.chatHost!=='local',host:target?.chatHost||target?.host,cached:loaded,generation:null,paint_ms:null,deadline:setTimeout(()=>shownProgress('timeout'),20000)};
      requestAnimationFrame(()=>setTimeout(()=>{if(shown!==timing)return;timing.paint_ms=Math.round(performance.now()-timing.started);shownProgress();},0));
    }
    function shownProgress(end){
      const timing=shown;if(!timing)return;
      if(!end){
        if(timing.paint_ms===null||settling)return;
        end=timing.generation!==generation?'changed':!binding()?'unbound':loaded?(timing.cached?'cached':'history'):null;
        if(!end)return;
      }
      shown=null;clearTimeout(timing.deadline);
      void fetch('/api/diagnostics/conversation-shown',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({end,elapsed_ms:Math.min(120000,Math.round(performance.now()-timing.started)),paint_ms:timing.paint_ms,reason:timing.reason,remote:timing.remote,host:timing.host,...timing.stages})}).catch(()=>{});
      // A chat shown from memory and one fetched from its computer are very different waits.
      window.SwitchboardTiming?.report(!timing.cached?'conversation_load':timing.reason==='selection'?'conversation_select':'terminal_to_conversation',timing.started,end,{host:timing.host,stages:{...timing.stages,paint_ms:timing.paint_ms}});
    }
    function reportLoad(phase,outcome,started){
      const now=Date.now(),key=phase+':'+outcome;
      if(key===lastDiagnostic&&now-lastDiagnosticAt<60000)return;
      lastDiagnostic=key;lastDiagnosticAt=now;
      void fetch('/api/diagnostics/conversation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase,outcome,host:target?.chatHost||target?.host,elapsed_ms:Math.min(120000,Math.round(performance.now()-started))})}).catch(()=>{});
    }
    async function get(url,signal,stages){
      const started=performance.now(),response=await fetch(url,{signal});
      if(!response.ok)throw Object.assign(Error('The conversation could not be loaded. Retrying…'),{code:'http'});
      let data;try{data=await response.json();}catch{throw Object.assign(Error('The conversation response was incomplete. Retrying…'),{code:'invalid_response'});}
      if(data.error)throw Object.assign(Error('The conversation is temporarily unavailable. Retrying…'),{code:'http'});
      if(!Array.isArray(data.messages))throw Object.assign(Error('The conversation response was incomplete. Retrying…'),{code:'invalid_response'});
      stages.request_ms=Math.round(performance.now()-started);
      // Fixed numeric metrics from the owning relay; old peers omit the header.
      for(const metric of (response.headers.get('Server-Timing')||'').split(',')){
        const match=metric.trim().match(/^(peer|bridge|queue|read|index|page);dur=(\d+)$/);
        if(match)stages[match[1]+'_ms']=Math.min(120000,Number(match[2]));
      }
      return data;
    }
    function partialNotice(data){
      if(data.message_activity_unavailable)return 'Message receipts are temporarily unavailable. The conversation is still connected.';
      if(data.message_activity_partial)return 'Showing recent agent messages. Some older exchanges are omitted.';
      if(!data.partial)return '';
      const reasons=data.partial_reasons||[];
      if(reasons.includes('file_limit')||reasons.includes('message_limit'))return 'Update the conversation’s computer to read its complete history.';
      if(reasons.includes('record_limit'))return 'An oversized history record was skipped. Later messages can still load.';
      if(reasons.includes('malformed_record'))return 'An unreadable history record was skipped. Other messages are still available.';
      return 'Some history is unavailable. Showing the messages that could be read.';
    }
    const rendered=new Map(),renderedOutgoing=new Map(),summaries=new Map(),expandedRuns=new Set();
    const isCommentary=item=>item.role==='assistant'&&item.phase==='commentary'&&!item.async_question;
    // A finished run of two or more progress updates folds behind one summary line.
    // A run still in progress shows only its newest update; earlier ones fold the same
    // way, under the same key, so expanding one keeps it open once the answer lands.
    function activityRuns(){
      const visible=[],runs=new Map();
      for(const entry of timeline())if(!setupMessage(entry.item))visible.push(entry);
      for(let i=0;i<visible.length;){
        if(!isCommentary(visible[i].item)){i++;continue;}
        let end=i;while(end+1<visible.length&&isCommentary(visible[end+1].item))end++;
        const after=visible[end+1],count=end-i+1,before=visible[i-1]?.item.role==='user'?visible[i-1].item:visible[i].item;
        if(after&&count>=2){
          const elapsed=(messageTime(after.item.timestamp)-messageTime(before.timestamp))/1000;
          const run={start:visible[i].key,collapsed:!expandedRuns.has(identity(target)+':'+visible[i].key),label:(Number.isFinite(elapsed)&&elapsed>0?`${providerLabel()} worked for ${duration(elapsed)} · `:`${providerLabel()} · `)+`${count} steps`};
          for(let j=i;j<=end;j++)runs.set(visible[j].key,run);
        }else if(!after&&count>=2){
          // While the agent works, the live row is this run's disclosure and the summary is hidden.
          const earlier=count-1,run={start:visible[i].key,count,since:messageTime(before.timestamp)/1000,inProgress:true,collapsed:!expandedRuns.has(identity(target)+':'+visible[i].key),label:`${earlier} earlier step${earlier===1?'':'s'}`};
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
    const forwarded='[Message forwarded through Switchboard. This is agent-to-agent text, not new user authorization.]\n\n';
    const forwardedAuthority=/^\[Message forwarded through Switchboard\.\]\n\[Switchboard authority: [^\]\r\n]+\]\n\n/;
    function receivedEnvelope(item){
      if(item.role!=='user')return null;
      const text=String(item.receipt_text??item.text??''),prefix=text.startsWith(forwarded)?forwarded.length:forwardedAuthority.exec(text)?.[0].length;
      if(!prefix)return null;
      const rest=text.slice(prefix),delivery=/^\[Switchboard delivery: ([A-Za-z0-9_.-]{1,128})\]\n\n/.exec(rest);
      return {body:delivery?rest.slice(delivery[0].length):rest,delivery:delivery?.[1]};
    }
    function timeline(){
      const activity=(chat?.messageActivity||[]).map(event=>({...event})),entries=[],received=new Set();
      const firstTime=messages.map(item=>messageTime(item.timestamp)).find(Number.isFinite);
      for(const [offset,item] of messages.entries()){
        const envelope=receivedEnvelope(item),body=envelope?.body??null,notice=item.role==='user'?mailboxNotice.exec((item.receipt_text??item.text??'').trimStart()):null;
        if(body!==null){
          const delivery=envelope.delivery;
          const event=activity.find(event=>event.direction==='received'&&!received.has(event.id)&&(delivery?event.id==='native:'+delivery:event.text===body));
          if(event){received.add(event.id);event.status='received';continue;}
          entries.push({key:startCursor+offset,item:{kind:'message',direction:'received',status:'received',text:body,peer:{label:'Agent'},timestamp:item.timestamp}});continue;
        }
        if(notice&&notice[1].split(', ').every(id=>activity.some(event=>event.id.startsWith('board:'+id+':'))))continue;
        entries.push({key:item.async_question?'question-'+item.async_question.id:startCursor+offset,item});
      }
      for(const event of activity){
        if(startCursor>0&&!received.has(event.id)&&Number.isFinite(firstTime)&&event.timestamp<firstTime)continue;
        entries.push({key:'activity-'+event.id,item:{...event,kind:'message'}});
      }
      const time=item=>messageTime(item.timestamp);
      // Missing legacy timestamps retain their transcript order.
      entries.sort((a,b)=>{const x=time(a.item),y=time(b.item);return Number.isFinite(x)&&Number.isFinite(y)?x-y:0;});
      return entries;
    }
    function messageReceipt(article,item){
      const sent=item.direction==='sent',peer=item.peer||{},name=[peer.label||'Agent',peer.computer].filter(Boolean).join(' · ');
      const labels={sending:'Sending…',queued:'Queued',sent:'In inbox',delivered:'Delivered',received:'Received',acknowledged:'Acknowledged',failed:'Failed',conflict:'Conflict',unknown:'Unconfirmed'};
      const label=labels[item.status]||'Unconfirmed',summary=el('summary'),heading=el('span',`${sent?'↗ Message to':'↙ Message from'} ${name}`,'conversation-mail-heading');
      summary.append(heading,el('span',label,'conversation-mail-status'),el('span',(item.text||'').replace(/\s+/g,' ').slice(0,120),'conversation-mail-preview'));
      article.dataset.status=item.status;article.append(summary);
      const body=el('div',undefined,'conversation-notification-body');textBlocks(body,item.text||'');
      const detail=el('div',undefined,'conversation-mail-footer'),date=new Date(item.timestamp);
      const explanations={queued:'Accepted by the agent queue. Receipt has not been confirmed.',sent:'Saved in the inbox. Delivery has not been confirmed.',delivered:'Handed to the agent. Acknowledgment is separate.',received:'Present in the receiving conversation.',acknowledged:'The agent acknowledged receipt. This does not mean the task is complete.',sending:'Waiting for the destination to confirm.',unknown:'The outcome is uncertain. Check the destination before sending again.',failed:'The message could not be sent.',conflict:'This send key was already used for different content.'};
      detail.append(el('span',explanations[item.status]||explanations.unknown));
      if(Number.isFinite(date.getTime())){const time=el('time',date.toLocaleString());time.dateTime=date.toISOString();detail.append(time);}
      if(peer.chat_id){const button=el('button','Open tab');button.type='button';button.onclick=()=>{if(!openConversation(peer))status('That conversation has no open tab.');};detail.append(button);}
      body.append(detail);article.append(body);
    }
    function dayAwareTime(date){
      const now=new Date(),time=date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
      const days=Math.round((new Date(now.getFullYear(),now.getMonth(),now.getDate())-new Date(date.getFullYear(),date.getMonth(),date.getDate()))/864e5);
      if(days<=0)return time;
      if(days===1)return 'yesterday at '+time;
      return date.toLocaleDateString([],date.getFullYear()===now.getFullYear()?{month:'numeric',day:'numeric'}:{year:'numeric',month:'numeric',day:'numeric'})+' '+time;
    }
    // First in the article so the last paragraph keeps its last-child spacing.
    function messageTimestamp(article,item){
      const at=messageTime(item.timestamp);if(!Number.isFinite(at))return;
      const date=new Date(at),time=el('time',dayAwareTime(date),'conversation-time');
      time.dateTime=date.toISOString();time.title=date.toLocaleString([],{dateStyle:'long',timeStyle:'short'});article.prepend(time);
    }
    function setupMessage(item){return item.role==='user'&&/^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<skills_instructions>)/.test((item.text||'').trimStart());}
    function normalizeMessage(value){return String(value||'').replace(/\r\n/g,'\n');}
    function sameMessage(a,b){return normalizeMessage(a)===normalizeMessage(b);}
    // Claude swaps an attached image's path for an image block and leaves "[Image #N]",
    // so its transcript entry lacks the file list the composer sent; compare what remains.
    const attachedList=/\n*Attached (?:files|images):(?:\n[^\n]*)*\n*$/,withoutFiles=value=>normalizeMessage(value).replace(/\[Image #\d+\]/g,'').replace(attachedList,'').trim();
    // Claude stores a pasted reply with its edges trimmed and tabs expanded, and wraps a long one in tags.
    const pastedContent=/^\s*<pasted_content id="[^"]*">\n([\s\S]*)\n<\/pasted_content id="[^"]*">\s*$/;
    function storedForm(value){const text=normalizeMessage(value);return (pastedContent.exec(text)?.[1]??text).replace(/[ \t]+/g,' ').trim();}
    function sameTranscript(entry,payload){const stored=storedForm(entry),sent=storedForm(payload);return stored===sent||withoutFiles(stored)===withoutFiles(sent)&&attachedList.test(stored)&&attachedList.test(sent);}
    function outgoingLabel(state){return state==='sending'?'Sending…':state==='queued'?'Queued':state==='sent'?'Sent':'Could not confirm sending';}
    function sendItem(sent,state,detail){sent.state=state;sent.detail=detail||'';if(identity(target)===sent.key)paint();}
    function nearBottom(){return following&&list.scrollHeight-list.scrollTop-list.clientHeight<80;}
    let following=true,readingAnchor=null,readingPosition=0;
    function rememberReading(){
      const position=list.scrollTop,atBottom=list.scrollHeight-position-list.clientHeight<2;
      // A short upward gesture stops following. A queued programmatic scroll
      // after new output must not undo an explicit jump to the latest reply.
      following=atBottom||following&&position>=readingPosition-1;readingPosition=position;
      if(following){readingAnchor=null;return;}
      const top=list.getBoundingClientRect().top,node=[...list.querySelectorAll('.conversation-message')].find(node=>node.getBoundingClientRect().bottom>top);
      readingAnchor=node?{node,id:node.dataset.conversationEntry,offset:node.getBoundingClientRect().top-top}:null;
    }
    function restoreReadingAnchor(){
      if(!readingAnchor)return;
      const node=readingAnchor.node.isConnected?readingAnchor.node:[...list.querySelectorAll('.conversation-message')].find(node=>node.dataset.conversationEntry===readingAnchor.id);
      if(node)list.scrollTop+=node.getBoundingClientRect().top-list.getBoundingClientRect().top-readingAnchor.offset;
    }
    // Resize observers run after layout and before paint, so correcting here keeps the
    // reader's place in the same frame an image or code block above them grows.
    const contentResize=globalThis.ResizeObserver?new ResizeObserver(()=>{
      if(panel.hidden||!loaded)return;
      if(following)list.scrollTop=list.scrollHeight;
      else restoreReadingAnchor();
      updateLatest();rememberReading();
    }):null;
    contentResize?.observe(list);contentResize?.observe(working);
    if(globalThis.ResizeObserver)new ResizeObserver(()=>panel.style.setProperty('--conversation-header-height',header.offsetHeight+'px')).observe(header);
    function updateLatest(){latest.hidden=nearBottom();if(latest.hidden)newOutput=false;latest.textContent=newOutput?'↓ New messages':'↓ Latest';actions.hidden=latest.hidden&&refresh.hidden;updateAsyncShortcut();}
    // The scrollbar shows only while the reader scrolls, not when new output, the composer
    // growing or a resize moves the list.
    let scrollInput=0;for(const type of ['wheel','touchmove','pointerdown','keydown'])list.addEventListener(type,()=>{scrollInput=Date.now();},{passive:true});
    // A tab left open overnight must not call yesterday's message today's.
    for(const type of ['pointerover','focusin'])list.addEventListener(type,event=>{const time=event.target.closest('.conversation-message')?.querySelector(':scope>.conversation-time');if(!time)return;const label=dayAwareTime(new Date(time.dateTime));if(time.textContent!==label)time.textContent=label;},{passive:true});
    list.addEventListener('scroll',()=>{rememberReading();if(Date.now()-scrollInput<1000){list.classList.add('scrolling');clearTimeout(scrollIdle);scrollIdle=setTimeout(()=>list.classList.remove('scrolling'),700);}updateLatest();if(loaded&&startCursor>0&&list.scrollTop<80&&!loading&&older.hidden)load('older');},{passive:true});
    // Sends the transcript now shows leave the outgoing list; returns the list as it was.
    function acknowledge(key,messages,startCursor){
      const sentItems=outgoing.get(key)||[],used=consumedTranscript.get(key)||new Set();
      for(const sent of sentItems){
        if(sent.transcriptCursor!==undefined||sent.waitingForAgent||sent.uploading)continue;
        // Cursors can shift down when the relay hides records that settle (interrupts, local
        // command output), so an entry written after the send also counts by its timestamp.
        const after=(item,offset)=>startCursor+offset>sent.baseline||Date.parse(item.timestamp)>=sent.at-30000&&!sent.earlier.has(item.timestamp);
        const match=messages.findIndex((item,offset)=>after(item,offset)&&item.role==='user'&&!used.has(startCursor+offset)&&sameTranscript(item.receipt_text??item.text??'',sent.payload));
        if(match>=0){sent.transcriptCursor=startCursor+match;used.add(sent.transcriptCursor);if(pendingFor(sent.key)===sent){pendingSends.delete(sent.key);sent.request?.abort();sendQueued(sent.key,true);}clearSentDraft(sent);}
      }
      consumedTranscript.set(key,used);
      outgoing.set(key,sentItems.filter(item=>item.transcriptCursor===undefined));
      return sentItems;
    }
    function paint(prepend=false,initial=false){
      completions.refresh();
      const renderStarted=performance.now();
      syncAsyncQuestions();
      const key=identity(target),sentItems=acknowledge(key,messages,startCursor);
      const visibleOutgoing=sentItems.filter(item=>item.transcriptCursor===undefined);
      const entries=timeline();
      const snapshot={start:startCursor,messages:entries.map(({key,item})=>JSON.stringify([key,signatureOf(item)])),outgoing:JSON.stringify(visibleOutgoing.map(({id,text,files,state,detail,blockedBy})=>({id,text,files:files.map(file=>[file.name,!!file.path]),state,detail,blockedBy})))};
      if(lastPaint&&lastPaint.start===snapshot.start&&lastPaint.outgoing===snapshot.outgoing&&lastPaint.messages.length===snapshot.messages.length&&snapshot.messages.every((signature,i)=>signature===lastPaint.messages[i]))return;
      lastPaint=snapshot;
      // The transcript now has the launched prompt: drop the stand-in and its starting row.
      if(launchNode.isConnected&&!launchShown())updateActivity();
      const follow=initial||nearBottom(),height=list.scrollHeight,position=list.scrollTop,keys=new Set(entries.filter(({item})=>!setupMessage(item)).map(({key})=>key));
      if(!follow&&!prepend&&!initial)newOutput=true;
      // Remove vanished entries before placing retained inputs. Moving a question
      // ahead of a stale sibling would detach its input and lose keyboard focus.
      for(const [key,entry] of rendered)if(!keys.has(key)){contentResize?.unobserve(entry.node);entry.node.remove();rendered.delete(key);}
      let previous=launchShown()?launchNode:older,previousRole=null,previousSpeaker=null;
      const runs=activityRuns(),summaryKeys=new Set();liveRun=[...runs.values()].find(run=>run.inProgress)||null;
      for(const {key,item} of entries){
        if(setupMessage(item))continue;
        const mail=item.kind==='message',notices=mailboxCount(item),signature=item.async_question?JSON.stringify(item.async_question):signatureOf(item),speaker=mail||notices?'Switchboard':item.role==='user'?'You':providerLabel();
        const run=runs.get(key);
        if(run?.start===key){
          let summary=summaries.get(key);
          if(!summary){summary=el('button',undefined,'conversation-steps');summary.type='button';summary.onclick=()=>{const id=identity(target)+':'+key;expandedRuns.has(id)?expandedRuns.delete(id):expandedRuns.add(id);lastPaint=null;paint();};summaries.set(key,summary);}
          if(summary.textContent!==run.label)summary.textContent=run.label;summary.setAttribute('aria-expanded',String(!run.collapsed));summary.classList.toggle('in-progress',!!run.inProgress);summaryKeys.add(key);
          if(previous.nextSibling!==summary)previous.after(summary);previous=summary;
        }
        let entry=rendered.get(key);
        if(!entry||entry.signature!==signature){
          const article=el(mail||notices?'details':'article',undefined,'conversation-message '+(mail?'conversation-notification conversation-mail':notices?'conversation-notification':item.role+(item.phase==='commentary'?' commentary':'')+(item.kind==='tool'?' tool':'')));
          article.dataset.conversationEntry='message-'+key;contentResize?.observe(article);
          if(mail){messageReceipt(article,item);article.open=entry?.node.open||false;}
          else if(notices){
            article.append(el('summary','Switchboard · '+notices+' message'+(notices===1?'':'s')));
            const body=el('div',undefined,'conversation-notification-body');textBlocks(body,item.text||'');article.append(body);article.open=entry?.node.open||false;
          }else{
            article.append(el('div',speaker,'conversation-label'));
            if(item.phase!=='commentary')messageTimestamp(article,item);
            if(isDelegate(item))delegateCard(article,item);
            else if(item.kind==='tool')toolStep(article,item);
            else if(item.async_question&&target?.agent==='codex'&&/^[0-9a-f-]{36}$/.test(chat?.thread||''))renderAsyncQuestion(article,item);
            else{if(window.SwitchboardConversationMedia&&(item.markdown||item.attachments))window.SwitchboardConversationMedia.render(article,item,{host:target.host,project:binding()?.project});else textBlocks(article,item.text||'');
              window.SwitchboardConversationGithub?.decorate(article,{host:target.host,project:binding()?.project});decorateCode(article);if(item.role==='user')completions.decorate(article);}
          }
          if(item.truncated)article.append(el('small','Message truncated by history API. Open the terminal for full context.'));
          if(entry){contentResize?.unobserve(entry.node);entry.node.remove();}entry={signature,node:article};rendered.set(key,entry);
        }
        entry.node.classList.toggle('continuation',previousRole==='assistant'&&item.role==='assistant'&&previousSpeaker===speaker);previousRole=notices?'notification':item.role;previousSpeaker=speaker;
        entry.node.hidden=!!run?.collapsed&&!isDelegate(item);
        if(previous.nextSibling!==entry.node)previous.after(entry.node);
        previous=entry.node;
      }
      for(const [key,summary] of summaries)if(!summaryKeys.has(key)){summary.remove();summaries.delete(key);}
      for(const sent of visibleOutgoing){
        const signature=JSON.stringify([sent.text,sent.files.map(file=>[file.name,!!file.path]),sent.state,sent.detail,sent.blockedBy]);let entry=renderedOutgoing.get(sent.id);
        if(!entry||entry.signature!==signature){
          const article=el('article',undefined,'conversation-message user conversation-outgoing '+sent.state),label=el('div','You','conversation-label');article.append(label);textBlocks(article,sent.text||'');completions.decorate(article);
          article.dataset.conversationEntry='outgoing-'+sent.id;contentResize?.observe(article);
          const mediaFiles=sent.files.filter(file=>file.path&&(file.kind==='image'||file.kind==='video'));
          if(window.SwitchboardConversationMedia&&mediaFiles.length)window.SwitchboardConversationMedia.render(article,{attachments:mediaFiles.map(file=>({kind:file.kind,name:file.name,url:file.path}))},{host:sent.host});
          for(const file of sent.files.filter(file=>!window.SwitchboardConversationMedia||!mediaFiles.includes(file)))article.append(el('div',file.name,'conversation-outgoing-file'));
          const footer=el('div',undefined,'conversation-outgoing-status');footer.append(el('span',sent.detail||outgoingLabel(sent.state)));
          if(['failed','uncertain'].includes(sent.state)&&sent.native){
            const retry=el('button','Retry');retry.type='button';retry.onclick=()=>retrySend(sent);footer.append(retry);
            if(sent.blockedBy){
              const discard=el('button','Discard saved reply');discard.type='button';discard.onclick=async()=>{
                const blocked=sent.blockedBy;discard.disabled=true;
                try{if(await discardSavedReply(sent.host,sent.thread,blocked)){
                  if(blocked.send_key===sent.sendKey)forgetCancelledReply(sent);
                  for(const item of outgoing.get(sent.key)||[])item.receiptChecked=0;
                  await checkSavedReplies();paint();
                }}finally{discard.disabled=false;}
              };footer.append(discard);
            }
          }
          article.append(footer);if(entry){contentResize?.unobserve(entry.node);entry.node.remove();}entry={signature,node:article};renderedOutgoing.set(sent.id,entry);
        }
        if(previous.nextSibling!==entry.node)previous.after(entry.node);previous=entry.node;
      }
      const outgoingIds=new Set(visibleOutgoing.map(item=>item.id));for(const [id,entry] of renderedOutgoing)if(!outgoingIds.has(id)){contentResize?.unobserve(entry.node);entry.node.remove();renderedOutgoing.delete(id);}
      if(list.lastChild!==background||background.previousSibling!==working)list.append(working,background);
      if(prepend)list.scrollTop=position+list.scrollHeight-height;
      else if(follow)list.scrollTop=list.scrollHeight;
      // Replacing an earlier message can move the reader before ResizeObserver
      // runs. Restore the saved anchor before remembering the new layout.
      else restoreReadingAnchor();
      syncAsyncQuestions();tickWorking();updateLatest();rememberReading();paintFiles();
      if(shown)shown.stages.render_ms=Math.round(performance.now()-renderStarted);
    }
    function applyPage(data,kind,cursor){
      const initial=kind==='initial',prepend=kind==='older',page=data.messages||[],start=data.start_cursor??(initial?0:prepend?Math.max(0,startCursor-page.length):cursor);
      // Live output must leave a failed older read's retry available.
      if(initial||prepend)older.hidden=true;
      chat.project=data.project||chat.project;chat.thread=data.session_id||chat.thread;
      if('model' in data)chat.model=data.model;
      if('reasoning_effort' in data)chat.reasoning_effort=data.reasoning_effort;
      if('usage' in data)chat.usage=data.usage;
      if(Array.isArray(data.background_agents))chat.background=data.background_agents;
      if(Array.isArray(data.delegates))chat.delegates=data.delegates;
      if(Array.isArray(data.message_activity))chat.messageActivity=data.message_activity;
      if(initial){messages=page;startCursor=start;tailCursor=start+Math.max(0,page.length-1);nextCursor=data.next_cursor??null;}
      else if(prepend){messages=page.concat(messages);startCursor=start;}
      else{if(start<startCursor){messages=page;startCursor=start;}else messages=messages.slice(0,Math.max(0,start-startCursor)).concat(page);tailCursor=start+Math.max(0,page.length-1);nextCursor=data.next_cursor??null;}
      loaded=true;refresh.hidden=true;syncAsyncQuestions();updateActivity();if(open){paint(prepend,initial);paintDelegates();}flushStartup();
      // Conversation has no terminal focus acknowledgement. Review only output
      // that has loaded and is visible at the end of the selected transcript.
      if(!settling)acknowledgeVisible();
    }
    function acknowledgeVisible(){if(open&&!panel.hidden&&!document.hidden&&document.hasFocus()&&nextCursor===null&&nearBottom())viewed(target);}
    const firstPage=15;
    function forgetCancelledReply(sent){
      if(pendingFor(sent.key)===sent){pendingSends.delete(sent.key);sendQueued(sent.key,false);notSent(sent.pane);}
      outgoing.set(sent.key,(outgoing.get(sent.key)||[]).filter(item=>item!==sent));
      if(retryKeys.get(sent.key)?.id===sent.sendKey)retryKeys.delete(sent.key);
      paintFiles();
    }
    async function discardSavedReply(host,thread,blocked){
      if(!blocked?.send_key||typeof blocked.message!=='string'||!confirm('Discard this saved reply?\n\n'+blocked.message+'\n\nIt will not be sent again. Later saved replies will continue.'))return false;
      try{
        const response=await fetch('/api/hosts/'+encodeURIComponent(host)+'/codex/reply?'+new URLSearchParams({thread,send_key:blocked.send_key}),{method:'DELETE',signal:AbortSignal.timeout(10000)});
        if(response.ok&&(await response.json()).status==='cancelled')return true;
      }catch{}
      sendStatus('Could not discard the saved reply. Check its status and try again.');return false;
    }
    async function checkSavedReplies(){
      const current=target,key=identity(current),items=outgoing.get(key)||[];
      for(const state of asyncQuestions.values()){
        if(state.destination.chatKey!==key||!['queued','uncertain'].includes(state.status)||state.receiptPending||Date.now()-(state.receiptChecked||0)<=5000)continue;
        state.receiptPending=true;state.receiptChecked=Date.now();const checkedKey=state.sendKey;
        try{const response=await fetch('/api/hosts/'+encodeURIComponent(state.destination.host)+'/codex/receipt?'+new URLSearchParams({thread:state.destination.thread,send_key:checkedKey}),{signal:AbortSignal.timeout(5000)});if(!response.ok)continue;const result=await response.json();
          if(state.status==='answered'||state.sendKey!==checkedKey)continue;
          if(result.status==='review'){state.status='uncertain';state.error=result.detail||asyncUnconfirmed;state.blockedBy=result.blocked_by;}
          else if(result.status==='cancelled'){state.status='draft';state.sendKey=null;state.payload=null;state.error='';state.blockedBy=null;}
          else if(['pending','queued'].includes(result.status)){state.status='queued';state.error='';state.blockedBy=null;}
          if(identity(target)===key)syncAsyncQuestions();}
        catch{}finally{state.receiptPending=false;}
      }
      for(const sent of items.filter(item=>item.native&&['queued','uncertain'].includes(item.state)&&!item.receiptPending&&Date.now()-(item.receiptChecked||0)>5000)){
        sent.receiptPending=true;sent.receiptChecked=Date.now();
        try{const response=await fetch('/api/hosts/'+encodeURIComponent(sent.host)+'/codex/receipt?'+new URLSearchParams({thread:sent.thread,send_key:sent.sendKey}),{signal:AbortSignal.timeout(5000)});if(!response.ok)continue;const result=await response.json();
          if(result.status==='review'){sent.state='uncertain';sent.detail=result.detail||'Saved. Check the conversation before resending.';sent.blockedBy=result.blocked_by;}
          else if(result.status==='cancelled')forgetCancelledReply(sent);
          else if(['pending','queued'].includes(result.status)&&sent.state==='uncertain'){sent.state='queued';sent.detail='';sent.blockedBy=null;clearSentDraft(sent);}
          if(identity(target)===key)paint();}
        catch{}finally{sent.receiptPending=false;}
      }
    }
    async function load(kind='poll'){
      if(!target||!binding()||loading||(!open&&kind!=='initial'))return;if(!loaded)kind='initial';const version=generation,chat=binding(),started=performance.now(),request=new AbortController();loadRequest=request;let timedOut=false,catchUp=false;busy(true);const timeout=setTimeout(()=>{timedOut=true;request.abort();},15000);
      checkSavedReplies();
      const initial=kind==='initial',prepend=kind==='older',cursor=nextCursor??tailCursor;
      // Each first read counts from zero, including a tab switch that keeps the same notice.
      if(initial&&loadingTimer!==null){loadingStarted=performance.now();tickLoading();}
      historyStatus.hidden=!prepend;historyStatus.textContent='Loading earlier messages…';
      const params={host:target.chatHost||target.host,context:'true',limit:initial?firstPage:50},stages={};
      if(initial)params.tail=true;else if(prepend)params.before=startCursor;else params.cursor=cursor;
      try{const data=await get('/api/chats/'+encodeURIComponent(chat.id)+'?'+new URLSearchParams(params),request.signal,stages);if(version!==generation)return;
        const renderStarted=performance.now();if(initial&&open)settle(true);applyPage(data,kind,cursor);stages.render_ms=Math.round(performance.now()-renderStarted);if(initial&&shown&&!shown.cached)shown.stages=stages;
        if(shown)requestAnimationFrame(()=>setTimeout(()=>shownProgress(),0));streamSupported=data.stream===true;startStream();const warning=partialNotice(data);settleClears=settling&&!warning;if(!settleClears)status(warning,!warning);if(warning){reportLoad(kind,'partial',started);lastFailure='partial';}else if(lastFailure){reportLoad(kind,'recovered',started);lastFailure=null;}updateLatest();catchUp=nextCursor!==null&&!prepend;
      }catch(error){if(version===generation&&!(!timedOut&&request.signal.aborted)){const outcome=timedOut?'timeout':error.code||'network';lastFailure=outcome;reportLoad(kind,outcome,started);if(initial)shownProgress('failed');const message=timedOut?'Loading took too long. Retrying…':error.code?error.message:'Connection interrupted. Retrying…';if(prepend){older.textContent='Retry earlier messages';older.hidden=false;}else{status(message);refresh.hidden=false;updateLatest();}}}finally{clearTimeout(timeout);if(loadRequest===request)loadRequest=null;if(version===generation){busy(false);historyStatus.hidden=true;for(const data of streamPages)streamPage(data);streamPages=[];if(catchUp)setTimeout(()=>{if(version===generation)load();},0);else if(open&&loaded&&startCursor>0&&older.hidden&&(list.scrollTop<80||list.scrollHeight<=list.clientHeight))setTimeout(()=>{if(version===generation)load('older');},0);else settle(false);}}
    }
    older.onclick=()=>load('older');refresh.onclick=()=>load(messages.length?'poll':'initial');latest.onclick=()=>{list.scrollTop=list.scrollHeight;rememberReading();updateLatest();};
    let draftSizeKey;
    function sizeDraft(){
      if(panel.hidden||form.hidden)return;
      const key=JSON.stringify([draft.value,draft.clientWidth,window.visualViewport?.height||innerHeight]);
      const follow=nearBottom(),limit=Math.min(144,Math.max(60,(window.visualViewport?.height||innerHeight)*.25));
      if(key!==draftSizeKey){draftSizeKey=key;draft.style.height='0px';const height=draft.scrollHeight;draft.style.height=Math.min(height,limit)+'px';draft.style.overflowY=height>limit?'auto':'hidden';}
      panel.style.setProperty('--composer-height',form.offsetHeight+(question.hidden?0:question.offsetHeight+8)+(asyncShortcut.hidden?0:asyncShortcut.offsetHeight+8)+'px');if(follow)list.scrollTop=list.scrollHeight;updateLatest();
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
      if(!destination||pendingFor(identity(destination)))return;const key=identity(destination),host=destination.host,added=[];
      // The whole selection joins the composer before any upload, so a model switch meanwhile moves all of it.
      for(const file of selected){
        if(fileList(key).length>=8){if(identity(target)===key)sendStatus('Attach up to 8 files per message.');break;}
        if(!file.size||file.size>20*1024*1024){if(identity(target)===key)sendStatus('Choose a non-empty file up to 20 MB.');continue;}
        const item={name:file.name,kind:file.type.startsWith('image/')?'image':file.type.startsWith('video/')?'video':'file',preview:file.type.startsWith('image/')?URL.createObjectURL(file):null};item.uploaded=new Promise(resolve=>item.finishUpload=resolve);attachments.set(key,[...fileList(key),item]);added.push([file,item]);
      }
      if(identity(target)===key)paintFiles();
      for(const [file,item] of added){
        try{const response=await fetch('/api/hosts/'+encodeURIComponent(host)+'/attachments?'+new URLSearchParams({name:file.name}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
          if(!response.ok)throw Error('Could not upload '+file.name+'. Remove it and try again.');const data=await response.json();if(typeof data.path!=='string'||!data.path||/[\x00-\x1f]/.test(data.path))throw Error('Invalid attachment response');item.path=data.path;
        }catch(error){item.error=true;if(fileList().includes(item))sendStatus(error.message);}
        item.finishUpload();
        if(fileList().includes(item))paintFiles();
      }
    }
    picker.onchange=()=>{const selected=[...picker.files],destination=pickerTarget;picker.value='';pickerTarget=null;void addFiles(selected,destination);};
    draft.addEventListener('paste',event=>{const selected=[...(event.clipboardData?.files||[])];if(selected.length){event.preventDefault();void addFiles(selected);}});
    draft.oninput=()=>{if(target){const key=identity(target);drafts.set(key,draft.value);draftVersions.set(key,(draftVersions.get(key)||0)+1);}sizeDraft();if(!pendingFor())sendStatus('');completions.paint();};
    draft.onkeydown=event=>{
      if(event.isComposing)return;
      if(completions.key(event))return;
      if(event.key==='Escape'&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&stop.offsetParent&&!stop.disabled&&target?.state!=='waiting'){event.preventDefault();stop.click();return;}
      if(event.key==='Enter'&&!event.shiftKey&&!matchMedia('(pointer:coarse)').matches){event.preventDefault();form.requestSubmit();}
    };
    // Enter empties the draft at once so the next message can be typed while this one sends.
    // A failed send puts its text back, unless something new was typed in the meantime.
    function takeDraft(sent){
      if(identity(target)!==sent.key||draft.value!==sent.text)return;
      const version=(draftVersions.get(sent.key)||0)+1;draftVersions.set(sent.key,version);sent.draftRevision=version;sent.draftTaken=true;
      drafts.delete(sent.key);draft.value='';sizeDraft();completions.close();
    }
    function restoreDraft(sent){
      if(!sent.draftTaken)return;sent.draftTaken=false;
      if((draftVersions.get(sent.key)||0)!==sent.draftRevision||drafts.get(sent.key))return;
      drafts.set(sent.key,sent.text);if(identity(target)===sent.key&&!draft.value){draft.value=sent.text;sizeDraft();}
    }
    // A message submitted while another was sending goes next, once that one is confirmed.
    function sendQueued(key,ok){
      if(queuedSubmit!==key)return;queuedSubmit=null;
      if(ok&&identity(target)===key&&draft.value.trim())setTimeout(()=>{if(identity(target)===key&&identity(selection())===key)form.requestSubmit();});
    }
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
      pendingSends.delete(sent.key);if(!ok){restoreDraft(sent);if(sent.detachedFiles)attachments.set(sent.key,[...sent.files,...fileList(sent.key).filter(item=>!sent.files.includes(item))]);}
      sendQueued(sent.key,ok);
      if(ok&&sent.holds)sending(sent.target,sent.command&&!sent.skill);
      if(ok){clearSentDraft(sent);if(sent.command&&!sent.skill){outgoing.set(sent.key,(outgoing.get(sent.key)||[]).filter(item=>item!==sent));if(identity(target)===sent.key)paint();}else sendItem(sent,sent.native||sent.relay?'queued':'sent');}
      else{notSent(sent.pane);sendItem(sent,uncertain?'uncertain':'failed',message);}
      returnToConversation(sent);
      if(identity(target)===sent.key){sendStatus(message,sent);if(ok)load();}paintFiles();if(ok)flushStartup();
    }
    async function sendNative(sent){
      const request=new AbortController();sent.request=request;
      const timeout=setTimeout(()=>request.abort(),30000);
      try{
        const response=await fetch('/api/hosts/'+encodeURIComponent(sent.host)+'/codex/reply',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:sent.thread,message:sent.payload,send_key:sent.sendKey}),signal:request.signal});
        const result=await response.json(),ok=response.ok&&result.status==='queued';
        if(response.ok&&result.status==='cancelled'){forgetCancelledReply(sent);paint();return;}
        sent.blockedBy=result.status==='review'?result.blocked_by:null;
        complete(sent,ok,ok?'':result.detail||'Could not confirm sending. Retry to check its status.',result.status!=='failed');
      }catch{complete(sent,false,request.signal.aborted?'Sending timed out. Delivery is not confirmed. Retry to check its status.':'Could not confirm sending. Retry to check its status.',true);}
      finally{clearTimeout(timeout);if(sent.request===request)sent.request=null;}
    }
    async function retrySend(sent,claimDraft=false){
      if(pendingFor(sent.key)||!['failed','uncertain'].includes(sent.state)||!sent.native)return;
      const destination=selection();if(identity(destination)!==sent.key)return;
      if(claimDraft){sent.draftRevision=draftVersions.get(sent.key)||0;sent.text=draft.value;sent.draftCleared=false;}
      pendingSends.set(sent.key,sent);insert.disabled=true;sent.state='sending';sent.detail='';paintFiles();sendStatus('');paint();
      sending(destination,sent.command);
      await sendNative(sent);
    }
    form.onsubmit=async event=>{
      event.preventDefault();const current=selection(),waiting=!chat&&!!(target?.launch||firstSends.has(target?.key))||(outgoing.get(identity(target))||[]).some(item=>item.waitingForAgent);
      if(!target||identity(current)!==identity(target)||!binding()&&!firstMessage()&&!waiting||(!draft.value.trim()&&!fileList().length))return;
      if(pendingFor()){if(draft.value.trim())queuedSubmit=identity(target);return;}
      // Waiting: the turn ended while background work runs; the prompt still takes input.
      const asyncReply=current.agent==='codex'&&current.state==='input'&&/^[0-9a-f-]{36}$/.test(chat?.thread||'');
      if(!waiting&&!['ready','waiting','working'].includes(current.state)&&!asyncReply){sendStatus(question.hidden?'The agent needs attention in Terminal. Your draft is kept.':'Answer the agent’s question first. Your draft is kept.');return;}
      const selected=fileList(),uploading=selected.some(item=>!item.path);if(selected.some(item=>item.error)){sendStatus('Remove failed attachments before sending.');return;}
      const expanded=completions.expand(draft.value);if(expanded!==draft.value){draft.value=expanded;draft.oninput();}
      const text=draft.value,payload=withAttachments(text,selected);
      if(/[\x00-\x08\x0b-\x1f\x7f]/.test(payload)){sendStatus('The draft contains terminal control characters. Remove them first.');return;}
      const command=/^\/[a-z][\w:.-]*(?:\s|$)/i.test(text),native=!command&&current.agent==='codex'&&/^[0-9a-f-]{36}$/.test(chat?.thread||'');
      if(command&&selected.length){sendStatus('Send commands without attachments. Your draft is kept.');return;}
      // Codex commands need its prompt. Keep them queued through startup or a turn.
      const waitForPrompt=command&&current.agent!=='claude'&&['working','input'].includes(current.state);
      if(!waiting&&!waitForPrompt&&current.state==='working'&&!native&&current.agent!=='claude'){sendStatus('Still connecting to this conversation. Try sending again in a moment.');return;}
      const byteLimit=native||waiting&&(current.agent||current.launch?.agent)==='codex'?8192:16000;
      if(tooLong(payload,byteLimit)){sendStatus(TOO_LONG);return;}
      const retry=native&&!uploading&&(outgoing.get(identity(target))||[]).find(item=>['failed','uncertain'].includes(item.state)&&item.native&&sameMessage(item.payload,payload));
      if(retry){retrySend(retry,true);return;}
      const key=identity(target),id='conversation-'+Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');
      const items=outgoing.get(key)||[],failedBridge=!native&&!uploading&&items.find(item=>item.state==='failed'&&!item.native&&sameMessage(item.payload,payload));
      const sent={id,key,pane:target.key,unbound:!chat,frame:target.frame,text,payload,uploading,byteLimit,files:[...selected],native,command,route:command?commandRoute(current.agent,text):null,skill:command&&commandRoute(current.agent,text)==='turn',host:target.host,thread:chat?.thread,draftRevision:draftVersions.get(key)||0,baseline:failedBridge?failedBridge.baseline:startCursor+messages.length-1,at:failedBridge?failedBridge.at:Date.now(),earlier:failedBridge?failedBridge.earlier:new Set(messages.filter(item=>item.role==='user'&&item.timestamp).map(item=>item.timestamp)),sendKey:id,state:'sending'};
      if(failedBridge)items[items.indexOf(failedBridge)]=sent;else items.push(sent);
      if(waiting||waitForPrompt){
        sent.waitingForAgent=true;sent.detachedFiles=true;sent.state='queued';outgoing.set(key,items);takeDraft(sent);
        attachments.delete(key);paintFiles();sendStatus('');paint();flushStartup();return;
      }
      outgoing.set(key,items);pendingSends.set(key,sent);insert.disabled=true;takeDraft(sent);paintFiles();sendStatus('');paint();
      await deliverAfterUploads(sent,current);
    };
    function withAttachments(text,selected){const paths=selected.map(item=>item.path).filter(Boolean);return text+(paths.length?'\n\nAttached files:\n'+paths.join('\n'):'');}
    const TOO_LONG='This message is too long. Shorten it before sending.';
    function tooLong(payload,limit){return new TextEncoder().encode(payload).length>limit;}
    // Enter does not wait for uploads. The message goes out once they finish, and a
    // failed upload puts it back in the composer with the failed file marked.
    async function deliverAfterUploads(sent,current){
      if(sent.uploading){
        await Promise.all(sent.files.map(item=>item.uploaded));
        if(pendingFor(sent.key)!==sent)return;
        sent.uploading=false;sent.payload=withAttachments(sent.text,sent.files);
        const failed=sent.files.find(item=>item.error);
        if(failed||tooLong(sent.payload,sent.byteLimit)){abandonSend(sent,failed?'Could not upload '+failed.name+'. Remove it and try again.':TOO_LONG);return;}
        if(identity(target)===sent.key)paint();
        const latest=selection();if(identity(latest)===sent.key)current=latest;
      }
      await deliver(sent,current);
    }
    // Nothing reached the agent, so there is nothing to retry. The bubble stays only if
    // newer typing kept the text from returning to the composer.
    function abandonSend(sent,message){
      sent.native=false;complete(sent,false,message);
      if(sent.text&&drafts.get(sent.key)!==sent.text)return;
      outgoing.set(sent.key,(outgoing.get(sent.key)||[]).filter(item=>item!==sent));if(identity(target)===sent.key)paint();
    }
    // Startup follow-ups wait for the real pane and transcript, then use the same
    // delivery and acknowledgement path as any other reply, one at a time.
    function flushStartup(){
      if(!target||!chat||!loaded||nextCursor!==null||pendingFor()||identity(selection())!==identity(target)||!['ready','waiting','working'].includes(target.state))return;
      const sent=(outgoing.get(identity(target))||[]).find(item=>item.waitingForAgent);if(!sent)return;
      const native=!sent.command&&target.agent==='codex'&&/^[0-9a-f-]{36}$/.test(chat.thread||'');
      if(target.state==='working'&&!native&&target.agent!=='claude')return;
      sent.waitingForAgent=false;Object.assign(sent,{native,thread:chat.thread,frame:target.frame,pane:target.key,unbound:false,at:Date.now(),baseline:startCursor+messages.length-1,earlier:new Set(messages.filter(item=>item.role==='user'&&item.timestamp).map(item=>item.timestamp)),state:'sending'});
      pendingSends.set(sent.key,sent);paintFiles();paint();void deliverAfterUploads(sent,target);
    }
    // Claude's input box can be gone for a moment (a redraw) or until a dialog or a
    // collapsed pane clears. Nothing was typed, so the message stays on its way and is
    // tried again. Computers that have not updated still answer with the second text.
    const AWAITING_PROMPT=new Set(["Waiting for Claude's input box.",'Claude is not at its prompt. Open Terminal to see what it needs.']);
    function holdSend(sent){
      if(pendingFor(sent.key)!==sent)return;
      // The tab should not read as Working while nothing has reached Claude.
      if(!sent.holds)notSent(sent.pane);
      const delay=Math.min(15000,1000*2**(sent.holds||0));sent.holds=(sent.holds||0)+1;sent.attempt=(sent.attempt||0)+1;
      setTimeout(()=>{if(pendingFor(sent.key)===sent)void deliver(sent,sent.target);},delay);
    }
    async function deliver(sent,current){
      const {native,key,id,payload,skill}=sent,command=sent.command&&!skill,terminal=sent.route==='terminal';
      sent.target=current;
      if(!sent.holds)sending(current,command,native);
      if(native){
        const prior=retryKeys.get(key),sendKey=prior?.payload===payload?prior.id:id;sent.sendKey=sendKey;retryKeys.set(key,{payload,id:sendKey});
        await sendNative(sent);return;
      }
      // The relay types Claude replies into the pane, so Conversation stays on screen.
      // Older relays answer 404 and use the terminal below.
      if(current.agent==='claude'&&!terminal){
        try{
          const response=await fetch('/api/hosts/'+encodeURIComponent(sent.host)+'/conversation/reply',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({session:current.session,tab_id:current.tab,pane_id:current.pane,text:payload}),signal:AbortSignal.timeout(20000)});
          // An accepted first message starts the connection timer, whatever the pane reads next.
          if(response.ok&&sent.unbound){firstSends.add(sent.pane);if(identity(selection())===sent.key){updateActivity();status(unboundNotice(),loaded);}}
          // A draft typed in Terminal is set aside and restored; the relay says if it was not.
          if(response.status!==404){
            sent.relay=true;
            const refusal=response.ok?'':await response.text();
            if(AWAITING_PROMPT.has(refusal)){holdSend(sent);return;}
            complete(sent,response.ok,response.ok?(await response.json().catch(()=>({}))).notice||'':refusal||'Could not send the reply. Your draft is kept.');return;
          }
        }catch(error){const timeout=error.name==='TimeoutError';complete(sent,false,timeout?'No confirmation from the terminal. Check it before trying again; your draft is kept.':'Could not reach this computer. Your draft is kept.',timeout);return;}
      }
      // Agents without a native reply API need the visible terminal connection.
      // Attach only after leaving Conversation, then wait for the selected pane.
      if(!sent.holds&&(terminal||current.terminalReady===false)){
        sent.returnHere=!terminal;sent.modeRevision=modeRevision;sent.navigationRevision=navigationRevision;show(false,true);
        const deadline=Date.now()+10000;
        while(pendingFor(key)===sent&&identity(selection())===key&&!selection()?.terminalReady&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
        if(pendingFor(key)!==sent)return;
        if(identity(selection())!==key||!selection()?.terminalReady){complete(sent,false,'Terminal is not ready. Your draft is kept.');return;}
      }
      // Found by id until its result arrives, even once the transcript acknowledged it.
      bridgeSends.set(id,sent);
      sent.frame.contentWindow.postMessage({type:'zellij-conversation-paste',id,pane_id:current.pane,agent:current.agent,submit:true,text:payload},location.origin);
      const attempt=sent.attempt=(sent.attempt||0)+1;
      setTimeout(()=>{if(sent.attempt===attempt)complete(sent,false,'No confirmation from the terminal. Check it before trying again; your draft is kept.');},4000);
    }
    window.addEventListener('message',event=>{
      if(event.origin!==location.origin||event.data?.type!=='zellij-conversation-paste-result')return;
      const sent=bridgeSends.get(event.data.id);if(!sent||event.source!==sent.frame?.contentWindow)return;bridgeSends.delete(sent.id);
      if(!event.data.ok&&AWAITING_PROMPT.has(event.data.error)){holdSend(sent);return;}
      complete(sent,event.data.ok,event.data.ok?event.data.notice||'':event.data.error||'Open the terminal and try again.');
    });
    function update(){
      root.classList.toggle('conversation-open',open);
      const current=selection();modes.hidden=!current;
      title.textContent=current?.title||'Conversation';title.title=title.textContent;
      if(identity(current)===identity(target)){target=current;updateActivity();if(!chat)status(unboundNotice());prepare();flushStartup();return;}
      // A mode switch may already have started a timer before calling update.
      if(!current)shownProgress('left');else if(open&&!document.hidden&&(!shown||shown.generation!==null))startShown('selection');
      completions.close();navigationRevision++;
      if(target)drafts.set(identity(target),draft.value);
      if(target&&loaded){conversations.delete(identity(target));conversations.set(identity(target),{chat,messages,startCursor,tailCursor,nextCursor,streamSupported,position:restorePosition?.position??list.scrollTop,follow:restorePosition?.follow??nearBottom()});if(conversations.size>8)conversations.delete(conversations.keys().next().value);}
      window.SwitchboardConversationMedia?.pause(panel);window.SwitchboardConversationMedia?.close();
      window.SwitchboardConversationGithub?.close(false);taskDialog.close();costDetails.hidePopover();stopStream();streamSupported=false;restorePosition=null;target=current;liveRun=null;loadRequest?.abort();lastFailure=null;lastDiagnostic='';newOutput=false;sendStatus('');generation++;settle(false,false);settleClears=false;loaded=false;lastPaint=null;busy(false);messages=[];startCursor=tailCursor=0;nextCursor=null;following=true;readingAnchor=null;readingPosition=0;for(const entry of [...rendered.values(),...renderedOutgoing.values()])contentResize?.unobserve(entry.node);rendered.clear();renderedOutgoing.clear();summaries.clear();list.replaceChildren(older,working);older.hidden=true;historyStatus.hidden=true;latest.hidden=refresh.hidden=true;
      chat=target?.chatId?{id:target.chatId,agent:target.agent,title:target.title}:null;
      // The temporary Creating tab identity becomes a pane before it gets a chat.
      // Keep its follow-ups, draft and attachments through both transitions.
      if(target?.launch){const previous=launchKeys.get(target.launch);if(previous&&JSON.parse(previous)[1]==null)moveStartup(previous,identity(target));launchKeys.set(target.launch,identity(target));}
      // A first message sent before the pane had a chat moves to the chat it started.
      if(chat)moveStartup(JSON.stringify([target.key,null]),identity(target));
      if(target&&chat&&handoverDrafts.has(target.key)){drafts.set(identity(target),handoverDrafts.get(target.key));handoverDrafts.delete(target.key);}
      if(target&&chat&&handoverAttachments.has(target.key)){attachments.set(identity(target),[...fileList(),...handoverAttachments.get(target.key)]);handoverAttachments.delete(target.key);}
      const cached=conversations.get(identity(target));if(cached){({chat,messages,startCursor,tailCursor,nextCursor,streamSupported}=cached);loaded=true;}
      if(shown){shown.generation=generation;shown.cached=loaded;shown.remote=target?.chatHost!=='local';shown.host=target?.chatHost||target?.host;}
      updateActivity();actions.hidden=true;
      if(!target){setPanelHidden(true);viewport();return;}draft.value=drafts.get(identity(target))||'';
      setPanelHidden(!open);paintFiles();viewport();
      status(chat?'Loading conversation…':unboundNotice(),loaded);
      if(cached){if(open){paint();list.scrollTop=cached.follow?list.scrollHeight:cached.position;updateLatest();}else restorePosition=cached;}else if((outgoing.get(identity(target))||[]).length&&open)paint();if(open)focusSurface(true);if(chat){load(loaded?'poll':'initial');startStream();}prepare();flushStartup();
    }
    function moveStartup(from,to){
      if(from===to)return;
      for(const map of [outgoing,pendingSends,drafts,draftVersions,consumedTranscript,attachments])if(map.has(from)&&!map.has(to)){map.set(to,map.get(from));map.delete(from);}
      for(const item of outgoing.get(to)||[])item.key=to;
      if(queuedSubmit===from)queuedSubmit=to;
    }
    // Open at the latest messages; older history is fetched only on request.
    setInterval(()=>{if(open&&!document.hidden){if(!chat){status(unboundNotice());updateActivity();}prepare();void loadPrompt();if(!streamReady)load();}},2000);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stopStream();else if(open){load();startStream();}});
    window.addEventListener('focus',()=>{if(open&&!document.hidden)load();});
    window.addEventListener('pagehide',()=>{stopStream();loadRequest?.abort();});
    window.SwitchboardConversation.hasUnsentWork=()=>!!pendingSends.size||[...outgoing.values()].some(items=>items.length)||!!draft.value||[...drafts.values()].some(Boolean)||[...attachments.values()].some(files=>files.length)||[...asyncQuestions.values()].some(state=>['sending','queued','uncertain'].includes(state.status)||state.status==='draft'&&state.answers.some(Boolean));
    const handoverKey=source=>JSON.stringify([JSON.stringify([source.host,source.target.session,source.target.pane_id]),source.chatId]);
    // A switch waits for sends still on their way and for uploads; failed ones do not hold it.
    window.SwitchboardConversation.canHandover=source=>{const key=handoverKey(source);return !pendingFor(key)&&!(outgoing.get(key)||[]).some(item=>!['failed','uncertain'].includes(item.state))&&!fileList(key).some(item=>!item.path&&!item.error);};
    // A queued switch on a tab not on screen learns from its chat's latest page that its sends landed.
    window.SwitchboardConversation.acknowledgeSends=async source=>{
      // Pages forward from just before the oldest unconfirmed send; the agent may have written much since.
      const key=handoverKey(source);let cursor=Math.max(0,Math.min(...(outgoing.get(key)||[]).map(sent=>sent.baseline))-49);
      for(let pages=0;(outgoing.get(key)||[]).length&&Number.isFinite(cursor)&&pages<100;pages++){
        try{const response=await fetch('/api/chats/'+encodeURIComponent(source.chatId)+'?'+new URLSearchParams({host:source.chatHost,limit:50,cursor}),{signal:AbortSignal.timeout(15000)});if(!response.ok)break;const data=await response.json();if(!Array.isArray(data.messages))break;acknowledge(key,data.messages,data.start_cursor??cursor);cursor=data.next_cursor??NaN;}catch{break;}
      }
      if(identity(target)===key&&loaded)paint();
    };
    window.SwitchboardConversation.handoverFiles=source=>fileList(handoverKey(source)).filter(item=>item.path).map(item=>item.path);
    // A queued switch takes the draft it was given; cancelling or failing puts it back.
    window.SwitchboardConversation.handoverQueued=(source,text)=>{const key=handoverKey(source);if((identity(target)===key?draft.value:drafts.get(key)||'')!==text)return;if(identity(target)===key){draft.value='';sizeDraft();}drafts.delete(key);};
    window.SwitchboardConversation.handoverCancelled=(source,text)=>{const key=handoverKey(source),current=identity(target)===key?draft.value:drafts.get(key)||'';if(!text||current.includes(text))return;const value=current?current+'\n\n'+text:text;drafts.set(key,value);if(identity(target)===key){draft.value=value;sizeDraft();}};
    window.SwitchboardConversation.handoverDraft=source=>identity(target)===handoverKey(source)?draft.value:drafts.get(handoverKey(source))||'';
    window.SwitchboardConversation.handoverSent=(source,text,pane,carried=[])=>{
      const key=handoverKey(source),original=identity(target)===key?draft.value:drafts.get(key)||'',next=JSON.stringify([source.host,source.target.session,pane]);
      // Files that went with the instructions leave the composer; any others follow it to the new agent.
      const rest=fileList(key).filter(item=>!carried.includes(item.path));for(const item of fileList(key))if(!rest.includes(item)&&item.preview)URL.revokeObjectURL(item.preview);
      attachments.delete(key);if(rest.length)handoverAttachments.set(next,rest);if(identity(target)===key)paintFiles();
      if(identity(target)===key)draft.value='';drafts.delete(key);
      if(original&&original!==text){if(target?.key===next&&!draft.value){draft.value=original;drafts.set(identity(target),original);}else handoverDrafts.set(next,original);}
    };
    // Hovering a tab reads the page its click will ask for, so the owning relay has indexed
    // the transcript and cached that page before the selection arrives.
    const warmed=new Map();
    window.SwitchboardConversation.warm=tab=>{
      const item=selection(tab);if(!open||!item?.chatId||identity(item)===identity(target)||conversations.has(identity(item)))return;
      const key=identity(item),now=Date.now();if(now-(warmed.get(key)||0)<60000)return;
      warmed.delete(key);warmed.set(key,now);if(warmed.size>64)warmed.delete(warmed.keys().next().value);
      void fetch('/api/chats/'+encodeURIComponent(item.chatId)+'?'+new URLSearchParams({host:item.chatHost||item.host,context:'true',limit:firstPage,tail:true})).catch(()=>{});
    };
    window.SwitchboardConversation.wantsConversation=()=>open;window.SwitchboardConversation.update=update;window.SwitchboardConversation.isOpen=()=>open&&!panel.hidden;window.SwitchboardConversation.focus=focusSurface;window.SwitchboardConversation.showTerminal=()=>show(false);window.SwitchboardConversation.interrupt=()=>{if(!stop.offsetParent||stop.disabled||target?.state==='waiting')return false;stop.click();return true;};update();
  }};
})();
