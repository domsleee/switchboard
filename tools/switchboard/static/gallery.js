// One floating carousel for media from the current terminal. Opening it never
// navigates the terminal frame or changes the terminal's dimensions.
(() => {
  let dialog,items=[],index=0,version=0,previousFocus,displayedUrl,pendingBack,avifBlob,avifLoad=0;
  const fileUrl=(host,path)=>`/api/hosts/${encodeURIComponent(host)}/file?path=${encodeURIComponent(path)}`;
  const isVideo=path=>/\.(?:mp4|webm|mov|m4v)$/i.test(path);
  // An animated AVIF is an MP4-style track beside a cover image. Given the file itself, a
  // <video> reports the track's duration but shows only the cover, so seeking does nothing.
  // Hiding the cover plays the track. Same-length edits keep the file's offsets valid.
  // Returns a blob URL the caller revokes, or null for a still image or an unreadable file.
  window.SwitchboardAvifVideo=async url=>{
    try{
      const response=await fetch(url);if(!response.ok)return null;
      const bytes=new Uint8Array(await response.arrayBuffer()),view=new DataView(bytes.buffer);
      const tag=at=>String.fromCharCode(...bytes.subarray(at,at+4));
      const put=(at,name)=>bytes.set([...name].map(letter=>letter.charCodeAt(0)),at);
      if(tag(4)!=='ftyp')return null;
      // The brands are the first word and every word after the minor version.
      const brands=[8];for(let at=16;at+4<=view.getUint32(0);at+=4)brands.push(at);
      if(!brands.some(at=>tag(at)==='avis'))return null;
      for(const at of brands)if(['avis','avif'].includes(tag(at)))put(at,'isom');
      for(let at=0;at+8<=bytes.length;){
        const short=view.getUint32(at),size=short===1?Number(view.getBigUint64(at+8)):short||bytes.length-at;
        if(tag(at+4)==='meta')put(at+4,'free');
        if(size<8)return null;
        at+=size;
      }
      return URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
    }catch{return null;}
  };
  function create(){
    dialog=document.createElement('dialog');dialog.id='image-gallery';
    dialog.setAttribute('aria-label','Media carousel');
    dialog.innerHTML='<button type="button" class="gallery-close" aria-label="Close media carousel" title="Close · Escape" autofocus>✕</button><div class="gallery-stage"><button type="button" class="gallery-prev" aria-label="Previous media">‹</button><div class="gallery-image"><img alt="" hidden><video controls playsinline preload="metadata" hidden></video><p role="status"></p><footer><span class="gallery-path"></span><span class="gallery-count" aria-live="polite"></span><a target="_blank" rel="noopener noreferrer">Open original</a></footer></div><button type="button" class="gallery-next" aria-label="Next media">›</button></div>';
    document.body.append(dialog);
    // Chromium can save a dragged DownloadURL as a file, using the current item's original URL.
    const original=dialog.querySelector('footer a');
    original.ondragstart=event=>event.dataTransfer.setData('DownloadURL',`application/octet-stream:${items[index].path.split(/[\\/]/).pop().replace(/:/g,'_')}:${original.href}`);
    dialog.querySelector('.gallery-close').onclick=close;
    dialog.querySelector('.gallery-prev').onclick=()=>step(-1);
    dialog.querySelector('.gallery-next').onclick=()=>step(1);
    let pressedOutside=false;
    const outside=event=>event.target===dialog||event.target.classList.contains('gallery-stage')||event.target.classList.contains('gallery-image');
    dialog.addEventListener('pointerdown',event=>{pressedOutside=outside(event);});
    dialog.addEventListener('click',event=>{if(pressedOutside&&outside(event))close();pressedOutside=false;});
    dialog.addEventListener('cancel',event=>{event.preventDefault();if(!document.fullscreenElement)close();});
    // Native close events are queued. An older event may arrive after a new gallery opens.
    dialog.addEventListener('close',()=>{if(!dialog.open&&previousFocus)finishClose();});
    let touch;
    dialog.addEventListener('touchstart',event=>{
      touch=event.touches.length===1&&!event.target.closest('video')?{x:event.touches[0].clientX,y:event.touches[0].clientY}:null;
    },{passive:true});
    dialog.addEventListener('touchend',event=>{
      if(!touch)return;
      const dx=event.changedTouches[0].clientX-touch.x,dy=event.changedTouches[0].clientY-touch.y;touch=null;
      if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5)step(dx<0?1:-1);
    },{passive:true});
  }
  function unload(){
    displayedUrl=null;avifLoad++;
    const image=dialog.querySelector('img'),video=dialog.querySelector('video');
    image.onload=image.onerror=video.onloadedmetadata=video.onloadeddata=video.onerror=null;
    image.removeAttribute('src');image.hidden=true;
    video.pause();video.removeAttribute('src');video.load();video.hidden=true;video.loop=video.muted=false;
    if(avifBlob){URL.revokeObjectURL(avifBlob);avifBlob=null;}
  }
  // The image comes back if the player fails at any point, which can be after it has started,
  // so an AVIF this browser cannot play remains the animated image it was. It loops unprompted,
  // as that image did.
  async function playAvif(item){
    const load=++avifLoad,blob=await window.SwitchboardAvifVideo(item.url);
    if(!blob)return;
    if(load!==avifLoad)return URL.revokeObjectURL(blob);
    const image=dialog.querySelector('img'),video=dialog.querySelector('video');
    avifBlob=blob;video.loop=video.muted=true;video.setAttribute('aria-label',item.path);
    video.onloadeddata=()=>{
      image.onload=image.onerror=null;image.hidden=true;
      dialog.querySelector('[role="status"]').hidden=true;video.hidden=false;video.play().catch(()=>{});
    };
    video.onerror=()=>{
      video.onloadeddata=video.onerror=null;video.removeAttribute('src');video.load();video.hidden=true;video.loop=video.muted=false;image.hidden=false;
      URL.revokeObjectURL(blob);avifBlob=null;
    };
    video.src=blob;
  }
  function finishClose(){
    version++;unload();items=[];
    if(history.state?.switchboardMedia&&!pendingBack){
      pendingBack=new Promise(resolve=>window.addEventListener('popstate',()=>{pendingBack=null;resolve();},{once:true}));
      history.back();
    }
    const focus=previousFocus;previousFocus=null;focus?.focus();
  }
  function close(){
    if(!dialog?.open)return;
    dialog.close();finishClose();
  }
  window.addEventListener('popstate',()=>{
    if(dialog?.open){if(!history.state?.switchboardMedia)close();}
    // Forward can revisit a closed preview's entry. It no longer owns an open
    // gallery, so a later opening must not inherit another marked entry beneath it.
    else if(history.state?.switchboardMedia)history.replaceState({...history.state,switchboardMedia:false},'');
  });
  // A reload has no open media to dismiss.
  if(history.state?.switchboardMedia)history.replaceState({...history.state,switchboardMedia:false},'');
  function step(direction){if(items.length>1){index=(index+direction+items.length)%items.length;show();}}
  function show(){
    const item=items[index],img=dialog.querySelector('img'),video=dialog.querySelector('video'),status=dialog.querySelector('[role="status"]');
    dialog.querySelector('.gallery-count').textContent=`${index+1} / ${items.length}`;
    dialog.querySelector('.gallery-count').hidden=items.length<2;
    dialog.querySelector('.gallery-path').textContent=item.path.split(/[\\/]/).pop();
    dialog.querySelector('.gallery-path').title=item.path;
    dialog.querySelector('a').href=item.url;
    for(const button of dialog.querySelectorAll('.gallery-prev,.gallery-next')){button.disabled=items.length<2;button.hidden=items.length<2;}
    // Resolving sibling paths updates the count without restarting a playing video.
    if(displayedUrl===item.url)return;
    unload();displayedUrl=item.url;
    const playingVideo=isVideo(item.path),media=playingVideo?video:img;
    status.hidden=false;status.textContent=playingVideo?'Loading video…':'Loading image…';
    const loaded=()=>{media.hidden=false;status.hidden=true;};
    if(playingVideo){video.hidden=false;video.onloadedmetadata=loaded;video.setAttribute('aria-label',item.path);}
    else{img.onload=loaded;img.alt=item.path;}
    media.onerror=()=>{media.hidden=true;status.hidden=false;status.textContent=`Could not load this ${playingVideo?'video':'image'}. Try Open original.`;};
    media.src=item.url;
    if(/\.avif$/i.test(item.path))playAvif(item);
  }
  window.SwitchboardOpenMedia=async(host,path,paths=[{path}],locate=async path=>path)=>{
    if(!dialog)create();
    const current=++version;
    // Closing consumes history asynchronously. Let it finish before opening another preview.
    if(pendingBack)await pendingBack;
    if(current!==version)return;
    if(!dialog.open){
      previousFocus=document.activeElement;
      history.pushState({...history.state,switchboardMedia:true},'');
      dialog.showModal();
    }
    items=[{path,url:fileUrl(host,path)}];index=0;show();
    if(paths.find(entry=>entry.path===path)?.relative){
      const found=await locate(path).catch(()=>null);
      if(current!==version)return;
      if(found){items[0]={path:found,url:fileUrl(host,found)};show();}
    }
    const clicked=items[0];
    const resolved=await Promise.all(paths.map(async entry=>{
      try{const found=entry.relative?await locate(entry.path):entry.path;return found?{path:found,url:fileUrl(host,found)}:null;}catch{return null;}
    }));
    if(current!==version)return;
    const unique=new Map();
    for(const entry of resolved)if(entry)unique.set(entry.url,entry);
    if(!unique.has(clicked.url))unique.set(clicked.url,clicked);
    items=[...unique.values()];index=items.findIndex(item=>item.url===clicked.url);show();
  };
  window.SwitchboardOpenImages=window.SwitchboardOpenMedia;
  window.addEventListener('keydown',event=>{
    if(!dialog?.open||event.altKey||event.ctrlKey||event.metaKey)return;
    if(!['Escape','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    if(event.key==='Escape'){
      if(document.fullscreenElement)return;
      event.preventDefault();event.stopImmediatePropagation();close();return;
    }
    // Native video controls own their seeking and volume shortcuts.
    if(event.target.closest?.('video')||!items.length)return;
    event.preventDefault();event.stopImmediatePropagation();
    if(event.key==='Home'||event.key==='End'){index=event.key==='Home'?0:items.length-1;show();}
    else step(event.key==='ArrowLeft'?-1:1);
  },true);
})();
