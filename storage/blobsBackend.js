// storage/blobsBackend.js
// Netlify 배포용 저장소. Netlify Blobs(내장 키-값 저장소)에 저장합니다.
// fileBackend.js와 함수 이름을 동일하게 맞췄어요. (다중 사용자 target/interest 구조는
// fileBackend.js 상단 주석 참고)

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const STORE_NAME = "tennis-alert-data";
const MAX_LOG_ENTRIES = 1000;

function store() {
  return getStore(STORE_NAME);
}

async function readJson(key, fallback) {
  const value = await store().get(key, { type: "json" });
  return value === null || value === undefined ? fallback : value;
}

async function writeJson(key, value) {
  await store().setJSON(key, value);
}

// ---- targets ----
async function getTargets() {
  return readJson("targets", []);
}
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
  await writeJson("targets", targets);
  return target;
}
async function removeTargetIfOrphan(targetId) {
  const interests = await getInterests();
  const stillWanted = interests.some((i) => i.targetId === targetId);
  if (stillWanted) return;

  const targets = (await getTargets()).filter((t) => t.id !== targetId);
  await writeJson("targets", targets);
}

// ---- interests ----
async function getInterests() {
  return readJson("interests", []);
}
async function addInterest(deviceId, targetId) {
  const interests = await getInterests();
  const exists = interests.find((i) => i.deviceId === deviceId && i.targetId === targetId);
  if (exists) return exists;

  const interest = { id: crypto.randomUUID(), deviceId, targetId, createdAt: new Date().toISOString() };
  interests.push(interest);
  await writeJson("interests", interests);
  return interest;
}
async function removeInterest(interestId) {
  const interests = await getInterests();
  const found = interests.find((i) => i.id === interestId);
  const remaining = interests.filter((i) => i.id !== interestId);
  await writeJson("interests", remaining);
  if (found) await removeTargetIfOrphan(found.targetId);
}
async function getInterestsByDevice(deviceId) {
  return (await getInterests()).filter((i) => i.deviceId === deviceId);
}
async function getInterestsByTarget(targetId) {
  return (await getInterests()).filter((i) => i.targetId === targetId);
}

// ---- subscriptions ----
async function getSubscriptions() {
  return readJson("subscriptions", []);
}
async function addSubscription(deviceId, sub) {
  const subs = await getSubscriptions();
  const exists = subs.some((s) => s.endpoint === sub.endpoint);
  if (!exists) {
    subs.push({ ...sub, deviceId });
    await writeJson("subscriptions", subs);
  }
  return sub;
}
async function removeSubscriptionByEndpoint(endpoint) {
  const subs = (await getSubscriptions()).filter((s) => s.endpoint !== endpoint);
  await writeJson("subscriptions", subs);
}
async function getSubscriptionsByDevices(deviceIds) {
  const idSet = new Set(deviceIds);
  return (await getSubscriptions()).filter((s) => idSet.has(s.deviceId));
}

// ---- known-state ----
async function getKnownState() {
  return readJson("known-state", {});
}
async function setKnownState(targetId, slots) {
  const state = await getKnownState();
  state[targetId] = slots;
  await writeJson("known-state", state);
}

async function getSchedulerStatus() {
  return readJson("status", {
    lastRunAt: null,
    lastRunOk: null,
    lastError: null,
    checkedCount: 0,
    skippedCount: 0,
  });
}
async function setSchedulerStatus(status) {
  await writeJson("status", status);
}

async function appendChangeLog(entry) {
  const logs = await readJson("change-log", []);
  logs.push({ timestamp: new Date().toISOString(), ...entry });
  const trimmed = logs.length > MAX_LOG_ENTRIES ? logs.slice(-MAX_LOG_ENTRIES) : logs;
  await writeJson("change-log", trimmed);
}

async function readChangeLog(limit = 100) {
  const logs = await readJson("change-log", []);
  return logs.slice(-limit).reverse();
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
