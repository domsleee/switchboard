// Times what the user waits for. Counts and timings only, never terminal or chat content.
// A journey during which the page was hidden is marked so it never counts as a wait:
// timers stall in a background tab and the elapsed time means nothing.
window.SwitchboardTiming = (function () {
  let visibilityChanged=-1;
  document.addEventListener('visibilitychange',()=>{visibilityChanged=performance.now();});
  function report(journey,started,outcome,{host,stages={},elapsed}={}) {
    const end=performance.now(),hidden=document.hidden||visibilityChanged>=started;
    const elapsed_ms=Math.min(120000,Math.max(0,Math.round(elapsed??end-started)));
    // Shows the same journeys on a Switchboard track in Chrome's Performance panel.
    try{performance.measure(`switchboard:${journey}`,{start:started,duration:elapsed_ms,detail:{devtools:{dataType:'track-entry',track:'Switchboard'}}});}catch{}
    const body={journey,outcome,elapsed_ms,hidden,stages:Object.entries(stages)
      .filter(([,value])=>Number.isFinite(value)&&value>=0).map(([name,value])=>[name.replace(/_ms$/,''),Math.min(120000,Math.round(value))])};
    if(host)body.host=host;
    fetch('/api/diagnostics/timing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),keepalive:true}).catch(()=>{});
  }
  // A journey nothing ever finishes reports a timeout, so the worst waits are not lost.
  function begin(journey,{host,deadline=30000,timeoutStages}={}) {
    const started=performance.now();let timer;
    const end=(outcome,options={})=>{if(timer===null)return;clearTimeout(timer);timer=null;report(journey,started,outcome,{host,...options});};
    timer=setTimeout(()=>end('timeout',{stages:timeoutStages?.()??{}}),deadline);
    return {end};
  }
  return {report,begin};
})();
