// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { randomUUID } = require("crypto");

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

// 브라우저 푸시 구독 등록
app.post("/api/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    return res.status(400).json({ error: "invalid subscription" });
  }
  store.addSubscription(sub);
  res.json({ ok: true });
});

// 구독 해제
app.post("/api/unsubscribe", (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) store.removeSubscriptionByEndpoint(endpoint);
  res.json({ ok: true });
});

// 감시 목록 조회
app.get("/api/watches", (req, res) => {
  res.json(store.getWatches());
});

// 스케줄러가 실제로 잘 돌고 있는지 확인용 상태 API
app.get("/api/status", (req, res) => {
  res.json({
    scheduler: store.getSchedulerStatus(),
    watchCount: store.getWatches().length,
    subscriptionCount: store.getSubscriptions().length,
    checkIntervalMin: parseInt(process.env.CHECK_INTERVAL_MIN || "3", 10),
    serverTime: new Date().toISOString(),
  });
});

// 예약 가능 시간표 변경 이력 조회 (최신순)
app.get("/api/change-log", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  res.json(store.readChangeLog(limit));
});

// 변경 이력 로그 파일 통째로 다운로드 (JSON Lines)
app.get("/api/change-log/download", (req, res) => {
  const filePath = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "availability-changes.jsonl");
  res.download(filePath, "availability-changes.jsonl", (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "아직 기록된 로그가 없어요." });
    }
  });
});

// 특정 감시 항목의 "내일부터 7일간" 예약 가능 시간표
// 스케줄러가 3분마다 갱신해두는 캐시(known-state)를 그대로 보여주기 때문에
// 새로 사이트에 요청을 보내지 않고도, 빈자리가 생기거나 사라지면 자동으로 반영돼요.
app.get("/api/timetable/:watchId", (req, res) => {
  const watch = store.getWatches().find((w) => w.id === req.params.watchId);
  if (!watch) return res.status(404).json({ error: "감시 항목을 찾을 수 없어요." });

  const state = store.getKnownState()[watch.id];
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
      // undefined면 "아직 이 날짜를 확인 안 함", 빈 배열이면 "확인은 했는데 빈자리 없음"
      slots: slotKeys === undefined ? null : slotKeys.map((k) => {
        const [court, time] = k.split("|");
        return { court, time };
      }),
    });
  }

  res.json({
    watch: { id: watch.id, label: watch.label, provider: watch.provider, mode: watch.mode },
    days,
  });
});

// 감시 등록: { provider, grp, label, date }
app.post("/api/watches", (req, res) => {
  const { provider: providerId, grp, label, date } = req.body;
  if (!providerId || !grp || !date) {
    return res.status(400).json({ error: "provider, grp, date는 필수입니다." });
  }

  let provider;
  try {
    provider = getProvider(providerId);
  } catch {
    return res.status(400).json({ error: "알 수 없는 provider입니다." });
  }

  const watch = {
    id: randomUUID(),
    provider: providerId,
    grp: Number(grp),
    label: label || `${provider.name} · ${provider.courts[grp] || `코트 ${grp}`}`,
    mode: "date",
    date,
    createdAt: new Date().toISOString(),
  };
  store.addWatch(watch);
  res.json(watch);
});

// 감시 삭제
app.delete("/api/watches/:id", (req, res) => {
  store.removeWatch(req.params.id);
  res.json({ ok: true });
});

// 특정 사이트의 전체 코트를 "이번 달 전체" 모드로 한 번에 감시 등록
app.post("/api/watches/bulk-all-courts", (req, res) => {
  const providerId = req.body.provider || "gytennis";
  let provider;
  try {
    provider = getProvider(providerId);
  } catch {
    return res.status(400).json({ error: "알 수 없는 provider입니다." });
  }

  const existing = store.getWatches();
  const alreadyWatchedGrps = new Set(
    existing.filter((w) => w.mode === "month" && w.provider === providerId).map((w) => w.grp)
  );

  const created = [];
  for (const grpStr of Object.keys(provider.courts)) {
    const grp = Number(grpStr);
    if (alreadyWatchedGrps.has(grp)) continue; // 중복 등록 방지
    const watch = {
      id: randomUUID(),
      provider: providerId,
      grp,
      label: `${provider.name} · ${provider.courts[grp]}`,
      mode: "month",
      createdAt: new Date().toISOString(),
    };
    store.addWatch(watch);
    created.push(watch);
  }

  res.json({ created, skippedCount: alreadyWatchedGrps.size });
});

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
