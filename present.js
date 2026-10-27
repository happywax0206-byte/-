// 수업 화면: 교사 화면의 「수업 화면 띄우기」로 여는 탭. 교사 화면은 빼고 학생에게 보여 줄 슬라이드만 화면 가득 띄운다.
// 교사 화면이 BroadcastChannel("cra-present")로 보내는 지금 쪽·시뮬레이션·크게 띄운 것(시뮬레이션·결과·링크)을 그대로 따라간다.
// 서버에 묻지 않으므로 로그인도 필요 없고 사용량도 늘지 않는다.

const ch = window.BroadcastChannel ? new BroadcastChannel("cra-present") : null;
const img = h("img", { class: "present-slide", alt: "" });
const layer = slideLayer(img);
const simStage = h("div", { class: "sim-stage", hidden: true });
const empty = h("div", { class: "present-empty" }, "교사 화면과 연결하는 중…");
const stage = h("div", { class: "present-stage" }, img, layer, simStage, empty);
const show = h("div", { class: "present-show", hidden: true });
const hint = h("p", { class: "present-hint" }, "화면을 한 번 누르면 전체 화면 · ← → 로 쪽 넘기기");
document.getElementById("app").replaceChildren(stage, show, hint);

let st = null;          // 교사 화면이 보낸 상태 { lesson, sims, show }
let lessonId = null;
let shownPage = 0;
let simKey = "";
let showKey = "";
let localShow = false;  // 이 탭에서 직접 크게 띄운 것인지(슬라이드 위 시뮬레이션의 ⤢)

function render() {
  const L = st.lesson;
  if (!L) {
    document.title = "수업 화면";
    empty.textContent = "교사 화면에서 수업을 고르세요.";
    empty.hidden = false;
    img.hidden = simStage.hidden = true;
    showSimBoxes(layer, [], () => "", null);
    renderShow(st.show);
    return;
  }
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
  // 「슬라이드 대신 크게」 시뮬레이션
  const key = stageSim ? stageSim.id + ":" + (stageSim.html || "").length + ":" + stageSim.title : "";
  simStage.hidden = !stageSim;
  if (key !== simKey) {
    simKey = key;
    simStage.replaceChildren(...(stageSim ? [simFrame(stageSim.html, stageSim.title)] : []));
  }
  // 슬라이드 위 정한 자리에 얹는 시뮬레이션
  const boxed = has && !stageSim ? st.sims.filter((a) => !a.sim_full && validSimBox(a.sim_box) && onPage(a, L.page)) : [];
  showSimBoxes(layer, boxed, (a) => a.html, (a) => { localShow = true; renderShow({ kind: "sim", title: a.title, html: a.html }); });
  if (!localShow) renderShow(st.show);
}

// 크게 띄운 것: 화면 전체를 덮는다
function renderShow(s) {
  const key = s ? JSON.stringify(s) : "";
  if (key === showKey) return;
  showKey = key;
  if (!s) { show.hidden = true; show.replaceChildren(); localShow = false; return; }
  let body;
  if (s.kind === "sim") body = simFrame(s.html, s.title);
  else if (s.kind === "link") body = linkFrame(s.url, s.title);
  else {
    // 교사 화면이 h()로 만든 것을 옮겨 적은 것(학생 글은 글자로만 들어 있다)
    body = h("div", { class: "present-view" });
    body.innerHTML = s.html || "";
  }
  show.replaceChildren(
    h("div", { class: "present-show-head" }, h("strong", {}, s.title || ""),
      h("span", { class: "row" },
        s.kind === "link" ? h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, "안 보이면 새 탭에서 열기") : null,
        h("button", { class: "ghost", type: "button", onclick: closeShow }, "닫기"))),
    body);
  show.hidden = false;
}

// 외부 링크. 유튜브 주소는 화면 안에 띄울 수 있는 주소로 바꾼다. 다른 사이트 중에는 안에 띄우는 것을 막아 둔 곳도 있다.
function linkFrame(url, title) {
  if (!/^https?:\/\//i.test(url || "")) return h("p", { class: "present-empty" }, "열 수 없는 주소입니다.");
  const f = h("iframe", { class: "present-link", src: embedUrl(url), title: title || "링크",
    allow: "autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write", allowfullscreen: true, referrerpolicy: "strict-origin-when-cross-origin" });
  // 띄운 사이트가 이 탭을 다른 곳으로 옮기지 못하게
  f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-modals allow-downloads");
  return f;
}

function embedUrl(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^(www|m)\./, "");
    const id = host === "youtu.be" ? x.pathname.slice(1)
      : host === "youtube.com" && x.pathname === "/watch" ? x.searchParams.get("v")
      : host === "youtube.com" && /^\/(shorts|live)\//.test(x.pathname) ? x.pathname.split("/")[2] : null;
    if (id && /^[\w-]{6,20}$/.test(id)) {
      const t = parseInt(x.searchParams.get("t") || x.searchParams.get("start") || "", 10);
      return "https://www.youtube.com/embed/" + id + "?autoplay=1" + (t > 0 ? "&start=" + t : "");
    }
  } catch (_) {}
  return u;
}

function closeShow() {
  const fromTeacher = !localShow && st && st.show;
  renderShow(null);
  if (fromTeacher && ch) ch.postMessage({ type: "closed" });
}

if (ch) {
  ch.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === "state") {
      try { st = JSON.parse(m.state); } catch (_) { return; }
      if (localShow && st.show) localShow = false;   // 교사가 새로 띄운 것이 먼저
      render();
    }
    if (m.type === "who") ch.postMessage({ type: "hello" });
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
