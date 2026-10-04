(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let invitationId = null;
  let pending = false;
  let refreshing = false;
  let previewLink = null;
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
    const buttons = [...document.querySelectorAll('button')];
    buttons.forEach(button => button.disabled = true);
    try { await fn(); } catch (error) { show(error.message || 'Pairing unavailable. Check the network and retry.', true); }
    finally { buttons.forEach(button => button.disabled = false); }
  }
  function local() {
    return {computer_name: $('computer-name').value.trim(), address: $('address').value.trim()};
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const state = await api('');
      pending = Boolean(state.joining);
      $('retry-gateway').hidden = !state.configured || state.gateway_available !== false;
      $('mesh-title').textContent = state.mesh || 'Your computers';
      if (state.computer) {
        $('computer-name').value = state.computer.name;
        $('address').value = state.computer.address;
        $('computer-name').readOnly = $('address').readOnly = true;
      }
      if (state.mesh) $('mesh-name').value = state.mesh;
      $('mesh-name').readOnly = Boolean(state.mesh);
      $('create-section').hidden = Boolean(state.mesh) && !state.administrator;
      $('join-form').hidden = Boolean(state.mesh) || pending;
      $('joining').hidden = !pending;
      if (pending) {
        $('joining-description').textContent = `Waiting for ${state.joining.computer} to approve joining ${state.joining.mesh}.`;
        $('joining-code').textContent = state.joining.code || '';
      }
      $('members').replaceChildren();
      const hosts = state.members.some(member => !member.local && member.state === 'paired')
        ? await fetch('/api/hosts', {cache: 'no-store'}).then(r => r.ok ? r.json() : []).catch(() => []) : [];
      for (const member of state.members) {
        const card = document.createElement('div'); card.className = 'card';
        const title = document.createElement('strong'); title.textContent = member.name;
        const address = document.createElement('p'); address.textContent = member.address;
        const status = document.createElement('span');
        const host = hosts.find(host => host.id === `mesh-${member.id}`);
        status.textContent = member.local ? 'This computer' : member.state === 'paired'
          ? (host && Array.isArray(host.sessions) && !host.error ? 'Connected' : 'Paired, connection unavailable — check the address and retry')
          : 'Credential distribution pending — retry pairing on the joining computer';
        card.append(title, address, status);
        if (!member.local && member.state === 'paired' && (!host || host.error)) {
          const retry = document.createElement('button'); retry.textContent = 'Retry connection'; retry.onclick = () => action(refresh); card.append(retry);
        }
        $('members').append(card);
      }
      $('requests').replaceChildren();
      for (const request of state.requests) {
        const card = document.createElement('div'); card.className = 'card';
        const description = document.createElement('p'); description.textContent = `${request.computer} (${request.address}) wants to join. Compare this code on both computers:`;
        const code = document.createElement('p'); code.className = 'code'; code.textContent = request.code;
        const approve = document.createElement('button'); approve.textContent = 'Codes match — Approve';
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
    } finally { refreshing = false; }
  }
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
  $('preview').onclick = () => action(async () => {
    const link = $('join-link').value.trim(); const result = await api('/preview', {link});
    previewLink = link; $('preview-card').hidden = false;
    $('preview-description').textContent = `${result.computer} (${result.address}) invites you to ${result.mesh}. The invitation expires ${new Date(result.expires * 1000).toLocaleTimeString()}.`;
    show('Review the inviting computer and mesh, then explicitly join.');
  });
  $('join-link').oninput = () => { previewLink = null; $('preview-card').hidden = true; };
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
    else if (result.state === 'denied') { pending = false; show('The administrator denied pairing. Ask for a new invitation.', true); }
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
  refresh().catch(error => show(error.message, true));
  setInterval(() => (pending ? retry() : refresh()).catch(error => {
    show(error.message, true); return refresh().catch(() => {});
  }), 3000);
  window.addEventListener('pagehide', () => { clearInvitation(); $('join-link').value = ''; previewLink = null; });
})();
