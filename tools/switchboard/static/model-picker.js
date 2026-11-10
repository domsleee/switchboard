// New tab's shared picker, after T3 Code's: favourites and agents in a rail, models on the left and their
// effort docked on the right. A choice is `claude:<model>` or `codex:<model>`, plus `#<effort>` when an
// effort is chosen; no effort leaves the agent's own setting in charge.
(() => {
  const CLAUDE_MODELS=[['claude-fable-5-2','Fable 5.2'],['claude-opus-5-5','Opus 5.5'],['claude-sonnet-5-5','Sonnet 5.5'],['claude-haiku-5-5','Haiku 5.5']];
  const CLAUDE_OLDER=[['claude-fable-5-1','Fable 5.1'],['claude-fable-5','Fable 5'],['claude-opus-5','Opus 5'],['claude-sonnet-5','Sonnet 5'],['claude-opus-4-8','Opus 4.8'],['claude-opus-4-7','Opus 4.7'],['claude-opus-4-6','Opus 4.6'],['claude-sonnet-4-6','Sonnet 4.6'],['claude-haiku-4-5','Haiku 4.5']];
  const CLAUDE_EFFORTS=[['low','Quickest replies, light reasoning'],['medium','Balanced speed and depth'],['high','Deeper reasoning for complex work'],['xhigh','More reasoning for hard problems'],['max','Deepest reasoning, slowest replies']];
  // An older relay lists Codex models without their levels; these are the ones every current model takes.
  const CODEX_FALLBACK_EFFORTS=[['low',''],['medium',''],['high',''],['xhigh','']];
  const EFFORT_NAMES={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max',ultra:'Ultra'};
  // One scale for every model: bars filled per level, so the same word always looks the same.
  const EFFORT_BARS={none:0,minimal:0,low:1,medium:2,high:3,xhigh:4,max:5,ultra:5};
  const PROVIDERS={claude:'Claude Code',codex:'Codex'};
  const VIEWS={favorites:'Favourites',codex:'Codex',claude:'Claude Code'};
  const FAVORITES_KEY='switchboard-model-favorites';
  const STAR='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2 2.5 5 5.5.8-4 3.9.9 5.5L10 14.6l-4.9 2.6.9-5.5-4-3.9L7.5 7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  function favoriteKeys(values){return [...new Set((Array.isArray(values)?values:[]).map(parse).filter(Boolean).map(({provider,model})=>format({provider,model})))];}
  function readFavorites(){try{return favoriteKeys(JSON.parse(localStorage.getItem(FAVORITES_KEY)||'[]'));}catch{return [];}}
  // The owner's shell shortcuts, as the model and effort each one runs.
  const ALIASES={csol:'codex:gpt-6.1-sol#high',castra:'codex:gpt-6-astra#medium',c:'claude:claude-opus-5-5'};
  const DEFAULT='codex:gpt-6.1-sol#high';
  const NAME=/^[A-Za-z0-9][A-Za-z0-9._\-[\]/:@]{0,99}$/;

  function parse(value){
    value=ALIASES[value]??String(value||'');
    const match=/^(claude|codex):([^#]+)(?:#([a-z]+))?$/.exec(value);
    if(!match||!NAME.test(match[2]))return null;
    return {provider:match[1],model:match[2],effort:match[3]||''};
  }
  const format=({provider,model,effort})=>provider+':'+model+(effort?'#'+effort:'');
  const normalize=value=>{const parts=parse(value);return parts?format(parts):DEFAULT;};
  // No effort leaves it to the agent's own setting.
  const effortName=effort=>effort?EFFORT_NAMES[effort]||effort.replace(/^\w/,c=>c.toUpperCase()):'Agent setting';
  // "GPT-6.1-Sol" reads as "GPT-6.1 Sol".
  const codexName=name=>String(name).replace(/^(GPT-[\d.]+)-(?=[A-Za-z])/i,'$1 ');
  const listedCodex=(parts,codex)=>Array.isArray(codex)&&codex.find(item=>item.id===parts.model);
  function modelName(parts,codex,claude){
    if(!parts)return '';
    if(parts.provider==='claude')return (Array.isArray(claude)?claude.find(item=>item.id===parts.model)?.name:null)||[...CLAUDE_MODELS,...CLAUDE_OLDER].find(([id])=>id===parts.model)?.[1]||parts.model;
    const listed=listedCodex(parts,codex);
    return listed?codexName(listed.name):/^gpt-[\d.]+-[a-z]+$/i.test(parts.model)?codexName(parts.model.replace(/^gpt/i,'GPT').replace(/-([a-z])([a-z]*)$/,(_,a,b)=>'-'+a.toUpperCase()+b)):parts.model;
  }
  // The levels a model accepts, as [id, description]. Agents report their own per model; a model that
  // reports none offers only the agent setting, and an older relay that reports nothing gets the common levels.
  function efforts(parts,codex,claude){
    if(!parts)return [];
    const listed=parts.provider==='claude'?Array.isArray(claude)&&claude.find(item=>item.id===parts.model):listedCodex(parts,codex);
    return listed&&Array.isArray(listed.efforts)?listed.efforts.map(item=>[item.id,item.description||'']):parts.provider==='claude'?CLAUDE_EFFORTS:CODEX_FALLBACK_EFFORTS;
  }
  // Levels are known once Claude is chosen or this computer's Codex has answered.
  const effortsKnown=(parts,codex)=>parts?.provider==='claude'||Array.isArray(codex);
  // A choice this computer can run as asked: its effort is one the model offers, when that is known.
  const runnable=(parts,codex,claude)=>!!parts&&(!parts.effort||!effortsKnown(parts,codex)||efforts(parts,codex,claude).some(([id])=>id===parts.effort));
  // The choice with an effort the model does not offer replaced by the agent setting.
  function fit(value,codex,claude){const parts=parse(value);return parts&&!runnable(parts,codex,claude)?format({...parts,effort:''}):value;}
  function describe(value,codex,claude){
    const parts=parse(value)||parse(DEFAULT);
    return {...parts,name:modelName(parts,codex,claude),effortName:effortName(parts.effort),providerName:PROVIDERS[parts.provider]};
  }

  const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const SVG='http://www.w3.org/2000/svg';
  // Five rising bars on whole pixels, 2px apart, filled up to the level. Ultra adds a spark: it also delegates.
  function glyph(effort){
    const svg=document.createElementNS(SVG,'svg'),ultra=effort==='ultra',width=ultra?24:18,filled=EFFORT_BARS[effort]??3;
    svg.setAttribute('viewBox',`0 0 ${width} 12`);svg.setAttribute('width',width);svg.setAttribute('height',12);svg.setAttribute('aria-hidden','true');svg.classList.add('model-picker-bars');
    for(let bar=0;bar<5;bar++){
      const rect=document.createElementNS(SVG,'rect'),height=4+bar*2;
      rect.setAttribute('x',bar*4);rect.setAttribute('y',12-height);rect.setAttribute('width',2);rect.setAttribute('height',height);
      if(bar>=filled)rect.setAttribute('class','off');svg.append(rect);
    }
    if(ultra){const spark=document.createElementNS(SVG,'path');spark.setAttribute('d','M21.5 0.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z');svg.append(spark);}
    return svg;
  }
  // The typed words, marked inside a name.
  function marked(name,words){
    const node=el('span','model-picker-name');
    const word=words.find(word=>word&&name.toLowerCase().includes(word));
    if(!word){node.textContent=name;return node;}
    const at=name.toLowerCase().indexOf(word);
    node.append(name.slice(0,at),el('mark',undefined,name.slice(at,at+word.length)),name.slice(at+word.length));
    return node;
  }

  // chip: the button that names the choice. menu: an empty element the picker fills.
  // value()/set(value): the chosen model and effort. codex(): this computer's Codex models, undefined while
  // loading or 'failed'. reload(): asks for them again. recent(): earlier choices, newest first.
  // claude(): this computer's Claude models, or undefined to use the older-relay fallback.
  // done(): the picker closed; focus returns to the prompt. warning(): why a remembered effort was dropped.
  function create({chip,menu,value,set,codex=()=>undefined,claude=()=>undefined,reload=()=>{},recent=()=>[],done=()=>{},warning=()=>'',icons={},compact=()=>matchMedia('(max-width:700px),(pointer:coarse)').matches}){
    const base=menu.id.replace(/-menu$/,''),scrim=menu.closest('dialog')||document.body;
    const home=menu.parentNode;let embedded=false;
    const icon=provider=>{const node=el('span','model-picker-icon');node.setAttribute('aria-hidden','true');if(icons[provider])node.innerHTML=icons[provider];return node;};
    const head=el('div','model-picker-head'),searchBox=el('div','model-picker-search'),search=el('input');
    search.id=base+'-search';search.type='text';search.placeholder='Search all models';search.autocomplete='off';search.spellcheck=false;
    search.setAttribute('aria-label','Search all models, or type any model name');search.setAttribute('role','combobox');search.setAttribute('aria-autocomplete','list');search.setAttribute('aria-expanded','true');
    const list=el('div','model-picker-list');list.id=base+'-options';list.setAttribute('role','listbox');search.setAttribute('aria-controls',list.id);
    searchBox.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';searchBox.append(search);
    // A shared favourites view and one view per agent, like T3 Code's icon rail.
    const tabs=el('div','model-picker-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Model views');tabs.setAttribute('aria-orientation',compact()?'horizontal':'vertical');
    const tabButtons={};
    for(const provider of Object.keys(VIEWS)){
      const button=el('button','model-picker-tab');button.type='button';button.setAttribute('role','tab');button.id=base+'-tab-'+provider;button.setAttribute('aria-controls',list.id);
      const mark=icon(provider);if(provider==='favorites')mark.innerHTML=STAR;
      button.append(mark,el('span','model-picker-tab-label',VIEWS[provider]));button.title=VIEWS[provider];
      button.onmousedown=event=>{if(!compact())event.preventDefault();};
      button.onclick=()=>{showTab(provider);if(!compact())search.focus();};
      tabButtons[provider]=button;tabs.append(button);
    }
    const sheetTitle=el('h3','model-picker-title','Model and effort'),cancelButton=el('button','model-picker-cancel','Cancel'),sheetDone=el('button','model-picker-done','Done');
    sheetTitle.id=base+'-sheet-title';sheetTitle.tabIndex=-1;cancelButton.type=sheetDone.type='button';
    head.append(cancelButton,sheetTitle,sheetDone,searchBox);
    const effortHead=el('div','model-picker-effort-head'),effortTitle=el('span',undefined,'Effort'),effortModel=el('span','model-picker-effort-model');
    effortTitle.id=base+'-effort-label';effortModel.id=base+'-effort-model';effortHead.append(effortTitle,effortModel);
    const effortList=el('div','model-picker-efforts');effortList.setAttribute('role','radiogroup');effortList.setAttribute('aria-labelledby',effortTitle.id+' '+effortModel.id);
    // Shown in place of the levels when the chosen model is not among the rows on screen.
    const effortAway=el('p','model-picker-effort-away');
    // A warning about an effort a model lacks, then the description that follows hover and focus.
    const effortWarning=el('p','model-picker-effort-warning');effortWarning.id=base+'-effort-warning';effortWarning.setAttribute('role','status');
    const effortNote=el('p','model-picker-effort-note');effortNote.setAttribute('aria-hidden','true');
    const left=el('div','model-picker-models'),right=el('div','model-picker-effort'),effortScroll=el('div','model-picker-effort-scroll'),effortFoot=el('div','model-picker-effort-foot');
    left.append(list);effortScroll.append(effortList,effortAway);effortFoot.append(effortWarning,effortNote);right.append(effortHead,effortScroll,effortFoot);
    const body=el('div','model-picker-body');body.append(left,right);
    const content=el('div','model-picker-content'),main=el('div','model-picker-main');content.append(head,body);main.append(tabs,content);
    const foot=el('div','model-picker-foot'),hints=el('span','model-picker-hints'),footDone=el('button','model-picker-foot-done');footDone.type='button';
    footDone.innerHTML='Done <kbd>Enter</kbd>';foot.append(hints,footDone);
    const favoriteStatus=el('p','sr-only');favoriteStatus.setAttribute('role','status');
    menu.replaceChildren(main,foot,favoriteStatus);menu.classList.add('model-picker');menu.setAttribute('role','dialog');menu.setAttribute('aria-labelledby',sheetTitle.id);
    // A press on the picker's own background keeps focus inside it, so it never reads as leaving; on a
    // desktop it leaves focus where it was, so Escape, Enter and the arrows keep working.
    menu.tabIndex=-1;
    menu.addEventListener('mousedown',event=>{if(!compact()&&!event.target.closest('input,button'))event.preventDefault();});
    // initial: the choice when the picker opened, which Cancel and Escape restore. wanted: the effort last
    // chosen, carried to each model that offers it. tab: the agent whose models show. active: the
    // highlighted row. Without a search the highlight is the choice. A search highlights its first match on
    // a desktop and previews that model's effort; Enter, Done, Right, a click or an effort chooses it.
    let tab='codex',initial=null,wanted='',painting=false,active=null;

    const query=()=>search.value.trim().toLowerCase();
    const words=()=>query().split(/\s+/).filter(Boolean);
    const sameModel=(a,b)=>!!a&&!!b&&a.provider===b.provider&&(a.id??a.model)===(b.id??b.model);
    const keyOf=parts=>parts?parts.provider+':'+parts.model:null;
    const isFavorite=item=>readFavorites().includes(item.provider+':'+(item.id??item.model));
    const supports=(parts,effort)=>!effort||efforts(parts,codex(),claude()).some(([id])=>id===effort);
    // A model with the effort last chosen, when it offers that effort.
    const withWanted=(provider,model)=>format({provider,model,effort:supports({provider,model},wanted)?wanted:''});
    // Up to three earlier pairs from either agent, other than the one the picker opened with and runnable
    // here. They are fixed while the picker is open, so choosing one never moves the rows.
    function recents(){
      const models=codex(),listed=item=>{const catalog=item.provider==='claude'?claude():models;return !Array.isArray(catalog)||catalog.some(model=>model.id===item.model);};
      return recent().map(parse).filter(item=>item&&!isFavorite(item)&&format(item)!==initial&&listed(item)&&runnable(item,models,claude()))
        .filter((item,index,all)=>all.findIndex(other=>format(other)===format(item))===index).slice(0,3)
        .map(item=>({kind:'model',key:'recent:'+format(item),group:'recent',provider:item.provider,id:item.model,name:modelName(item,models,claude()),effort:item.effort,recent:true}));
    }
    function rowsFor(provider){
      const parts=parse(value()),models=codex();
      const row=(id,name,extra={})=>({kind:'model',key:provider+':'+id,group:provider,provider,id,name,...extra});
      let rows;
      if(provider==='claude')rows=Array.isArray(claude())?claude().map(item=>row(item.id,item.name)):[...CLAUDE_MODELS.map(([id,name])=>row(id,name)),...CLAUDE_OLDER.map(([id,name])=>row(id,name,{older:true,group:'older'}))];
      else rows=Array.isArray(models)?models.map(item=>row(item.id,codexName(item.name),{isDefault:!!item.default})):[];
      // A chosen model nobody lists stays visible, so it can always be seen and kept.
      if(parts?.provider===provider&&!rows.some(item=>sameModel(item,parts)))rows.splice(provider==='claude'?CLAUDE_MODELS.length:rows.length,0,row(parts.model,modelName(parts,models,claude())));
      return rows;
    }
    function favoriteRows(){
      return readFavorites().map(key=>{const parts=parse(key),listed=rowsFor(parts.provider).find(item=>sameModel(item,parts));
        return {...(listed||{kind:'model',provider:parts.provider,id:parts.model,name:modelName(parts,codex(),claude())}),key,group:'favorites',favorite:true};});
    }
    function toggleFavorite(item){
      const key=item.provider+':'+item.id,saved=readFavorites(),had=saved.includes(key);
      try{localStorage.setItem(FAVORITES_KEY,JSON.stringify(had?saved.filter(value=>value!==key):[...saved,key]));}
      catch{favoriteStatus.textContent='Could not save favourites in this browser.';return;}
      paint(false);favoriteStatus.textContent=(had?'Removed ':'Added ')+item.name+(had?' from':' to')+' favourites.';
    }
    // Rows in display order, each with the group it sits under.
    function items(){
      const text=query();
      if(!text){
        if(tab==='favorites')return favoriteRows();
        return [...favoriteRows().filter(item=>item.provider===tab),...recents(),...rowsFor(tab).filter(item=>!isFavorite(item))];
      }
      // Every word matches the model's name or id, or starts the agent's name ("codex astra").
      const candidates=[...rowsFor('claude'),...rowsFor('codex'),...favoriteRows()];
      const matches=candidates.filter((item,index)=>candidates.findIndex(other=>sameModel(other,item))===index).map(item=>({...item,group:item.provider}))
        .filter(item=>words().every(word=>[item.id,item.name].some(field=>field.toLowerCase().includes(word))||PROVIDERS[item.provider].toLowerCase().split(' ').some(part=>part.startsWith(word))));
      // A name nobody lists can start either agent, offered only when nothing listed matches.
      const typed=search.value.trim();
      if(!matches.length&&NAME.test(typed)){
        const agents=/^(claude|opus|sonnet|haiku|fable)/i.test(typed)?['claude','codex']:['codex','claude'];
        return agents.map(provider=>({kind:'model',key:'custom:'+provider+':'+typed,group:'other',provider,id:typed,name:typed,custom:true}));
      }
      return matches.sort((a,b)=>Number(isFavorite(b))-Number(isFavorite(a)));
    }
    const committedKey=()=>keyOf(parse(value()));
    // What a row chooses: its model with the effort last chosen, or a recent row's own effort.
    const valueFor=item=>item.recent?format({provider:item.provider,model:item.id,effort:item.effort}):withWanted(item.provider,item.id);
    const highlighted=()=>items().find(item=>item.key===active);
    // During a search the effort column serves the highlighted model, which Done would choose.
    const previewing=()=>!!query()&&!!highlighted()&&valueFor(highlighted())!==value();
    const shownValue=()=>previewing()?valueFor(highlighted()):value();
    // The effort column sets the chosen model's effort only while that model is on screen.
    const chosenShown=()=>previewing()||items().some(item=>!item.recent&&!item.custom&&sameModel(item,parse(value())));
    const GROUP_TITLES={favorites:'Favourites',recent:'Recent',older:'Older models',other:'Use a model not listed'};
    function paintModels(scroll){
      const parts=parse(value()),models=codex(),text=query(),shown=items();list.replaceChildren();let group=null,groupName=null,index=0,activeId=null;
      if(!shown.some(item=>item.key===active))active=text?(compact()?null:shown[0]?.key??null):committedKey();
      tabs.hidden=false;menu.classList.toggle('favorites-view',tab==='favorites'&&!text);
      for(const [provider,button] of Object.entries(tabButtons)){
        button.setAttribute('aria-selected',String(provider===tab));button.tabIndex=provider===tab?0:-1;
        button.setAttribute('aria-label',VIEWS[provider]+(parts?.provider===provider?', current choice':''));
      }
      list.setAttribute('aria-label',text?'Matching models':VIEWS[tab]+' models');
      for(const item of shown){
        if(!group||item.group!==groupName){
          groupName=item.group;group=el('div','model-picker-group');group.setAttribute('role','group');
          const title=item.group==='favorites'&&tab==='favorites'&&!text?'':GROUP_TITLES[item.group]||(text?PROVIDERS[item.provider]:'');
          if(title){
            const heading=el('div','model-picker-group-title');heading.id=list.id+'-group-'+item.group;group.setAttribute('aria-labelledby',heading.id);
            if(text&&PROVIDERS[item.group])heading.append(icon(item.provider));
            heading.append(title);group.append(heading);
          }else group.setAttribute('aria-label',item.group==='favorites'?'Favourites':PROVIDERS[item.provider]);
          list.append(group);
        }
        const option=el('div','model-picker-option');option.id=list.id+'-'+index++;option.setAttribute('role','option');
        if(item.key===active){option.classList.add('active');activeId=option.id;}
        // The chosen model is selected in its agent's list; a recent row only repeats a pair.
        const chosen=!item.recent&&!item.custom&&sameModel(item,parts);
        option.setAttribute('aria-selected',String(chosen));option.title=item.custom?`Start ${PROVIDERS[item.provider]} with ${item.id}`:item.id;
        option.classList.add('model-picker-tagged');option.append(icon(item.provider));
        option.append(marked(item.name,words()));
        if(item.recent)option.append(el('small',undefined,effortName(item.effort)));
        else if(item.custom)option.append(el('small',undefined,'with '+PROVIDERS[item.provider]));
        else if(item.older&&text)option.append(el('small',undefined,'Older'));
        else if(item.isDefault)option.append(el('small',undefined,'Codex default'));
        if(item.custom||item.recent)option.setAttribute('aria-label',item.custom?`${item.id}, with ${PROVIDERS[item.provider]}`:`${item.name}, ${PROVIDERS[item.provider]}, ${item.effort?effortName(item.effort)+' effort':'agent setting effort'}, recent`);
        const check=el('span','model-picker-check');check.setAttribute('aria-hidden','true');option.append(check);
        option.onclick=()=>{choose(item);if(!compact())search.focus();};
        // While searching, the pointer moves the highlight, so Enter and Done take what it points at.
        option.onpointermove=event=>{if(event.pointerType==='mouse'&&query()&&active!==item.key){active=item.key;paint(false);}};
        option.onmousedown=event=>event.preventDefault();
        const row=el('div','model-picker-row'),star=el('button','model-picker-star');star.type='button';star.innerHTML=STAR;
        const saved=isFavorite(item);star.classList.toggle('saved',saved);star.title=(saved?'Remove ':'Add ')+item.name+(saved?' from':' to')+' favourites';star.setAttribute('aria-label',star.title);star.setAttribute('aria-pressed',String(saved));
        star.dataset.favoriteKey=item.provider+':'+item.id;
        star.onmousedown=event=>event.preventDefault();star.onclick=()=>{
          toggleFavorite(item);
          const destination=compact()?[...list.querySelectorAll('.model-picker-star')].find(button=>button.dataset.favoriteKey===item.provider+':'+item.id)||tabButtons[tab]:search;
          destination.focus({preventScroll:true});
        };
        row.append(option,star);group.append(row);
      }
      if(!text&&tab==='favorites'&&!shown.length){const empty=el('p','model-picker-note','No favourites yet. Star a model in Codex or Claude Code to keep it here.');list.append(empty);}
      // Whether Codex's catalog is still loading or failed shows in its tab, whatever rows it has.
      if(!text&&tab==='codex'&&!Array.isArray(models)){
        const note=el('p','model-picker-note',models==='failed'?'Codex models are unavailable on this computer. ':'Loading Codex models…');
        if(models==='failed'){
          const retry=el('button','model-picker-retry','Retry');retry.type='button';retry.onmousedown=event=>event.preventDefault();retry.onclick=()=>{reload();paint(false);tabButtons[tab].focus();};
          // Retry sits between the agent tabs and effort in the Tab order.
          retry.onkeydown=event=>{if(event.key!=='Tab'||compact())return;event.preventDefault();if(event.shiftKey)tabButtons[tab].focus();else if(!focusEffort())footDone.focus();};
          note.append(retry,' or search to type a model name.');
        }
        list.append(note);
      }
      if(text&&!shown.length)list.append(el('p','model-picker-note','Model names use letters, digits and . - _ [ ] / : @'));
      if(activeId){search.setAttribute('aria-activedescendant',activeId);if(scroll&&!menu.hidden)document.getElementById(activeId).scrollIntoView({block:'nearest'});}
      else search.removeAttribute('aria-activedescendant');
      hints.innerHTML=text?'<span><kbd>↑</kbd><kbd>↓</kbd> highlight</span><span><kbd>Esc</kbd> clear search</span>':'<span><kbd>↑</kbd><kbd>↓</kbd> model</span><span><kbd>→</kbd> effort</span><span><kbd>Esc</kbd> cancel</span>';
      fade(left);
    }
    function paintEfforts(){
      const parts=parse(shownValue()),models=codex(),levels=efforts(parts,models,claude()),focused=effortList.contains(document.activeElement),current=parts?.effort||'';
      const listed=parts&&listedCodex(parts,models),modelDefault=listed?.default_effort||'',away=!chosenShown();
      effortModel.textContent=modelName(parts,models,claude());right.classList.toggle('previewing',previewing());right.classList.toggle('away',away);
      // Browsing another agent's tab, or a phone's search, leaves the chosen model off screen: say what is chosen.
      effortList.hidden=away;effortAway.hidden=!away;
      effortAway.textContent=away?`${modelName(parts,models,claude())} at ${current?effortName(current)+' effort':'its agent setting'} is chosen. Choose a model here to set its effort.`:'';
      effortList.replaceChildren();
      const agentNote=parts?.provider==='codex'?`Uses your Codex config${modelDefault?`, else this model's default (${effortName(modelDefault)})`:''}.`:'Uses your Claude Code effort setting (/effort).';
      // The effort asked for stays wanted; a model without it uses the agent setting, and says so.
      const missing=wanted&&!supports(parts,wanted)&&effortsKnown(parts,models)?`${effortName(wanted)} isn't offered for ${modelName(parts,models,claude())}, so the agent setting is used.`:previewing()?'':warning();
      effortWarning.textContent=away?'':missing||'';
      const choices=[['',agentNote],...levels],noteFor=()=>away?'':choices.find(([id])=>id===current)?.[1]||'';
      const hover=matchMedia('(hover:hover)').matches;
      choices.forEach(([id,description],index)=>{
        const row=el('button','model-picker-level');row.type='button';row.setAttribute('role','radio');row.dataset.effort=id;
        row.setAttribute('aria-label',effortName(id));
        row.setAttribute('aria-checked',String(id===current));row.tabIndex=id===current?0:-1;
        const mark=el('span','model-picker-glyph');mark.setAttribute('aria-hidden','true');
        if(id)mark.append(glyph(id));else mark.classList.add('model-picker-auto');
        row.append(mark,el('span','model-picker-level-name',effortName(id)));
        if(id&&id===modelDefault){row.append(el('small',undefined,'default'));row.setAttribute('aria-label',`${effortName(id)}, this model's default`);}
        // Each level carries its own description for screen readers.
        if(description){row.title=description;const said=el('span','sr-only',description);said.id=base+'-effort-'+index;row.append(said);row.setAttribute('aria-describedby',said.id+(missing&&!id?' '+effortWarning.id:''));}
        const check=el('span','model-picker-check');check.setAttribute('aria-hidden','true');row.append(check);
        // Focusing, or on a desktop hovering, a level shows what it does.
        row.onfocus=()=>{effortNote.textContent=description;};row.onblur=()=>{effortNote.textContent=noteFor();};
        if(hover){row.onmouseenter=row.onfocus;row.onmouseleave=row.onblur;}
        // Keep a pointer press from changing the description and moving the touch target before its click.
        row.onmousedown=event=>event.preventDefault();
        row.onclick=()=>{setEffort(id);if(!compact())focusEffort();};
        effortList.append(row);
      });
      effortNote.textContent=noteFor();
      if(focused&&!away)focusEffort();
      // The chosen level stays in view in a short column.
      effortList.querySelector('[aria-checked=true]')?.scrollIntoView({block:'nearest'});
      fade(effortScroll);
    }
    // Rebuilding rows removes the focused one; that blur is not the user leaving.
    function paint(scroll=true){painting=true;try{paintModels(scroll);paintEfforts();}finally{painting=false;}}
    // A scrolled column fades at its bottom edge, so more rows read as more.
    function fade(node){node.classList.toggle('more',node.scrollTop+node.clientHeight<node.scrollHeight-2);}
    left.addEventListener('scroll',()=>fade(left),{passive:true});effortScroll.addEventListener('scroll',()=>fade(effortScroll),{passive:true});
    function choose(item,scroll=false){
      if(item.recent)wanted=item.effort;
      // A recent pair from the other agent opens that agent's tab, so its effort can be set.
      set(valueFor(item));tab=tab==='favorites'&&isFavorite(item)?'favorites':item.provider;active=item.recent?item.key:keyOf(parse(value()));
      if(query()&&!item.custom)search.value='';
      paint(scroll);
    }
    // An effort chooses the model it is shown for, the highlighted one during a search.
    function setEffort(effort){
      if(previewing())choose(highlighted());
      const parts=parse(value());if(!parts)return;wanted=effort;set(format({...parts,effort}));paint(false);
    }
    function showTab(provider){tab=provider;search.value='';active=committedKey();paint(false);left.scrollTop=0;fade(left);}
    function place(){
      tabs.setAttribute('aria-orientation',compact()?'horizontal':'vertical');
      if(embedded){menu.style.cssText='';body.style.height='';return;}
      if(compact()){
        // A phone's sheet sits on the visible viewport, above an on-screen keyboard.
        const view=globalThis.visualViewport,bottom=view?Math.max(0,innerHeight-view.height-view.offsetTop):0,height=view?view.height:innerHeight;
        menu.style.cssText=`bottom:${bottom}px;height:${Math.min(700,Math.round(height*.92))}px`;body.style.height='';return;
      }
      // Fixed to the window beside the chip, on the side with more room; it covers the chip only when neither side has 150px.
      const rect=chip.getBoundingClientRect(),width=Math.min(560,innerWidth-24),chrome=head.offsetHeight+foot.offsetHeight+2,want=330,floor=150;
      const above=rect.top-16,below=innerHeight-rect.bottom-16,room=Math.max(above,below)-chrome;
      let bodyHeight,top;
      if(room>=floor){bodyHeight=Math.min(want,room);top=above>=below?rect.top-8-bodyHeight-chrome:rect.bottom+8;}
      else{bodyHeight=Math.max(150,Math.min(want,innerHeight-16-chrome));top=Math.max(8,innerHeight-8-bodyHeight-chrome);}
      body.style.height=bodyHeight+'px';menu.classList.toggle('tight',bodyHeight<300);
      Object.assign(menu.style,{left:Math.max(12,Math.min(rect.right-width,innerWidth-width-12))+'px',top:top+'px',width:width+'px'});
      fade(left);fade(effortScroll);
    }
    function open(){
      if(chip.disabled||!menu.hidden)return;
      initial=value();wanted=parse(initial)?.effort||'';search.value='';tab=readFavorites().length?'favorites':parse(initial)?.provider||'codex';active=committedKey();
      menu.hidden=false;chip.setAttribute('aria-expanded','true');
      if(!embedded){scrim.classList.add('model-picker-open');menu.setAttribute('aria-modal',String(compact()));}
      paint(false);place();list.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});fade(left);
      if(embedded)return;
      if(compact())sheetTitle.focus();else search.focus();
    }
    // keep: false restores the choice from when the picker opened.
    function close(keep=true){
      if(embedded)return;
      if(menu.hidden)return;
      // Cancel restores the opening choice, minus an effort this computer has since said the model lacks.
      if(!keep&&initial!==null&&value()!==fit(initial,codex(),claude()))set(fit(initial,codex(),claude()));
      menu.hidden=true;chip.setAttribute('aria-expanded','false');scrim.classList.remove('model-picker-open');search.value='';initial=null;
    }
    function finish(keep=true){close(keep);done();}
    // Without a search, arrows choose as they move within the agent's tab; a search's arrows only highlight.
    function step(delta){
      const shown=items(),index=shown.findIndex(item=>item.key===active),next=shown[(index+delta+shown.length)%shown.length];
      if(!next)return;
      if(query()){active=next.key;paint();}else choose(next,true);
    }
    // Enter and Done take a search's highlighted model, then close.
    function commit(){if(query()&&highlighted()&&(previewing()||highlighted().custom))choose(highlighted());}
    function confirm(){commit();finish();}
    const focusEffort=()=>{if(effortList.hidden)return false;(effortList.querySelector('[aria-checked=true]')||effortList.querySelector('[role=radio]'))?.focus();return true;};
    function stepEffort(delta){
      const radios=[...effortList.querySelectorAll('[role=radio]')],index=radios.findIndex(row=>row.getAttribute('aria-checked')==='true'),next=radios[Math.max(0,Math.min(radios.length-1,index+delta))];
      if(next)setEffort(next.dataset.effort);focusEffort();
    }
    // Escape clears a search first, wherever focus is; with no search it cancels.
    function escape(){if(search.value){search.value='';active=committedKey();paint();search.focus();}else if(embedded)scrim.close();else finish(false);}
    search.addEventListener('input',()=>{active=null;paint();});
    search.addEventListener('keydown',event=>{
      if(event.altKey||event.ctrlKey||event.metaKey||event.isComposing)return;
      if(embedded&&event.key==='Tab')return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();step(event.key==='ArrowDown'?1:-1);}
      else if(event.key==='ArrowLeft'&&search.selectionStart===0&&!query()){event.preventDefault();tabButtons[tab].focus();}
      // Right moves on to effort, taking a search's highlighted model with it; Tab reaches the agent tabs first.
      else if((event.key==='ArrowRight'&&search.selectionStart===search.value.length)||(event.key==='Tab'&&!event.shiftKey&&query()&&!compact())){
        event.preventDefault();if(query()&&highlighted())choose(highlighted());if(!focusEffort()&&event.key==='Tab')footDone.focus();
      }
      else if(event.key==='Tab'&&!event.shiftKey&&!compact()){event.preventDefault();tabButtons[tab].focus();}
      else if(event.key==='Enter'){event.preventDefault();confirm();}
      else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();escape();}
    });
    tabs.addEventListener('keydown',event=>{
      if(event.altKey||event.ctrlKey||event.metaKey)return;
      if(embedded&&event.key==='Tab')return;
      if(event.key==='ArrowLeft'||event.key==='ArrowRight'||event.key==='ArrowUp'||event.key==='ArrowDown'){
        event.preventDefault();const views=Object.keys(VIEWS),direction=['ArrowLeft','ArrowUp'].includes(event.key)?-1:1;showTab(views[(views.indexOf(tab)+direction+views.length)%views.length]);tabButtons[tab].focus();
      }
      else if(event.key==='Tab'&&!compact()){event.preventDefault();if(event.shiftKey)search.focus();else if(list.querySelector('.model-picker-retry'))list.querySelector('.model-picker-retry').focus();else if(!focusEffort())footDone.focus();}
      else if(event.key==='Enter'){event.preventDefault();confirm();}
      else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();escape();}
    });
    effortList.addEventListener('keydown',event=>{
      if(event.altKey||event.ctrlKey||event.metaKey)return;
      if(embedded&&event.key==='Tab')return;
      const across=compact()&&(event.key==='ArrowRight'||event.key==='ArrowLeft');
      if(event.key==='ArrowDown'||event.key==='ArrowUp'||across){event.preventDefault();stepEffort(event.key==='ArrowDown'||event.key==='ArrowRight'?1:-1);}
      else if(event.key==='ArrowLeft'){event.preventDefault();search.focus();}
      else if(event.key==='Tab'&&!compact()){event.preventDefault();if(event.shiftKey)(list.querySelector('.model-picker-retry')||tabButtons[tab]).focus();else (list.querySelector('.model-picker-star')||footDone).focus();}
      else if(event.key==='Enter'){event.preventDefault();finish();}
      else if(event.key===' '){event.preventDefault();setEffort(event.target.dataset.effort);focusEffort();}
      else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();escape();}
    });
    footDone.addEventListener('keydown',event=>{
      if(event.key==='Tab'){event.preventDefault();if(event.shiftKey){const stars=[...list.querySelectorAll('.model-picker-star')];if(stars.length)stars.at(-1).focus();else if(!focusEffort())tabButtons[tab].focus();}else finish();}
      else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();escape();}
    });
    list.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();escape();return;}
      if(embedded||compact()||event.key!=='Tab'||!event.target.matches('.model-picker-star'))return;
      const stars=[...list.querySelectorAll('.model-picker-star')],index=stars.indexOf(event.target),next=index+(event.shiftKey?-1:1);
      event.preventDefault();event.stopPropagation();
      if(next<0){if(!focusEffort())tabButtons[tab].focus();}else (stars[next]||footDone).focus();
    });
    // A phone's sheet is modal: Tab cycles inside it, past Cancel, Done, search, the tabs and effort.
    menu.addEventListener('keydown',event=>{
      if(embedded||!compact()||event.defaultPrevented)return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();escape();return;}
      if(event.key!=='Tab')return;
      const stops=[cancelButton,sheetDone,search,tabButtons[tab],list.querySelector('.model-picker-retry'),...list.querySelectorAll('.model-picker-star'),effortList.hidden?null:effortList.querySelector('[tabindex="0"]')].filter(Boolean),index=stops.indexOf(document.activeElement);
      event.preventDefault();event.stopPropagation();stops[(index+(event.shiftKey?-1:1)+stops.length)%stops.length].focus();
    });
    sheetDone.onclick=footDone.onclick=confirm;cancelButton.onclick=()=>finish(false);
    // Focus leaving the chip and the picker keeps the choice and closes it.
    const leave=event=>{if(embedded||compact()||painting||!event.relatedTarget)return;if(event.relatedTarget!==chip&&!menu.contains(event.relatedTarget))close();};
    chip.addEventListener('blur',leave);menu.addEventListener('focusout',leave);
    // A click or a key opens it; focus alone never does, so returning to the window leaves it shut.
    chip.addEventListener('click',()=>{if(menu.hidden)open();else finish();});
    chip.addEventListener('keydown',event=>{
      if(event.altKey||event.ctrlKey||event.metaKey)return;
      if(['ArrowDown','ArrowUp'].includes(event.key)&&menu.hidden){event.preventDefault();open();}
      else if(event.key==='Escape'&&!menu.hidden){event.preventDefault();event.stopPropagation();finish(false);}
    });
    // A press outside keeps the choice and closes the picker, without acting on what was under it.
    document.addEventListener('pointerdown',event=>{
      if(embedded||menu.hidden||menu.contains(event.target)||chip.contains(event.target))return;
      event.preventDefault();event.stopPropagation();finish();
      const swallow=click=>{click.preventDefault();click.stopPropagation();};
      addEventListener('click',swallow,{capture:true,once:true});setTimeout(()=>removeEventListener('click',swallow,{capture:true}),600);
    },true);
    addEventListener('resize',()=>{if(!menu.hidden)place();});
    globalThis.visualViewport?.addEventListener('resize',()=>{if(!menu.hidden)place();});
    addEventListener('storage',event=>{if(event.key===FAVORITES_KEY&&!menu.hidden)paint(false);});
    function embed(container){
      embedded=false;close();embedded=!!container;
      (container||home).append(menu);menu.classList.toggle('model-picker-embedded',embedded);
      menu.setAttribute('role',embedded?'group':'dialog');menu.removeAttribute('aria-modal');
      if(embedded)open();else{menu.style.cssText='';body.style.height='';}
    }
    return {open,close,embed,commit,refresh(){if(!menu.hidden){paint(false);place();}},search,modal:()=>!embedded&&!menu.hidden&&compact(),isOpen:()=>!menu.hidden};
  }
  globalThis.SwitchboardModelPicker={parse,format,normalize,fit,describe,efforts,effortName,create,favoriteKeys,DEFAULT,ALIASES,CLAUDE_MODELS,CLAUDE_OLDER};
})();
