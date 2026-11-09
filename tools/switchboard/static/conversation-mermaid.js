// Mermaid code blocks become diagrams. Transcript text is untrusted, so the finished SVG is only
// ever shown through an <img>, where it cannot run scripts, load anything or reach this page.
// To update Mermaid, replace the versioned file and MERMAID_LIBRARY in switchboard_relay.rs.
(() => {
  const LIBRARY='/mermaid-12.2.0.min.js',MAX_SOURCE=50000,MAX_REMEMBERED=64;
  // An image cannot use the page's web font, so measure and draw with fonts every system has.
  const FONT='-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
  const CONFIG={startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:MAX_SOURCE,theme:'base',darkMode:true,fontFamily:FONT,fontSize:14,
    // SVG text instead of HTML labels: Safari does not draw HTML inside an SVG image.
    htmlLabels:false,flowchart:{htmlLabels:false,curve:'basis',padding:14,nodeSpacing:44,rankSpacing:52},
    sequence:{mirrorActors:false,boxMargin:8,messageMargin:32},
    themeVariables:{darkMode:true,dropShadow:'none',background:'#0c0d0f',fontFamily:FONT,fontSize:'14px',
      primaryColor:'#23252c',primaryTextColor:'#ececf1',primaryBorderColor:'#565965',
      secondaryColor:'#1d2a3a',secondaryTextColor:'#dfe8f5',secondaryBorderColor:'#46688d',
      tertiaryColor:'#17181c',tertiaryTextColor:'#dcdce1',tertiaryBorderColor:'#3a3b42',
      lineColor:'#9a9aa6',textColor:'#dcdce1',mainBkg:'#23252c',nodeBorder:'#565965',
      clusterBkg:'#15161a',clusterBorder:'#3a3b42',titleColor:'#ececf1',edgeLabelBackground:'#0c0d0f',
      noteBkgColor:'#3a3320',noteTextColor:'#f1e6c6',noteBorderColor:'#7a6a3a',
      actorBkg:'#23252c',actorBorder:'#565965',actorTextColor:'#ececf1',actorLineColor:'#565965',signalColor:'#c2c2ca',signalTextColor:'#dcdce1',labelBoxBkgColor:'#23252c',labelBoxBorderColor:'#565965',labelTextColor:'#ececf1',loopTextColor:'#c2c2ca',activationBkgColor:'#2f3440',activationBorderColor:'#6d7283',sequenceNumberColor:'#0c0d0f',
      pie1:'#6d9bd1',pie2:'#d9a066',pie3:'#7dbb8f',pie4:'#b89adf',pie5:'#d98a9b',pie6:'#6fbdbd',pie7:'#c9b76a',pie8:'#8e8e98',pieStrokeColor:'#0c0d0f',pieOuterStrokeColor:'#0c0d0f',pieTitleTextColor:'#ececf1',pieSectionTextColor:'#0c0d0f',pieLegendTextColor:'#dcdce1',pieOpacity:'1',
      sectionBkgColor:'#1a1b20',altSectionBkgColor:'#0c0d0f',sectionBkgColor2:'#15161a',gridColor:'#3a3b42',todayLineColor:'#d98a9b',
      taskBkgColor:'#2b3f57',taskBorderColor:'#46688d',taskTextColor:'#ececf1',taskTextLightColor:'#ececf1',taskTextDarkColor:'#ececf1',taskTextOutsideColor:'#dcdce1',taskTextClickableColor:'#8fc4ff',
      activeTaskBkgColor:'#3d5f86',activeTaskBorderColor:'#6d9bd1',doneTaskBkgColor:'#2c3a31',doneTaskBorderColor:'#5f8a6e',critBkgColor:'#6b2f37',critBorderColor:'#d98a9b',
      ...Object.fromEntries(['#2b3f57','#4a3a26','#2c4a38','#3f3358','#553040','#25494b','#4a4426','#34363f','#2f4a66','#5a4530','#35573f','#4b3d68'].flatMap((color,i)=>[['cScale'+i,color],['cScaleInv'+i,'#8e8e98'],['cScaleLabel'+i,'#ececf1']])),
      ...Object.fromEntries(['#6d9bd1','#d9a066','#7dbb8f','#b89adf','#d98a9b','#6fbdbd','#c9b76a','#8e8e98'].flatMap((color,i)=>[['git'+i,color],['gitInv'+i,'#0c0d0f'],['gitBranchLabel'+i,'#0c0d0f']])),
      commitLabelColor:'#dcdce1',commitLabelBackground:'#23252c',tagLabelColor:'#ececf1',tagLabelBackground:'#2b3f57',tagLabelBorder:'#46688d'}};
  const remembered=new Map(),running=new Map();
  let library,sequence=0,sandbox;
  const element=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  function load(){
    return library||=new Promise((resolve,reject)=>{
      const script=element('script');script.src=LIBRARY;
      script.onload=()=>{window.mermaid.initialize(CONFIG);resolve(window.mermaid);};
      script.onerror=()=>{library=null;script.remove();reject(new Error('Mermaid did not load'));};
      document.head.append(script);
    });
  }
  // Text must be laid out to be measured, away from the transcript and its scroll position.
  function workspace(){
    if(!sandbox?.isConnected){sandbox=element('div');sandbox.setAttribute('aria-hidden','true');sandbox.style.cssText='position:fixed;left:-20000px;top:0;width:760px;visibility:hidden;pointer-events:none';document.body.append(sandbox);}
    return sandbox;
  }
  // Mermaid returns HTML-flavoured markup, which an SVG image, being XML, would reject.
  function image(markup){
    const svg=new DOMParser().parseFromString(markup,'text/html').querySelector('svg');
    const [,,viewWidth,viewHeight]=(svg?.getAttribute('viewBox')||'').trim().split(/[\s,]+/).map(Number);
    const width=viewWidth||parseFloat(svg?.getAttribute('width')),height=viewHeight||parseFloat(svg?.getAttribute('height'));
    if(!(width>0&&height>0))throw new Error('Mermaid drew nothing');
    svg.setAttribute('width',width);svg.setAttribute('height',height);svg.removeAttribute('style');
    return {url:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(svg)),width,height};
  }
  function remember(source,result){remembered.delete(source);remembered.set(source,result);if(remembered.size>MAX_REMEMBERED)remembered.delete(remembered.keys().next().value);return result;}
  function draw(source){
    if(remembered.has(source))return Promise.resolve(remember(source,remembered.get(source)));
    if(running.has(source))return running.get(source);
    const job=load().then(async mermaid=>{
      const id='switchboard-mermaid-'+(++sequence);
      try{const {svg}=await mermaid.render(id,source,workspace());return remember(source,image(svg));}
      catch(error){return remember(source,{error:String(error?.message||error).split('\n')[0]});}
      finally{document.getElementById(id)?.remove();document.getElementById('d'+id)?.remove();}
    }).catch(error=>({error:error.message})).finally(()=>running.delete(source));
    running.set(source,job);return job;
  }
  function show(card,pre,result){
    if(!card.isConnected&&!card.parentNode)return;
    const bar=card.querySelector('.conversation-code-bar'),label=bar.firstElementChild,copy=bar.querySelector('button');
    if(result.error){if(!label.querySelector('.conversation-mermaid-note')){const note=element('span','not rendered','conversation-mermaid-note');note.title=result.error;label.append(note);}return;}
    const open=element('button',undefined,'conversation-mermaid-diagram'),img=element('img');
    open.type='button';open.dataset.conversationMediaUrl=result.url;open.setAttribute('aria-label','Expand diagram');
    img.src=result.url;img.alt='Mermaid diagram';img.width=result.width;img.height=result.height;img.draggable=false;img.decoding='async';
    open.append(img);open.onclick=()=>window.SwitchboardConversationMedia.expand([{url:result.url,label:'Mermaid diagram',kind:'image',aspect:result.width/result.height,file:'mermaid-diagram.svg'}],0,open);
    const toggle=element('button','Code','conversation-mermaid-toggle'),actions=element('span',undefined,'conversation-code-actions');
    toggle.type='button';toggle.setAttribute('aria-pressed','false');
    toggle.onclick=()=>{const code=pre.hidden;pre.hidden=!code;open.hidden=code;toggle.textContent=code?'Diagram':'Code';toggle.setAttribute('aria-pressed',String(code));if(code)pre.classList.toggle('fits',pre.scrollWidth<=pre.clientWidth+1);};
    copy.replaceWith(actions);actions.append(toggle,copy);pre.hidden=true;card.insertBefore(open,pre);
  }
  // Long histories draw a diagram only as the reader nears it.
  const waiting=new WeakMap();
  const nearby=globalThis.IntersectionObserver?new IntersectionObserver(entries=>{
    for(const entry of entries){if(!entry.isIntersecting)continue;nearby.unobserve(entry.target);waiting.get(entry.target)?.();}
  },{rootMargin:'800px 0px',scrollMargin:'800px 0px'}):null;
  function attach(card,pre,text){
    const source=text.trim();if(!source||source.length>MAX_SOURCE)return;
    if(remembered.has(source))return show(card,pre,remember(source,remembered.get(source)));
    const start=()=>draw(source).then(result=>show(card,pre,result));
    if(!nearby)return void start();
    waiting.set(card,start);nearby.observe(card);
  }
  window.SwitchboardConversationMermaid={attach};
})();
