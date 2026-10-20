// Close immediately, like Ctrl+D in a shell. Archive hides a tab without stopping it.
function closeTabTarget(item){
  if(item.entry.cached||!Number.isInteger(item.tab.id))return null;
  if(!item.tab.pending)return {tab_id:item.tab.id};
  return item.entry.state?.panes?.some(pane=>!pane.is_plugin&&pane.pane_id===item.tab.id&&pane.tab_position===item.tab.position)
    ? {pane_id:item.tab.id}:null;
}
(() => {
  $('close-tab').onclick=async()=>{
    const item=contextItem;
    closeTabMenu();
    if(!item)return;
    const target=closeTabTarget(item);
    if(!target){setStatus('This terminal is still connecting. Try Close again shortly.',true);return;}
    const closing={host:item.entry.host,key:item.key,session:item.entry.name,...target,entry:item.entry};
    if(closing.entry.closingTabs?.get(closing.key)?.pending)return;
    const tabs=allTabs(),index=tabs.findIndex(item=>item.key===closing.key);
    const wasSelected=selected===closing.key,next=tabs[index+1]||tabs[index-1];
    closing.pending=true;
    closing.entry.closeError=null;
    closing.entry.closingTabs??=new Map();
    closing.entry.closingTabs.set(closing.key,closing);
    if(wasSelected&&next)activate(next,false);else render();
    try{
      const {host,session}=closing;
      const response=await fetch(`/api/hosts/${encodeURIComponent(host)}/close-tab`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session,...target}),signal:AbortSignal.timeout(15000),
      });
      if(!response.ok)throw new Error((await response.text()).slice(0,240)||`HTTP ${response.status}`);
      closing.pending=false;
      delete ready[closing.key];saveReady();
      delete archived[closing.key];localStorage.setItem('switchboard-archived',JSON.stringify(archived));
      render();
    }catch(failure){
      closing.entry.closeError=['AbortError','TimeoutError'].includes(failure.name)
        ? 'Close timed out; delivery is uncertain. Check the tab before trying again.'
        : `Close failed: ${failure.message}`;
      closing.entry.closingTabs.delete(closing.key);
      // Restore the card, not keyboard focus: the user may already be elsewhere.
      render();
      setStatus(closing.entry.closeError,true);
    }
  };
})();
