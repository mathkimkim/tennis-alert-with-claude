// providers/gimpo.js
//
// 김포시체육회 파르코스 테니스장 (gimposports.or.kr) 전용 프로바이더
//
// 이 사이트는 저장된 페이지 안에 상태 범례가 명확히 나와있어서 신뢰도 있게 만들었어요:
//   달력 셀(li)  : of=휴관, no=불가(예약범위 밖/마감), on=가능, ok=현재 선택됨
//   시간대(label): no=불가, on=가능  (같은 on/no 체계를 그대로 씀)
//
// 코트는 "A관~H관" 8개면인데 화면엔 "1코트~8코트"로 표시됩니다. sTeb=g 가 테니스 카테고리 고정값.
//
// ⚠️ 처음엔 저장된 페이지의 URL 주석(http://...)만 보고 HTTP로 요청했는데, 실제 브라우저는
// HTTPS로 요청을 보낸다는 걸 실제 네트워크 요청(cURL)으로 확인해서 고쳤습니다. HTTP로 받은
// 세션 쿠키가 HTTPS 요청에는 전달되지 않아서 계속 실패했던 것으로 보입니다.

const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.gimposports.or.kr";
const S_TEB = "g"; // 테니스장 카테고리 고정값

const COURTS = {
  1: "1코트",
  2: "2코트",
  3: "3코트",
  4: "4코트",
  5: "5코트",
  6: "6코트",
  7: "7코트",
  8: "8코트",
};

function roomCode(grp) {
  // 1 -> A관, 2 -> B관 ... 8 -> H관 (실제 브라우저 요청으로 이 형식이 맞다고 확인됨)
  const letter = String.fromCharCode(64 + Number(grp));
  return `${letter}관`;
}

let cachedCookie = null;
let cookieFetchedAt = 0;
let lastCookieFetchStatus = null;
const COOKIE_TTL_MS = 5 * 60 * 1000; // 5분마다 세션 갱신

// 이 사이트는 PHP 세션 기반이라, 쿠키 없이 바로 AJAX(POST)를 날리면
// "잘못된 접근" 취급을 받아 빈 응답이 올 수 있어요. 그래서 먼저 메인 페이지를
// 한 번 GET해서 세션 쿠키를 받아온 뒤, 그 쿠키를 실어서 AJAX 요청을 보냅니다.
async function getSessionCookie() {
  const now = Date.now();
  if (cachedCookie && now - cookieFetchedAt < COOKIE_TTL_MS) {
    return cachedCookie;
  }

  const res = await axios.get(`${BASE_URL}/bbs/orderCourse.php`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  lastCookieFetchStatus = res.status;

  const setCookie = res.headers["set-cookie"];
  if (setCookie && setCookie.length > 0) {
    cachedCookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    cookieFetchedAt = now;
  }
  return cachedCookie;
}

async function postForm(path, data) {
  const cookie = await getSessionCookie();
  const params = new URLSearchParams(data);
  const res = await axios.post(`${BASE_URL}${path}`, params, {
    headers: {
      Accept: "*/*",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/bbs/orderCourse.php`,
      "X-Requested-With": "XMLHttpRequest",
      ...(cookie ? { Cookie: cookie } : {}),
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    timeout: 15000,
    validateStatus: () => true, // 상태코드와 무관하게 응답을 받아서 직접 진단하기 위함
  });
  return { $: cheerio.load(res.data), status: res.status, raw: String(res.data), cookie };
}

function diagnosticSnippet(raw) {
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

function diagnoseCalendarResponse(raw, status, cookie) {
  // 작은따옴표(class='txt')와 큰따옴표(class="txt") 둘 다 잡히도록 함
  const dateMatches = raw.match(/data=["'](\d{8})["']/g) || [];
  const hasTxtUl = /class=["'][^"']*\btxt\b[^"']*["']/.test(raw);
  const onDayMatches = raw.match(/class=["']on["']/g) || [];
  const looksLikeLogin = /login|로그인|세션|session/i.test(raw);

  return (
    `HTTP ${status} / 응답 전체 길이: ${raw.length}자 / ` +
    `쿠키 GET 상태: ${lastCookieFetchStatus} / 쿠키 확보됨: ${cookie ? `예(${cookie.length}자)` : "아니오"} / ` +
    `txt 클래스 포함: ${hasTxtUl} / data="YYYYMMDD" 패턴 발견: ${dateMatches.length}건 / ` +
    `class='on' 발견: ${onDayMatches.length}건 / 로그인 관련 문구 포함: ${looksLikeLogin} / ` +
    `응답 전체: "${raw.replace(/\s+/g, " ").trim()}"`
  );
}

/**
 * 특정 코트(grp)의 이번 달(또는 지정한 달) 날짜별 상태를 가져옵니다.
 * 반환값: [{ date: "2026-09-10", totalCnt: 1 }, ...]  (available=1 / unavailable=0, 정확한 개수 아님)
 *
 * 참고: 여기서 "불가(no)"는 대부분 "예약 가능 기간(보통 오늘부터 열흘 정도) 밖"이라는 뜻이라,
 * 이 숫자만으로는 취소 감지가 잘 안 돼요. 그래서 이 provider는 supportsAccurateMonthCount=false로
 * 등록해서, 스케줄러가 매번 날짜별 상세 시간표를 직접 비교하도록 되어있습니다.
 */
async function fetchMonthAvailability(grp, { year, month } = {}) {
  const now = new Date();
  const y = year || now.getFullYear();
  const m = month || now.getMonth() + 1;

  const { $, status, raw, cookie } = await postForm("/skin/orders/calender4.php", {
    toYear: y,
    toMonth: m,
    sTeb: S_TEB,
    sRoom: roomCode(grp),
  });

  const results = [];
  $("ul.txt li").each((_, li) => {
    const dateRaw = $(li).attr("data"); // 예: 20260910
    if (!dateRaw || dateRaw.length !== 8) return;
    const date = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
    const cls = ($(li).attr("class") || "").split(/\s+/);
    const available = cls.includes("on") && !cls.includes("of");
    results.push({ date, totalCnt: available ? 1 : 0 });
  });

  if (results.length === 0) {
    throw new Error(`캘린더 응답에서 날짜를 못 찾음 (${diagnoseCalendarResponse(raw, status, cookie)})`);
  }

  return results;
}

/**
 * 특정 코트(grp)의 특정 날짜(date) 시간대별(06:00~23:00, 1시간 단위) 예약 가능 여부를 가져옵니다.
 * 반환값: [{ court: 1, time: "18:00~19:00", available: true }, ...]
 */
async function fetchDayDetail(grp, date) {
  const [y, m, d] = date.split("-");
  const dateYmd = `${y}${m}${d}`;

  const { $, status, raw } = await postForm("/skin/orders/timeBoard4.php", {
    toYear: y,
    toMonth: m,
    sTeb: S_TEB,
    sRoom: roomCode(grp),
    orderDate: dateYmd,
  });

  const slots = [];
  $("label.labelDate").each((_, label) => {
    const start = $(label).attr("data"); // 예: "06:00"
    if (!start) return;
    const cls = ($(label).attr("class") || "").split(/\s+/);
    const available = cls.includes("on") && !cls.includes("no");

    const [h] = start.split(":");
    const endHour = (parseInt(h, 10) + 1) % 24;
    const time = `${start}~${String(endHour).padStart(2, "0")}:00`;

    slots.push({ court: Number(grp), time, available });
  });

  if (slots.length === 0) {
    const hasLabelDate = /labelDate/.test(raw);
    const looksLikeLogin = /login|로그인|세션|session/i.test(raw);
    throw new Error(
      `시간표 응답에서 시간대를 못 찾음 (HTTP ${status} / labelDate 존재: ${hasLabelDate} / ` +
        `로그인 관련 문구 포함: ${looksLikeLogin} / 응답 전체: "${raw.replace(/\s+/g, " ").trim()}")`
    );
  }

  return slots;
}

module.exports = {
  id: "gimpo",
  name: "김포시체육회 (파르코스 테니스장)",
  courts: COURTS,
  timeSlots: [], // 코트마다 동적으로 파싱되므로 고정 목록 없음
  baseUrl: BASE_URL,
  supportsAccurateMonthCount: false,
  fetchMonthAvailability,
  fetchDayDetail,
};
