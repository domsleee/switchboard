// Open links in the viewing browser, synchronously within the user's gesture.
(() => {
  const [host, session] = location.pathname.split('/').slice(2).map(decodeURIComponent);
  const config = window.__switchboardLinkHosts?.[host];
  const localHost = name => ['localhost','127.0.0.1','[::1]','::1'].includes(name);
  function resolve(uri) {
    const url = new URL(uri, location.href);
    if (!['http:','https:','mailto:'].includes(url.protocol)) throw Error('Unsupported link type');
    if (config && (localHost(url.hostname) || url.hostname === new URL(config.origin).hostname)) {
      const target = config.artifacts?.[url.port || (url.protocol==='https:'?'443':'80')];
      if (target) {
        const root = new URL(target);
        root.pathname = root.pathname.replace(/\/$/,'') + url.pathname;
        root.search = url.search; root.hash = url.hash;
        return root.href;
      }
      // This requires the artifact server to listen on LAN. An actual tunnel can
      // be supplied in artifact_urls without changing terminal link behavior.
      if(localHost(url.hostname) && !config.local)url.hostname = new URL(config.origin).hostname;
    }
    return url.href;
  }
  // Absolute paths with two parts (so /help and and/or stay text), ~/ paths, and C:\ paths.
  const part=String.raw`[^\s"'<>|*?:;,()[\]{}\\/]+`,sep=String.raw`[\\/]`;
  const filePath=new RegExp(String.raw`(?<![\w.~:/\\-])(?:(?:~|[A-Za-z]:)${sep}${part}|/${part}${sep}${part})(?:${sep}${part})*`,'g');
  function filePathOf(uri) {
    if (uri.startsWith('file:')) {
      const path = decodeURIComponent(new URL(uri).pathname);
      return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
    }
    return /^(~|[A-Za-z]:)?[\\/]/.test(uri) ? uri : null;
  }
  // Hovering an image or video path previews it from this terminal's computer.
  // Drive, UNC, ~/ and / paths to media. Spaces are allowed because the extension ends the path,
  // but a space before another root starts a new path, so two paths on a line stay separate.
  const mediaPaths=/(?<![\w.~:%/\\-])(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)(?:[^\s"'<>|*?:\\/](?:(?!\s+(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/))[^"'<>|*?:\n\\/])*?[\\/])*?[^\s"'<>|*?:\\/](?:(?!\s+(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/))[^"'<>|*?:\n\\/])*?\.(?:png|jpe?g|gif|webp|avif|mp4|webm|mov|m4v)(?![\w-]|\.\w)/gi;
  // Browser pages such as chrome://settings, which only the browser itself may open.
  const browserPages=/(?<![\w.+-])(?:chrome|edge|brave):\/\/[a-z0-9-]+(?:[/#][\w/.#-]*)?/g;
  const isBrowserPage=uri=>/^(?:chrome|edge|brave):\/\//.test(uri);
  const mediaFile=/\.(?:png|jpe?g|gif|webp|avif|mp4|webm|mov|m4v)$/i,videoFile=/\.(?:mp4|webm|mov|m4v)$/i,
    // Browsers play animated images and videos, including formats desktop viewers may lack.
    tabFile=/\.(?:mp4|webm|mov|m4v|avif|gif)$/i;
  const imageFile=/\.(?:png|jpe?g|gif|webp|avif|svg)$/i,htmlFile=/\.html?$/i;
  // Relative media paths, such as out/shot.png, without spaces since they have no root to start from.
  const relativeMedia=/(?<![\w.~:%/\\@-])(?:[^\s"'`<>|*?:;,()[\]{}\\/]+[\\/])*[^\s"'`<>|*?:;,()[\]{}\\/]+\.(?:png|jpe?g|gif|webp|avif|mp4|webm|mov|m4v)(?![\w-]|\.\w)/gi;
  // Other relative paths: a file with a 2-8 character extension (so e.g. stays text), or a
  // folder ending in a slash (so and/or stays text). Only media previews; any of them opens.
  const segment=String.raw`[^\s"'\`<>|*?:;,()[\]{}\\/]+`;
  const relativePath=new RegExp(String.raw`(?<![\w.~:%/\\@-])(?:(?:${segment}[\\/])*${segment}\.[A-Za-z][A-Za-z0-9]{1,7}|(?:${segment}[\\/])+)(?![\w-]|\.\w)`,'g');
  const relativeFile=path=>!/^(?:[A-Za-z]:|[\\/~]|[a-z][\w+.-]*:)/i.test(path);
  // The pane that printed a relative path is unknown, so the relay tries each pane directory in
  // this session. Found paths are kept; misses are retried, since the file may appear later.
  const located=new Map();
  function locate(path){
    if(!located.has(path))located.set(path,fetch(`/api/hosts/${encodeURIComponent(host)}/resolve-file?session=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}`)
      .then(response=>response.ok?response.json():null).then(body=>body?.path||null,()=>null)
      .then(found=>{if(!found)located.delete(path);return found;}));
    return located.get(path);
  }
  let preview,previewTimer,previewId=0;
  function hidePreview(){previewId++;clearTimeout(previewTimer);preview?.remove();preview=null;}
  function showPreview(event,uri){
    hidePreview();
    let path;try{path=filePathOf(uri);}catch{return;}
    const relative=!path&&relativeFile(uri);
    if(relative)path=uri;
    if(!path||!mediaFile.test(path))return;
    try{if(localStorage.getItem('switchboard-media-previews')!=='true')return;}catch{return;}
    const {clientX:x,clientY:y}=event,{innerWidth:width,innerHeight:height}=window,id=previewId;
    // A relative path that no pane holds is likely prose, so it shows nothing rather than an error.
    previewTimer=setTimeout(()=>relative?locate(path).then(found=>{if(found&&id===previewId)show(found);}):show(path),300);
    function show(path){
      const box=preview=document.createElement('div'),media=document.createElement(videoFile.test(path)?'video':'img');
      if(media.tagName==='VIDEO')Object.assign(media,{muted:true,autoplay:true,loop:true,playsInline:true});else media.alt=path;
      media.style.cssText='display:block;max-width:min(480px,60vw);max-height:min(320px,45vh);border-radius:4px';
      // Opens away from the nearest edges so it never covers the hovered path.
      box.style.cssText=`position:fixed;z-index:1000;pointer-events:none;padding:4px;background:#111318;color:#b5bfd0;font:13px system-ui;border:1px solid #465674;border-radius:6px;box-shadow:0 6px 24px #0009;${x>width/2?`right:${width-x+12}px`:`left:${x+12}px`};${y>height/2?`bottom:${height-y+12}px`:`top:${y+16}px`}`;
      media.onerror=()=>box.replaceChildren('Preview unavailable');
      media.src=`/api/hosts/${encodeURIComponent(host)}/file?path=${encodeURIComponent(path)}`;
      box.append(media);document.body.append(box);
    }
  }
  function pathsIn(line) {
    const media = [...line.matchAll(mediaPaths)].map(match => ({index:match.index,text:match[0]}));
    // A media path with spaces wins over the shorter plain path inside it.
    const overlaps = (path,others) => others.some(m => path.index < m.index+m.text.length && m.index < path.index+path.text.length);
    const plain = [...line.matchAll(filePath)].map(match => ({index:match.index,text:match[0].replace(/[.`]+$/,'')}))
      .filter(path => !overlaps(path,media));
    const relativeMediaPaths = [...line.matchAll(relativeMedia)].map(match => ({index:match.index,text:match[0]}))
      .filter(path => !overlaps(path,[...media,...plain]));
    const relative = [...relativeMediaPaths,...[...line.matchAll(relativePath)].map(match => ({index:match.index,text:match[0]}))
      .filter(path => !overlaps(path,[...media,...plain,...relativeMediaPaths]))];
    return {media,plain,relative};
  }
  // Joins a wrapped path's rows. shortcut: wide characters shift the cells after them.
  const fileLinks = term => ({provideLinks(y,callback) {
    const buffer = term.buffer.active;
    let start = y-1, line = '';
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
    let row = start;
    do line += buffer.getLine(row).translateToString(true).padEnd(term.cols); while (buffer.getLine(++row)?.isWrapped);
    const cell = index => ({x:index%term.cols+1,y:start+Math.floor(index/term.cols)+1});
    const {media,plain,relative} = pathsIn(line);
    const pages = [...line.matchAll(browserPages)].map(match => ({index:match.index,text:match[0].replace(/[.`]+$/,'')}));
    const links = [...media,...plain,...relative,...pages].map(({index,text}) =>
      ({range:{start:cell(index),end:cell(index+text.length-1)},text,activate:open,hover:showPreview,leave:hidePreview}))
      .filter(link => link.range.start.y <= y && y <= link.range.end.y);
    callback(links.length ? links : undefined);
  }});
  // Modifiers belong to the viewing browser, regardless of the terminal host OS.
  const linkGesture = event => event.button===0 && !event.altKey && (event.metaKey || event.ctrlKey || event.shiftKey);
  function openMedia(path){
    if(window.parent===window||!(parent.SwitchboardOpenMedia||parent.SwitchboardOpenImages))return false;
    const buffer=window.term?.buffer?.active,paths=[],seen=new Set();
    // Keep the carousel tied to the current terminal, including its recent scrollback.
    for(let row=Math.max(0,(buffer?.length||0)-10000);row<(buffer?.length||0);){
      let line='';
      do{
        const text=buffer.getLine(row++)?.translateToString(true)||'',wrapped=row<buffer.length&&buffer.getLine(row)?.isWrapped;
        line+=wrapped?text.padEnd(window.term.cols):text;
        if(!wrapped)break;
      }while(row<buffer.length);
      const found=pathsIn(line);
      for(const entry of [...found.media,...found.plain,...found.relative].sort((a,b)=>a.index-b.index)){
        if(!(imageFile.test(entry.text)||videoFile.test(entry.text))||seen.has(entry.text))continue;
        seen.add(entry.text);paths.push({path:entry.text,relative:relativeFile(entry.text)});
      }
    }
    if(!seen.has(path))paths.push({path,relative:relativeFile(path)});
    hidePreview();(parent.SwitchboardOpenMedia||parent.SwitchboardOpenImages)(host,path,paths,locate);return true;
  }
  function open(event,uri) {
    if (!linkGesture(event)) return;
    event.preventDefault();event.stopImmediatePropagation();
    try {
      if(isBrowserPage(uri)){
        if(window.parent===window||!parent.SwitchboardOpenBrowserPage)throw Error('Browser pages open from the Switchboard page');
        parent.SwitchboardOpenBrowserPage(uri);return;
      }
      const path=filePathOf(uri),newTab=event.metaKey||event.ctrlKey,relative=!path&&relativeFile(uri);
      if((path||relative)&&(imageFile.test(path||uri)||videoFile.test(path||uri))&&openMedia(path||uri))return;
      // Standalone terminal viewers can still open media in a browser tab.
      if((path||relative)&&!(newTab&&(tabFile.test(path||uri)||htmlFile.test(path||uri)))){
        if(window.parent===window||!parent.SwitchboardOpenFile)throw Error('Files open from the Switchboard page');
        if(path){parent.SwitchboardOpenFile(host,path);return;}
        locate(uri).then(found=>found?parent.SwitchboardOpenFile(host,found):console.warn('Switchboard link: no pane in this session holds',uri));
        return;
      }
      const fileUrl=file=>new URL(`/api/hosts/${encodeURIComponent(host)}/file?path=${encodeURIComponent(file)}`,location.href).href;
      const url=relative?null:path?fileUrl(path):resolve(uri);
      if(!path&&!relative&&window.parent!==window&&parent.SwitchboardOpenInApp?.(host,url))return;
      if(newTab){
        // Open just after the click, not during it: Chrome opens a tab in the background
        // while the click that opened it holds Cmd/Ctrl. The click still allows the popup.
        // No popup features: use the browser's normal new-tab behavior.
        setTimeout(()=>{
          try{
            const tab=window.open('about:blank','_blank');
            if(!tab)throw Error('The browser blocked the new tab');
            tab.opener=null;
            const go=href=>{const link=tab.document.createElement('a');link.href=href;link.rel='noreferrer';link.click();};
            // Reserve the tab before resolving a relative path or asking for an isolated HTML URL.
            if(htmlFile.test(path||uri)&&(path||relative)){
              Promise.resolve(relative?locate(uri):path).then(async found=>{
                if(!found)throw Error(`File not found: ${uri}`);
                const response=await fetch(`/api/hosts/${encodeURIComponent(host)}/html`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:found})});
                if(!response.ok)throw Error(await response.text());
                go((await response.json()).url);
              }).catch(error=>{tab.document.body.textContent=`Could not open HTML: ${error.message}`;});
            }else if(relative)locate(uri).then(found=>{if(found)go(fileUrl(found));else{tab.close();console.warn('Switchboard link: no pane in this session holds',uri);}});
            else go(url);
            tab.focus();
          }catch(error){console.warn('Switchboard link:',error.message);}
        },0);
      }else{
        const link=document.createElement('a');
        link.href=url;link.target='_blank';link.rel='noopener noreferrer';
        // Omit Shift, which browsers otherwise interpret as a new window.
        link.click();
      }
    } catch(error) { console.warn('Switchboard link:',error.message); }
  }
  function atPointer(event,term) {
    const core=term?._core, linkifier=core?.linkifier || core?._linkifier2;
    const position=linkifier?._positionFromMouseEvent?.(event,term.element,core._mouseService);
    if(!position)return null;
    const contains=link=>{
      const start=link.range.start.y*term.cols+link.range.start.x;
      const end=link.range.end.y*term.cols+link.range.end.x;
      const point=position.y*term.cols+position.x;
      return start<=point&&point<=end;
    };
    const cached=linkifier?._currentLink?.link;
    if(cached&&contains(cached))return cached.text;
    let found;
    const providers=core?._linkProviderService?.linkProviders || core?._linkifier2?._linkProviders || [];
    for(const provider of providers){
      provider.provideLinks(position.y,links=>{if(!found)found=links?.find(contains)?.text;});
      if(found)break;
    }
    return found;
  }
  let down;
  window.addEventListener('mousedown',event=>{
    if(!linkGesture(event)||!event.target.closest?.('#terminal')||event.target.closest?.('.switchboard-thumbnails'))return;
    const uri=atPointer(event,window.term);
    if(uri){down={uri,x:event.clientX,y:event.clientY};event.preventDefault();event.stopImmediatePropagation();}
  },true);
  window.addEventListener('mouseup',event=>{
    const previous=down;down=null;
    if(!previous||!linkGesture(event))return;
    if(Math.hypot(event.clientX-previous.x,event.clientY-previous.y)>5)return;
    open(event,previous.uri);
  },true);
  window.addEventListener('blur',()=>{down=null;hidePreview();});
  const timer=setInterval(()=>{
    const term=window.term;if(!term)return;clearInterval(timer);
    if(term.options.linkHandler)term.options.linkHandler={...term.options.linkHandler,activate:open,hover:showPreview,leave:hidePreview};
    term.registerLinkProvider?.(fileLinks(term));
    for(const entry of term._addonManager?._addons || []){
      const addon=entry.instance;
      if(addon?._linkProvider?._handler){addon._handler=open;addon._linkProvider._handler=open;}
    }
  },25);
  // Shared with thumbnails.js, which shows the media paths on screen without a hover.
  window.__switchboardMedia={
    paths:line=>{const {media,relative}=pathsIn(line);return [...media,...relative.filter(path=>mediaFile.test(path.text)).map(path=>({...path,relative:true}))].sort((a,b)=>a.index-b.index);},
    locate,
    url:path=>`/api/hosts/${encodeURIComponent(host)}/file?path=${encodeURIComponent(path)}`,
    isVideo:path=>videoFile.test(path),
    open:(path,event)=>{
      if((imageFile.test(path)||videoFile.test(path))&&openMedia(path))return;
      if(event?.metaKey||event?.ctrlKey)open(event,path);
      else if(window.parent!==window)parent.SwitchboardOpenFile?.(host,path);
    },
  };
  window.__switchboardResolveLink=resolve;
  window.__switchboardBrowserPages=line=>[...line.matchAll(browserPages)].map(match=>match[0].replace(/[.`]+$/,''));
  window.__switchboardFilePaths=line=>[...line.matchAll(filePath)].map(match=>match[0].replace(/[.`]+$/,''));
})();
