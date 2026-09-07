// push.js
require("dotenv").config();
const webpush = require("web-push");
const { getSubscriptionsByDevices, removeSubscriptionByEndpoint } = require("./store");

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:you@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// deviceIds에 해당하는 구독자에게만 알림을 보냅니다.
// (예전 notifyAll처럼 모두에게 보내지 않고, 그 대상(target)에 관심 있는 사람에게만 보냄)
async function notifyDevices(deviceIds, payload) {
  if (!deviceIds || deviceIds.length === 0) return;

  const subs = await getSubscriptionsByDevices(deviceIds);
  const body = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body);
      } catch (err) {
        // 구독이 만료/삭제된 경우 (410 Gone, 404 Not Found) 정리
        if (err.statusCode === 404 || err.statusCode === 410) {
          await removeSubscriptionByEndpoint(sub.endpoint);
        } else {
          console.error("[push] 알림 발송 실패:", err.message);
        }
      }
    })
  );
}

module.exports = { notifyDevices };
