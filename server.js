// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const store = require("./store");
const scheduler = require("./scheduler");
const { getProvider, listProviders } = require("./providers");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 프론트에서 push 구독할 때 필요한 공개키 전달
app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || "" });
});

// 지원하는 모든 사이트(프로바이더) + 각 사이트의 코트 목록
app.get("/api/providers", (req, res) => {
  res.json(listProviders());
});

// 브라우저 푸시 구독 등록: { deviceId, endpoint, keys }
app.post("/api/subscribe", async (req, res) => {
  const { deviceId, ...sub } = req.body || {};
  if (!deviceId || !sub || !sub.endpoint) {
    return res.status(400).json({ error: "deviceId, endpoint가 필요합니다." });
  }
  await store.addSubscription(deviceId, sub);
  res.json({ ok: true });
});

// 구독 해제
app.post("/api/unsubscribe", async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await store.removeSubscriptionByEndpoint(endpoint);
  res.json({ ok: true });
});

// 이 기기(deviceId)가 관심 등록한 감시 목록 조회
app.get("/api/watches", async (req, res) => {
  const deviceId = req.query.deviceId;
  if (!deviceId) return res.status(400).json({ error: "deviceId 쿼리파라미터가 필요합니다." });

  const [interests, targets] = await Promise.all([store.getInterestsByDevice(deviceId), store.getTargets()]);
  const targetById = new Map(targets.map((t) => [t.id, t]));

  const result = interests
    .map((i) => {
      const target = targetById.get(i.targetId);
      if (!target) return null;
      return { interestId: i.id, ...target };
    })
    .filter(Boolean);

  res.json(result);
});

// 스케줄러가 실제로 잘 돌고 있는지 확인용 상태 API (전체 현황, 특정 기기와 무관)
app.get("/api/status", async (req, res) => {
  const [schedulerStatus, targets, interests, subs] = await Promise.all([
    store.getSchedulerStatus(),
    store.getTargets(),
    store.getInterests(),
    store.getSubscriptions(),
  ]);
  res.json({
    scheduler: schedulerStatus,
    targetCount: targets.length,
    interestCount: interests.length,
    subscriptionCount: subs.length,
    checkIntervalMin: parseInt(process.env.CHECK_INTERVAL_MIN || "3", 10),
    serverTime: new Date().toISOString(),
  });
});

// 예약 가능 시간표 변경 이력 조회 (최신순, 전체 공용 - 특정 시설의 공개 예약현황 로그라
// 개인정보가 아니라서 전체 공개로 둡니다)
app.get("/api/change-log", async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  res.json(await store.readChangeLog(limit));
});

// 변경 이력 로그 파일 통째로 다운로드 (로컬 파일 저장소일 때만 동작)
app.get("/api/change-log/download", (req, res) => {
  if (process.env.NETLIFY) {
    return res
      .status(400)
      .json({ error: "Netlify 배포에서는 다운로드 대신 /api/change-log?limit=1000 을 이용해주세요." });
  }
  const filePath = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "availability-changes.jsonl");
  res.download(filePath, "availability-changes.jsonl", (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "아직 기록된 로그가 없어요." });
    }
  });
});

// 특정 감시 대상의 "내일부터 7일간" 예약 가능 시간표
app.get("/api/timetable/:targetId", async (req, res) => {
  const targets = await store.getTargets();
  const target = targets.find((t) => t.id === req.params.targetId);
  if (!target) return res.status(404).json({ error: "감시 대상을 찾을 수 없어요." });

  const knownState = await store.getKnownState();
  const state = knownState[target.id];
  const slotsByDate = (state && state.slots) || {};

  const days = [];
  const today = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const slotKeys = slotsByDate[dateStr];
    days.push({
      date: dateStr,
      slots: slotKeys === undefined ? null : slotKeys.map((k) => {
        const [court, time] = k.split("|");
        return { court, time };
      }),
    });
  }

  res.json({
    target: { id: target.id, label: target.label, provider: target.provider, mode: target.mode },
    days,
  });
});

// 감시 등록(특정 코트+날짜): { deviceId, provider, grp, label, date }
// 같은 대상이 이미 있으면 재사용하고, 이 기기의 관심(interest)만 새로 추가합니다.
app.post("/api/watches", async (req, res) => {
  const { deviceId, provider: providerId, grp, label, date } = req.body;
  if (!deviceId || !providerId || !grp || !date) {
    return res.status(400).json({ error: "deviceId, provider, grp, date는 필수입니다." });
  }

  let provider;
  try {
    provider = getProvider(providerId);
  } catch {
    return res.status(400).json({ error: "알 수 없는 provider입니다." });
  }

  const target = await store.findOrCreateTarget({
    provider: providerId,
    grp: Number(grp),
    mode: "date",
    date,
    label: label || `${provider.name} · ${provider.courts[grp] || `코트 ${grp}`}`,
  });
  const interest = await store.addInterest(deviceId, target.id);

  res.json({ interestId: interest.id, ...target });
});

// 감시 삭제: 이 기기의 관심(interest)만 지웁니다. 다른 사람이 아직 관심있으면 대상 자체는 남아요.
app.delete("/api/watches/:interestId", async (req, res) => {
  await store.removeInterest(req.params.interestId);
  res.json({ ok: true });
});

// 특정 사이트의 전체 코트를 "이번 달 전체" 모드로 한 번에 관심 등록: { deviceId, provider }
app.post("/api/watches/bulk-all-courts", async (req, res) => {
  const { deviceId, provider: providerId = "gytennis" } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId가 필요합니다." });

  let provider;
  try {
    provider = getProvider(providerId);
  } catch {
    return res.status(400).json({ error: "알 수 없는 provider입니다." });
  }

  const existingInterests = await store.getInterestsByDevice(deviceId);
  const targets = await store.getTargets();
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const alreadyWatchedGrps = new Set(
    existingInterests
      .map((i) => targetById.get(i.targetId))
      .filter((t) => t && t.mode === "month" && t.provider === providerId)
      .map((t) => t.grp)
  );

  const created = [];
  for (const grpStr of Object.keys(provider.courts)) {
    const grp = Number(grpStr);
    if (alreadyWatchedGrps.has(grp)) continue; // 이 기기가 이미 관심 등록한 코트는 건너뜀

    const target = await store.findOrCreateTarget({
      provider: providerId,
      grp,
      mode: "month",
      label: `${provider.name} · ${provider.courts[grp]}`,
    });
    await store.addInterest(deviceId, target.id);
    created.push(target);
  }

  res.json({ created, skippedCount: alreadyWatchedGrps.size });
});

// Netlify Functions(서버리스)에서는 이 파일을 require해서 app만 재사용하고,
// 로컬(node server.js)로 직접 실행했을 때만 실제로 포트를 열고 스케줄러를 켭니다.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT} 에서 실행 중`);
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      console.warn(
        "[server] VAPID 키가 설정되어 있지 않아요. `npx web-push generate-vapid-keys` 로 만들어서 .env에 넣어주세요."
      );
    } else {
      scheduler.start();
    }
  });
}

module.exports = { app };
