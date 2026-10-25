# 작업 메모 (Claude Code용)

수업 응답 웹앱. 화면은 GitHub Pages(이 저장소 `main` 브랜치 루트), 데이터·파일은 Supabase. 빌드 도구 없음: 파일을 고쳐 push하면 1~2분 뒤 사이트에 반영된다. 사용법·설치는 README.md.

- 저장소: https://github.com/happywax0206-byte/-  ·  사이트: https://happywax0206-byte.github.io/-/ (교사 화면은 끝에 `teacher.html`)
- 사용자는 개발자가 아니다. 설명은 한국어로 쉽게, 명령은 대신 실행해 준다.
- `config.js`에는 publishable 키만 둔다(공개 저장소). secret 키나 학생 자료는 절대 커밋하지 않는다.
- JS/CSS를 고치면 `index.html`, `teacher.html`의 `?v=` 값을 바꿔 캐시를 깬다.
- DB를 바꾸면 `setup.sql`에 반영한다(여러 번 실행해도 안전하게). 사용자가 Supabase SQL Editor에서 직접 Run 해야 한다.
- 문법 검사: node가 없으면 VS Code에 든 것을 쓴다 — `ELECTRON_RUN_AS_NODE=1 "<VS Code 경로>/Code.exe" -e "new Function(require('fs').readFileSync('student.js','utf8'))"`

## 진행 상황

- 2026-10-15: 질문 종류 「파일 올리기」 추가(학생이 사진·문서를 답으로 제출).
  - 비공개 저장소 `submissions`. 학생은 `student_upload_ticket`으로 받은 자리(`수업id/활동id_학생id_무작위.확장자`)에만 15분 안에 올린다. `student_save`가 그 파일이 실제로 있는지 확인한다. 교사는 signed URL로 연다.
  - **남은 일 (파일 올리기):** 사용자가 setup.sql을 Supabase에서 다시 Run 했는지 확인하지 못했다. 실제 사이트에서 휴대폰으로 올리고 교사 화면에서 여는 시험도 아직 안 했다.
- 2026-10-23: 맥놀이 시뮬레이션 `beats.html` 추가(수업 앱과 별개인 단독 페이지, Web Audio로 두 사인파를 들려주고 파형·포락선을 소리와 맞춰 그림). 주소: https://happywax0206-byte.github.io/-/beats.html
- 2026-10-25: 진자 주기 시뮬레이션 `pendulum.html` 추가(길이·g(행성 11곳 + 직접 입력)·진폭 조절). 계산은 근사 T=2π√(L/g)와 실제 진자(운동 방정식 RK4, 주기는 AGM 공식) 중 전환. 비교: 다른 길이·지구·근사 vs 실제. 주소: https://happywax0206-byte.github.io/-/pendulum.html
  - 페이지 이동 버튼(제목 위 오른쪽, 네 페이지 모두 같은 마크업·순서): [용수철 진자 `spring.html`][단진자][이중진자][혼돈 용수철]. 이중진자·혼돈 용수철은 `pendulum-advanced.html?type=double|spring` 한 페이지(궤적 남기기, RK4). 이중진자·혼돈 용수철에만 라그랑주 역학 설명(KaTeX)과 실시간 위치·속도·가속도 표가 있다(단진자에서는 사용자 요청으로 뺐음).
  - 2026-10-25: (위아래) 용수철 진자 `spring.html` 추가(T=2π√(m/k) 하나만, 단진자 페이지와 같은 구성: 행성 g, 진폭, 비교(질량·k·지구), 그래프, 공식 칸). 처음 이름은 「수직 용수철」이었고, 예전 「용수철 진자」(탄성 진자)는 「혼돈 용수철」로 이름을 바꿨다.
  - 단진자·용수철 진자는 기본이 「같은 눈금」(고정 축척), 「크게 보기」 버튼으로 자동 축척.
