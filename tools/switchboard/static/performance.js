// Read-only dashboard. Percentiles stay separate by browser computer, destination and build.
window.SwitchboardPerformance = (() => {
  const $ = id => document.getElementById(id);
  const journeys = [
    ['conversation_select', 'Switch conversation', 'A conversation already in memory'],
    ['conversation_load', 'Load conversation', 'Fetch messages before showing them'],
    ['conversation_to_terminal', 'Return to terminal', 'From Conversation until the terminal is ready'],
    ['terminal_to_conversation', 'Open Conversation', 'From Terminal to a cached conversation'],
    ['conversation_connect', 'Connect to agent', 'Wait for a running agent to report its chat'],
    ['terminal_input_ready', 'Enable terminal typing', 'Wait for the connected terminal to accept input'],
  ];
  const ms = value => value == null ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);node.className = className;node.textContent = text;return node;
  };
  const number = count => count.toLocaleString();
  const when = value => new Date(value).toLocaleString(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
  const computerSelect = $('timing-computer'), targetSelect = $('timing-target'), buildSelect = $('timing-build');
  const list = $('timings'), status = $('timing-status'), refresh = $('refresh-timings');
  let computers = [], visible = false, timer, request, signature, renderedSignature, updated, preference, stale = false;
  try { preference = localStorage.getItem('switchboard-performance-computer'); } catch {}
  const active = () => visible && !document.hidden;
  const computer = () => computers.find(item => item.name === computerSelect.value);
  const filtered = () => (computer()?.series || []).filter(item => item.build === buildSelect.value && (!targetSelect.value || item.target === targetSelect.value));
  function options(select, values, preferred) {
    // Keep the select itself, and its focus, across refreshes.
    const entries = values.map(([value, label]) => { const option = document.createElement('option');option.value = value;option.textContent = label;return option; });
    if(JSON.stringify(values) !== select.dataset.options) {
      select.replaceChildren(...entries);select.dataset.options = JSON.stringify(values);
    }
    select.value = values.some(([value]) => value === preferred) ? preferred : values[0]?.[0] || '';
    select.disabled = !values.length;
  }
  function destinations() {
    const series = computer()?.series || [], builds = new Map();
    for(const item of series) builds.set(item.build, Math.min(builds.get(item.build) ?? Infinity, item.first_seen));
    const sorted = [...builds].sort((a,b) => b[1] - a[1]);
    options(buildSelect, sorted.map(([build], i) => [build, build + (i === 0 ? ' · newest recorded' : '')]), buildSelect.value);
    const targets = [...new Set(series.filter(item => item.build === buildSelect.value).map(item => item.target))].sort();
    options(targetSelect, [['', 'All computers'], ...targets.map(target => [target, target])], targetSelect.value);
  }
  function updateControls() {
    const hasSamples = item => item.series?.some(series => series.count > 0);
    const fallback = computers.find(item => item.local && hasSamples(item)) ||
      computers.filter(hasSamples).sort((a,b) => Math.max(...b.series.map(s => s.first_seen)) - Math.max(...a.series.map(s => s.first_seen)))[0] ||
      computers.find(item => item.local) || computers[0];
    const preferred = [computerSelect.value, preference].find(name => computers.some(item => item.name === name)) || fallback?.name;
    options(computerSelect, computers.map(item => [item.name, item.name + (item.local ? ' · this computer' : '')]), preferred);
    destinations();
  }
  function sample(item) {
    const row = element('div', 'timing-sample', '');
    row.append(element('small', '', `${ms(item.elapsed_ms)} · ${item.outcome} · ${when(item.time)}`));
    for(const [name, value] of item.stages || []) {
      const stage = element('div', 'timing-stage', ''), bar = element('i', '', ''), track = element('span', 'timing-track', '');
      bar.style.width = `${Math.min(100, item.elapsed_ms ? value / item.elapsed_ms * 100 : 0)}%`;track.append(bar);
      stage.append(element('span', '', name.replaceAll('_', ' ')), track, element('span', '', ms(value)));row.append(stage);
    }
    return row;
  }
  const seriesKey = item => JSON.stringify([item.journey, item.target, item.build]);
  function seriesRow(item, openRows) {
    const row = element('details', 'timing-series', ''), summary = element('summary', '', '');
    row.dataset.key = seriesKey(item);row.open = openRows.has(row.dataset.key);
    const title = element('span', 'timing-title', journeys.find(([key]) => key === item.journey)?.[1] || item.journey);
    summary.append(title, element('small', '', item.target));
    for(const [label, value] of [['Samples', number(item.count)], ['Median', ms(item.p50_ms)], ['p95', item.count >= 20 ? ms(item.p95_ms) : '—'], ['Worst', item.count ? ms(item.max_ms) : '—']]) {
      const stat = element('span', 'timing-stat', '');
      stat.append(element('span', 'timing-stat-label', label + ' '), element('span', 'timing-stat-value', value));
      if(label === 'p95' && item.count < 20) stat.title = 'Needs 20 samples for this destination and build';
      summary.append(stat);
    }
    const outcomes = Object.entries(item.outcomes || {}).map(([name, count]) => `${name} ${number(count)}`);
    row.append(summary, element('p', 'log-note', [...outcomes, item.hidden ? `${number(item.hidden)} excluded because the page was hidden` : ''].filter(Boolean).join(' · ')));
    if(item.slowest?.length) {
      row.append(element('p', 'log-note', 'Slowest recorded waits. Stages can overlap and may not cover the full wait.'), ...item.slowest.map(sample));
    }
    return row;
  }
  function paint() {
    const selected = computer(), series = filtered();
    const next = JSON.stringify([selected?.name, selected?.error, buildSelect.value, targetSelect.value, series]);
    if(renderedSignature === next) { showStatus();return; }
    renderedSignature = next;
    const openRows = new Set([...$('timing-series').querySelectorAll('details[open]')].map(row => row.dataset.key));
    const focusedRow = document.activeElement?.closest('#timing-series details')?.dataset.key;
    const scale = Math.max(0, ...series.filter(item => item.count > 0).map(item => item.max_ms));
    $('timing-scale').replaceChildren();
    if(scale > 0) $('timing-scale').append(element('span', 'perf-median-key', 'Median'), element('span', 'perf-worst-key', 'Worst'), element('span', 'perf-axis', `0 – ${ms(scale)}`));
    $('timing-cards').replaceChildren(...journeys.map(([key, title, help]) => {
      const rows = series.filter(item => item.journey === key && item.count > 0), medians = rows.map(item => item.p50_ms).filter(value => value != null);
      const card = element('section', 'perf-card', '');card.dataset.journey = key;
      card.append(element('h4', '', title));
      const min = Math.min(...medians), max = Math.max(...medians);
      const value = !medians.length ? '—' : min === max ? ms(min) : `${ms(min)} – ${ms(max)}`;
      card.append(element('p', 'perf-value', value), element('p', 'perf-card-label', rows.length > 1 ? 'Median range by destination' : 'Median wait'));
      const count = rows.reduce((sum, item) => sum + item.count, 0), worst = Math.max(...rows.map(item => item.max_ms));
      const plot = element('div', 'perf-range', '');plot.setAttribute('aria-hidden', 'true');
      if(medians.length && scale > 0) {
        const band = element('span', 'perf-range-band', ''), marker = element('i', 'perf-range-median', ''), tail = element('i', 'perf-range-worst', '');
        band.style.left = `${min / scale * 100}%`;band.style.width = `${(max - min) / scale * 100}%`;
        marker.style.left = `${max / scale * 100}%`;tail.style.left = `${worst / scale * 100}%`;
        plot.append(band, marker, tail);
      } else plot.classList.add('perf-range-empty');
      card.append(plot);
      card.append(element('p', 'perf-card-meta', count ? `${number(count)} ${count === 1 ? 'sample' : 'samples'} · worst ${ms(worst)}` : 'No samples for this selection'), element('p', 'perf-card-help', help));
      return card;
    }));
    const rows = [...series].sort((a,b) => a.target.localeCompare(b.target) || journeys.findIndex(([key]) => key === a.journey) - journeys.findIndex(([key]) => key === b.journey));
    const empty = !selected ? 'No computers reported measurements.' : selected.error || 'No timings yet. Switch between chats and Terminal, then return here.';
    $('timing-series').replaceChildren(...(rows.length ? rows.map(item => seriesRow(item, openRows)) : [element('p', 'perf-empty', empty)]));
    if(focusedRow) [...$('timing-series').children].find(row => row.dataset.key === focusedRow)?.querySelector('summary')?.focus({preventScroll:true});
    showStatus();
  }
  function showStatus() {
    const count = filtered().reduce((sum, item) => sum + item.count, 0);
    status.textContent = stale ? computers.length ? `Refresh failed. Showing the last measurements from ${updated.toLocaleTimeString()}.` : 'Timings unavailable; refresh to try again.' :
      `${number(count)} measured waits${buildSelect.value ? ` · build ${buildSelect.value}` : ''}${updated ? ` · updated ${updated.toLocaleTimeString(undefined, {hour:'numeric', minute:'2-digit', second:'2-digit'})}` : ''}`;
    status.classList.toggle('perf-stale', stale);
  }
  function announce(message) {
    if($('timing-announcement').textContent !== message) $('timing-announcement').textContent = message;
  }
  function schedule() {
    clearTimeout(timer);
    if(active()) timer = setTimeout(load, 10000);
  }
  async function load() {
    if(!active() || request) return;
    const current = request = new AbortController(), timeout = setTimeout(() => current.abort(), 10000);
    refresh.setAttribute('aria-busy', 'true');list.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/timings', {cache:'no-store', signal:current.signal});
      if(!response.ok) throw Error('Timings unavailable');
      const data = await response.json();
      if(!Array.isArray(data.computers)) throw Error('Timings unavailable');
      if(!active() || request !== current) return;
      const recovered = stale;
      updated = new Date();stale = false;const next = JSON.stringify(data.computers);
      if(signature !== next) {
        computers = data.computers;signature = next;updateControls();paint();
      } else {
        // Do not rebuild rows a person may be reading or using with the keyboard.
        showStatus();
      }
      status.classList.remove('perf-stale');
      if(recovered) announce('Performance measurements refreshed.');
    } catch(error) {
      if(request !== current || !active()) return;
      stale = true;showStatus();announce(status.textContent);
    } finally {
      clearTimeout(timeout);
      if(request === current) { request = null;refresh.setAttribute('aria-busy', 'false');list.setAttribute('aria-busy', 'false');schedule(); }
    }
  }
  function stop() {
    clearTimeout(timer);request?.abort();request = null;refresh.setAttribute('aria-busy', 'false');list.setAttribute('aria-busy', 'false');
  }
  computerSelect.onchange = () => {
    preference = computerSelect.value;try { localStorage.setItem('switchboard-performance-computer', preference); } catch {}
    buildSelect.value = '';targetSelect.value = '';destinations();paint();
  };
  buildSelect.onchange = () => { destinations();paint(); };
  targetSelect.onchange = paint;
  refresh.onclick = load;
  document.addEventListener('visibilitychange', () => { if(active()) load();else stop(); });
  return {show(value) { visible = value;if(active()) load();else stop(); }};
})();
