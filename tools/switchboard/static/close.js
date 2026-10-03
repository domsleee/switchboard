// Capture the context-menu target before opening the native confirmation dialog.
(() => {
  let target;
  const dialog=$('close-tab-dialog'),confirm=$('confirm-close-tab'),error=$('close-tab-error');
  $('close-tab').onclick=()=>{
    const item=contextItem;
    closeTabMenu();
    if(!item)return;
    const pane=item.entry.state.panes.find(p=>p.tab_position===item.tab.position);
    if(!pane){setStatus('That tab is no longer available.',true);return;}
    target={host:item.entry.host,key:item.key,session:item.entry.name,pane_id:pane.pane_id,is_plugin:pane.is_plugin};
    $('close-tab-name').textContent=`${SwitchboardTitles.tabTitle(item.entry.state,item.tab)} — ${hosts.get(item.entry.host)?.name || item.entry.host}`;
    error.textContent='';confirm.disabled=false;
    dialog.showModal();$('cancel-close-tab').focus();
  };
  $('cancel-close-tab').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{target=null;});
  confirm.onclick=async()=>{
    if(!target||confirm.disabled)return;
    const closing=target;
    confirm.disabled=true;error.textContent='';
    try{
      const {host,key,...payload}=closing;
      const response=await fetch(`/api/hosts/${encodeURIComponent(host)}/close-tab`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
      });
      if(!response.ok)throw new Error((await response.text()).slice(0,240)||`HTTP ${response.status}`);
      delete ready[key];saveReady();
      delete archived[key];localStorage.setItem('switchboard-archived',JSON.stringify(archived));
      if(target===closing)dialog.close();
      await refresh();
    }catch(failure){
      if(target===closing)error.textContent=`Close failed: ${failure.message}`;
      else setStatus(`Close failed: ${failure.message}`,true);
    }finally{if(target===closing)confirm.disabled=false;}
  };
})();
