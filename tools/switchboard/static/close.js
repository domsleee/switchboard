// Capture the context-menu target before opening the native confirmation dialog.
(() => {
  let target;
  const dialog=$('close-tab-dialog'),confirm=$('confirm-close-tab'),error=$('close-tab-error');
  $('close-tab').onclick=()=>{
    const item=contextItem;
    closeTabMenu();
    if(!item)return;
    if(item.tab.pending){setStatus('This terminal is still connecting its tab actions. Try Close again shortly.',true);return;}
    if(!Number.isInteger(item.tab.id)){setStatus('That tab is no longer available.',true);return;}
    target={host:item.entry.host,key:item.key,session:item.entry.name,tab_id:item.tab.id,entry:item.entry};
    $('close-tab-name').textContent=`${tabTitle(item)} · ${hosts.get(item.entry.host)?.name || item.entry.host}`;
    error.textContent='';confirm.disabled=false;
    dialog.showModal();confirm.focus();
  };
  $('cancel-close-tab').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{target=null;});
  confirm.onclick=async()=>{
    if(!target||confirm.disabled)return;
    const closing=target;
    confirm.disabled=true;error.textContent='';
    const tabs=allTabs(),index=tabs.findIndex(item=>item.key===closing.key);
    const wasSelected=selected===closing.key,next=tabs[index+1]||tabs[index-1];
    closing.pending=true;
    closing.entry.closeError=null;
    closing.entry.closingTabs??=new Map();
    closing.entry.closingTabs.set(closing.tab_id,closing);
    dialog.close();
    if(wasSelected&&next)activate(next,false);else render();
    const replacement=selected;
    try{
      const {host,key,session,tab_id}=closing;
      const response=await fetch(`/api/hosts/${encodeURIComponent(host)}/close-tab`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session,tab_id}),
      });
      if(!response.ok)throw new Error((await response.text()).slice(0,240)||`HTTP ${response.status}`);
      closing.pending=false;
      delete ready[key];saveReady();
      delete archived[key];localStorage.setItem('switchboard-archived',JSON.stringify(archived));
      render();
    }catch(failure){
      closing.entry.closeError=`Close failed: ${failure.message}`;
      closing.entry.closingTabs.delete(closing.tab_id);
      if(wasSelected&&selected===replacement&&closing.entry.name===closing.session){
        const item=allTabs().find(item=>item.key===closing.key);
        if(item)activate(item,false);else render();
      }else render();
      setStatus(closing.entry.closeError,true);
    }
  };
})();
