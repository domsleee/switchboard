// Keep the last sidebar visible while discovery and terminal sockets warm up.
(() => {
  const key='switchboard-startup-tabs',until=Date.now()+5000;
  let snapshot={hosts:[],tabs:[]},latest=null,listed=null,finished=false,savedContent=null,savedAt=0;
  try{
    const saved=JSON.parse(localStorage.getItem(key));
    if(saved?.version===1&&saved.savedAt<=Date.now()&&Date.now()-saved.savedAt<86400000&&Array.isArray(saved.hosts)&&Array.isArray(saved.tabs)
      &&saved.hosts.every(host=>typeof host.id==='string'&&typeof host.name==='string')
      &&saved.tabs.every(tab=>typeof tab.host==='string'&&typeof tab.session==='string'&&Number.isInteger(tab.id)&&tab.id>=0&&Number.isInteger(tab.position)&&typeof tab.name==='string'
        &&Array.isArray(tab.panes)&&tab.panes.every(pane=>Number.isInteger(pane?.pane_id))))snapshot=saved;
  }catch(_){}
  const identity=tab=>JSON.stringify([tab.host,tab.session,'tab',tab.id]);
  const held=new Map(snapshot.tabs.map(tab=>[identity(tab),tab]));
  const order=[...held.keys()];
  const active=()=>!finished&&Date.now()<until;
  globalThis.SwitchboardStartup={
    snapshot,active,
    discover(hosts){listed=new Set(hosts.map(host=>host.id));},
    order(){return active()?order:[];},
    merge(tabs){
      latest=tabs;
      if(!active())return tabs;
      for(const tab of tabs)held.set(identity(tab),tab);
      const supplied=new Set(tabs.map(identity));
      return [...tabs,...[...held].filter(([id])=>!supplied.has(id)).map(([,tab])=>tab)];
    },
    finish(){finished=true;return {tabs:latest,listed};},
    save(hosts,items,groups){
      const tabs=items.filter(item=>!item.tab.pending&&Number.isInteger(item.tab.id)).map(({entry,tab,title})=>({
        host:entry.host,session:entry.name,id:tab.id,position:tab.position,name:tab.name,cachedTitle:title,
        panes:tab.panes.map(pane=>({pane_id:pane.pane_id,is_plugin:pane.is_plugin,tab_position:tab.position})),
      }));
      const content={version:1,hosts:hosts.map(host=>({id:host.id,name:host.name,local:host.local,group:groups[host.id]})),tabs};
      const serialized=JSON.stringify(content),now=Date.now();
      if(serialized===savedContent&&now-savedAt<60000)return;
      try{localStorage.setItem(key,JSON.stringify({...content,savedAt:now}));savedContent=serialized;savedAt=now;}catch(_){}
    },
  };
})();
