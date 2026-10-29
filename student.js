// 학생 화면: 입장(학번 + 이름 + 비밀번호) → 슬라이드를 따라가며 질문에 답한다.
// 3초마다 서버에서 수업 상태를 받아 온다(교사가 넘긴 쪽, 제출 열림, 공개된 응답).

const app = document.getElementById("app");
const params = new URLSearchParams(location.search);
const POLL_MS = 3000;
// 학생 계정은 웹앱 전체에 하나. 한 번 입장한 기기는 열쇠(token)를 기억해서, 새 수업 코드만 넣으면 바로 들어간다.
const TOKEN_KEY = "cra-token";
const ENDED_MSG = "선생님이 수업을 끝냈습니다. 더 이상 이 수업에 들어올 수 없습니다.";
const ME_KEY = "cra-me";
// 이 인터넷 주소(학교 와이파이 등)에서 없는 수업 코드를 많이 넣어 새 수업 들어가기가 잠시 막혔을 때(서버 code_blocked)
const BUSY_MSG = "틀린 수업 코드가 너무 많이 입력되어, 이 와이파이(인터넷)에서는 새 수업 들어가기가 잠시 막혔습니다. 선생님께 말하면 바로 풀 수 있습니다(학생 관리 → 「입장 막힘 풀기」). 이미 들어갔던 수업은 그대로 들어갈 수 있습니다.";
// 여러 사람이 같이 쓰는 기기(학교 컴퓨터·태블릿): 열쇠·이름·쓰던 답을 이 탭에만(sessionStorage) 둔다. 창이나 탭을 닫으면 지워져 다음 사람이 앞 학생으로 들어가지 않는다.
// 한 번 고르면 이 기기는 다음에도 「같이 쓰는 기기」 칸이 체크되어 나온다
const SHARED_KEY = "cra-shared-device";
const sharedDevice = () => localStorage.getItem(SHARED_KEY) === "1";
const keep = () => (sharedDevice() ? sessionStorage : localStorage);

let code = "";          // 수업 코드
let token = null;       // 입장 열쇠(이 기기에 저장)
let state = null;       // 서버에서 받은 수업 상태
let viewing = 1;        // 학생이 보고 있는 쪽
let following = true;   // 교사가 띄운 쪽을 따라가는 중인지
let timer = null;
let shell = null;
const cards = new Map(); // 활동 id → 화면 카드

// 시작은 파일 맨 끝에서 한다(아래쪽 let/const가 모두 만들어진 뒤에 poll이 돌아야 한다)

function start() {
  code = (params.get("c") || localStorage.getItem("cra-last-code") || "").trim();
  // 예전 판은 수업마다 열쇠를 따로 저장했다: 있으면 그대로 옮겨 쓴다
  token = keep().getItem(TOKEN_KEY);
  if (!token && !sharedDevice()) {
    token = code ? localStorage.getItem("cra-token:" + code.toLowerCase()) : null;
    if (token) localStorage.setItem(TOKEN_KEY, token);
  }
  if (token && code) poll();
  else if (token) showCodeOnly();
  else showEntry();
}

function enterLesson(newCode) {
  code = newCode.trim();
  localStorage.setItem("cra-last-code", code);
  state = null;
  following = true;
  poll();
}

// 이미 입장한 기기: 수업 코드만 넣으면 된다
function showCodeOnly(notice) {
  stopPolling();
  shell = null;
  cards.clear();
  const me = keep().getItem(ME_KEY) || "";
  const codeIn = h("input", { type: "text", value: params.get("c") ? "" : code, autocomplete: "off", maxlength: 20, placeholder: "예: K7P2Q", autocapitalize: "characters", required: true });
  const msg = h("p", { class: "msg" }, notice || "");
  app.replaceChildren(h("main", { class: "narrow" },
    h("header", { class: "intro" }, h("p", { class: "eyebrow" }, me ? me + " 학생" : "수업 응답"), h("h1", {}, "수업 코드 입력")),
    h("form", {
      class: "card stack",
      onsubmit(e) {
        e.preventDefault();
        if (!codeIn.value.trim()) return;
        history.replaceState(null, "", "?c=" + encodeURIComponent(codeIn.value.trim()));
        enterLesson(codeIn.value);
      },
    }, h("label", {}, "수업 코드", codeIn), h("button", { class: "primary big", type: "submit" }, "입장하기"), msg),
    h("p", { class: "center" }, h("button", { class: "link", type: "button", onclick() { logout(""); } }, me ? me + " 학생이 아니면: 다른 학생으로 들어가기" : "다른 학생으로 들어가기"))));
  codeIn.focus();
}

// ---------- 입장 ----------
function showEntry(notice) {
  stopPolling();
  shell = null;
  cards.clear();
  const fromLink = !!params.get("c");
  const codeIn = h("input", { type: "text", value: code, autocomplete: "off", maxlength: 20, placeholder: "예: K7P2Q", autocapitalize: "characters", required: true });
  const noIn = h("input", { type: "text", autocomplete: "off", maxlength: 20, inputmode: "numeric", placeholder: "예: 20243030", required: true });
  const nameIn = h("input", { type: "text", autocomplete: "off", maxlength: 20, required: true });
  const pinIn = h("input", { type: "password", inputmode: "numeric", maxlength: 4, autocomplete: "off", required: true });
  const pin2In = h("input", { type: "password", inputmode: "numeric", maxlength: 4, autocomplete: "off" });
  // 처음 들어오는 학생은 두 칸을 한꺼번에 채워 한 번에 입장한다. 이미 비밀번호가 있는 학생은 비워 두면 된다
  // (채워도 서버는 이미 정한 비밀번호와만 비교하므로 바뀌지 않는다).
  const pin2Row = h("label", {}, "비밀번호 한 번 더 ", h("span", { class: "muted small" }, "(처음 들어올 때만)"), pin2In);
  const sharedIn = h("input", { type: "checkbox", checked: sharedDevice() });
  const sharedRow = h("label", { class: "check" }, sharedIn,
    h("span", {}, "여러 사람이 같이 쓰는 기기예요 ", h("span", { class: "muted small" }, "(학교 컴퓨터·태블릿: 창을 닫으면 자동으로 나가집니다)")));
  const msg = h("p", { class: "msg" }, notice || "");
  const btn = h("button", { class: "primary big", type: "submit" }, "입장하기");

  const form = h("form", {
    class: "card stack",
    async onsubmit(e) {
      e.preventDefault();
      const pin = pinIn.value.trim();
      const pin2 = pin2In.value.trim();
      if (!/^\d{4}$/.test(pin)) { msg.textContent = "비밀번호는 숫자 4자리로 입력하세요."; return; }
      if (pin2 && pin2 !== pin) { msg.textContent = "두 비밀번호가 다릅니다. 다시 입력하세요."; pin2In.focus(); return; }
      const confirming = !!pin2;
      btn.disabled = true;
      msg.textContent = "확인 중…";
      const { data, error } = await sb.rpc("student_enter", {
        p_code: codeIn.value, p_class_no: noIn.value, p_name: nameIn.value, p_pin: pin, p_confirm: confirming,
      });
      btn.disabled = false;
      if (error) { msg.textContent = "연결하지 못했습니다. " + NET_HINT + " (" + error.message + ")"; return; }
      const err = data.error;
      if (err === "no_lesson") msg.textContent = "수업 코드를 찾지 못했습니다. 선생님께 받은 코드를 확인하세요.";
      else if (err === "bad_name") msg.textContent = "학번과 이름을 확인하세요(각각 20자까지).";
      else if (err === "bad_pin") msg.textContent = "비밀번호는 숫자 4자리로 입력하세요.";
      else if (err === "full") msg.textContent = "이 수업은 인원이 가득 찼습니다. 선생님께 알려 주세요.";
      else if (err === "ended") msg.textContent = ENDED_MSG;
      else if (err === "busy") msg.textContent = BUSY_MSG;
      else if (err === "need_confirm") {
        pin2In.focus();
        msg.textContent = data.reset
          ? "선생님이 비밀번호를 초기화했습니다. 새 비밀번호를 「비밀번호 한 번 더」 칸에도 입력하고 입장하세요."
          : "처음 들어왔네요(학번·이름이 맞는지 확인하세요). 지금 입력한 번호가 내 비밀번호가 됩니다. 「비밀번호 한 번 더」 칸에도 입력하고 입장하세요.";
      } else if (err === "wrong_pin") msg.textContent = "비밀번호가 틀렸습니다. " + data.left + "번 더 틀리면 10분 동안 잠깁니다.";
      else if (err === "locked") msg.textContent = "비밀번호를 여러 번 틀려 잠겼습니다. " + data.minutes + "분 뒤에 다시 하거나 선생님께 초기화를 부탁하세요.";
      else if (data.token) {
        token = data.token;
        code = data.code;
        localStorage.setItem("cra-last-code", code);
        if (sharedIn.checked) localStorage.setItem(SHARED_KEY, "1"); else localStorage.removeItem(SHARED_KEY);
        localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ME_KEY);
        sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(ME_KEY);
        keep().setItem(TOKEN_KEY, token);
        keep().setItem(ME_KEY, data.class_no + " " + data.name);
        following = true;
        poll();
      } else msg.textContent = "알 수 없는 오류입니다. 다시 시도하세요.";
    },
  },
    fromLink ? null : h("label", {}, "수업 코드", codeIn),
    h("label", {}, "학번", noIn),
    h("label", {}, "이름", nameIn),
    h("label", {}, "비밀번호 (숫자 4자리)", pinIn),
    pin2Row,
    sharedRow,
    h("div", { class: "tip" },
      h("strong", {}, "처음 들어오나요?"),
      h("p", {}, "비밀번호를 두 칸에 똑같이 입력하세요. 처음 입력한 번호가 내 비밀번호가 됩니다. 다른 수업에서도 같은 학번·이름·비밀번호를 씁니다. 휴대폰 비밀번호나 생일은 쓰지 마세요.")),
    btn, msg);

  app.replaceChildren(h("main", { class: "narrow" },
    h("header", { class: "intro" },
      h("p", { class: "eyebrow" }, fromLink ? "수업 코드 " + code : "수업 응답"),
      h("h1", {}, "입장하기")),
    form,
    h("p", { class: "muted small center" }, "비밀번호를 잊었다면 선생님께 말하세요. 초기화해도 쓴 답은 지워지지 않습니다.")));
  (fromLink ? noIn : codeIn).focus();
}

// 나간 순간을 교사 화면 「마지막 접속」에 적는다. 화면을 닫는 중에도 끝까지 가도록 keepalive로 직접 보낸다.
function sendLeave() {
  if (!token || !code || !configured) return;
  try {
    fetch(SB_URL + "/rest/v1/rpc/student_leave", {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", apikey: String(SUPABASE_KEY).trim() },
      body: JSON.stringify({ p_token: token, p_code: code }),
    }).catch(() => {});
  } catch (e) { /* 보내지 못해도 나가는 것은 막지 않는다 */ }
}
window.addEventListener("pagehide", () => { if (shell) sendLeave(); });

// 수업이 끝남: 서버가 학생 열쇠를 지웠으므로 이 기기에서도 나간다. 주소의 수업 코드도 지워 다른 수업 코드를 넣을 수 있게 한다
function lessonEnded() {
  params.delete("c");
  history.replaceState(null, "", location.pathname);
  localStorage.removeItem("cra-last-code");
  if (shell) sendLeave();   // 예전 서버(열쇠를 지우지 않음)에서도 「나감」을 적는다
  shell = null;
  code = "";
  logout(ENDED_MSG);
}

function logout(notice) {
  if (shell) sendLeave();
  if (scr.stream) screenStop(true);
  for (const st of [localStorage, sessionStorage]) {
    st.removeItem(TOKEN_KEY);
    st.removeItem(ME_KEY);
    // 저장하지 않고 쓰던 답도 이 기기에서 지운다(다음 사람에게 남지 않게)
    if (token) Object.keys(st).filter((k) => k.startsWith("cra-draft:" + token + ":")).forEach((k) => st.removeItem(k));
  }
  if (code) localStorage.removeItem("cra-token:" + code.toLowerCase());
  token = null;
  state = null;
  showEntry(notice);
}

// ---------- 서버에서 상태 받기 ----------
function stopPolling() {
  if (scr.stream) screenStop(true);   // 수업을 떠나면 화면 보여 주기도 멈춘다
  closeScreenModal();
  clearTimeout(timer);
  timer = null;
}

// 서버가 아는 방식. setup.sql을 아직 다시 실행하지 않았으면 한 단계씩 예전 방식으로 내려간다
// 2: 바뀐 부분만(p_parts) · 1: 같으면 same만(p_hash) · 0: 늘 통째로
let stateMode = 2;

async function poll() {
  clearTimeout(timer);
  // 지난번에 받은 것의 hash를 보내면, 바뀐 것이 없을 때 서버가 내용 없이 same만 돌려준다
  const call = () => {
    const args = { p_token: token, p_code: code };
    if (stateMode >= 2) args.p_parts = true;
    if (stateMode >= 1 && state && state.hash) args.p_hash = state.hash;
    return sb.rpc("student_state", args);
  };
  let { data, error } = await call();
  while (error && stateMode > 0 && /p_parts|p_hash|function/i.test(error.message || "")) {
    stateMode--;
    ({ data, error } = await call());
  }
  if (!token) return;
  if (!error && data.same) {
    if (!state) return poll();   // 그사이 다른 수업으로 바뀐 경우: hash 없이 다시 받는다
    if (shell) shell.conn.hidden = true;
    timer = setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
    return;
  }
  if (!error && data.error === "no_lesson") return showCodeOnly("수업 코드를 찾지 못했습니다. 선생님께 받은 코드를 확인하세요.");
  if (!error && data.error === "busy") return showCodeOnly(BUSY_MSG);
  if (!error && data.error === "full") return showCodeOnly("이 수업은 인원이 가득 찼습니다. 선생님께 알려 주세요.");
  if (!error && data.error === "ended") return lessonEnded();
  if (error) {
    if (shell) shell.conn.hidden = false;
    else showEntry("연결하지 못했습니다. " + NET_HINT);
  } else if (data.error === "logged_out") {
    return logout("다시 입장해 주세요. 수업이 끝나 로그아웃되었거나, 선생님이 비밀번호를 초기화했거나 학생 정보가 지워졌습니다.");
  } else if (data.error) {
    // 이 화면이 모르는 오류(서버가 더 새것일 때): 상태로 그리지 않고 코드 입력으로 돌아간다
    return showCodeOnly("들어가지 못했습니다(" + data.error + "). 새로고침하거나 선생님께 알려 주세요.");
  } else {
    const full = merge(data);
    if (!full) return poll();   // 바뀐 부분만 왔는데 합칠 예전 상태가 없다: hash 없이 다시 받는다
    apply(full);
  }
  timer = setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
}

// 서버는 바뀐 부분(lesson·me·watch / activities / others)만 보낸다(parts). 지난 상태에 합쳐 온전한 상태를 만든다.
// others(공개된 친구 응답)는 활동마다 a.others 로 붙인다. 예전 서버는 parts 없이 통째로 보낸다.
function merge(data) {
  if (!data.parts) return data;
  const s = Object.assign({}, state || {}, data);
  if (!s.lesson || !s.me || !s.activities || !s.others) return null;
  if (data.activities || data.others) {
    s.activities = s.activities.map((a) => a.shared ? { ...a, others: s.others[a.id] || [] } : a);
  }
  return s;
}
// 키보드 ← → 로 쪽 넘기기(선생님이 띄운 쪽까지만). 글을 쓰는 칸에서는 커서 이동이므로 넘기지 않는다
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
  if (!shell || !state || !state.lesson.slide_count) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const n = viewing + (e.key === "ArrowRight" ? 1 : -1);
  if (n < 1 || n > clampPage(state.lesson.page)) return;
  e.preventDefault();
  go(n);
});
document.addEventListener("visibilitychange", () => {
  if (token && shell) sendLive(true);
  if (!document.hidden && token && shell) poll();
});

// ---------- 선생님에게 보이는 실시간 화면 ----------
// 보고 있는 쪽, 다른 앱으로 나갔는지, 저장하기 전에 쓰고 있는 답을 바뀔 때만(2초에 한 번까지) 보낸다. 교사만 읽는다.
// 교사가 「학생 화면」 탭을 보고 있을 때(state.watch)만 보낸다. 예전 서버(watch 없음)에는 늘 보낸다.
const LIVE_MS = 2000;
const liveDrafts = {};   // 활동 id → 지금 쓰고 있는 답
let liveFocus = null;    // 지금 누르고 있는 활동
let liveSent = "";
let liveAt = 0;
let liveTimer = null;

function liveValue(v) {
  if (typeof v === "string") return v.slice(0, 1500);
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => x && typeof x === "object" ? { name: String(x.name || "파일").slice(0, 100) } : String(x).slice(0, 200));
  return v ?? null;
}

function liveNow(onlyFocus) {
  const drafts = {};
  for (const [id, values] of Object.entries(liveDrafts)) {
    if (onlyFocus && id !== liveFocus) continue;
    const d = {};
    for (const [q, v] of Object.entries(values)) d[q] = liveValue(v);
    drafts[id] = d;
  }
  return { page: state.lesson.slide_count ? viewing : null, following, hidden: document.hidden, focus: liveFocus, drafts };
}

function sendLive(now) {
  clearTimeout(liveTimer);
  if (!token || !state || !shell || state.watch === false) return;
  const wait = liveAt + LIVE_MS - Date.now();
  if (wait > 0 && !now) { liveTimer = setTimeout(sendLive, wait); return; }
  let live = liveNow(false);
  // 서버는 20000바이트까지 받는다. 넘치면 지금 쓰고 있는 활동만 보낸다
  if (new TextEncoder().encode(JSON.stringify(live)).length > 18000) live = liveNow(true);
  const body = JSON.stringify(live);
  if (body === liveSent) return;
  liveSent = body;
  liveAt = Date.now();
  sb.rpc("student_live", { p_token: token, p_code: code, p_live: live }).then(() => {}, () => { liveSent = ""; });
}

// ---------- 화면 전체 보여 주기(학생이 동의할 때만) ----------
// 교사가 요청하면(screen.state = asked) 무엇이 보이고 무엇은 할 수 없는지 알리는 창을 띄우고, 학생이 읽고 동의해야만 시작한다.
// 영상은 서버를 거치지 않고 WebRTC로 교사 브라우저에 바로 간다. 서버(student_screen)에는 연결 약속(SDP)만 적는다.
const scr = { ask: null, stream: null, pc: null, key: null, seen: new Set(), modal: null, bar: null, waitTimer: null, renewAt: null };

function screenRpc(ask, st, extra) {
  return sb.rpc("student_screen", Object.assign({ p_token: token, p_code: code, p_ask: ask, p_state: st || null }, extra || {}));
}

function handleScreen(sc) {
  if (!sc || !sc.ask) return;
  const sharing = scr.stream && scr.stream.active;
  if (sc.state === "asked") {
    // 이미 동의해 보여 주는 중: 새 요청에도 그대로 잇는다(같은 요청이면 늦게 온 예전 상태이므로 무시)
    if (sharing) { if (sc.ask !== scr.ask) { scr.ask = sc.ask; screenOffer(); } return; }
    if (scr.seen.has(sc.ask)) return;
    scr.seen.add(sc.ask);
    if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
      screenRpc(sc.ask, "unsupported");
      screenNotice("선생님이 화면 보기를 요청했지만, 이 기기(휴대폰·태블릿 등)에서는 화면을 보여 줄 수 없습니다. 선생님께는 「이 기기에서는 안 됨」으로만 알려졌습니다.");
      return;
    }
    screenConsent(sc.ask);
  } else if (sc.state === "ended") {
    if (sharing || scr.modal) {
      closeScreenModal();
      screenStop(false);
      screenNotice("선생님이 화면 보기를 끝냈습니다. 이제 내 화면은 보이지 않습니다.");
    }
  } else if (sc.state === "renew") {
    if (scr.renewAt === sc.at) return;   // 이미 답한 다시 연결 요청
    scr.renewAt = sc.at;
    if (sharing && sc.ask === scr.ask) screenOffer();
    else if (!sharing) screenRpc(sc.ask, "stopped");
  } else if (["offer", "answer", "live", "failed"].includes(sc.state)) {
    // 새로고침 등으로 보여 주던 화면이 없어졌다
    if (!sharing) screenRpc(sc.ask, "stopped");
    else if (sc.state === "answer" && scr.pc && scr.pc.signalingState === "have-local-offer") screenWaitAnswer(scr.key);
  }
}

function screenNotice(text) {
  const box = h("div", { class: "overlay screen-overlay" },
    h("div", { class: "modal screen-modal" },
      h("div", { class: "modal-body stack" }, h("p", {}, text),
        h("button", { class: "primary", type: "button", onclick() { box.remove(); } }, "확인"))));
  document.body.append(box);
}

function closeScreenModal() {
  if (scr.modal) scr.modal.remove();
  scr.modal = null;
}

// 동의 창: 다 읽고 확인란에 표시해야 「동의」를 누를 수 있다
function screenConsent(ask) {
  closeScreenModal();
  const check = h("input", { type: "checkbox" });
  const agree = h("button", { class: "primary", type: "button", disabled: true }, "동의하고 보여 줄 화면 고르기");
  const msg = h("p", { class: "msg" });
  check.addEventListener("change", () => { agree.disabled = !check.checked; });
  const decline = h("button", { class: "ghost", type: "button", onclick() {
    closeScreenModal();
    screenRpc(ask, "declined");
    screenNotice("거절했습니다. 선생님께는 「거절함」으로만 알려지고, 수업 참여와 답 제출은 그대로 할 수 있습니다.");
  } }, "거절");
  agree.addEventListener("click", async () => {
    agree.disabled = decline.disabled = true;
    msg.textContent = "다음에 뜨는 창에서 「전체 화면」(화면 전체)을 고르고 「공유」를 누르세요.";
    const err = await screenStart(ask);
    if (!err) { closeScreenModal(); return; }
    msg.textContent = err;
    agree.textContent = "다시 고르기";
    agree.disabled = !check.checked;
    decline.disabled = false;
  });
  scr.modal = h("div", { class: "overlay screen-overlay" },
    h("div", { class: "modal screen-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "screen-title" },
      h("div", { class: "modal-head" }, h("h2", { id: "screen-title" }, "🖥 선생님이 내 화면 전체를 보려고 합니다")),
      h("div", { class: "modal-body stack" },
        h("p", {}, "동의하면 ", h("strong", {}, "이 컴퓨터 모니터에 보이는 모든 것"), "이 선생님 화면에 실시간 영상으로 보입니다. 이 수업 창뿐 아니라 ",
          h("strong", {}, "다른 창·다른 프로그램·알림·바탕화면"), "도 모두 보입니다. 소리는 보내지 않습니다."),
        h("div", { class: "tip screen-cannot" },
          h("strong", {}, "선생님이 할 수 없는 것"),
          h("ul", {},
            h("li", {}, "내 컴퓨터의 마우스·키보드를 움직이거나 조작하는 것"),
            h("li", {}, "내 컴퓨터의 파일·사진·프로그램을 열거나, 복사하거나, 지우는 것"),
            h("li", {}, "비밀번호·저장된 개인 정보·다른 사이트 계정에 들어가는 것"),
            h("li", {}, "카메라·마이크를 켜는 것")),
          h("p", { class: "small" }, "선생님은 화면을 ", h("strong", {}, "보기만"), " 할 수 있습니다.")),
        h("ul", { class: "small" },
          h("li", {}, "이 앱은 화면 영상을 서버에 저장하거나 녹화하지 않습니다. 영상은 선생님 컴퓨터로 바로 갑니다."),
          h("li", {}, "다만 선생님 화면에 보이는 것은 사진으로 찍힐 수 있으니, 보이고 싶지 않은 창(메신저, 개인 사이트 등)은 먼저 닫으세요."),
          h("li", {}, "보여 주는 동안 화면 맨 위에 빨간 띠가 보이고, 「멈추기」를 누르면 바로 멈춥니다. 브라우저의 「공유 중지」를 누르거나 이 창을 닫아도 멈춥니다."),
          h("li", {}, "거절해도 됩니다. 선생님께는 「거절함」으로만 알려지고, 수업 참여와 답 제출은 그대로 할 수 있습니다.")),
        h("label", { class: "check screen-check" }, check, " 위 내용을 모두 읽고 이해했습니다"),
        h("div", { class: "row wrap" }, decline, h("span", { class: "spacer" }), agree),
        msg)));
  document.body.append(scr.modal);
}

// 화면 고르기 → 전체 화면이 아니면 다시 고르게 한다. 실패하면 알릴 글을 돌려준다
async function screenStart(ask) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "monitor", frameRate: { ideal: 8, max: 10 } }, audio: false,
      monitorTypeSurfaces: "include", surfaceSwitching: "exclude", selfBrowserSurface: "include",
    });
  } catch (e) {
    return "화면을 고르지 않았습니다. 보여 주려면 다시 누르고, 원하지 않으면 「거절」을 누르세요.";
  }
  const track = stream.getVideoTracks()[0];
  const surface = track && track.getSettings ? track.getSettings().displaySurface : null;
  if (surface && surface !== "monitor") {
    stream.getTracks().forEach((t) => t.stop());
    return "선생님이 요청한 것은 「전체 화면」입니다. 창이나 탭이 아니라 「전체 화면」을 골라 주세요.";
  }
  track.contentHint = "detail";
  track.addEventListener("ended", () => screenStop(true));   // 브라우저의 「공유 중지」
  scr.stream = stream;
  scr.ask = ask;
  showScreenBar("연결하는 중…");
  screenOffer();
  return null;
}

// 연결 정보(offer)를 만들어 서버에 적고, 교사의 답(answer)을 기다린다
async function screenOffer() {
  const track = scr.stream && scr.stream.getVideoTracks()[0];
  if (!track) return;
  if (scr.pc) scr.pc.close();
  const pc = new RTCPeerConnection({ iceServers: SCREEN_ICE });
  scr.pc = pc;
  const key = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  scr.key = key;
  const st = track.getSettings ? track.getSettings() : {};
  // 전송량을 줄이려고 가로 1280px 이하, 1초 8장 이하로 보낸다
  pc.addTransceiver(track, { direction: "sendonly", streams: [scr.stream],
    sendEncodings: [{ maxBitrate: 600000, maxFramerate: 8, scaleResolutionDownBy: Math.max(1, (st.width || 1280) / 1280) }] });
  pc.addEventListener("connectionstatechange", () => {
    if (scr.pc !== pc || scr.key !== key) return;
    if (pc.connectionState === "connected") { showScreenBar(); screenRpc(scr.ask, "live", { p_key: key }); }
    if (pc.connectionState === "failed") { showScreenBar("선생님과 연결이 끊겼습니다. 선생님이 다시 연결하면 이어서 보입니다."); screenRpc(scr.ask, "failed", { p_key: key }); }
  });
  await pc.setLocalDescription(await pc.createOffer());
  await iceDone(pc);
  if (scr.pc !== pc) return;
  const { data, error } = await screenRpc(scr.ask, "offer", { p_offer: pc.localDescription.sdp, p_key: key });
  if (error || (data && data.error)) { showScreenBar("선생님께 연결하지 못했습니다. 잠시 뒤 선생님이 다시 요청하면 이어집니다."); return; }
  screenWaitAnswer(key);
}

// 교사의 답을 1초마다(최대 1분) 묻는다
function screenWaitAnswer(key) {
  clearTimeout(scr.waitTimer);
  const until = Date.now() + 60000;
  const tick = async () => {
    if (scr.key !== key || !scr.pc || scr.pc.signalingState !== "have-local-offer") return;
    const { data } = await screenRpc(scr.ask, null);
    if (scr.key !== key || !scr.pc || scr.pc.signalingState !== "have-local-offer") return;
    if (data && data.key === key && data.answer) {
      try { await scr.pc.setRemoteDescription({ type: "answer", sdp: data.answer }); } catch (e) { console.error(e); }
      return;
    }
    if (data && data.state === "ended") return;
    if (Date.now() < until) scr.waitTimer = setTimeout(tick, 1000);
    else showScreenBar("선생님 화면이 응답하지 않습니다. 선생님이 「학생 화면」 탭을 열면 이어집니다.");
  };
  scr.waitTimer = setTimeout(tick, 800);
}

// 보여 주기 멈춤. byStudent면 서버에도 「멈춤」을 적는다
function screenStop(byStudent) {
  clearTimeout(scr.waitTimer);
  if (scr.pc) scr.pc.close();
  if (scr.stream) scr.stream.getTracks().forEach((t) => t.stop());
  const ask = scr.ask;
  scr.pc = scr.stream = scr.key = null;
  if (scr.bar) { scr.bar.remove(); scr.bar = null; }
  if (byStudent && ask) screenRpc(ask, "stopped");
}

// 보여 주는 동안 늘 화면 맨 위에 보이는 빨간 띠
function showScreenBar(extra) {
  if (!scr.bar) {
    scr.bar = h("div", { class: "screen-bar", role: "status" },
      h("span", { class: "screen-bar-text" }),
      h("button", { type: "button", onclick() { screenStop(true); screenNotice("화면 보여 주기를 멈췄습니다. 이제 내 화면은 선생님께 보이지 않습니다."); } }, "■ 멈추기"));
    document.body.prepend(scr.bar);
  }
  scr.bar.querySelector(".screen-bar-text").textContent = extra
    ? "● 화면 보여 주기 켜짐 · " + extra
    : "● 선생님이 지금 내 화면 전체를 보고 있습니다 (보기만 가능, 조작 불가)";
}

function apply(data) {
  const before = state;
  state = data;
  handleScreen(data.screen);
  if (!shell) buildShell();
  shell.conn.hidden = true;
  const teacherPage = clampPage(data.lesson.page);
  if (!before || following) viewing = teacherPage;
  if (viewing > teacherPage) viewing = teacherPage;   // 교사가 앞쪽으로 되돌아간 경우
  following = viewing === teacherPage;
  // 교사가 「학생 화면」을 막 열었으면 바뀐 게 없어도 지금 모습을 바로 보낸다
  if (data.watch && !(before && before.watch)) liveSent = "";
  render(!before || before.lesson.page !== data.lesson.page);
}

function clampPage(n) {
  const max = Math.max(state.lesson.slide_count, 1);
  return Math.min(Math.max(n || 1, 1), max);
}

// ---------- 화면 ----------
function buildShell() {
  const img = h("img", { class: "slide", alt: "", title: "누르면 크게 보기", onclick: zoom });
  const prev = h("button", { class: "ghost", type: "button", onclick() { go(viewing - 1); } }, "◀ 이전");
  const next = h("button", { class: "ghost", type: "button", onclick() { go(viewing + 1); } }, "다음 ▶");
  const where = h("span", { class: "where" });
  const back = h("button", { class: "primary", type: "button", onclick() { go(state.lesson.page); } }, "선생님과 같은 쪽으로");
  const closed = h("p", { class: "banner" }, "지금은 제출이 닫혀 있습니다. 쓴 내용은 이 기기에 남아 있으니, 선생님이 열면 저장하세요.");
  const conn = h("p", { class: "banner bad", hidden: true }, "연결이 끊겼습니다. 다시 연결하는 중…");
  const title = h("strong", {});
  const who = h("span", {});
  const simStage = h("div", { class: "sim-stage", hidden: true });
  const simLayer = slideLayer(img);   // 슬라이드 위 정한 자리에 얹는 시뮬레이션
  const slideBox = h("div", { class: "slide-box" }, img, simLayer, simStage,
    h("nav", { class: "pager" }, prev, where, next, back, h("span", { class: "spacer" }),
      h("button", { class: "ghost", type: "button", onclick: zoom }, "크게 보기")),
    h("p", { class: "muted small" }, "다음 쪽은 선생님이 넘기면 자동으로 열립니다. 키보드 ← → 키로도 넘길 수 있습니다."));
  const list = h("div", { class: "stack" });
  app.replaceChildren(
    h("header", { class: "top" }, h("div", { class: "top-title" }, title, who),
      h("div", { class: "row" },
        h("button", { class: "link", type: "button", onclick() { history.replaceState(null, "", location.pathname); showCodeOnly(); } }, "다른 수업"),
        h("button", { class: "link", type: "button", onclick() { logout("나갔습니다. 다시 들어오려면 입장하세요."); } }, "나가기"))),
    h("main", { class: "lesson" }, conn, closed, slideBox, list),
    h("p", { class: "muted small center live-note" }, "선생님은 수업 중에 내가 보고 있는 쪽과 저장하기 전에 쓰고 있는 답을 볼 수 있습니다. 화면 전체는 내가 동의할 때만 보이고, 선생님은 보기만 할 뿐 내 컴퓨터를 조작할 수 없습니다."));
  const anytimeHead = h("h2", { class: "section-head" }, "언제든 할 수 있는 활동");
  const empty = h("p", { class: "muted center" });
  shell = { img, simStage, simLayer, prev, next, where, back, closed, conn, title, who, slideBox, list, anytimeHead, empty, stageSim: null, stageKey: "" };
}

// 슬라이드를 화면 가득 띄운다. 누르거나 Esc로 닫는다. 선생님이 쪽을 넘기면 띄운 그림도 바뀐다.
function zoom() {
  if (shell.stageSim) {
    const a = shell.stageSim;
    return loadSim(a).then((html) => openSimFull(a.title, html));
  }
  if (shell.zoom) return;
  const big = h("img", { src: slideSrc(state.lesson, viewing, slideSize()), alt: shell.img.alt });
  const box = h("div", { class: "slide-zoom", onclick: close }, big, h("p", {}, "눌러서 닫기 · 휴대폰은 가로로 돌리면 더 크게 보입니다"));
  function close() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    box.remove();
    document.removeEventListener("keydown", esc);
    document.removeEventListener("fullscreenchange", left);
    shell.zoom = null;
  }
  const esc = (e) => { if (e.key === "Escape") close(); };
  const left = () => { if (!document.fullscreenElement) close(); };
  document.addEventListener("keydown", esc);
  document.body.append(box);
  shell.zoom = big;
  if (box.requestFullscreen) box.requestFullscreen().then(() => document.addEventListener("fullscreenchange", left)).catch(() => {});
}

function go(n) {
  viewing = clampPage(Math.min(n, state.lesson.page));
  following = viewing === clampPage(state.lesson.page);
  render(true);
  scrollTo(0, 0);
}

function render(pageChanged) {
  const L = state.lesson;
  const hasSlides = L.slide_count > 0;
  shell.title.textContent = L.title;
  shell.who.textContent = state.me.class_no + " " + state.me.name;
  shell.closed.hidden = L.open;
  shell.slideBox.hidden = !hasSlides;
  if (hasSlides) {
    const src = slideSrc(L, viewing, slideSize(shell.img));
    // 화면 넘김 효과: 앞으로 가면 그 쪽의 효과, 뒤로 가면 떠나는 쪽의 효과를 거꾸로. 애니메이션 쪽으로 갈 때는 바로 바꾼다
    const dir = shell.shownPage && viewing < shell.shownPage ? -1 : 1;
    const fullHere = state.activities.some((a) => a.kind === "sim" && a.sim_full && onPage(a, viewing));
    const fx = fullHere || shell.shownPage === viewing ? null : transitionFor(L, dir > 0 ? viewing : shell.shownPage);
    changeSlide(shell.img, src, fx, dir, [shell.simLayer]);
    if (shell.zoom) changeSlide(shell.zoom, slideSrc(L, viewing, slideSize()), fx, dir);
    shell.shownPage = viewing;
    shell.img.alt = "슬라이드 " + viewing;
    shell.where.textContent = viewing + " / " + L.slide_count;
    shell.prev.disabled = viewing <= 1;
    shell.next.disabled = viewing >= clampPage(L.page);
    shell.back.hidden = following;
  }

  // 슬라이드가 없는 수업은 활동을 모두 보여 준다
  const acts = state.activities;
  // 큰 화면에서는 슬라이드와 질문을 나란히(split), 슬라이드가 없으면 가운데 한 줄(single)
  shell.slideBox.parentNode.className = "lesson " + (hasSlides ? "split" : "single");
  let here = hasSlides ? acts.filter((a) => onPage(a, viewing)) : acts;
  const anytime = hasSlides ? acts.filter((a) => a.page == null) : [];
  // 「슬라이드 자리에 띄우기」 시뮬레이션은 슬라이드 그림 대신 위쪽에 크게 보인다
  const stageSim = hasSlides ? here.find((a) => a.kind === "sim" && a.sim_full) : null;
  showStageSim(stageSim);
  if (stageSim) here = here.filter((a) => a !== stageSim);
  // 「슬라이드 위 정한 자리」 시뮬레이션은 카드 대신 슬라이드 위에 얹는다
  const boxed = hasSlides && !stageSim ? here.filter((a) => a.kind === "sim" && !a.sim_full && validSimBox(a.sim_box)) : [];
  showSimBoxes(shell.simLayer, boxed, loadSim, (a) => loadSim(a).then((html) => openSimFull(a.title, html)));
  if (boxed.length) here = here.filter((a) => !boxed.includes(a));
  const els = here.map(cardFor);
  if (anytime.length) els.push(shell.anytimeHead, anytime.map(cardFor));
  if (!here.length && !anytime.length) {
    shell.empty.textContent = hasSlides ? "이 쪽에는 질문이 없습니다." : "아직 활동이 없습니다.";
    els.push(shell.empty);
  }
  // 같은 카드들이면 그대로 둔다(다시 끼우면 쓰고 있던 칸의 커서가 빠진다)
  if (pageChanged || shell.list.childElementCount !== els.flat().length || els.flat().some((el, i) => shell.list.children[i] !== el)) {
    shell.list.replaceChildren(...els.flat());
  }
  sendLive();   // 바뀐 것이 없으면 보내지 않는다
}

// ---------- 시뮬레이션 ----------
const simCache = new Map();   // 활동 id → { ver, html }

async function loadSim(a) {
  const hit = simCache.get(a.id);
  if (hit && hit.ver === a.html_ver) return hit.html;
  const { data, error } = await sb.rpc("student_sim", { p_token: token, p_activity: a.id });
  if (error) throw error;
  const html = typeof data === "string" ? data : "";
  simCache.set(a.id, { ver: a.html_ver, html });
  return html;
}

function showStageSim(a) {
  shell.stageSim = a || null;
  shell.img.hidden = !!a;
  shell.simStage.hidden = !a;
  const key = a ? a.id + ":" + a.html_ver : "";
  if (key === shell.stageKey) return;
  shell.stageKey = key;
  shell.simStage.replaceChildren();
  if (!a) return;
  const f = simFrame(null, a.title);
  shell.simStage.append(f);
  loadSim(a).then((html) => { if (shell.stageKey === key) f.srcdoc = html; })
    .catch(() => shell.simStage.replaceChildren(h("p", { class: "error" }, "시뮬레이션을 불러오지 못했습니다. 새로고침해 보세요.")));
}

// 슬라이드 아래에 붙는 시뮬레이션 카드
function simCard(a) {
  let c = cards.get(a.id);
  if (!c) {
    c = { el: h("section", { class: "card activity" }), key: "" };
    cards.set(a.id, c);
  }
  const key = a.title + ":" + a.html_ver;
  if (c.key !== key) {
    c.key = key;
    const f = simFrame(null, a.title);
    c.el.replaceChildren(
      h("div", { class: "card-head" }, h("h2", {}, a.title), h("span", { class: "badge" }, "시뮬레이션")),
      h("p", { class: "muted small" }, "직접 조작해 보세요. 화면이 작으면 「화면 가득 보기」를 누르세요."),
      h("button", { class: "primary", type: "button", onclick() { loadSim(a).then((html) => openSimFull(a.title, html)); } }, "화면 가득 보기"),
      f);
    loadSim(a).then((html) => { if (c.key === key) f.srcdoc = html; })
      .catch(() => f.replaceWith(h("p", { class: "error" }, "시뮬레이션을 불러오지 못했습니다. 새로고침해 보세요.")));
  }
  return c.el;
}

// ---------- 파일 답 ----------
// 고르면 바로 올리고, 답(values)에는 올린 자리와 이름만 적는다. 「저장하기」를 눌러야 제출된다.
// 올릴 자리는 서버가 정해 준다(student_upload_ticket): 학생은 그 자리에만 올릴 수 있고, 남의 파일은 볼 수 없다.
function fileField(a, q, label, values, locked, changed) {
  const list = h("div", { class: "file-list" });
  const msg = h("p", { class: "small" });
  const input = h("input", { type: "file", multiple: true, accept: fileAccept(q), hidden: locked, onchange: pick });
  const files = () => [].concat(values[q.id] ?? []);
  const draw = () => list.replaceChildren(...files().map((f, i) => h("div", { class: "file-item" },
    h("span", { class: "file-name" }, f.name), h("span", { class: "muted small" }, fileSize(f.size)),
    locked ? null : h("button", { class: "link danger", type: "button", onclick() {
      values[q.id] = files().filter((_, j) => j !== i);
      draw();
      changed();
    } }, "빼기"))));

  async function pick() {
    const picked = [...input.files];
    input.value = "";
    if (!picked.length) return;
    if (!state.lesson.open) { msg.className = "error small"; msg.textContent = "지금은 제출이 닫혀 있어서 올릴 수 없습니다."; return; }
    if (files().length + picked.length > FILE_COUNT) { msg.className = "error small"; msg.textContent = "파일은 " + FILE_COUNT + "개까지 올릴 수 있습니다."; return; }
    input.disabled = true;
    msg.className = "status";
    try {
      for (const original of picked) {
        msg.textContent = "올리는 중… " + original.name;
        const f = await shrinkImage(original);
        const ext = fileExt(f.name);
        const type = FILE_TYPES[ext];
        if (!type || (q.accept === "image" && !type.startsWith("image/"))) throw new Error(original.name + ": " + (q.accept === "image" ? "사진만 올릴 수 있습니다." : "올릴 수 없는 파일 종류입니다."));
        if (f.size > FILE_MAX) throw new Error(original.name + ": " + fileSize(FILE_MAX) + "가 넘습니다.");
        const { data, error } = await sb.rpc("student_upload_ticket", { p_token: token, p_activity: a.id, p_ext: ext });
        if (error) throw error;
        if (data.error === "logged_out") return logout("다시 입장해 주세요.");
        if (data.error) throw new Error({ closed: "지금은 제출이 닫혀 있습니다.", ended: ENDED_MSG, already: "이미 제출한 퀴즈입니다.", too_many: "잠시 뒤에 다시 올리세요(한 시간에 40개까지)." }[data.error] || data.error);
        const up = await sb.storage.from("submissions").upload(data.path, f, { contentType: type, upsert: false });
        if (up.error) throw up.error;
        values[q.id] = files().concat({ path: data.path, name: f.name, size: f.size });
        draw();
        changed();
      }
      msg.textContent = "올렸습니다. 아래 「저장하기」를 눌러야 제출됩니다.";
    } catch (e) {
      msg.className = "error small";
      msg.textContent = "올리지 못했습니다: " + (e.message || e);
    }
    input.disabled = false;
  }

  draw();
  return h("div", { class: "stack" },
    h("p", { class: "q-label" }, label),
    locked ? null : h("label", { class: "file-pick" }, q.accept === "image" ? "사진 고르기 · 찍기" : "파일 고르기", input),
    locked ? null : h("p", { class: "muted small" }, (q.accept === "image" ? "사진" : "사진, PDF, 한글·워드·엑셀·PPT 등") + " · " + FILE_COUNT + "개까지 · 한 개에 " + fileSize(FILE_MAX) + "까지"),
    list, msg);
}

// 휴대폰 사진은 커서 가로세로 2000px JPG로 줄여 올린다. 줄이지 못하면(예: 일부 브라우저의 HEIC) 원본 그대로.
async function shrinkImage(f) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(f.type) || f.size < 1500000) return f;
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = h("canvas", { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
    if (!blob || blob.size >= f.size) return f;
    return new File([blob], f.name.replace(/\.[^.]*$/, "") + ".jpg", { type: "image/jpeg" });
  } catch (_) { return f; }
}

// ---------- 활동 카드 ----------
function draftKey(a) { return "cra-draft:" + token + ":" + a.id; }

function cardFor(a) {
  if (a.kind === "sim") return simCard(a);
  let c = cards.get(a.id);
  if (!c) {
    c = { el: h("section", { class: "card activity" }), form: h("div", { class: "stack" }), others: h("div", {}) };
    c.el.append(c.form, c.others);
    cards.set(a.id, c);
  }
  c.a = a;
  const formSig = JSON.stringify([a.title, a.kind, a.questions, a.saved_at, a.score]);
  if (formSig !== c.formSig) {
    c.formSig = formSig;
    buildForm(c);
  }
  c.refresh();
  // 친구들의 응답: 선생님이 고른 질문(shared_q)만. 서버도 그 질문의 답만 보낸다
  const only = a.shared_q || null;
  const show = a.shared && !isInfoActivity(a) && (!only || only.length > 0);
  const othersSig = JSON.stringify(show ? [a.others, a.questions, only, a.named] : null);
  if (othersSig !== c.othersSig) {
    c.othersSig = othersSig;
    c.others.replaceChildren(...(show ? [
      h("div", { class: "others" },
        h("h3", {}, "친구들의 응답"),
        h("p", { class: "muted small" }, "선생님이 공개한 질문만 보입니다 · " + (a.named ? "이름과 함께" : "이름 없이") + " · " + (a.others || []).length + "명"),
        summaryView(a.questions, a.others || [], { only })),
    ] : []));
  }
  return c.el;
}

function buildForm(c) {
  const a = c.a;
  if (isInfoActivity(a)) {
    c.refresh = () => {};
    // replaceChildren은 null을 글자 "null"로 넣으므로 빈 것은 빼고 넣는다
    c.form.replaceChildren(...[
      h("div", { class: "card-head" }, h("h2", {}, a.title), h("span", { class: "badge" }, "설명 카드")),
      activityDescription(a) ? linkedDescription(activityDescription(a)) : null,
      ...a.questions.map((q) => linkedDescription(q.text))].filter(Boolean));
    return;
  }
  const quizDone = a.kind === "quiz" && !!a.mine;
  // 고치는 중인 내용(이 기기에 저장). 서버에 더 나중에 저장된 것이 있으면 그것을 쓴다.
  let draft = null;
  try { draft = JSON.parse(keep().getItem(draftKey(a)) || "null"); } catch (e) { draft = null; }
  if (draft && a.saved_at && draft.at < Date.parse(a.saved_at)) draft = null;
  const values = Object.assign({}, a.mine || {}, draft ? draft.values : {});
  if (draft && !quizDone) { liveDrafts[a.id] = values; sendLive(); } else delete liveDrafts[a.id];
  if (!c.liveHooked) {
    c.liveHooked = true;
    c.form.addEventListener("focusin", () => { if (liveFocus !== c.a.id) { liveFocus = c.a.id; sendLive(); } });
  }
  const err = h("p", { class: "error" });
  const status = h("p", { class: "status" });
  const btn = h("button", { class: "primary big", type: "button" });
  let sending = false;

  const saveDraft = () => {
    keep().setItem(draftKey(a), JSON.stringify({ at: Date.now(), values }));
    liveDrafts[a.id] = values;
    liveFocus = a.id;
    sendLive();
    err.textContent = "";
    c.refresh();
  };
  const asked = askedQuestions(a);
  const dirty = () => asked.some((q) => JSON.stringify(values[q.id] ?? "") !== JSON.stringify((a.mine || {})[q.id] ?? ""));

  let num = 0;
  const rows = a.questions.map((q) => {
    // 설명 칸: 답을 받지 않고 글(링크 포함)만 보인다
    if (q.type === "info") return linkedDescription(q.text);
    const label = (++num) + ". " + q.text;
    let control;
    if (q.type === "choice" || q.type === "multi") {
      const picked = () => [].concat(values[q.id] ?? []);
      control = h("fieldset", { class: "options" }, h("legend", {}, label), q.options.map((o) => {
        const right = quizDone && q.answer != null && [].concat(q.answer).includes(o);
        return h("label", { class: "option" + (right ? " right" : "") },
          h("input", {
            type: q.type === "choice" ? "radio" : "checkbox", name: a.id + "-" + q.id, checked: picked().includes(o), disabled: quizDone,
            onchange(e) {
              if (q.type === "choice") values[q.id] = o;
              else values[q.id] = q.options.filter((x) => (x === o ? e.target.checked : picked().includes(x)));
              saveDraft();
            },
          }),
          h("span", {}, o), right ? h("strong", { class: "right-mark" }, "정답") : null);
      }));
    } else if (q.type === "file") {
      control = fileField(a, q, label, values, quizDone, saveDraft);
    } else {
      const input = q.type === "short"
        ? h("input", { type: "text", maxlength: 200, value: values[q.id] || "", disabled: quizDone })
        : h("textarea", { rows: 4, maxlength: 2000, disabled: quizDone }, values[q.id] || "");
      input.addEventListener("input", () => { values[q.id] = input.value; saveDraft(); });
      control = h("label", {}, label, input);
    }
    const result = quizDone && q.answer != null
      ? h("p", { class: JSON.stringify(values[q.id]) === JSON.stringify(q.answer) ? "ok small" : "error small" },
        JSON.stringify(values[q.id]) === JSON.stringify(q.answer) ? "맞았습니다." : "정답: " + answerText(q.answer))
      : null;
    const explain = quizDone && q.explain ? h("p", { class: "tip small" }, "해설: " + q.explain) : null;
    return h("div", { class: "question" }, control, result, explain);
  });

  async function save() {
    const missing = asked.findIndex((q) => isEmptyAnswer(values[q.id]));
    if (missing >= 0) { err.textContent = (missing + 1) + "번 질문에 답해 주세요."; return; }
    if (a.kind === "quiz" && !confirm("퀴즈는 한 번만 제출할 수 있습니다. 제출할까요?")) return;
    const answers = {};
    asked.forEach((q) => { answers[q.id] = typeof values[q.id] === "string" ? values[q.id].trim() : values[q.id]; });
    sending = true;
    c.refresh();
    const { data, error } = await sb.rpc("student_save", { p_token: token, p_activity: a.id, p_answers: answers });
    sending = false;
    if (error) err.textContent = "저장하지 못했습니다. 다시 시도하세요. (" + error.message + ")";
    else if (data.error === "closed") err.textContent = "지금은 제출이 닫혀 있습니다. 선생님이 열면 다시 저장하세요.";
    else if (data.error === "ended") return lessonEnded();
    else if (data.error === "already") err.textContent = "이미 제출한 퀴즈입니다.";
    else if (data.error === "bad_file") err.textContent = "올린 파일을 확인하지 못했습니다. 파일을 빼고 다시 올려 주세요.";
    else if (data.error === "logged_out") return logout("다시 입장해 주세요.");
    else if (data.error) err.textContent = "저장하지 못했습니다. (" + data.error + ")";
    else {
      keep().removeItem(draftKey(a));
      delete liveDrafts[a.id];
      sendLive();
      c.formSig = null;   // 저장한 내용으로 다시 그린다
      return poll();
    }
    c.refresh();
  }
  btn.addEventListener("click", save);

  // 저장한 내 응답 지우기(퀴즈는 한 번만 내므로 없음). 제출이 열려 있을 때만
  const unsaveBtn = h("button", { class: "link danger", type: "button", hidden: true }, "내 응답 지우기");
  unsaveBtn.addEventListener("click", async () => {
    if (!confirm("저장한 내 응답을 지울까요? 선생님 화면에서도 사라지고, 되돌릴 수 없습니다.")) return;
    sending = true;
    c.refresh();
    const { data, error } = await sb.rpc("student_unsave", { p_token: token, p_activity: a.id });
    sending = false;
    if (error) err.textContent = /student_unsave|function/i.test(error.message) ? "아직 응답 지우기를 쓸 수 없습니다. 선생님께 알려 주세요." : "지우지 못했습니다. 다시 시도하세요. (" + error.message + ")";
    else if (data.error === "closed") err.textContent = "지금은 제출이 닫혀 있어서 지울 수 없습니다.";
    else if (data.error === "ended") return lessonEnded();
    else if (data.error === "logged_out") return logout("다시 입장해 주세요.");
    else if (data.error) err.textContent = "지우지 못했습니다. (" + data.error + ")";
    else {
      keep().removeItem(draftKey(a));
      for (const q of asked) delete values[q.id];
      delete liveDrafts[a.id];
      sendLive();
      c.formSig = null;   // 빈 칸으로 다시 그린다
      return poll();
    }
    c.refresh();
  });

  c.refresh = () => {
    const open = state.lesson.open;
    const d = dirty();
    if (quizDone) {
      btn.hidden = true;
      status.textContent = "제출했습니다 (" + fmtTime(a.saved_at) + ")";
      status.className = "status ok";
      return;
    }
    unsaveBtn.hidden = !a.mine || a.kind === "quiz" || !open;
    unsaveBtn.disabled = sending;
    btn.disabled = sending || !open || (a.mine && !d);
    btn.textContent = sending ? "저장 중…" : a.kind === "quiz" ? "제출하기" : !a.mine ? "저장하기" : d ? "고친 내용 저장" : "저장됨";
    status.textContent = !open ? "지금은 저장할 수 없습니다." : a.mine && !d ? "✓ 저장 완료 (" + fmtTime(a.saved_at) + ")" : a.mine ? "저장하지 않은 수정 내용이 있습니다." : "";
    status.className = a.mine && !d && open ? "status ok" : "status";
  };

  c.form.replaceChildren(...[
    h("div", { class: "card-head" }, h("h2", {}, a.title), h("span", { class: "badge" }, KIND_NAME[a.kind])),
    activityDescription(a) ? linkedDescription(activityDescription(a)) : null,
    quizDone && a.total ? h("p", { class: "score" }, "점수 " + a.score + " / " + a.total) : null,
    rows, err, btn, status, unsaveBtn].flat().filter(Boolean));
}

// 휴대폰을 가로로 돌리거나 창이 커지면 더 큰 슬라이드 그림으로 바꾼다
function refitSlides() {
  if (!shell || !state || !state.lesson) return;
  refitSlide(shell.img, state.lesson, viewing);
  if (shell.zoom) refitSlide(shell.zoom, state.lesson, viewing);
}
addEventListener("resize", refitSlides);
document.addEventListener("fullscreenchange", refitSlides);

// 맨 끝에서 시작: 위 파일의 let/const(stateMode, liveDrafts, simCache…)가 모두 준비된 뒤
if (!sb) notConfigured(app);
else start();
