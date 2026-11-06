// Transcript content is untrusted. Build DOM nodes, never insert transcript HTML.
(() => {
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const imageExt=/\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#].*)?$/i,videoExt=/\.(?:mp4|webm|mov|m4v)(?:[?#].*)?$/i;
  function resolve(reference,{host,project},embedded=false){
    const originalReference=reference;
    if(typeof reference!=='string'||!reference||/[\x00-\x1f\x7f]/.test(reference))return null;
    if(embedded&&/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(reference))return reference;
    if(/^https?:\/\//i.test(reference)){
      try{const url=new URL(reference);if(url.username||url.password)return null;
        // A loopback URL in a remote transcript is not a URL on the viewing phone.
        if(['localhost','127.0.0.1','[::1]'].includes(url.hostname))return null;
        return url.href;}catch{return null;}
    }
    if(reference.startsWith('//')||reference.startsWith('\\\\'))return null;
    if(/^file:\/\//i.test(reference)){try{const url=new URL(reference);if(url.hostname&&url.hostname!=='localhost')return null;reference=decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/,'$1');}catch{return null;}}
    else if(/^[a-z][\w+.-]*:/i.test(reference)&&!(/^[A-Za-z]:[\\/]/.test(reference)))return null;
    try{if(!/^file:/i.test(originalReference))reference=decodeURIComponent(reference);}catch{return null;}
    reference=reference.replace(/\\/g,'/');
    if(!/^(?:\/|~\/|[A-Za-z]:\/)/.test(reference)){
      if(!project||! /^(?:\/|~[\\/]|[A-Za-z]:[\\/])/.test(project))return null;
      reference=project.replace(/\\/g,'/').replace(/\/$/,'')+'/'+reference;
    }
    // Keep literal # and ? in filesystem names; URLSearchParams escapes them.
    return `/api/hosts/${encodeURIComponent(host)}/file?${new URLSearchParams({path:reference})}`;
  }
  let dialog,stage,counter,original,zoomButton,previous,next,items=[],index=0,zoom=1,focusBefore;
  function pause(root){for(const video of root?.querySelectorAll('video')||[])video.pause();}
  function close(){if(!dialog?.open)return;pause(dialog);dialog.close();stage.replaceChildren();items=[];focusBefore?.focus();}
  function show(){
    pause(stage);stage.replaceChildren();zoom=1;const item=items[index];counter.textContent=`${index+1} / ${items.length} · ${item.label}`;original.href=item.url;
    previous.disabled=next.disabled=items.length<2;zoomButton.hidden=item.kind==='video';zoomButton.textContent='Zoom in';
    const media=node(item.kind==='video'?'video':'img');media.src=item.url;
    if(item.kind==='video'){media.controls=true;media.playsInline=true;media.preload='metadata';media.setAttribute('aria-label',item.label);}else media.alt=item.label;
    media.onerror=()=>{stage.replaceChildren(node('p','Preview unavailable. Try Open original.'));};stage.append(media);
  }
  function expand(gallery,selected){
    if(!dialog){dialog=node('dialog');dialog.className='conversation-media-dialog';dialog.setAttribute('aria-label','Media viewer');const header=node('header');counter=node('span');original=node('a','Open original');original.target='_blank';original.rel='noopener noreferrer';const dismiss=node('button','Close');dismiss.onclick=close;header.append(counter,original,dismiss);
      stage=node('div');stage.className='conversation-media-stage';const controls=node('footer');previous=node('button','← Previous');next=node('button','Next →');zoomButton=node('button','Zoom in');previous.onclick=()=>{index=(index-1+items.length)%items.length;show();};next.onclick=()=>{index=(index+1)%items.length;show();};
      zoomButton.onclick=()=>{zoom=zoom===1?2:1;const img=stage.querySelector('img');if(img){img.style.maxWidth=zoom===1?'100%':'none';img.style.maxHeight=zoom===1?'100%':'none';img.style.width=zoom===1?'auto':Math.max(img.naturalWidth,stage.clientWidth*1.5)+'px';}zoomButton.textContent=zoom===1?'Zoom in':'Fit image';};controls.append(previous,zoomButton,next);dialog.append(header,stage,controls);document.body.append(dialog);
      dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('click',e=>{if(e.target===dialog)close();});dialog.addEventListener('keydown',e=>{if(e.target.tagName==='VIDEO')return;if(e.key==='ArrowRight'){e.preventDefault();next.click();}if(e.key==='ArrowLeft'){e.preventDefault();previous.click();}});
    }
    items=gallery;index=selected;focusBefore=document.activeElement;if(!dialog.open)dialog.showModal();show();
  }
  function media(reference,label,kind,context,gallery,embedded=false){
    const url=resolve(reference,context,embedded),wrapper=node('span');wrapper.className='conversation-media';
    if(!url){wrapper.append(node('span',`${label}: preview unavailable`));return wrapper;}
    const item={url,label,kind},position=gallery.push(item)-1;
    const caption=node('span',label);caption.className='conversation-media-caption';
    const open=node('a','Open original');open.href=url;open.target='_blank';open.rel='noopener noreferrer';
    if(kind==='video'){
      const video=node('video');video.src=url;video.controls=true;video.playsInline=true;video.preload='metadata';video.setAttribute('aria-label',label);video.onerror=()=>{caption.textContent=label+' · Video unavailable';};wrapper.append(video);
      const full=node('button','Expand video');full.type='button';full.onclick=()=>{video.pause();expand(gallery,position);};wrapper.append(full);
    }else{
      const button=node('button');button.type='button';button.className='conversation-image-button';button.setAttribute('aria-label','Preview '+label);const img=node('img');img.src=url;img.alt=label;img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';img.onerror=()=>{img.hidden=true;button.textContent='Image unavailable';};button.append(img);button.onclick=()=>expand(gallery,position);wrapper.append(button);
    }
    wrapper.append(caption,open);return wrapper;
  }
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
        if(event.tag==='table'){const wrap=node('div');wrap.className='conversation-table';current().append(wrap);wrap.append(element);}else current().append(element);
        stack.push(element);
      }else if(event.type==='end'){if(stack.length>1)stack.pop();}
      else if(event.type==='code')current().append(node('code',event.text||''));
      else if(event.type==='break')current().append(node('br'));
      else if(event.type==='rule')current().append(node('hr'));
      else if(event.type==='text')current().append(document.createTextNode(event.text||''));
    }
    for(const attachment of message.attachments||[]){
      if(attachment.unavailable){const unavailable=node('p',`${attachment.name||'Attachment'} · ${attachment.unavailable}`);unavailable.className='conversation-media-unavailable';parent.append(unavailable);}
      else parent.append(media(attachment.url,attachment.name||'Attachment',attachment.kind==='video'?'video':'image',context,gallery,true));
    }
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause(document);});
  window.SwitchboardConversationMedia={render,resolve,pause,close};
})();
