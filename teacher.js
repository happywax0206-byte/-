// 교사 화면(버전 2): 로그인 → 수업 고르기 → [수업 진행] [질문·설문 만들기] [학생 관리] [수업 설정]
// 수업 진행·학생 관리 탭은 3초마다 응답을 다시 읽어 온다.

const app = document.getElementById("app");
const POLL_MS = 3000;

let lessons = [];
let lesson = null;        // 지금 고른 수업(없으면 새 수업 만들기)
let activities = [];
let students = [];
let responses = [];
let tab = localStorage.getItem("cra-tab") || "run";
let timer = null;
let editing = null;       // 만들기 탭에서 고치는 중인 활동(사본)
let main = null;
let me = null;            // 로그인한 교사(auth user)

if (!sb) notConfigured(app);
else init();

// ---------- 로그인 ----------
async function init() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return showLogin();
  me = data.session.user;
  const { data: ok, error } = await sb.rpc("is_teacher");
  if (error || !ok) {
    return app.replaceChildren(h("main", { class: "narrow" }, h("section", { class: "card stack" },
      h("h1", {}, "교사로 등록되지 않은 계정입니다"),
      h("p", {}, (me.email || "") + " 이메일이 teachers 표에 없습니다. setup.sql 맨 아래에 이 이메일을 넣고 다시 실행하세요."),
      error ? h("p", { class: "error" }, error.message) : null,
      h("button", { class: "ghost", type: "button", async onclick() { await sb.auth.signOut(); location.reload(); } }, "로그아웃"))));
  }
  await loadLessons(localStorage.getItem("cra-lesson"));
  document.addEventListener("keydown", (e) => {
    if (tab !== "run" || !lesson || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === "ArrowRight") setPage(lesson.page + 1);
    if (e.key === "ArrowLeft") setPage(lesson.page - 1);
  });
}

function showLogin() {
  const email = h("input", { type: "email", autocomplete: "username", required: true });
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  const msg = h("p", { class: "msg" });
  app.replaceChildren(h("main", { class: "narrow" },
    h("header", { class: "intro" }, h("p", { class: "eyebrow" }, "교사용"), h("h1", {}, "로그인")),
    h("form", {
      class: "card stack",
      async onsubmit(e) {
        e.preventDefault();
        msg.textContent = "로그인 중…";
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
        if (error) msg.textContent = "로그인하지 못했습니다: " + error.message;
        else init();
      },
    }, h("label", {}, "이메일", email), h("label", {}, "비밀번호", pw),
      h("button", { class: "primary big", type: "submit" }, "로그인"), msg),
    h("p", { class: "muted small center" }, "교사 계정은 Supabase 대시보드 → Authentication → Users 에서 만듭니다.")));
}

// 로그인한 교사의 비밀번호 바꾸기
function changePassword() {
  const pw = h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 8 });
  const again = h("input", { type: "password", autocomplete: "new-password", required: true });
  const msg = h("p", { class: "msg" });
  const btn = h("button", { class: "primary", type: "submit" }, "바꾸기");
  const close = openModal("비밀번호 바꾸기", h("form", {
    class: "stack",
    async onsubmit(e) {
      e.preventDefault();
      if (pw.value.length < 8) { msg.textContent = "8자 이상으로 정하세요."; return; }
      if (pw.value !== again.value) { msg.textContent = "두 칸의 비밀번호가 다릅니다."; return; }
      btn.disabled = true;
      msg.textContent = "바꾸는 중…";
      const { error } = await sb.auth.updateUser({ password: pw.value });
      btn.disabled = false;
      if (error) { msg.textContent = "바꾸지 못했습니다: " + error.message; return; }
      close();
      alert("비밀번호를 바꿨습니다. 다음 로그인부터 새 비밀번호를 쓰세요.");
    },
  }, h("label", {}, "새 비밀번호 (8자 이상)", pw), h("label", {}, "새 비밀번호 한 번 더", again), btn, msg));
  pw.focus();
}

// ---------- 데이터 ----------
async function loadLessons(selectId) {
  const { data, error } = await sb.from("lessons").select("*").order("created_at");
  if (error) return fatal(error);
  lessons = data;
  lesson = lessons.find((l) => l.id === selectId) || lessons[0] || null;
  if (!lesson) tab = "settings";
  await loadLesson();
}

async function loadLesson() {
  activities = [];
  students = [];
  responses = [];
  editing = null;
  if (lesson) {
    localStorage.setItem("cra-lesson", lesson.id);
    const { data, error } = await sb.from("activities").select("*").eq("lesson_id", lesson.id);
    if (error) return fatal(error);
    activities = sortActivities(data);
    await loadResponses();
    removeOrphanFiles().catch(() => {});
  }
  draw();
}

function sortActivities(list) {
  return list.slice().sort((x, y) => (x.page ?? 1e9) - (y.page ?? 1e9) || x.sort - y.sort || x.created_at.localeCompare(y.created_at));
}

// 전송량 줄이기: 몇 초마다 묻는 것(full=false)은 최근에 바뀐 응답만 받고, 30초마다·직접 부를 때는 전부 받는다.
// 쓰고 있는 답(live)은 「학생 화면」 탭에서만 받는다.
let respLesson = null;
let respFullAt = 0;
let respSince = 0;
let oldTeacherStudents = false;   // setup.sql을 아직 다시 실행하지 않았으면 예전 방식으로 부른다

async function loadResponses(full = true) {
  if (!lesson) return;
  // 이 수업에 들어온 학생(학생 계정은 웹앱 전체에 하나, 수업마다 참여 기록이 따로 있다)
  let st = await sb.rpc("teacher_students", oldTeacherStudents ? { p_lesson: lesson.id } : { p_lesson: lesson.id, p_live: tab === "live" });
  if (st.error && !oldTeacherStudents && /p_live|function/i.test(st.error.message || "")) {
    oldTeacherStudents = true;
    st = await sb.rpc("teacher_students", { p_lesson: lesson.id });
  }
  if (st.error) return fatal(st.error);
  students = (st.data || []).sort((x, y) => x.class_no.localeCompare(y.class_no, "ko", { numeric: true }) || x.name.localeCompare(y.name, "ko"));
  const ids = activities.map((a) => a.id);
  if (!ids.length) { responses = []; return; }
  if (full || respLesson !== lesson.id || Date.now() - respFullAt > 30000) {
    const rs = await sb.from("responses").select("*").in("activity_id", ids);
    if (rs.error) return fatal(rs.error);
    responses = rs.data;
    respLesson = lesson.id;
    respFullAt = Date.now();
  } else {
    // 늦게 저장이 끝난 것도 놓치지 않게 10초 앞부터 다시 받는다
    const since = new Date(Math.max(0, respSince - 10000)).toISOString();
    const rs = await sb.from("responses").select("*").in("activity_id", ids).gte("updated_at", since);
    if (rs.error) return fatal(rs.error);
    const key = (r) => r.student_id + " " + r.activity_id;
    const got = new Map(rs.data.map((r) => [key(r), r]));
    responses = responses.filter((r) => !got.has(key(r)) && ids.includes(r.activity_id)).concat(rs.data);
  }
  respSince = responses.reduce((m, r) => Math.max(m, Date.parse(r.updated_at) || 0), 0);
}

function schedule() {
  clearTimeout(timer);
  if (!lesson || (tab !== "run" && tab !== "students" && tab !== "live")) return;
  timer = setTimeout(async () => {
    await loadResponses(false);
    if (tab === "run") refreshRun();
    if (tab === "students") drawStudents();
    if (tab === "live") refreshLive();
    schedule();
  }, tab === "live" ? 2000 : POLL_MS);
}

function fatal(error) {
  console.error(error);
  const box = h("p", { class: "banner bad" }, "서버 오류: " + (error.message || error) + " · 새로고침해 보세요.");
  (main || app).prepend(box);
}

async function save(table, row, id) {
  const q = id ? sb.from(table).update(row).eq("id", id) : sb.from(table).insert(row);
  const { data, error } = await q.select();
  if (error) {
    alert("저장하지 못했습니다: " + error.message +
      (/page_to/.test(error.message) ? " · 여러 쪽에 걸친 질문을 쓰려면 Supabase SQL Editor에서 setup.sql을 한 번 실행하세요. 끝 쪽 칸을 비우면 지금도 저장됩니다." : "") +
      (/sim_box/.test(error.message) ? " · 「슬라이드 위 원하는 자리에」를 쓰려면 Supabase SQL Editor에서 setup.sql을 한 번 다시 실행하세요." : ""));
    return null;
  }
  return data[0];
}

const nameOf = (s) => s.class_no + " " + s.name;
const studentById = (id) => students.find((s) => s.id === id);
const docsOf = (a) => responses.filter((r) => r.activity_id === a.id && studentById(r.student_id))
  .map((r) => ({ name: nameOf(studentById(r.student_id)), answers: r.answers, r }));
const whereText = (a) => a.page == null ? "언제든" : a.page_to > a.page ? a.page + "~" + a.page_to + "쪽" : a.page + "쪽";

// ---------- 틀 ----------
function draw() {
  clearTimeout(timer);
  const pick = h("select", {
    "aria-label": "수업 고르기",
    async onchange() {
      if (pick.value === "new") { lesson = null; tab = "settings"; }
      else lesson = lessons.find((l) => l.id === pick.value);
      await loadLesson();
    },
  }, lessons.map((l) => h("option", { value: l.id, selected: lesson && l.id === lesson.id }, (l.kind === "survey" ? "[설문] " : "") + l.title + " (" + l.code + ")")),
    h("option", { value: "new", selected: !lesson }, "+ 새 수업 만들기"));
  const tabs = [["run", "수업 진행"], ["live", "학생 화면"], ["build", "질문·설문 만들기"], ["students", "학생 관리"], ["settings", "수업 설정"]];
  if (!tabs.some(([k]) => k === tab)) tab = "run";
  main = h("main", { class: "wide" });
  app.replaceChildren(
    h("header", { class: "top" },
      h("div", { class: "top-title" }, h("span", { class: "eyebrow" }, "교사용"), pick),
      h("nav", { class: "tabs" }, tabs.map(([k, label]) => h("button", {
        type: "button", class: tab === k ? "tab on" : "tab", disabled: !lesson && k !== "settings",
        async onclick() {
          const needLive = k === "live" && tab !== "live";
          tab = k; localStorage.setItem("cra-tab", k);
          if (needLive) await loadResponses();   // 다른 탭에서는 쓰고 있는 답을 받지 않았으므로 먼저 받는다
          draw();
        },
      }, label))),
      lesson ? h("button", { class: "ghost present-btn", type: "button", title: "학생에게 보여 줄 슬라이드만 새 탭에 띄웁니다", onclick: openPresent }, "▣ 수업 화면 띄우기") : null,
      lesson ? mirrorStatus : null,
      h("button", { class: "link", type: "button", onclick: changePassword }, "비밀번호 바꾸기"),
      h("button", { class: "link", type: "button", async onclick() { await sb.auth.signOut(); location.reload(); } }, "로그아웃")),
    main);
  setTopHeight();
  if (!lesson) tab = "settings";
  ({ run: drawRun, live: drawLive, build: drawBuild, students: drawStudents, settings: drawSettings })[tab]();
  schedule();
  updateMirror();
}

// 위쪽 막대 높이. 수업 진행 탭에서 슬라이드 칸이 스크롤해도 그 아래에 붙어 있게(CSS --top-h)
function setTopHeight() {
  const top = app.querySelector(".top");
  if (top) document.documentElement.style.setProperty("--top-h", top.offsetHeight + "px");
}
addEventListener("resize", setTopHeight);

// ---------- 수업 화면(학생에게 보여 줄 새 탭) ----------
// 「수업 화면 띄우기」로 연 present.html 탭에 지금 쪽·시뮬레이션·크게 띄운 것을 보낸다.
// BroadcastChannel은 같은 컴퓨터·같은 브라우저의 탭끼리만 주고받으므로 서버 사용량이 늘지 않는다.
const presentCh = window.BroadcastChannel ? new BroadcastChannel("cra-present") : null;
let presentOn = false;     // 수업 화면 탭이 열려 있는지
let presentWin = null;     // 수업 화면 창(조작 화면을 직접 넘겨줄 때 씀)
let presentShow = null;    // 수업 화면에 크게 띄운 것 { kind: "sim" | "view" | "link", title, html | url }
let presentShowEl = null;  // 교사 화면에서 그것이 보이는 칸(조작 화면을 잘라 보낼 곳)
let presentSent = "";
window.cra_attachPresent = (w) => { presentWin = w; };   // 수업 화면이 열리면 스스로 알려 온다

function openPresent() {
  if (!presentCh) return alert("이 브라우저에서는 수업 화면을 쓸 수 없습니다. Chrome이나 Edge를 쓰세요.");
  const win = window.open("present.html", "cra-present");
  if (!win) return alert("새 탭이 막혔습니다. 주소창 오른쪽의 팝업 차단 표시를 눌러 이 사이트를 허용하세요.");
  presentWin = win;
  captureDenied = false;   // 전에 화면 공유를 거절했어도 다시 물어본다
}

function presentState() {
  const L = lesson;
  return {
    lesson: L && { id: L.id, title: L.title, slide_dir: L.slide_dir, slide_count: L.slide_count, page: L.page, transition: L.transition },
    sims: L ? activities.filter((a) => a.kind === "sim").map((a) => ({ id: a.id, title: a.title, html: a.html, html_ver: a.html_ver,
      page: a.page, page_to: a.page_to, sim_full: a.sim_full, sim_box: a.sim_box })) : [],
    show: presentShow,
    mirror: mirrorOn,
    asking: !!captureAsking,
  };
}

// 바뀐 것이 있을 때만 보낸다
function sendPresent(force) {
  if (!presentCh) return;
  const s = JSON.stringify(presentState());
  if (!force && s === presentSent) return;
  presentSent = s;
  presentCh.postMessage({ type: "state", state: s });
}

if (presentCh) {
  presentCh.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === "hello") { presentOn = true; sendPresent(true); setMirrorEl(null); updateMirror(); }   // 수업 화면을 새로 열었으면 조작 화면도 다시 넘긴다
    if (m.type === "bye") { presentOn = false; updateMirror(); }
    if (m.type === "closed" && presentClose) presentClose();   // 수업 화면에서 Esc·닫기를 누르면 교사 화면에서도 닫는다
    if (m.type === "step" && lesson && lesson.slide_count) setPage(lesson.page + (m.step > 0 ? 1 : -1));   // 수업 화면에서 ← → 를 누름
  };
  presentCh.postMessage({ type: "who" });   // 이 탭을 새로 열었을 때 이미 열린 수업 화면이 있는지
}

let presentClose = null;
function setPresentShow(show, close, el) {
  presentShow = show;
  presentClose = show ? close || null : null;
  presentShowEl = show ? el || null : null;
  updateMirror();
}

// 크게 띄우기: 교사 화면에 띄우고 수업 화면에도 띄운다. 어느 쪽에서 닫아도 함께 닫힌다.
function bigSim(a) {
  const close = openSimFull(a.title, a.html, () => { if (presentShow && presentShow.kind === "sim") setPresentShow(null); });
  setPresentShow({ kind: "sim", title: a.title, html: a.html }, close, close.body);
}

function bigLink(url, title) {
  const close = openFull(title, linkFrame(url, title), () => { if (presentShow && presentShow.kind === "link") setPresentShow(null); },
    h("a", { class: "ghost-link", href: url, target: "_blank", rel: "noopener noreferrer" }, "새 탭에서 열기"));
  setPresentShow({ kind: "link", title, url }, close, close.body);
}

// 결과·학생·QR은 조작할 것이 없으므로 보이는 그대로 옮겨 적어 보낸다
function bigView(title, body) {
  const close = openModal(title, body, () => { if (presentShow && presentShow.kind === "view") setPresentShow(null); });
  setPresentShow({ kind: "view", title, html: snapshotHtml(body) }, close);
}

// 보이는 그대로 옮겨 적는다(학생 글은 h()가 글자로만 넣었으므로 옮겨도 안전하다). QR은 그림으로 바꾸고 누르는 단추는 뺀다.
function snapshotHtml(el) {
  const copy = el.cloneNode(true);
  const qrs = el.querySelectorAll(".qr");
  copy.querySelectorAll(".qr").forEach((q, i) => {
    const c = qrs[i].querySelector("canvas"), im = qrs[i].querySelector("img");
    let src = "";
    try { src = c ? c.toDataURL() : im ? im.src : ""; } catch (_) {}
    q.replaceChildren(src ? h("img", { src, alt: "QR" }) : "");
  });
  copy.querySelectorAll("button:not(.file-link)").forEach((b) => b.remove());
  return copy.outerHTML;
}

// 수업 진행 탭의 외부 링크: 수업 화면이 열려 있으면 교사 화면에 크게 띄우고 수업 화면에도 보낸다
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a || !presentOn || tab !== "run" || !main || !main.contains(a) || !/^https?:/i.test(a.href)) return;
  e.preventDefault();
  bigLink(a.href, a.textContent || a.href);
});

// ---------- 조작한 그대로 보내기 ----------
// 시뮬레이션·유튜브는 교사 화면과 수업 화면에 따로 떠 있어서 교사가 조작한 것이 수업 화면에 전해지지 않는다.
// 그래서 이 탭의 화면을 잡아(화면 공유 → 「이 탭」) 시뮬레이션·링크 칸만 잘라 내어(Element Capture)
// 수업 화면에 영상으로 넘긴다. 같은 컴퓨터의 창끼리 직접 넘기므로 인터넷으로 나가지 않는다. Chrome·Edge(컴퓨터)에서만 된다.
let capture = null;        // 이 탭 화면(MediaStream)
let captureAsking = null;  // 화면 공유를 묻는 중(Promise)
let captureDenied = false; // 거절함 → 「조작도 보내기」를 누를 때까지 다시 묻지 않는다
let mirrorEl = null;       // 지금 잘라 보내는 칸
let mirrorOn = null;       // 수업 화면에 영상으로 보이는 것 { mode: "show" | "stage" | "box" | "all", id }
let mirrorQueue = Promise.resolve();
const canMirror = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && (window.RestrictionTarget || window.CropTarget));
const captureTrack = () => { const t = capture && capture.getVideoTracks()[0]; return t && t.readyState === "live" ? t : null; };
const mirrorStatus = h("span", { class: "mirror-status" });

function ensureCapture() {
  if (captureTrack()) return Promise.resolve(true);
  if (!canMirror()) return Promise.resolve(false);
  if (!captureAsking) {
    captureAsking = navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false,
      preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude", monitorTypeSurfaces: "exclude" })
      .then((s) => {
        const t = s.getVideoTracks()[0];
        if (!t || t.getSettings().displaySurface !== "browser") {
          s.getTracks().forEach((x) => x.stop());
          alert("「이 탭」을 골라야 합니다. 위쪽의 「조작도 보내기」를 눌러 다시 고르세요.");
          captureDenied = true;
          return false;
        }
        // 크롬 위쪽의 「공유 중지」를 누르면 수업 화면은 따로 띄운 사본으로 돌아간다
        t.addEventListener("ended", () => { capture = null; setMirrorEl(null); updateMirror(); });
        capture = s;
        return true;
      }, () => { captureDenied = true; return false; })
      .finally(() => { captureAsking = null; drawMirrorStatus(); });
    drawMirrorStatus();
  }
  return captureAsking;
}

// 지금 잘라 보낼 칸: 크게 띄운 것 > 슬라이드 대신 크게 띄운 시뮬레이션 > 슬라이드 위 시뮬레이션(하나면 그 칸, 여럿이면 슬라이드 전체)
function mirrorTarget() {
  if (presentShowEl && presentShowEl.isConnected) return { el: presentShowEl, mode: "show" };
  if (presentShow || tab !== "run" || !run || !lesson || !lesson.slide_count || !run.stage.isConnected) return null;
  if (!run.simStage.hidden && run.simStage.firstChild) return { el: run.simStage, mode: "stage" };
  const boxes = [...run.simLayer.children];
  if (boxes.length === 1) return { el: boxes[0], mode: "box", id: boxes[0]._id };
  if (boxes.length > 1) return { el: run.stage, mode: "all" };
  return null;
}

// 무엇을 보낼지 다시 정하고 수업 화면에 알린다. 차례대로 하나씩 처리한다.
function updateMirror() {
  mirrorQueue = mirrorQueue.then(async () => {
    const want = presentOn && presentWin && !presentWin.closed ? mirrorTarget() : null;
    if (!want) { mirrorOn = null; return; }
    if (!captureTrack()) {
      mirrorOn = null;
      if (captureDenied || !canMirror()) return;
      sendPresent();   // 묻는 동안에도 쪽은 넘어가게 먼저 보낸다
      if (await ensureCapture()) updateMirror();   // 허락을 받는 사이 칸이 바뀌었을 수 있으므로 이 차례가 끝난 뒤 처음부터 다시
      return;
    }
    const t = captureTrack();
    if (want.el !== mirrorEl) {
      try {
        if (window.RestrictionTarget) await t.restrictTo(await RestrictionTarget.fromElement(want.el));
        else await t.cropTo(await CropTarget.fromElement(want.el));
        setMirrorEl(want.el);
      } catch (err) {
        // 쪽을 넘기는 중이라 칸이 아직 그려지지 않았을 때 등. 잠시 뒤 다시 해 본다(같은 칸에 몇 번까지만)
        console.warn("잘라 보내기 실패", err);
        setMirrorEl(null); mirrorOn = null;
        mirrorRetry = mirrorRetryEl === want.el ? mirrorRetry + 1 : 1;
        mirrorRetryEl = want.el;
        if (mirrorRetry <= 5) setTimeout(updateMirror, 400);
        return;
      }
    }
    try { presentWin.cra_stream(capture); } catch (_) { mirrorOn = null; return; }
    mirrorOn = { mode: want.mode, id: want.id || null, frozen: !mirrorSeen };
  }).catch((err) => { console.warn(err); mirrorOn = null; }).then(() => { if (!mirrorOn) setMirrorEl(null); sendPresent(); drawMirrorStatus(); });
}

// 잘라 보내는 칸 표시: 모서리를 둥글게 깎거나 그림자를 두면 잘라 낸 영상의 모서리·가장자리가 검게 나오므로 그동안은 네모로 둔다.
// 화면 잘라 보내기는 실제로 화면에 보이는 부분만 잡을 수 있어서, 스크롤로 칸이 화면 밖으로 나가면
// 수업 화면은 마지막 장면에서 멈춰 둔다(frozen). 다시 보이면 이어서 보인다.
let mirrorSeen = true;
let mirrorRetry = 0, mirrorRetryEl = null;
const mirrorIO = window.IntersectionObserver ? new IntersectionObserver((entries) => {
  const seen = entries[entries.length - 1].intersectionRatio > 0.97;
  if (seen === mirrorSeen) return;
  mirrorSeen = seen;
  if (mirrorOn) { mirrorOn = { ...mirrorOn, frozen: !seen }; sendPresent(); }
}, { threshold: [0, 0.5, 0.97, 1] }) : null;

function setMirrorEl(el) {
  if (el === mirrorEl) return;
  if (mirrorEl) mirrorEl.classList.remove("mirroring");
  mirrorEl = el;
  if (mirrorIO) mirrorIO.disconnect();
  mirrorSeen = true;
  if (el) { el.classList.add("mirroring"); if (mirrorIO) mirrorIO.observe(el); }
}

// 위쪽 막대: 수업 화면이 열려 있을 때 조작을 보내는 중인지 보이고, 꺼져 있으면 켜는 단추
function drawMirrorStatus() {
  requestAnimationFrame(setTopHeight);   // 단추 글자가 바뀌어 위쪽 막대 높이가 달라질 수 있다
  mirrorStatus.hidden = !presentOn || !canMirror();
  if (mirrorStatus.hidden) return;
  if (captureTrack()) mirrorStatus.replaceChildren(h("span", { class: "pill on", title: "시뮬레이션·링크에서 조작한 것이 수업 화면에 그대로 보입니다. 끄려면 크롬 위쪽의 「공유 중지」를 누르세요." }, "● 조작 보내는 중"));
  else if (captureAsking) mirrorStatus.replaceChildren(h("span", { class: "pill" }, "화면 공유를 허용해 주세요…"));
  else mirrorStatus.replaceChildren(h("button", { class: "ghost present-btn", type: "button",
    title: "시뮬레이션·유튜브를 이 화면에서 조작한 그대로 수업 화면에 보냅니다. 「이 탭」 공유를 허용하세요.",
    onclick() { captureDenied = false; ensureCapture().then(updateMirror); } }, "조작도 보내기"));
}


// ---------- 수업 진행 ----------
let run = null;

function drawRun() {
  const img = h("img", { class: "slide", alt: "" });
  const where = h("span", { class: "where" });
  const prev = h("button", { class: "ghost", type: "button", onclick() { setPage(lesson.page - 1); } }, "◀ 이전");
  const next = h("button", { class: "primary", type: "button", onclick() { setPage(lesson.page + 1); } }, "다음 ▶");
  const openBtn = h("button", { type: "button", onclick() { setLesson({ open: !lesson.open }); } });
  const openText = h("span", {});
  const simStage = h("div", { class: "sim-stage", hidden: true });
  const simLayer = slideLayer(img);
  const stage = h("div", { class: "stage" }, img, simLayer, simStage);
  const panel = h("div", { class: "stack" });
  const roster = h("section", { class: "card stack" });
  const hasSlides = lesson.slide_count > 0;
  main.replaceChildren(h("div", { class: "run" },
    h("div", { class: "run-left stack" },
      hasSlides ? stage : h("p", { class: "card muted" }, lesson.kind === "survey" ? "설문 전용입니다. 학생 화면에는 모든 설문이 보입니다." : "슬라이드가 없는 수업입니다. 학생 화면에는 모든 활동이 보입니다."),
      hasSlides ? h("nav", { class: "pager" }, prev, where, next, h("span", { class: "spacer" }),
        h("button", { class: "ghost", type: "button", onclick() { if (stage.requestFullscreen) stage.requestFullscreen(); } }, "전체 화면"),
        h("button", { class: "ghost", type: "button", onclick: openPresent }, "수업 화면 띄우기")) : null,
      h("div", { class: "row" },
        h("button", { class: "ghost", type: "button", onclick: showJoin }, "학생 접속 주소·QR"),
        h("button", { class: "ghost", type: "button", onclick() { downloadCSV(activities, lesson.code + "_전체응답"); } }, "전체 응답 CSV")),
      hasSlides ? h("p", { class: "muted small" }, "학생 화면은 여기서 띄운 쪽을 따라갑니다. 키보드 ← → 로도 넘길 수 있습니다. 「수업 화면 띄우기」는 슬라이드만 새 탭에 띄웁니다(그 탭을 프로젝터 화면으로 옮겨 쓰세요). 여기서 시뮬레이션이나 결과를 크게 띄우거나 링크를 누르면 수업 화면에도 바로 보입니다. 화면 공유(「이 탭」)를 허용하면 시뮬레이션·유튜브를 여기서 조작한 그대로 수업 화면에 보입니다.") : null),
    h("aside", { class: "run-right stack" },
      h("section", { class: "card row between" }, openText, openBtn),
      roster,
      panel)));
  run = { img, stage, simStage, simLayer, simKey: "", where, prev, next, openBtn, openText, panel, roster, blocks: new Map() };
  refreshRun();
}

function refreshRun() {
  if (!run) return;
  const L = lesson;
  const shown = activities.filter((a) => L.slide_count === 0 || onPage(a, L.page) || a.page == null);
  // 「슬라이드 자리에 띄우기」 시뮬레이션: 교사 화면에서도 슬라이드 대신 띄운다(다시 그릴 때마다 새로 띄우지 않게 key로 확인)
  const stageSim = L.slide_count > 0 ? shown.find((a) => a.kind === "sim" && a.sim_full && onPage(a, L.page)) : null;
  if (L.slide_count > 0) {
    // 화면 넘김 효과: 앞으로 가면 그 쪽의 효과, 뒤로 가면 떠나는 쪽의 효과를 거꾸로
    const dir = run.shownPage && L.page < run.shownPage ? -1 : 1;
    changeSlide(run.img, slideSrc(L, L.page), stageSim || run.shownPage === L.page ? null : transitionFor(L, dir > 0 ? L.page : run.shownPage), dir, [run.simLayer]);
    run.shownPage = L.page;
    run.img.alt = "슬라이드 " + L.page;
    run.where.textContent = L.page + " / " + L.slide_count;
    run.prev.disabled = L.page <= 1;
    run.next.disabled = L.page >= L.slide_count;
    if (L.page < L.slide_count) new Image().src = slideSrc(L, L.page + 1);
  }
  run.openText.replaceChildren(h("strong", {}, L.open ? "제출 받는 중" : "제출 닫힘"),
    h("span", { class: "muted small" }, " · 입장 " + students.length + "명"));
  run.openBtn.className = L.open ? "ghost" : "primary";
  run.openBtn.textContent = L.open ? "제출 마감" : "제출 열기";

  const simKey = stageSim ? stageSim.id + ":" + (stageSim.html || "").length + ":" + stageSim.title : "";
  run.img.hidden = !!stageSim;
  run.simStage.hidden = !stageSim;
  if (simKey !== run.simKey) {
    run.simKey = simKey;
    run.simStage.replaceChildren(...(stageSim ? [simFrame(stageSim.html, stageSim.title)] : []));
  }
  // 슬라이드 위 정한 자리에 얹는 시뮬레이션
  const boxed = L.slide_count > 0 && !stageSim ? shown.filter((a) => a.kind === "sim" && !a.sim_full && validSimBox(a.sim_box) && onPage(a, L.page)) : [];
  showSimBoxes(run.simLayer, boxed, (a) => a.html, bigSim);
  drawRoster(shown.filter((a) => a.kind !== "sim"));
  run.panel.replaceChildren(...(shown.length ? shown.map(runBlock)
    : [h("p", { class: "card muted" }, L.page + "쪽에는 활동이 없습니다. 「질문·설문 만들기」에서 추가하세요.")]));
  updateMirror();
}

// 접속한 학생: 초록 = 지금 화면을 열어 둔 학생(20초 안에 서버에 물어봄), ✓ = 이 쪽 활동에 답함
const ONLINE_MS = 20000;
function rosterChips(shown, big) {
  const now = Date.now();
  const ids = new Set(shown.map((a) => a.id));
  return h("div", { class: "roster" + (big ? " big" : "") }, students.map((s) => {
    const on = s.last_seen && now - Date.parse(s.last_seen) < ONLINE_MS;
    const done = shown.length && responses.some((r) => r.student_id === s.id && ids.has(r.activity_id));
    return h("span", { class: "chip" + (on ? " on" : "") + (done ? " done" : ""), title: on ? "접속 중" : "접속 끊김" }, nameOf(s));
  }));
}

function drawRoster(shown) {
  const now = Date.now();
  const online = students.filter((s) => s.last_seen && now - Date.parse(s.last_seen) < ONLINE_MS).length;
  run.roster.replaceChildren(
    h("div", { class: "row between" },
      h("h2", {}, "접속 중 " + online + "명", h("span", { class: "muted small" }, " · 입장 " + students.length + "명")),
      h("button", { class: "ghost", type: "button", onclick() { bigView("입장한 학생", rosterChips(shown, true)); } }, "크게 보기")),
    students.length ? rosterChips(shown) : h("p", { class: "muted small" }, "아직 입장한 학생이 없습니다."),
    students.length ? h("p", { class: "muted small" }, "초록색: 지금 접속 중 · ✓: " + (lesson.slide_count ? "이 쪽" : "") + " 활동에 답함") : h("span", {}));
}

function runBlock(a) {
  if (a.kind === "sim") return h("section", { class: "card stack" },
    h("div", { class: "row between" },
      h("div", {}, h("p", { class: "muted small" }, "시뮬레이션 · " + whereText(a)), h("h2", {}, a.title)),
      h("button", { class: "primary", type: "button", onclick() { bigSim(a); } }, "크게 실행")),
    h("p", { class: "pill" }, !lesson.slide_count ? "학생 화면: 카드로 보임"
      : a.sim_full ? "학생 화면: 슬라이드 대신 크게 보임"
      : validSimBox(a.sim_box) ? "학생 화면: 슬라이드 위 정한 자리에 보임" : "학생 화면: 슬라이드 아래 카드로 보임"));
  if (isInfoActivity(a)) return h("section", { class: "card stack" },
    h("div", { class: "row between" },
      h("div", {}, h("p", { class: "muted small" }, "설명 카드 · " + whereText(a)), h("h2", {}, a.title)),
      h("button", { type: "button", class: a.shared ? "ghost" : "primary", async onclick() { await setActivity(a, { shared: !a.shared }); } }, a.shared ? "공개 끝내기" : "학생에게 공개")),
    h("p", { class: a.shared ? "pill on" : "pill" }, a.shared ? "학생에게 공개 중" : "학생에게는 보이지 않음"),
    linkedDescription(a.questions[0].text));
  const docs = docsOf(a);
  const scored = docs.filter((d) => d.r.total);
  const avg = scored.length ? (scored.reduce((s, d) => s + d.r.score / d.r.total, 0) / scored.length * 100).toFixed(0) + "점" : null;
  return h("section", { class: "card stack" },
    h("div", { class: "row between" },
      h("div", {},
        h("p", { class: "muted small" }, KIND_NAME[a.kind] + " · " + whereText(a)),
        h("h2", {}, a.title)),
      h("button", {
        type: "button", class: a.shared ? "ghost" : "primary",
        async onclick() { await setActivity(a, { shared: !a.shared }); },
      }, a.shared ? "공개 끝내기" : "학생에게 공개")),
    h("p", { class: a.shared ? "pill on" : "pill" }, a.shared ? "학생에게 공개 중 (" + (a.named ? "이름과 함께" : "이름 없이") + ")" : "학생에게는 보이지 않음"),
    h("p", { class: "muted small" }, "응답 " + docs.length + " / " + students.length + "명" + (avg ? " · 평균 " + avg : "")),
    summaryView(a.questions, docs, { openFile }),
    h("div", { class: "row" },
      h("button", { class: "ghost", type: "button", onclick() { bigView(a.title, h("div", { class: "big-view" }, summaryView(a.questions, docsOf(a), { openFile }))); } }, "크게 보기"),
      h("button", { class: "ghost", type: "button", onclick() { openModal(a.title + " · 학생별", responseTable(a)); } }, "학생별 표"),
      h("button", { class: "ghost", type: "button", onclick() { downloadCSV([a], lesson.code + "_" + a.title); } }, "CSV")));
}

function responseTable(a) {
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "학번"), h("th", {}, "이름"), a.kind === "quiz" ? h("th", {}, "점수") : null,
      a.questions.map((q, i) => h("th", {}, (i + 1) + ". " + q.text)), h("th", {}, "저장"))),
    h("tbody", {}, students.map((s) => {
      const r = responses.find((x) => x.activity_id === a.id && x.student_id === s.id);
      return h("tr", { class: r ? "" : "missing" }, h("td", {}, s.class_no), h("td", {}, s.name),
        a.kind === "quiz" ? h("td", {}, r && r.total ? r.score + "/" + r.total : "") : null,
        a.questions.map((q) => h("td", {}, !r ? "" : q.type === "file" ? fileLinks(r.answers[q.id], openFile) : answerText(r.answers[q.id]))),
        h("td", {}, r ? fmtTime(r.updated_at) : "미제출"));
    }))));
}

async function setPage(n) {
  n = Math.min(Math.max(n, 1), Math.max(lesson.slide_count, 1));
  if (n === lesson.page) return;
  await setLesson({ page: n });
}

async function setLesson(change) {
  Object.assign(lesson, change);
  refreshRun();
  const { error } = await sb.from("lessons").update(change).eq("id", lesson.id);
  if (error) fatal(error);
}

async function setActivity(a, change) {
  Object.assign(a, change);
  refreshRun();
  const { error } = await sb.from("activities").update(change).eq("id", a.id);
  if (error) fatal(error);
}

function joinUrl(l) {
  return new URL("index.html?c=" + encodeURIComponent(l.code), location.href).href;
}

function showJoin() {
  const url = joinUrl(lesson);
  const qr = h("div", { class: "qr" });
  const body = h("div", { class: "join" }, qr,
    h("div", { class: "stack" },
      h("p", { class: "join-code" }, "수업 코드 ", h("strong", {}, lesson.code)),
      h("p", { class: "join-url" }, url),
      h("button", { class: "ghost", type: "button", onclick(e) { navigator.clipboard.writeText(url).then(() => { e.target.textContent = "복사했습니다"; }); } }, "주소 복사")));
  if (window.QRCode) new QRCode(qr, { text: url, width: 320, height: 320 });
  else qr.textContent = "QR을 만들지 못했습니다(인터넷 연결 확인).";
  bigView("학생 접속", body);
}

// ---------- 질문·설문 만들기 ----------
const newId = () => Math.random().toString(36).slice(2, 8);
const newQuestion = (type) => ({ id: newId(), type: type || "choice", text: "", options: ["", ""] });

// 활동 목록: 손잡이(⋮⋮)를 끌어 순서를 바꾼다. 활동은 쪽 순서로 보이므로 같은 쪽(시작 쪽) 안에서만 옮긴다.
let dragId = null;
let moving = false;

function activityList() {
  if (!activities.length) return h("p", { class: "muted small" }, "아직 활동이 없습니다.");
  const pageOf = (a) => a.page ?? null;
  const clearMarks = () => document.querySelectorAll(".act-row.drop-before, .act-row.drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
  let after = false;
  const row = (a) => h("div", {
    class: "act-row", draggable: "true",
    ondragstart(ev) {
      if (moving) return ev.preventDefault();
      dragId = a.id;
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", a.id);
      ev.currentTarget.classList.add("dragging");
    },
    ondragend(ev) { dragId = null; ev.currentTarget.classList.remove("dragging"); clearMarks(); },
    ondragover(ev) {
      const d = activities.find((x) => x.id === dragId);
      if (!d || d.id === a.id || pageOf(d) !== pageOf(a)) return;
      ev.preventDefault();
      const r = ev.currentTarget.getBoundingClientRect();
      after = ev.clientY > r.top + r.height / 2;
      clearMarks();
      ev.currentTarget.classList.add(after ? "drop-after" : "drop-before");
    },
    ondrop(ev) { ev.preventDefault(); clearMarks(); if (dragId) moveActivity(dragId, a.id, after); },
  },
    h("span", { class: "drag-handle", title: "끌어서 순서 바꾸기", "aria-hidden": "true" }, "⋮⋮"),
    h("button", {
      type: "button", class: "act-item" + (editing && editing.id === a.id ? " on" : ""),
      onclick() { editing = JSON.parse(JSON.stringify(a)); drawBuild(); },
    }, h("span", { class: "muted small" }, activityName(a) + " · " + whereText(a)), h("span", {}, a.title)));
  // 쪽마다 묶어서 보인다(슬라이드 수업)
  const groups = [];
  for (const a of activities) {
    const g = groups[groups.length - 1];
    if (g && g.page === pageOf(a)) g.items.push(a);
    else groups.push({ page: pageOf(a), items: [a] });
  }
  const showHeads = lesson.slide_count > 0 && groups.some((g) => g.page != null);
  return h("div", { class: "stack" },
    groups.map((g) => [showHeads ? h("p", { class: "act-group-head" }, g.page == null ? "언제든" : g.page + "쪽") : null, g.items.map(row)]),
    activities.length > 1 ? h("p", { class: "muted small" }, showHeads ? "⋮⋮를 끌어 같은 쪽 안에서 순서를 바꿉니다. 다른 쪽으로 옮기려면 활동을 열어 「어디에 보일까요?」를 바꾸세요." : "⋮⋮를 끌어 순서를 바꿉니다.") : null);
}

async function moveActivity(fromId, toId, after) {
  const from = activities.find((x) => x.id === fromId);
  if (!from || moving) return;
  const group = activities.filter((x) => (x.page ?? null) === (from.page ?? null));
  const order = group.filter((x) => x !== from);
  const at = order.findIndex((x) => x.id === toId);
  if (at < 0) return;
  order.splice(at + (after ? 1 : 0), 0, from);
  if (order.every((x, k) => x === group[k])) return;
  const changed = order.map((x, k) => [x, k]).filter(([x, k]) => x.sort !== k);
  changed.forEach(([x, k]) => { x.sort = k; });
  activities = sortActivities(activities);
  drawBuild();
  moving = true;
  const results = await Promise.all(changed.map(([x, k]) => sb.from("activities").update({ sort: k }).eq("id", x.id)));
  moving = false;
  const bad = results.find((r) => r.error);
  if (bad) {
    alert("순서를 저장하지 못했습니다: " + bad.error.message);
    const { data } = await sb.from("activities").select("*").eq("lesson_id", lesson.id);
    if (data) activities = sortActivities(data);
    drawBuild();
  } else flash("순서를 바꿨습니다.");
}

function drawBuild() {
  const list = activityList();
  const kindList = lesson.kind === "survey" ? { survey: "정답 없는 설문", quiz: "정답·자동 채점" } : { slide: "쪽 아래에 붙는 질문", survey: "정답 없는 설문", quiz: "정답·자동 채점" };
  const kinds = h("div", { class: "kinds" }, Object.entries(kindList).map(([k, sub]) =>
    h("button", {
      type: "button", class: "kind",
      onclick() {
        editing = { kind: k, title: "", page: lesson.slide_count ? lesson.page : null, show_answer: true, named: false, shared: false, questions: [newQuestion(k === "survey" ? "long" : "choice")] };
        drawBuild();
      },
    }, h("strong", {}, KIND_NAME[k]), h("span", {}, sub))),
    h("button", { type: "button", class: "kind", onclick() {
      editing = { kind: "survey", title: "", page: lesson.slide_count ? lesson.page : null, show_answer: false, named: false, shared: false,
        questions: [{ id: newId(), type: "info", text: "" }] };
      drawBuild();
    } }, h("strong", {}, "설명 카드"), h("span", {}, "글과 외부 링크만 표시")),
    h("button", { type: "button", class: "kind", onclick() {
      editing = { kind: "sim", title: "", page: lesson.slide_count ? lesson.page : null, sim_full: false, sim_box: null, html: "", questions: [] };
      drawBuild();
    } }, h("strong", {}, "시뮬레이션"), h("span", {}, "html 파일을 슬라이드 사이에")));
  main.replaceChildren(h("div", { class: "build" },
    h("aside", { class: "stack" },
      h("section", { class: "card stack" }, h("h2", {}, "새로 만들기"), kinds),
      h("section", { class: "card stack" }, h("h2", {}, "이 수업의 활동"), list)),
    editing ? editor() : h("section", { class: "card muted" }, "왼쪽에서 새로 만들거나, 고칠 활동을 고르세요.")));
}

// 편집 화면의 자리 정하기: 그 쪽 슬라이드 위에 시뮬레이션 상자를 놓고, 끌어서 옮기거나 오른쪽 아래 모서리로 크기를 바꾼다.
// 상자 안에는 실제 시뮬레이션이 수업 때와 같은 비율로 보인다(조작은 막아 둠).
function simPlacer(e, getHtml) {
  const img = h("img", { class: "slide", alt: "", draggable: "false" });
  const layer = slideLayer(img, "place-layer");
  const box = simBoxEl({ id: "edit", title: e.title || "시뮬레이션" }, e.sim_box, null);
  box.classList.add("place-box");
  const cover = h("div", { class: "place-cover" }, h("span", { class: "place-label" }, "시뮬레이션"), h("span", { class: "place-handle", title: "끌어서 크기 조절" }));
  box.append(cover);
  layer.append(box);
  const MIN = 0.08;
  const clamp = () => {
    const b = e.sim_box;
    b.w = Math.min(Math.max(b.w, MIN), 1);
    b.h = Math.min(Math.max(b.h, MIN), 1);
    b.x = Math.min(Math.max(b.x, 0), 1 - b.w);
    b.y = Math.min(Math.max(b.y, 0), 1 - b.h);
  };
  cover.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const resize = ev.target.classList.contains("place-handle");
    const r = layer.getBoundingClientRect();
    const start = Object.assign({}, e.sim_box);
    const x0 = ev.clientX, y0 = ev.clientY;
    cover.setPointerCapture(ev.pointerId);
    const move = (m) => {
      const dx = (m.clientX - x0) / r.width, dy = (m.clientY - y0) / r.height;
      const b = e.sim_box;
      if (resize) { b.w = Math.min(start.w + dx, 1 - b.x); b.h = Math.min(start.h + dy, 1 - b.y); }
      else { b.x = start.x + dx; b.y = start.y + dy; }
      clamp();
      layer.relayout();
    };
    const up = () => {
      cover.removeEventListener("pointermove", move);
      cover.removeEventListener("pointerup", up);
      cover.removeEventListener("pointercancel", up);
    };
    cover.addEventListener("pointermove", move);
    cover.addEventListener("pointerup", up);
    cover.addEventListener("pointercancel", up);
  });
  const setPage = (n) => { img.src = slideSrc(lesson, Math.min(Math.max(n || 1, 1), Math.max(lesson.slide_count, 1))); };
  const loadHtml = () => {
    const html = getHtml();
    box._frame.srcdoc = (html || "").trim() ? html : "<p style='font:24px sans-serif;padding:1em;color:#64748b'>html을 넣으면 여기에 미리 보입니다.</p>";
  };
  if (lesson.slide_count) setPage(e.page ?? lesson.page);
  if (e.mode === "box") loadHtml();
  return { el: h("div", { class: "place-wrap" }, img, layer), setPage, loadHtml, redraw: () => layer.relayout() };
}

function simEditor() {
  const e = editing;
  const msg = h("p", { class: "error" });
  const title = h("input", { type: "text", maxlength: 100, value: e.title, placeholder: "예: 열의 전도 시뮬레이션", oninput() { e.title = title.value; } });
  const code = h("textarea", { rows: 8, class: "mono", spellcheck: "false", placeholder: "<!DOCTYPE html> 로 시작하는 코드를 통째로 붙여넣거나, 위에서 html 파일을 고르세요.", oninput() { e.html = code.value; size.textContent = sizeText(); } }, e.html || "");
  const sizeText = () => (e.html ? (e.html.length / 1000).toFixed(0) + "천 자 / 최대 500천 자" : "");
  const size = h("span", { class: "muted small" }, sizeText());
  const file = h("input", { type: "file", accept: ".html,.htm,text/html", async onchange() {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 2000000) { msg.textContent = "파일이 너무 큽니다. html 파일 하나로 된 시뮬레이션만 올릴 수 있습니다."; return; }
    e.html = await f.text();
    code.value = e.html;
    if (e.mode === "box") place.loadHtml();
    size.textContent = sizeText();
    if (!e.title.trim()) { e.title = f.name.replace(/\.html?$/i, ""); title.value = e.title; }
    msg.textContent = "";
  } });
  const pageIn = h("input", { type: "number", min: 1, max: Math.max(lesson.slide_count, 1), value: e.page ?? lesson.page, class: "num", "aria-label": "시작 쪽", oninput() { e.page = parseInt(pageIn.value, 10) || 1; place.setPage(e.page); } });
  const pageToIn = h("input", { type: "number", min: 1, max: Math.max(lesson.slide_count, 1), value: e.page_to > e.page ? e.page_to : "", placeholder: "(한 쪽만)", class: "num", "aria-label": "끝 쪽", oninput() { e.page_to = parseInt(pageToIn.value, 10) || null; } });

  // 보일 자리: 슬라이드 아래 카드(기본) / 슬라이드 위 정한 자리 / 슬라이드 대신 크게
  if (!e.mode) e.mode = e.sim_full ? "full" : validSimBox(e.sim_box) ? "box" : "below";
  if (!validSimBox(e.sim_box)) e.sim_box = { x: 0.5, y: 0.2, w: 0.45, h: 0.6 };
  const place = simPlacer(e, () => e.html);
  const placeBox = h("div", { class: "stack", hidden: e.mode !== "box" },
    h("p", { class: "muted small" }, "파란 상자를 끌어서 옮기고, 오른쪽 아래 모서리를 끌어서 크기를 조절하세요. 교사·학생 화면 모두 이 자리에 같은 비율로 보입니다. 학생은 상자의 ⤢ 단추로 크게 볼 수 있습니다."),
    place.el,
    h("div", { class: "row" },
      h("button", { class: "ghost", type: "button", onclick() { Object.assign(e.sim_box, { x: 0.5, y: 0.2, w: 0.45, h: 0.6 }); place.redraw(); } }, "오른쪽 절반으로"),
      h("button", { class: "ghost", type: "button", onclick() { Object.assign(e.sim_box, { x: 0.05, y: 0.55, w: 0.9, h: 0.42 }); place.redraw(); } }, "아래쪽 넓게"),
      h("button", { class: "ghost", type: "button", onclick() { place.loadHtml(); } }, "상자 안 미리보기 새로고침")));
  const modes = h("fieldset", { class: "place-modes" }, h("legend", {}, "슬라이드와 함께 어떻게 보일까요?"),
    [["below", "슬라이드 아래에 카드로 (기본)"], ["box", "슬라이드 위 원하는 자리에 (끌어서 위치·크기 조절)"], ["full", "슬라이드 대신 화면 가득"]].map(([k, text]) =>
      h("label", { class: "option" }, h("input", { type: "radio", name: "sim-mode", checked: e.mode === k, onchange() {
        e.mode = k;
        placeBox.hidden = k !== "box";
        if (k === "box") { place.setPage(e.page ?? lesson.page); place.loadHtml(); }
      } }), h("span", {}, text))));

  async function saveSim() {
    e.title = e.title.trim();
    if (!e.title) { msg.textContent = "제목을 입력하세요."; return; }
    if (!(e.html || "").trim()) { msg.textContent = "html 파일을 고르거나 코드를 붙여넣으세요."; return; }
    if (e.html.length > 500000) { msg.textContent = "코드가 너무 깁니다(최대 50만 자)."; return; }
    const slides = lesson.slide_count > 0;
    const row = { kind: "sim", title: e.title, page: slides ? e.page : null, html: e.html, sim_full: slides && e.mode === "full", show_answer: false, named: false, questions: [] };
    // sim_box 칸은 setup.sql을 다시 실행해야 생긴다. 칸이 없는 데이터베이스에서도 다른 방식은 저장되도록 필요할 때만 보낸다
    const boxNow = slides && e.mode === "box";
    const hasBoxCol = activities.some((x) => "sim_box" in x);
    if (boxNow && activities.length && !hasBoxCol) {
      msg.textContent = "「슬라이드 위 원하는 자리에」를 쓰려면 먼저 Supabase SQL Editor에서 setup.sql을 한 번 다시 실행해야 합니다. 다른 방식은 지금도 저장됩니다.";
      return;
    }
    if (boxNow || hasBoxCol) {
      const b = e.sim_box;
      row.sim_box = boxNow ? { x: +b.x.toFixed(4), y: +b.y.toFixed(4), w: +b.w.toFixed(4), h: +b.h.toFixed(4) } : null;
    }
    const to = row.page != null && e.page_to > row.page ? Math.min(e.page_to, lesson.slide_count) : null;
    if (to != null || activities.some((x) => "page_to" in x)) row.page_to = to;
    if (!e.id) { row.lesson_id = lesson.id; row.sort = activities.length; }
    const saved = await save("activities", row, e.id);
    if (!saved) return;
    const { data } = await sb.from("activities").select("*").eq("lesson_id", lesson.id);
    activities = sortActivities(data || []);
    editing = JSON.parse(JSON.stringify(saved));
    drawBuild();
    flash("저장했습니다.");
  }
  return h("section", { class: "card stack editor" },
    h("h2", {}, e.id ? "시뮬레이션 고치기" : "시뮬레이션 넣기"),
    h("label", {}, "제목", title),
    h("label", {}, "html 파일 올리기", file),
    h("label", {}, "또는 코드 붙여넣기", code), size,
    lesson.slide_count ? h("div", { class: "row wrap" },
      h("label", {}, "어디에 넣을까요?", h("div", { class: "row" }, pageIn, h("span", {}, "쪽부터"), pageToIn, h("span", {}, "쪽까지")))) : null,
    lesson.slide_count ? modes : null,
    lesson.slide_count ? placeBox : null,
    lesson.slide_count ? h("p", { class: "muted small" }, "슬라이드 사이에 애니메이션 쪽을 따로 끼우려면 「수업 설정 → 애니메이션 슬라이드 끝에 추가」를 쓰세요.") : null,
    h("p", { class: "muted small" }, "시뮬레이션은 격리된 칸에서 실행되어 이 웹앱의 로그인 정보에 접근할 수 없습니다. 학생은 이 카드에 답을 입력하지 않습니다."),
    msg,
    h("div", { class: "row between" },
      e.id ? h("button", { class: "ghost danger", type: "button", async onclick() {
        if (!confirm("「" + e.title + "」 시뮬레이션을 지울까요?")) return;
        const { error } = await sb.from("activities").delete().eq("id", e.id);
        if (error) { msg.textContent = error.message; return; }
        activities = activities.filter((a) => a.id !== e.id); editing = null; drawBuild();
      } }, "지우기") : h("span", {}),
      h("div", { class: "row" },
        h("button", { class: "ghost", type: "button", onclick() { if ((e.html || "").trim()) openSimFull(e.title || "미리보기", e.html); else msg.textContent = "먼저 html을 넣으세요."; } }, "미리보기"),
        h("button", { class: "ghost", type: "button", onclick() { editing = null; drawBuild(); } }, "닫기"),
        h("button", { class: "primary", type: "button", onclick: saveSim }, "저장"))));
}

// 「어디에 보일까요?」: 슬라이드 쪽 아래(시작~끝 쪽) / 언제든. 질문·설문과 설명 카드가 함께 쓴다
function placeControls(e, redraw) {
  if (!lesson.slide_count) return null;
  const pageIn = h("input", { type: "number", min: 1, max: Math.max(lesson.slide_count, 1), value: e.page ?? lesson.page, class: "num", "aria-label": "시작 쪽", oninput() { e.page = parseInt(pageIn.value, 10) || 1; } });
  // 여러 쪽에 걸쳐 같은 활동을 띄울 때 끝 쪽. 비우면 시작 쪽 한 쪽에만 보인다
  const pageToIn = h("input", { type: "number", min: 1, max: Math.max(lesson.slide_count, 1), value: e.page_to > e.page ? e.page_to : "", placeholder: "(한 쪽만)", class: "num", "aria-label": "끝 쪽", oninput() { e.page_to = parseInt(pageToIn.value, 10) || null; } });
  const placeSel = h("select", {
    onchange() { e.page = placeSel.value === "page" ? (parseInt(pageIn.value, 10) || 1) : null; redraw(); },
  }, h("option", { value: "page", selected: e.page != null }, "슬라이드 쪽 아래"), h("option", { value: "any", selected: e.page == null }, "언제든 (모든 쪽 아래 목록)"));
  const on = e.page != null;
  return h("label", {}, "어디에 보일까요?", h("div", { class: "row" }, placeSel, on ? pageIn : null, on ? h("span", {}, "쪽부터") : null,
    on ? pageToIn : null, on ? h("span", {}, "쪽까지") : null));
}

// 저장할 줄에 끝 쪽을 넣는다. page_to 칸이 없는 예전 데이터베이스에서 여러 쪽을 고르면 안내하고 false
function putPageTo(row, e, msg) {
  // 끝 쪽: 시작 쪽보다 뒤일 때만 쓴다
  const to = e.page != null && e.page_to > e.page ? Math.min(e.page_to, Math.max(lesson.slide_count, e.page)) : null;
  // 데이터베이스에 page_to 칸이 있을 때만(불러온 활동에 그 칸이 보일 때만) 보낸다
  const hasPageTo = activities.some((x) => "page_to" in x);
  if (to != null && activities.length && !hasPageTo) {
    msg.textContent = "여러 쪽에 걸친 활동을 쓰려면 먼저 Supabase에서 setup.sql을 한 번 실행해야 합니다. 끝 쪽 칸을 비우면 지금도 저장할 수 있습니다.";
    return false;
  }
  if (to != null || hasPageTo) row.page_to = to;
  return true;
}

function editor() {
  const e = editing;
  if (e.kind === "sim") return simEditor();
  const redraw = () => { const y = scrollY; drawBuild(); scrollTo(0, y); };
  if (isInfoActivity(e)) {
    const msg = h("p", { class: "error" });
    const title = h("input", { type: "text", maxlength: 100, value: e.title, placeholder: "예: 활동 안내", oninput() { e.title = title.value; } });
    const body = h("textarea", { rows: 10, maxlength: 5000, placeholder: "설명과 링크를 입력하세요. https:// 주소는 학생 화면에서 클릭할 수 있습니다.", oninput() { e.questions[0].text = body.value; } }, e.questions[0].text || "");
    return h("section", { class: "card stack editor" },
      h("h2", {}, e.id ? "설명 카드 고치기" : "설명 카드 만들기"),
      h("label", {}, "제목", title), placeControls(e, redraw),
      lesson.slide_count && e.page != null ? h("p", { class: "muted small" }, "끝 쪽을 적으면 그 사이 쪽마다 같은 카드가 보입니다.") : null,
      h("label", {}, "설명문", body),
      h("p", { class: "muted small" }, "학생은 이 카드에 답을 입력하지 않습니다."), msg,
      h("div", { class: "row between" },
        e.id ? h("button", { class: "ghost danger", type: "button", async onclick() {
          if (!confirm("설명 카드를 지울까요?")) return;
          const { error } = await sb.from("activities").delete().eq("id", e.id);
          if (error) { msg.textContent = error.message; return; }
          activities = activities.filter((a) => a.id !== e.id); editing = null; drawBuild();
        } }, "카드 지우기") : h("span", {}),
        h("div", { class: "row" },
          h("button", { class: "ghost", type: "button", onclick() { editing = null; drawBuild(); } }, "닫기"),
          h("button", { class: "primary", type: "button", async onclick() {
            e.title = e.title.trim(); e.questions[0].text = e.questions[0].text.trim();
            if (!e.title || !e.questions[0].text) { msg.textContent = "제목과 설명문을 입력하세요."; return; }
            const row = { kind: "survey", title: e.title, page: lesson.slide_count ? e.page : null, show_answer: false, named: false, questions: e.questions };
            if (!putPageTo(row, e, msg)) return;
            if (!e.id) { row.lesson_id = lesson.id; row.sort = activities.length; }
            const saved = await save("activities", row, e.id);
            if (!saved) return;
            const { data } = await sb.from("activities").select("*").eq("lesson_id", lesson.id);
            activities = sortActivities(data || []); editing = JSON.parse(JSON.stringify(saved)); drawBuild(); flash("저장했습니다.");
          } }, "저장"))));
  }
  if (e.description === undefined) e.description = activityDescription(e);
  const hasResponses = e.id && responses.some((r) => r.activity_id === e.id);
  const msg = h("p", { class: "error" });

  const title = h("input", { type: "text", maxlength: 100, value: e.title, placeholder: "예: 예상해 보기", oninput() { e.title = title.value; } });
  const description = h("textarea", { rows: 5, maxlength: 2000, placeholder: "설문 전체에 대한 설명을 입력하세요. 웹 주소는 학생 화면에서 링크가 됩니다.", oninput() { e.description = description.value; } }, e.description || "");

  const qs = e.questions.map((q, i) => {
    const typeSel = h("select", {
      "aria-label": "질문 종류",
      onchange() { q.type = typeSel.value; if (q.type === "choice" || q.type === "multi") { q.options = q.options && q.options.length ? q.options : ["", ""]; } if (q.type === "file") q.accept = q.accept || "any"; delete q.answer; redraw(); },
    }, Object.entries(TYPE_NAME).map(([k, v]) => h("option", { value: k, selected: q.type === k }, v)));
    const move = (d) => { const j = i + d; if (j < 0 || j >= e.questions.length) return; [e.questions[i], e.questions[j]] = [e.questions[j], e.questions[i]]; redraw(); };
    const text = h("input", { type: "text", maxlength: 300, value: q.text, placeholder: "질문을 입력하세요", oninput() { q.text = text.value; } });
    const choice = q.type === "choice" || q.type === "multi";
    const opts = choice ? h("textarea", {
      rows: Math.max(3, q.options.length + 1),
      onchange() {
        q.options = opts.value.split("\n").map((x) => x.trim()).filter(Boolean);
        if (q.answer != null) {
          q.answer = q.type === "choice" ? (q.options.includes(q.answer) ? q.answer : undefined) : [].concat(q.answer).filter((x) => q.options.includes(x));
          if (q.answer === undefined || (Array.isArray(q.answer) && !q.answer.length)) delete q.answer;
        }
        redraw();
      },
    }, q.options.filter(Boolean).join("\n")) : null;
    const answerPick = e.kind === "quiz" && choice && q.options.filter(Boolean).length ? h("fieldset", { class: "options" },
      h("legend", {}, "정답 표시" + (q.type === "multi" ? " (모두 고르기)" : "")),
      q.options.filter(Boolean).map((o) => h("label", { class: "option" + ([].concat(q.answer ?? []).includes(o) ? " right" : "") },
        h("input", {
          type: q.type === "choice" ? "radio" : "checkbox", name: "ans-" + q.id, checked: [].concat(q.answer ?? []).includes(o),
          onchange(ev) {
            if (q.type === "choice") q.answer = o;
            else {
              const now = q.options.filter((x) => (x === o ? ev.target.checked : [].concat(q.answer ?? []).includes(x)));
              if (now.length) q.answer = now; else delete q.answer;
            }
            redraw();
          },
        }), h("span", {}, o)))) : null;
    const acceptSel = q.type === "file" ? h("select", { "aria-label": "받을 파일", onchange() { q.accept = acceptSel.value; } },
      h("option", { value: "any", selected: q.accept !== "image" }, "사진·문서 (PDF, 한글, 워드, 엑셀, PPT 등)"),
      h("option", { value: "image", selected: q.accept === "image" }, "사진만 (휴대폰에서 바로 찍기)")) : null;
    const explain = e.kind === "quiz" ? h("input", { type: "text", maxlength: 300, value: q.explain || "", placeholder: "해설 (선택)", oninput() { q.explain = explain.value.trim() || undefined; } }) : null;
    return h("article", { class: "q-edit stack" },
      h("div", { class: "row" }, h("strong", {}, "질문 " + (i + 1)), typeSel, h("span", { class: "spacer" }),
        h("button", { class: "link", type: "button", onclick() { move(-1); } }, "위로"),
        h("button", { class: "link", type: "button", onclick() { move(1); } }, "아래로"),
        h("button", { class: "link danger", type: "button", onclick() { if (e.questions.length > 1) { e.questions.splice(i, 1); redraw(); } } }, "삭제")),
      h("label", {}, "질문", text),
      choice ? h("label", {}, "보기 (한 줄에 하나씩)", opts) : null,
      acceptSel ? h("label", {}, "받을 파일", acceptSel) : null,
      acceptSel ? h("p", { class: "muted small" }, "학생은 " + FILE_COUNT + "개까지, 한 개에 " + fileSize(FILE_MAX) + "까지 올립니다. 파일은 교사만 열어 볼 수 있고, 「학생에게 공개」해도 친구들에게는 파일 이름만 보입니다.") : null,
      answerPick,
      explain ? h("label", {}, "해설", explain) : null,
      e.kind === "quiz" && !choice ? h("p", { class: "muted small" }, "글로 답하는 질문은 자동 채점하지 않습니다.") : null);
  });

  async function saveActivity() {
    e.title = e.title.trim();
    if (!e.title) { msg.textContent = "제목을 입력하세요."; return; }
    for (const [i, q] of e.questions.entries()) {
      q.text = (q.text || "").trim();
      delete q.description;
      delete q.intro;
      if (!q.text) { msg.textContent = (i + 1) + "번 질문을 입력하세요."; return; }
      if (q.type === "choice" || q.type === "multi") {
        q.options = q.options.map((x) => x.trim()).filter(Boolean);
        if (q.options.length < 2) { msg.textContent = (i + 1) + "번 질문의 보기를 두 개 이상 적으세요."; return; }
        if (new Set(q.options).size !== q.options.length) { msg.textContent = (i + 1) + "번 질문에 같은 보기가 두 번 있습니다."; return; }
      } else { delete q.options; delete q.answer; }
      if (q.type === "file") q.accept = q.accept === "image" ? "image" : "any"; else delete q.accept;
    }
    if (e.questions.length && e.description.trim()) e.questions[0].intro = e.description.trim();
    const row = { kind: e.kind, title: e.title, page: e.page, show_answer: e.show_answer, named: e.named, questions: e.questions };
    if (!putPageTo(row, e, msg)) return;
    if (!e.id) { row.lesson_id = lesson.id; row.sort = activities.length; }
    const saved = await save("activities", row, e.id);
    if (!saved) return;
    const { data } = await sb.from("activities").select("*").eq("lesson_id", lesson.id);
    activities = sortActivities(data || []);
    editing = JSON.parse(JSON.stringify(saved));
    drawBuild();
    flash("저장했습니다.");
  }

  async function removeActivity() {
    if (!confirm("「" + e.title + "」을(를) 지울까요? 학생 응답도 함께 지워집니다.")) return;
    const { error } = await sb.from("activities").delete().eq("id", e.id);
    if (error) { msg.textContent = error.message; return; }
    await removeSubmissionFiles(lesson.id, e.id);
    activities = activities.filter((a) => a.id !== e.id);
    editing = null;
    drawBuild();
  }

  return h("section", { class: "card stack editor" },
    h("p", { class: "muted small" }, KIND_NAME[e.kind] + (e.id ? " 고치기" : " 새로 만들기")),
    hasResponses ? h("p", { class: "banner" }, "이미 학생 응답이 있습니다. 질문이나 보기를 바꾸면 기존 응답과 맞지 않을 수 있습니다.") : null,
    h("div", { class: "row wrap" },
      h("label", { class: "grow" }, "제목", title),
      placeControls(e, redraw)),
      lesson.slide_count && e.page != null ? h("p", { class: "muted small grow" }, "끝 쪽을 적으면 그 사이 쪽마다 같은 질문이 보이고, 학생이 쓴 답도 이어서 보입니다.") : null,
    h("label", {}, "설문 설명문 (선택)", description),
    h("div", { class: "row wrap" },
      e.kind === "quiz" ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: e.show_answer, onchange(ev) { e.show_answer = ev.target.checked; } }), "제출 뒤 정답과 해설 보여 주기") : null,
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: e.named, onchange(ev) { e.named = ev.target.checked; } }), "학생에게 공개할 때 이름 표시")),
    qs,
    h("div", { class: "row" }, Object.entries(TYPE_NAME).map(([k, v]) =>
      h("button", { class: "ghost", type: "button", onclick() { e.questions.push(newQuestion(k)); redraw(); } }, "+ " + v))),
    msg,
    h("div", { class: "row between" },
      e.id ? h("button", { class: "ghost danger", type: "button", onclick: removeActivity }, "활동 지우기") : h("span", {}),
      h("div", { class: "row" },
        h("button", { class: "ghost", type: "button", onclick() { editing = null; drawBuild(); } }, "닫기"),
        h("button", { class: "primary", type: "button", onclick: saveActivity }, "저장"))));
}

function flash(text) {
  const el = h("p", { class: "toast" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 1800);
}

// ---------- 학생 관리 ----------
// ---------- 학생 화면(실시간, 교사만) ----------
// 학생 화면이 보내는 live = { page, following, hidden, focus, drafts: { 활동id: { 질문id: 쓰는 중인 답 } } }
let live = null;   // { grid, note, tiles: Map(학생 id → { el, sig }), open: 크게 본 학생 id }

function drawLive() {
  live = { grid: h("div", { class: "live-grid" }), note: h("p", { class: "muted small" }), tiles: new Map(), open: live ? live.open : null };
  main.replaceChildren(h("div", { class: "stack" },
    h("section", { class: "card stack" },
      h("h2", {}, "학생 화면 (실시간)"),
      h("p", { class: "muted small" }, "학생마다 지금 보고 있는 쪽과, 저장하기 전에 쓰고 있는 답이 2초마다 바뀌어 보입니다. 이 화면은 선생님만 볼 수 있습니다. 학생을 누르면 크게 봅니다."),
      live.note),
    live.grid));
  refreshLive();
}

function liveState(s) {
  const L = s.live || {};
  if (!s.last_seen || Date.now() - Date.parse(s.last_seen) > ONLINE_MS) return ["off", "나감"];
  if (L.hidden) return ["away", "다른 앱·화면 꺼짐"];
  return ["on", "보는 중"];
}

function liveAnswer(v) {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? "📎 " + x.name : x)).join(", ");
  return String(v);
}

function liveTile(s) {
  const L = s.live || {};
  const [cls, label] = liveState(s);
  const big = live.open === s.id;
  const hasSlides = lesson.slide_count > 0 && L.page;
  const where = !hasSlides ? null : L.page === lesson.page ? L.page + "쪽 · 선생님과 같은 쪽" : L.page < lesson.page ? L.page + "쪽 · 앞 쪽을 다시 보는 중" : L.page + "쪽";
  // 지금 누르고 있는 활동을 맨 위에
  const ids = Object.keys(L.drafts || {}).filter((id) => activities.some((a) => a.id === id))
    .sort((x, y) => (y === L.focus) - (x === L.focus));
  const drafts = ids.map((id) => {
    const a = activities.find((x) => x.id === id);
    const vals = L.drafts[id] || {};
    const lines = a.questions.filter((q) => q.type !== "info" && !isEmptyAnswer(vals[q.id])).map((q) =>
      h("p", { class: "live-answer" }, h("span", { class: "muted" }, q.text + " "), liveAnswer(vals[q.id])));
    return lines.length ? h("div", { class: "live-draft" + (id === L.focus ? " focus" : "") },
      h("strong", { class: "small" }, (id === L.focus ? "✏️ 쓰는 중 · " : "저장 전 · ") + a.title), lines) : null;
  }).filter(Boolean);
  const done = new Set(responses.filter((r) => r.student_id === s.id).map((r) => r.activity_id)).size;
  return h("article", { class: "card live-tile " + cls + (big ? " big" : ""), title: big ? "누르면 작게" : "누르면 크게",
    onclick() { live.open = big ? null : s.id; refreshLive(); } },
    h("div", { class: "row between" }, h("strong", {}, nameOf(s)), h("span", { class: "live-dot " + cls }, label)),
    hasSlides ? h("img", { class: "live-slide", src: slideSrc(lesson, L.page), alt: L.page + "쪽", loading: "lazy" }) : null,
    where ? h("p", { class: "small muted" }, where) : null,
    drafts.length ? drafts : h("p", { class: "small muted" }, cls === "off" ? "" : "쓰고 있는 답 없음"),
    h("p", { class: "small muted" }, "제출한 활동 " + done + "개"));
}

function refreshLive() {
  if (!live || !live.grid.isConnected) return;
  if (students.length && !("live" in students[0])) {
    live.note.textContent = "이 기능을 쓰려면 먼저 Supabase SQL Editor에서 setup.sql을 한 번 다시 실행하세요.";
  } else if (!students.length) {
    live.note.textContent = "아직 들어온 학생이 없습니다.";
  } else {
    const st = students.map(liveState);
    const on = st.filter(([c]) => c === "on").length, away = st.filter(([c]) => c === "away").length;
    const same = lesson.slide_count ? students.filter((s, i) => st[i][0] === "on" && s.live && s.live.page === lesson.page).length : null;
    live.note.textContent = "보는 중 " + on + "명" + (same != null ? " (선생님과 같은 쪽 " + same + "명)" : "") + " · 다른 앱·화면 꺼짐 " + away + "명 · 나감 " + (students.length - on - away) + "명";
  }
  // 바뀐 학생 칸만 다시 그린다(그림이 깜빡이지 않게)
  const els = students.map((s) => {
    const sig = JSON.stringify([s.live, liveState(s), live.open === s.id, lesson.page, responses.filter((r) => r.student_id === s.id).length]);
    let t = live.tiles.get(s.id);
    if (!t || t.sig !== sig) { t = { el: liveTile(s), sig }; live.tiles.set(s.id, t); }
    return t.el;
  });
  if (els.length !== live.grid.children.length || els.some((el, i) => live.grid.children[i] !== el)) live.grid.replaceChildren(...els);
}

function drawStudents() {
  const now = Date.now();
  const rows = students.map((s) => {
    const mine = responses.filter((r) => r.student_id === s.id);
    const last = mine.reduce((t, r) => (r.updated_at > t ? r.updated_at : t), "");
    const locked = s.locked_until && Date.parse(s.locked_until) > now;
    const status = locked ? h("span", { class: "tag warn" }, "잠김 · " + Math.ceil((Date.parse(s.locked_until) - now) / 60000) + "분 남음")
      : !s.pin_set ? h("span", { class: "tag info" }, "초기화됨 · 새 비밀번호 기다리는 중")
      : h("span", { class: "tag ok" }, "정상");
    return h("tr", { class: locked ? "locked" : "" },
      h("td", {}, s.class_no), h("td", {}, s.name),
      h("td", {}, mine.length + " / " + activities.filter((a) => a.kind !== "sim").length), h("td", {}, fmtTime(last)), h("td", {}, status),
      h("td", { class: "actions" },
        h("button", {
          class: locked ? "primary" : "ghost", type: "button", disabled: !s.pin_set && !locked,
          async onclick() {
            if (!confirm(nameOf(s) + " 학생의 비밀번호를 초기화할까요?\n모든 수업에 함께 적용됩니다. 쓴 답은 그대로 남고, 다음에 들어올 때 새 비밀번호를 정합니다.")) return;
            const { error } = await sb.from("students").update({ pin_hash: null, token: null, fails: 0, locked_until: null }).eq("id", s.id);
            if (error) return alert(error.message);
            await loadResponses();
            drawStudents();
            flash("초기화했습니다.");
          },
        }, "비밀번호 초기화"),
        h("button", {
          class: "link danger", type: "button",
          async onclick() {
            if (!confirm(nameOf(s) + " 학생을 이 수업에서 뺄까요? 이 수업에서 쓴 응답이 지워집니다.\n(다른 수업의 응답과 학생 계정은 남습니다. 학생이 다시 들어오면 다시 참여합니다.)")) return;
            const ids = activities.map((a) => a.id);
            if (ids.length) {
              const r = await sb.from("responses").delete().eq("student_id", s.id).in("activity_id", ids);
              if (r.error) return alert(r.error.message);
            }
            const { error } = await sb.from("lesson_students").delete().eq("lesson_id", lesson.id).eq("student_id", s.id);
            if (error) return alert(error.message);
            await loadResponses();
            drawStudents();
          },
        }, "이 수업에서 빼기"),
        h("button", {
          class: "link danger", type: "button",
          async onclick() {
            if (!confirm(nameOf(s) + " 학생 계정을 완전히 지울까요?\n모든 수업에서 빠지고, 모든 수업의 응답이 지워집니다. 장난으로 만든 이름을 지울 때 쓰세요.")) return;
            const { error } = await sb.from("students").delete().eq("id", s.id);
            if (error) return alert(error.message);
            await loadResponses();
            drawStudents();
          },
        }, "계정 삭제")));
  });
  main.replaceChildren(h("section", { class: "card stack" },
    h("div", { class: "row between wrap" },
      h("h2", {}, "학생 " + students.length + "명"),
      h("p", { class: "muted small" }, "학생 계정은 웹앱 전체에 하나라서, 어느 수업에서든 같은 학번·이름·비밀번호를 씁니다. 비밀번호는 암호화되어 교사도 볼 수 없습니다. 잊은 학생은 초기화해 주세요.")),
    students.length ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["학번", "이름", "저장한 활동", "마지막 저장", "상태", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows))) : h("p", { class: "muted" }, "아직 입장한 학생이 없습니다.")));
}

// ---------- 수업 설정 ----------
function drawSettings() {
  const title = h("input", { type: "text", maxlength: 100, value: lesson ? lesson.title : "", placeholder: "예: 2학년 3반 · 열의 이동" });
  const msg = h("p", { class: "error" });
  let kind = "lesson";
  const kindPick = h("fieldset", { class: "options" }, h("legend", {}, "무엇을 만들까요?"),
    [["lesson", "슬라이드 수업", "PDF 슬라이드를 띄우며 쪽마다 질문"], ["survey", "설문만", "슬라이드 없이 설문·퀴즈 링크 하나"]].map(([k, name, sub]) =>
      h("label", { class: "option" }, h("input", { type: "radio", name: "lesson-kind", checked: k === kind, onchange() { kind = k; } }),
        h("span", {}, h("strong", {}, name), " · ", h("span", { class: "muted small" }, sub)))));

  async function submit(ev) {
    ev.preventDefault();
    const t = title.value.trim();
    if (!t) { msg.textContent = "수업 제목을 입력하세요."; return; }
    if (lesson) {
      const saved = await save("lessons", { title: t }, lesson.id);
      if (!saved) return;
      await loadLessons(saved.id);
      flash("저장했습니다.");
      return;
    }
    const { data, error } = await sb.rpc("create_lesson", { p_title: t, p_kind: kind });
    if (error) { msg.textContent = "만들지 못했습니다: " + error.message; return; }
    tab = "settings";
    if (data.kind === "survey") tab = "build";
    await loadLessons(data.id);
    flash(data.kind === "survey" ? "설문을 만들었습니다. 이제 질문을 넣으세요." : "수업을 만들었습니다. 이제 슬라이드를 올리세요.");
    return;
  }

  async function duplicate() {
    const { data: copy, error } = await sb.rpc("create_lesson", { p_title: (lesson.title + " (복사)").slice(0, 100), p_kind: lesson.kind });
    if (error) return alert("복제하지 못했습니다: " + error.message);
    // 슬라이드 그림은 같은 것을 함께 쓴다(원래 수업을 지워도 다른 수업이 쓰는 그림은 남긴다)
    await sb.from("lessons").update({ slide_dir: lesson.slide_dir, slide_count: lesson.slide_count,
      ...("transition" in lesson && lesson.transition ? { transition: lesson.transition } : {}) }).eq("id", copy.id);
    if (activities.length) {
      const r = await sb.from("activities").insert(activities.map((a) => ({
        lesson_id: copy.id, kind: a.kind, title: a.title, page: a.page, show_answer: a.show_answer, named: a.named, questions: a.questions, sort: a.sort,
        // 나중에 더한 칸은 데이터베이스에 있을 때만 복사한다(시뮬레이션 html·띄우는 자리, 끝 쪽)
        ...Object.fromEntries(["page_to", "html", "sim_full", "sim_box"].filter((k) => k in a).map((k) => [k, a[k]])),
      })));
      if (r.error) alert("활동을 복사하지 못했습니다: " + r.error.message);
    }
    await loadLessons(copy.id);
    flash("복제했습니다. 제목을 고쳐 주세요.");
  }

  async function remove() {
    const typed = prompt("수업을 지우면 활동, 학생, 응답, 슬라이드가 모두 지워집니다.\n지우려면 수업 코드 「" + lesson.code + "」를 입력하세요.");
    if ((typed || "").trim().toUpperCase() !== lesson.code) return;
    await removeSlideFiles(lesson);
    const { error } = await sb.from("lessons").delete().eq("id", lesson.id);
    if (error) return alert(error.message);
    await removeSubmissionFiles(lesson.id);
    await loadLessons(null);
  }

  main.replaceChildren(h("div", { class: "stack narrowish" },
    h("form", { class: "card stack", onsubmit: submit },
      h("h2", {}, lesson ? (lesson.kind === "survey" ? "설문 설정" : "수업 설정") : "새로 만들기"),
      lesson ? null : kindPick,
      lesson ? h("p", { class: "join-code" }, "수업 코드 ", h("strong", {}, lesson.code)) : h("p", { class: "muted small" }, "수업 코드는 겹치지 않게 자동으로 만들어집니다."),
      h("label", {}, "제목", title),
      msg,
      h("button", { class: "primary big", type: "submit" }, lesson ? "제목 저장" : "수업 만들기")),
    lesson && lesson.kind !== "survey" ? slidesCard() : null,
    lesson ? h("section", { class: "card stack" },
      h("h2", {}, "학생 접속"),
      h("p", { class: "join-url" }, joinUrl(lesson)),
      h("div", { class: "row" },
        h("button", { class: "ghost", type: "button", onclick: showJoin }, "QR 크게 보기"),
        h("button", { class: "ghost", type: "button", onclick: duplicate }, "다른 반용으로 복제"),
        h("button", { class: "ghost danger", type: "button", onclick: remove }, "수업 지우기"))) : null));
}

// 슬라이드 올리기: PDF 한 개 또는 그림 여러 장 → 쪽마다 JPG로 바꿔 Storage에 올린다.
function slidesCard() {
  const file = h("input", { type: "file", accept: "application/pdf,image/png,image/jpeg", multiple: true });
  const bar = h("progress", { max: 1, value: 0, hidden: true });
  const status = h("p", { class: "msg" });
  const btn = h("button", { class: lesson.slide_count ? "ghost" : "primary", type: "button" }, lesson.slide_count ? "다시 올리기 (기존 슬라이드를 바꿈)" : "올리기");
  const addBtn = lesson.slide_count ? h("button", { class: "primary", type: "button" }, "끝에 추가 (기존 슬라이드는 그대로)") : null;
  const htmlFile = h("input", { type: "file", accept: ".html,.htm,text/html", multiple: true });
  const htmlBtn = h("button", { class: "primary", type: "button" }, "애니메이션 슬라이드 끝에 추가");
  const buttons = [btn, addBtn, htmlBtn].filter(Boolean);
  const doUpload = async (input, upload, done) => {
    if (!input.files.length) { status.textContent = input === htmlFile ? "html 파일을 먼저 고르세요." : "PDF 파일이나 그림 파일을 먼저 고르세요."; return; }
    if (slideBusy) return;
    slideBusy = true;
    buttons.forEach((b) => { b.disabled = true; });
    bar.hidden = false;
    try {
      const n = await upload([...input.files], (k, total, what) => {
        bar.max = total;
        bar.value = k;
        status.textContent = what + " " + k + " / " + total;
      });
      slideBusy = false;
      flash(done(n));
      await loadLessons(lesson.id);
    } catch (e) {
      slideBusy = false;
      status.textContent = "올리지 못했습니다: " + (e.message || e);
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  btn.addEventListener("click", () => {
    const animated = activities.filter((a) => a.kind === "sim" && a.sim_full).length;
    if (lesson.slide_count && !confirm("기존 슬라이드 " + lesson.slide_count + "장을 모두 새 파일로 바꿀까요?\n기존 슬라이드 뒤에 붙이려면 「끝에 추가」를 누르세요." +
      (animated ? "\n애니메이션 슬라이드 " + animated + "개는 지워지지 않고 원래 쪽 번호에 남아, 새 슬라이드의 그 쪽을 가립니다. 필요 없으면 「질문·설문 만들기」에서 지우세요." : ""))) return;
    doUpload(file, uploadSlides, (n) => "슬라이드 " + n + "장을 올렸습니다.");
  });
  if (addBtn) addBtn.addEventListener("click", () => doUpload(file, appendSlides, (n) => "슬라이드 " + n + "장을 끝에 붙였습니다."));
  htmlBtn.addEventListener("click", () => doUpload(htmlFile, addHtmlSlides, (n) => "애니메이션 슬라이드 " + n + "장을 끝에 붙였습니다."));
  // 화면 넘김 효과: 수업 전체 기본값 + 쪽마다 다르게(미리보기 아래 칸)
  const fx = transitionSetting();
  const fxMsg = h("p", { class: "msg" });
  const fxSel = h("select", { "aria-label": "넘김 효과", onchange() { fx.type = fxSel.value; saveTransition(fx, fxMsg); } },
    Object.entries(TRANSITIONS).map(([k, v]) => h("option", { value: k, selected: fx.type === k }, v)));
  const fxSpeed = h("select", { "aria-label": "넘김 빠르기", onchange() { fx.ms = +fxSpeed.value; saveTransition(fx, fxMsg); } },
    Object.entries(TRANSITION_SPEED).map(([k, v]) => h("option", { value: k, selected: fx.ms === +k }, v)));
  const pv = h("img", { alt: "넘김 미리보기", src: lesson.slide_count ? slideSrc(lesson, 1) : "" });
  let pvPage = 1, pvCount = 0;
  const pvBtn = h("button", { class: "ghost", type: "button", onclick() {
    // 1쪽 → 2쪽으로 넘기는 모습을 보여 주고, 다시 누르면 1쪽으로 돌아간다(# 은 같은 그림이라도 바뀐 것으로 보게)
    if (pvPage !== 1) { changeSlide(pv, slideSrc(lesson, 1) + "#" + ++pvCount, null, 1); pvPage = 1; pvBtn.textContent = "미리보기 ▶"; return; }
    const to = Math.min(2, lesson.slide_count);
    changeSlide(pv, slideSrc(lesson, to) + "#" + ++pvCount, transitionFor({ transition: fx }, to), 1);
    pvPage = 2;
    pvBtn.textContent = "처음으로 ↺";
  } }, "미리보기 ▶");
  // 쪽마다 정한 효과를 모두 지워 모든 쪽이 위의 효과 하나로 넘어가게 한다
  const pageSels = [];
  const allBtn = h("button", { class: "ghost", type: "button", onclick() {
    const n = Object.keys(fx.pages).length;
    if (n && !confirm("쪽마다 따로 정한 효과 " + n + "개를 지우고, 모든 쪽을 「" + TRANSITIONS[fx.type] + "」(으)로 넘길까요?")) return;
    fx.pages = {};
    pageSels.forEach((s) => { s.value = ""; });
    saveTransition(fx, fxMsg);
  } }, "모든 쪽에 같게 적용");
  const fxCard = lesson.slide_count ? h("div", { class: "stack" },
    h("h3", {}, "화면 넘김 효과"),
    h("div", { class: "row wrap" }, h("label", {}, "효과", fxSel), h("label", {}, "빠르기", fxSpeed), pvBtn, allBtn),
    h("div", { class: "fx-preview" }, pv), fxMsg,
    h("p", { class: "muted small" }, "교사 화면·학생 화면 모두 이 효과로 넘어갑니다. 앞 쪽으로 돌아갈 때는 거꾸로 움직입니다. 쪽마다 다르게 하려면 아래 미리보기 밑의 칸에서 고르고, 다시 모두 같게 하려면 「모든 쪽에 같게 적용」을 누르세요.")) : null;
  const pageFx = (i) => {
    const sel = h("select", { class: "thumb-fx", "aria-label": i + "쪽으로 넘어갈 때", title: i + "쪽으로 넘어갈 때 효과", draggable: "false",
      onmousedown(ev) { ev.stopPropagation(); },
      onchange(ev) {
        const v = ev.target.value;
        if (v) fx.pages[i] = v; else delete fx.pages[i];
        saveTransition(fx, fxMsg);
      } },
      h("option", { value: "", selected: !fx.pages[i] }, "넘김: 기본"),
      Object.entries(TRANSITIONS).map(([k, v]) => h("option", { value: k, selected: fx.pages[i] === k }, "넘김: " + v)));
    pageSels.push(sel);
    return sel;
  };

  // 애니메이션(html)이 슬라이드 자리에 뜨는 쪽
  const htmlOn = (i) => activities.find((a) => a.kind === "sim" && a.sim_full && a.page === i && !(a.page_to > i));

  // 미리보기를 끌어 순서를 바꾼다. 그림의 왼쪽 반에 놓으면 그 앞, 오른쪽 반이면 그 뒤로 간다.
  const thumbs = h("div", { class: "thumbs" });
  let dragFrom = 0;
  let after = false;
  const clearMarks = () => thumbs.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
  for (let i = 1; i <= lesson.slide_count; i++) {
    thumbs.append(h("figure", {
      class: "thumb", draggable: "true", title: "끌어서 순서 바꾸기",
      ondragstart(ev) {
        if (slideBusy) return ev.preventDefault();
        dragFrom = i;
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", String(i));
        ev.currentTarget.classList.add("dragging");
      },
      ondragend(ev) { dragFrom = 0; ev.currentTarget.classList.remove("dragging"); clearMarks(); },
      ondragover(ev) {
        if (!dragFrom || dragFrom === i) return;
        ev.preventDefault();
        const r = ev.currentTarget.getBoundingClientRect();
        after = ev.clientX > r.left + r.width / 2;
        clearMarks();
        ev.currentTarget.classList.add(after ? "drop-after" : "drop-before");
      },
      ondrop(ev) {
        ev.preventDefault();
        clearMarks();
        if (!dragFrom) return;
        const ins = after ? i + 1 : i;   // 이 번호 앞에 끼운다
        moveSlide(dragFrom, ins > dragFrom ? ins - 1 : ins, status);
      },
    },
      h("img", { src: slideSrc(lesson, i), alt: i + "쪽", loading: "lazy", draggable: "false" }),
      h("figcaption", {}, h("span", { title: htmlOn(i) ? htmlOn(i).title : null }, i + "쪽" + (htmlOn(i) ? " · 애니메이션" : "")),
        h("button", { class: "link danger", type: "button", "aria-label": i + "쪽 삭제", onclick() { deleteSlide(i, status); } }, "삭제")),
      pageFx(i)));
  }
  return h("section", { class: "card stack" },
    h("h2", {}, "슬라이드 " + (lesson.slide_count ? lesson.slide_count + "장" : "없음")),
    h("p", { class: "muted small" }, "PowerPoint에서 「파일 → 다른 이름으로 저장 → PDF」로 저장한 파일을 올리면 쪽마다 그림으로 바뀝니다. 그림 파일(PNG, JPG) 여러 장을 올려도 됩니다(파일 이름 순서). 100쪽까지."),
    h("div", { class: "row wrap" }, file, addBtn, btn),
    h("p", { class: "muted small" }, "애니메이션이 들어간 html 파일은 아래에서 올립니다. 끝에 「▶ 애니메이션」 쪽이 생기고, 수업할 때 그 쪽에서는 교사·학생 화면 모두 슬라이드 대신 애니메이션이 움직입니다. 파일 하나로 된 html(최대 50만 자)만 됩니다."),
    h("div", { class: "row wrap" }, htmlFile, htmlBtn),
    bar, status,
    fxCard,
    lesson.slide_count ? h("div", { class: "row slide-tools" },
      h("span", { class: "muted small grow" }, "미리보기를 끌어서 순서를 바꿉니다(붙어 있는 질문도 따라갑니다). 빈 칸이 있거나 쪽 수가 맞지 않으면 →"),
      h("button", { class: "ghost", type: "button", onclick() { deleteSlide(null, status); } }, "번호 다시 맞추기")) : null,
    lesson.slide_count ? thumbs : null);
}

async function loadPdfJs() {
  if (!window.pdfjsLib) {
    await new Promise((ok, fail) => document.head.append(h("script", { src: "vendor/pdf.min.js", onload: ok, onerror: () => fail(new Error("PDF 도구를 불러오지 못했습니다")) })));
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  }
  return window.pdfjsLib;
}

const SLIDE_WIDTH = 1600;

function canvasToJpeg(canvas) {
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("그림으로 바꾸지 못했습니다"))), "image/jpeg", 0.85));
}

// 파일들을 쪽별 JPG 묶음으로 바꾼다
async function toSlideImages(files, progress) {
  const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (pdfs.length > 1) throw new Error("PDF는 한 번에 하나만 올릴 수 있습니다.");
  const out = [];
  if (pdfs.length) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: await pdfs[0].arrayBuffer() }).promise;
    if (pdf.numPages > 100) throw new Error("100쪽이 넘습니다(" + pdf.numPages + "쪽).");
    for (let i = 1; i <= pdf.numPages; i++) {
      progress(i - 1, pdf.numPages, "그림으로 바꾸는 중");
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: SLIDE_WIDTH / page.getViewport({ scale: 1 }).width });
      const canvas = h("canvas", { width: Math.round(vp.width), height: Math.round(vp.height) });
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push(await canvasToJpeg(canvas));
    }
    return out;
  }
  const imgs = files.filter((f) => /^image\/(png|jpeg)$/.test(f.type)).sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
  if (!imgs.length) throw new Error("PDF나 PNG·JPG 파일을 고르세요.");
  if (imgs.length > 100) throw new Error("100장이 넘습니다.");
  for (const [i, f] of imgs.entries()) {
    progress(i, imgs.length, "그림 줄이는 중");
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, SLIDE_WIDTH / bmp.width);
    const canvas = h("canvas", { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    out.push(await canvasToJpeg(canvas));
  }
  return out;
}

const slideFolder = (l) => me.id + "/" + l.id + "/";

// 슬라이드 그림이 들어 있는 폴더(주소에서 읽는다). 다른 교사가 올렸거나 복제한 수업이면 원래 수업의 폴더다.
function slideFolderOf(l) {
  const m = /\/public\/slides\/(.+\/)\{n\}/.exec(l.slide_dir || "");
  return m ? decodeURIComponent(m[1]) : null;
}

// 슬라이드 한 쪽 지우기: 그 쪽 그림을 지우고 뒤쪽 그림을 한 칸씩 앞으로 당긴다.
// 질문의 쪽 번호도 함께 당긴다(지운 쪽에 붙어 있던 질문은 그 자리로 당겨진 다음 슬라이드에 붙는다).
// 저장소에 실제로 있는 그림 목록을 보고 1, 2, 3 … 으로 다시 번호를 매기므로, 중간에 멈춰 꼬인 상태도 바로잡는다.
// k 가 없으면(번호 다시 맞추기) 아무것도 지우지 않고 번호만 맞춘다.
let slideBusy = false;

// 이 수업만 쓰는 슬라이드 폴더. 복제한 다른 수업과 같은 그림을 쓰면 쪽 단위로 바꿀 수 없다.
function editableSlideFolder() {
  const folder = slideFolderOf(lesson);
  if (!folder) throw new Error("이 수업의 슬라이드 위치를 알 수 없습니다. 슬라이드를 다시 올려 주세요.");
  const base = lesson.slide_dir.split("?")[0];
  if (folder !== slideFolder(lesson) || lessons.some((x) => x.id !== lesson.id && (x.slide_dir || "").split("?")[0] === base)) {
    throw new Error("이 슬라이드는 복제한 다른 수업과 함께 쓰고 있어서 쪽을 지우거나 옮기거나 더할 수 없습니다.\n이 수업에서 PDF를 「다시 올리기」하면 이 수업만의 슬라이드가 됩니다.");
  }
  return folder;
}

// 저장소에 실제로 있는 슬라이드 그림 번호(작은 것부터)
async function slideNums(folder) {
  const listed = await sb.storage.from("slides").list(folder.replace(/\/$/, ""), { limit: 1000 });
  if (listed.error) throw listed.error;
  return (listed.data || []).map((o) => /^(\d+)\.jpg$/.exec(o.name)).filter(Boolean).map((m) => +m[1]).sort((x, y) => x - y);
}

// 이 수업의 화면 넘김 설정(고쳐도 lesson에는 저장할 때 반영)
function transitionSetting() {
  const t = lesson.transition && typeof lesson.transition === "object" ? lesson.transition : {};
  const pages = {};
  for (const [p, v] of Object.entries(t.pages || {})) if (TRANSITIONS[v] && +p >= 1 && +p <= lesson.slide_count) pages[p] = v;
  return { type: TRANSITIONS[t.type] ? t.type : "none", ms: TRANSITION_SPEED[t.ms] ? +t.ms : 600, pages };
}

async function saveTransition(t, msg) {
  // transition 칸은 setup.sql을 다시 실행해야 생긴다(불러온 수업에 그 칸이 보일 때만 저장)
  if (!("transition" in lesson)) { msg.textContent = "화면 넘김 효과를 쓰려면 먼저 Supabase SQL Editor에서 setup.sql을 한 번 다시 실행하세요."; return; }
  const value = JSON.parse(JSON.stringify(t));
  const { error } = await sb.from("lessons").update({ transition: value }).eq("id", lesson.id);
  if (error) { msg.textContent = "저장하지 못했습니다: " + error.message; return; }
  lesson.transition = value;
  msg.textContent = "";
  flash("화면 넘김 효과를 저장했습니다.");
}

// 슬라이드 번호가 바뀔 때 쪽마다 정한 효과도 따라가게 한다. map(옛 번호) → 새 번호(없애면 0). 바꿀 것이 없으면 {}
function transitionChange(map) {
  const t = lesson.transition;
  if (!t || typeof t !== "object" || !t.pages || !Object.keys(t.pages).length) return {};
  const pages = {};
  for (const [p, v] of Object.entries(t.pages)) { const n = map(+p); if (n) pages[n] = v; }
  return { transition: { ...t, pages } };
}

async function checkSlideNums(folder) {
  const nums = await slideNums(folder);
  if (nums.length !== lesson.slide_count || nums.some((n, i) => n !== i + 1)) {
    throw new Error("저장된 슬라이드 번호가 맞지 않습니다. 「번호 다시 맞추기」를 먼저 눌러 주세요.");
  }
}

// 슬라이드 한 장을 from 쪽에서 to 쪽으로 옮긴다. 사이의 그림은 한 칸씩 밀리거나 당겨진다.
// 질문은 붙어 있던 슬라이드를 따라간다. 여러 쪽에 걸친 질문은 옮긴 슬라이드를 빼고 남은 쪽들을 따라간다.
function slideMoveMap(from, to) {
  return (p) => p === from ? to
    : from < to ? (p > from && p <= to ? p - 1 : p)
    : (p >= to && p < from ? p + 1 : p);
}

function movedRange(a, from, newPos) {
  const end = a.page_to > a.page ? a.page_to : a.page;
  let pages = [];
  for (let p = a.page; p <= end; p++) pages.push(p);
  if (pages.length > 1) pages = pages.filter((p) => p !== from);
  const mapped = pages.map(newPos);
  const page = Math.min(...mapped);
  const last = Math.max(...mapped);
  return { page, page_to: last > page ? last : null };
}

async function moveSlide(from, to, status) {
  if (slideBusy || from === to) return;
  let folder;
  try { folder = editableSlideFolder(); } catch (e) { return alert(e.message); }
  slideBusy = true;
  document.querySelectorAll(".thumb button, .slide-tools button").forEach((b) => { b.disabled = true; });
  const st = sb.storage.from("slides");
  const mv = async (x, y) => { const r = await st.move(folder + x + ".jpg", folder + y + ".jpg"); if (r.error) throw r.error; };
  try {
    status.textContent = from + "쪽을 " + to + "쪽 자리로 옮기는 중…";
    await checkSlideNums(folder);
    // 잠시 비켜 둘 이름. 중간에 멈춰도 「번호 다시 맞추기」를 누르면 맨 끝 쪽으로 되살아난다
    const park = 9000 + from;
    await mv(from, park);
    const step = from < to ? 1 : -1;
    for (let n = from + step; n !== to + step; n += step) await mv(n, n - step);
    await mv(park, to);

    const newPos = slideMoveMap(from, to);
    for (const a of activities) {
      if (a.page == null) continue;
      const r = movedRange(a, from, newPos);
      if (r.page === a.page && r.page_to === (a.page_to > a.page ? a.page_to : null)) continue;
      const change = { page: r.page };
      if ("page_to" in a) change.page_to = r.page_to;
      const u = await sb.from("activities").update(change).eq("id", a.id);
      if (u.error) throw u.error;
    }
    const dir = lesson.slide_dir.split("?")[0] + "?v=" + Date.now();   // 이름이 바뀐 그림을 브라우저가 예전 것으로 보이지 않게
    const u = await sb.from("lessons").update({ slide_dir: dir, page: newPos(lesson.page), ...transitionChange(newPos) }).eq("id", lesson.id);
    if (u.error) throw u.error;
    flash(from + "쪽을 " + to + "쪽으로 옮겼습니다.");
    slideBusy = false;
    await loadLessons(lesson.id);
  } catch (e) {
    slideBusy = false;
    document.querySelectorAll(".thumb button, .slide-tools button").forEach((b) => { b.disabled = false; });
    status.textContent = "멈췄습니다: " + (e.message || e) + " · 「번호 다시 맞추기」를 누르면 남은 그림으로 번호를 다시 맞춥니다.";
    alert(status.textContent);
  }
}

async function deleteSlide(k, status) {
  if (slideBusy) return;
  let folder;
  try { folder = editableSlideFolder(); } catch (e) { return alert(e.message); }
  const base = lesson.slide_dir.split("?")[0];
  // 이 쪽 자리에 뜨는 애니메이션은 쪽과 함께 지운다(남겨 두면 당겨진 다음 슬라이드를 가린다)
  const sims = k ? activities.filter((a) => a.kind === "sim" && a.sim_full && a.page === k && !(a.page_to > k)) : [];
  if (k) {
    const onIt = activities.filter((a) => a.page === k && !(a.page_to > k) && !sims.includes(a));
    if (!confirm(k + "쪽 슬라이드를 지울까요? 뒤쪽 슬라이드가 한 칸씩 앞으로 당겨집니다." +
      (sims.length ? "\n이 쪽의 애니메이션 「" + sims.map((a) => a.title).join("」, 「") + "」도 함께 지웁니다." : "") +
      (onIt.length ? "\n이 쪽에만 있던 질문 " + onIt.length + "개는 지우지 않고, 그 자리로 당겨지는 다음 슬라이드에 붙습니다." : ""))) return;
  }
  slideBusy = true;
  document.querySelectorAll(".thumb button, .slide-tools button").forEach((b) => { b.disabled = true; });
  const st = sb.storage.from("slides");
  try {
    status.textContent = "슬라이드 목록을 확인하는 중…";
    let nums = await slideNums(folder);
    if (k) {
      if (!nums.includes(k)) throw new Error(k + "쪽 그림이 이미 없습니다. 「번호 다시 맞추기」를 눌러 주세요.");
      status.textContent = k + "쪽을 지우는 중…";
      const r = await st.remove([folder + k + ".jpg"]);
      if (r.error) throw r.error;
      nums = nums.filter((x) => x !== k);
    }
    // 남은 그림을 1, 2, 3 … 으로 당긴다(작은 번호부터 옮기므로 옮길 자리는 늘 비어 있다)
    for (const [i, num] of nums.entries()) {
      if (num === i + 1) continue;
      status.textContent = "슬라이드 번호를 맞추는 중 " + (i + 1) + " / " + nums.length;
      const r = await st.move(folder + num + ".jpg", folder + (i + 1) + ".jpg");
      if (r.error) throw r.error;
    }
    const left = nums.length;
    if (sims.length) {
      const d = await sb.from("activities").delete().in("id", sims.map((a) => a.id));
      if (d.error) throw d.error;
    }
    if (k) {
      const shift = (pg) => (pg == null ? pg : pg > k ? pg - 1 : pg);
      for (const a of activities) {
        if (a.page == null || sims.includes(a)) continue;
        const page = Math.min(shift(a.page), Math.max(left, 1));
        let to = a.page_to > a.page ? Math.min(shift(a.page_to), Math.max(left, 1)) : a.page_to ?? null;
        if (to != null && to <= page) to = null;
        if (page === a.page && to === (a.page_to ?? null)) continue;
        const change = { page };
        if ("page_to" in a) change.page_to = to;
        const u = await sb.from("activities").update(change).eq("id", a.id);
        if (u.error) throw u.error;
      }
    }
    const pageNow = k && lesson.page > k ? lesson.page - 1 : lesson.page;
    const dir = base + "?v=" + Date.now();   // 이름이 바뀐 그림을 브라우저가 예전 것으로 보이지 않게
    const u = await sb.from("lessons").update({ slide_dir: left ? dir : "", slide_count: left, page: Math.min(Math.max(pageNow, 1), Math.max(left, 1)),
      ...(k ? transitionChange((p) => (p === k ? 0 : p > k ? p - 1 : p)) : {}) }).eq("id", lesson.id);
    if (u.error) throw u.error;
    flash(k ? k + "쪽을 지웠습니다." : "슬라이드 번호를 맞췄습니다 (" + left + "장).");
    slideBusy = false;
    await loadLessons(lesson.id);
  } catch (e) {
    slideBusy = false;
    document.querySelectorAll(".thumb button, .slide-tools button").forEach((b) => { b.disabled = false; });
    status.textContent = "멈췄습니다: " + (e.message || e) + " · 「번호 다시 맞추기」를 누르면 남은 그림으로 번호를 다시 맞춥니다.";
    alert(status.textContent);
  }
}

async function uploadSlides(files, progress) {
  const images = await toSlideImages(files, progress);
  const folder = slideFolder(lesson);
  for (const [i, blob] of images.entries()) {
    progress(i, images.length, "올리는 중");
    const { error } = await sb.storage.from("slides").upload(folder + (i + 1) + ".jpg", blob, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" });
    if (error) throw error;
  }
  progress(images.length, images.length, "올리는 중");
  // 전보다 쪽 수가 줄었으면 남은 그림을 지운다
  const { data: old } = await sb.storage.from("slides").list(folder.replace(/\/$/, ""), { limit: 1000 });
  const extra = (old || []).map((o) => o.name).filter((n) => parseInt(n, 10) > images.length).map((n) => folder + n);
  if (extra.length) await sb.storage.from("slides").remove(extra);
  const dir = SB_URL + "/storage/v1/object/public/slides/" + folder + "{n}.jpg?v=" + Date.now();
  // 슬라이드를 모두 바꾸면 쪽마다 정한 넘김 효과는 지운다(수업 전체 효과는 그대로)
  const { error } = await sb.from("lessons").update({ slide_dir: dir, slide_count: images.length, page: 1, ...transitionChange(() => 0) }).eq("id", lesson.id);
  if (error) throw error;
  return images.length;
}

// 기존 슬라이드는 그대로 두고 마지막 쪽 뒤에 붙인다. 질문의 쪽 번호도 바뀌지 않는다.
async function appendSlides(files, progress) {
  if (lesson.slide_count) await checkSlideNums(editableSlideFolder());   // 오래 걸리는 PDF 변환 전에 먼저 확인
  const images = await toSlideImages(files, progress);
  await appendImages(images, progress);
  return images.length;
}

// 그림 묶음을 마지막 쪽 뒤에 붙이고, 붙이기 전의 쪽 수를 돌려준다. 슬라이드가 없으면 이 수업의 폴더에 1쪽부터 올린다.
async function appendImages(images, progress) {
  const start = lesson.slide_count;
  const folder = start ? editableSlideFolder() : slideFolder(lesson);
  if (start) await checkSlideNums(folder);
  if (start + images.length > 100) throw new Error("슬라이드는 모두 100장까지입니다(지금 " + start + "장, 더할 것 " + images.length + "장).");
  for (const [i, blob] of images.entries()) {
    progress(i, images.length, "올리는 중");
    const { error } = await sb.storage.from("slides").upload(folder + (start + i + 1) + ".jpg", blob, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" });
    if (error) throw error;
  }
  progress(images.length, images.length, "올리는 중");
  if (!start) {
    // 예전에 남은 그림이 있으면 지운다(번호가 꼬이지 않게)
    const { data: old } = await sb.storage.from("slides").list(folder.replace(/\/$/, ""), { limit: 1000 });
    const extra = (old || []).map((o) => o.name).filter((n) => parseInt(n, 10) > images.length).map((n) => folder + n);
    if (extra.length) await sb.storage.from("slides").remove(extra);
  }
  const base = start ? lesson.slide_dir.split("?")[0] : SB_URL + "/storage/v1/object/public/slides/" + folder + "{n}.jpg";
  const { error } = await sb.from("lessons").update({ slide_dir: base + "?v=" + Date.now(), slide_count: start + images.length }).eq("id", lesson.id);
  if (error) throw error;
  return start;
}

// 애니메이션 슬라이드: html 파일마다 「▶ 애니메이션」 그림을 한 쪽씩 끝에 붙이고,
// 그 쪽 자리에 크게 뜨는 시뮬레이션(sim_full)을 만든다. 쪽을 옮기면 시뮬레이션도 따라간다(moveSlide).
async function addHtmlSlides(files, progress) {
  const sims = [];
  for (const f of files) {
    if (!/\.html?$/i.test(f.name)) throw new Error(f.name + ": html 파일만 올릴 수 있습니다.");
    const html = await f.text();
    if (!html.trim()) throw new Error(f.name + ": 빈 파일입니다.");
    if (html.length > 500000) throw new Error(f.name + ": 너무 깁니다(최대 50만 자). 그림을 파일 안에 넣었다면 그림 크기를 줄여 주세요.");
    sims.push({ title: f.name.replace(/\.html?$/i, "").trim().slice(0, 100) || "애니메이션", html });
  }
  const images = [];
  for (const s of sims) images.push(await htmlSlideImage(s.title));
  const start = await appendImages(images, progress);
  const { error } = await sb.from("activities").insert(sims.map((s, i) => ({
    lesson_id: lesson.id, kind: "sim", title: s.title, page: start + i + 1, html: s.html, sim_full: true,
    show_answer: false, named: false, questions: [], sort: activities.length + i,
  })));
  if (error) throw new Error("슬라이드 자리는 만들었지만 애니메이션을 저장하지 못했습니다: " + error.message + " · 「질문·설문 만들기 → 시뮬레이션」에서 " + (start + 1) + "쪽에 직접 넣을 수 있습니다.");
  return sims.length;
}

// 미리보기와 「크게 보기」 전에 잠깐 보이는 자리 표시 그림
function htmlSlideImage(title) {
  const c = h("canvas", { width: SLIDE_WIDTH, height: SLIDE_WIDTH * 9 / 16 });
  const g = c.getContext("2d");
  const W = c.width;
  g.fillStyle = "#1e293b";
  g.fillRect(0, 0, W, c.height);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#fff";
  g.font = "bold 170px sans-serif";
  g.fillText("▶", W / 2, 320);
  g.font = "bold 72px sans-serif";
  let t = title;
  while (t.length > 1 && g.measureText(t).width > W - 200) t = t.slice(0, -1);
  g.fillText(t === title ? t : t.slice(0, -1) + "…", W / 2, 560);
  g.font = "44px sans-serif";
  g.fillStyle = "#cbd5e1";
  g.fillText("애니메이션 슬라이드", W / 2, 670);
  return canvasToJpeg(c);
}

// 수업을 지울 때 그 수업의 슬라이드 그림도 지운다(복제한 다른 수업이 같은 그림을 쓰면 남긴다)
async function removeSlideFiles(l) {
  if (!l.slide_count || !l.slide_dir.includes("/" + l.id + "/")) return;
  if (lessons.some((x) => x.id !== l.id && x.slide_dir.split("?")[0] === l.slide_dir.split("?")[0])) return;
  // 그림을 올린 교사의 폴더(교사가 여러 명일 수 있으므로 주소에서 읽는다)
  const m = /\/public\/slides\/(.+\/)\{n\}/.exec(l.slide_dir);
  if (!m) return;
  const folder = decodeURIComponent(m[1]);
  const { data } = await sb.storage.from("slides").list(folder.replace(/\/$/, ""), { limit: 1000 });
  if (data && data.length) await sb.storage.from("slides").remove(data.map((o) => folder + o.name));
}

// ---------- 학생이 올린 파일 ----------
// 저장소는 비공개라 10분짜리 주소를 받아 연다. 그림·PDF·글은 새 탭에서 보고, 나머지는 원래 이름으로 내려받는다.
async function openFile(f) {
  const view = /^(image\/(jpeg|png|gif|webp)|application\/pdf|text\/plain)$/.test(fileTypeOf(f.path));
  const win = view ? window.open("", "_blank") : null;   // 팝업 차단을 피하려고 누른 즉시 연다
  const { data, error } = await sb.storage.from("submissions").createSignedUrl(f.path, 600, view ? undefined : { download: f.name });
  if (error) {
    if (win) win.close();
    return alert("파일을 열지 못했습니다: " + error.message + (/not found/i.test(error.message) ? " · 수업이나 활동을 지우면서 함께 지워졌을 수 있습니다." : ""));
  }
  if (win) win.location = data.signedUrl;
  else location.href = data.signedUrl;
}

// 활동(또는 수업 전체)을 지울 때 학생이 올린 파일도 지운다. 파일 이름이 「수업/활동_학생_….확장자」 꼴이다.
async function removeSubmissionFiles(lessonId, activityId) {
  const st = sb.storage.from("submissions");
  for (let round = 0; round < 50; round++) {
    const { data, error } = await st.list(lessonId, { limit: 1000, search: activityId || "" });
    if (error || !data || !data.length) return;
    const names = data.filter((o) => o.id && (!activityId || o.name.startsWith(activityId + "_"))).map((o) => lessonId + "/" + o.name);
    if (!names.length) return;
    const r = await st.remove(names);
    if (r.error || data.length < 1000) return;
  }
}

// 학생이 올렸다가 「빼기」 하거나 저장하지 않은 파일은 아무 답에도 없이 저장소만 차지한다.
// 수업을 열 때(한 번만) 올린 지 이틀이 지났는데 어느 답에도 없는 파일을 지운다.
const cleanedLessons = new Set();
async function removeOrphanFiles() {
  if (!lesson || cleanedLessons.has(lesson.id)) return;
  if (!activities.some((a) => (a.questions || []).some((q) => q.type === "file"))) return;
  cleanedLessons.add(lesson.id);
  const lessonId = lesson.id;
  // 답 목록을 새로 받는다. 못 받으면 아무것도 지우지 않는다
  const rs = await sb.from("responses").select("answers").in("activity_id", activities.map((a) => a.id));
  if (rs.error || !rs.data) return;
  const used = new Set();
  for (const r of rs.data) for (const v of Object.values(r.answers || {})) {
    if (Array.isArray(v)) v.forEach((x) => x && x.path && used.add(x.path));
  }
  const st = sb.storage.from("submissions");
  const old = Date.now() - 2 * 24 * 3600 * 1000;
  const gone = [];
  for (let offset = 0; offset < 50000; offset += 1000) {
    const { data, error } = await st.list(lessonId, { limit: 1000, offset });
    if (error || !data) return;
    for (const o of data) {
      const path = lessonId + "/" + o.name;
      if (o.id && !used.has(path) && Date.parse(o.created_at) < old) gone.push(path);
    }
    if (data.length < 1000) break;
  }
  for (let i = 0; i < gone.length; i += 100) await st.remove(gone.slice(i, i + 100));
}

// ---------- CSV ----------
function downloadCSV(acts, fileName) {
  acts = acts.filter((a) => a.kind !== "sim");
  const cell = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const head = ["학번", "이름"];
  acts.forEach((a) => {
    if (a.kind === "quiz") head.push(a.title + " · 점수");
    a.questions.forEach((q, i) => head.push(a.title + " · " + (i + 1) + ". " + q.text));
    head.push(a.title + " · 저장 시각");
  });
  const lines = [head.map(cell).join(",")];
  students.forEach((s) => {
    const row = [s.class_no, s.name];
    acts.forEach((a) => {
      const r = responses.find((x) => x.activity_id === a.id && x.student_id === s.id);
      if (a.kind === "quiz") row.push(r && r.total ? r.score + "/" + r.total : "");
      a.questions.forEach((q) => row.push(r ? answerText(r.answers[q.id]) : ""));
      row.push(r ? new Date(r.updated_at).toLocaleString("ko-KR") : "");
    });
    lines.push(row.map(cell).join(","));
  });
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: fileName.replace(/[\\/:*?"<>|]/g, "_") + ".csv" });
  document.body.append(a);
  a.click();
  a.remove();
}
