// push.js
require("dotenv").config();
const webpush = require("web-push");
const { getSubscriptions, removeSubscriptionByEndpoint } = require("./store");

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:you@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function notifyAll(payload) {
  const subs = getSubscriptions();
  const body = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
      } catch (err) {
        // 구독이 만료/삭제된 경우 (410 Gone, 404 Not Found) 정리
        if (err.statusCode === 404 || err.statusCode === 410) {
          removeSubscriptionByEndpoint(sub.endpoint);
        } else {
          console.error("[push] 알림 발송 실패:", err.message);
        }
      }
    })
  );
}

module.exports = { notifyAll };
