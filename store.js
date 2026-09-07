// store.js
// 실행 환경에 따라 저장소를 골라서 씁니다.
// - 로컬(내 PC)에서 `node server.js`로 실행 → JSON 파일 저장 (storage/fileBackend.js)
// - Netlify 배포 → Netlify Blobs 저장 (storage/blobsBackend.js)
//
// 둘 다 함수 이름과 시그니처가 동일해서, 이 파일을 쓰는 server.js/scheduler.js 코드는
// 어느 쪽이 실제로 쓰이는지 신경 쓸 필요가 없습니다 (전부 await로 호출하면 됩니다).
//
// 환경 감지: Netlify Functions 실행 환경에서는 NETLIFY 환경변수가 자동으로 설정됩니다.
// 로컬에서 강제로 Blobs를 테스트해보고 싶으면 STORAGE_DRIVER=blobs 로 지정하면 됩니다.

const useBlobs = process.env.STORAGE_DRIVER === "blobs" || Boolean(process.env.NETLIFY);

module.exports = useBlobs ? require("./storage/blobsBackend") : require("./storage/fileBackend");
