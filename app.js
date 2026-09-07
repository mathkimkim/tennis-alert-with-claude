// app.js

const statusBody = document.getElementById("statusBody");
const changeLogList = document.getElementById("changeLogList");
const timetableWatchSelect = document.getElementById("timetableWatchSelect");
const timetableBody = document.getElementById("timetableBody");
const subscribeBtn = document.getElementById("subscribeBtn");
const subStatus = document.getElementById("subStatus");
const addWatchBtn = document.getElementById("addWatchBtn");
const watchAllBtn = document.getElementById("watchAllBtn");
const watchAllStatus = document.getElementById("watchAllStatus");
const watchStatus = document.getElementById("watchStatus");
const watchList = document.getElementById("watchList");
const providerSelect = document.getElementById("providerSelect");
const providerSelectAll = document.getElementById("providerSelectAll");
const courtSelect = document.getElementById("courtSelect");
const labelInput = document.getElementById("labelInput");
const dateInput = document.getElementById("dateInput");

let PROVIDERS = [];

// 이 브라우저(기기)를 구분하기 위한 고유 ID. 로그인 없이도 "이 기기가 관심있는
// 감시 목록"을 서버가 구분할 수 있게 해줍니다. 최초 접속 시 한 번만 생성되고
// localStorage에 저장되어 계속 재사용됩니다.
function getDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("deviceId", id);
  }
  return id;
}
const DEVICE_ID = getDeviceId();

function timeAgo(isoString) {
  if (!isoString) return "아직 없음";
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}초 전`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour}시간 전`;
}

async function loadStatus() {
  try {
    const s = await fetch("/api/status").then((r) => r.json());
    const sched = s.scheduler;

    let badge;
    if (!sched.lastRunAt) {
      badge = '<span class="badge idle">아직 한 번도 확인 안 함</span>';
    } else if (sched.lastRunOk) {
      badge = '<span class="badge ok">정상 동작 중</span>';
    } else {
      badge = '<span class="badge err">오류 발생</span>';
    }

    const roundsNeeded = Math.ceil(s.targetCount / (s.tickBatchSize || 1));
    const intervalLabel =
      s.checkMode === "roundrobin"
        ? `외부 스케줄러 호출마다 ${s.tickBatchSize}개씩 순서대로 (등록 ${s.targetCount}개 · 한 바퀴에 약 ${roundsNeeded}회 호출 필요)`
        : `${s.checkIntervalMin}분마다 전체 확인`;

    statusBody.innerHTML = `
      <div class="status-row"><span>서버 상태</span><b>${badge}</b></div>
      <div class="status-row"><span>마지막 확인</span><b>${timeAgo(sched.lastRunAt)}</b></div>
      <div class="status-row"><span>확인 방식</span><b>${intervalLabel}</b></div>
      <div class="status-row"><span>전체 감시 대상</span><b>${s.targetCount}개 (${s.interestCount}건 관심등록)</b></div>
      ${sched.skippedCount > 0 ? `<div class="status-row"><span>지금 감시 중단 중</span><b>${sched.skippedCount}개 (야간 시간대)</b></div>` : ""}
      <div class="status-row"><span>구독 중인 브라우저</span><b>${s.subscriptionCount}개</b></div>
      ${sched.lastError ? `<div class="status-row" style="color:#fca5a5">${sched.lastError}</div>` : ""}
    `;
  } catch (err) {
    statusBody.textContent = "서버에 연결할 수 없어요: " + err.message;
  }
}
let currentTimetableTargetId = "";

function populateTimetableSelect(watches) {
  const monthWatches = watches.filter((w) => w.mode === "month");
  const prevSelection = timetableWatchSelect.value;

  timetableWatchSelect.innerHTML =
    '<option value="">-- 감시 항목 선택 --</option>' +
    monthWatches.map((w) => `<option value="${w.id}">${w.label}</option>`).join("");

  // 이전에 선택했던 항목이 여전히 목록에 있으면 유지
  if (monthWatches.some((w) => w.id === prevSelection)) {
    timetableWatchSelect.value = prevSelection;
    currentTimetableTargetId = prevSelection;
  } else {
    currentTimetableTargetId = "";
  }
}

async function loadTimetable() {
  if (!currentTimetableTargetId) {
    timetableBody.innerHTML = '<div class="empty">감시 항목을 선택해주세요.</div>';
    return;
  }
  try {
    const data = await fetch(`/api/timetable/${currentTimetableTargetId}`).then((r) => r.json());
    if (data.error) {
      timetableBody.innerHTML = `<div class="empty">${data.error}</div>`;
      return;
    }

    timetableBody.innerHTML = data.days
      .map((day) => {
        const weekday = new Date(day.date + "T00:00:00").toLocaleDateString("ko-KR", {
          month: "long",
          day: "numeric",
          weekday: "short",
        });

        let bodyHtml;
        if (day.slots === null) {
          bodyHtml = '<div class="tt-unknown">아직 확인 전이에요 (다음 확인 때 반영돼요)</div>';
        } else if (day.slots.length === 0) {
          bodyHtml = '<div class="tt-none">예약 가능한 시간 없음</div>';
        } else {
          const label = day.slots.map((s) => `${s.court}코트 ${s.time}`).join(", ");
          bodyHtml = `<div class="tt-slots">🟢 ${label}</div>`;
        }

        return `<div class="tt-day"><div class="tt-date">${weekday}</div>${bodyHtml}</div>`;
      })
      .join("");
  } catch (err) {
    timetableBody.textContent = "시간표를 불러오지 못했어요: " + err.message;
  }
}
function readableKeys(keys) {
  return keys
    .map((k) => {
      const [court, time] = k.split("|");
      return `${court}코트 ${time}`;
    })
    .join(", ");
}

async function loadChangeLog() {
  try {
    const logs = await fetch("/api/change-log?limit=30").then((r) => r.json());
    if (logs.length === 0) {
      changeLogList.innerHTML = '<div class="empty">아직 기록된 변경 이력이 없어요.</div>';
      return;
    }
    changeLogList.innerHTML = logs
      .map((log) => {
        const time = new Date(log.timestamp).toLocaleString("ko-KR");
        const parts = [];
        if (log.opened && log.opened.length > 0) {
          parts.push(`<div class="log-open">🟢 새로 가능: ${readableKeys(log.opened)}</div>`);
        }
        if (log.closed && log.closed.length > 0) {
          parts.push(`<div class="log-close">🔴 다시 마감: ${readableKeys(log.closed)}</div>`);
        }
        return `
          <div class="log-item">
            <div><b>${log.label}</b> · ${log.date}</div>
            ${parts.join("")}
            <div class="log-time">${time}${log.note ? " · " + log.note : ""}</div>
          </div>
        `;
      })
      .join("");
  } catch (err) {
    changeLogList.textContent = "이력을 불러오지 못했어요: " + err.message;
  }
}
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function loadProviders() {
  PROVIDERS = await fetch("/api/providers").then((r) => r.json());

  const options = PROVIDERS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  providerSelect.innerHTML = options;
  providerSelectAll.innerHTML = options;

  updateCourtsForProvider(providerSelect.value);
}

function updateCourtsForProvider(providerId) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return;
  courtSelect.innerHTML = provider.courts
    .map((c) => `<option value="${c.grp}">${c.name}</option>`)
    .join("");
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    subStatus.textContent = "이 브라우저는 푸시 알림을 지원하지 않아요.";
    return null;
  }
  return navigator.serviceWorker.register("/sw.js");
}

async function subscribe() {
  subscribeBtn.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      subStatus.textContent = "알림 권한이 거부되었어요. 브라우저 설정에서 허용해주세요.";
      return;
    }

    const reg = await registerServiceWorker();
    if (!reg) return;

    const { publicKey } = await fetch("/api/vapid-public-key").then((r) => r.json());
    if (!publicKey) {
      subStatus.textContent = "서버에 VAPID 키가 설정되어 있지 않아요. 관리자에게 문의하세요.";
      return;
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: DEVICE_ID, ...sub.toJSON() }),
    });

    subStatus.textContent = "✅ 구독 완료! 빈자리가 생기면 알림을 보내드려요.";
  } catch (err) {
    console.error(err);
    subStatus.textContent = "구독 중 오류가 발생했어요: " + err.message;
  } finally {
    subscribeBtn.disabled = false;
  }
}

async function loadWatches() {
  const watches = await fetch(`/api/watches?deviceId=${DEVICE_ID}`).then((r) => r.json());
  populateTimetableSelect(watches);

  watchList.innerHTML = "";
  if (watches.length === 0) {
    watchList.innerHTML = '<div class="empty">등록된 감시가 없어요.</div>';
    return;
  }
  for (const w of watches) {
    const item = document.createElement("div");
    item.className = "watch-item";
    const desc = w.mode === "month" ? "이번 달 전체 (자동)" : w.date;
    item.innerHTML = `
      <div class="info">
        <b>${w.label}</b>
        <span>${desc}</span>
      </div>
      <button data-id="${w.interestId}">삭제</button>
    `;
    item.querySelector("button").addEventListener("click", async () => {
      await fetch(`/api/watches/${w.interestId}`, { method: "DELETE" });
      loadWatches();
    });
    watchList.appendChild(item);
  }
}

async function addWatch() {
  const provider = providerSelect.value;
  const grp = courtSelect.value;
  const label = labelInput.value.trim();
  const date = dateInput.value;

  if (!provider || !grp || !date) {
    watchStatus.textContent = "사이트, 코트, 날짜를 모두 선택해주세요.";
    return;
  }

  addWatchBtn.disabled = true;
  try {
    const res = await fetch("/api/watches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: DEVICE_ID, provider, grp, label, date }),
    });
    if (!res.ok) throw new Error("등록 실패");
    watchStatus.textContent = "감시가 등록되었어요.";
    labelInput.value = "";
    loadWatches();
  } catch (err) {
    watchStatus.textContent = "오류: " + err.message;
  } finally {
    addWatchBtn.disabled = false;
  }
}

async function watchAllCourts() {
  const provider = providerSelectAll.value;
  watchAllBtn.disabled = true;
  try {
    const res = await fetch("/api/watches/bulk-all-courts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: DEVICE_ID, provider }),
    });
    const data = await res.json();
    const count = data.created.length;
    watchAllStatus.textContent =
      count > 0
        ? `✅ ${count}개 코트 감시를 새로 등록했어요.`
        : "이미 이 사이트의 전체 코트를 관심 등록하셨어요.";
    loadWatches();
  } catch (err) {
    watchAllStatus.textContent = "오류: " + err.message;
  } finally {
    watchAllBtn.disabled = false;
  }
}

providerSelect.addEventListener("change", () => updateCourtsForProvider(providerSelect.value));
subscribeBtn.addEventListener("click", subscribe);
watchAllBtn.addEventListener("click", watchAllCourts);
addWatchBtn.addEventListener("click", addWatch);
timetableWatchSelect.addEventListener("change", () => {
  currentTimetableTargetId = timetableWatchSelect.value;
  loadTimetable();
});

loadProviders();
loadWatches();
loadStatus();
loadChangeLog();
loadTimetable();
setInterval(loadStatus, 30000); // 30초마다 상태 갱신
setInterval(loadChangeLog, 30000); // 30초마다 변경 이력 갱신
setInterval(loadTimetable, 30000); // 30초마다 시간표 갱신
