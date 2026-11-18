// Service worker for the Cloud edition: receives Web Push messages from the Worker and shows them as
// desktop notifications, even when no dashboard tab is open. Voice is not possible here (browsers do not
// allow speech from a service worker); open dashboard tabs get the events and speak them instead.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let data = {};
    try {
      data = e.data ? e.data.json() : {};
    } catch {
      data = {};
    }
    const items = Array.isArray(data.items) && data.items.length ? data.items.slice(0, 4) : [{ title: 'JARVIS', body: 'New activity on your bugs.', key: '', ids: [] }];
    // Hand the events to open dashboards so they can update the list and speak.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: 'jbd-push', events: Array.isArray(data.events) ? data.events : [] });
    // Always show the notification: browsers (Safari especially) revoke push access when a push shows nothing.
    await Promise.all(items.map((i) =>
      self.registration.showNotification(String(i.title || 'JARVIS'), {
        body: String(i.body || ''),
        tag: `jbd-${i.key || 'info'}-${(i.ids && i.ids[0]) || Date.now()}`,
        icon: '/icon.svg',
        badge: '/icon.svg',
        data: { key: i.key || '', ids: i.ids || [] },
        requireInteraction: i.importance === 'high',
      })
    ));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { key = '', ids = [] } = e.notification.data || {};
  const target = key && /^[A-Z][A-Z0-9_]+-\d+$/.test(key) ? `/?view=foryou&issue=${encodeURIComponent(key)}` : '/?view=foryou';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (w) {
      await w.focus();
      w.postMessage({ type: 'jbd-open', key, ids });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// Push services occasionally rotate subscriptions; re-register the new one with the server.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const opts = e.oldSubscription && e.oldSubscription.options;
    if (!opts) return;
    const sub = await self.registration.pushManager.subscribe(opts);
    await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-JBD': '1' },
      body: JSON.stringify({ ...sub.toJSON(), label: 'Renewed subscription' }),
    });
  })());
});
