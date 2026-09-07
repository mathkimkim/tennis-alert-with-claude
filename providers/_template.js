// providers/_template.js
//
// 새 지역 사이트를 추가할 때 이 파일을 복사해서 시작하세요.
// 예: cp providers/_template.js providers/suwontennis.js
//
// 필요한 것: 그 사이트의 "월별 캘린더(또는 목록) 페이지" HTML과
// "특정 날짜 상세(시간대별) 페이지" HTML을 저장해서 구조를 확인한 뒤
// 아래 두 함수를 그 구조에 맞게 구현하면 됩니다.

const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://example.or.kr"; // TODO: 실제 도메인으로 교체

// TODO: 실제 코트 번호/이름 매핑으로 교체
const COURTS = {
  1: "코트 1",
};

const TIME_SLOTS = [
  // TODO: 실제 시간대 구조로 교체 (예: 1시간 단위일 수도 있음)
  "06:00~08:00",
  "08:00~10:00",
];

/**
 * 특정 코트의 이번 달 날짜별 "예약 가능 슬롯 수"를 가져옵니다.
 * 반환값: [{ date: "2026-09-10", totalCnt: 9 }, ...]
 *
 * 만약 이 사이트에 월간 요약 데이터가 따로 없다면(=날짜별 상세를 하나하나 봐야만 알 수 있다면),
 * fetchDayDetail을 이용해 직접 계산해서 반환해도 됩니다.
 */
async function fetchMonthAvailability(grp) {
  throw new Error("TODO: 구현 필요 - fetchMonthAvailability");
}

/**
 * 특정 코트의 특정 날짜(date, YYYY-MM-DD) 시간대별 예약 가능 여부를 가져옵니다.
 * 반환값: [{ court: 1, time: "18:00~20:00", available: true }, ...]
 */
async function fetchDayDetail(grp, date) {
  throw new Error("TODO: 구현 필요 - fetchDayDetail");
}

module.exports = {
  id: "template", // TODO: 고유 id로 교체 (영문 소문자, 공백 없이)
  name: "예시 테니스협회", // TODO: 화면에 표시될 이름
  courts: COURTS,
  timeSlots: TIME_SLOTS,
  baseUrl: BASE_URL,
  fetchMonthAvailability,
  fetchDayDetail,
};
