// Installation and notification permission belong to this device, never to the mesh.
(() => {
  const KEY = 'switchboard-notifications-enabled';
  const $ = id => document.getElementById(id);
  let enabled = false, busy = false, failure = '', installPrompt;
  try { enabled = localStorage.getItem(KEY) === 'true'; } catch (_) {}
  const supported = () => globalThis.isSecureContext && 'Notification' in globalThis && 'serviceWorker' in navigator && 'PushManager' in globalThis;
  const remember = value => { enabled = value; try { localStorage.setItem(KEY, String(value)); } catch (_) {} };
  const on = () => enabled && supported() && Notification.permission === 'granted';
  // Start registration early; Android shows notifications through the worker.
  const worker = navigator.serviceWorker && globalThis.isSecureContext
    ? navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready)
    : Promise.resolve(null);
  // Keep startup rejection handled until the user opens Settings.
  worker.catch(() => {});

  function syncToggle() {
    const button = $('attention-notifications'), help = $('attention-notifications-help');
    if (!button) return;
    button.setAttribute('aria-pressed', String(on()));
    button.disabled = busy || !supported();
    if ($('test-notification')) $('test-notification').disabled = busy || !on();
    help.textContent = failure || (!globalThis.isSecureContext
      ? 'Open Switchboard over HTTPS to install it and enable notifications on your phone.'
      : !supported() ? 'Push notifications are unavailable in this browser.'
      : Notification.permission === 'denied' ? 'Notifications are blocked. Allow them in this site’s browser settings, then turn this on.'
      : 'On this device only. Alerts from all paired computers for approval, input, and results ready to review, even when Switchboard is closed.');
  }
  async function api(path, body) {
    const response = await fetch('/api/push/' + path, {
      method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error('The relay could not save or deliver notifications. Try again.');
    return response.json();
  }
  const bytes = key => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  async function subscribe() {
    const registration = await worker;
    if (!registration) throw Error('Notifications need HTTPS and a supported browser.');
    const config = await api('config');
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const previous = new Uint8Array(subscription.options.applicationServerKey || []), current = bytes(config.publicKey);
      if (previous.length !== current.length || previous.some((value, i) => value !== current[i])) {
        await subscription.unsubscribe(); subscription = null;
      }
    }
    subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(config.publicKey) });
    await api('subscribe', subscription.toJSON());
  }
  async function setEnabled(next) {
    if (busy) return on();
    busy = true; failure = ''; syncToggle();
    try {
      if (next) {
        if (!supported()) throw Error('Notifications need HTTPS and a supported browser.');
        // Called directly by a click, before any awaits, preserving user activation.
        const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (permission !== 'granted') { remember(false); return false; }
        await subscribe(); remember(true);
      } else {
        const registration = await worker;
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          // Remove server state before reporting Off. Offline disable stays retryable.
          await api('unsubscribe', { endpoint: subscription.endpoint });
          await subscription.unsubscribe();
        }
        remember(false);
        for (const notification of await registration?.getNotifications() || []) notification.close();
      }
    } catch (error) { failure = error.message || 'Could not change notifications. Try again.'; }
    finally { busy = false; syncToggle(); }
    return on();
  }
  async function testNotification() {
    busy = true; failure = ''; syncToggle();
    try {
      const subscription = await (await worker).pushManager.getSubscription();
      if (!subscription) throw Error('Turn notifications off and on to reconnect this device.');
      await api('test', { endpoint: subscription.endpoint });
      failure = 'Test sent. Check your device’s notifications.';
    } catch (error) { failure = error.message; }
    finally { busy = false; syncToggle(); }
  }
  function check(items) {
    try {
      const count = items?.length || 0;
      const result = count ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.();
      result?.catch(() => {});
    } catch (_) {}
  }
  function syncInstall() {
    const installed = matchMedia('(display-mode: standalone)').matches;
    if ($('install-switchboard')) $('install-switchboard').hidden = installed || !installPrompt;
    if ($('install-help')) $('install-help').textContent = installed ? 'Switchboard is installed on this device.'
      : !globalThis.isSecureContext ? 'Open Switchboard over HTTPS to install it on your phone.'
      : 'On Android, use your browser menu → Add to Home screen → Install.';
  }
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; syncInstall(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; syncInstall(); });
  function bind() {
    $('attention-notifications')?.addEventListener('click', () => setEnabled(!on()));
    $('test-notification')?.addEventListener('click', testNotification);
    $('install-switchboard')?.addEventListener('click', async () => {
      const prompt = installPrompt; if (!prompt) return;
      installPrompt = null; await prompt.prompt(); await prompt.userChoice; syncInstall();
    });
    syncToggle(); syncInstall();
    // Refresh persisted relay registration after reconnect/restart, never prompt automatically.
    if (on()) subscribe().catch(() => { failure = 'Could not reconnect notifications. Turn them off and on to retry.'; syncToggle(); });
  }
  globalThis.SwitchboardNotifications = { check, setEnabled, syncToggle, get enabled() { return on(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
