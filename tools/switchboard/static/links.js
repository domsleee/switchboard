// Open links in the viewing browser, synchronously within the user's gesture.
(() => {
  const host = location.pathname.split('/')[2];
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
  // Joins a wrapped path's rows. shortcut: wide characters shift the cells after them.
  const fileLinks = term => ({provideLinks(y,callback) {
    const buffer = term.buffer.active;
    let start = y-1, line = '';
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
    let row = start;
    do line += buffer.getLine(row).translateToString(true).padEnd(term.cols); while (buffer.getLine(++row)?.isWrapped);
    const cell = index => ({x:index%term.cols+1,y:start+Math.floor(index/term.cols)+1});
    const links = [...line.matchAll(filePath)].map(match => {
      const text = match[0].replace(/[.`]+$/,'');
      return {range:{start:cell(match.index),end:cell(match.index+text.length-1)},text,activate:open};
    }).filter(link => link.range.start.y <= y && y <= link.range.end.y);
    callback(links.length ? links : undefined);
  }});
  // Modifiers belong to the viewing browser, regardless of the terminal host OS.
  const linkGesture = event => event.button===0 && !event.altKey && (event.metaKey || event.ctrlKey || event.shiftKey);
  function open(event,uri) {
    if (!linkGesture(event)) return;
    event.preventDefault();event.stopImmediatePropagation();
    try {
      const path=filePathOf(uri);
      if(path){
        if(window.parent===window||!parent.SwitchboardOpenFile)throw Error('Files open from the Switchboard page');
        parent.SwitchboardOpenFile(host,path);return;
      }
      const url=resolve(uri);
      if(window.parent!==window&&parent.SwitchboardOpenInApp?.(host,url))return;
      if(event.metaKey||event.ctrlKey){
        // Open synchronously in this browser, then request foreground focus.
        // No popup features: use the browser's normal new-tab behavior.
        const tab=window.open('about:blank','_blank');
        if(!tab)throw Error('The browser blocked the new tab');
        tab.opener=null;
        const link=tab.document.createElement('a');
        link.href=url;link.rel='noreferrer';link.click();
        tab.focus();
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
    if(!linkGesture(event)||!event.target.closest?.('#terminal'))return;
    const uri=atPointer(event,window.term);
    if(uri){down={uri,x:event.clientX,y:event.clientY};event.preventDefault();event.stopImmediatePropagation();}
  },true);
  window.addEventListener('mouseup',event=>{
    const previous=down;down=null;
    if(!previous||!linkGesture(event))return;
    if(Math.hypot(event.clientX-previous.x,event.clientY-previous.y)>5)return;
    open(event,previous.uri);
  },true);
  window.addEventListener('blur',()=>{down=null;});
  const timer=setInterval(()=>{
    const term=window.term;if(!term)return;clearInterval(timer);
    if(term.options.linkHandler)term.options.linkHandler={...term.options.linkHandler,activate:open};
    term.registerLinkProvider?.(fileLinks(term));
    for(const entry of term._addonManager?._addons || []){
      const addon=entry.instance;
      if(addon?._linkProvider?._handler){addon._handler=open;addon._linkProvider._handler=open;}
    }
  },25);
  window.__switchboardResolveLink=resolve;
  window.__switchboardFilePaths=line=>[...line.matchAll(filePath)].map(match=>match[0].replace(/[.`]+$/,''));
})();
