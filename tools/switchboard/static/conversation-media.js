// Transcript content is untrusted. Build DOM nodes, never insert transcript HTML.
(() => {
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const imageExt=/\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#].*)?$/i,videoExt=/\.(?:mp4|webm|mov|m4v)(?:[?#].*)?$/i;
  const mediaPath=/^\s*(?:[A-Za-z]:[\\/]|\/|~[\\/])[^\n]*[^\s]\s*$/;
  // A literal reference is a path as written, not a URL, so a % in it is part of the name.
  function resolve(reference,{host,project},literal=false){
    const originalReference=reference;
    if(typeof reference!=='string'||!reference||/[\x00-\x1f\x7f]/.test(reference))return null;
    if(literal&&/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(reference))return reference;
    if(/^https?:\/\//i.test(reference)){
      try{const url=new URL(reference);if(url.username||url.password)return null;
        // A loopback URL in a remote transcript is not a URL on the viewing phone.
        if(['localhost','127.0.0.1','[::1]'].includes(url.hostname))return null;
        return url.href;}catch{return null;}
    }
    if(reference.startsWith('#'))return null;
    if(reference.startsWith('//')||reference.startsWith('\\\\'))return null;
    if(/^file:\/\//i.test(reference)){try{const url=new URL(reference);if(url.hostname&&url.hostname!=='localhost')return null;reference=decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/,'$1');}catch{return null;}}
    else if(/^[a-z][\w+.-]*:/i.test(reference)&&!(/^[A-Za-z]:[\\/]/.test(reference)))return null;
    try{if(!literal&&!/^file:/i.test(originalReference))reference=decodeURIComponent(reference);}catch{return null;}
    reference=reference.replace(/\\/g,'/');
    // Markdown file links can spell a Windows absolute path as /C:/... .
    reference=reference.replace(/^\/([A-Za-z]:\/)/,'$1');
    if(!/^(?:\/|~\/|[A-Za-z]:\/)/.test(reference)){
      if(!project||! /^(?:\/|~[\\/]|[A-Za-z]:[\\/])/.test(project))return null;
      reference=project.replace(/\\/g,'/').replace(/\/$/,'')+'/'+reference;
    }
    // Keep literal # and ? in filesystem names; URLSearchParams escapes them.
    return `/api/hosts/${encodeURIComponent(host)}/file?${new URLSearchParams({path:reference})}`;
  }
  // Full-screen viewer. Click or double-tap zooms, drag pans a zoomed image, pinch and the
  // wheel zoom, and on touch a sideways swipe changes item and a downward swipe closes.
  const ICONS={
    close:'<path d="M5.5 5.5l9 9m0-9l-9 9"/>',
    previous:'<path d="M12 4.5L6.5 10l5.5 5.5"/>',next:'<path d="M8 4.5l5.5 5.5L8 15.5"/>',
    zoomIn:'<circle cx="8.75" cy="8.75" r="5.25"/><path d="M12.6 12.6l4 4M8.75 6.5v4.5M6.5 8.75H11"/>',
    zoomOut:'<circle cx="8.75" cy="8.75" r="5.25"/><path d="M12.6 12.6l4 4M6.5 8.75H11"/>',
    open:'<path d="M11.5 4h4.5v4.5M16 4l-6.5 6.5M14 11.5V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3.5"/>',
    download:'<path d="M10 3.5v9m-4-4 4 4 4-4M4.5 16h11"/>',
    play:'<path d="M7 5.2v9.6a.5.5 0 0 0 .76.43l7.7-4.8a.5.5 0 0 0 0-.86l-7.7-4.8A.5.5 0 0 0 7 5.2z"/>'};
  // ICONS are constants above, never transcript text.
  const icon=name=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 20 20');svg.setAttribute('aria-hidden','true');svg.innerHTML=ICONS[name];return svg;};
  const control=(tag,label,name,className='conversation-viewer-icon')=>{const n=node(tag);if(tag==='button')n.type='button';n.className=className;n.setAttribute('aria-label',label);n.title=label;n.append(icon(name));return n;};
  let dialog,scrim,stage,header,meta,title,count,original,download,zoomButton,previous,next,strip,items=[],index=0,focusBefore,focusRoot,focusUrl;
  let view={scale:1,x:0,y:0},gesture=null,suppressClick=false,lastTap=null,tapTimer,pointerKind='mouse',avifBlob;
  const pointers=new Map();
  const image=()=>stage?.querySelector(':scope>img');
  const shown=()=>stage?.querySelector(':scope>img,:scope>video');
  function pause(root){for(const video of root?.querySelectorAll('video')||[])video.pause();}
  function releaseAvif(){if(avifBlob){URL.revokeObjectURL(avifBlob);avifBlob=null;}}
  function close(){
    if(!dialog?.open)return;pause(dialog);dialog.close();stage.replaceChildren();releaseAvif();items=[];pointers.clear();gesture=null;clearTimeout(tapTimer);
    dialog.classList.remove('chrome-hidden','zoomed','loading');scrim.style.opacity='';
    const available=node=>node?.isConnected&&!node.disabled&&node.getClientRects().length>0;
    const replacement=[...(focusRoot?.querySelectorAll('[data-conversation-media-url]')||[])].find(node=>node.dataset.conversationMediaUrl===focusUrl&&available(node));
    const destination=[focusBefore,replacement,focusRoot?.querySelector('.conversation-compose textarea'),focusRoot].find(available);
    destination?.focus({preventScroll:true});focusBefore=focusRoot=focusUrl=null;
  }
  // A zoomed image keeps covering the screen: its edges never come inside the viewport.
  function clamp(){
    const img=image();if(!img)return;
    const axis=(size,full,offset,value)=>{const half=Math.max(0,(size*view.scale-full)/2),center=offset+size/2-full/2;return Math.min(Math.max(half-center,0),Math.max(Math.min(-half-center,0),value));};
    view.x=axis(img.offsetWidth,stage.clientWidth,img.offsetLeft,view.x);view.y=axis(img.offsetHeight,stage.clientHeight,img.offsetTop,view.y);
  }
  function apply(animate){
    const img=image(),zoomed=view.scale>1.001;
    if(img){img.classList.toggle('settling',!!animate);img.style.transform=zoomed||view.x||view.y?`translate(${view.x}px,${view.y}px) scale(${view.scale})`:'';}
    dialog.classList.toggle('zoomed',zoomed);
    const label=zoomed?'Fit image':'Zoom in';
    if(zoomButton.getAttribute('aria-label')!==label){zoomButton.setAttribute('aria-label',label);zoomButton.title=label;zoomButton.replaceChildren(icon(zoomed?'zoomOut':'zoomIn'));}
  }
  // Zoom about a screen point, so the pixel under the pointer stays under it.
  function zoomTo(scale,clientX,clientY,animate){
    const img=image();if(!img)return;scale=Math.min(8,Math.max(1,scale));
    const box=stage.getBoundingClientRect(),cx=box.left+img.offsetLeft+img.offsetWidth/2,cy=box.top+img.offsetTop+img.offsetHeight/2;
    const px=(clientX??cx)-cx,py=(clientY??cy)-cy,ratio=scale/view.scale;
    view={scale,x:px-(px-view.x)*ratio,y:py-(py-view.y)*ratio};if(scale===1)view.x=view.y=0;clamp();apply(animate);
  }
  function toggleZoom(clientX,clientY){
    const img=image();if(!img)return;
    if(view.scale>1.001)return zoomTo(1,null,null,true);
    zoomTo(Math.min(6,Math.max(2,img.naturalWidth/Math.max(1,img.offsetWidth))),clientX,clientY,true);
  }
  // The image comes back if the player fails at any point, which can be after it has started,
  // so an AVIF this browser cannot play remains the animated image it was. Only the relay's own files are fetched:
  // a URL in a transcript is untrusted and an image request is all it has ever received.
  async function playAvif(item,still){
    if(!item.url.startsWith('/api/hosts/')||!/\.avif$/i.test(item.url))return;
    const blob=await window.SwitchboardAvifVideo?.(item.url);
    if(!blob)return;
    if(still.parentNode!==stage)return URL.revokeObjectURL(blob);
    const video=node('video');video.className='conversation-viewer-media';video.controls=video.loop=video.muted=video.playsInline=true;video.preload='metadata';video.setAttribute('aria-label',item.label);
    video.onerror=()=>{if(video.parentNode===stage){video.replaceWith(still);zoomButton.hidden=false;avifBlob=null;}URL.revokeObjectURL(blob);};
    video.onloadeddata=()=>{
      if(still.parentNode!==stage)return URL.revokeObjectURL(blob);
      avifBlob=blob;still.replaceWith(video);view={scale:1,x:0,y:0};gesture=null;zoomButton.hidden=true;dialog.classList.remove('loading');apply();video.play().catch(()=>{});
    };
    video.src=blob;
  }
  function show(direction){
    // A video's taps go to its controls, so a new item always shows the viewer's controls.
    pause(stage);stage.replaceChildren();releaseAvif();view={scale:1,x:0,y:0};gesture=null;scrim.style.opacity='';clearTimeout(tapTimer);dialog.classList.remove('chrome-hidden');
    const item=items[index],media=node(item.kind==='video'?'video':'img');
    title.textContent=item.label;count.textContent=`${index+1} / ${items.length}`;
    original.href=download.href=item.url;download.download=item.file||item.label.split(/[\\/]/).pop()||'media';original.hidden=!!item.aspect;
    zoomButton.hidden=item.kind==='video';
    media.className='conversation-viewer-media'+(direction?' from-'+direction:'')+(item.aspect?' vector':'');if(item.aspect)media.style.setProperty('--aspect',item.aspect);
    dialog.classList.add('loading');const loaded=()=>{if(media.parentNode===stage)dialog.classList.remove('loading');};
    if(item.kind==='video'){media.controls=true;media.playsInline=true;media.preload='metadata';media.setAttribute('aria-label',item.label);media.onloadedmetadata=loaded;}
    else{media.alt=item.label;media.draggable=false;media.decoding='async';media.onload=loaded;}
    media.onerror=()=>{if(media.parentNode!==stage)return;dialog.classList.remove('loading');const failed=node('p','Preview unavailable. Try Open original.');failed.className='conversation-viewer-failed';stage.replaceChildren(failed);};
    media.src=item.url;stage.append(media);apply();
    if(item.kind!=='video')playAvif(item,media);
    for(const [position,thumb] of [...strip.children].entries()){thumb.setAttribute('aria-current',String(position===index));if(position===index&&dialog.open)thumb.scrollIntoView({block:'nearest',inline:'nearest'});}
    if(items.length>1)for(const neighbour of [items[(index+1)%items.length],items[(index-1+items.length)%items.length]])if(neighbour.kind!=='video')new Image().src=neighbour.url;
  }
  function step(delta){if(items.length<2)return;index=(index+delta+items.length)%items.length;show(delta>0?'next':'previous');}
  function settle(){const media=shown();if(media){media.classList.add('settling');media.style.transform='';}scrim.style.opacity='';}
  function release(event){
    const g=gesture;if(!pointers.delete(event.pointerId))return;
    if(pointers.size===1&&g?.type==='pinch'){const [[,p]]=pointers;gesture={type:'pan',x0:p.x,y0:p.y,tx:view.x,ty:view.y,moved:true};return;}
    if(pointers.size)return;gesture=null;stage.classList.remove('panning');if(!g)return;
    if(g.moved)suppressClick=true;
    const dx=event.clientX-g.x0,dy=event.clientY-g.y0,elapsed=Math.max(1,event.timeStamp-g.t0),done=event.type==='pointerup';
    if(g.type==='swipe'){if(done&&items.length>1&&(Math.abs(dx)>Math.min(90,stage.clientWidth*.2)||Math.abs(dx)/elapsed>.5))step(dx<0?1:-1);else settle();}
    else if(g.type==='dismiss'){if(done&&(dy>110||dy/elapsed>.6))close();else settle();}
    else if(g.type==='pan'){if(view.scale<1.05)zoomTo(1,null,null,true);}
    else if(!g.moved&&g.pointerType!=='mouse'&&done){
      // On touch, a double-tap zooms and a single tap on the image shows or hides the controls.
      const tap={t:event.timeStamp,x:event.clientX,y:event.clientY};clearTimeout(tapTimer);
      if(lastTap&&tap.t-lastTap.t<320&&Math.hypot(tap.x-lastTap.x,tap.y-lastTap.y)<40){lastTap=null;toggleZoom(tap.x,tap.y);return;}
      lastTap=tap;if(event.target===image())tapTimer=setTimeout(()=>dialog.classList.toggle('chrome-hidden'),320);
    }
  }
  function build(){
    dialog=node('dialog');dialog.className='conversation-media-dialog';dialog.setAttribute('aria-label','Media viewer');dialog.autofocus=true;dialog.tabIndex=-1;
    scrim=node('div');scrim.className='conversation-viewer-scrim';
    stage=node('div');stage.className='conversation-media-stage';
    header=node('header');meta=node('div');meta.className='conversation-viewer-meta';title=node('strong');count=node('span');meta.append(title,count);
    const actions=node('div');actions.className='conversation-viewer-actions';
    zoomButton=control('button','Zoom in','zoomIn');zoomButton.onclick=()=>toggleZoom();
    // Browsers ignore `download` on another origin's file; the new tab keeps Switchboard open.
    download=control('a','Download','download');download.target='_blank';download.rel='noopener noreferrer';original=control('a','Open original','open');original.target='_blank';original.rel='noopener noreferrer';
    // Chromium can save a dragged DownloadURL as a file. Keep external media's normal link drag.
    download.ondragstart=event=>{if(new URL(download.href).origin===location.origin)event.dataTransfer.setData('DownloadURL',`application/octet-stream:${download.download.replace(/:/g,'_')}:${download.href}`);};
    const dismiss=control('button','Close','close');dismiss.onclick=close;
    const divider=node('i');divider.className='conversation-viewer-divider';actions.append(zoomButton,download,original,divider,dismiss);header.append(meta,actions);
    previous=control('button','Previous','previous','conversation-viewer-nav previous');next=control('button','Next','next','conversation-viewer-nav next');
    previous.onclick=()=>step(-1);next.onclick=()=>step(1);
    strip=node('nav');strip.className='conversation-viewer-strip';strip.setAttribute('aria-label','Gallery');
    dialog.append(scrim,stage,header,previous,next,strip);document.body.append(dialog);
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    dialog.addEventListener('click',e=>{
      if(suppressClick){suppressClick=false;return;}
      if(e.target===image()){if(pointerKind==='mouse')toggleZoom(e.clientX,e.clientY);return;}
      // Empty space closes. On touch only the stage counts, so a missed tap on a control does not.
      if(e.target===stage||pointerKind==='mouse'&&[dialog,scrim,header,meta,strip].includes(e.target))close();
    });
    dialog.addEventListener('keydown',e=>{
      if(e.target.tagName==='VIDEO'||e.altKey||e.ctrlKey||e.metaKey)return;
      const zoomIn=()=>zoomTo(view.scale*1.5,null,null,true);
      const keys={ArrowRight:()=>step(1),ArrowLeft:()=>step(-1),'+':zoomIn,'=':zoomIn,'-':()=>zoomTo(view.scale/1.5,null,null,true),'0':()=>zoomTo(1,null,null,true)};
      if(keys[e.key]){e.preventDefault();keys[e.key]();}
    });
    stage.addEventListener('pointerdown',e=>{
      pointerKind=e.pointerType;if(e.target.tagName==='VIDEO'||e.button>0)return;
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});suppressClick=false;
      if(pointers.size===2&&image()){const [a,b]=[...pointers.values()];stage.classList.remove('panning');gesture={type:'pinch',distance:Math.hypot(a.x-b.x,a.y-b.y)||1,scale:view.scale,mx:(a.x+b.x)/2,my:(a.y+b.y)/2,moved:true};}
      else if(pointers.size===1)gesture={type:'pending',x0:e.clientX,y0:e.clientY,t0:e.timeStamp,tx:view.x,ty:view.y,pointerType:e.pointerType,moved:false};
    });
    dialog.addEventListener('pointermove',e=>{
      if(!pointers.has(e.pointerId)||!gesture)return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});const g=gesture;
      if(g.type==='pinch'){
        const [a,b]=[...pointers.values()],mx=(a.x+b.x)/2,my=(a.y+b.y)/2;view.x+=mx-g.mx;view.y+=my-g.my;g.mx=mx;g.my=my;
        zoomTo(g.scale*Math.hypot(a.x-b.x,a.y-b.y)/g.distance,mx,my);return;
      }
      const dx=e.clientX-g.x0,dy=e.clientY-g.y0;
      if(g.type==='pending'){
        if(Math.hypot(dx,dy)<6)return;g.moved=true;
        g.type=view.scale>1.001&&image()?'pan':g.pointerType==='mouse'?'none':Math.abs(dx)>Math.abs(dy)?'swipe':dy>0?'dismiss':'none';
        if(g.type==='pan')stage.classList.add('panning');
      }
      const media=shown();
      if(g.type==='pan'){view.x=g.tx+dx;view.y=g.ty+dy;clamp();apply();}
      else if(g.type==='swipe'&&media){media.classList.remove('settling');media.style.transform=`translateX(${items.length>1?dx:dx/4}px)`;}
      else if(g.type==='dismiss'&&media){const progress=Math.min(1,Math.max(0,dy)/(stage.clientHeight*.6));media.classList.remove('settling');media.style.transform=`translateY(${Math.max(0,dy)}px) scale(${1-progress*.25})`;scrim.style.opacity=String(1-progress*.85);}
    });
    dialog.addEventListener('pointerup',release);dialog.addEventListener('pointercancel',release);
    stage.addEventListener('wheel',e=>{
      if(!image()||e.target.tagName==='VIDEO')return;e.preventDefault();
      // At fit every wheel zooms. Zoomed, a trackpad pinch (ctrlKey) or a mouse wheel notch
      // zooms and a two-finger trackpad scroll pans.
      if(view.scale<=1.001||e.ctrlKey||e.deltaMode||Math.abs(e.deltaY)>=50&&!e.deltaX){const delta=Math.max(-100,Math.min(100,e.deltaMode?e.deltaY*33:e.deltaY));return zoomTo(view.scale*Math.exp(-delta*(e.ctrlKey?.01:.0025)),e.clientX,e.clientY);}
      if(view.scale>1.001){view.x-=e.deltaX;view.y-=e.deltaY;clamp();apply();}
    },{passive:false});
    window.addEventListener('resize',()=>{if(dialog.open&&view.scale>1){view={scale:1,x:0,y:0};apply();}});
  }
  function expand(gallery,selected,trigger){
    if(!dialog)build();
    items=gallery;index=selected;focusBefore=trigger||document.activeElement;focusRoot=focusBefore?.closest('.conversation-panel');focusUrl=gallery[selected].url;
    dialog.classList.toggle('gallery',items.length>1);previous.hidden=next.hidden=strip.hidden=items.length<2;
    strip.replaceChildren(...items.map((item,position)=>{
      const thumb=node('button');thumb.type='button';thumb.setAttribute('aria-label','Show '+item.label);thumb.title=item.label;
      if(item.kind==='video')thumb.append(icon('play'));
      else{const img=node('img');img.src=item.url;img.alt='';img.loading='lazy';img.decoding='async';img.draggable=false;img.onerror=()=>img.remove();thumb.append(img);}
      thumb.onclick=()=>{if(position!==index){const delta=position-index;index=position;show(delta>0?'next':'previous');}};return thumb;
    }));
    if(!dialog.open){dialog.showModal();dialog.focus({preventScroll:true});}
    show();
  }
  function media(reference,label,kind,context,gallery,literal=false){
    const url=resolve(reference,context,literal),wrapper=node('span');wrapper.className='conversation-media';
    if(!url){wrapper.append(node('span',`${label}: preview unavailable`));return wrapper;}
    const item={url,label,kind},position=gallery.push(item)-1;
    const caption=node('span',label);caption.className='conversation-media-caption';
    const open=node('a','Open original');open.href=url;open.target='_blank';open.rel='noopener noreferrer';
    if(kind==='video'){
      const video=node('video');video.src=url;video.controls=true;video.playsInline=true;video.preload='metadata';video.setAttribute('aria-label',label);video.onerror=()=>{wrapper.classList.add('failed');video.remove();full.remove();caption.remove();};wrapper.append(video);
      const full=node('button','Expand video');full.type='button';full.dataset.conversationMediaUrl=url;full.onclick=()=>{video.pause();expand(gallery,position,full);};wrapper.append(full);
    }else{
      const button=node('button');button.type='button';button.className='conversation-image-button';button.dataset.conversationMediaUrl=url;button.setAttribute('aria-label','Preview '+label);const img=node('img');img.src=url;img.alt=label;img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';img.onerror=()=>{wrapper.classList.add('failed');img.hidden=true;button.textContent='Image unavailable';};button.append(img);button.onclick=()=>expand(gallery,position,button);wrapper.append(button);
    }
    wrapper.append(caption,open);return wrapper;
  }
  function linkify(parent,context){
    // Agents print bare URLs; markdown only links <url> and [text](url). Link the rest,
    // leaving trailing sentence punctuation outside the link. The relay splits text at
    // characters like _ and (, so join adjacent pieces first.
    parent.normalize();
    const urls=document.createTreeWalker(parent,NodeFilter.SHOW_TEXT),bare=[];
    while(urls.nextNode()){const text=urls.currentNode;if(/https?:\/\//i.test(text.data)&&!text.parentElement.closest('a,pre,code,.conversation-media'))bare.push(text);}
    for(const text of bare){
      const parts=[];let last=0;
      for(const match of text.data.matchAll(/https?:\/\/[^\s<>"'`]+/gi)){
        let url=match[0];while(/[.,;:!?)\]}]$/.test(url)&&!(url.endsWith(')')&&url.split('(').length>url.split(')').length-1))url=url.slice(0,-1);
        const href=resolve(url,context);if(!href)continue;
        parts.push(document.createTextNode(text.data.slice(last,match.index)));
        const link=node('a',url);link.href=href;link.target='_blank';link.rel='noopener noreferrer';parts.push(link);last=match.index+url.length;
      }
      if(parts.length){parts.push(document.createTextNode(text.data.slice(last)));text.replaceWith(...parts);}
    }
  }
  const html=()=>window.SwitchboardConversationHtml;
  function render(parent,message,context){
    const gallery=[],stack=[parent],current=()=>stack.at(-1);let capture=null;
    const allowed=new Set(['p','blockquote','pre','li','em','strong','del','table','thead','tr','td','span','ul','ol','h1','h2','h3','h4','h5','h6']);
    for(const event of message.markdown||[{type:'text',text:message.text||''}]){
      if(capture){
        if(event.type==='start')capture.depth++;
        else if(event.type==='end'&&--capture.depth===0){const kind=videoExt.test(capture.url)?'video':'image';current().append(media(capture.url,capture.label||'Media',kind,context,gallery));capture=null;}
        else if(event.text)capture.label+=event.text;
        continue;
      }
      if(event.type==='start'){
        if(event.tag==='image'||event.tag==='a'&&(imageExt.test(event.url)||videoExt.test(event.url))){capture={url:event.url,label:'',depth:1};continue;}
        let element;
        if(event.tag==='a'){
          const url=resolve(event.url,context);element=node(url?'a':'span');if(url){element.href=url;element.target='_blank';element.rel='noopener noreferrer';}
        }else element=node(allowed.has(event.tag)?event.tag:'span');
        if(event.tag==='ol'&&Number.isSafeInteger(event.start)&&event.start>0)element.start=event.start;
        if(event.tag==='pre'&&typeof event.lang==='string'&&/^[\w+#.-]{1,24}$/.test(event.lang))element.dataset.lang=event.lang;
        if(event.tag==='table'){const wrap=node('div');wrap.className='conversation-table';current().append(wrap);wrap.append(element);}else current().append(element);
        stack.push(element);
      }else if(event.type==='end'){if(stack.length>1)stack.pop();}
      else if(event.type==='code')current().append(node('code',event.text||''));
      else if(event.type==='break')current().append(node('br'));
      else if(event.type==='rule')current().append(node('hr'));
      else if(event.type==='text')current().append(document.createTextNode(event.text||''));
    }
    // A line that is only an absolute image, video or published HTML path shows it, as the terminal does.
    // Markdown text arrives in fragments, so the whole line must be that one text node,
    // directly inside a block: a path in bold or italics belongs to its sentence.
    const lineEdge=(sibling,start)=>!sibling||sibling.nodeName==='BR'||sibling.nodeType===3&&(start?sibling.data.endsWith('\n'):sibling.data.startsWith('\n'));
    const walker=document.createTreeWalker(parent,NodeFilter.SHOW_TEXT),paths=[];
    while(walker.nextNode()){const text=walker.currentNode;if((text.parentElement===parent||text.parentElement.matches('p,li,td,h1,h2,h3,h4,h5,h6'))&&!text.parentElement.closest('blockquote,.conversation-media')&&mediaPath.test(text.data)&&(imageExt.test(text.data.trim())||videoExt.test(text.data.trim())||html()?.isPath(text.data.trim()))&&lineEdge(text.previousSibling,true)&&lineEdge(text.nextSibling,false))paths.push(text);}
    for(const text of paths){const path=text.data.trim();if(html()?.isPath(path)){const url=resolve(path,context,true);if(url)text.replaceWith(html().card(url,path,context.host));continue;}text.replaceWith(media(path,path.split(/[\\/]/).pop(),videoExt.test(path)?'video':'image',context,gallery,true));}
    linkify(parent,context);
    window.SwitchboardConversationGithub?.decorate(parent,context);
    for(const attachment of message.attachments||[]){
      if(attachment.unavailable){const unavailable=node('p',`${attachment.name||'Attachment'} · ${attachment.unavailable}`);unavailable.className='conversation-media-unavailable';parent.append(unavailable);}
      else if(attachment.kind==='file'){
        const url=resolve(attachment.url,context),file=node(url?'a':'span',attachment.name||'Attachment');file.className='conversation-outgoing-file';
        if(url){file.href=url;file.target='_blank';file.rel='noopener noreferrer';}parent.append(file);
      }
      else parent.append(media(attachment.url,attachment.name||'Attachment',attachment.kind==='video'?'video':'image',context,gallery,true));
    }
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause(document);});
  window.SwitchboardConversationMedia={render,resolve,linkify,pause,close,expand};
})();
