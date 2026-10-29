# 작업 메모 (Claude Code용)

수업 응답 웹앱. 화면은 GitHub Pages(이 저장소 `main` 브랜치 루트), 데이터·파일은 Supabase. 빌드 도구 없음: 파일을 고쳐 push하면 1~2분 뒤 사이트에 반영된다. 사용법·설치는 README.md.

- 저장소: https://github.com/happywax0206-byte/-  ·  사이트: https://happywax0206-byte.github.io/-/ (교사 화면은 끝에 `teacher.html`)
- 사용자는 개발자가 아니다. 설명은 한국어로 쉽게, 명령은 대신 실행해 준다.
- `config.js`에는 publishable 키만 둔다(공개 저장소). secret 키나 학생 자료는 절대 커밋하지 않는다.
- JS/CSS를 고치면 `index.html`, `teacher.html`의 `?v=` 값을 바꿔 캐시를 깬다.
- DB를 바꾸면 `setup.sql`에 반영한다(여러 번 실행해도 안전하게). 사용자가 Supabase SQL Editor에서 직접 Run 해야 하므로 꼭 알린다.
- 문법 검사: node가 없으면 VS Code에 든 것을 쓴다 — `ELECTRON_RUN_AS_NODE=1 "<VS Code 경로>/Code.exe" -e "new Function(require('fs').readFileSync('student.js','utf8'))"`
- **지난 변경 기록은 `HISTORY.md`** (날짜별, 기능·함수 이름이 적혀 있음). 필요할 때만 grep으로 찾아 읽고, 작업을 끝내면 맨 아래에 한두 줄 더한다. 이 파일에는 기록을 쌓지 않는다.

## 파일

- 학생: `index.html` + `student.js` · 교사: `teacher.html` + `teacher.js` · 둘이 같이 씀: `common.js`, `app.css`
- 수업 화면(프로젝터): `present.html` + `present.js` (교사 탭과 BroadcastChannel)
- DB·보안 규칙·함수 전부: `setup.sql` · Supabase 사용량 읽는 Chrome 확장: `extension/` · 라이브러리: `vendor/`
- 독립 시뮬레이션 페이지(수업 앱과 별개): beats, pendulum, pendulum-advanced, spring, string-pulse, drum, circuit, binary-doppler, sonic-boom (`.html`)

## 꼭 지킬 것 (예전에 버그가 났던 곳)

- 최상위 `let/const`를 쓰는 함수는 파일 끝에서 시작할 것(student.js `start()`가 위에 있어 ReferenceError 났었음).
- DOM `replaceChildren`/`append`에 `null`을 넘기지 말 것(글자 "null"이 들어감, `h()`와 다름).
- SQL에서 조건(where) 없는 `delete`/`update`를 쓰지 말 것: Supabase(pg_safeupdate)가 함수 안에서도 거부한다. 전부 지울 때는 `where true`(PGlite 시험으로는 안 잡힘).
- plpgsql 함수 안에서 변수와 같은 이름의 표 별칭(`... from jsonb_array_elements(x) q` + 변수 `q`)을 쓰지 말 것: "ambiguous" 오류로 함수가 통째로 실패한다(퀴즈 제출이 2주 동안 안 됐었음).
- `students` 표에 칸을 더하면 setup.sql의 `grant select (...) on students` 목록도 고칠 것(교사는 token·pin_hash를 못 봄).

## 사용자 차례로 남은 일

- Resend 키 넣기(버그 제보 메일): SQL Editor에서 `insert into app_secrets values ('resend_key','re_…') on conflict (key) do update set value = excluded.value;`
- 공동작업자 「보기만」을 실제 Supabase·브라우저로 확인.
- 보안 제안 중 아직 안 고른 것: 4자리 PIN 추측(흔한 PIN 금지·잠금 늘리기). (「Confirm email」은 켜져 있음 확인, 2026-10-30)
