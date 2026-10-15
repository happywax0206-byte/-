// 학생 화면과 교사 화면이 함께 쓰는 것들

// 주소 끝에 /rest/v1/ 같은 꼬리나 빈칸이 붙어 있어도 프로젝트 주소만 쓴다
const SB_URL = String(SUPABASE_URL).trim().replace(/\/(rest|auth|storage)\/v1.*$/, "").replace(/\/+$/, "");
const configured = (/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SB_URL) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SB_URL))
  && !/여기에/.test(SUPABASE_KEY) && String(SUPABASE_KEY).trim() !== "";
const sb = configured ? supabase.createClient(SB_URL, String(SUPABASE_KEY).trim()) : null;

// 만든 사람 표시. 고쳐 쓰거나 나눌 때도 지우지 말아 주세요(LICENSE.md).
const CREDIT = { name: "이효송", year: 2026 };

const KIND_NAME = { slide: "슬라이드 질문", survey: "설문", quiz: "퀴즈", sim: "시뮬레이션" };
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

// 시뮬레이션을 화면 가득 띄운다. 닫기 버튼이나 Esc로 닫는다.
function openSimFull(title, html) {
  const close = () => { box.remove(); document.removeEventListener("keydown", esc); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  const box = h("div", { class: "sim-full" },
    h("div", { class: "sim-full-head" }, h("strong", {}, title || "시뮬레이션"), h("button", { class: "ghost", type: "button", onclick: close }, "닫기")),
    simFrame(html, title));
  document.addEventListener("keydown", esc);
  document.body.append(box);
  if (box.requestFullscreen) box.requestFullscreen().catch(() => {});
}

function slideSrc(lesson, n) {
  const dir = lesson.slide_dir.trim();
  return encodeURI(dir.includes("{n}") ? dir.split("{n}").join(n) : dir.replace(/\/+$/, "") + "/" + n + ".png");
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

function isInfoActivity(activity) {
  return activity.kind === "survey" && activity.questions?.length === 1 && activity.questions[0].type === "info";
}

function activityName(activity) {
  return isInfoActivity(activity) ? "설명 카드" : KIND_NAME[activity.kind];
}

// 응답 모아 보기: 고르는 질문은 막대, 글은 목록. docs = [{ name, answers }]
function summaryView(questions, docs, opts) {
  opts = opts || {};
  return questions.map((q, i) => {
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

function openModal(title, body) {
  const close = () => box.remove();
  const box = h("div", { class: "overlay", onclick(e) { if (e.target === box) close(); } },
    h("div", { class: "modal" },
      h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { class: "ghost", type: "button", onclick: close }, "닫기")),
      h("div", { class: "modal-body" }, body)));
  document.body.append(box);
  return close;
}

function notConfigured(app) {
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
