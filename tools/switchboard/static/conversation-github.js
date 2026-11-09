// Repository references and GitHub previews. All remote content stays text.
(() => {
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const repos=new Map(),previews=new Map();let panel,content,external,heading,crumbs,focusBefore,serial=0,prefetching=0;
  const PREVIEW_TTL=30000,PREVIEW_LIMIT=32;
  // Fixed icon paths, never content returned by GitHub.
  const paths={pr:'M6 8v8M18 16V7a4 4 0 0 0-4-4h-1M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0M8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    branch:'M6 3v12m0-12a2 2 0 1 0 0 .01M6 15a2 2 0 1 0 0 .01M18 3a2 2 0 1 0 0 .01M18 5v2a5 5 0 0 1-5 5H6',
    arrow:'M17 12H7m4-4-4 4 4 4',file:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    check:'m5 12 4 4L19 6',review:'M9 12h6m-6-4h6m-6 8h3M8 3H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2M9 2h6v4H9z',
    merge:'M6 3v12m0-12a2 2 0 1 0 0 .01M6 15a2 2 0 1 0 0 .01M18 15a2 2 0 1 0 0 .01M6 7c0 5 12 0 12 8',
    close:'m6 6 12 12M18 6 6 18',external:'M15 3h6v6m0-6L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5',
    issue:'M12 8v5m0 3v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'};
  function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');path.setAttribute('d',paths[name]);svg.append(path);return svg;}
  const words=value=>value?value.toLowerCase().replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase()):'Not reported';
  async function request(host,body,signal){
    const response=await fetch(`/api/hosts/${encodeURIComponent(host)}/conversation/github`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal||AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('GitHub details unavailable. Check repository access and gh login on the conversation’s computer.');
    return response.json();
  }
  // Hover, focus and click share one read. Only successful reads get a freshness
  // window, and the bounded cache lives in memory, never in browser storage.
  function preview(reference,host,speculative=false){
    const key=JSON.stringify([host,reference.repo.toLowerCase(),reference.number]);
    let entry=previews.get(key);
    if(entry&&(entry.pending||Date.now()-entry.at<PREVIEW_TTL))return entry.promise;
    if(speculative&&prefetching>=2)return;
    previews.delete(key);
    while(previews.size>=PREVIEW_LIMIT)previews.delete(previews.keys().next().value);
    entry={pending:true,at:0};
    if(speculative)prefetching++;
    entry.promise=request(host,{repo:reference.repo,number:reference.number}).then(item=>{
      entry.pending=false;entry.at=Date.now();return item;
    },error=>{if(previews.get(key)===entry)previews.delete(key);throw error;}).finally(()=>{if(speculative)prefetching--;});
    previews.set(key,entry);return entry.promise;
  }
  function parse(href){
    try{const url=new URL(href);if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password)return null;
      const match=/^\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
      if(match&&Number(match[3])<=2147483647)return {repo:match[1],number:Number(match[3]),kind:match[2],url:url.href};
    }catch{}return null;
  }
  function close(restore=true){
    serial++;if(!panel)return;panel.hidden=true;
    document.getElementById('terminals')?.classList.remove('github-open');
    if(restore){
      const source=focusBefore?.isConnected&&focusBefore.getClientRects().length?focusBefore:document.querySelector('.conversation-panel:not([hidden]) .conversation-compose textarea');
      source?.focus({preventScroll:true});
    }
  }
  function build(){
    panel=node('aside',undefined,'conversation-github-panel');panel.hidden=true;panel.tabIndex=-1;panel.setAttribute('aria-label','GitHub preview');
    const bar=node('header',undefined,'github-toolbar'),dismiss=node('button');dismiss.type='button';dismiss.className='github-icon-button';dismiss.append(icon('close'));dismiss.setAttribute('aria-label','Close GitHub preview');dismiss.title='Close · Esc';dismiss.onclick=()=>close();
    crumbs=node('div',undefined,'github-crumbs');
    external=node('a');external.append(icon('external'));external.className='github-icon-button';external.setAttribute('aria-label','Open on GitHub');external.title='Open on GitHub';external.target='_blank';external.rel='noopener noreferrer';bar.append(crumbs,external,dismiss);
    heading=node('h2',undefined,'github-title');content=node('div',undefined,'conversation-github-content');content.setAttribute('aria-live','polite');panel.append(bar,content);
    (document.getElementById('terminals')||document.body).append(panel);
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.isComposing){event.preventDefault();event.stopPropagation();close();}});
  }
  async function open(reference,host,source){
    if(!panel)build();const version=++serial;
    focusBefore=source;external.href=reference.url;crumbs.replaceChildren(icon(reference.kind==='pull'?'pr':'issue'),node('span',reference.repo,'github-repository'),node('span','/','github-crumb-divider'),node('span','#'+reference.number,'github-number'));heading.textContent='';
    const loading=node('div',undefined,'github-loading');loading.setAttribute('role','status');loading.append(node('span','Loading GitHub…','github-muted'));for(let i=0;i<4;i++)loading.append(node('div',undefined,'github-skeleton'));content.replaceChildren(loading);panel.hidden=false;
    document.getElementById('terminals')?.classList.add('github-open');panel.focus({preventScroll:true});
    try{
      const item=await preview(reference,host);
      if(version!==serial)return;
      heading.textContent=item.title;
      const pr=item.__typename==='PullRequest',state=node('span',item.isDraft?'Draft':words(item.state),'github-state');state.dataset.state=item.isDraft?'DRAFT':item.state;state.prepend(icon(pr?'pr':'issue'));
      crumbs.firstChild.replaceWith(icon(pr?'pr':'issue'));
      const hero=node('section',undefined,'github-hero'),identity=node('div',undefined,'github-identity');identity.append(state,node('span',pr?'Pull request':'Issue','github-muted'));hero.append(identity,heading);
      const author=item.author?.login||'Unknown author',byline=node('div',undefined,'github-byline'),avatar=node('span',author.slice(0,2).toUpperCase(),'github-avatar');avatar.setAttribute('aria-hidden','true');
      byline.append(avatar,node('span',author,'github-author'),node('span',pr?'opened this pull request':'opened this issue','github-muted'));hero.append(byline);
      content.replaceChildren(hero);
      if(pr){
        const change=node('div',undefined,'github-change'),branches=node('div',undefined,'github-branches');
        branches.append(icon('branch'),node('code',item.baseRefName),icon('arrow'),node('code',item.headRefName));branches.title=`${item.headRefName} → ${item.baseRefName}`;branches.setAttribute('aria-label',branches.title);
        const stats=node('div',undefined,'github-stats'),files=node('span',`${item.changedFiles} ${item.changedFiles===1?'file':'files'} changed`,'github-files');files.prepend(icon('file'));
        stats.append(files,node('span',`+${item.additions}`,'github-additions'),node('span',`−${item.deletions}`,'github-deletions'));
        const breakdown=node('span',undefined,'github-diffstat'),total=item.additions+item.deletions;
        for(let i=0;i<5;i++)breakdown.append(node('i',undefined,total?(i<Math.round(item.additions/total*5)?'added':'removed'):''));breakdown.setAttribute('aria-hidden','true');stats.append(breakdown);change.append(branches,stats);hero.append(change);
      }
      const overview=node('div',undefined,'github-overview-heading');overview.append(icon('review'),node('span','Overview'));content.append(overview);
      const description=node('section',undefined,'github-description');description.setAttribute('aria-label','Description');description.append(node('h3','Description','github-section-title'));
      const body=node('div',undefined,'github-body conversation-message');
      if(item.markdown?.length&&window.SwitchboardConversationMedia)window.SwitchboardConversationMedia.render(body,{markdown:item.markdown},{host,repo:reference.repo});
      else{body.textContent=item.body||'No description provided.';body.classList.add('github-plain');}
      description.append(body);content.append(description);
      if(pr){
        const details=node('section',undefined,'github-details');details.setAttribute('aria-label','Review and merge status');details.append(node('h3','Details','github-section-title'));
        const rows=node('dl');
        for(const [kind,label,value,text] of [
          ['review','Review',item.reviewDecision,{APPROVED:'Approved',CHANGES_REQUESTED:'Changes requested',REVIEW_REQUIRED:'Review required'}[item.reviewDecision]],
          ['merge','Merge',item.mergeStateStatus,{CLEAN:'No conflicts',DIRTY:'Conflicts to resolve',BLOCKED:'Blocked',BEHIND:'Branch out of date',UNSTABLE:'Checks need attention',DRAFT:'Draft'}[item.mergeStateStatus]]
        ]){
          const term=node('dt',label),detail=node('dd',undefined,'github-detail-value');term.prepend(icon(kind));detail.dataset.status=value||'UNKNOWN';if(value==='APPROVED'||value==='CLEAN')detail.append(icon('check'));detail.append(text||words(value));rows.append(term,detail);
        }
        details.append(rows);content.append(details);
      }
    }catch(error){
      if(version!==serial)return;
      const retry=node('button','Retry');retry.type='button';retry.onclick=()=>open(reference,host,source);
      const failed=node('div',undefined,'github-error');failed.append(icon('issue'),node('h3','Couldn’t load this reference'),node('p',error.message,'github-muted'),retry);content.replaceChildren(failed);
    }
  }
  function wire(link,context){
    const ref=parse(link.href);if(!ref||link.dataset.githubPreview)return;
    // Issue links remain ordinary GitHub links unless they were inferred from #number.
    if(ref.kind!=='pull'&&!link.dataset.githubReference)return;
    link.dataset.githubPreview='true';link.title='Preview '+ref.repo+' #'+ref.number;
    // Match T3's intent delay: passing across links does no work. Do not abort
    // an already started read on leave/close: a click or another link shares it.
    let timer;
    const cancel=()=>{clearTimeout(timer);timer=undefined;};
    const warm=()=>{cancel();timer=setTimeout(()=>{if(link.isConnected)preview(ref,context.host,true)?.catch(()=>{});},150);};
    link.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch')warm();});
    link.addEventListener('pointerleave',cancel);
    link.addEventListener('focus',warm);
    link.addEventListener('blur',cancel);
    link.addEventListener('click',event=>{
      if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
      cancel();event.preventDefault();open(ref,context.host,link);
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
