-- ============================================================
-- 수업 응답 웹앱 · 버전 2 · Supabase 설정
-- 교사(선생님)와 학생만 쓰는 판. 교사는 맨 아래에 적은 이메일로 로그인한다.
-- Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run. 여러 번 실행해도 괜찮습니다.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- 교사 목록: 여기에 있는 이메일로 로그인한 사람만 교사 화면을 쓸 수 있다.
create table if not exists teachers (
  email text primary key
);
-- 나중에 더한 칸: 교사 프로필(이름·학교·과목)과, 공동작업자로 초대되어 들어온 교사인지
alter table teachers add column if not exists name text check (length(name) <= 30);
alter table teachers add column if not exists school text check (length(school) <= 50);
alter table teachers add column if not exists subject text check (length(subject) <= 30);
alter table teachers add column if not exists invited boolean not null default false;

-- 수업(반) 하나. 수업 코드는 서버가 겹치지 않게 만든다.
create table if not exists lessons (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid(),
  code        text not null check (code ~ '^[A-Z0-9]{4,12}$'),
  title       text not null check (length(title) <= 100),
  slide_dir   text not null default '' check (length(slide_dir) <= 500),   -- 슬라이드 그림 주소({n} = 쪽 번호)
  slide_count int  not null default 0 check (slide_count between 0 and 300),
  page        int  not null default 1,
  open        boolean not null default true,
  created_at  timestamptz not null default now()
);
-- 나중에 더한 칸: 수업 종류(슬라이드 수업 / 설문만)
alter table lessons add column if not exists kind text not null default 'lesson' check (kind in ('lesson', 'survey'));
-- 나중에 더한 칸: 화면 넘김 효과 {type, ms, pages: {"쪽 번호": type}}
alter table lessons add column if not exists transition jsonb;
alter table lessons drop constraint if exists lessons_transition_size;
alter table lessons add constraint lessons_transition_size check (transition is null or (jsonb_typeof(transition) = 'object' and octet_length(transition::text) <= 8000));
-- 나중에 더한 칸: 교사가 「학생 화면」 탭을 마지막으로 본 때. 이때부터 15초 동안만 학생이 쓰고 있는 답을 보낸다
alter table lessons add column if not exists live_watch_at timestamptz;
create unique index if not exists lessons_code_key on lessons (code);
create index if not exists lessons_owner on lessons (owner);

-- 수업 공동작업자: 수업을 만든 교사가 이메일로 초대한 교사. 그 수업을 함께 보고 고치고 진행한다(지우기는 만든 교사만).
create table if not exists lesson_members (
  lesson_id  uuid not null references lessons(id) on delete cascade,
  email      text not null check (email = lower(email) and length(email) <= 200),
  added_at   timestamptz not null default now(),
  primary key (lesson_id, email)
);
create index if not exists lesson_members_email on lesson_members (email);

create table if not exists activities (
  id          uuid primary key default gen_random_uuid(),
  lesson_id   uuid not null references lessons(id) on delete cascade,
  kind        text not null check (kind in ('slide', 'survey', 'quiz')),
  title       text not null check (length(title) <= 100),
  page        int,
  show_answer boolean not null default true,
  named       boolean not null default false,
  shared      boolean not null default false,
  questions   jsonb not null default '[]' check (octet_length(questions::text) <= 50000),
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists activities_lesson on activities (lesson_id);
-- 나중에 더한 칸: 여러 쪽에 걸친 질문의 끝 쪽(비우면 page 한 쪽)
alter table activities add column if not exists page_to int;
-- 나중에 더한 칸: 시뮬레이션(html 한 파일)과 '슬라이드 자리에 띄우기'
alter table activities add column if not exists html text;
alter table activities add column if not exists sim_full boolean not null default false;
-- 나중에 더한 칸: 시뮬레이션을 슬라이드 위 정한 자리에 얹을 때의 자리 {x, y, w, h}(슬라이드 안 0~1 비율). 비우면 슬라이드 아래 카드
alter table activities add column if not exists sim_box jsonb;
alter table activities drop constraint if exists activities_sim_box_size;
alter table activities add constraint activities_sim_box_size check (sim_box is null or octet_length(sim_box::text) <= 200);
alter table activities drop constraint if exists activities_kind_check;
alter table activities add constraint activities_kind_check check (kind in ('slide', 'survey', 'quiz', 'sim'));
alter table activities drop constraint if exists activities_html_size;
alter table activities add constraint activities_html_size check (html is null or length(html) <= 500000);

-- 학생: 웹앱 전체에 한 명당 하나(학번 + 이름 + 4자리 비밀번호). 어느 수업에 들어와도 같은 비밀번호를 쓴다.
create table if not exists students (
  id           uuid primary key default gen_random_uuid(),
  class_no     text not null,        -- 학번
  name         text not null,
  pin_hash     text,                 -- 비어 있으면 다음에 들어올 때 새로 정한다(처음, 또는 교사가 초기화)
  pin_set      boolean generated always as (pin_hash is not null) stored,
  token        text unique,          -- 입장한 기기가 쓰는 열쇠. 초기화하면 지워져 모든 기기가 나가진다
  fails        int not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now()
);
alter table students add column if not exists last_seen timestamptz;

-- 수업 참여: 학생이 어느 수업에 들어왔는지, 그 수업 화면을 마지막으로 연 때(교사 화면의 '접속 중')
create table if not exists lesson_students (
  lesson_id  uuid not null references lessons(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  last_seen  timestamptz,
  primary key (lesson_id, student_id)
);
create index if not exists lesson_students_student on lesson_students (student_id);
-- 나중에 더한 칸: 교사만 보는 학생 실시간 화면 {page, following, hidden, focus, drafts: {활동id: {질문id: 쓰는 중인 답}}}
alter table lesson_students add column if not exists live jsonb;
alter table lesson_students add column if not exists live_at timestamptz;
alter table lesson_students drop constraint if exists lesson_students_live_size;
alter table lesson_students add constraint lesson_students_live_size check (live is null or (jsonb_typeof(live) = 'object' and octet_length(live::text) <= 20000));
-- 나중에 더한 칸: 학생 화면 전체 보기(학생이 동의할 때만). 영상은 서버를 거치지 않고 학생 → 교사 브라우저로 바로 간다(WebRTC).
-- 여기에는 연결 약속만 적는다 {ask: 요청 번호, state, key: 학생이 만든 연결 번호, offer/answer: 연결 정보(SDP)}
-- state: asked(교사가 요청) declined(거절) unsupported(휴대폰 등) offer(학생 동의, 연결 정보 보냄) answer(교사 답함)
--        live(보이는 중) failed(연결 끊김) renew(교사가 다시 연결 요청) stopped(학생이 멈춤) ended(교사가 끝냄)
alter table lesson_students add column if not exists screen jsonb;
alter table lesson_students drop constraint if exists lesson_students_screen_size;
alter table lesson_students add constraint lesson_students_screen_size check (screen is null or (jsonb_typeof(screen) = 'object' and octet_length(screen::text) <= 70000));

create table if not exists responses (
  student_id  uuid not null references students(id) on delete cascade,
  activity_id uuid not null references activities(id) on delete cascade,
  answers     jsonb not null default '{}',
  score       int,
  total       int,
  updated_at  timestamptz not null default now(),
  primary key (student_id, activity_id)
);
create index if not exists responses_activity on responses (activity_id);

-- 예전 구조(수업마다 학생이 따로)에서 옮기기. 이미 새 구조면 아무것도 하지 않는다.
-- 같은 학번+이름은 한 명으로 합치고, 가장 최근에 들어온 기록의 비밀번호를 쓴다. 응답은 모두 그 학생에게 옮긴다.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'students' and column_name = 'lesson_id') then
    drop table if exists pg_temp.keep_students;
    create temp table keep_students as
      select id, first_value(id) over (partition by class_no, name
                                       order by coalesce(last_seen, created_at) desc, created_at desc) as keep_id
      from students;
    insert into lesson_students (lesson_id, student_id, joined_at, last_seen)
      select s.lesson_id, k.keep_id, s.created_at, s.last_seen
      from students s join keep_students k on k.id = s.id
      on conflict (lesson_id, student_id) do nothing;
    update responses r set student_id = k.keep_id
      from keep_students k where r.student_id = k.id and k.id <> k.keep_id;
    delete from students s using keep_students k where s.id = k.id and k.id <> k.keep_id;
    alter table students drop column lesson_id;   -- 수업별 제약도 함께 없어진다
    drop table pg_temp.keep_students;
  end if;
end $$;
create unique index if not exists students_who on students (class_no, name);

-- ------------------------------------------------------------
-- 보안(RLS): 표는 교사만 직접 읽고 쓴다. 학생은 아래 함수 세 개(입장, 상태, 저장)로만 들어온다.
-- ------------------------------------------------------------
alter table teachers   enable row level security;
alter table lessons    enable row level security;
alter table activities enable row level security;
alter table students   enable row level security;
alter table responses  enable row level security;
alter table lesson_students enable row level security;
alter table lesson_members enable row level security;   -- 정책 없음: 아래 함수로만 쓴다

create or replace function is_teacher() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from teachers where email = lower(auth.jwt() ->> 'email'))
$$;

create or replace function my_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

-- 이 수업을 볼 수 있는지: 내가 만든 수업이거나 공동작업자로 초대받은 수업
create or replace function can_lesson(p_lesson uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_teacher() and exists (
    select 1 from lessons l where l.id = p_lesson
      and (l.owner = auth.uid() or exists (select 1 from lesson_members m where m.lesson_id = l.id and m.email = my_email())))
$$;

create or replace function can_activity(p_activity uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from activities a where a.id = p_activity and can_lesson(a.lesson_id))
$$;

-- 학생 계정은 웹앱 전체에 하나: 내가 볼 수 있는 수업에 들어온 학생만 다룬다
create or replace function can_student(p_student uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from lesson_students m where m.student_id = p_student and can_lesson(m.lesson_id))
$$;

-- 저장소 폴더 이름(글자)이 볼 수 있는 수업의 id인지
create or replace function can_lesson_path(p text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce(p, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and can_lesson(p::uuid);
end $$;

-- 예전에는 교사면 모든 수업을 다뤘다. 이제는 내 수업과 초대받은 수업만. 수업 지우기는 만든 교사만.
drop policy if exists teacher_all on lessons;
drop policy if exists teacher_all on activities;
drop policy if exists teacher_all on students;
drop policy if exists teacher_all on responses;
drop policy if exists teacher_all on lesson_students;
drop policy if exists lesson_select on lessons;
drop policy if exists lesson_insert on lessons;
drop policy if exists lesson_update on lessons;
drop policy if exists lesson_delete on lessons;
create policy lesson_select on lessons for select to authenticated using (can_lesson(id));
create policy lesson_insert on lessons for insert to authenticated with check (is_teacher() and owner = auth.uid());
create policy lesson_update on lessons for update to authenticated using (can_lesson(id)) with check (can_lesson(id));
create policy lesson_delete on lessons for delete to authenticated using (is_teacher() and owner = auth.uid());
create policy teacher_all on activities for all to authenticated using (can_lesson(lesson_id)) with check (can_lesson(lesson_id));
create policy teacher_all on students   for all to authenticated using (can_student(id)) with check (can_student(id));
create policy teacher_all on responses  for all to authenticated using (can_activity(activity_id)) with check (can_activity(activity_id));
create policy teacher_all on lesson_students for all to authenticated using (can_lesson(lesson_id)) with check (can_lesson(lesson_id));

-- 수업을 만든 교사(owner)는 바뀌지 않는다(공동작업자가 수업을 가져가지 못하게)
create or replace function lessons_keep_owner() returns trigger
language plpgsql as $$ begin new.owner := old.owner; return new; end $$;
drop trigger if exists lessons_keep_owner on lessons;
create trigger lessons_keep_owner before update on lessons for each row execute function lessons_keep_owner();

-- 새 수업 만들기: 겹치지 않는 수업 코드를 서버가 정한다(헷갈리는 0, O, 1, I 는 쓰지 않음)
-- p_kind: 'lesson'(슬라이드 수업) 또는 'survey'(설문만)
drop function if exists create_lesson(text);
create or replace function create_lesson(p_title text, p_kind text default 'lesson')
returns lessons language plpgsql security definer set search_path = public, extensions as $$
declare
  c text;
  l lessons;
  letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if not is_teacher() then raise exception 'not a teacher'; end if;
  if coalesce(trim(p_title), '') = '' or length(p_title) > 100 then raise exception 'bad title'; end if;
  loop
    select string_agg(substr(letters, 1 + (get_byte(b, i) % length(letters)), 1), '')
      into c from (select gen_random_bytes(5) b) x, generate_series(0, 4) i;
    begin
      insert into lessons (owner, code, title, kind)
        values (auth.uid(), c, trim(p_title), case when p_kind = 'survey' then 'survey' else 'lesson' end) returning * into l;
      return l;
    exception when unique_violation then
      -- 드물게 겹치면 다시 뽑는다
    end;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 학생용 함수 (class-response-app 과 같음)
-- ------------------------------------------------------------
create or replace function tidy(t text) returns text
language sql immutable as $$ select regexp_replace(coalesce(t, ''), '\s', '', 'g') $$;

-- 학생 입장: 학번+이름+비밀번호로 확인하고 이 수업에 참여시킨다.
-- 처음이거나 초기화된 학생은 p_confirm = true 로 다시 불러야 비밀번호가 정해진다. 5번 틀리면 10분 잠금.
create or replace function student_enter(p_code text, p_class_no text, p_name text, p_pin text, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  l lessons;
  s students;
  c text := tidy(p_class_no);
  n text := tidy(p_name);
  existed boolean;
begin
  select * into l from lessons where code = upper(tidy(p_code));
  if not found then return jsonb_build_object('error', 'no_lesson'); end if;
  if c = '' or n = '' or length(c) > 20 or length(n) > 20 then return jsonb_build_object('error', 'bad_name'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('error', 'bad_pin'); end if;

  select * into s from students where class_no = c and name = n for update;
  existed := found;

  if not existed or s.pin_hash is null then
    if not p_confirm then return jsonb_build_object('error', 'need_confirm', 'reset', existed); end if;
    if not existed then
      if (select count(*) from students) >= 5000 then return jsonb_build_object('error', 'full'); end if;
      insert into students (class_no, name) values (c, n) returning * into s;
    end if;
    update students
      set pin_hash = crypt(p_pin, gen_salt('bf')), fails = 0, locked_until = null,
          token = coalesce(token, encode(gen_random_bytes(24), 'hex'))
      where id = s.id returning * into s;
  else
    if s.locked_until > now() then
      return jsonb_build_object('error', 'locked', 'minutes', ceil(extract(epoch from s.locked_until - now()) / 60));
    end if;
    if s.pin_hash <> crypt(p_pin, s.pin_hash) then
      if s.fails + 1 >= 5 then
        update students set fails = 0, locked_until = now() + interval '10 minutes' where id = s.id;
        return jsonb_build_object('error', 'locked', 'minutes', 10);
      end if;
      update students set fails = fails + 1 where id = s.id;
      return jsonb_build_object('error', 'wrong_pin', 'left', 4 - s.fails);
    end if;
    update students
      set fails = 0, locked_until = null, token = coalesce(token, encode(gen_random_bytes(24), 'hex'))
      where id = s.id returning * into s;
  end if;

  if not exists (select 1 from lesson_students where lesson_id = l.id and student_id = s.id) then
    if (select count(*) from lesson_students where lesson_id = l.id) >= 200 then return jsonb_build_object('error', 'full'); end if;
    insert into lesson_students (lesson_id, student_id) values (l.id, s.id) on conflict do nothing;
  end if;
  return jsonb_build_object('token', s.token, 'class_no', s.class_no, 'name', s.name, 'code', l.code);
end $$;

-- 학생 화면에 필요한 것 전부: 이 수업의 상태, 활동, 내 응답, 공개된 친구들 응답.
-- 이미 입장한 학생(열쇠가 있는 기기)이 새 수업 코드로 오면 비밀번호 없이 그 수업에 참여시킨다.
-- 학생은 3초마다 묻는다. 전송량을 줄이려고 내용을 세 부분(lesson: 수업 정보, activities: 활동, others: 공개된 친구 응답)으로 나누고
-- 부분마다 md5를 붙인다(hash = 세 md5를 이은 96글자). 학생이 보낸 p_hash와 비교해 바뀐 부분만 돌려주고('parts': true),
-- 모두 같으면 same만 돌려준다. 그래서 쪽을 넘길 때는 짧은 수업 정보만 간다.
-- p_parts가 없는 예전 학생 화면(캐시)에는 예전처럼 통째로(others는 활동 안에) 보내고 hash도 전체 md5 하나다.
drop function if exists student_state(text);
drop function if exists student_state(text, text);
drop function if exists student_state(text, text, text);
create or replace function student_state(p_token text, p_code text, p_hash text default null, p_parts boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  s students;
  l lessons;
  m lesson_students;
  vl jsonb;
  va jsonb;
  vo jsonb;
  hl text;
  ha text;
  ho text;
  v jsonb;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return jsonb_build_object('error', 'logged_out'); end if;
  select * into l from lessons where code = upper(tidy(p_code));
  if not found then return jsonb_build_object('error', 'no_lesson'); end if;
  select * into m from lesson_students where lesson_id = l.id and student_id = s.id;
  if not found then
    if (select count(*) from lesson_students where lesson_id = l.id) >= 200 then return jsonb_build_object('error', 'full'); end if;
    insert into lesson_students (lesson_id, student_id) values (l.id, s.id) on conflict do nothing returning * into m;
  end if;
  -- 접속 중 표시: 10초에 한 번만 적는다
  if m.last_seen is null or m.last_seen < now() - interval '10 seconds' then
    update lesson_students set last_seen = now() where lesson_id = l.id and student_id = s.id;
  end if;

  vl := jsonb_build_object(
    'me', jsonb_build_object('class_no', s.class_no, 'name', s.name),
    'lesson', jsonb_build_object('code', l.code, 'title', l.title, 'slide_dir', l.slide_dir,
                                 'slide_count', l.slide_count, 'page', l.page, 'open', l.open, 'kind', l.kind, 'transition', l.transition),
    'watch', coalesce(l.live_watch_at > now() - interval '15 seconds', false),
    'screen', case when m.screen is not null then jsonb_build_object('ask', m.screen -> 'ask', 'state', m.screen -> 'state', 'key', m.screen -> 'key', 'at', m.screen -> 'at') end);
  va := coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'kind', a.kind, 'title', a.title, 'page', a.page, 'page_to', a.page_to, 'named', a.named, 'shared', a.shared,
        'sim_full', a.sim_full, 'sim_box', a.sim_box, 'html_ver', case when a.kind = 'sim' then md5(coalesce(a.html, '')) end,
        'questions', case
          when a.kind = 'quiz' and a.show_answer and r.student_id is not null then a.questions
          else (select coalesce(jsonb_agg(q - 'answer' - 'explain'), '[]'::jsonb) from jsonb_array_elements(a.questions) q)
        end,
        'mine', r.answers, 'score', r.score, 'total', r.total, 'saved_at', r.updated_at
      ) order by a.page nulls last, a.sort, a.created_at)
      from activities a
      left join responses r on r.activity_id = a.id and r.student_id = s.id
      where a.lesson_id = l.id), '[]'::jsonb);
  vo := coalesce((
      select jsonb_object_agg(a.id, (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'name', case when a.named then o.class_no || ' ' || o.name end,
                   'answers', x.answers) order by x.updated_at), '[]'::jsonb)
          from responses x join students o on o.id = x.student_id
          where x.activity_id = a.id))
      from activities a
      where a.lesson_id = l.id and a.shared), '{}'::jsonb);
  if not coalesce(p_parts, false) then
    v := vl || jsonb_build_object('activities', coalesce((
      select jsonb_agg(case when vo ? (e ->> 'id') then e || jsonb_build_object('others', vo -> (e ->> 'id')) else e end order by n)
      from jsonb_array_elements(va) with ordinality t(e, n)), '[]'::jsonb));
    hl := md5(v::text);
    if p_hash = hl then return jsonb_build_object('same', true); end if;
    return v || jsonb_build_object('hash', hl);
  end if;
  hl := md5(vl::text);
  ha := md5(va::text);
  ho := md5(vo::text);
  if p_hash = (hl || ha || ho) then return jsonb_build_object('same', true); end if;
  v := jsonb_build_object('parts', true, 'hash', hl || ha || ho);
  if p_hash is null or substr(p_hash, 1, 32) <> hl then v := v || vl; end if;
  if p_hash is null or substr(p_hash, 33, 32) <> ha then v := v || jsonb_build_object('activities', va); end if;
  if p_hash is null or substr(p_hash, 65, 32) <> ho then v := v || jsonb_build_object('others', vo); end if;
  return v;
end $$;

-- 학생 응답 저장. 그 수업에 참여한 학생만, 제출이 열려 있을 때만. 퀴즈는 한 번만 제출하고 서버에서 채점한다.
create or replace function student_save(p_token text, p_activity uuid, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s students;
  l lessons;
  a activities;
  sc int;
  tot int;
  q jsonb;
  f jsonb;
  pre text;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return jsonb_build_object('error', 'logged_out'); end if;
  select * into a from activities where id = p_activity;
  if not found or a.kind = 'sim' or not exists (select 1 from lesson_students where lesson_id = a.lesson_id and student_id = s.id) then
    return jsonb_build_object('error', 'no_activity');
  end if;
  select * into l from lessons where id = a.lesson_id;
  if not l.open then return jsonb_build_object('error', 'closed'); end if;
  if jsonb_typeof(p_answers) is distinct from 'object' or octet_length(p_answers::text) > 20000 then
    return jsonb_build_object('error', 'too_big');
  end if;

  -- 파일 답: 이 학생이 이 활동에 받은 자리(student_upload_ticket)에 실제로 올린 파일만 받는다
  pre := a.lesson_id || '/' || a.id || '_' || s.id || '_';
  for q in select value from jsonb_array_elements(a.questions) loop
    if q ->> 'type' = 'file' and p_answers ? (q ->> 'id') then
      f := p_answers -> (q ->> 'id');
      if jsonb_typeof(f) is distinct from 'array' or jsonb_array_length(f) > 5 then
        return jsonb_build_object('error', 'bad_file');
      end if;
      if exists (select 1 from jsonb_array_elements(f) x
                 where jsonb_typeof(x) <> 'object'
                    or left(coalesce(x ->> 'path', ''), length(pre)) <> pre
                    or not exists (select 1 from storage.objects o where o.bucket_id = 'submissions' and o.name = x ->> 'path')) then
        return jsonb_build_object('error', 'bad_file');
      end if;
    end if;
  end loop;

  if a.kind = 'quiz' then
    if exists (select 1 from responses where student_id = s.id and activity_id = a.id) then
      return jsonb_build_object('error', 'already');
    end if;
    select count(*) filter (where q ? 'answer'),
           count(*) filter (where q ? 'answer' and p_answers -> (q ->> 'id') = q -> 'answer')
      into tot, sc
      from jsonb_array_elements(a.questions) q;
  end if;

  insert into responses (student_id, activity_id, answers, score, total, updated_at)
    values (s.id, a.id, p_answers, sc, tot, now())
    on conflict (student_id, activity_id)
    do update set answers = excluded.answers, score = excluded.score, total = excluded.total, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- 시뮬레이션 html: 크기가 커서 3초마다 받는 상태에는 넣지 않고, 바뀌었을 때(html_ver)만 이것으로 한 번 받는다
create or replace function student_sim(p_token text, p_activity uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  s students;
  a activities;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return null; end if;
  select * into a from activities where id = p_activity and kind = 'sim';
  if not found or not exists (select 1 from lesson_students where lesson_id = a.lesson_id and student_id = s.id) then return null; end if;
  return a.html;
end $$;

-- 교사 화면: 이 수업에 들어온 학생 목록(비밀번호 대신 '정해졌는지'만)
-- p_live = false: 「학생 화면」 탭이 아닐 때는 쓰고 있는 답(live)을 빼고 받아 전송량을 줄인다
-- p_live = true: 교사가 보고 있다고 적어 둔다(live_watch_at). 학생은 그때만 쓰고 있는 답을 보낸다
drop function if exists teacher_students(uuid);
create or replace function teacher_students(p_lesson uuid, p_live boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not can_lesson(p_lesson) then raise exception 'not your lesson'; end if;
  if p_live then
    update lessons set live_watch_at = now()
      where id = p_lesson and (live_watch_at is null or live_watch_at < now() - interval '5 seconds');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'class_no', s.class_no, 'name', s.name, 'pin_set', s.pin_set, 'fails', s.fails,
      'locked_until', s.locked_until, 'created_at', s.created_at, 'joined_at', m.joined_at, 'last_seen', m.last_seen,
      'live', case when p_live then m.live end, 'live_at', m.live_at,
      'screen', coalesce(m.screen - 'offer' - 'answer', '{}'::jsonb)))
    from lesson_students m join students s on s.id = m.student_id
    where m.lesson_id = p_lesson), '[]'::jsonb);
end $$;

-- 학생 화면: 지금 보는 쪽·쓰고 있는 답을 교사에게 알린다(교사만 teacher_students로 읽는다)
create or replace function student_live(p_token text, p_code text, p_live jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  s students;
  l lessons;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return jsonb_build_object('error', 'logged_out'); end if;
  select * into l from lessons where code = upper(tidy(p_code));
  if not found then return jsonb_build_object('error', 'no_lesson'); end if;
  if p_live is null or jsonb_typeof(p_live) <> 'object' or octet_length(p_live::text) > 20000 then
    return jsonb_build_object('error', 'too_big');
  end if;
  update lesson_students set live = p_live, live_at = now(), last_seen = now()
    where lesson_id = l.id and student_id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- 학생 화면 전체 보기 — 학생 쪽. p_state 없이 부르면 지금 약속(교사의 answer 포함)만 돌려준다.
-- 학생은 교사가 요청한 그 요청 번호(p_ask)에만 답할 수 있다.
create or replace function student_screen(p_token text, p_code text, p_ask text, p_state text default null,
                                          p_offer text default null, p_key text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  s students;
  l lessons;
  m lesson_students;
  v jsonb;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return jsonb_build_object('error', 'logged_out'); end if;
  select * into l from lessons where code = upper(tidy(p_code));
  if not found then return jsonb_build_object('error', 'no_lesson'); end if;
  select * into m from lesson_students where lesson_id = l.id and student_id = s.id for update;
  if not found then return jsonb_build_object('error', 'no_lesson'); end if;
  v := m.screen;
  if p_state is not null then
    if v is null or v ->> 'ask' is distinct from p_ask then return jsonb_build_object('error', 'stale'); end if;
    if p_state = 'offer' then
      if p_offer is null or length(p_offer) > 60000 or coalesce(p_key, '') !~ '^[a-z0-9]{6,32}$' then
        return jsonb_build_object('error', 'bad');
      end if;
      v := jsonb_build_object('ask', p_ask, 'state', 'offer', 'key', p_key, 'offer', p_offer);
    elsif p_state in ('live', 'failed') then
      if v ->> 'key' is distinct from p_key or v ->> 'state' not in ('offer', 'answer', 'live', 'failed') then
        return jsonb_build_object('error', 'stale');
      end if;
      v := (v - 'offer' - 'answer') || jsonb_build_object('state', p_state);
    elsif p_state in ('declined', 'unsupported', 'stopped') then
      v := jsonb_build_object('ask', p_ask, 'state', p_state);
    else
      return jsonb_build_object('error', 'bad');
    end if;
    v := v || jsonb_build_object('at', now());
    update lesson_students set screen = v where lesson_id = l.id and student_id = s.id;
  end if;
  return coalesce(v - 'offer', '{}'::jsonb);
end $$;

-- 학생 화면 전체 보기 — 교사 쪽.
-- ask: 보기 요청(p_student 없으면 이 수업 학생 모두, 이미 보이는 학생은 빼고) · end: 끝내기 · renew: 다시 연결(교사가 새로고침한 경우 등)
-- get: 학생이 보낸 연결 정보(offer) 받기 · answer: 교사 쪽 연결 정보 보내기(p_key = 학생이 만든 연결 번호)
create or replace function teacher_screen(p_lesson uuid, p_student uuid, p_action text, p_key text default null, p_answer text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v jsonb;
begin
  if not can_lesson(p_lesson) then raise exception 'not your lesson'; end if;
  if p_action = 'ask' then
    update lesson_students
      set screen = jsonb_build_object('ask', encode(gen_random_bytes(6), 'hex'), 'state', 'asked', 'at', now())
      where lesson_id = p_lesson and (p_student is null or student_id = p_student)
        and (p_student is not null or coalesce(screen ->> 'state', '') not in ('offer', 'answer', 'live', 'failed', 'renew'));
  elsif p_action = 'end' then
    update lesson_students
      set screen = jsonb_build_object('ask', screen -> 'ask', 'state', 'ended', 'at', now())
      where lesson_id = p_lesson and (p_student is null or student_id = p_student)
        and screen is not null and screen ->> 'state' <> 'ended';
  elsif p_action = 'renew' then
    update lesson_students
      set screen = jsonb_build_object('ask', screen -> 'ask', 'state', 'renew', 'at', now())
      where lesson_id = p_lesson and student_id = p_student and screen ->> 'state' in ('offer', 'answer', 'live', 'failed');
  elsif p_action = 'get' then
    select screen into v from lesson_students where lesson_id = p_lesson and student_id = p_student;
    return coalesce(v, '{}'::jsonb);
  elsif p_action = 'answer' then
    if p_answer is null or length(p_answer) > 60000 then return jsonb_build_object('error', 'bad'); end if;
    update lesson_students
      set screen = (screen - 'offer') || jsonb_build_object('state', 'answer', 'answer', p_answer, 'at', now())
      where lesson_id = p_lesson and student_id = p_student and screen ->> 'state' = 'offer' and screen ->> 'key' = p_key;
    if not found then return jsonb_build_object('error', 'stale'); end if;
  else
    return jsonb_build_object('error', 'bad');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 교사 화면 「관리」 탭: 무료 용량 중 쓴 만큼과, 무엇이 많이 쓰는지(큰 것부터). 교사만.
-- 데이터베이스 크기: Supabase 문서와 같은 방법(모든 데이터베이스의 pg_database_size 합, 기본으로 40~60MB).
-- 디스크: 데이터베이스 + WAL(읽을 수 있을 때만). 무료는 2GB, 95%가 차면 읽기 전용이 된다.
-- 저장소: 파일 크기 합(버킷·수업별). 활성 사용자(MAU): 이번 달에 로그인했거나 로그인을 이어 간(토큰 새로 받기) 교사 계정.
-- 전송량(egress)은 데이터베이스에서도, 토큰으로 부르는 Supabase API에서도 알 수 없어 대시보드에서만 보인다.
create or replace function usage_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  admin boolean;
  wal bigint;
  since timestamptz := date_trunc('month', now());
begin
  if not is_teacher() then raise exception 'not a teacher'; end if;
  admin := exists (select 1 from teachers where email = my_email() and not invited);
  begin
    select sum(size) into wal from pg_ls_waldir();
  exception when others then
    wal := null;   -- 권한이 없으면 디스크는 데이터베이스 크기만으로 본다
  end;
  return jsonb_build_object(
    'db_bytes', (select sum(pg_database_size(datname)) from pg_database),
    'wal_bytes', wal,
    -- 이 데이터베이스의 표(색인 포함) 큰 것 40개. 나머지(기본 시스템 표·다른 데이터베이스)는 화면에서 「기본」으로 묶는다
    'db_parts', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.nspname || '.' || x.relname, 'bytes', x.b) order by x.b desc)
      from (select n.nspname, c.relname, pg_total_relation_size(c.oid) b
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relkind in ('r', 'm', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'
            order by 3 desc limit 40) x), '[]'::jsonb),
    -- 저장소 파일: 버킷과 수업 폴더별(슬라이드는 만든교사id/수업id/…, 예전에는 수업id/…; 학생 제출은 수업id/…)
    'storage_parts', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', x.bucket_id, 'lesson', x.lid, 'bytes', x.b, 'files', x.n,
               'title', case when x.lid is not null and can_lesson(x.lid) then (select title from lessons where id = x.lid) end,
               'mine', x.lid is not null and can_lesson(x.lid)) order by x.b desc)
      from (select o.bucket_id, coalesce(l1.id, l2.id) lid, sum(coalesce((o.metadata ->> 'size')::bigint, 0)) b, count(*) n
            from storage.objects o
            left join lessons l1 on l1.id::text = (storage.foldername(o.name))[1]
            left join lessons l2 on l2.id::text = (storage.foldername(o.name))[2]
            group by 1, 2) x), '[]'::jsonb),
    'users', (select count(*) from auth.users),
    'mau', (select count(*) from auth.users u
            where u.last_sign_in_at >= since
               or exists (select 1 from auth.sessions s where s.user_id = u.id and s.updated_at >= since)
               or exists (select 1 from auth.refresh_tokens r where r.user_id = u.id::text and r.updated_at >= since)),
    -- 계정 목록(이메일)은 처음부터 있던 교사(초대받아 들어온 교사가 아닌)에게만
    'mau_list', case when admin then coalesce((
      select jsonb_agg(jsonb_build_object('email', x.email, 'at', x.at) order by x.at desc)
      from (select u.email, greatest(u.last_sign_in_at,
                     (select max(s.updated_at) from auth.sessions s where s.user_id = u.id),
                     (select max(r.updated_at) from auth.refresh_tokens r where r.user_id = u.id::text)) at
            from auth.users u) x
      where x.at >= since), '[]'::jsonb) end,
    'students', (select count(*) from students),
    'lessons', (select count(*) from lessons));
end $$;
revoke all on function usage_stats() from public;
grant execute on function usage_stats() to authenticated;

-- ------------------------------------------------------------
-- 교사 프로필과 수업 공동작업자
-- ------------------------------------------------------------
create or replace function my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('email', t.email, 'name', t.name, 'school', t.school, 'subject', t.subject)
  from teachers t where t.email = my_email()
$$;

create or replace function save_profile(p_name text, p_school text, p_subject text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_teacher() then raise exception 'not a teacher'; end if;
  if length(trim(coalesce(p_name, ''))) > 30 or length(trim(coalesce(p_school, ''))) > 50 or length(trim(coalesce(p_subject, ''))) > 30 then
    return jsonb_build_object('error', 'too_long');
  end if;
  update teachers set name = nullif(trim(p_name), ''), school = nullif(trim(p_school), ''), subject = nullif(trim(p_subject), '')
    where email = my_email();
  return my_profile();
end $$;

-- 이 수업을 만든 교사와 공동작업자(프로필과 함께). joined: 그 이메일로 계정을 만들었는지
create or replace function lesson_people(p_lesson uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  l lessons;
  oe text;
begin
  if not can_lesson(p_lesson) then raise exception 'not your lesson'; end if;
  select * into l from lessons where id = p_lesson;
  select lower(u.email) into oe from auth.users u where u.id = l.owner;
  return jsonb_build_object(
    'owner', (select jsonb_build_object('email', oe, 'name', t.name, 'school', t.school, 'subject', t.subject, 'me', l.owner = auth.uid())
              from (select 1) x left join teachers t on t.email = oe),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('email', m.email, 'name', t.name, 'school', t.school, 'subject', t.subject, 'me', m.email = my_email(),
               'joined', exists (select 1 from auth.users u where lower(u.email) = m.email and u.email_confirmed_at is not null))
             order by m.added_at)
      from lesson_members m left join teachers t on t.email = m.email
      where m.lesson_id = p_lesson), '[]'::jsonb));
end $$;

-- 공동작업자 초대: 수업을 만든 교사만. 초대한 이메일은 교사 목록에도 넣어 로그인할 수 있게 한다.
create or replace function add_member(p_lesson uuid, p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  l lessons;
begin
  select * into l from lessons where id = p_lesson;
  if not found or not is_teacher() or l.owner <> auth.uid() then return jsonb_build_object('error', 'not_owner'); end if;
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(e) > 200 then return jsonb_build_object('error', 'bad_email'); end if;
  if e = my_email() then return jsonb_build_object('error', 'self'); end if;
  if (select count(*) from lesson_members where lesson_id = p_lesson) >= 20 then return jsonb_build_object('error', 'full'); end if;
  insert into lesson_members (lesson_id, email) values (p_lesson, e) on conflict do nothing;
  insert into teachers (email, invited) values (e, true) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- 공동작업자 빼기: 만든 교사는 누구든, 공동작업자는 자기 자신만(「이 수업에서 나가기」)
create or replace function remove_member(p_lesson uuid, p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  l lessons;
begin
  select * into l from lessons where id = p_lesson;
  if not found or not is_teacher() or (l.owner <> auth.uid() and e <> my_email()) then return jsonb_build_object('error', 'not_owner'); end if;
  delete from lesson_members where lesson_id = p_lesson and email = e;
  -- 초대로만 들어온 교사가 이제 어느 수업에도 없으면 교사 목록에서도 뺀다(로그인해도 교사 화면을 못 쓴다)
  delete from teachers t where t.email = e and t.invited
    and not exists (select 1 from lesson_members m where m.email = e)
    and not exists (select 1 from lessons x join auth.users u on u.id = x.owner where lower(u.email) = e);
  return jsonb_build_object('ok', true);
end $$;

-- 이 수업의 슬라이드 그림을 다른 수업(복제한 수업, 내가 볼 수 없는 수업 포함)도 쓰는지
create or replace function slide_dir_shared(p_lesson uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select can_lesson(p_lesson) and exists (
    select 1 from lessons a join lessons b on b.id <> a.id
    where a.id = p_lesson and a.slide_dir <> '' and split_part(b.slide_dir, '?', 1) = split_part(a.slide_dir, '?', 1))
$$;

revoke all on function my_profile() from public;
revoke all on function save_profile(text, text, text) from public;
revoke all on function lesson_people(uuid) from public;
revoke all on function add_member(uuid, text) from public;
revoke all on function remove_member(uuid, text) from public;
revoke all on function slide_dir_shared(uuid) from public;
grant execute on function my_profile() to authenticated;
grant execute on function save_profile(text, text, text) to authenticated;
grant execute on function lesson_people(uuid) to authenticated;
grant execute on function add_member(uuid, text) to authenticated;
grant execute on function remove_member(uuid, text) to authenticated;
grant execute on function slide_dir_shared(uuid) to authenticated;
grant execute on function my_email() to authenticated;
grant execute on function can_lesson(uuid) to authenticated;
grant execute on function can_activity(uuid) to authenticated;
grant execute on function can_student(uuid) to authenticated;
grant execute on function can_lesson_path(text) to authenticated;

revoke all on function student_enter(text, text, text, text, boolean) from public;
revoke all on function student_state(text, text, text, boolean) from public;
revoke all on function teacher_students(uuid, boolean) from public;
revoke all on function student_sim(text, uuid) from public;
revoke all on function student_save(text, uuid, jsonb) from public;
revoke all on function create_lesson(text, text) from public;
grant execute on function student_enter(text, text, text, text, boolean) to anon, authenticated;
grant execute on function student_state(text, text, text, boolean) to anon, authenticated;
revoke all on function student_live(text, text, jsonb) from public;
grant execute on function student_live(text, text, jsonb) to anon, authenticated;
revoke all on function student_screen(text, text, text, text, text, text) from public;
grant execute on function student_screen(text, text, text, text, text, text) to anon, authenticated;
revoke all on function teacher_screen(uuid, uuid, text, text, text) from public;
grant execute on function teacher_screen(uuid, uuid, text, text, text) to authenticated;
grant execute on function teacher_students(uuid, boolean) to authenticated;
grant execute on function student_sim(text, uuid) to anon, authenticated;
grant execute on function student_save(text, uuid, jsonb) to anon, authenticated;
grant execute on function create_lesson(text, text) to authenticated;
grant execute on function is_teacher() to authenticated;

-- ------------------------------------------------------------
-- 슬라이드 그림 저장소: 누구나 주소로 볼 수 있고(학생 화면), 교사만 올리고 지운다.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('slides', 'slides', true, 3145728, array['image/jpeg', 'image/png'])
  on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg', 'image/png'];

drop policy if exists slides_teacher_read on storage.objects;
drop policy if exists slides_teacher_insert on storage.objects;
drop policy if exists slides_teacher_update on storage.objects;
drop policy if exists slides_teacher_delete on storage.objects;
create policy slides_teacher_read on storage.objects for select to authenticated using (bucket_id = 'slides' and is_teacher());
-- 올리고 지우기는 내 폴더(교사id/…)이거나, 볼 수 있는 수업의 폴더(만든교사id/수업id/…, 공동작업자)에서만
create or replace function can_slide_path(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_teacher() and ((storage.foldername(p_name))[1] = auth.uid()::text or can_lesson_path((storage.foldername(p_name))[2]))
$$;
grant execute on function can_slide_path(text) to authenticated;
create policy slides_teacher_insert on storage.objects for insert to authenticated with check (bucket_id = 'slides' and can_slide_path(name));
create policy slides_teacher_update on storage.objects for update to authenticated using (bucket_id = 'slides' and can_slide_path(name)) with check (bucket_id = 'slides' and can_slide_path(name));
create policy slides_teacher_delete on storage.objects for delete to authenticated using (bucket_id = 'slides' and can_slide_path(name));

-- ------------------------------------------------------------
-- 학생이 답으로 올리는 파일(질문 종류 「파일 올리기」): 비공개 저장소. 교사만 열어 보고 지운다.
-- 학생은 로그인하지 않으므로, 먼저 student_upload_ticket 으로 올릴 자리(파일 이름)를 받고 15분 안에 그 자리에만 올릴 수 있다.
-- 파일 이름: 수업id/활동id_학생id_무작위.확장자
-- ------------------------------------------------------------
create table if not exists upload_tickets (
  name       text primary key,
  student_id uuid not null references students(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists upload_tickets_student on upload_tickets (student_id, created_at);
alter table upload_tickets enable row level security;   -- 정책 없음: 아래 함수로만 쓴다

create or replace function student_upload_ticket(p_token text, p_activity uuid, p_ext text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  s students;
  a activities;
  l lessons;
  n text;
begin
  select * into s from students where token = p_token and p_token is not null;
  if not found then return jsonb_build_object('error', 'logged_out'); end if;
  select * into a from activities where id = p_activity;
  if not found or a.kind = 'sim'
     or not exists (select 1 from lesson_students where lesson_id = a.lesson_id and student_id = s.id)
     or not exists (select 1 from jsonb_array_elements(a.questions) q where q ->> 'type' = 'file') then
    return jsonb_build_object('error', 'no_activity');
  end if;
  select * into l from lessons where id = a.lesson_id;
  if not l.open then return jsonb_build_object('error', 'closed'); end if;
  if a.kind = 'quiz' and exists (select 1 from responses where student_id = s.id and activity_id = a.id) then
    return jsonb_build_object('error', 'already');
  end if;
  if coalesce(p_ext, '') !~ '^[a-z0-9]{1,5}$' then return jsonb_build_object('error', 'bad_file'); end if;
  delete from upload_tickets where created_at < now() - interval '1 day';
  if (select count(*) from upload_tickets where student_id = s.id and created_at > now() - interval '1 hour') >= 40 then
    return jsonb_build_object('error', 'too_many');
  end if;
  n := a.lesson_id || '/' || a.id || '_' || s.id || '_' || encode(gen_random_bytes(8), 'hex') || '.' || p_ext;
  insert into upload_tickets (name, student_id) values (n, s.id);
  return jsonb_build_object('path', n);
end $$;

create or replace function submission_ticket_ok(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from upload_tickets where name = p_name and created_at > now() - interval '15 minutes')
$$;

revoke all on function student_upload_ticket(text, uuid, text) from public;
revoke all on function submission_ticket_ok(text) from public;
grant execute on function student_upload_ticket(text, uuid, text) to anon, authenticated;
grant execute on function submission_ticket_ok(text) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('submissions', 'submissions', false, 10485760, array[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'application/pdf', 'text/plain',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/x-hwp', 'application/vnd.hancom.hwpx', 'application/zip',
    'audio/mpeg', 'audio/mp4', 'video/mp4', 'video/quicktime'])
  on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists submissions_student_insert on storage.objects;
drop policy if exists submissions_student_read on storage.objects;
drop policy if exists submissions_teacher_read on storage.objects;
drop policy if exists submissions_teacher_delete on storage.objects;
create policy submissions_student_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'submissions' and submission_ticket_ok(name));
create policy submissions_student_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'submissions' and submission_ticket_ok(name));
-- 교사는 볼 수 있는 수업의 폴더(수업id/…)만
create policy submissions_teacher_read on storage.objects for select to authenticated using (bucket_id = 'submissions' and can_lesson_path((storage.foldername(name))[1]));
create policy submissions_teacher_delete on storage.objects for delete to authenticated using (bucket_id = 'submissions' and can_lesson_path((storage.foldername(name))[1]));

-- ------------------------------------------------------------
-- 교사 이메일: happywax0206@gmail.com 을 자기 이메일(소문자)로 바꾸세요. 여러 명이면 줄을 더하면 됩니다.
-- 함께 쓸 선생님은 여기에 적지 않아도 됩니다: 교사 화면 「프로필·공동작업자」 탭에서 이메일로 초대하면 됩니다.
-- ------------------------------------------------------------
insert into teachers (email) values ('happywax0206@gmail.com') on conflict do nothing;

-- 바뀐 표·함수를 웹앱이 바로 알아보도록 목록을 새로 읽게 한다
notify pgrst, 'reload schema';
