// providers/index.js
//
// 이 앱이 지원하는 모든 예약 사이트를 등록하는 곳입니다.
// 새 지역을 추가하려면:
//   1) providers/_template.js를 복사해서 새 파일 생성 (예: providers/suwontennis.js)
//   2) 그 사이트의 실제 구조에 맞게 fetchMonthAvailability / fetchDayDetail 구현
//   3) 아래 목록에 require해서 추가

const gytennis = require("./gytennis");
const dobong = require("./dobong");
const gimpo = require("./gimpo");

const PROVIDERS = [gytennis, dobong, gimpo];

function getProvider(id) {
  const p = PROVIDERS.find((p) => p.id === id);
  if (!p) throw new Error(`알 수 없는 provider: ${id}`);
  return p;
}

function listProviders() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    courts: Object.entries(p.courts).map(([grp, name]) => ({ grp: Number(grp), name })),
  }));
}

module.exports = { PROVIDERS, getProvider, listProviders };
