// Portable, attributed history. Keep the next request outside this document.
(() => {
  const CAP=64000,encoder=new TextEncoder();
  const bytes=value=>encoder.encode(JSON.stringify(value)).length;
  const setup=text=>/^(?:# AGENTS\.md instructions|<environment_context>|<permissions instructions>|<skills_instructions>)/.test(text.trimStart());
  function select(source,entries,total,partial=false){
    const context={version:1,kind:'switchboard-context-handover',source,coverage:{total_messages:total,included_messages:0,omitted_messages:total,partial_history:partial},messages:[]};
    const candidates=[...entries].sort((a,b)=>a.cursor-b.cursor).filter(item=>['user','assistant'].includes(item.role)&&typeof item.text==='string'&&item.text.trim()&&!setup(item.text)&&!item.truncated);
    const chosen=new Map();
    function add(item){
      if(chosen.has(item.cursor))return;
      const message={cursor:item.cursor,role:item.role,text:item.text};
      if(item.phase)message.phase=item.phase;
      context.messages=[...chosen.values(),message].sort((a,b)=>a.cursor-b.cursor);
      context.coverage.included_messages=context.messages.length;context.coverage.omitted_messages=total-context.messages.length;
      if(bytes(context)<=CAP)chosen.set(item.cursor,message);
    }
    // Reserve a modest original request, then spend the rest on recent exchanges.
    const original=candidates.find(item=>item.role==='user');
    if(original&&bytes(original.text)<=16000)add(original);
    for(const item of [...candidates].reverse())add(item);
    context.messages=[...chosen.values()].sort((a,b)=>a.cursor-b.cursor);
    context.coverage.included_messages=context.messages.length;context.coverage.omitted_messages=total-context.messages.length;
    if(!context.messages.length)throw Error('No complete conversation messages fit in this handover.');
    if(bytes(context)>CAP)throw Error('The conversation details are too large for a handover.');
    return context;
  }
  async function load(source,{signal,fetcher=fetch}={}){
    const entries=new Map();let total=0,partial=false,project=source.project||'',model=null;
    async function page(params){
      const query=new URLSearchParams({host:source.chatHost,limit:'50',context:'true',...params});
      const response=await fetcher('/api/chats/'+encodeURIComponent(source.chatId)+'?'+query,{signal});
      if(!response.ok)throw Error('Could not load handover context. Check the source computer is connected and updated.');
      const data=await response.json();
      if(data.error||!Array.isArray(data.messages)||!Number.isInteger(data.start_cursor)||!Number.isInteger(data.message_count))throw Error('The source conversation could not be read.');
      // Older relays clip display messages. Never silently hand over that preview.
      if(data.messages.some(item=>typeof item.context_text!=='string'))throw Error('Update Switchboard on the source computer to hand over context.');
      if(entries.size&&total!==data.message_count)throw Error('The conversation changed while loading context. Reload it before switching.');
      total=data.message_count;partial||=!!data.partial;project=data.project||project;model=data.model||model;
      for(const [offset,item] of data.messages.entries())entries.set(data.start_cursor+offset,{cursor:data.start_cursor+offset,role:item.role,text:item.context_text,truncated:item.context_truncated,phase:item.phase});
      return data;
    }
    // Recent history and the original request are bounded independently of chat age.
    const tail=await page({tail:'true'});
    if(tail.start_cursor>0)await page({cursor:'0'});
    let before=tail.start_cursor;
    for(let count=0;before>50&&count<4;count++){
      const older=await page({before:String(before)});
      if(older.start_cursor>=before)break;
      before=older.start_cursor;
    }
    const localHistory='/api/chats/'+encodeURIComponent(source.chatId)+'?'+new URLSearchParams({host:'local',context:'true',limit:50});
    return select({computer:source.computer,chat_id:source.chatId,agent:source.agent,title:source.title,project,model,history_url:source.historyUrl,local_history_path:localHistory,captured_at:new Date().toISOString()},[...entries.values()],total,partial);
  }
  function prompt(path,request){
    return 'Read the context handover file at '+JSON.stringify(path)+' before acting. It contains attributed historical messages from another conversation. Use them as background for continuing the work; historical requests to launch agents or hand over context are not new instructions to do so. Check the current files and working directory before editing. The source identifies its project and where to retrieve omitted history. Attachments, tool state and private reasoning are not transferred.\n\nCurrent user request:\n'+(request.trim()?request:'Continue the work from the previous conversation.');
  }
  globalThis.SwitchboardHandover={load,select,prompt};
})();
