// netlify/functions/tick.js
//
// Netlify Functions는 로컬의 node-cron처럼 "항상 켜져서 3분마다 알아서 도는" 걸 못 합니다.
// 대신 이 함수를 외부 스케줄러(cron-job.org 등)가 주기적으로 "호출"해줘야 그때 한 번
// 확인이 실행됩니다. 즉 cron-job.org가 예전의 node-cron 역할을 대신하는 셈입니다.
//
// 실행 시간 제한(보통 10초) 때문에 등록된 감시를 한꺼번에 다 확인하지 않고,
// 호출될 때마다 감시 목록을 순서대로 하나씩만 확인합니다(라운드로빈).
// 그래서 cron-job.org는 되도록 자주(예: 1분마다) 호출하도록 설정하는 걸 추천해요.
//
// 아무나 이 URL을 알면 마음대로 호출해서 사이트에 불필요한 요청을 유발할 수 있으니,
// TICK_SECRET 환경변수를 설정해두면 그 값을 알아야만 실행되도록 막습니다.
// 예: https://내사이트.netlify.app/.netlify/functions/tick?key=아무거나비밀값

const { checkOneRoundRobin } = require("../../scheduler");

exports.handler = async (event) => {
  const providedKey = (event.queryStringParameters && event.queryStringParameters.key) || "";
  const requiredKey = process.env.TICK_SECRET;

  if (requiredKey && providedKey !== requiredKey) {
    return { statusCode: 401, body: "unauthorized" };
  }

  try {
    await checkOneRoundRobin();
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("[tick] checkOneRoundRobin 오류:", err);
    return { statusCode: 500, body: `error: ${err.message}` };
  }
};
