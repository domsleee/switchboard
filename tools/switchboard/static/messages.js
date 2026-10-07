(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let selected = null, thread = null, project = '', cursor = null;
  let directoryVersion = 0, historyVersion = 0;
  const text = (tag, value, className) => {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  const date = value => value == null ? 'Unknown time' : new Date(value).toLocaleString();
  function status(id, value, error = false) {
    $(id).textContent = value;
    $(id).classList.toggle('error', error);
  }
  async function get(path, after) {
    const query = new URLSearchParams({limit: '25'});
    if (project) query.set('project', project);
    if (after != null) query.set('after', String(after));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/message-board/' + path + '?' + query, {signal: controller.signal, cache: 'no-store'});
      if (!response.ok) {
        let body = {};
        try { body = await response.json(); } catch {}
        if (body.configured === false || body.code === 'not_configured') {
          throw Error('Shared message board is not configured. Open Manage computers to pair your computers and choose a message board host.');
        }
        throw Error(typeof body.error === 'string' ? body.error : 'Message board unavailable. Check the shared board connection and try Refresh.');
      }
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw Error('Message board unavailable. Check the shared board connection and try Refresh.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function markSelection() {
    for (const button of $('inboxes').querySelectorAll('button')) {
      button.setAttribute('aria-current', String(button.dataset.key === selected?.key));
    }
  }
  function choose(inbox) {
    selected = inbox; thread = null;
    $('heading').textContent = inbox.label;
    $('location').textContent = inbox.location || '';
    $('back').hidden = true;
    markSelection();
    loadHistory();
  }
  function inboxButton(inbox, count, detail, agent = false) {
    const button = text('button', `${inbox.label} · ${count || 0} awaiting acknowledgment`, agent ? 'agent' : '');
    button.dataset.key = inbox.key;
    if (detail) button.append(text('small', detail));
    button.addEventListener('click', () => choose(inbox));
    return button;
  }
  async function boardHost() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch('/api/mesh/board-host', {cache: 'no-store', signal: controller.signal});
      return response.ok ? await response.json() : null;
    } catch (_) { return null; } finally { clearTimeout(timer); }
  }
  async function loadDirectory() {
    const version = ++directoryVersion;
    status('status', 'Loading inboxes…');
    try {
      const [board, result] = await Promise.all([boardHost(), get('inboxes').then(data => ({data}), error => ({error}))]);
      if (version !== directoryVersion) return;
      $('board-host').textContent = board?.state === 'selected' ? `Message board host: ${board.host_name || board.host_id}`
        : board?.state === 'unconfigured' ? 'Choose a message board host in Manage computers.' : '';
      if (result.error) throw result.error;
      const data = result.data;
      $('inboxes').replaceChildren();
      const visibleInboxes = new Set();
      for (const machine of data.machines) {
        const section = document.createElement('section');
        section.append(text('h2', machine.name));
        const machineInbox = {key: 'computer:' + machine.id, label: machine.name + ' / Computer inbox', path: 'machines/' + encodeURIComponent(machine.id) + '/inbox'};
        visibleInboxes.add(machineInbox.key);
        section.append(inboxButton(machineInbox, machine.unread_count, machine.id));
        for (const agent of machine.participants) {
          const location = agent.terminal ? `Terminal location: ${agent.terminal.host} / ${agent.terminal.session} / tab ${agent.terminal.tab_id}` : 'No terminal location registered';
          const inbox = {key: 'agent:' + agent.id, label: machine.name + ' / ' + agent.name, path: 'participants/' + encodeURIComponent(agent.id) + '/inbox', location: `${location} · Agent session: ${agent.id}`};
          visibleInboxes.add(inbox.key);
          section.append(inboxButton(inbox, agent.unread_count, `${agent.project} · ${agent.active ? 'Registered' : 'Retired'} · ${agent.id}`, true));
        }
        $('inboxes').append(section);
      }
      if (selected && !visibleInboxes.has(selected.key)) {
        ++historyVersion;
        selected = null; thread = null; cursor = null;
        $('heading').textContent = 'Choose an inbox';
        $('location').textContent = '';
        $('messages').replaceChildren();
        $('back').hidden = true;
        $('more').hidden = true;
        status('history-status', '');
      }
      markSelection();
      status('status', data.machines.length ? 'Inboxes updated. Counts show messages awaiting agent acknowledgment.' : 'No computers have registered with this board yet.');
    } catch (error) {
      if (version === directoryVersion) status('status', error.message, true);
    }
  }
  function renderMessage(message) {
    const article = document.createElement('article');
    article.append(text('h3', `${message.sender_name} · ${message.sender_machine_name}`));
    article.append(text('p', `${date(message.created_at)} · Project: ${message.project} · ${message.id}`, 'meta'));
    article.append(text('p', message.body, 'body'));
    const receipts = document.createElement('ul');
    for (const delivery of message.deliveries) {
      const receipt = delivery.acknowledged_at == null ? 'Awaiting acknowledgment' : 'Acknowledged ' + date(delivery.acknowledged_at);
      receipts.append(text('li', `${delivery.machine_name} / ${delivery.name} (${delivery.recipient_kind === 'computer' ? 'computer' : 'agent'}) · ${receipt}`, 'receipt'));
    }
    article.append(receipts);
    if (!thread) {
      const button = text('button', 'View thread');
      button.addEventListener('click', () => {
        thread = message.thread_id;
        $('heading').textContent = 'Thread · ' + thread;
        $('back').hidden = false;
        loadHistory();
      });
      article.append(button);
    }
    return article;
  }
  async function loadHistory(append = false) {
    if (!selected) return;
    const version = ++historyVersion;
    const after = append ? cursor : null;
    $('more').hidden = true;
    if (!append) { cursor = null; $('messages').replaceChildren(); }
    status('history-status', 'Loading messages…');
    try {
      const page = await get(thread ? 'threads/' + encodeURIComponent(thread) : selected.path, after);
      if (version !== historyVersion) return;
      for (const message of page.items) $('messages').append(renderMessage(message));
      cursor = page.next_cursor;
      $('more').hidden = cursor == null;
      status('history-status', $('messages').children.length ? '' : 'No messages in this inbox for the selected project.');
    } catch (error) {
      if (version !== historyVersion) return;
      status('history-status', error.message, true);
      $('more').hidden = !append;
    }
  }
  $('filter').addEventListener('submit', event => {
    event.preventDefault();
    project = $('project').value.trim();
    loadDirectory();
    if (selected) choose(selected);
  });
  $('refresh').addEventListener('click', () => { loadDirectory(); loadHistory(); });
  $('more').addEventListener('click', () => loadHistory(true));
  $('back').addEventListener('click', () => choose(selected));
  loadDirectory();
})();
