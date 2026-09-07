// netlify/functions/api.js
// 기존 Express 앱(server.js)을 그대로 재사용해서 Netlify Function으로 감쌉니다.
// netlify.toml의 리다이렉트 설정 덕분에, 프론트엔드는 예전처럼 /api/... 로 그대로 호출하면 됩니다.

const serverless = require("serverless-http");
const { app } = require("../../server");

exports.handler = serverless(app);
