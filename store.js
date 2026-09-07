// store.js
// 별도 DB 없이 JSON 파일로 상태를 저장하는 아주 단순한 저장소입니다.
// 사용자가 많아지거나 운영을 오래 할 계획이면 SQLite 등으로 바꾸는 걸 추천해요.

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const WATCHES_FILE = path.join(DATA_DIR, "watches.json");
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
const STATE_FILE = path.join(DATA_DIR, "known-state.json");

function ensureFile(file, fallback) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
}

function readJson(file, fallback) {
  ensureFile(file, fallback);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureFile(file, data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- 감시 목록 (어떤 시설/날짜를 감시할지) ----
// watch: { id, grp, label, mode: "date" | "month", date? (mode=date일 때만), createdAt }
function getWatches() {
  return readJson(WATCHES_FILE, []);
}
function addWatch(watch) {
  const watches = getWatches();
  watches.push(watch);
  writeJson(WATCHES_FILE, watches);
  return watch;
}
function removeWatch(id) {
  const watches = getWatches().filter((w) => w.id !== id);
  writeJson(WATCHES_FILE, watches);
}

// ---- 푸시 구독 정보 ----
function getSubscriptions() {
  return readJson(SUBS_FILE, []);
}
function addSubscription(sub) {
  const subs = getSubscriptions();
  const exists = subs.some((s) => s.endpoint === sub.endpoint);
  if (!exists) {
    subs.push(sub);
    writeJson(SUBS_FILE, subs);
  }
  return sub;
}
function removeSubscriptionByEndpoint(endpoint) {
  const subs = getSubscriptions().filter((s) => s.endpoint !== endpoint);
  writeJson(SUBS_FILE, subs);
}

// ---- 마지막으로 확인한 예약 가능 슬롯 상태 (watchId -> 슬롯 배열) ----
function getKnownState() {
  return readJson(STATE_FILE, {});
}
function setKnownState(watchId, slots) {
  const state = getKnownState();
  state[watchId] = slots;
  writeJson(STATE_FILE, state);
}

// ---- 스케줄러 상태 (마지막 확인 시각/결과) - 앱 화면에 "잘 돌고 있는지" 보여주기 위함 ----
const STATUS_FILE = path.join(DATA_DIR, "status.json");
function getSchedulerStatus() {
  return readJson(STATUS_FILE, {
    lastRunAt: null,
    lastRunOk: null,
    lastError: null,
    checkedCount: 0,
  });
}
function setSchedulerStatus(status) {
  writeJson(STATUS_FILE, status);
}

// ---- 예약 가능 시간표 변경 이력 로그 (JSON Lines, 한 줄에 이벤트 하나) ----
// 조회할 때마다 "새로 열린 시간대"/"다시 마감된 시간대"가 있으면 한 줄씩 계속 추가됩니다.
// 파일이 무한히 커지는 걸 막기 위해 너무 커지면 오래된 줄부터 잘라냅니다.
const CHANGE_LOG_FILE = path.join(DATA_DIR, "availability-changes.jsonl");
const MAX_LOG_LINES = 5000;

function appendChangeLog(entry) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  fs.appendFileSync(CHANGE_LOG_FILE, line + "\n");

  // 너무 커지면 오래된 것부터 정리 (대략적인 크기 체크, 매번 정확히 셀 필요는 없음)
  try {
    const stat = fs.statSync(CHANGE_LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) {
      // 5MB 넘으면 최근 MAX_LOG_LINES 줄만 남기고 정리
      const lines = fs.readFileSync(CHANGE_LOG_FILE, "utf-8").split("\n").filter(Boolean);
      const trimmed = lines.slice(-MAX_LOG_LINES);
      fs.writeFileSync(CHANGE_LOG_FILE, trimmed.join("\n") + "\n");
    }
  } catch {
    // 정리 실패해도 로그 자체는 이미 기록됐으니 무시
  }
}

function readChangeLog(limit = 100) {
  if (!fs.existsSync(CHANGE_LOG_FILE)) return [];
  const lines = fs.readFileSync(CHANGE_LOG_FILE, "utf-8").split("\n").filter(Boolean);
  const recent = lines.slice(-limit);
  return recent.map((l) => JSON.parse(l)).reverse(); // 최신순
}

module.exports = {
  getWatches,
  addWatch,
  removeWatch,
  getSubscriptions,
  addSubscription,
  removeSubscriptionByEndpoint,
  getKnownState,
  setKnownState,
  getSchedulerStatus,
  setSchedulerStatus,
  appendChangeLog,
  readChangeLog,
};
