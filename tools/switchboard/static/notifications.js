// Attention notifications for this browser/device only. Permission and the
// on/off choice are never shared with paired computers: each phone decides
// for itself. Foreground path uses the Notification API while the page is
// open (including backgrounded on Android); sw.js handles future push events.
(() => {
  const ENABLED_KEY = 'switchboard-notifications-enabled';
  const NOTIFIED_KEY = 'switchboard-notified-attention';
  const load = key => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (_) { return {}; } };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} };
  let enabled = false;
  try { enabled = localStorage.getItem(ENABLED_KEY) === 'true'; } catch (_) {}
  let notified = load(NOTIFIED_KEY);
  let ready = false;

  const supported = () => typeof Notification !== 'undefined';
  const granted = () => supported() && Notification.permission === 'granted';

  function syncToggle() {
    const button = document.getElementById('attention-notifications');
    if (!button) return;
    const on = enabled && granted();
    button.setAttribute('aria-pressed', String(on));
    button.classList.toggle('selected', on);
    const help = document.getElementById('attention-notifications-help');
    if (help) {
      help.textContent = !supported()
        ? 'This browser does not support notifications. On Android, install Switchboard from Chrome and open the installed app.'
        : Notification.permission === 'denied'
          ? 'Notifications are blocked for this site. Allow them in the browser site settings, then turn this on again.'
          : 'On this device only. Alerts when a tab needs approval or input, or is ready to review, while Switchboard is open or in the background.';
    }
  }

  async function setEnabled(next) {
    if (!next) { enabled = false; try { localStorage.setItem(ENABLED_KEY, 'false'); } catch (_) {} syncToggle(); return false; }
    if (!supported()) { syncToggle(); return false; }
    let permission = Notification.permission;
    if (permission === 'default') { try { permission = await Notification.requestPermission(); } catch (_) {} }
    enabled = permission === 'granted';
    try { localStorage.setItem(ENABLED_KEY, String(enabled)); } catch (_) {}
    syncToggle();
    return enabled;
  }

  function bindToggle() {
    const button = document.getElementById('attention-notifications');
    if (!button || button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => { setEnabled(!(enabled && granted())); });
    syncToggle();
  }

  function show(item) {
    const options = {
      body: `${item.label || 'Needs your attention'} · ${item.machine || ''}`.replace(/ · $/, ''),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: item.key,
      data: { url: '/' },
    };
    try {
      const note = new Notification(item.title || 'Switchboard', options);
      note.onclick = () => { try { window.focus(); } catch (_) {} note.close(); };
      return true;
    } catch (_) {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(reg => reg.showNotification(item.title || 'Switchboard', options)).catch(() => {});
        return true;
      }
      return false;
    }
  }

  // items: [{key, sig, title, machine, label}] for tabs that need the user now.
  // A tab alerts once per sig; it can alert again when its token/state changes.
  function check(items) {
    const list = Array.isArray(items) ? items : [];
    if (navigator.setAppBadge) {
      try {
        const result = list.length ? navigator.setAppBadge(list.length) : navigator.clearAppBadge();
        if (result && result.catch) result.catch(() => {});
      } catch (_) {}
    }
    const present = new Set(list.map(item => item.key));
    let changed = false;
    for (const key of Object.keys(notified)) {
      if (!present.has(key)) { delete notified[key]; changed = true; }
    }
    if (!enabled || !granted()) { if (changed) save(NOTIFIED_KEY, notified); return 0; }
    let shown = 0;
    for (const item of list) {
      const sig = item.sig || item.label || 'attention';
      if (notified[item.key] === sig) continue;
      // Remember before showing so a burst or a failed show cannot repeat.
      notified[item.key] = sig; changed = true;
      // Do not alert for the tab the user is already looking at.
      if (item.active && !document.hidden && document.hasFocus()) continue;
      if (show(item)) {
        shown++;
        try { navigator.vibrate && navigator.vibrate(120); } catch (_) {}
      }
    }
    if (changed) save(NOTIFIED_KEY, notified);
    return shown;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  globalThis.SwitchboardNotifications = { check, setEnabled, syncToggle, get enabled() { return enabled && granted(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindToggle);
  else bindToggle();
  registerServiceWorker();
  ready = true;
})();
