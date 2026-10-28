// 교사 화면에 이 확장 프로그램이 있다고 알리고, 「관리」 탭의 요청을 확장 프로그램에 전한다.
// 돌려주는 것은 사용량 숫자뿐이다(Supabase 로그인 정보는 넘기지 않는다).
document.documentElement.dataset.craUsage = chrome.runtime.getManifest().version;

window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.cra !== "usage-request") return;
  chrome.runtime.sendMessage({ type: "usage", ref: e.data.ref, force: !!e.data.force }, (res) => {
    const err = chrome.runtime.lastError;
    window.postMessage({ cra: "usage-result", id: e.data.id, res: res || { error: err ? err.message : "응답 없음" } }, location.origin);
  });
});
