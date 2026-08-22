// LECTRA Web Push & Native Service Worker
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  console.log("[PUSH SW] message received");
  let data = {
    title: "LECTRA Alert",
    body: "Student focus activity changed",
    tag: `lectra-${Date.now()}`,
    data: { url: "/" }
  };

  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (err) {
    console.warn("[PUSH SW] error parsing push payload json:", err);
    if (event.data) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body || "Student activity changed",
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    tag: data.tag || `lectra-${Date.now()}`,
    data: data.data || {},
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "LECTRA", options).then(() => {
      console.log("[PUSH SW] notification displayed:", data.title);
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
