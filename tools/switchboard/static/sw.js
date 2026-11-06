// Switchboard service worker. Deliberately network-only: terminals, APIs and
// relay updates must never be served stale from a cache. The worker exists so
// the site is installable and can show push notifications.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Switchboard';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'A tab needs your attention.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'switchboard-attention',
    data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      await client.focus();
      if ('navigate' in client) { try { await client.navigate(url); } catch (_) {} }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
