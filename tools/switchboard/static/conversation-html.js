// An agent's HTML page shown in the transcript. Transcript text and the page are untrusted, and
// this origin holds terminal access: the page is read as text and shown in a frame with its own
// opaque origin, where it runs no scripts and loads nothing. See docs/SWITCHBOARD_INLINE_HTML.md.
(() => {
  const MAX_BYTES=2*1024*1024,MAX_LIVE=3,MAX_REMEMBERED=8,DEFAULT_HEIGHT=480,MIN_HEIGHT=80,MAX_HEIGHT=900;
  const PATH=/(?:^|[\\/])\.switchboard[\\/]artifacts[\\/][^\\/]+[\\/][^\\/]+\.html?$/i;
  const POLICY="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";
  // Names agents know from T3 Code, read from this page so cards follow conversation.css.
  const THEME=[['--background','--bg'],['--foreground','--text'],['--card','--surface'],['--border','--line-2'],['--muted-foreground','--muted'],['--accent','--accent'],['--font-sans','--sans'],['--font-mono','--mono']];
  const element=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const remembered=new Map(),running=new Map(),cards=new WeakMap(),live=new Set();
  function prepare(source){
    const doc=new DOMParser().parseFromString(source,'text/html');
    // Resource hints such as dns-prefetch are outside the policy, and a template can hide one
    // in a declarative shadow root that this parser leaves unexpanded.
    for(const hint of doc.querySelectorAll('link,template'))hint.remove();
    const root=doc.body.children.length===1&&doc.body.firstElementChild.localName==='svg'?doc.body.firstElementChild:null;
    const [,,width,height]=(root?.getAttribute('viewBox')||'').trim().split(/[\s,]+/).map(Number);
    const asked=Number(doc.querySelector('meta[name="switchboard-height"]')?.getAttribute('content'));
    return {html:doc.documentElement.outerHTML,aspect:width>0&&height>0?width/height:null,height:asked>0?Math.min(MAX_HEIGHT,Math.max(MIN_HEIGHT,asked)):DEFAULT_HEIGHT};
  }
  function remember(url,page){remembered.delete(url);remembered.set(url,page);if(remembered.size>MAX_REMEMBERED)remembered.delete(remembered.keys().next().value);return page;}
  function load(url){
    if(remembered.has(url))return Promise.resolve(remember(url,remembered.get(url)));
    if(running.has(url))return running.get(url);
    const job=fetch(url).then(async response=>{
      if(!response.ok)return {error:'HTML page unavailable'};
      const tooLarge={error:'This HTML page is too large to show here'};
      if(Number(response.headers.get('content-length'))>MAX_BYTES)return tooLarge;
      const blob=await response.blob();if(blob.size>MAX_BYTES)return tooLarge;
      return remember(url,prepare(await blob.text()));
    }).catch(()=>({error:'HTML page unavailable'})).finally(()=>running.delete(url));
    running.set(url,job);return job;
  }
  function size(body,page){body.style.height=page.aspect?'':page.height+'px';body.style.aspectRatio=page.aspect?String(page.aspect):'';}
  function page_(card,page){
    const style=getComputedStyle(card),tokens=THEME.map(([name,source])=>`${name}:${style.getPropertyValue(source).trim()}`).join(';');
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${POLICY}"><style>:root{color-scheme:dark;${tokens};--destructive:#f87171;--warning:#fbbf24}html,body{margin:0;background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans)}${page.aspect?'html{overflow:hidden}body>svg{display:block;width:100%;height:auto}':''}</style>${page.html}`;
  }
  function hide(card){const state=cards.get(card);state.frame?.remove();state.frame=null;live.delete(card);}
  // The cards nearest the middle of the screen stay. False means this one is not among them yet.
  function makeRoom(incoming){
    for(const card of live)if(!card.isConnected){hide(card);nearby?.unobserve(card);visible?.unobserve(card);}
    const middle=innerHeight/2,distance=card=>{const box=card.getBoundingClientRect();return Math.abs(box.top+box.height/2-middle);};
    while(live.size>=MAX_LIVE){const far=[...live,incoming].reduce((far,card)=>distance(card)>distance(far)?card:far);if(far===incoming)return false;hide(far);}
    return true;
  }
  async function show(card){
    const state=cards.get(card),page=await load(state.url);
    if(!state.near||!card.isConnected||state.frame)return;
    if(page.error){state.body.replaceChildren(element('p',page.error,'conversation-media-unavailable'));state.body.style.height='auto';return;}
    size(state.body,page);if(!makeRoom(card))return;
    // The policy lasts only as long as the srcdoc document. An inert frame cannot be clicked or
    // focused, so no link, in any markup, can navigate it out of that document.
    const frame=element('iframe');frame.inert=true;frame.setAttribute('sandbox','');frame.title=state.label;frame.referrerPolicy='no-referrer';frame.srcdoc=page_(card,page);
    state.body.replaceChildren(frame);state.frame=frame;live.add(card);
  }
  // Long histories build a frame only as the reader nears it, and drop it once well past.
  const nearby=globalThis.IntersectionObserver?new IntersectionObserver(entries=>{
    for(const entry of entries){const state=cards.get(entry.target);state.near=entry.isIntersecting;if(state.near)show(entry.target);else hide(entry.target);}
  },{rootMargin:'800px 0px',scrollMargin:'800px 0px'}):null;
  // A card that gave way while nearby never leaves that band, so seeing it brings it back.
  const visible=globalThis.IntersectionObserver?new IntersectionObserver(entries=>{
    for(const entry of entries)if(entry.isIntersecting){cards.get(entry.target).near=true;show(entry.target);}
  }):null;
  // Scripted pages run on the separate artifact origin, which only this computer's browser reaches.
  function open(host,path){
    const tab=window.open('about:blank','_blank');if(!tab)return;tab.opener=null;
    fetch(`/api/hosts/${encodeURIComponent(host)}/html`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})}).then(async response=>{
      if(!response.ok)throw Error(await response.text());
      const link=tab.document.createElement('a');link.href=(await response.json()).url;link.rel='noreferrer';link.click();
    }).catch(error=>{tab.document.body.textContent=`Could not open HTML: ${error.message}`;});
  }
  function card(url,path,host){
    const box=element('div',undefined,'conversation-code conversation-html'),bar=element('div',undefined,'conversation-code-bar'),label=path.split(/[\\/]/).pop(),body=element('div',undefined,'conversation-html-body');
    bar.append(element('span',label));
    if(['127.0.0.1','localhost','switchboard.localhost'].includes(location.hostname)){const button=element('button','Open');button.type='button';button.setAttribute('aria-label','Open '+label);button.onclick=()=>open(host,path);bar.append(button);}
    box.append(bar,body);cards.set(box,{url,label,body,frame:null,near:!nearby});
    size(body,remembered.get(url)||{height:DEFAULT_HEIGHT});
    if(nearby){nearby.observe(box);visible.observe(box);}else queueMicrotask(()=>show(box));
    return box;
  }
  window.SwitchboardConversationHtml={isPath:path=>PATH.test(path),card};
})();
