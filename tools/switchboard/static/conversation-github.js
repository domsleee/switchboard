// Repository references and GitHub previews. All remote content stays text.
(() => {
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const repos=new Map();let panel,content,external,heading,controller,focusBefore,serial=0;
  async function request(host,body,signal){
    const response=await fetch(`/api/hosts/${encodeURIComponent(host)}/conversation/github`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal||AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('GitHub details unavailable. Check repository access and gh login on the conversation’s computer.');
    return response.json();
  }
  function parse(href){
    try{const url=new URL(href);if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password)return null;
      const match=/^\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
      if(match&&Number(match[3])<=2147483647)return {repo:match[1],number:Number(match[3]),kind:match[2],url:url.href};
    }catch{}return null;
  }
  function close(restore=true){
    serial++;controller?.abort();if(!panel)return;panel.hidden=true;
    document.getElementById('terminals')?.classList.remove('github-open');
    if(restore){
      const source=focusBefore?.isConnected&&focusBefore.getClientRects().length?focusBefore:document.querySelector('.conversation-panel:not([hidden]) .conversation-compose textarea');
      source?.focus({preventScroll:true});
    }
  }
  function build(){
    panel=node('aside',undefined,'conversation-github-panel');panel.hidden=true;panel.tabIndex=-1;panel.setAttribute('aria-label','GitHub preview');
    const bar=node('header'),label=node('strong','GitHub'),dismiss=node('button','×');dismiss.type='button';dismiss.setAttribute('aria-label','Close GitHub preview');dismiss.title='Close · Esc';dismiss.onclick=()=>close();
    external=node('a','Open on GitHub ↗');external.target='_blank';external.rel='noopener noreferrer';bar.append(label,external,dismiss);
    heading=node('h2');content=node('div',undefined,'conversation-github-content');content.setAttribute('aria-live','polite');panel.append(bar,heading,content);
    (document.getElementById('terminals')||document.body).append(panel);
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();close();}});
  }
  async function open(reference,host,source){
    if(!panel)build();controller?.abort();controller=new AbortController();const version=++serial;
    focusBefore=source;external.href=reference.url;heading.textContent=`${reference.repo} #${reference.number}`;
    content.replaceChildren(node('p','Loading GitHub…','github-muted'));panel.hidden=false;
    document.getElementById('terminals')?.classList.add('github-open');panel.focus({preventScroll:true});
    try{
      const item=await request(host,{repo:reference.repo,number:reference.number},AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]));
      if(version!==serial)return;
      heading.textContent=item.title;
      const pr=item.__typename==='PullRequest',state=node('span',item.isDraft?'DRAFT':item.state,'github-state');state.dataset.state=item.state;
      const summary=node('p',undefined,'github-summary');summary.append(state,node('span',`${reference.repo} #${reference.number} · ${item.author?.login||'Unknown author'}`));
      content.replaceChildren(summary);
      if(pr){
        content.append(node('p',`${item.headRefName} → ${item.baseRefName}`,'github-branches'));
        const stats=node('p',undefined,'github-stats');stats.append(node('span',`+${item.additions}`,'github-additions'),node('span',`−${item.deletions}`,'github-deletions'),node('span',`${item.changedFiles} files changed`));content.append(stats);
        const status=[item.reviewDecision,item.mergeStateStatus].filter(Boolean).map(value=>value.replaceAll('_',' ').toLowerCase()).join(' · ');
        if(status)content.append(node('p',status,'github-muted'));
      }
      const description=node('div',undefined,'github-description conversation-message');
      if(item.markdown?.length&&window.SwitchboardConversationMedia)window.SwitchboardConversationMedia.render(description,{markdown:item.markdown},{host,repo:reference.repo});
      else description.textContent=item.body||'No description provided.';
      content.append(description);
    }catch(error){
      if(version!==serial)return;
      const retry=node('button','Retry');retry.type='button';retry.onclick=()=>open(reference,host,source);
      content.replaceChildren(node('p',error.message,'github-muted'),retry);
    }
  }
  function wire(link,context){
    const ref=parse(link.href);if(!ref||link.dataset.githubPreview)return;
    // Issue links remain ordinary GitHub links unless they were inferred from #number.
    if(ref.kind!=='pull'&&!link.dataset.githubReference)return;
    link.dataset.githubPreview='true';link.title='Preview '+ref.repo+' #'+ref.number;
    link.addEventListener('click',event=>{
      if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
      event.preventDefault();open(ref,context.host,link);
    });
  }
  function references(parent,context,repo){
    parent.normalize();const walker=document.createTreeWalker(parent,NodeFilter.SHOW_TEXT),texts=[];
    while(walker.nextNode())if(!walker.currentNode.parentElement.closest('a,pre,code,button,.conversation-media'))texts.push(walker.currentNode);
    for(const text of texts){
      const fragment=document.createDocumentFragment();let last=0;
      for(const match of text.data.matchAll(/(?<![\w/#])(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d*)\b/g)){
        const target=match[1]||repo;if(!target||Number(match[2])>2147483647)continue;
        fragment.append(text.data.slice(last,match.index));const link=node('a',match[0]);link.href=`https://github.com/${target}/issues/${match[2]}`;link.target='_blank';link.rel='noopener noreferrer';link.dataset.githubReference='true';wire(link,context);fragment.append(link);last=match.index+match[0].length;
      }
      if(last){fragment.append(text.data.slice(last));text.replaceWith(fragment);}
    }
  }
  function decorate(parent,context){
    window.SwitchboardConversationMedia?.linkify(parent,context);
    for(const link of parent.querySelectorAll('a[href]'))wire(link,context);
    // Fully qualified references work even outside a checkout.
    references(parent,context,context.repo||null);
    if(!context.project||!/#\d/.test(parent.textContent))return;
    const key=JSON.stringify([context.host,context.project]);let entry=repos.get(key);
    if(!entry||Date.now()-entry.at>60000){entry={at:Date.now(),promise:request(context.host,{cwd:context.project}).then(result=>result.repo,()=>null)};repos.set(key,entry);}
    entry.promise.then(repo=>{if(repo)references(parent,context,repo);});
  }
  window.SwitchboardConversationGithub={decorate,close,parse,isOpen:()=>!!panel&&!panel.hidden};
})();
