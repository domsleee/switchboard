'use strict';
// Settings → Health, per computer: the Switchboard build it runs and whether its
// agents report their own status (with a Set up button for each that doesn't), then
// the update tasks from its ~/.config/switchboard/tasks.json. Task failures or
// changes share a compact sidebar summary until cleared in Health, on any computer.
(()=>{
  const byId=id=>document.getElementById(id);
  const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const marks={ok:'✓',changed:'↑',failed:'✗',timeout:'✗',interrupted:'✗',running:'…',waiting:'…',skipped:'–',never:'·'};
  let computers=[],versions=[],loading=false,failed=false,fast=null,batch=[],dispatching=false;
  const pendingRuns=new Set();
  const groupKey=(computer,group)=>JSON.stringify([computer.host||'',group.name]);
  const busyGroup=(computer,group)=>group.running||pendingRuns.has(groupKey(computer,group));

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
  const blocked=group=>/not pulled, local changes/.test(group.summary||'');
  const groupIssue=group=>blocked(group)||['failed','timeout','interrupted'].includes(group.status);
  const eligible=(computer,group)=>!computer.error&&group.enabled&&!group.paused&&!busyGroup(computer,group);
  const needsSetup=agent=>['setup','approve'].includes(agent.state);
  const needsSkills=agent=>agent.skillRepair?.supported&&(agent.skills?.refreshPlugins?.length||agent.skillRepair?.error);
  const eligibleAgent=(computer,agent)=>!computer.error&&agent.state!=='absent'&&agent.state!=='running'&&!agent.skillRepair?.running&&(needsSetup(agent)||needsSkills(agent));
  const repairTargets=(selected=computers)=>selected.flatMap(computer=>[
    ...(computer.agents||[]).filter(agent=>eligibleAgent(computer,agent)).map(agent=>({computer,agent})),
    ...(computer.groups||[]).filter(group=>eligible(computer,group)&&groupIssue(group)&&!blocked(group)).map(group=>({computer,group}))
  ]);
  async function requestAction(computer,group,action,task){
    const body={group:group.name,action};
    if(computer.host)body.host=computer.host;
    if(task)body.task=task.name;
    const response=await fetch('/api/tasks/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok){const reply=await response.json().catch(()=>null);throw Error(reply?.error||'Update task action failed');}
  }
  async function act(computer,group,action,task){
    const key=groupKey(computer,group);
    if(action==='run'&&busyGroup(computer,group))return;
    if(action==='run')pendingRuns.add(key);
    renderPanel();
    try{await requestAction(computer,group,action,task);}
    catch(error){alertStatus(error.message);}
    finally{pendingRuns.delete(key);await load();renderPanel();}
  }
  async function runBatch(targets,retry=false){
    if(dispatching||batch.some(job=>job.state==='running'))return;
    const jobs=targets.filter(({computer,group,agent})=>agent?eligibleAgent(computer,agent):eligible(computer,group)).map(({computer,group,agent})=>({
      host:computer.host||'',name:computer.name,group:group?.name,agent:agent?.agent,label:agent?.name||group.name,
      phase:agent?(needsSetup(agent)?'setup':'fix-skills'):null,
      before:agent?(needsSetup(agent)?agent.setupFinished:agent.skillRepair?.finished):group.lastStart,state:'running',sent:false
    }));
    if(!jobs.length)return;
    batch=retry?batch.map(previous=>jobs.find(job=>job.host===previous.host&&job.group===previous.group&&job.agent===previous.agent)||previous):jobs;
    dispatching=true;
    for(const job of jobs.filter(job=>!job.agent))pendingRuns.add(groupKey({host:job.host},{name:job.group}));
    renderPanel();
    // One request per computer at a time; failures do not stop the remaining computers.
    for(const job of jobs){
      try{await dispatchJob(job);job.sent=true;}
      catch(error){job.state='failed';job.error=error.message;pendingRuns.delete(groupKey({host:job.host},{name:job.group}));}
    }
    dispatching=false;
    await load();renderPanel();
  }
  async function dispatchJob(job){
    if(!job.agent)return requestAction({host:job.host},{name:job.group},'run');
    const body={agent:job.agent};
    if(job.host)body.host=job.host;
    if(job.phase==='fix-skills')body.action='fix-skills';
    const response=await fetch('/api/tasks/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok){const reply=await response.json().catch(()=>null);throw Error(reply?.error||'Repair failed');}
  }
  async function updateBatch(){
    for(const job of batch){
      if(job.state!=='running'||!job.sent)continue;
      const computer=computers.find(c=>(c.host||'')===job.host);
      if(job.agent){
        const agent=computer?.agents?.find(a=>a.agent===job.agent);
        if(!computer||computer.error||!agent)continue;
        const setup=job.phase==='setup',finished=setup?agent.setupFinished:agent.skillRepair?.finished;
        if(agent.state==='running'||agent.skillRepair?.running||finished==null||finished===job.before)continue;
        const error=setup?agent.setupError:agent.skillRepair?.error;
        if(error){job.state='failed';job.error=error;continue;}
        // Setup and refresh share a lock on the host. Wait for setup to finish first.
        if(setup&&needsSkills(agent)){
          job.phase='fix-skills';job.before=agent.skillRepair?.finished;
          try{await dispatchJob(job);}catch(error){job.state='failed';job.error=error.message;}
          continue;
        }
        job.state=needsSetup(agent)||needsSkills(agent)?'failed':'done';
        if(job.state==='failed')job.error='Repair finished but this agent still needs attention';
        continue;
      }
      const group=computer?.groups?.find(g=>g.name===job.group);
      // Lost contact is not proof that a command failed. Keep the run pending.
      if(!computer||computer.error||!group)continue;
      if(group.lastStart!==job.before&&group.lastStart!=null&&!group.running){
        job.state=groupIssue(group)?'failed':'done';
        job.error=groupIssue(group)?result(group):null;
        pendingRuns.delete(groupKey(computer,group));
      }
    }
  }
  function renderBatch(){
    const box=byId('health-batch');if(!box)return;
    box.hidden=!batch.length;
    const done=batch.filter(j=>j.state!=='running').length,failures=batch.filter(j=>j.state==='failed');
    box.replaceChildren(element('span','',`${done}/${batch.length} repairs finished${failures.length?` · ${failures.length} need attention`:''}`));
    for(const job of failures)box.append(element('p','health-batch-error',`${job.name} · ${job.label||job.group}: ${job.error}`));
    if(!dispatching&&done===batch.length&&failures.length){
      const retry=button('Retry failed','Retry repairs that failed',()=>runBatch(repairTargets().filter(({computer,group,agent})=>failures.some(j=>j.host===(computer.host||'')&&j.group===group?.name&&j.agent===agent?.agent)),true));
      retry.disabled=!repairTargets().some(({computer,group,agent})=>failures.some(j=>j.host===(computer.host||'')&&j.group===group?.name&&j.agent===agent?.agent));box.append(retry);
    }
    if(failed||batch.some(j=>j.state==='running'&&(!computers.some(c=>(c.host||'')===j.host&&!c.error))))box.append(element('p','health-batch-error','Connection lost. Results will update when the computer reconnects.'));
  }
  function alertStatus(message){const status=byId('status-message');if(status)status.textContent=message;}
  function button(text,title,onclick){const node=element('button','',text);node.type='button';node.title=title;node.onclick=event=>{event.stopPropagation();onclick();};return node;}

  function link(text,title,onclick){const node=button(text,title,onclick);node.className='task-link';return node;}
  function dot(status){const node=element('span','task-dot');node.dataset.status=status;node.setAttribute('aria-hidden','true');return node;}
  // The dot carries the status, so the panel spells out the result without glyphs.
  function result(group){
    if(group.status==='waiting')return 'Waiting for agents to finish';
    if(group.status==='running')return 'Running…';
    if(blocked(group))return 'Update blocked by local changes';
    if(['failed','timeout','interrupted','changed'].includes(group.status))return group.summary||group.status;
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
    const run=link('Run','Run only this task now',()=>act(computer,group,'run',task));run.disabled=busyGroup(computer,group);
    const log=element('a','task-link','Log');log.href=logUrl(computer,group,task);log.target='_blank';log.rel='noopener';log.title='Open the full output of the last run';
    actions.append(run,log);
    head.append(actions);row.append(head);
    if(task.note)row.append(element('p','task-note',task.note));
    for(const change of task.changed||[])row.append(element('p','task-change',change));
    if(task.tail?.length&&!['ok','never'].includes(task.status))row.append(element('pre','task-tail',task.tail.join('\n')));
    return row;
  }
  function groupBlock(computer,group){
    const block=element('details','task-group');block.dataset.status=blocked(group)?'attention':group.status;
    block.dataset.key=`${computer.host||''}\n${group.name}`;
    const summary=element('summary');
    const schedule=[`every ${group.every}`,!group.enabled?'off in tasks.json':group.paused?'paused':group.nextRun&&!group.running?`next ${until(group.nextRun)}`:''].filter(Boolean).join(' · ');
    const title=element('span','task-title');title.append(element('strong','',group.name),element('small','',schedule));
    const state=element('span','task-state',result(group));state.title=group.summary||'';
    const run=button(groupIssue(group)?'Retry':'Check again','Check for updates in this group now',()=>act(computer,group,'run'));run.className='task-run';run.disabled=busyGroup(computer,group);
    summary.append(dot(block.dataset.status),title,state);
    const footer=element('div','task-footer');footer.append(run);
    footer.append(link(group.paused?'Resume schedule':'Pause schedule',group.paused?'Run this group on its schedule again':'Stop running this group on its schedule; Check again still works',()=>act(computer,group,group.paused?'resume':'pause')));
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
    const activate=computer.switchboard?.activateUpdate&&(computer.switchboard?.activationTarget||computer.switchboard?.readyUpdate?.commit);
    if(activate)body.activate=activate;
    let message;
    try{
      const response=await fetch('/api/tasks/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const reply=await response.json().catch(()=>null);
      message=reply?.warning||(response.ok?(activate?`Update requested on ${computer.name}; terminals will briefly reconnect…`:`Checking for a newer build on ${computer.name}…`):reply?.error||`Could not start the update on ${computer.name}`);
    }catch(_){message=`Could not start the update on ${computer.name}`;}
    await load();
    alertStatus(message);
  }
  // Each agent row: ready agents show when they last reported; others say what is missing.
  const agentStatus={ready:'ok',setup:'failed',approve:'attention',running:'running'};
  function agentRow(computer,agent){
    const row=element('div','task-row agent-row');row.dataset.status=agent.skillRepair?.running?'running':agent.skillRepair?.error?'attention':(agent.plugins?.state==='attention'||agent.skills?.state==='attention'||agent.installation?.state==='attention')?'attention':agentStatus[agent.state]||'never';row.dataset.agent=agent.agent;
    const head=element('div','task-head');
    head.append(dot(row.dataset.status),element('span','task-name',agent.name));
    const meta=agent.state==='ready'?`${agent.detail} · ${agent.lastReport?`reported ${ago(agent.lastReport)}`:'no report yet'}`:agent.detail;
    head.append(element('small','task-meta',meta));
    if(agent.state==='setup'||agent.state==='approve'){
      const actions=element('span','task-links');
      const setup=agent.state==='approve'
        ?button('Trust hooks',`Trust Switchboard's ${agent.name} hooks on ${computer.name}`,()=>setUp(computer,agent))
        :button('Set up',`Install Switchboard's status reporting for ${agent.name} on ${computer.name}`,()=>setUp(computer,agent));
      setup.disabled=!!agent.skillRepair?.running||batch.some(job=>job.state==='running'&&job.host===(computer.host||'')&&job.agent===agent.agent);
      setup.className='task-run';
      actions.append(setup);
      head.append(actions);
    }
    if(agent.skillRepair?.supported&&(agent.skillRepair.running||agent.skillRepair.error||agent.skills?.refreshPlugins?.length)){
      const fix=button(agent.skillRepair.running?'Fixing skills…':'Fix skills',`Refresh stale Codex plugins on ${computer.name}`,()=>setUp(computer,agent,'fix-skills'));
      fix.className='task-run';fix.disabled=agent.skillRepair.running||agent.state==='running'||batch.some(job=>job.state==='running'&&job.host===(computer.host||'')&&job.agent===agent.agent);head.append(fix);
    }
    row.append(head);
    if(agent.skillRepair?.error)row.append(element('pre','task-tail skill-repair-error',agent.skillRepair.error));
    else if(agent.skillRepair?.finished&&agent.skills?.state==='ok')row.append(element('p','task-note','Skills refreshed. Start a new Codex conversation to use them.'));
    if(agent.installation?.state==='attention'){
      row.append(element('p','task-note installation-warning',agent.installation.detail));
      if(agent.installation.command)row.append(element('pre','task-tail installation-command',agent.installation.command));
    }
    for(const warning of agent.plugins?.warnings||[])row.append(element('p','task-note plugin-warning',warning));
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
    const updating=['requested','applying'].includes(sb.updatePhase);
    const checkOnly=sb.updateCheckError&&!sb.lastUpdateError&&!sb.readyUpdate&&sb.updatePhase!=='recovery';
    const updates=updating?'running':sb.automaticUpdates===true?((sb.lastUpdateError||sb.updateCheckError||sb.readyUpdate||sb.updatePhase==='recovery')?'attention':'ok'):sb.automaticUpdates===false?'failed':'never';
    const installWarnings=agents.filter(agent=>agent.installation?.state==='attention');
    const pluginWarnings=agents.filter(agent=>agent.plugins?.state==='attention');
    const skillWarnings=agents.filter(agent=>agent.skills?.state==='attention'||agent.skillRepair?.error);
    const repairing=agents.some(agent=>agent.skillRepair?.running);
    const waiting=agents.filter(agent=>agent.state!=='ready');
    const status=updates==='failed'||waiting.some(agent=>agent.state==='setup')?'failed':updating||repairing||waiting.some(agent=>agent.state==='running')?'running':waiting.length||pluginWarnings.length||skillWarnings.length||installWarnings.length||updates==='attention'||updates==='never'?'attention':'ok';
    const block=element('details','task-group switchboard-group');block.dataset.status=status;
    block.dataset.key=`${computer.host||''}\n\u0000switchboard`;
    const summary=element('summary');
    const title=element('span','task-title');title.append(element('strong','','Switchboard'),element('small','',`build ${sb.commit}${sb.commitDate?` · ${sb.commitDate}`:''}`));
    let text='All set';
    if(updating)text=sb.updatePhase==='applying'?'Installing update…':'Update requested…';
    else if(updates==='failed')text='Automatic updates are off';
    else if(updates==='attention')text=sb.lastUpdateError?'Last update failed':checkOnly?"Couldn't check for updates":sb.updatePhase==='recovery'?'Interrupted update · recovery waiting':'Update ready · terminals connected';
    else if(updates==='never')text='Update status unknown';
    else if(waiting.length)text=waiting.map(agent=>`${agent.name}: ${agent.state==='approve'?'hooks not trusted':agent.state==='running'?'setting up…':'needs setup'}`).join(' · ');
    if(installWarnings.length)text=(text==='All set'?'':text+' · ')+installWarnings.map(agent=>`${agent.name}: installation needs attention`).join(' · ');
    if(pluginWarnings.length)text=(text==='All set'?'':text+' · ')+pluginWarnings.map(agent=>`${agent.name}: plugins need attention`).join(' · ');
    if(repairing)text=(text==='All set'?'':text+' · ')+'Refreshing Codex skills…';
    else if(skillWarnings.length)text=(text==='All set'?'':text+' · ')+skillWarnings.map(agent=>`${agent.name}: skills need attention`).join(' · ');
    const state=element('span','task-state',text);state.title=text;
    summary.append(dot(status),title,state);
    block.append(summary);
    const update=element('div','task-row');update.dataset.status=updates;
    const head=element('div','task-head');
    head.append(dot(updates),element('span','task-name','Automatic updates'),element('small','task-meta',updating?'on · updating':updates==='ok'?'on':updates==='attention'?(sb.lastUpdateError?'on · last update failed':checkOnly?"on · couldn't check":'on · update waiting'):updates==='failed'?'off':'unknown on this build'));
    const activate=sb.activateUpdate&&(sb.activationTarget||sb.readyUpdate?.commit);
    if(sb.updateNow||activate){
      const actions=element('span','task-links');
      const run=button(activate?'Update now':'Check for updates',activate?`Activate ${activate.slice(0,7)} on ${computer.name}; terminals briefly reconnect`:`Check for a newer build on ${computer.name}`,()=>updateNow(computer));run.className='task-run';run.disabled=updating;
      actions.append(run);head.append(actions);
    }
    update.append(head);
    if(sb.readyUpdate)update.append(element('p','task-note',`Build ${sb.readyUpdate.commit.slice(0,7)} ready${sb.readyUpdate.since?` · downloaded ${ago(sb.readyUpdate.since*1000)}`:''}. ${sb.activateUpdate?'Terminals briefly reconnect; running commands continue.':'This computer needs a newer updater to activate while terminals are connected.'}`));
    else if(sb.updateNotice)update.append(element('p','task-note',sb.updateNotice));
    if(sb.lastUpdateError||sb.updateCheckError)update.append(element('pre','task-tail',sb.lastUpdateError||sb.updateCheckError));
    block.append(update,...agents.map(agent=>agentRow(computer,agent)));
    if(sb.sessionsWithoutHost?.length){
      const one=sb.sessionsWithoutHost.length===1;
      block.append(element('p','task-note sessions-without-host',`Updates leave ${sb.sessionsWithoutHost.join(', ')} on the engine ${one?'it has':'they have'}, because ${one?'it':'they'} started before updates could move terminals. Closing and reopening a session lets updates move it, but stops what runs in it.`));
    }
    if(!agents.length)block.append(element('p','task-note agent-none','No Claude Code, Copilot CLI or Codex on this computer'));
    // Open by default while something needs the user.
    if(status!=='ok')block.open=true;
    return block;
  }
  function versionLabel(computer){
    if(computer.local)return 'This computer';
    const own=computers.find(c=>c.local&&!c.error),build=computer.switchboard,local=own?.switchboard;
    const valid=commit=>typeof commit==='string'&&/^[a-f0-9]{7,40}$/i.test(commit);
    if(computer.error||!valid(build?.commit)||!valid(local?.commit))return 'Version comparison unavailable';
    const same=(a,b)=>a.toLowerCase().startsWith(b.toLowerCase())||b.toLowerCase().startsWith(a.toLowerCase());
    if(same(build.commit,local.commit))return 'Same version as this computer';
    // Only use host timestamps for the exact builds returned by Health. The
    // two snapshots can straddle an update, so mismatched metadata is ignored.
    const time=(c,sb)=>{
      const host=versions.find(h=>c.local?h.local:h.id===c.host);
      return valid(host?.version?.commit)&&same(host.version.commit,sb.commit)
        ? Date.parse(host.version.commit_timestamp||'') : NaN;
    };
    let theirs=time(computer,build),ours=time(own,local);
    if(!Number.isFinite(theirs)||!Number.isFinite(ours)){
      const day=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')?Date.parse(value):NaN;
      theirs=day(build.commitDate);ours=day(local.commitDate);
    }
    if(!Number.isFinite(theirs)||!Number.isFinite(ours)||theirs===ours)return 'Different version · order unknown';
    return theirs<ours?'Older than this computer':'Newer than this computer';
  }
  function renderPanel(){
    const list=byId('updates');if(!list)return;
    const open=new Set([...list.querySelectorAll('details[data-key][open]')].map(node=>node.dataset.key));
    const closed=new Set([...list.querySelectorAll('details[data-key]:not([open])')].map(node=>node.dataset.key));
    const active=dispatching||batch.some(job=>job.state==='running');
    const runAll=byId('fix-all-health');
    if(runAll){runAll.disabled=failed||active||!repairTargets().length;runAll.textContent=active?'Fixing…':'Fix all';}
    renderBatch();
    if(failed&&!computers.length){list.replaceChildren(element('p','log-note','Health unavailable; refresh to try again.'));if(byId('health-summary'))byId('health-summary').textContent='Could not check computers';return;}
    let attention=0;
    list.replaceChildren(...computers.map(computer=>{
      const sb=computer.switchboard?switchboardBlock(computer):null;
      const groups=computer.groups||[];
      const issues=[];
      if(computer.error)issues.push(computer.error);
      else if(!sb)issues.push('Update Switchboard to check agents');
      if(sb&&sb.dataset.status!=='ok')issues.push(sb.querySelector('.task-state').textContent);
      for(const group of groups)if(groupIssue(group))issues.push(`${group.name}: ${result(group)}`);
      const running=groups.some(group=>busyGroup(computer,group))||sb?.dataset.status==='running';
      if(issues.length)attention++;
      const state=running?'running':issues.length?'attention':'ok';
      const section=element('details','log-computer task-computer');section.dataset.key=JSON.stringify([computer.host||'','computer']);section.dataset.status=state;
      const summary=element('summary','computer-summary');
      const title=element('span','computer-title');title.append(element('h4','',computer.name));
      const version=element('small','computer-local computer-version',versionLabel(computer));
      version.title='Compared with the computer serving this Switchboard page. Build order uses commit time.';
      title.append(version);
      const last=Math.max(0,...groups.map(g=>g.lastEnd||0));
      const status=element('span','computer-state',running?'Working…':issues.length?issues.join(' · '):`All set${last?` · ran ${ago(last)}`:''}`);
      const run=button('Fix',`Fix detected issues on ${computer.name}`,()=>runBatch(repairTargets([computer])));run.className='computer-run';run.disabled=failed||active;
      summary.append(dot(state),title,status);if(repairTargets([computer]).length)summary.append(run);section.append(summary);
      if(sb)section.append(sb);
      else if(!computer.error)section.append(element('p','log-note','Update Switchboard on this computer to check its agents'));
      if(computer.error)section.append(element('p','log-note',computer.error));
      else if(!groups.length)section.append(element('p','log-note','No update tasks configured'));
      for(const group of groups)section.append(groupBlock(computer,group));
      for(const details of [section,...section.querySelectorAll('details[data-key]')]){
        if(open.has(details.dataset.key))details.open=true;else if(closed.has(details.dataset.key))details.open=false;
      }
      return section;
    }));
    const summary=byId('health-summary');if(summary)summary.textContent=failed?'Could not refresh · showing previous results':`${computers.length} computers · ${attention?`${attention} need attention${!active&&!repairTargets().length?' · expand for details':''}`:'all healthy'}`;
  }
  function renderNotices(){
    const list=byId('task-notices');if(!list)return;
    // Successful changes stay in Health; only problems earn a sidebar count.
    const notices=computers.flatMap(computer=>[
      ...(computer.groups||[]).filter(group=>group.notice&&groupIssue(group)).map(group=>`${computer.name} · ${group.name} ${line(group)}`),
      ...(computer.switchboard?.pathCopyDamaged?[`${computer.name} · zellij on PATH is damaged`]:[])]);
    list.hidden=!notices.length;
    if(!notices.length){list.replaceChildren();return;}
    const open=element('button','task-notice-open',`Health · ${notices.length}`);open.type='button';
    open.dataset.status='attention';
    open.setAttribute('aria-label',`Health: ${notices.length} need attention`);
    open.title=notices.join('\n')+'\nOpen Health';
    open.onclick=()=>globalThis.openPanel?.('health');
    list.replaceChildren(open);
  }
  async function load(){
    if(loading)return;loading=true;
    const list=byId('updates'),refresh=byId('refresh-updates');
    list?.setAttribute('aria-busy','true');if(refresh)refresh.disabled=true;
    try{
      const [response,hosts]=await Promise.all([
        fetch('/api/tasks',{cache:'no-store'}),
        fetch('/api/hosts',{cache:'no-store'}).then(r=>r.ok?r.json():[]).catch(()=>[])
      ]);
      versions=Array.isArray(hosts)?hosts:[];
      if(!response.ok)throw Error('Update tasks unavailable');
      computers=(await response.json()).computers||[];failed=false;await updateBatch();
    }catch(_){failed=true;}
    finally{
      loading=false;list?.setAttribute('aria-busy','false');if(refresh)refresh.disabled=false;
      renderPanel();renderNotices();
      // Poll quickly while a setup runs, so its result shows without a refresh.
      const busy=batch.some(job=>job.state==='running')||computers.some(computer=>['requested','applying'].includes(computer.switchboard?.updatePhase)||(computer.groups||[]).some(group=>group.running)||(computer.agents||[]).some(agent=>agent.state==='running'||agent.skillRepair?.running));
      if(busy&&!fast)fast=setInterval(load,2000);else if(!busy&&fast){clearInterval(fast);fast=null;}
    }
  }
  const runAll=byId('fix-all-health');if(runAll)runAll.onclick=()=>runBatch(repairTargets());
  async function refreshHealth(){
    const refresh=byId('refresh-updates');
    if(refresh)refresh.disabled=true;
    try{
      // A status GET cannot replace a superseded downloaded release. Start a
      // fresh guarded check without repeating the rejected activation target.
      const stale=computers.filter(computer=>computer.switchboard?.updateNow&&
        computer.switchboard?.lastUpdateError?.includes('The requested update was superseded'));
      const results=await Promise.all(stale.map(async computer=>{
        try{
          const response=await fetch('/api/tasks/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(computer.host?{host:computer.host}:{})});
          const reply=await response.json().catch(()=>null);
          if(!response.ok)throw Error(reply?.error||'Could not check for updates');
          return `Checking for a newer build on ${computer.name}…`;
        }catch(error){return `${computer.name}: ${error.message}`;}
      }));
      await load();
      if(results.length)alertStatus(results.join(' · '));
    }finally{if(refresh)refresh.disabled=false;}
  }
  const refresh=byId('refresh-updates');if(refresh)refresh.onclick=refreshHealth;
  globalThis.SwitchboardTasks={load};
  load();setInterval(load,60000);
})();
