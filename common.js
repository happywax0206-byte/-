// 학생 화면과 교사 화면이 함께 쓰는 것들

// 주소 끝에 /rest/v1/ 같은 꼬리나 빈칸이 붙어 있어도 프로젝트 주소만 쓴다
const SB_URL = String(SUPABASE_URL).trim().replace(/\/(rest|auth|storage)\/v1.*$/, "").replace(/\/+$/, "");
const configured = (/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SB_URL) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SB_URL))
  && !/여기에/.test(SUPABASE_KEY) && String(SUPABASE_KEY).trim() !== "";
// 학교 와이파이가 서버 주소를 막으면 요청이 끝없이 기다리기도 한다: 20초가 지나면 끊고 오류로 알린다(파일 올리기는 제외)
function fetchWithTimeout(url, opts) {
  if (/\/storage\/v1\//.test(String(url && url.url || url)) || !window.AbortController) return fetch(url, opts);
  const ctl = new AbortController();
  if (opts && opts.signal) opts.signal.addEventListener("abort", () => ctl.abort());
  const t = setTimeout(() => ctl.abort(), 20000);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}
const sb = configured && window.supabase
  ? supabase.createClient(SB_URL, String(SUPABASE_KEY).trim(), { global: { fetch: fetchWithTimeout } }) : null;
// 서버에 닿지 못했을 때 덧붙이는 안내
const NET_HINT = "학교 와이파이에서만 안 되면 휴대폰 데이터(LTE·5G)로 바꿔 보세요. 와이파이가 서버 주소(supabase.co)를 막고 있을 수 있습니다.";

// 만든 사람 표시. 고쳐 쓰거나 나눌 때도 지우지 말아 주세요(LICENSE.md).
const CREDIT = { name: "이효송", year: 2026 };

// 슬라이드 질문·설문은 이제 하나(「질문」)로 보인다. 예전 활동의 kind 값은 그대로 둔다
const KIND_NAME = { slide: "질문", survey: "질문", quiz: "퀴즈", sim: "시뮬레이션" };
const INFO_NAME = "설명";   // 카드 안의 설명 칸(답 없음, questions의 type "info")
const TYPE_NAME = { choice: "하나 고르기", multi: "여러 개 고르기", short: "짧은 글", long: "긴 글", file: "파일 올리기" };

// 학생이 답으로 올리는 파일. setup.sql 의 submissions 저장소와 같은 종류·크기만 받는다.
const FILE_MAX = 10 * 1024 * 1024;
const FILE_COUNT = 5;   // 한 질문에 올릴 수 있는 파일 수
const FILE_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  pdf: "application/pdf", txt: "text/plain",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  hwp: "application/x-hwp", hwpx: "application/vnd.hancom.hwpx", zip: "application/zip",
  mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "video/mp4", mov: "video/quicktime",
};
const fileExt = (name) => (/\.([a-z0-9]{1,5})$/i.exec(name || "") || [])[1]?.toLowerCase() || "";
const fileTypeOf = (name) => FILE_TYPES[fileExt(name)] || "";
const fileAccept = (q) => q.accept === "image" ? "image/*" : "image/*," + Object.keys(FILE_TYPES).map((x) => "." + x).join(",");
const fileSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB";

// 올린 파일 목록. open 이 있으면(교사 화면) 이름을 눌러 열어 본다
function fileLinks(list, open) {
  return [].concat(list ?? []).map((f, i) => [i ? ", " : null,
    open ? h("button", { class: "link file-link", type: "button", onclick() { open(f); } }, f.name) : h("span", {}, f.name)]);
}

// 화면 요소 만들기. 학생이 쓴 글은 늘 글자(텍스트)로만 넣는다(innerHTML을 쓰지 않음).
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// 슬라이드 그림 주소. 보통은 "폴더/1.png". 폴더 칸에 {n}을 넣으면 그 자리에 쪽 번호가 들어간다
// (예: "slides/슬라이드{n}.PNG" → PowerPoint가 내보낸 이름을 그대로 쓸 때).
// 활동이 이 쪽에 보이는지. page부터 page_to까지(page_to가 없으면 page 한 쪽)
function onPage(a, n) {
  return a.page != null && a.page <= n && n <= Math.max(a.page_to ?? a.page, a.page);
}

// 시뮬레이션(html) 칸. sandbox 로 격리해서 이 웹앱의 로그인 정보나 저장소에 손대지 못하게 한다.
function simFrame(html, title) {
  const f = h("iframe", { class: "sim-frame", title: title || "시뮬레이션", loading: "lazy" });
  f.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-pointer-lock allow-downloads");
  if (html != null) f.srcdoc = html;
  return f;
}

// ---------- 슬라이드 위에 얹는 시뮬레이션 ----------
// sim_box = { x, y, w, h }: 슬라이드 그림 안에서의 자리(0~1 비율). 시뮬레이션은 슬라이드 너비를 SIM_BASE 픽셀로 보고 그린 뒤
// 화면 크기에 맞춰 통째로 줄이거나 키운다. 그래서 교사 화면·학생 휴대폰·전체 화면에서 모두 같은 모양으로 보인다.
const SIM_BASE = 1280;

function validSimBox(b) {
  return !!b && [b.x, b.y, b.w, b.h].every((v) => typeof v === "number" && isFinite(v)) && b.w > 0 && b.h > 0;
}

// 그림 칸 안에서 실제 슬라이드가 그려진 자리(object-fit: contain 이라 위아래나 양옆이 빌 수 있다). offsetParent 기준.
function slideContentRect(img) {
  const W = img.clientWidth, H = img.clientHeight;
  const nw = img.naturalWidth || 16, nh = img.naturalHeight || 9;
  const k = Math.min(W / nw, H / nh);
  const w = nw * k, hh = nh * k;
  return { left: img.offsetLeft + img.clientLeft + (W - w) / 2, top: img.offsetTop + img.clientTop + (H - hh) / 2, width: w, height: hh };
}

// 슬라이드 그림(img)과 같은 칸(position: relative)에 넣는 층. 그림 크기가 바뀌면 따라서 다시 맞춘다.
function slideLayer(img, cls) {
  const layer = h("div", { class: "sim-layer" + (cls ? " " + cls : ""), hidden: true });
  const relayout = () => {
    if (img.hidden || !img.naturalWidth || !img.clientWidth) { layer.hidden = true; return; }
    const r = slideContentRect(img);
    layer.hidden = false;
    Object.assign(layer.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    const k = r.width / SIM_BASE;
    for (const box of layer.children) {
      const b = box._box, f = box.querySelector("iframe");
      Object.assign(box.style, { left: b.x * 100 + "%", top: b.y * 100 + "%", width: b.w * 100 + "%", height: b.h * 100 + "%" });
      if (f) Object.assign(f.style, { width: b.w * SIM_BASE + "px", height: (b.h * r.height) / k + "px", transform: "scale(" + k + ")" });
    }
  };
  img.addEventListener("load", relayout);
  if (window.ResizeObserver) new ResizeObserver(relayout).observe(img);
  window.addEventListener("resize", relayout);
  layer.relayout = relayout;
  return layer;
}

// 시뮬레이션 상자 하나. full 이 있으면 오른쪽 위에 「크게」 단추
function simBoxEl(a, box, full) {
  const f = simFrame(null, a.title);
  f.classList.add("boxed");
  const el = h("div", { class: "sim-box" }, f,
    full ? h("button", { class: "sim-box-full", type: "button", title: "크게 보기", "aria-label": a.title + " 크게 보기", onclick() { full(a); } }, "⤢") : null);
  el._box = box;
  el._frame = f;
  el._id = a.id;
  return el;
}

// 층에 시뮬레이션들을 얹는다. list 가 그대로면(같은 활동·자리·내용) 다시 띄우지 않는다.
function showSimBoxes(layer, list, getHtml, full) {
  const key = list.map((a) => a.id + ":" + JSON.stringify(a.sim_box) + ":" + (a.html_ver || (a.html || "").length)).join("|");
  if (layer._key !== key) {
    layer._key = key;
    layer.replaceChildren(...list.map((a) => {
      const el = simBoxEl(a, a.sim_box, full);
      Promise.resolve(getHtml(a)).then((html) => { if (layer._key === key) el._frame.srcdoc = html || ""; }).catch(() => {});
      return el;
    }));
  }
  layer.relayout();
}

// content(시뮬레이션·링크 칸)를 화면 가득 띄운다. 닫기 버튼이나 Esc로 닫는다. onclose: 닫힐 때 부를 함수. extra: 제목 옆에 둘 것.
// 닫는 함수를 돌려주고, close.body 는 content를 감싼 칸이다.
function openFull(title, content, onclose, extra) {
  const close = () => {
    if (!box.isConnected) return;
    box.remove(); document.removeEventListener("keydown", esc); if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (onclose) onclose();
  };
  const esc = (e) => { if (e.key === "Escape") close(); };
  const body = h("div", { class: "sim-full-body" }, content);
  const box = h("div", { class: "sim-full" },
    h("div", { class: "sim-full-head" }, h("strong", {}, title || "시뮬레이션"),
      h("span", { class: "row" }, extra, h("button", { class: "ghost", type: "button", onclick: close }, "닫기"))),
    body);
  document.addEventListener("keydown", esc);
  document.body.append(box);
  if (box.requestFullscreen) box.requestFullscreen().catch(() => {});
  close.body = body;
  return close;
}

function openSimFull(title, html, onclose) {
  return openFull(title, simFrame(html, title), onclose);
}

// 외부 링크 칸. 유튜브 주소는 화면 안에서 재생되는 주소로 바꾼다. 다른 사이트 중에는 안에 띄우는 것을 막아 둔 곳도 있다.
function linkFrame(url, title) {
  if (!/^https?:\/\//i.test(url || "")) return h("p", { class: "muted" }, "열 수 없는 주소입니다.");
  const f = h("iframe", { class: "sim-frame link-frame", src: embedUrl(url), title: title || "링크",
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

// ---------- 학생 화면 전체 보기(WebRTC) — 학생·교사 화면이 함께 쓴다 ----------
// 영상은 서버를 거치지 않고 두 브라우저 사이에 바로 간다. 서로 주소를 알아내는 데만 공개 STUN 서버를 쓴다.
const SCREEN_ICE = [{ urls: "stun:stun.l.google.com:19302" }];

// 연결 정보(주소 후보) 모으기가 끝날 때까지(최대 4초) 기다린다. 다 모은 다음 한 번에 서버에 적는다.
function iceDone(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((ok) => {
    const t = setTimeout(ok, 4000);
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); ok(); } });
  });
}

function slideSrc(lesson, n) {
  const dir = lesson.slide_dir.trim();
  return encodeURI(dir.includes("{n}") ? dir.split("{n}").join(n) : dir.replace(/\/+$/, "") + "/" + n + ".png");
}

// ---------- 화면 넘김 효과 ----------
// lesson.transition = { type, ms, pages: { "쪽 번호": type } }. 그 쪽으로 들어갈 때의 효과이고, 앞 쪽으로 돌아갈 때는 거꾸로 움직인다.
const TRANSITIONS = { none: "없음 (바로 바뀜)", fade: "서서히 바뀌기", push: "밀어내기", cover: "덮기", wipe: "닦아내기", zoom: "확대", flip: "뒤집기", up: "위로 밀기", book: "책장 넘기기" };
const TRANSITION_SPEED = { 300: "빠르게", 600: "보통", 1000: "느리게" };

function transitionFor(lesson, n) {
  const t = lesson.transition && typeof lesson.transition === "object" ? lesson.transition : {};
  const type = (t.pages && t.pages[n]) || t.type || "none";
  return { type: TRANSITIONS[type] ? type : "none", ms: Math.min(Math.max(+t.ms || 600, 100), 3000) };
}

// [새 그림 움직임, 예전 그림 움직임, 새 그림이 위에 오는지]. dir: 1 = 다음 쪽으로, -1 = 앞 쪽으로
function transitionFrames(type, dir) {
  const x = (k) => "translateX(" + k * 100 + "%)", y = (k) => "translateY(" + k * 100 + "%)";
  const rot = (d) => "perspective(1600px) rotateY(" + d + "deg)";
  switch (type) {
    case "fade": return [[{ opacity: 0 }, { opacity: 1 }], [{ opacity: 1 }, { opacity: 0 }], false];
    case "push": return [[{ transform: x(dir) }, { transform: "none" }], [{ transform: "none" }, { transform: x(-dir) }], false];
    case "up": return [[{ transform: y(dir) }, { transform: "none" }], [{ transform: "none" }, { transform: y(-dir) }], false];
    case "cover": return [[{ transform: x(dir) }, { transform: "none" }], null, true];
    case "wipe": return [[{ clipPath: dir > 0 ? "inset(0 100% 0 0)" : "inset(0 0 0 100%)" }, { clipPath: "inset(0 0 0 0)" }], null, true];
    case "zoom": return [[{ transform: "scale(" + (dir > 0 ? 0.5 : 1.3) + ")", opacity: 0 }, { transform: "none", opacity: 1 }],
      [{ transform: "none", opacity: 1 }, { transform: "scale(" + (dir > 0 ? 1.3 : 0.5) + ")", opacity: 0 }], false];
    case "flip": return [[{ transform: rot(dir * 90) }, { transform: rot(dir * 90), offset: 0.5 }, { transform: rot(0) }],
      [{ transform: rot(0) }, { transform: rot(-dir * 90), offset: 0.5, opacity: 1 }, { transform: rot(-dir * 90), opacity: 0 }], false];
    case "book": {
      // 왼쪽 끝을 책등으로 삼아 종이 한 장이 넘어간다. 다음 쪽: 지금 쪽이 들려 왼쪽으로 넘어가고 아래에서 새 쪽이 드러난다.
      // 앞 쪽: 넘겼던 쪽이 왼쪽에서 되넘어와 덮는다. 넘어가는 종이에는 그림자, 밑에 깔린 쪽은 어두웠다가 밝아진다.
      const page = (deg, shadow) => ({ transform: "perspective(2200px) rotateY(" + deg + "deg)", transformOrigin: "left center", backfaceVisibility: "hidden",
        boxShadow: shadow ? "18px 0 40px rgba(0,0,0,.35)" : "0 0 0 rgba(0,0,0,0)" });
      const turn = (from, to) => [page(from, false), { ...page((from + to) / 2, true), offset: 0.5 }, page(to, false)];
      const under = (a, b) => [{ filter: "brightness(" + a + ")" }, { filter: "brightness(" + b + ")" }];
      return dir > 0 ? [under(0.55, 1), turn(0, -90), false] : [turn(-90, 0), under(1, 0.55), true];
    }
  }
  return [null, null, false];
}

// 슬라이드 그림(img)을 src로 바꾸며 넘김 효과를 준다. 예전 그림의 복사본을 같은 자리에 겹쳐 두고,
// 새 그림을 다 불러오면 둘을 함께 움직인다. also: 함께 서서히 나타날 요소(슬라이드 위 시뮬레이션 층)
function changeSlide(img, src, fx, dir, also) {
  if (img.getAttribute("src") === src) return;
  if (img._fx) img._fx();   // 아직 끝나지 않은 효과는 바로 끝낸다
  const old = img.getAttribute("src");
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [inK, outK, newOnTop] = transitionFrames(fx && fx.type, dir);
  if (!inK || !old || img.hidden || !img.animate || !img.naturalWidth || !img.offsetWidth || reduce) { img.src = src; return; }
  const parent = img.parentNode;
  const ghost = img.cloneNode(false);
  ghost.removeAttribute("id");
  ghost.alt = "";
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, { position: "absolute", left: img.offsetLeft + "px", top: img.offsetTop + "px", width: img.offsetWidth + "px", height: img.offsetHeight + "px",
    margin: "0", maxWidth: "none", maxHeight: "none", pointerEvents: "none" });
  // 둘 다 위치를 가진 요소로 두면 문서 순서대로 겹친다(시뮬레이션 층은 그 뒤에 있어 늘 위에 보인다)
  img.style.position = "relative";
  if (newOnTop) img.before(ghost); else img.after(ghost);
  parent.classList.add("slide-fx");
  img.style.opacity = "0";
  const anims = [];
  let done = false, started = false, timer = 0;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    img._fx = null;
    img.removeEventListener("load", start);
    img.removeEventListener("error", start);
    anims.forEach((a) => a.cancel());
    ghost.remove();
    img.style.opacity = "";
    img.style.position = "";
    parent.classList.remove("slide-fx");
  };
  function start() {
    if (done || started) return;
    started = true;
    clearTimeout(timer);
    img.style.opacity = "";
    const opt = { duration: fx.ms, easing: "ease-in-out" };
    anims.push(img.animate(inK, opt));
    if (outK) anims.push(ghost.animate(outK, { ...opt, fill: "forwards" }));
    for (const el of also || []) if (el && !el.hidden) anims.push(el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], opt));
    anims[0].finished.then(finish, finish);
  }
  img._fx = finish;
  img.addEventListener("load", start);
  img.addEventListener("error", start);
  timer = setTimeout(start, 4000);   // 그림이 늦게 오면 기다리지 않고 움직인다
  img.src = src;
}

function fmtTime(t) {
  if (!t) return "—";
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return (today ? "" : (d.getMonth() + 1) + "/" + d.getDate() + " ") +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// 응답 하나를 글로: 여러 개 고르기는 쉼표로 잇는다
function answerText(v) {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.name : x)).join(", ");
  return v == null ? "" : String(v);
}

function isEmptyAnswer(v) {
  return v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "");
}

// 설명문은 텍스트로 표시하고, 웹 주소만 안전한 링크로 바꾼다.
function linkedDescription(value) {
  const box = h("p", { class: "question-description" });
  const urlPattern = /https?:\/\/[^\s<>"']+/g;
  const source = String(value || "");
  let from = 0;
  for (const match of source.matchAll(urlPattern)) {
    const raw = match[0];
    const urlText = raw.replace(/[.,!?;:)\]]+$/, "");
    box.append(document.createTextNode(source.slice(from, match.index)));
    try {
      const url = new URL(urlText);
      if (url.protocol === "http:" || url.protocol === "https:") {
        box.append(h("a", { href: url.href, target: "_blank", rel: "noopener noreferrer" }, urlText));
      } else box.append(document.createTextNode(urlText));
    } catch (_) { box.append(document.createTextNode(urlText)); }
    from = match.index + urlText.length;
  }
  box.append(document.createTextNode(source.slice(from)));
  return box;
}

function activityDescription(activity) {
  const questions = activity.questions || [];
  return questions.find((q) => q.intro)?.intro ||
    [...new Set(questions.map((q) => q.description).filter(Boolean))].join("\n\n");
}

// 카드 안의 「설명」 칸(type info)은 답을 받지 않는다. 답을 받는 질문만
function askedQuestions(activity) {
  return (activity.questions || []).filter((q) => q.type !== "info");
}

// 설명 칸만 있는 카드(예전 「설명 카드」 포함): 학생은 답하지 않는다
function isInfoActivity(activity) {
  const qs = activity.questions || [];
  return activity.kind !== "sim" && qs.length > 0 && qs.every((q) => q.type === "info");
}

function activityName(activity) {
  return isInfoActivity(activity) ? "설명 카드" : KIND_NAME[activity.kind];
}

// 응답 모아 보기: 고르는 질문은 막대, 글은 목록. docs = [{ name, answers }]
function summaryView(questions, docs, opts) {
  opts = opts || {};
  return questions.filter((q) => q.type !== "info").map((q, i) => {
    const answered = docs.filter((d) => !isEmptyAnswer(d.answers[q.id]));
    const head = h("p", { class: "sum-q" }, (i + 1) + ". " + q.text);
    if (q.type === "file") {
      return h("div", { class: "sum-block" }, head,
        answered.length ? answered.map((d) => h("p", { class: "note" }, d.name ? h("strong", {}, d.name + " · ") : null, fileLinks(d.answers[q.id], opts.openFile)))
          : h("p", { class: "muted small" }, opts.empty || "아직 응답이 없습니다."));
    }
    if (q.type === "choice" || q.type === "multi") {
      return h("div", { class: "sum-block" }, head, q.options.map((o) => {
        const n = answered.filter((d) => [].concat(d.answers[q.id]).includes(o)).length;
        const pct = answered.length ? Math.round((n / answered.length) * 100) : 0;
        const right = q.answer != null && [].concat(q.answer).includes(o);
        return h("div", { class: "bar-row" },
          h("span", { class: "bar-label" }, o, right ? h("strong", { class: "right-mark" }, " ✓정답") : null),
          h("span", { class: "bar-track" }, h("span", { class: "bar", style: "width:" + pct + "%" })),
          h("span", { class: "bar-value" }, n + "명"));
      }));
    }
    return h("div", { class: "sum-block" }, head,
      answered.length ? answered.map((d) => h("p", { class: "note" }, d.name ? h("strong", {}, d.name + " · ") : null, answerText(d.answers[q.id])))
        : h("p", { class: "muted small" }, opts.empty || "아직 응답이 없습니다."));
  });
}

function openModal(title, body, onclose) {
  const close = () => { if (!box.isConnected) return; box.remove(); if (onclose) onclose(); };
  const box = h("div", { class: "overlay", onclick(e) { if (e.target === box) close(); } },
    h("div", { class: "modal" },
      h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { class: "ghost", type: "button", onclick: close }, "닫기")),
      h("div", { class: "modal-body" }, body)));
  document.body.append(box);
  return close;
}

function notConfigured(app) {
  if (configured && !window.supabase) {
    app.replaceChildren(h("main", { class: "narrow" }, h("section", { class: "card" },
      h("h1", {}, "필요한 파일을 불러오지 못했습니다"),
      h("p", {}, "새로고침해 보세요. 그래도 안 되면 " + NET_HINT))));
    return;
  }
  app.replaceChildren(h("main", { class: "narrow" }, h("section", { class: "card" },
    h("h1", {}, "아직 연결되지 않았습니다"),
    h("p", {}, "config.js 파일에 Supabase 주소(SUPABASE_URL)와 publishable 키(SUPABASE_KEY)를 넣어 주세요. 방법은 README.md에 있습니다."),
    h("p", { class: "muted small" }, "지금 읽은 주소: " + SUPABASE_URL),
    h("p", { class: "muted small" }, "주소는 https://(영문 소문자·숫자).supabase.co 모양이어야 합니다. 고친 뒤 GitHub에 다시 올렸다면 1~2분 뒤 Ctrl+F5로 새로고침하세요."))));
}

// 모든 화면 맨 아래에 만든 사람과 이용 조건을 보인다
document.addEventListener("DOMContentLoaded", () => {
  document.body.append(h("footer", { class: "credit" },
    "수업 응답 웹앱 · 만든 사람 ", h("strong", {}, CREDIT.name), " · © " + CREDIT.year + " · ",
    h("a", { href: "https://creativecommons.org/licenses/by-nc/4.0/deed.ko", target: "_blank", rel: "noopener noreferrer" }, "CC BY-NC 4.0"),
    " · 출처를 밝히면 수업에 자유롭게 쓰고 고칠 수 있습니다(판매 금지)"));
});
