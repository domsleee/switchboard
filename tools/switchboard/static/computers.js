(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let invitationId = null;
  let pending = false;
  let refreshing = false;
  let previewLink = null;
  let previewVersion = 0, previewTimer;
  let defaultsLoaded = false;
  let configuredHosts = [], hostDetails = [];
  const buildText = build => build && /^[a-f0-9]{7,40}$/.test(build.commit) && /^\d{4}-\d{2}-\d{2}$/.test(build.commit_date)
    ? `${build.commit} · ${build.commit_date}` : null;
  const localBuild = fetch('/api/health', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).catch(() => null);
  const versionKey = list => JSON.stringify(list.map(host => [host.id, host.error, host.version]));
  const show = (message, error = false) => {
    $('message').textContent = message;
    $('message').className = error ? 'error' : '';
  };
  async function api(path, body) {
    const response = await fetch(`/api/mesh${path}`, body === undefined ? {cache: 'no-store'} : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), cache: 'no-store'
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
  async function action(fn) {
    const buttons = [...document.querySelectorAll('button')].map(button => [button, button.disabled]);
    buttons.forEach(([button]) => button.disabled = true);
    try { await fn(); } catch (error) { show(error.message || 'Pairing unavailable. Check the network and retry.', true); }
    finally { buttons.forEach(([button, disabled]) => button.disabled = disabled); }
  }
  function local() {
    if (!$('address').value.trim()) {
      if ($('network-choice').hidden) $('advanced').open = true;
      throw new Error('Choose a connection for this computer before continuing.');
    }
    if (!$('computer-name').value.trim()) throw new Error('Enter a name for this computer.');
    return {computer_name: $('computer-name').value.trim(), address: $('address').value.trim()};
  }
  async function setupDefaults() {
    if (defaultsLoaded) return;
    const defaults = await api('/defaults');
    if (!$('computer-name').value) $('computer-name').value = defaults.computer_name || '';
    if (!$('address').value) $('address').value = defaults.address || '';
    if (!$('mesh-name').value) $('mesh-name').value = defaults.name || 'My computers';
    for (const address of defaults.addresses || []) {
      const option = document.createElement('option'); option.value = address; option.textContent = address;
      $('network').append(option);
    }
    $('network-choice').hidden = !defaults.requires_choice;
    if (!$('address').value && !defaults.requires_choice) {
      $('advanced').open = true;
      show('Could not find a local network address. Connect to your network and reload, or enter an address in Advanced.', true);
    }
    defaultsLoaded = true;
  }
  $('network').onchange = () => { $('address').value = $('network').value; };
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      let state, meshError;
      try { state = await api(''); } catch (error) {
        meshError = error;
        state = {members: [], requests: []};
        show('Pairing is unavailable. Existing terminal connections are listed below.', true);
      }
      pending = Boolean(state.joining);
      const incoming = state.incoming || [], sent = state.sent || [];
      $('incoming-section').hidden = !incoming.length;
      renderPairing(incoming, sent);
      renderBoardHost(state.board_host);

      $('receive-requests').hidden = Boolean(state.configured);
      $('retry-gateway').hidden = !state.configured || state.gateway_available !== false;
      $('mesh-title').textContent = state.mesh || 'Your computers';
      if (state.computer) {
        $('computer-name').value = state.computer.name;
        $('address').value = state.computer.address;
        $('computer-name').readOnly = $('address').readOnly = true;
        $('network-choice').hidden = true;
      }
      if (state.mesh) $('mesh-name').value = state.mesh;
      $('mesh-name').readOnly = Boolean(state.mesh);
      $('join-section').hidden = Boolean(state.mesh) && !pending;
      $('join-form').hidden = Boolean(state.mesh) || pending;
      $('joining').hidden = !pending;
      if (pending) {
        $('joining-description').textContent = `Waiting for ${state.joining.computer} to approve joining ${state.joining.mesh}.`;
        $('joining-code').textContent = state.joining.code || '';
      }
      // Remote entries left in the hosts file are offered for pairing only.
      try {
        const response = await fetch('/api/hosts?summary=1&candidates=1', {cache: 'no-store'});
        if (response.ok) configuredHosts = await response.json();
      } catch (_) {}
      const loadHosts = () => fetch('/api/hosts', {cache: 'no-store'}).then(r => r.ok ? r.json() : []).catch(() => []);
      let hosts = [];
      if (state.members.some(member => !member.local && member.state === 'paired')) hosts = hostDetails = await loadHosts();
      // Unpaired pages render from the fast summary; versions fill in once the full catalog lands.
      else if (configuredHosts.length) loadHosts().then(list => {
        const changed = versionKey(list) !== versionKey(hostDetails);
        hostDetails = list;
        if (changed) refresh().catch(() => {});
      });
      const thisBuild = buildText(await localBuild);
      const version = (build, local) => {
        const line = document.createElement('small'), text = local ? thisBuild : buildText(build);
        line.textContent = text ? `Version ${text}` : 'Version unknown';
        if (!local && text && thisBuild && text !== thisBuild) {
          line.textContent += ' · Different version from this computer'; line.className = 'different';
        }
        return line;
      };
      // Build before swapping, and only swap on change, so polling never blanks the list.
      const cards = [];
      for (const member of state.members) {
        const card = document.createElement('div'); card.className = 'card';
        const title = document.createElement('strong'); title.textContent = member.name;
        const address = document.createElement('p'); address.textContent = member.address;
        const status = document.createElement('span');
        const host = hosts.find(host => host.id === `mesh-${member.id}`);
        status.textContent = member.local ? 'This computer' : member.state === 'paired'
          ? (host && Array.isArray(host.sessions) && !host.error ? 'Connected' : 'Paired, connection unavailable. Check the address and retry')
          : 'Connecting to this computer. Keep Switchboard running on both computers.';
        card.append(title, address, status);
        if (member.local || (host && !host.error)) card.append(version(host && host.version, member.local));
        if (!member.local && member.state === 'paired' && (!host || host.error)) {
          const retry = document.createElement('button'); retry.textContent = 'Retry connection'; retry.onclick = () => action(refresh); card.append(retry);
        }
        cards.push(card);
      }
      const endpoints = new Set(state.members.map(member => endpoint(member.address)).filter(Boolean));
      const hasLocalMember = state.members.some(member => member.local);
      for (const host of configuredHosts) {
        if (!host.configured || !host.address) continue;
        const identity = endpoint(host.pairing_address || host.address);
        if ((host.local && hasLocalMember) || (identity && endpoints.has(identity))) continue;
        if (identity) endpoints.add(identity);
        const card = document.createElement('div'); card.className = 'card';
        const title = document.createElement('strong'); title.textContent = host.name;
        const address = document.createElement('p'); address.textContent = host.address;
        const status = document.createElement('span');
        status.textContent = host.local ? 'This computer · configured terminal connection'
          : 'In the hosts file · pair this computer to use its terminals';
        card.append(title, address, status);
        const detail = hostDetails.find(candidate => candidate.id === host.id);
        if (host.local || (detail && !detail.error)) card.append(version(detail && detail.version, host.local));
        if (!host.local && host.pairing_address) {
          const pair = document.createElement('button'); pair.textContent = 'Pair this computer';
          pair.disabled = Boolean(meshError);
          pair.onclick = () => action(() => addComputer(host.pairing_address));
          card.append(pair);
        }
        cards.push(card);
      }
      $('catalog').hidden = !cards.length && !state.requests.length;
      const memberSignature = JSON.stringify([Boolean(meshError), cards.map(card => card.textContent)]);
      if ($('members').dataset.signature !== memberSignature) {
        $('members').dataset.signature = memberSignature;
        $('members').replaceChildren(...cards);
      }
      const requestSignature=JSON.stringify(state.requests);
      if ($('requests').dataset.signature !== requestSignature) {
      $('requests').dataset.signature=requestSignature;
      $('requests').replaceChildren();
      for (const request of state.requests) {
        const card = document.createElement('div'); card.className = 'card';
        const description = document.createElement('p'); description.textContent = `${request.computer} (${request.address}) wants to join. Compare this code on both computers:`;
        const code = document.createElement('p'); code.className = 'code'; code.textContent = request.code;
        const approve = document.createElement('button'); approve.textContent = 'Codes match, approve';
        const deny = document.createElement('button'); deny.textContent = 'Deny';
        const decide = allow => action(async () => {
          await api('/approve', {invitation: request.invitation, request: request.request, code: request.code, allow});
          show(allow ? `Approved ${request.computer}. The other computer can now finish pairing.` : 'Pairing denied.');
          if (allow && invitationId === request.invitation) clearInvitation();
          await refresh();
        });
        approve.onclick = () => decide(true); deny.onclick = () => decide(false);
        card.append(description, code, approve, deny); $('requests').append(card);
      }
      }
    } finally { refreshing = false; }
  }
  function renderBoardHost(board) {
    $('board-section').hidden = !board;
    if (!board) return;
    const signature = JSON.stringify(board);
    if ($('board-section').dataset.signature === signature) return;
    $('board-section').dataset.signature = signature;
    $('board-form').hidden = !board.can_select;
    $('board-description').textContent = board.state === 'selected'
      ? `Message board: ${board.host_name || board.host_id}. Keep this computer running to use shared inboxes.`
      : board.state === 'conflict' ? 'Your computers disagree about the message board host. Resolve this before using shared messages.'
      : board.state === 'legacy_database' ? 'An existing message board needs migration before a host can be selected. Its messages have been kept.'
      : board.can_select ? 'Choose which paired computer will store your shared messages.'
      : 'Pair your computers before choosing where to store shared messages.';
    $('board-host').replaceChildren();
    const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = 'Choose a paired computer';
    $('board-host').append(prompt);
    for (const candidate of board.candidates || []) {
      const option = document.createElement('option'); option.value = candidate.id; option.textContent = candidate.name;
      $('board-host').append(option);
    }
  }
  $('board-form').onsubmit = event => {
    event.preventDefault();
    if (!$('board-host').value) return;
    action(async () => {
      const board = await api('/board-host', {host_id: $('board-host').value});
      renderBoardHost(board);
      show(`Shared messages are hosted by ${board.host_name || board.host_id}.`);
      await refresh();
    });
  };
  function endpoint(address) {
    try { return new URL(address).origin; } catch (_) { return null; }
  }
  async function addComputer(target) {
    const result = await api('/add', {target, name: $('mesh-name').value.trim(), ...local()});
    show(`Request sent to ${result.computer}. Compare code ${result.code} on the other computer.`);
    await refresh();
  }
  function renderPairing(incoming, sent) {
    // Polls must not replace a button while someone is focusing or clicking it.
    const signature = JSON.stringify([incoming, sent]);
    if ($('incoming').dataset.signature === signature) return;
    $('incoming').dataset.signature = signature;
    $('incoming').replaceChildren(); $('sent').replaceChildren();
    for (const request of incoming) {
      const card=document.createElement('div'); card.className='card';
      const title=document.createElement('strong'); title.textContent=`${request.computer} wants to connect`;
      const address=document.createElement('p'); address.textContent=request.address;
      const code=document.createElement('p'); code.className='code'; code.textContent=request.code;
      const description=document.createElement('p'); description.textContent='Compare this code on both computers. Allowing pairs your terminals with this computer after it confirms the code too.';
      const allow=document.createElement('button'); allow.textContent='Codes match, allow';
      const deny=document.createElement('button'); deny.textContent='Deny';
      const answer=accepted=>action(async()=>{
        await api('/answer',{invitation:request.invitation,code:request.code,allow:accepted});
        show(accepted?'Allowed. Confirm the matching code on the other computer to finish.':'Request denied.');
        await refresh();
      });
      allow.onclick=()=>answer(true); deny.onclick=()=>answer(false);
      card.append(title,address,code,description,allow,deny); $('incoming').append(card);
    }
    for (const request of sent) {
      const card=document.createElement('div'); card.className='card';
      const title=document.createElement('strong'); title.textContent=`Request sent to ${request.computer}`;
      const code=document.createElement('p'); code.className='code'; code.textContent=request.code;
      const description=document.createElement('p'); description.textContent='On the other computer, open Switchboard and allow this matching code. Then confirm its request above.';
      const cancel=document.createElement('button'); cancel.textContent='Cancel request';
      cancel.onclick=()=>action(async()=>{await api('/cancel',{invitation:request.invitation}); await refresh(); show('Request cancelled.');});
      card.append(title,code,description,cancel); $('sent').append(card);
    }
  }
  $('receive-requests').onclick=()=>action(async()=>{
    await api('/ready',local()); show('Ready to receive connection requests.'); await refresh();
  });
  $('add-form').onsubmit=event=>{
    event.preventDefault(); action(() => addComputer($('target-address').value.trim()));
  };
  function clearInvitation() {
    invitationId = null; $('invitation-link').value = ''; $('invitation').hidden = true;
  }
  $('create-form').onsubmit = event => {
    event.preventDefault(); action(async () => {
      const result = await api('/invitations', {name: $('mesh-name').value.trim(), ...local()});
      invitationId = result.id; $('invitation-link').value = result.link; $('invitation').hidden = false;
      $('expiry').textContent = `Expires ${new Date(result.expires * 1000).toLocaleTimeString()}`;
      show('Invitation ready. Share it over chat, then approve the matching computer here.'); await refresh();
    });
  };
  $('copy-link').onclick = () => action(async () => {
    try { await navigator.clipboard.writeText($('invitation-link').value); show('Invitation copied.'); }
    catch (_) { $('invitation-link').select(); show('Select and copy the invitation link.'); }
  });
  $('cancel-invitation').onclick = () => action(async () => {
    await api('/cancel', {invitation: invitationId}); clearInvitation(); show('Invitation cancelled.'); await refresh();
  });
  async function previewInvitation() {
    const link = $('join-link').value.trim(), version = ++previewVersion;
    previewLink = null; $('preview-card').hidden = true; $('preview').hidden = true;
    if (!link) return;
    try {
      const result = await api('/preview', {link});
      if (version !== previewVersion || link !== $('join-link').value.trim()) return;
      previewLink = link; $('preview-card').hidden = false;
      $('preview-description').textContent = `${result.computer} invites you to ${result.mesh}. Expires ${new Date(result.expires * 1000).toLocaleTimeString()}.`;
      show('Check the inviting computer, then choose Join computer.');
    } catch (error) {
      if (version !== previewVersion || link !== $('join-link').value.trim()) return;
      $('preview').hidden = false; show(error.message, true);
    }
  }
  $('preview').onclick = () => previewInvitation();
  $('join-link').oninput = () => {
    previewVersion++; previewLink = null; $('preview-card').hidden = true;
    clearTimeout(previewTimer); previewTimer = setTimeout(previewInvitation, 250);
  };
  $('join-form').onsubmit = event => {
    event.preventDefault(); action(async () => {
      if (previewLink !== $('join-link').value.trim()) throw new Error('Review the invitation before joining.');
      const result = await api('/join', {link: previewLink, ...local()});
      $('join-link').value = ''; previewLink = null; $('preview-card').hidden = true;
      show(result.state === 'paired' ? 'Paired. Checking terminal availability.' : 'Compare the code on the inviting computer and approve there.');
      await refresh();
    });
  };
  async function retry() {
    const result = await api('/retry', {});
    if (result.state === 'paired') show('Paired. Checking authenticated terminal availability.');
    else if (result.state === 'denied') { pending = false; show('The other computer denied pairing. Ask for a new invitation.', true); }
    await refresh();
  }
  $('retry').onclick = () => action(retry);
  $('retry-gateway').onclick = () => action(async () => {
    await api('/retry-gateway', {}); show('Gateway ready.'); await refresh();
  });
  // App-link handlers may open this local page with the invitation in its fragment.
  // Remove it from browser history before parsing; no public landing page receives it.
  if (location.hash) {
    const fragment = location.hash.slice(1); history.replaceState(null, '', location.pathname);
    $('join-link').value = fragment.startsWith('switchboard://join#') ? fragment : `switchboard://join#${fragment}`;
  }
  action(async () => {
    await refresh();
    try { await setupDefaults(); } catch (_) {
      $('advanced').open = true;
      show('Automatic setup is unavailable. Enter your connection in Advanced, or reload to retry.', true);
    }
    if ($('join-link').value.trim()) await previewInvitation();
  });
  setInterval(() => (pending ? retry() : refresh()).catch(error => {
    show(error.message, true); return refresh().catch(() => {});
  }), 3000);
  window.addEventListener('pagehide', () => { clearTimeout(previewTimer); previewVersion++; clearInvitation(); $('join-link').value = ''; previewLink = null; });
})();
