// One floating carousel for media from the current terminal. Opening it never
// navigates the terminal frame or changes the terminal's dimensions.
(() => {
  let dialog,items=[],index=0,version=0,previousFocus,displayedUrl,pendingBack;
  const fileUrl=(host,path)=>`/api/hosts/${encodeURIComponent(host)}/file?path=${encodeURIComponent(path)}`;
  const isVideo=path=>/\.(?:mp4|webm|mov|m4v)$/i.test(path);
  function create(){
    dialog=document.createElement('dialog');dialog.id='image-gallery';
    dialog.setAttribute('aria-label','Media carousel');
    dialog.innerHTML='<header><span class="gallery-count" aria-live="polite"></span><span class="gallery-path"></span><a target="_blank" rel="noopener noreferrer">Open original</a><button type="button" class="gallery-close" aria-label="Close media carousel" autofocus>✕</button></header><div class="gallery-stage"><button type="button" class="gallery-prev" aria-label="Previous media">‹</button><div class="gallery-image"><img alt="" hidden><video controls playsinline preload="metadata" hidden></video><p role="status"></p></div><button type="button" class="gallery-next" aria-label="Next media">›</button></div><footer>← → to browse · Escape to return to terminal</footer>';
    document.body.append(dialog);
    dialog.querySelector('.gallery-close').onclick=close;
    dialog.querySelector('.gallery-prev').onclick=()=>step(-1);
    dialog.querySelector('.gallery-next').onclick=()=>step(1);
    let pressedOutside=false;
    const outside=event=>{
      const bounds=dialog.getBoundingClientRect();
      return event.target===dialog&&(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom);
    };
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
    displayedUrl=null;
    const image=dialog.querySelector('img'),video=dialog.querySelector('video');
    image.onload=image.onerror=video.onloadedmetadata=video.onerror=null;
    image.removeAttribute('src');image.hidden=true;
    video.pause();video.removeAttribute('src');video.load();video.hidden=true;
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
  window.addEventListener('popstate',()=>{if(dialog?.open&&!history.state?.switchboardMedia)close();});
  // A reload has no open media to dismiss.
  if(history.state?.switchboardMedia)history.replaceState({...history.state,switchboardMedia:false},'');
  function step(direction){if(items.length>1){index=(index+direction+items.length)%items.length;show();}}
  function show(){
    const item=items[index],img=dialog.querySelector('img'),video=dialog.querySelector('video'),status=dialog.querySelector('[role="status"]');
    dialog.querySelector('.gallery-count').textContent=`${index+1} / ${items.length}`;
    dialog.querySelector('.gallery-path').textContent=item.path;
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
