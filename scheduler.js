// scheduler.js
require("dotenv").config();
const cron = require("node-cron");
const { getProvider } = require("./providers");
const {
  getWatches,
  getKnownState,
  setKnownState,
  setSchedulerStatus,
  appendChangeLog,
} = require("./store");
const { notifyAll } = require("./push");

const INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "3", 10);

// 이런 사이트(supportsAccurateMonthCount: false)는 "빈자리 총 개수"가 정확하지 않아서
// 매번 날짜마다 실제로 상세 조회를 해야 하고, 그만큼 요청이 많이 나갑니다.
// 한 달 전체를 다 보는 대신 가까운 며칠만 확인해서 사이트 부담을 줄입니다
// (취소는 보통 가까운 날짜부터 확인하는 게 실용적이기도 해요).
const INACCURATE_PROVIDER_DAYS_AHEAD = parseInt(process.env.DAYS_AHEAD_LIMIT || "14", 10);

// 같은 사이트에 요청이 한꺼번에 몰아치지 않도록, 상세 조회 사이마다 살짝 텀을 둡니다.
const REQUEST_STAGGER_MS = 400;

// "빈자리 총 개수"가 정확한 사이트(고양 등)라도, 가까운 며칠(기본 7일)은 총 개수가
// 안 늘었어도 매번 상세 시간표를 확인합니다. 이래야 "다음 7일 시간표" 화면에 보여줄
// 데이터가 쌓이고, 알림도 조금 더 촘촘하게(예: 같은 날 안에서 슬롯이 바뀌는 것도) 잡아요.
const NEAR_TERM_DAYS = parseInt(process.env.NEAR_TERM_DAYS || "7", 10);

function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(fromDateStr + "T00:00:00");
  const to = new Date(toDateStr + "T00:00:00");
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
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

// 이전 상태와 지금 상태를 비교해서 새로 열린 것/새로 마감된 것을 계산하고,
// 뭔가 바뀐 게 있으면 변경 이력 로그 파일에 한 줄 남깁니다.
function logIfChanged({ watch, date, prevList, nowList }) {
  const opened = nowList.filter((k) => !prevList.includes(k));
  const closed = prevList.filter((k) => !nowList.includes(k));

  if (opened.length === 0 && closed.length === 0) return { opened, closed };

  appendChangeLog({
    provider: watch.provider || "gytennis",
    grp: watch.grp,
    label: watch.label,
    date,
    opened,
    closed,
    currentAvailable: nowList,
  });

  return { opened, closed };
}

// ---- mode: "date" - 특정 코트+특정 날짜를 시간대 단위로 정밀 감시 ----
async function checkDateWatch(watch, provider, knownState) {
  const slots = await provider.fetchDayDetail(watch.grp, watch.date);
  const availableNow = slots.filter((s) => s.available).map(slotKey);
  const prevAvailable = knownState[watch.id];

  if (prevAvailable !== undefined) {
    const { opened } = logIfChanged({
      watch,
      date: watch.date,
      prevList: prevAvailable,
      nowList: availableNow,
    });

    if (opened.length > 0) {
      await notifyAll({
        title: `🎾 ${watch.label} 취소 발생!`,
        body: `${watch.date} ${readableSlots(opened)} 예약 가능해졌어요.`,
        url: `${provider.baseUrl}/daily/${watch.grp}/${watch.date}`,
      });
    }
  }
  setKnownState(watch.id, availableNow);
}

// ---- mode: "month" - 코트 하나의 이번 달 전체 날짜를 감시 ----
// 반환값: 문제가 있었으면 에러 메시지(string), 없으면 null.
// (호출부에서 이 값을 스케줄러 상태에 반영해서, 조용히 실패하는 걸 막습니다.)
async function checkMonthWatch(watch, provider, knownState) {
  const month = await provider.fetchMonthAvailability(watch.grp);
  const prev = knownState[watch.id] || { totals: {}, slots: {} };
  const nextTotals = { ...prev.totals };
  const nextSlots = { ...prev.slots };

  const todayStr = new Date().toISOString().slice(0, 10);
  const futureEntries = month.filter((entry) => entry.date >= todayStr);

  // 캘린더 자체를 아예 못 읽어온 경우 (사이트 구조 변경, 로그인/세션 필요, 접근 차단 등 의심)
  if (month.length === 0) {
    return `캘린더에서 날짜를 하나도 못 읽었어요 (사이트 구조가 바뀌었거나, 접근이 막혔거나, 로그인/세션이 필요할 수 있어요)`;
  }

  let dateErrorCount = 0;
  let lastDateError = null;
  let attemptedCount = 0;

  if (provider.supportsAccurateMonthCount) {
    // ---- 월별 요약 숫자가 정확한 사이트: 기본은 "늘어난 날짜만" 상세 조회해서 가볍게 감시하되,
    //      가까운 며칠(NEAR_TERM_DAYS)은 총 개수가 안 늘었어도 매번 확인합니다.
    //      (그래야 "다음 7일 시간표" 화면에 보여줄 데이터도 쌓이고, 알림도 더 촘촘해져요.) ----
    for (const entry of futureEntries) {
      const prevTotal = prev.totals[entry.date];
      nextTotals[entry.date] = entry.totalCnt;

      const isNearTerm = daysBetween(todayStr, entry.date) <= NEAR_TERM_DAYS;
      const totalIncreased = prevTotal !== undefined && entry.totalCnt > prevTotal;

      if (!isNearTerm && !totalIncreased) continue;

      attemptedCount++;
      try {
        const detail = await provider.fetchDayDetail(watch.grp, entry.date);
        const availableNow = detail.filter((s) => s.available).map(slotKey);
        const prevSlotList = prev.slots[entry.date];

        if (prevSlotList !== undefined) {
          // 이 날짜를 예전에도 확인한 적 있으면 평소처럼 정확히 비교
          const { opened } = logIfChanged({
            watch,
            date: entry.date,
            prevList: prevSlotList,
            nowList: availableNow,
          });

          if (opened.length > 0) {
            await notifyAll({
              title: `🎾 ${watch.label} 취소 발생!`,
              body: `${entry.date} ${readableSlots(opened)} 예약 가능해졌어요.`,
              url: `${provider.baseUrl}/daily/${watch.grp}/${entry.date}`,
            });
          }
        } else if (totalIncreased) {
          // 슬롯 캐시는 없는데 총 개수가 실제로 늘어난 경우만 "새로 발견" 알림
          appendChangeLog({
            provider: watch.provider || "gytennis",
            grp: watch.grp,
            label: watch.label,
            date: entry.date,
            opened: availableNow,
            closed: [],
            currentAvailable: availableNow,
            note: `최초 상세 조회 (총 개수 ${prevTotal} → ${entry.totalCnt})`,
          });

          await notifyAll({
            title: `🎾 ${watch.label} 빈자리 발생!`,
            body: `${entry.date} 예약 가능 슬롯이 ${prevTotal} → ${entry.totalCnt}개로 늘었어요. 확인해보세요.`,
            url: `${provider.baseUrl}/daily/${watch.grp}/${entry.date}`,
          });
        }
        // else: 슬롯 캐시도 없고 총 개수도 안 늘었으면(근접일이라 처음 확인하는 것뿐) 조용히 기준값만 저장

        nextSlots[entry.date] = availableNow;
      } catch (err) {
        dateErrorCount++;
        lastDateError = err.message;
        console.error(`[scheduler] ${watch.label} ${entry.date} 상세 조회 오류:`, err.message);
      }

      await sleep(REQUEST_STAGGER_MS);
    }
  } else {
    // ---- 월별 요약이 "가능/불가능" 둘 중 하나뿐이라 정확도가 낮은 사이트:
    //      매번 날짜마다 실제 상세 시간표를 직접 비교 (요청은 더 들지만 정확함) ----
    // 매 확인 주기마다 날짜 수만큼 요청이 나가서 사이트에 부담을 줄 수 있으므로,
    // 한 달 전체가 아니라 가까운 N일(기본 14일)까지만 확인합니다.
    const nearFutureEntries = futureEntries.slice(0, INACCURATE_PROVIDER_DAYS_AHEAD);

    for (const entry of nearFutureEntries) {
      nextTotals[entry.date] = entry.totalCnt; // 참고용으로만 저장
      attemptedCount++;

      try {
        const detail = await provider.fetchDayDetail(watch.grp, entry.date);
        const availableNow = detail.filter((s) => s.available).map(slotKey);
        const prevSlotList = prev.slots[entry.date];

        if (prevSlotList !== undefined) {
          const { opened } = logIfChanged({
            watch,
            date: entry.date,
            prevList: prevSlotList,
            nowList: availableNow,
          });

          if (opened.length > 0) {
            await notifyAll({
              title: `🎾 ${watch.label} 취소 발생!`,
              body: `${entry.date} ${readableSlots(opened)} 예약 가능해졌어요.`,
              url: `${provider.baseUrl}/daily/${watch.grp}/${entry.date}`,
            });
          }
        }

        nextSlots[entry.date] = availableNow;
      } catch (err) {
        dateErrorCount++;
        lastDateError = err.message;
        console.error(`[scheduler] ${watch.label} ${entry.date} 상세 조회 오류:`, err.message);
      }

      await sleep(REQUEST_STAGGER_MS); // 요청 사이 살짝 텀을 둬서 한꺼번에 몰아치지 않게 함
    }
  }

  setKnownState(watch.id, { totals: nextTotals, slots: nextSlots });

  if (dateErrorCount > 0) {
    return `${attemptedCount}개 날짜 확인 중 ${dateErrorCount}건 상세 조회 실패 (예: ${lastDateError})`;
  }
  return null;
}

async function checkOnce() {
  const watches = getWatches();
  if (watches.length === 0) {
    setSchedulerStatus({
      lastRunAt: new Date().toISOString(),
      lastRunOk: true,
      lastError: null,
      checkedCount: 0,
    });
    return;
  }

  const knownState = getKnownState();
  let errorMsg = null;

  for (const watch of watches) {
    try {
      const provider = getProvider(watch.provider || "gytennis"); // 하위 호환: provider 없으면 gytennis로 간주
      if (watch.mode === "month") {
        const monthError = await checkMonthWatch(watch, provider, knownState);
        if (monthError) {
          console.error(`[scheduler] ${watch.label}:`, monthError);
          errorMsg = `${watch.label}: ${monthError}`;
        }
      } else {
        await checkDateWatch(watch, provider, knownState);
      }
    } catch (err) {
      console.error(`[scheduler] ${watch.label} 확인 중 오류:`, err.message);
      errorMsg = `${watch.label}: ${err.message}`;
    }
  }

  setSchedulerStatus({
    lastRunAt: new Date().toISOString(),
    lastRunOk: errorMsg === null,
    lastError: errorMsg,
    checkedCount: watches.length,
  });
}

function start() {
  console.log(`[scheduler] ${INTERVAL_MIN}분마다 예약 현황을 확인합니다.`);
  cron.schedule(`*/${INTERVAL_MIN} * * * *`, () => {
    checkOnce().catch((e) => console.error("[scheduler] checkOnce 오류:", e));
  });

  checkOnce().catch((e) => console.error("[scheduler] 초기 checkOnce 오류:", e));
}

module.exports = { start, checkOnce };
