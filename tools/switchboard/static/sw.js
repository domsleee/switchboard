// Network only: terminal connections, APIs and updates must never come from a cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch (_) {}
  event.waitUntil(self.registration.showNotification(data.title || 'Switchboard', {
    body: data.body || 'A tab needs your attention.',
    icon: '/icon-192.png', tag: data.tag || 'switchboard-attention',
    data: { url: terminalUrl(data.url) },
  }));
});
function terminalUrl(value) {
  try {
    const url = new URL(value || '/', self.location.origin);
    if (url.origin === self.location.origin && url.pathname === '/') return url.href;
  } catch (_) {}
  return new URL('/', self.location.origin).href;
}
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = terminalUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // An exact existing terminal can be focused without reloading its connections.
    for (const client of windows) if (client.frameType !== 'nested' && client.url === url) { await client.focus(); return; }
    // Do not navigate terminal iframes or unrelated pages in this origin.
    for (const client of windows) {
      if (client.frameType === 'nested' || new URL(client.url).pathname !== '/') continue;
      await client.navigate(url); await client.focus(); return;
    }
    await self.clients.openWindow(url);
  })());
});
