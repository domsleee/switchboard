'use strict';
// Settings → Health, per computer: the Switchboard build it runs and whether its
// agents report their own status (with a Set up button for each that doesn't), then
// the update tasks from its ~/.config/switchboard/tasks.json. Task failures or
// changes get a row in the sidebar until someone clears them, on any computer.
(()=>{
  const byId=id=>document.getElementById(id);
  const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const marks={ok:'✓',changed:'↑',failed:'✗',timeout:'✗',interrupted:'✗',running:'…',waiting:'…',skipped:'–',never:'·'};
  let computers=[],loading=false,failed=false,fast=null;

  function ago(ms,now=Date.now()){
    const seconds=Math.max(0,(now-ms)/1000);
    if(seconds<60)return 'just now';
    for(const [unit,size] of [['d',86400],['h',3600],['m',60]])if(seconds>=size)return `${Math.floor(seconds/size)}${unit} ago`;
  }
  function until(ms,now=Date.now()){
    const seconds=(ms-now)/1000;
    if(seconds<60)return 'soon';
    for(const [unit,size] of [['d',86400],['h',3600],['m',60]])if(seconds>=size)return `in ${Math.round(seconds/size)}${unit}`;
  }
  function line(group){
    if(group.status==='waiting')return 'Waiting for agents to finish';
    if(group.status==='running')return 'Running…';
    if(group.status==='failed')return `${marks.failed} ${group.summary}`;
    if(group.status==='changed')return `${marks.changed} ${group.summary}`;
    if(group.status==='ok')return `${marks.ok} ${group.lastEnd?ago(group.lastEnd):'done'}`;
    if(group.status==='skipped')return `${marks.skipped} Skipped`;
    return 'Not run yet';
  }
  function logUrl(computer,group,task){
    const query=new URLSearchParams({group:group.name,task:task.name});
    if(computer.host)query.set('host',computer.host);
    return `/api/tasks/log?${query}`;
  }
  async function act(computer,group,action,task){
    const body={group:group.name,action};
    if(computer.host)body.host=computer.host;
    if(task)body.task=task.name;
    try{
      const response=await fetch('/api/tasks/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      if(!response.ok){const reply=await response.json().catch(()=>null);alertStatus(reply?.error||'Update task action failed');}
    }catch(_){alertStatus('Update task action failed');}
    await load();
  }
  function alertStatus(message){const status=byId('status-message');if(status)status.textContent=message;}
  function button(text,title,onclick){const node=element('button','',text);node.type='button';node.title=title;node.onclick=event=>{event.stopPropagation();onclick();};return node;}

  function link(text,title,onclick){const node=button(text,title,onclick);node.className='task-link';return node;}
  function dot(status){const node=element('span','task-dot');node.dataset.status=status;node.setAttribute('aria-hidden','true');return node;}
  // The dot carries the status, so the panel spells out the result without glyphs.
  function result(group){
    if(group.status==='waiting')return 'Waiting for agents to finish';
    if(group.status==='running')return 'Running…';
    if(group.status==='failed'||group.status==='changed')return group.summary;
    if(group.status==='ok')return `Up to date · ${group.lastEnd?ago(group.lastEnd):'just now'}`;
    if(group.status==='skipped')return 'Skipped';
    return 'Not run yet';
  }
  function taskRow(computer,group,task){
    const row=element('div','task-row');row.dataset.status=task.status;
    const head=element('div','task-head');
    head.append(dot(task.status),element('span','task-name',task.name));
    const meta=[];
    if(task.status==='running')meta.push('running');
    else if(task.status==='waiting')meta.push('waiting for agents');
    else if(task.finished)meta.push(ago(task.finished));
    if(task.durationMs!=null&&!['running','waiting'].includes(task.status))meta.push(task.durationMs<1000?`${task.durationMs}ms`:`${Math.round(task.durationMs/1000)}s`);
    if(task.exitCode!=null&&task.exitCode!==0)meta.push(`exit ${task.exitCode}`);
    if(task.whenAgentsIdle)meta.push('when agents are idle');
    head.append(element('small','task-meta',meta.join(' · ')));
    const actions=element('span','task-links');
    const run=link('Run','Run only this task now',()=>act(computer,group,'run',task));run.disabled=group.running;
    const log=element('a','task-link','Log');log.href=logUrl(computer,group,task);log.target='_blank';log.rel='noopener';log.title='Open the full output of the last run';
    actions.append(run,log);
    head.append(actions);row.append(head);
    if(task.note)row.append(element('p','task-note',task.note));
    for(const change of task.changed||[])row.append(element('p','task-change',change));
    if(task.tail?.length&&!['ok','never'].includes(task.status))row.append(element('pre','task-tail',task.tail.join('\n')));
    return row;
  }
  function groupBlock(computer,group){
    const block=element('details','task-group');block.dataset.status=group.status;
    block.dataset.key=`${computer.host||''}\n${group.name}`;
    const summary=element('summary');
    const schedule=[`every ${group.every}`,!group.enabled?'off in tasks.json':group.paused?'paused':group.nextRun&&!group.running?`next ${until(group.nextRun)}`:''].filter(Boolean).join(' · ');
    const title=element('span','task-title');title.append(element('strong','',group.name),element('small','',schedule));
    const state=element('span','task-state',result(group));state.title=group.summary||'';
    const run=button('Run now','Run every task in this group now',()=>act(computer,group,'run'));run.className='task-run';run.disabled=group.running;
    summary.append(dot(group.status),title,state,run);
    const footer=element('div','task-footer');
    footer.append(link(group.paused?'Resume schedule':'Pause schedule',group.paused?'Run this group on its schedule again':'Stop running this group on its schedule; Run now still works',()=>act(computer,group,group.paused?'resume':'pause')));
    if(group.notice)footer.append(link('Clear result','Clear this result on every computer',()=>act(computer,group,'clear')));
    block.append(summary,...group.tasks.map(task=>taskRow(computer,group,task)),footer);
    return block;
  }
  async function setUp(computer,agent,action){
    const body={agent:agent.agent};
    if(action)body.action=action;
    if(computer.host)body.host=computer.host;
    try{
      const response=await fetch('/api/tasks/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      if(!response.ok){const reply=await response.json().catch(()=>null);alertStatus(reply?.error||`${agent.name} setup failed`);}
    }catch(_){alertStatus(`${agent.name} setup failed`);}
    await load();
  }
  // Starts that computer's update job; the updater installs only a newer build.
  async function updateNow(computer){
    const body=computer.host?{host:computer.host}:{};
    try{
      const response=await fetch('/api/tasks/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const reply=await response.json().catch(()=>null);
      alertStatus(response.ok?`Checking for a newer build on ${computer.name}…`:reply?.error||`Could not start the update on ${computer.name}`);
    }catch(_){alertStatus(`Could not start the update on ${computer.name}`);}
    await load();
  }
  // Each agent row: ready agents show when they last reported; others say what is missing.
  const agentStatus={ready:'ok',setup:'failed',approve:'attention',running:'running'};
  function agentRow(computer,agent){
    const row=element('div','task-row agent-row');row.dataset.status=agent.skillRepair?.running?'running':agent.skillRepair?.error?'attention':(agent.skills?.state==='attention'||agent.installation?.state==='attention')?'attention':agentStatus[agent.state]||'never';row.dataset.agent=agent.agent;
    const head=element('div','task-head');
    head.append(dot(row.dataset.status),element('span','task-name',agent.name));
    const meta=agent.state==='ready'?(agent.lastReport?`reported ${ago(agent.lastReport)}`:'no report yet'):agent.detail;
    head.append(element('small','task-meta',meta));
    if(agent.state==='setup'||agent.state==='approve'){
      const actions=element('span','task-links');
      const setup=agent.state==='approve'
        ?button('Trust hooks',`Trust Switchboard's ${agent.name} hooks on ${computer.name}`,()=>setUp(computer,agent))
        :button('Set up',`Install Switchboard's status reporting for ${agent.name} on ${computer.name}`,()=>setUp(computer,agent));
      setup.disabled=!!agent.skillRepair?.running;
      setup.className='task-run';
      actions.append(setup);
      head.append(actions);
    }
    if(agent.skillRepair?.supported&&(agent.skillRepair.running||agent.skillRepair.error||agent.skills?.refreshPlugins?.length)){
      const fix=button(agent.skillRepair.running?'Fixing skills…':'Fix skills',`Refresh stale Codex plugins on ${computer.name}`,()=>setUp(computer,agent,'fix-skills'));
      fix.className='task-run';fix.disabled=agent.skillRepair.running||agent.state==='running';head.append(fix);
    }
    row.append(head);
    if(agent.skillRepair?.error)row.append(element('pre','task-tail skill-repair-error',agent.skillRepair.error));
    else if(agent.skillRepair?.finished&&agent.skills?.state==='ok')row.append(element('p','task-note','Skills refreshed. Start a new Codex conversation to use them.'));
    if(agent.installation?.state==='attention'){
      row.append(element('p','task-note installation-warning',agent.installation.detail));
      if(agent.installation.command)row.append(element('pre','task-tail installation-command',agent.installation.command));
    }
    if(agent.skills){
      const warnings=agent.skills.warnings||[];
      const note=element('p','task-note',agent.skillRepair?.running?'Refreshing user skills…':agent.skills.state==='checking'?'Checking user skills…':warnings.length?'User skills need attention':'User skills up to date');
      note.title=agent.skills.scope||'';row.append(note);
      if(warnings.length){
        const details=element('details','skill-details');details.dataset.key=JSON.stringify([computer.host||'',agent.agent,'skills']);
        details.append(element('summary','',`Show ${warnings.length} diagnostic${warnings.length===1?'':'s'}`));
        if(agent.skills.scope)details.append(element('p','task-note',agent.skills.scope));
        for(const warning of warnings)details.append(element('p','task-note skill-warning',warning));
        row.append(details);
      }
    }
    if(agent.state==='ready'&&agent.lastReport==null)row.append(element('p','task-note',`Restart running ${agent.name} sessions to start reporting.`));
    if(agent.setupError&&agent.state!=='ready'&&agent.state!=='running')row.append(element('pre','task-tail',agent.setupError));
    return row;
  }
  function switchboardBlock(computer){
    const sb=computer.switchboard,agents=(computer.agents||[]).filter(agent=>agent.state!=='absent');
    // Builds before automaticUpdates existed leave it out: shown as unknown, not off.
    const updates=sb.automaticUpdates===true?(sb.lastUpdateError?'attention':'ok'):sb.automaticUpdates===false?'failed':'never';
    const installWarnings=agents.filter(agent=>agent.installation?.state==='attention');
    const skillWarnings=agents.filter(agent=>agent.skills?.state==='attention'||agent.skillRepair?.error);
    const repairing=agents.some(agent=>agent.skillRepair?.running);
    const waiting=agents.filter(agent=>agent.state!=='ready');
    const status=updates==='failed'||waiting.some(agent=>agent.state==='setup')?'failed':repairing||waiting.some(agent=>agent.state==='running')?'running':waiting.length||skillWarnings.length||installWarnings.length||updates==='attention'?'attention':'ok';
    const block=element('details','task-group switchboard-group');block.dataset.status=status;
    block.dataset.key=`${computer.host||''}\n\u0000switchboard`;
    const summary=element('summary');
    const title=element('span','task-title');title.append(element('strong','','Switchboard'),element('small','',`build ${sb.commit}${sb.commitDate?` · ${sb.commitDate}`:''}`));
    let text='All set';
    if(updates==='failed')text='Automatic updates are off';
    else if(updates==='attention')text='Last update failed';
    else if(waiting.length)text=waiting.map(agent=>`${agent.name}: ${agent.state==='approve'?'hooks not trusted':agent.state==='running'?'setting up…':'needs setup'}`).join(' · ');
    if(installWarnings.length)text=(text==='All set'?'':text+' · ')+installWarnings.map(agent=>`${agent.name}: installation needs attention`).join(' · ');
    if(repairing)text=(text==='All set'?'':text+' · ')+'Refreshing Codex skills…';
    else if(skillWarnings.length)text=(text==='All set'?'':text+' · ')+skillWarnings.map(agent=>`${agent.name}: skills need attention`).join(' · ');
    const state=element('span','task-state',text);state.title=text;
    summary.append(dot(status),title,state);
    block.append(summary);
    const update=element('div','task-row');update.dataset.status=updates;
    const head=element('div','task-head');
    head.append(dot(updates),element('span','task-name','Automatic updates'),element('small','task-meta',updates==='ok'?'on':updates==='attention'?'on · last update failed':updates==='failed'?'off':'unknown on this build'));
    if(sb.updateNow){
      const actions=element('span','task-links');
      const run=button('Update now',`Install the newest build on ${computer.name} now, if there is one`,()=>updateNow(computer));run.className='task-run';
      actions.append(run);head.append(actions);
    }
    update.append(head);
    if(sb.lastUpdateError)update.append(element('pre','task-tail',sb.lastUpdateError));
    block.append(update,...agents.map(agent=>agentRow(computer,agent)));
    if(!agents.length)block.append(element('p','task-note agent-none','No Claude Code, Copilot CLI or Codex on this computer'));
    // Open by default while something needs the user.
    if(status!=='ok')block.open=true;
    return block;
  }
  function renderPanel(){
    const list=byId('updates');if(!list)return;
    const open=new Set([...list.querySelectorAll('details[data-key][open]')].map(node=>node.dataset.key));
    if(failed&&!computers.length){list.replaceChildren(element('p','log-note','Update tasks unavailable; refresh to try again.'));return;}
    const closed=new Set([...list.querySelectorAll('details.switchboard-group:not([open])')].map(node=>node.dataset.key));
    list.replaceChildren(...computers.map(computer=>{
      const section=element('section','log-computer task-computer');section.append(element('h4','',computer.name));
      if(computer.switchboard){
        const block=switchboardBlock(computer);
        if(open.has(block.dataset.key))block.open=true;else if(closed.has(block.dataset.key))block.open=false;
        section.append(block);
      }
      else if(!computer.error)section.append(element('p','log-note','Update Switchboard on this computer to check its agents'));
      if(computer.error)section.append(element('p','log-note',computer.error));
      else if(!computer.groups.length)section.append(element('p','log-note','No update tasks configured'));
      for(const group of computer.groups){
        const block=groupBlock(computer,group);
        if(open.has(block.dataset.key))block.open=true;
        section.append(block);
      }
      return section;
    }));
    for(const details of list.querySelectorAll('details.skill-details'))details.open=open.has(details.dataset.key);
  }
  function renderNotices(){
    const list=byId('task-notices');if(!list)return;
    const notices=computers.flatMap(computer=>(computer.groups||[]).filter(group=>group.notice).map(group=>({computer,group})));
    list.hidden=!notices.length;
    list.replaceChildren(...notices.map(({computer,group})=>{
      const row=element('div','task-notice');row.dataset.status=group.status;
      const text=`${computer.name} · ${group.name} ${line(group)}`;
      const open=element('button','task-notice-open',text);open.type='button';open.title=`${text}\nOpen Updates`;
      open.onclick=()=>globalThis.openPanel?.('health');
      const clear=element('button','task-notice-clear','×');clear.type='button';clear.title='Clear on every computer';clear.setAttribute('aria-label',`Clear ${computer.name} ${group.name}`);
      clear.onclick=()=>act(computer,group,'clear');
      row.append(open,clear);return row;
    }));
  }
  async function load(){
    if(loading)return;loading=true;
    const list=byId('updates'),refresh=byId('refresh-updates');
    list?.setAttribute('aria-busy','true');if(refresh)refresh.disabled=true;
    try{
      const response=await fetch('/api/tasks',{cache:'no-store'});
      if(!response.ok)throw Error('Update tasks unavailable');
      computers=(await response.json()).computers||[];failed=false;
    }catch(_){failed=true;}
    finally{
      loading=false;list?.setAttribute('aria-busy','false');if(refresh)refresh.disabled=false;
      renderPanel();renderNotices();
      // Poll quickly while a setup runs, so its result shows without a refresh.
      const busy=computers.some(computer=>(computer.agents||[]).some(agent=>agent.state==='running'));
      if(busy&&!fast)fast=setInterval(load,2000);else if(!busy&&fast){clearInterval(fast);fast=null;}
    }
  }
  const refresh=byId('refresh-updates');if(refresh)refresh.onclick=load;
  globalThis.SwitchboardTasks={load};
  load();setInterval(load,60000);
})();
