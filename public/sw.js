// sw.js
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "테니스 알림", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "🎾 테니스 코트 알림";
  const options = {
    body: data.body || "예약 가능한 시간이 생겼어요.",
    icon: "/icon-192.png",
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  if (url) {
    event.waitUntil(clients.openWindow(url));
  }
});
