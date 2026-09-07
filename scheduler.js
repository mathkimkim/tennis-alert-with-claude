// scheduler.js
require("dotenv").config();
const cron = require("node-cron");
const { getProvider } = require("./providers");
const {
  getTargets,
  getInterestsByTarget,
  getKnownState,
  setKnownState,
  setSchedulerStatus,
  appendChangeLog,
} = require("./store");
const { notifyDevices } = require("./push");

const INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "3", 10);

// 이런 사이트(supportsAccurateMonthCount: false)는 "빈자리 총 개수"가 정확하지 않아서
// 매번 날짜마다 실제로 상세 조회를 해야 하고, 그만큼 요청이 많이 나갑니다.
// 한 달 전체를 다 보는 대신 가까운 며칠만 확인해서 사이트 부담을 줄입니다.
const INACCURATE_PROVIDER_DAYS_AHEAD = parseInt(process.env.DAYS_AHEAD_LIMIT || "14", 10);

// 같은 사이트에 요청이 한꺼번에 몰아치지 않도록, 상세 조회 사이마다 살짝 텀을 둡니다.
// Netlify Functions는 실행 시간 제한(기본 10초)이 있어서, 배포 환경에서는 텀을 짧게 줄입니다.
const REQUEST_STAGGER_MS = process.env.NETLIFY ? 100 : 400;

// "빈자리 총 개수"가 정확한 사이트(고양 등)라도, 가까운 며칠(기본 7일)은 총 개수가
// 안 늘었어도 매번 상세 시간표를 확인합니다 ("다음 7일 시간표" 화면을 채우기 위함).
const NEAR_TERM_DAYS = parseInt(process.env.NEAR_TERM_DAYS || "7", 10);

function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(fromDateStr + "T00:00:00");
  const to = new Date(toDateStr + "T00:00:00");
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}

// 사이트별로 이 시간대에는 감시를 쉽니다 (자정을 걸치는 구간은 start > end로 표현).
const QUIET_HOURS = {
  gytennis: { startMin: 22 * 60, endMin: 8 * 60 }, // 22:00 ~ 08:00
  dobong: { startMin: 0 * 60 + 30, endMin: 8 * 60 }, // 00:30 ~ 08:00
  gimpo: { startMin: 0 * 60 + 30, endMin: 8 * 60 }, // 00:30 ~ 08:00
};

function isInQuietHours(providerId) {
  const q = QUIET_HOURS[providerId];
  if (!q) return false;
  const now = new Date();
  const curMin = now.getHours() * 60 + now.getMinutes();
  if (q.startMin > q.endMin) {
    return curMin >= q.startMin || curMin < q.endMin;
  }
  return curMin >= q.startMin && curMin < q.endMin;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slotKey(slot) {
  return `${slot.court}|${slot.time}`;
}

function readableSlots(keys) {
  return keys
    .map((k) => {
      const [court, time] = k.split("|");
      return `${court}코트 ${time}`;
    })
    .join(", ");
}

// 이 대상(target)에 관심있는 사람들(interest)을 찾아서 그 사람들에게만 알림을 보냅니다.
async function notifyInterestedDevices(targetId, payload) {
  const interests = await getInterestsByTarget(targetId);
  const deviceIds = interests.map((i) => i.deviceId);
  await notifyDevices(deviceIds, payload);
}

// 이전 상태와 지금 상태를 비교해서 새로 열린 것/새로 마감된 것을 계산하고,
// 뭔가 바뀐 게 있으면 변경 이력 로그 파일에 한 줄 남깁니다.
async function logIfChanged({ target, date, prevList, nowList }) {
  const opened = nowList.filter((k) => !prevList.includes(k));
  const closed = prevList.filter((k) => !nowList.includes(k));

  if (opened.length === 0 && closed.length === 0) return { opened, closed };

  await appendChangeLog({
    provider: target.provider || "gytennis",
    grp: target.grp,
    label: target.label,
    date,
    opened,
    closed,
    currentAvailable: nowList,
  });

  return { opened, closed };
}

// ---- mode: "date" - 특정 코트+특정 날짜를 시간대 단위로 정밀 감시 ----
async function checkDateTarget(target, provider, knownState) {
  const slots = await provider.fetchDayDetail(target.grp, target.date);
  const availableNow = slots.filter((s) => s.available).map(slotKey);
  const prevAvailable = knownState[target.id];

  if (prevAvailable !== undefined) {
    const { opened } = await logIfChanged({
      target,
      date: target.date,
      prevList: prevAvailable,
      nowList: availableNow,
    });

    if (opened.length > 0) {
      await notifyInterestedDevices(target.id, {
        title: `🎾 ${target.label} 취소 발생!`,
        body: `${target.date} ${readableSlots(opened)} 예약 가능해졌어요.`,
        url: `${provider.baseUrl}/daily/${target.grp}/${target.date}`,
      });
    }
  }
  await setKnownState(target.id, availableNow);
}

// ---- mode: "month" - 코트 하나의 이번 달 전체 날짜를 감시 ----
// 반환값: 문제가 있었으면 에러 메시지(string), 없으면 null.
async function checkMonthTarget(target, provider, knownState) {
  const month = await provider.fetchMonthAvailability(target.grp);
  const prev = knownState[target.id] || { totals: {}, slots: {} };
  const nextTotals = { ...prev.totals };
  const nextSlots = { ...prev.slots };

  const todayStr = new Date().toISOString().slice(0, 10);
  const futureEntries = month.filter((entry) => entry.date >= todayStr);

  if (month.length === 0) {
    return `캘린더에서 날짜를 하나도 못 읽었어요 (사이트 구조가 바뀌었거나, 접근이 막혔거나, 로그인/세션이 필요할 수 있어요)`;
  }

  let dateErrorCount = 0;
  let lastDateError = null;
  let attemptedCount = 0;

  if (provider.supportsAccurateMonthCount) {
    for (const entry of futureEntries) {
      const prevTotal = prev.totals[entry.date];
      nextTotals[entry.date] = entry.totalCnt;

      const isNearTerm = daysBetween(todayStr, entry.date) <= NEAR_TERM_DAYS;
      const totalIncreased = prevTotal !== undefined && entry.totalCnt > prevTotal;

      if (!isNearTerm && !totalIncreased) continue;

      attemptedCount++;
      try {
        const detail = await provider.fetchDayDetail(target.grp, entry.date);
        const availableNow = detail.filter((s) => s.available).map(slotKey);
        const prevSlotList = prev.slots[entry.date];

        if (prevSlotList !== undefined) {
          const { opened } = await logIfChanged({
            target,
            date: entry.date,
            prevList: prevSlotList,
            nowList: availableNow,
          });

          if (opened.length > 0) {
            await notifyInterestedDevices(target.id, {
              title: `🎾 ${target.label} 취소 발생!`,
              body: `${entry.date} ${readableSlots(opened)} 예약 가능해졌어요.`,
              url: `${provider.baseUrl}/daily/${target.grp}/${entry.date}`,
            });
          }
        } else if (totalIncreased) {
          await appendChangeLog({
            provider: target.provider || "gytennis",
            grp: target.grp,
            label: target.label,
            date: entry.date,
            opened: availableNow,
            closed: [],
            currentAvailable: availableNow,
            note: `최초 상세 조회 (총 개수 ${prevTotal} → ${entry.totalCnt})`,
          });

          await notifyInterestedDevices(target.id, {
            title: `🎾 ${target.label} 빈자리 발생!`,
            body: `${entry.date} 예약 가능 슬롯이 ${prevTotal} → ${entry.totalCnt}개로 늘었어요. 확인해보세요.`,
            url: `${provider.baseUrl}/daily/${target.grp}/${entry.date}`,
          });
        }

        nextSlots[entry.date] = availableNow;
      } catch (err) {
        dateErrorCount++;
        lastDateError = err.message;
        console.error(`[scheduler] ${target.label} ${entry.date} 상세 조회 오류:`, err.message);
      }

      await sleep(REQUEST_STAGGER_MS);
    }
  } else {
    const nearFutureEntries = futureEntries.slice(0, INACCURATE_PROVIDER_DAYS_AHEAD);

    for (const entry of nearFutureEntries) {
      nextTotals[entry.date] = entry.totalCnt;
      attemptedCount++;

      try {
        const detail = await provider.fetchDayDetail(target.grp, entry.date);
        const availableNow = detail.filter((s) => s.available).map(slotKey);
        const prevSlotList = prev.slots[entry.date];

        if (prevSlotList !== undefined) {
          const { opened } = await logIfChanged({
            target,
            date: entry.date,
            prevList: prevSlotList,
            nowList: availableNow,
          });

          if (opened.length > 0) {
            await notifyInterestedDevices(target.id, {
              title: `🎾 ${target.label} 취소 발생!`,
              body: `${entry.date} ${readableSlots(opened)} 예약 가능해졌어요.`,
              url: `${provider.baseUrl}/daily/${target.grp}/${entry.date}`,
            });
          }
        }

        nextSlots[entry.date] = availableNow;
      } catch (err) {
        dateErrorCount++;
        lastDateError = err.message;
        console.error(`[scheduler] ${target.label} ${entry.date} 상세 조회 오류:`, err.message);
      }

      await sleep(REQUEST_STAGGER_MS);
    }
  }

  await setKnownState(target.id, { totals: nextTotals, slots: nextSlots });

  if (dateErrorCount > 0) {
    return `${attemptedCount}개 날짜 확인 중 ${dateErrorCount}건 상세 조회 실패 (예: ${lastDateError})`;
  }
  return null;
}

// ---- Netlify 배포용: 한 번 호출에 대상을 몇 개씩(기본 1개) 확인 (라운드로빈) ----
// 대상이 많아질수록 한 바퀴 도는 데 시간이 오래 걸리니, TICK_BATCH_SIZE로 한 번에
// 몇 개씩 처리할지 조절할 수 있습니다. 다만 Netlify Functions 실행 시간 제한(보통 10초)을
// 넘지 않게, 사이트당 소요 시간을 고려해서 너무 크게 잡지는 마세요.
const TICK_BATCH_SIZE = Math.max(1, parseInt(process.env.TICK_BATCH_SIZE || "1", 10));

async function checkOneRoundRobin() {
  const targets = await getTargets();
  if (targets.length === 0) {
    await setSchedulerStatus({
      lastRunAt: new Date().toISOString(),
      lastRunOk: true,
      lastError: null,
      checkedCount: 0,
      skippedCount: 0,
      tickCursor: 0,
    });
    return;
  }

  const status = await getSchedulerStatus();
  const startCursor = Number.isInteger(status.tickCursor) ? status.tickCursor : 0;
  const batchSize = Math.min(TICK_BATCH_SIZE, targets.length);

  let errorMsg = null;
  let skippedCount = 0;
  let cursor = startCursor;

  for (let i = 0; i < batchSize; i++) {
    const target = targets[cursor % targets.length];
    const providerId = target.provider || "gytennis";

    if (isInQuietHours(providerId)) {
      skippedCount++;
    } else {
      try {
        const knownState = await getKnownState();
        const provider = getProvider(providerId);
        if (target.mode === "month") {
          const monthError = await checkMonthTarget(target, provider, knownState);
          if (monthError) {
            console.error(`[scheduler] ${target.label}:`, monthError);
            errorMsg = `${target.label}: ${monthError}`;
          }
        } else {
          await checkDateTarget(target, provider, knownState);
        }
      } catch (err) {
        console.error(`[scheduler] ${target.label} 확인 중 오류:`, err.message);
        errorMsg = `${target.label}: ${err.message}`;
      }
    }

    cursor = (cursor + 1) % targets.length;
  }

  await setSchedulerStatus({
    lastRunAt: new Date().toISOString(),
    lastRunOk: errorMsg === null,
    lastError: errorMsg,
    checkedCount: targets.length,
    skippedCount,
    tickCursor: cursor,
  });
}

// ---- 로컬 실행용: 등록된 대상을 전부 순서대로 확인 ----
async function checkOnce() {
  const targets = await getTargets();
  if (targets.length === 0) {
    await setSchedulerStatus({
      lastRunAt: new Date().toISOString(),
      lastRunOk: true,
      lastError: null,
      checkedCount: 0,
      skippedCount: 0,
    });
    return;
  }

  const knownState = await getKnownState();
  let errorMsg = null;
  let skippedCount = 0;

  for (const target of targets) {
    const providerId = target.provider || "gytennis";

    if (isInQuietHours(providerId)) {
      skippedCount++;
      continue;
    }

    try {
      const provider = getProvider(providerId);
      if (target.mode === "month") {
        const monthError = await checkMonthTarget(target, provider, knownState);
        if (monthError) {
          console.error(`[scheduler] ${target.label}:`, monthError);
          errorMsg = `${target.label}: ${monthError}`;
        }
      } else {
        await checkDateTarget(target, provider, knownState);
      }
    } catch (err) {
      console.error(`[scheduler] ${target.label} 확인 중 오류:`, err.message);
      errorMsg = `${target.label}: ${err.message}`;
    }
  }

  await setSchedulerStatus({
    lastRunAt: new Date().toISOString(),
    lastRunOk: errorMsg === null,
    lastError: errorMsg,
    checkedCount: targets.length,
    skippedCount,
  });
}

function start() {
  console.log(`[scheduler] ${INTERVAL_MIN}분마다 예약 현황을 확인합니다.`);
  cron.schedule(`*/${INTERVAL_MIN} * * * *`, () => {
    checkOnce().catch((e) => console.error("[scheduler] checkOnce 오류:", e));
  });

  checkOnce().catch((e) => console.error("[scheduler] 초기 checkOnce 오류:", e));
}

module.exports = { start, checkOnce, checkOneRoundRobin };
