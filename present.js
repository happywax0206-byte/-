// 수업 화면: 교사 화면의 「수업 화면 띄우기」로 여는 탭. 교사 화면은 빼고 학생에게 보여 줄 슬라이드만 화면 가득 띄운다.
// 교사 화면이 BroadcastChannel("cra-present")로 보내는 지금 쪽·시뮬레이션·크게 띄운 것(시뮬레이션·결과·링크)을 그대로 따라간다.
// 교사 화면이 「이 탭」 화면 공유를 허용하면 시뮬레이션·링크 칸은 교사 화면을 잘라 낸 영상(cra_stream)으로 보여서
// 교사가 조작한 것이 그대로 보인다. 허용하지 않으면 이 탭에 따로 띄운 사본을 보인다.
// 서버에 묻지 않으므로 로그인도 필요 없고 사용량도 늘지 않는다.

const ch = window.BroadcastChannel ? new BroadcastChannel("cra-present") : null;
const img = h("img", { class: "present-slide", alt: "" });
const layer = slideLayer(img);
const simStage = h("div", { class: "sim-stage", hidden: true });
const allBox = h("div", { class: "present-all", hidden: true });   // 슬라이드 위 시뮬레이션이 여럿일 때: 교사 화면의 슬라이드 칸 전체
const empty = h("div", { class: "present-empty" }, "교사 화면과 연결하는 중…");
const stage = h("div", { class: "present-stage" }, img, layer, simStage, allBox, empty);
const show = h("div", { class: "present-show", hidden: true });
const hint = h("p", { class: "present-hint" }, "화면을 한 번 누르면 전체 화면 · ← → 로 쪽 넘기기");
document.getElementById("app").replaceChildren(stage, show, hint);

// 교사 화면에서 넘겨받는 영상. 하나뿐이라 지금 보낼 자리로 옮겨 단다.
const video = h("video", { class: "present-video", autoplay: true, playsinline: true });
video.muted = true;
window.cra_stream = (s) => {
  if (video.srcObject !== s) video.srcObject = s;
  if (video.paused && video.isConnected && !(st && st.mirror && st.mirror.frozen)) video.play().catch(() => {});
};
// frozen: 교사 화면에서 그 칸이 스크롤로 화면 밖에 나가 있음 → 비어 보이지 않게 마지막 장면에서 멈춰 둔다
function placeVideo(where, frozen) {
  if (!where) { video.remove(); return; }
  if (video.parentNode !== where) where.append(video);
  if (frozen) { if (!video.paused) video.pause(); }
  else if (video.paused && video.srcObject) video.play().catch(() => {});
}
// 교사 화면에 이 창을 알린다(영상을 직접 넘겨받으려고). 교사 화면이 새로고침되면 who 를 받을 때 다시 알린다.
function attach() { try { if (window.opener && window.opener.cra_attachPresent) window.opener.cra_attachPresent(window); } catch (_) {} }
attach();

let st = null;          // 교사 화면이 보낸 상태 { lesson, sims, show, mirror, asking }
let lessonId = null;
let shownPage = 0;
let simKey = "";
let showKey = "";
let localShow = false;  // 이 탭에서 직접 크게 띄운 것인지(슬라이드 위 시뮬레이션의 ⤢)

function render() {
  const L = st.lesson;
  const m = st.mirror;
  let videoAt = null;
  if (!L) {
    document.title = "수업 화면";
    empty.textContent = "교사 화면에서 수업을 고르세요.";
    empty.hidden = false;
    img.hidden = simStage.hidden = allBox.hidden = true;
    showSimBoxes(layer, [], () => "", null);
  } else {
    document.title = L.title + " · 수업 화면";
    if (L.id !== lessonId) { lessonId = L.id; shownPage = 0; img.removeAttribute("src"); }
    const has = L.slide_count > 0;
    const stageSim = has ? st.sims.find((a) => a.sim_full && onPage(a, L.page)) : null;
    empty.hidden = has;
    if (!has) empty.textContent = L.title;
    if (has) {
      // 화면 넘김 효과는 교사 화면과 같게: 앞으로 가면 그 쪽의 효과, 뒤로 가면 떠나는 쪽의 효과를 거꾸로
      const dir = shownPage && L.page < shownPage ? -1 : 1;
      changeSlide(img, slideSrc(L, L.page), stageSim || shownPage === L.page ? null : transitionFor(L, dir > 0 ? L.page : shownPage), dir, [layer]);
      shownPage = L.page;
      img.alt = "슬라이드 " + L.page;
      if (L.page < L.slide_count) new Image().src = slideSrc(L, L.page + 1);
    }
    img.hidden = !has || !!stageSim;
    // 「슬라이드 대신 크게」 시뮬레이션: 교사 화면 영상이 오면 그것을, 아니면 사본을
    const live = !!stageSim && m && m.mode === "stage";
    const key = stageSim ? (live ? "live" : stageSim.id + ":" + (stageSim.html || "").length + ":" + stageSim.title) : "";
    simStage.hidden = !stageSim;
    if (key !== simKey) {
      simKey = key;
      simStage.replaceChildren(...(stageSim && !live ? [simFrame(stageSim.html, stageSim.title)] : []));
    }
    if (live) videoAt = simStage;
    // 슬라이드 위 정한 자리에 얹는 시뮬레이션
    const boxed = has && !stageSim ? st.sims.filter((a) => !a.sim_full && validSimBox(a.sim_box) && onPage(a, L.page)) : [];
    showSimBoxes(layer, boxed, (a) => a.html, (a) => { localShow = true; renderShow({ kind: "sim", title: a.title, html: a.html }); });
    for (const box of layer.children) {
      const on = !!m && m.mode === "box" && box._id === m.id;
      box.classList.toggle("mirrored", on);
      if (on) videoAt = box;
    }
    allBox.hidden = !(boxed.length && m && m.mode === "all");
    if (!allBox.hidden) videoAt = allBox;
  }
  if (!localShow) renderShow(st.show);
  if (!show.hidden && m && m.mode === "show" && !localShow) videoAt = show.querySelector(".present-video-wrap");
  placeVideo(videoAt, !!(m && m.frozen));
}

// 크게 띄운 것: 화면 전체를 덮는다
function renderShow(s) {
  const m = st && st.mirror;
  const live = !!s && !localShow && !!m && m.mode === "show";
  const waiting = !!s && !localShow && !live && st.asking && s.kind !== "view";
  const key = s ? JSON.stringify(s) + (live ? ":live" : waiting ? ":wait" : "") : "";
  if (key === showKey) return;
  showKey = key;
  if (!s) { show.hidden = true; show.replaceChildren(); localShow = false; return; }
  let body;
  if (live) body = h("div", { class: "present-video-wrap" });
  else if (waiting) body = h("p", { class: "present-empty" }, "교사 화면에서 화면 공유(「이 탭」)를 허용하면 조작하는 그대로 보입니다…");
  else if (s.kind === "sim") body = simFrame(s.html, s.title);
  else if (s.kind === "link") body = linkFrame(s.url, s.title);
  else {
    // 교사 화면이 h()로 만든 것을 옮겨 적은 것(학생 글은 글자로만 들어 있다)
    body = h("div", { class: "present-view" });
    body.innerHTML = s.html || "";
  }
  show.replaceChildren(
    h("div", { class: "present-show-head" }, h("strong", {}, s.title || ""),
      h("span", { class: "row" },
        s.kind === "link" && !live ? h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, "안 보이면 새 탭에서 열기") : null,
        h("button", { class: "ghost", type: "button", onclick: closeShow }, "닫기"))),
    body);
  show.hidden = false;
}

function closeShow() {
  const fromTeacher = !localShow && st && st.show;
  renderShow(null);
  if (fromTeacher && ch) ch.postMessage({ type: "closed" });   // 교사 화면에서도 닫히고 새 상태가 온다
}

if (ch) {
  ch.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === "state") {
      try { st = JSON.parse(m.state); } catch (_) { return; }
      if (localShow && st.show) localShow = false;   // 교사가 새로 띄운 것이 먼저
      render();
    }
    if (m.type === "who") { attach(); ch.postMessage({ type: "hello" }); }
  };
  ch.postMessage({ type: "hello" });
  addEventListener("pagehide", () => ch.postMessage({ type: "bye" }));
  setTimeout(() => { if (!st) empty.textContent = "교사 화면과 연결되지 않았습니다. 교사 화면 탭에서 「수업 화면 띄우기」를 다시 누르세요."; }, 3000);
} else empty.textContent = "이 브라우저에서는 수업 화면을 쓸 수 없습니다. Chrome이나 Edge를 쓰세요.";

// 화면을 누르면 전체 화면(브라우저는 누르기 같은 동작 없이 전체 화면으로 바꾸지 못하게 막는다)
stage.addEventListener("click", () => {
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener("fullscreenchange", () => { hint.hidden = !!document.fullscreenElement; });
setTimeout(() => { hint.hidden = true; }, 8000);

// 프로젝터 화면 쪽에서 눌러도(무선 프레젠터 포함) 교사 화면이 쪽을 넘긴다
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !show.hidden) { closeShow(); return; }
  const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, Enter: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1, Backspace: -1 }[e.key];
  if (step && ch && show.hidden) { e.preventDefault(); ch.postMessage({ type: "step", step }); }
});
