// One carousel for images from the current terminal. It stays above the terminal
// without navigating its frame or changing the terminal's dimensions.
(() => {
  let dialog,items=[],index=0,version=0,previousFocus;
  const fileUrl=(host,path)=>`/api/hosts/${encodeURIComponent(host)}/file?path=${encodeURIComponent(path)}`;
  function create(){
    dialog=document.createElement('dialog');dialog.id='image-gallery';
    dialog.setAttribute('aria-label','Image carousel');
    dialog.innerHTML='<header><span class="gallery-count" aria-live="polite"></span><span class="gallery-path"></span><a target="_blank" rel="noopener noreferrer">Open original</a><button type="button" class="gallery-close" aria-label="Close image carousel">✕</button></header><div class="gallery-stage"><button type="button" class="gallery-prev" aria-label="Previous image">‹</button><div class="gallery-image"><img alt=""><p role="status"></p></div><button type="button" class="gallery-next" aria-label="Next image">›</button></div><footer>← → to browse · Escape to close</footer>';
    document.body.append(dialog);
    dialog.querySelector('.gallery-close').onclick=close;
    dialog.querySelector('.gallery-prev').onclick=()=>step(-1);
    dialog.querySelector('.gallery-next').onclick=()=>step(1);
    dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    // Native close events are queued. An older event may arrive after a new gallery opens.
    dialog.addEventListener('close',()=>{if(!dialog.open&&previousFocus)finishClose();});
    let touch;
    dialog.addEventListener('touchstart',event=>{if(event.touches.length===1)touch={x:event.touches[0].clientX,y:event.touches[0].clientY};},{passive:true});
    dialog.addEventListener('touchend',event=>{
      if(!touch)return;
      const dx=event.changedTouches[0].clientX-touch.x,dy=event.changedTouches[0].clientY-touch.y;touch=null;
      if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5)step(dx<0?1:-1);
    },{passive:true});
  }
  function finishClose(){
    version++;
    const image=dialog.querySelector('img');image.onload=image.onerror=null;image.removeAttribute('src');
    items=[];
    const focus=previousFocus;previousFocus=null;focus?.focus();
  }
  function close(){
    if(!dialog?.open)return;
    dialog.close();finishClose();
  }
  function step(direction){if(items.length>1){index=(index+direction+items.length)%items.length;show();}}
  function show(){
    const item=items[index],img=dialog.querySelector('img'),status=dialog.querySelector('[role="status"]');
    dialog.querySelector('.gallery-count').textContent=`${index+1} / ${items.length}`;
    dialog.querySelector('.gallery-path').textContent=item.path;
    dialog.querySelector('a').href=item.url;
    for(const button of dialog.querySelectorAll('.gallery-prev,.gallery-next'))button.disabled=items.length<2;
    img.hidden=true;status.hidden=false;status.textContent='Loading image…';img.alt=item.path;
    img.onload=()=>{img.hidden=false;status.hidden=true;};
    img.onerror=()=>{img.hidden=true;status.hidden=false;status.textContent='Could not load this image. Try Open original.';};
    img.src=item.url;
  }
  window.SwitchboardOpenImages=async(host,path,paths=[{path}],locate=async path=>path)=>{
    if(!dialog)create();
    const current=++version;
    if(!dialog.open){previousFocus=document.activeElement;dialog.showModal();}
    // Show the clicked image immediately; resolve other relative paths in the background.
    items=[{path,url:fileUrl(host,path)}];index=0;
    if(paths.find(entry=>entry.path===path)?.relative){
      const found=await locate(path).catch(()=>null);
      if(current!==version)return;
      if(found)items[0]={path:found,url:fileUrl(host,found)};
    }
    show();
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
  window.addEventListener('keydown',event=>{
    if(!dialog?.open||!items.length||event.altKey||event.ctrlKey||event.metaKey)return;
    if(!['Escape','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(event.key==='Escape')close();
    else if(event.key==='Home'||event.key==='End'){index=event.key==='Home'?0:items.length-1;show();}
    else step(event.key==='ArrowLeft'?-1:1);
  },true);
})();
