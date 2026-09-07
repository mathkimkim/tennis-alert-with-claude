// storage/fileBackend.js
// 로컬(내 PC) 실행용 저장소. JSON 파일에 저장합니다.
// blobsBackend.js와 함수 이름/시그니처를 똑같이 맞춰서, store.js가 둘 중 하나를
// 골라 쓰기만 하면 되도록 만들었습니다.
//
// [다중 사용자 구조]
// - target: "확인할 대상" (예: 고양 대화코트 이번 달 전체). 여러 사람이 같은 걸 원해도
//   딱 하나만 존재합니다 (provider+grp+mode+date로 중복 판별).
// - interest: "누가 이 대상에 관심 있는지" (deviceId <-> targetId 연결).
// - subscription: 브라우저 푸시 구독 정보. deviceId에 연결됩니다.
// 스케줄러는 target 단위로 딱 한 번만 확인하고, 변화가 생기면 그 target에 관심 있는
// interest들의 deviceId를 찾아서, 그 deviceId에 연결된 subscription에만 알림을 보냅니다.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const TARGETS_FILE = path.join(DATA_DIR, "targets.json");
const INTERESTS_FILE = path.join(DATA_DIR, "interests.json");
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
const STATE_FILE = path.join(DATA_DIR, "known-state.json");
const STATUS_FILE = path.join(DATA_DIR, "status.json");
const CHANGE_LOG_FILE = path.join(DATA_DIR, "availability-changes.jsonl");
const MAX_LOG_LINES = 5000;

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

// ---- targets: 확인할 대상 (중복 제거됨) ----
async function getTargets() {
  return readJson(TARGETS_FILE, []);
}

// 같은 provider+grp+mode+date 조합이 이미 있으면 그걸 재사용하고, 없으면 새로 만듭니다.
async function findOrCreateTarget({ provider, grp, mode, date, label }) {
  const targets = await getTargets();
  const existing = targets.find(
    (t) =>
      t.provider === provider &&
      t.grp === grp &&
      t.mode === mode &&
      (mode === "date" ? t.date === date : true)
  );
  if (existing) return existing;

  const target = {
    id: crypto.randomUUID(),
    provider,
    grp,
    mode,
    date: mode === "date" ? date : undefined,
    label,
    createdAt: new Date().toISOString(),
  };
  targets.push(target);
  writeJson(TARGETS_FILE, targets);
  return target;
}

async function removeTargetIfOrphan(targetId) {
  const interests = await getInterests();
  const stillWanted = interests.some((i) => i.targetId === targetId);
  if (stillWanted) return;

  const targets = (await getTargets()).filter((t) => t.id !== targetId);
  writeJson(TARGETS_FILE, targets);
}

// ---- interests: 누가(deviceId) 어떤 대상(targetId)에 관심있는지 ----
async function getInterests() {
  return readJson(INTERESTS_FILE, []);
}
async function addInterest(deviceId, targetId) {
  const interests = await getInterests();
  const exists = interests.some((i) => i.deviceId === deviceId && i.targetId === targetId);
  if (exists) return interests.find((i) => i.deviceId === deviceId && i.targetId === targetId);

  const interest = { id: crypto.randomUUID(), deviceId, targetId, createdAt: new Date().toISOString() };
  interests.push(interest);
  writeJson(INTERESTS_FILE, interests);
  return interest;
}
async function removeInterest(interestId) {
  const interests = await getInterests();
  const found = interests.find((i) => i.id === interestId);
  const remaining = interests.filter((i) => i.id !== interestId);
  writeJson(INTERESTS_FILE, remaining);
  if (found) await removeTargetIfOrphan(found.targetId);
}
async function getInterestsByDevice(deviceId) {
  return (await getInterests()).filter((i) => i.deviceId === deviceId);
}
async function getInterestsByTarget(targetId) {
  return (await getInterests()).filter((i) => i.targetId === targetId);
}

// ---- subscriptions: 브라우저 푸시 구독 (deviceId에 연결됨) ----
async function getSubscriptions() {
  return readJson(SUBS_FILE, []);
}
async function addSubscription(deviceId, sub) {
  const subs = await getSubscriptions();
  const exists = subs.some((s) => s.endpoint === sub.endpoint);
  if (!exists) {
    subs.push({ ...sub, deviceId });
    writeJson(SUBS_FILE, subs);
  }
  return sub;
}
async function removeSubscriptionByEndpoint(endpoint) {
  const subs = (await getSubscriptions()).filter((s) => s.endpoint !== endpoint);
  writeJson(SUBS_FILE, subs);
}
async function getSubscriptionsByDevices(deviceIds) {
  const idSet = new Set(deviceIds);
  return (await getSubscriptions()).filter((s) => idSet.has(s.deviceId));
}

// ---- known-state: targetId -> 마지막으로 확인한 상태 ----
async function getKnownState() {
  return readJson(STATE_FILE, {});
}
async function setKnownState(targetId, slots) {
  const state = await getKnownState();
  state[targetId] = slots;
  writeJson(STATE_FILE, state);
}

async function getSchedulerStatus() {
  return readJson(STATUS_FILE, {
    lastRunAt: null,
    lastRunOk: null,
    lastError: null,
    checkedCount: 0,
    skippedCount: 0,
  });
}
async function setSchedulerStatus(status) {
  writeJson(STATUS_FILE, status);
}

async function appendChangeLog(entry) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  fs.appendFileSync(CHANGE_LOG_FILE, line + "\n");

  try {
    const stat = fs.statSync(CHANGE_LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) {
      const lines = fs.readFileSync(CHANGE_LOG_FILE, "utf-8").split("\n").filter(Boolean);
      const trimmed = lines.slice(-MAX_LOG_LINES);
      fs.writeFileSync(CHANGE_LOG_FILE, trimmed.join("\n") + "\n");
    }
  } catch {
    // 정리 실패해도 로그 자체는 이미 기록됐으니 무시
  }
}

async function readChangeLog(limit = 100) {
  if (!fs.existsSync(CHANGE_LOG_FILE)) return [];
  const lines = fs.readFileSync(CHANGE_LOG_FILE, "utf-8").split("\n").filter(Boolean);
  const recent = lines.slice(-limit);
  return recent.map((l) => JSON.parse(l)).reverse();
}

module.exports = {
  getTargets,
  findOrCreateTarget,
  removeTargetIfOrphan,
  getInterests,
  addInterest,
  removeInterest,
  getInterestsByDevice,
  getInterestsByTarget,
  getSubscriptions,
  addSubscription,
  removeSubscriptionByEndpoint,
  getSubscriptionsByDevices,
  getKnownState,
  setKnownState,
  getSchedulerStatus,
  setSchedulerStatus,
  appendChangeLog,
  readChangeLog,
};
