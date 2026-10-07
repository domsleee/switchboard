// Close immediately, like Ctrl+D in a shell. Archive hides a tab without stopping it.
(() => {
  $('close-tab').onclick=async()=>{
    const item=contextItem;
    closeTabMenu();
    if(!item)return;
    if(item.tab.pending){setStatus('This terminal is still connecting its tab actions. Try Close again shortly.',true);return;}
    if(!Number.isInteger(item.tab.id)){setStatus('That tab is no longer available.',true);return;}
    const closing={host:item.entry.host,key:item.key,session:item.entry.name,tab_id:item.tab.id,entry:item.entry};
    if(closing.entry.closingTabs?.get(closing.tab_id)?.pending)return;
    const tabs=allTabs(),index=tabs.findIndex(item=>item.key===closing.key);
    const wasSelected=selected===closing.key,next=tabs[index+1]||tabs[index-1];
    closing.pending=true;
    closing.entry.closeError=null;
    closing.entry.closingTabs??=new Map();
    closing.entry.closingTabs.set(closing.tab_id,closing);
    if(wasSelected&&next)activate(next,false);else render();
    try{
      const {host,key,session,tab_id}=closing;
      const response=await fetch(`/api/hosts/${encodeURIComponent(host)}/close-tab`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session,tab_id}),signal:AbortSignal.timeout(15000),
      });
      if(!response.ok)throw new Error((await response.text()).slice(0,240)||`HTTP ${response.status}`);
      closing.pending=false;
      delete ready[key];saveReady();
      delete archived[key];localStorage.setItem('switchboard-archived',JSON.stringify(archived));
      render();
    }catch(failure){
      closing.entry.closeError=['AbortError','TimeoutError'].includes(failure.name)
        ? 'Close timed out; delivery is uncertain. Check the tab before trying again.'
        : `Close failed: ${failure.message}`;
      closing.entry.closingTabs.delete(closing.tab_id);
      // Restore the card, not keyboard focus: the user may already be elsewhere.
      render();
      setStatus(closing.entry.closeError,true);
    }
  };
})();
