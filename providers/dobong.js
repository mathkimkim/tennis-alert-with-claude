// providers/dobong.js
//
// 도봉구시설관리공단 인터넷예약시스템 (yeyak.dobongsiseol.or.kr) - 다락원체육공원 테니스장 전용
//
// ⚠️ 베타 (라이브 검증 대기 중):
// - 월별 캘린더: 실제 AJAX(ajax.rent.day.state.new_re_202607.php)로 검증 완료. 정상 동작.
// - 일별 상세 시간표: 실제 브라우저 요청(cURL)으로 진짜 엔드포인트
//   (ajax.day.rent.list_re_202607.php)와 응답 구조를 확인해서 완성했습니다.
//   응답은 { play_name: [ { play_code, place_code, event_code, play_name, htmlx, ... }, ... ] }
//   형태이고, 코트마다 "htmlx" 필드 안에 그 날짜 시간표 HTML이 문자열로 들어있어서
//   다시 한번 파싱합니다.
//
// ⚠️ 주의: 이 응답에는 다락원체육공원의 축구장 등 테니스가 아닌 다른 시설도 같이 섞여
// 나올 수 있습니다. 실제로 확인해보니:
//   - 실내코트(1~3면): place_code=019, event_code=039
//   - 실외코트(4~8면): place_code=022, event_code=039  (place_code가 실내와 다름!)
//   - 다락원 축구장: place_code=021, event_code=008     (event_code가 테니스와 다름)
// place_code는 실내외로 갈리지만 event_code=039는 테니스 전체에 공통이라, event_code만으로
// 테니스 여부를 걸러냅니다. 코트 번호도 play_code 숫자를 그대로 믿지 않고 "실내코트3면"/
// "실외코트5면" 같은 실제 표시 이름에서 직접 실내외 여부와 번호를 뽑아냅니다
// (알림/시간표에 "실내 3코트"처럼 표시됨).
//
// 사이트 구조 특징: gytennis처럼 "코트마다 다른 URL"이 아니라, 한 시설(다락원체육공원)의
// 테니스장 페이지 하나에 코트 1~9번이 전부 표에 같이 나옵니다. 그래서 이 provider는
// courts를 "1개 시설"로 등록하고, fetchDayDetail이 9개 코트 전부를 한번에 돌려줍니다.

const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://yeyak.dobongsiseol.or.kr";

// 다락원체육공원 테니스장 고정 식별자 (저장된 페이지 URL에서 확인)
const FACILITY = {
  c_id: "05",
  place_code: "019",
  event_code: "039",
  play_code: "01",
};

// 이 provider는 시설 하나(다락원체육공원 테니스장, 코트 1~9면 통합)만 지원합니다.
const COURTS = {
  1: "다락원체육공원 테니스장 (코트 1~9면 통합)",
};

const TIME_SLOTS = [
  "06:00~07:00",
  "07:00~08:00",
  "08:00~09:00",
  "09:00~10:00",
  "10:00~11:00",
  "11:00~12:00",
  "12:00~13:00",
  "13:00~14:00",
  "14:00~15:00",
  "15:00~16:00",
  "16:00~17:00",
  "17:00~18:00",
  "18:00~19:00",
  "19:00~20:00",
  "20:00~21:00",
  "21:00~22:00",
];

let cachedCookie = null;
let cookieFetchedAt = 0;
const COOKIE_TTL_MS = 5 * 60 * 1000;

// 이 사이트가 "지금 보고 있는 시설/코트"를 PHP 세션(쿠키)으로 기억하는 방식일 수 있어서,
// 쿠키 없이 따로따로 요청을 보내면 서버가 컨텍스트를 못 잡을 수 있습니다.
// 그래서 먼저 메인 페이지를 한 번 방문해서 세션 쿠키를 받아온 뒤, 이후 모든 요청에 실어 보냅니다.
async function getSessionCookie() {
  const now = Date.now();
  if (cachedCookie && now - cookieFetchedAt < COOKIE_TTL_MS) {
    return cachedCookie;
  }

  const res = await axios.get(`${BASE_URL}/rent/index.php`, {
    params: commonParams(),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  const setCookie = res.headers["set-cookie"];
  if (setCookie && setCookie.length > 0) {
    cachedCookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    cookieFetchedAt = now;
  }
  return cachedCookie;
}
function commonParams(extra = {}) {
  return {
    c_id: FACILITY.c_id,
    n_type: "rent",
    page_info: "index",
    c_ox: "0",
    place_code: FACILITY.place_code,
    event_code: FACILITY.event_code,
    play_code: FACILITY.play_code,
    ...extra,
  };
}

function diagnosticSnippet(raw) {
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * 이번 달(및 다음 달 일부) 날짜별 상태(가능/불가능)를 가져옵니다.
 * 반환값: [{ date: "2026-09-10", totalCnt: 1 }, ...]
 *   (다른 provider와 인터페이스를 맞추기 위해 available=1, unavailable=0으로 totalCnt를 씁니다)
 *
 * ⚠️ 이 캘린더는 페이지에 서버가 미리 렌더링해두는 게 아니라, 자바스크립트가 페이지 로드 후
 * 별도로 두드리는 AJAX 엔드포인트(ajax.rent.day.state.new_re_202607.php)로 채워집니다.
 * (rent_cal_new_re_202511.js 안의 실제 AJAX 호출을 그대로 재현한 것입니다.)
 */
async function fetchMonthAvailability(grp, { year, month } = {}) {
  const now = new Date();
  const y = year || now.getFullYear();
  const m = month || now.getMonth() + 1;

  const firstDay = `${y}${String(m).padStart(2, "0")}01`;
  const lastDayObj = new Date(y, m, 0); // m월의 마지막 날
  const lastDate =
    `${lastDayObj.getFullYear()}` +
    `${String(lastDayObj.getMonth() + 1).padStart(2, "0")}` +
    `${String(lastDayObj.getDate()).padStart(2, "0")}`;

  const params = new URLSearchParams({
    c_id: FACILITY.c_id,
    date: firstDay,
    lastdate: lastDate,
  });

  const cookie = await getSessionCookie();
  const res = await axios.post(`${BASE_URL}/rent/ajax.rent.day.state.new_re_202607.php`, params, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BASE_URL}/rent/index.php?${new URLSearchParams(commonParams()).toString()}`,
      ...(cookie ? { Cookie: cookie } : {}),
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  let data = res.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = null;
    }
  }

  // 응답이 배열이 아니라 { "2026-09-01": {...}, "2026-09-02": {...} } 형태의
  // "날짜를 키로 하는 객체"로 옵니다 (배열일 거라고 잘못 가정했던 부분 수정).
  const entries =
    data && typeof data === "object"
      ? Array.isArray(data)
        ? data
        : Object.values(data)
      : [];

  if (entries.length === 0) {
    throw new Error(
      `캘린더 ajax 응답이 예상과 다름 (HTTP ${res.status}, 응답: "${diagnosticSnippet(
        typeof res.data === "string" ? res.data : JSON.stringify(res.data)
      )}")`
    );
  }

  return entries.map((item) => {
    const tcnt = Number(item.t_cnt);
    const hcnt = Number(item.h_cnt);
    const available = tcnt === 0 && hcnt !== 999; // t_cnt=0(예약 0건) & 휴장일 아님 => 가능
    return { date: item.rday2, totalCnt: available ? 1 : 0 };
  });
}

/**
 * 특정 날짜의 코트별(1~9) x 시간대별 예약 가능 여부를 가져옵니다.
 * 반환값: [{ court: 1, time: "18:00~19:00", available: true }, ...]
 *
 * 실제 응답 구조 (cURL로 확인):
 *   { "play_name": [ { "play_code": "01", "htmlx": "<div class='chk_d nochk'>...</div>...", ... }, ... ] }
 * 코트마다 "htmlx"라는 필드에 그 날짜의 시간표 HTML 조각이 문자열로 통째로 들어있습니다.
 * (기존에 페이지에서 <!-- 주석 --> 안에 갇혀있던 것과 거의 동일한 구조 - 이 htmlx를 다시
 * cheerio로 파싱해서 시간대별 예약 가능 여부를 뽑아냅니다.)
 * 코트에 따라 htmlx가 빈 placeholder("chk_d xx"만 반복)인 경우도 있는데, 이건 그 코트에
 * 데이터가 없다는 뜻이라 건너뜁니다.
 */
async function fetchDayDetail(grp, date) {
  const [year, month, day] = date.split("-");
  const rdate = `${year}${month}${day}`;
  const cookie = await getSessionCookie();

  const params = new URLSearchParams({
    c_id: FACILITY.c_id,
    rdate,
    rent_open_start_day: "23", // 실제 브라우저 요청에서 확인한 고정값
  });

  const res = await axios.post(`${BASE_URL}/rent/ajax.day.rent.list_re_202607.php`, params, {
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/rent/index.php?c_id=${FACILITY.c_id}&n_type=rent`,
      "X-Requested-With": "XMLHttpRequest",
      ...(cookie ? { Cookie: cookie } : {}),
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  let data = res.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = null;
    }
  }

  // "play_name" 필드가 실제 배열이 아니라, 배열을 다시 JSON 문자열로 감싸놓은
  // 이중 인코딩 형태로 옵니다 (예: {"play_name": "[{...}, {...}]"}). 그래서 한 번 더 파싱합니다.
  let courtList = [];
  if (data && typeof data.play_name === "string") {
    try {
      courtList = JSON.parse(data.play_name);
    } catch {
      courtList = [];
    }
  } else if (data && Array.isArray(data.play_name)) {
    courtList = data.play_name;
  }

  if (!Array.isArray(courtList) || courtList.length === 0) {
    throw new Error(
      `일별 상세 응답 구조가 예상과 다름 (HTTP ${res.status}, 응답: "${JSON.stringify(data).slice(0, 500)}")`
    );
  }

  const slots = [];
  const skippedNames = [];
  const skippedByCode = [];
  for (const court of courtList) {
    // 실내코트(place_code=019)와 실외코트(place_code=022)는 place_code가 서로 다르지만
    // 둘 다 event_code=039(테니스)입니다. 반면 축구장 등은 event_code 자체가 다릅니다
    // (예: 다락원 축구장은 event_code=008). 그래서 event_code만으로 테니스 여부를 걸러냅니다.
    if (court.event_code !== FACILITY.event_code) {
      skippedByCode.push(`${court.play_name}(place=${court.place_code},event=${court.event_code})`);
      continue;
    }
    if (!court.htmlx) continue;

    // play_code 숫자가 실제 화면 코트 번호와 정확히 일치한다는 보장이 없어서,
    // "실내코트3면" / "실외코트5면" 같은 실제 표시 이름에서 직접 실내외+번호를 뽑습니다.
    const nameMatch = String(court.play_name || "").match(/(실내|실외)\s*코트\s*(\d+)\s*면?/);
    if (!nameMatch) {
      // 이 형식이 아니면(축구장이거나, 혹은 실외코트 이름 표기가 다를 수 있음) 건너뛰되,
      // 실제로 뭐라고 왔는지는 남겨서 나중에 확인할 수 있게 합니다.
      skippedNames.push(court.play_name);
      continue;
    }

    const indoorOutdoor = nameMatch[1]; // "실내" 또는 "실외"
    const courtNo = nameMatch[2];
    const courtLabel = `${indoorOutdoor} ${courtNo}`; // 예: "실내 3", "실외 5"

    const $ = cheerio.load(court.htmlx);
    $("div.chk_d").each((idx, chkDiv) => {
      const timeLabelRaw = $(chkDiv).find("li.chk_t").text().trim();
      if (!timeLabelRaw) return; // "chk_d xx" 같은 빈 placeholder는 건너뜀

      const timeLabel = timeLabelRaw.replace(/\s*~\s*/, "~");
      const input = $(chkDiv).find('input[type="hidden"], input[type="checkbox"]');
      const isDisabled = input.attr("disabled") !== undefined;
      slots.push({ court: courtLabel, time: timeLabel, available: !isDisabled });
    });
  }

  if (skippedByCode.length > 0) {
    console.warn(`[dobong] ${date} - place_code/event_code가 달라서 건너뛴 코트: ${JSON.stringify(skippedByCode)}`);
  }
  if (skippedNames.length > 0) {
    console.warn(
      `[dobong] ${date} - 이름 형식이 안 맞아서 건너뛴 코트: ${JSON.stringify(skippedNames)}`
    );
  }

  // 참고: 여기서 slots가 비어있는 건 에러가 아닐 수 있습니다 (예: 휴장일이라 시간표
  // 자체가 없는 날 - 9개 코트를 다 찾았어도 htmlx가 전부 빈 placeholder("chk_d xx")인 경우).
  // courtList 자체를 못 찾은 경우(구조 이상)만 위에서 이미 에러로 처리했으므로,
  // 여기서는 그냥 빈 배열을 그대로 반환합니다 (그 날은 "예약 가능 슬롯 0개"인 셈).
  return slots;
}

module.exports = {
  id: "dobong",
  name: "도봉구시설관리공단 (다락원체육공원 테니스)",
  courts: COURTS,
  timeSlots: TIME_SLOTS,
  baseUrl: BASE_URL,
  // 이 사이트의 월별 캘린더는 "가능/마감" 둘 중 하나로만 표시돼서(정확한 빈자리 개수 아님),
  // 코트가 여러 면(9면)인 이 시설에서는 슬롯 하나가 예약/취소돼도 캘린더 상태 자체가
  // 거의 안 바뀝니다. 그래서 정확도를 위해 매 확인마다 날짜별 상세 시간표를 직접 비교합니다.
  supportsAccurateMonthCount: false,
  fetchMonthAvailability,
  fetchDayDetail,
};
