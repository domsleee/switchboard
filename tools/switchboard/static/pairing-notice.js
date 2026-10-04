(() => {
  'use strict';
  const notice = document.getElementById('pairing-notice');
  if (!notice) return;
  let stopped = false, timer;
  async function refresh() {
    try {
      const response = await fetch('/api/mesh', {cache:'no-store'});
      if (response.ok) {
        const state = await response.json();
        const requests = [...(state.incoming || []), ...(state.requests || [])];
        notice.hidden = !requests.length;
        const text = requests.length === 1 ? `Connection request from ${requests[0].computer}. Review` : `${requests.length} connection requests. Review`;
        if (notice.textContent !== text) notice.textContent = text;
      }
    } catch (_) { /* Background availability never changes terminal focus or layout. */ }
    finally { if (!stopped) timer = setTimeout(refresh, 3000); }
  }
  window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);});
  window.addEventListener('pageshow',event=>{if(event.persisted){stopped=false;refresh();}});
  refresh();
})();
