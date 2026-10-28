// 수업 응답 · Supabase 사용량 읽기
// 교사 화면 「관리」 탭이 부를 때만 움직인다. 이 브라우저가 Supabase 대시보드에 로그인되어 있는지 먼저 보고,
// 로그인되어 있으면 대시보드 Usage 화면이 쓰는 것과 같은 숫자를 읽어 돌려준다.
// - 로그인은 하지 않는다. 로그인되어 있지 않으면 { loggedIn: false }만 돌려준다.
// - 로그인 정보(토큰)는 교사 화면에 넘기지 않고 저장하지도 않는다. 로그인을 이어 가는 일(토큰 새로 받기)은 대시보드가 스스로 한다.
// - 읽은 숫자는 10분 동안 이 브라우저에만 기억한다(그동안은 대시보드에 다시 들어가지 않음).
const DASH = "https://supabase.com";
const API = "https://api.supabase.com";
const TOKEN_KEY = "supabase.dashboard.auth.token";   // 대시보드가 로그인을 적어 두는 곳(supabase.com의 localStorage)
const CACHE_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== "usage" || !/^[a-z0-9]{20}$/.test(msg.ref || "")) return;
  readUsage(msg.ref, !!msg.force).then(reply, (e) => reply({ error: String((e && e.message) || e) }));
  return true;   // 답을 나중에 보낸다
});

// 탭 안에서 대시보드의 로그인 기록을 읽는다(그 탭의 주소도 함께)
async function readTab(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, func: (k) => ({ url: location.href, raw: localStorage.getItem(k) }), args: [TOKEN_KEY] });
    return r && r.result;
  } catch {
    return null;   // 아직 불러오는 중이거나 다른 사이트로 넘어간 탭
  }
}

// 1분 넘게 남은 로그인이면 그 열쇠, 아니면 null
function validToken(raw) {
  try {
    const s = JSON.parse(raw);
    const v = (s && s.currentSession) || s;
    return v && v.access_token && (v.expires_at || 0) * 1000 > Date.now() + 60000 ? v.access_token : null;
  } catch {
    return null;
  }
}

// 로그인되어 있으면 열쇠, 아니면 null
async function dashboardToken() {
  // 1) 이미 열려 있는 Supabase 탭에서
  for (const t of await chrome.tabs.query({ url: DASH + "/*" })) {
    const r = await readTab(t.id);
    const tok = r && validToken(r.raw);
    if (tok) return tok;
  }
  // 2) 대시보드를 뒤쪽 탭으로 잠깐 연다. 로그인되어 있으면 대시보드가 스스로 로그인을 이어 가고,
  //    아니면 로그인 화면으로 넘어간다(그때는 아무것도 입력하지 않고 닫는다).
  const tab = await chrome.tabs.create({ url: DASH + "/dashboard/projects", active: false });
  const started = Date.now();
  try {
    while (Date.now() - started < 25000) {
      await sleep(800);
      const r = await readTab(tab.id);
      if (!r) continue;
      const tok = validToken(r.raw);
      if (tok) return tok;
      if (/\/(sign-in|sign-up|forgot-password)/.test(r.url)) return null;
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) return null;   // 누군가 탭을 닫음
      if (!r.raw && t.status === "complete" && Date.now() - started > 6000) return null;   // 로그인 기록이 아예 없음
    }
    return null;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function readUsage(ref, force) {
  const key = "usage:" + ref;
  if (!force) {
    const c = (await chrome.storage.session.get(key))[key];
    if (c && Date.now() - c.at < CACHE_MS) return { ...c, cached: true };
  }
  const token = await dashboardToken();
  if (!token) return { loggedIn: false };
  const get = async (path) => {
    const r = await fetch(API + path, { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) { const e = new Error(path + " → " + r.status); e.status = r.status; throw e; }
    return r.json();
  };

  // 이 프로젝트가 속한 조직(무료 한도는 조직 전체에 적용된다)
  let project;
  try {
    project = await get("/platform/projects/" + ref);
  } catch (e) {
    if (e.status === 401) return { loggedIn: false };
    if (e.status === 403 || e.status === 404) return { loggedIn: true, noAccess: true };
    throw e;
  }
  const orgs = await get("/platform/organizations");
  const org = (orgs || []).find((o) => o.id === project.organization_id);
  if (!org) return { loggedIn: true, noAccess: true };

  // 지금 결제 주기(대시보드 Usage 화면의 기본 기간)
  let period = null;
  try {
    const s = await get("/platform/organizations/" + org.slug + "/billing/subscription");
    const ms = (x) => (x < 1e12 ? x * 1000 : x);
    period = { start: ms(s.current_period_start), end: ms(s.current_period_end), plan: s.plan && s.plan.name };
  } catch {}
  const q = period ? "?start=" + encodeURIComponent(new Date(period.start).toISOString()) + "&end=" + encodeURIComponent(new Date(period.end).toISOString()) : "";
  const usage = await get("/platform/organizations/" + org.slug + "/usage" + q);

  // 전송량을 서비스별로(하루치 기록을 더한다, 바이트)
  let breakdown = null;
  try {
    const daily = await get("/platform/organizations/" + org.slug + "/usage/daily" + q);
    breakdown = {};
    for (const d of daily.usages || []) {
      if (d.metric !== "EGRESS" || !d.breakdown) continue;
      for (const [k, v] of Object.entries(d.breakdown)) breakdown[k] = (breakdown[k] || 0) + (+v || 0);
    }
  } catch {}

  const out = {
    loggedIn: true, at: Date.now(), project: project.name,
    org: { name: org.name, slug: org.slug, plan: (period && period.plan) || (org.plan && org.plan.name) || null, restricted: org.restriction_status || null },
    period, breakdown, 
    usages: (usage.usages || []).map((u) => ({
      metric: u.metric, usage: u.usage, free: u.pricing_free_units, unlimited: u.unlimited, available: u.available_in_plan, capped: u.capped,
      projects: (u.project_allocations || []).map((p) => ({ name: p.name, ref: p.ref, usage: p.usage })),
    })),
  };
  await chrome.storage.session.set({ [key]: out });
  return out;
}
