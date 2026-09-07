// providers/gytennis.js
//
// 고양특례시테니스협회 (gytennis.or.kr) 전용 프로바이더입니다.
// 다른 지역 사이트를 추가할 때는 이 파일을 참고해서 providers/ 폴더에
// 같은 모양(id, name, courts, fetchMonthAvailability, fetchDayDetail)으로 새 파일을 만들면 됩니다.
// 고양특례시테니스협회 (gytennis.or.kr) 전용 스크래퍼입니다.
//
// 핵심 발견: /daily/{grp} 페이지에는 <input id="ensdat" ...> 라는 hidden input에
// 그 달의 날짜별 "예약 가능 슬롯 수"가 서버에서 렌더링된 JSON 문자열로 이미 들어있습니다.
// 예: [{"date":"2026-09-10","reserved":"23","total_cnt":9}, ...]
// -> total_cnt가 그 날짜에 "가능"으로 캘린더에 표시되는 슬롯 개수입니다.
// 이 값이 이전에 확인했을 때보다 늘어났다면 = 누군가 취소해서 빈자리가 생겼다는 뜻입니다.
//
// 장점: 헤드리스 브라우저(Playwright) 없이 단순 HTTP GET + HTML 파싱만으로 동작합니다.
// (개발자도구 감지 같은 방어 로직도 신경 쓸 필요 없어요.)

const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.gytennis.or.kr";

// 시간대는 06:00~22:00, 2시간 단위 고정 (일별 상세 페이지 구조 기준)
const TIME_SLOTS = [
  "06:00~08:00",
  "08:00~10:00",
  "10:00~12:00",
  "12:00~14:00",
  "14:00~16:00",
  "16:00~18:00",
  "18:00~20:00",
  "20:00~22:00",
];

// 코트(그룹) 번호 매핑 - daily.js / 페이지 네비게이션에서 확인함
const COURTS = {
  1: "대화코트",
  2: "삼송유수지코트",
  3: "성라코트",
  4: "성사전천후코트",
  5: "성사실외코트",
  6: "중산코트",
  7: "충장코트",
  8: "킨텍스유수지코트",
  9: "토당코트",
  10: "화정코트",
};

/**
 * 특정 코트(grp)의 이번 달 날짜별 예약 가능 슬롯 수를 가져옵니다.
 * 반환값: [{ date: "2026-09-10", totalCnt: 9, reserved: "23" }, ...]
 */
async function fetchMonthAvailability(grp) {
  const url = `${BASE_URL}/daily/${grp}`;
  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    timeout: 15000,
  });

  const $ = cheerio.load(res.data);
  const raw = $("#ensdat").attr("value");
  if (!raw) {
    throw new Error(
      "ensdat 값을 찾지 못했어요. 사이트 구조가 바뀌었을 수 있습니다 (scraper.js 확인 필요)."
    );
  }

  const parsed = JSON.parse(raw);
  return parsed.map((item) => ({
    date: item.date,
    totalCnt: Number(item.total_cnt),
    reserved: item.reserved,
  }));
}

/**
 * 특정 코트(grp)의 특정 날짜(date, YYYY-MM-DD) 예약 가능 슬롯 수만 가져옵니다.
 */
async function fetchDateAvailability(grp, date) {
  const month = await fetchMonthAvailability(grp);
  const found = month.find((d) => d.date === date);
  if (!found) {
    throw new Error(`${date}에 대한 데이터를 찾을 수 없어요. (해당 월 범위를 벗어났을 수 있어요)`);
  }
  return found;
}

module.exports = {
  id: "gytennis",
  name: "고양특례시테니스협회",
  courts: COURTS,
  timeSlots: TIME_SLOTS,
  baseUrl: BASE_URL,
  // 월별 요약(total_cnt)이 실제 "빈자리 개수"를 정확히 알려주는 사이트라서,
  // 스케줄러가 이 숫자가 늘어났을 때만 상세 조회를 하도록 가볍게 동작합니다.
  supportsAccurateMonthCount: true,
  fetchMonthAvailability,
  fetchDateAvailability,
  fetchDayDetail,
};

/**
 * 특정 코트(grp)의 특정 날짜(date) 시간대별 x 코트별 예약 가능 여부를 가져옵니다.
 *
 * 페이지 구조 (실제 저장된 상세페이지 HTML 기준):
 * - table.wholeTable 안에 <td>가 여러 개: 첫 번째 <td>는 시간대 라벨, 그 다음부터는 코트별 표
 * - 각 코트 표: 첫 행은 courtTag(코트 번호), 이후 8개 행(resTag)이 06~22시 2시간 단위 슬롯
 * - resTag 안에 <span class="public-empty-slot"> 이 있으면 "예약 가능"
 * - resTag 안에 <div class="public-tooltip-trigger" ...> 가 있으면 "예약됨"(개인 R / 단체 B 모두 마감으로 취급)
 *
 * 반환값: [{ court: 1, time: "18:00~20:00", available: true }, ...]  (코트 수 x 8슬롯)
 */
async function fetchDayDetail(grp, date) {
  const url = `${BASE_URL}/daily/${grp}/${date}`;
  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    timeout: 15000,
  });

  const $ = cheerio.load(res.data);
  const wholeTable = $("table.wholeTable").first();
  if (wholeTable.length === 0) {
    throw new Error(
      "wholeTable을 찾지 못했어요. 사이트 구조가 바뀌었을 수 있습니다 (scraper.js 확인 필요)."
    );
  }

  // wholeTable 바로 아래 tr 하나에 <td>들이 나열되어 있음: [시간라벨td, 코트1td, 코트2td, ...]
  const tds = wholeTable.find("> tbody > tr > td");
  const slots = [];

  tds.each((tdIndex, td) => {
    if (tdIndex === 0) return; // 첫 번째 td는 시간대 라벨 컬럼이라 건너뜀

    const rows = $(td).find("table.innerCustom > tbody > tr");
    if (rows.length === 0) return;

    const courtLabelText = $(rows[0]).find("td.courtTag").text().trim();
    const courtNo = parseInt(courtLabelText, 10);
    if (!courtNo) return;

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const timeLabel = TIME_SLOTS[r - 1] || `slot${r}`;
      const available = $(row).find("span.public-empty-slot").length > 0;
      slots.push({ court: courtNo, time: timeLabel, available });
    }
  });

  return slots;
}
