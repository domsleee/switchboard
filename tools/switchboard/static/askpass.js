// `sudo -A` in a pane on this or a paired computer asks for its password here
// (zellij-client/src/switchboard_relay/askpass.rs). The typed password goes to the
// relay once, which hands it, or forwards it to the paired computer, only for the
// waiting helper. Closing the dialog any
// other way than Send cancels, so sudo fails at once instead of waiting.
function createAskpass({$,current,hostName,fetch,focusTerminal,otherDialogOpen}){
  const dialog=$('askpass-dialog'),input=$('askpass-password');
  // Answered here; the relay's next snapshot drops them.
  const handled=new Set();
  let shown=null,settled=false,closing=false;
  function answer({id,host},password){
    handled.add(id);
    return fetch('/api/askpass/answer',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(password===undefined?{host,id}:{host,id,password})}).catch(()=>{});
  }
  function close(){closing=true;dialog.close();}
  function update(requests){
    if(closing)return;
    // Answered in another window, timed out, or sudo was interrupted.
    if(shown&&!requests.some(r=>r.id===shown.id)){settled=true;close();return;}
    if(dialog.open||otherDialogOpen())return;
    const request=current();
    if(!request||handled.has(request.id))return;
    shown=request;settled=false;
    $('askpass-computer').textContent=hostName(request.host);
    $('askpass-command').textContent=request.command||'(unknown program)';
    $('askpass-prompt').textContent=request.prompt?.trim()||'Password';
    input.value='';
    dialog.showModal();input.focus();
  }
  $('askpass-form').addEventListener('submit',event=>{
    event.preventDefault();
    if(!shown||closing)return;
    const password=input.value;input.value='';
    settled=true;answer(shown,password);close();
  });
  $('askpass-cancel').onclick=()=>close();
  dialog.addEventListener('close',()=>{
    input.value='';
    if(shown&&!settled)answer(shown);
    shown=null;closing=false;
    focusTerminal();
  });
  return {update};
}
if(typeof module!=='undefined')module.exports={createAskpass};
else{
  const askpass=createAskpass({$,fetch:(...args)=>fetch(...args),
    current:()=>{const item=allTabs(true,true).find(item=>item.key===selected);return item&&askpassForTab(item);},
    hostName:host=>hosts.get(host)?.name||host,
    focusTerminal:()=>allTabs(true,true).find(item=>item.key===selected)?.entry.frame?.focus(),
    otherDialogOpen:()=>!!document.querySelector('dialog[open]')});
  globalThis.SwitchboardAskpass={update:()=>askpass.update(askpassRequests)};
  askpass.update(askpassRequests);
}
