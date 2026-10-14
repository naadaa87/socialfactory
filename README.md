# 소셜팩토리 홈페이지 (SOCIAL FACTORY)

2015년 홍대에서 시작한 모임공간 소셜팩토리의 공식 홈페이지입니다. 현재 공간은 소셜팩토리 건대(서울 광진구 화양동 10-1 한아름건물 4층)입니다.
빌드 과정이 없는 정적 사이트라 GitHub에 올리고 Cloudflare Pages에 연결하면 바로 배포됩니다.

## 폴더 구성

```
index.html        메인 — 소개 영상, 룸 고르기(인원·진행 방식), 4층 조감도, 배치 안내, 요금 요약·정기대관·빠른 상담, 코워킹·사무실, 브랜드(250평·2015·340곳), 강사 모집·대형 공간 상담 배너, 오시는 길·FAQ
space.html        공간 안내 — ① 구조·사진(룸 비교표·상세) ② 배치·동선(배치 이름·조감도·평면도) ③ 기능·장비(장비 표·옵션) ④ 이용 가격, 코워킹, 독립사무실, 3D, 오시는 길
pricing.html      이용 요금 — 예상 금액 계산기(PDF 저장·인쇄·문의 연결), 룸 시간 요금, 시간대, 장비·기본 제공, 옵션, 코워킹, 독립사무실 월 이용료, 취소·환불, 정기대관·제휴
guide.html        이용 안내 — 예약부터 퇴실까지, 이용 원칙, 운영 시간, 요금·취소·환불, 오시는 길, FAQ
contact.html      대관과 이용 문의 — 빠른 상담 안내, 채널, 문의 폼(접수번호 발급 · 계산기 내용 자동 입력), 강사 모집·대형 공간 상담
about.html        소셜팩토리 소개 — 운영 기준, 로고, 이력, 창업자
program.html      프로그램·호스트 모집 — 함께하는 방법, 제휴·협업, 현재 모집, 소셜아카데미, 소셜패밀리, 기업·단체, 활용 예시, 홍대 시절 기록
history.html      지난 기록 2015–2021
tour.html         3D 공간 안내 (three.js 포함, 약 0.8MB · 참고 이미지는 images/tour/ 에서 필요할 때 불러옴)
admin.html        문의 · 회원 관리 화면 (관리자 키 입력 · 검색엔진 제외)
404.html          없는 주소 안내
css/style.css     디자인
js/site-config.js ★ 운영 상태 · 연락처 · 예약 채널 · 요금 · 장비 · 정책 설정 파일 (여기만 고치면 전 페이지에 반영)
js/main.js        메뉴 · 설정값 반영 · 룸 고르기 · 문의 폼 동작
js/estimate.js    예상 금액 계산기 (이용 요금 페이지 전용)
images/           로고(svg) · 브랜드 이미지 · OG 이미지
images/space/     룸 · 코워킹 · 사무실 공간 이미지 28장 (큰 파일 + -sm 작은 파일)
images/aerial/    4층 조감도 5장 (큰 파일 + -sm 작은 파일)
images/hero/      메인 소개 영상의 첫 장면 이미지 (영상을 불러오기 전에 보임)
video/            메인 소개 영상 (PC용 720p · 모바일용 480p, mp4 · webm)
images/scenes/    활용 예시 이미지 38장
images/tour/      3D 안내의 참고 이미지 32장과 원본 도면 1장
fonts/            영문 서체 Montserrat (한글 Pretendard는 CDN)
login.html · signup.html · mypage.html   로그인 · 회원가입(이메일 · 카카오) · 마이페이지(내 정보 · 문의 처리 상태 · 비밀번호 · 탈퇴)
terms.html · privacy.html                이용약관 · 개인정보 처리방침
js/member.js      회원 화면 동작
functions/api/inquiry.js  문의 접수 API (Cloudflare Pages Functions)
functions/api/auth/*      회원가입 · 로그인 · 로그아웃 · 내 정보 · 비밀번호 · 카카오 로그인 API
functions/api/member/inquiries.js  마이페이지 문의 목록 API
functions/api/admin/members.js     관리 화면 회원 API
functions/_lib/auth.js    회원 기능 공통 코드 (주소로 열리지 않음)
schema.sql        문의 · 회원 저장용 D1 테이블 (처음 설정할 때)
schema-upgrade-members.sql  문의 표를 이미 쓰고 있을 때 회원 표만 추가
_headers          보안 · 캐시 헤더
robots.txt, sitemap.xml, rss.xml   검색엔진용 (README 6번 참고)
```

## 0. 공개 전에 꼭 정할 것

홈페이지는 값이 비어 있어도 깨지지 않도록 만들어져 있지만, 아래 항목은 **공개 전에** `js/site-config.js`에 채우거나 결정해야 고객 안내가 정확해집니다.

| 항목 | 설정 위치 | 비어 있을 때 화면 |
| --- | --- | --- |
| 정식 주소(도메인) | `siteUrl` + 각 html의 canonical/OG, robots.txt, sitemap.xml (아래 5번) | 기본값 `https://socialfactory.co.kr` |
| 운영 상태 | `status.mode` (`preparing`/`open`) | 화면 맨 위 운영 안내 띠는 2026-10-11에 없앴습니다 (값은 남겨 둠) |
| 예약 채널 · 상담 채널 (카카오톡 문의채널 · 이메일은 입력 완료) | `contact.*`, `booking.primary` | 채널 버튼 숨김, 예약 버튼은 '대관 문의하기'로 대체 |
| 요금 (2026년 10월 최종 가격구조도 반영 완료) | `pricing.*` | — |
| 공휴일 (2026~2027년 입력 완료) | `pricing.holidays` — 2028년 공휴일은 2027년 안에 추가 | 빠진 날은 계산기에서 직접 체크 |
| 룸별 장비 · 배치별 인원 | `rooms.r1~r5` | "확인 중" 표시 |
| 주차 · 대중교통 · 승강기 | `parking`, `directions`, `elevator` | 해당 줄 숨김 또는 "확인 후 안내" |
| 개인정보 보유 기간 | `inquiry.retention` (실제 삭제 기준과 같게) | 기본 "문의 처리 완료 후 6개월" |
| 문의 폼 공개 여부 | `inquiry.enabled` — D1(3번)도 메일(`contact.email`)도 없으면 `false` 권장 | 폼 대신 준비 중 안내 |
| 회원 기능 | `members.enabled` — D1 연결(3번)을 마친 뒤 `true` | 메뉴의 '로그인'이 숨겨짐 |

## 1. 배포하기 (브라우저만으로 가능)

### GitHub에 올리기
1. github.com 에 로그인 → 오른쪽 위 **+** → **New repository**
2. Repository name: `socialfactory`, **Public**, 나머지는 그대로 두고 **Create repository**
3. 만들어진 빈 저장소 화면에서 **uploading an existing file** 링크 클릭
4. 이 압축을 푼 폴더 안의 **모든 파일과 폴더**를 드래그해서 올립니다
   (`css`, `js`, `images`, `fonts`, `functions` 폴더째로 올리면 됩니다. `_headers`처럼 밑줄로 시작하는 파일도 꼭 포함)
   GitHub는 한 번에 100개 파일까지만 받으므로, 전체 파일 수가 많다고 나오면 나눠 올립니다.
   ① `images` 폴더를 뺀 나머지 전부 → Commit ② **Add file → Upload files**에서 `images/space` → Commit ③ `images/scenes` → Commit ④ `images/tour`, `images/aerial`, `images/hero` 와 나머지 이미지 → Commit ⑤ `video` → Commit
5. **Commit changes** 클릭

이미 저장소가 있다면 바뀐 파일만 같은 자리에 다시 올리면 됩니다.
- 2026-10-11 회원 기능 추가: html 전부, `admin.html`, `css/style.css`, `js/main.js`, `js/site-config.js`, `js/member.js`(새 파일), `functions/` 폴더 전체, `schema.sql`, `schema-upgrade-members.sql`(새 파일), `README.md`, `sitemap.xml`, `rss.xml`
- 2026-10-11 메인 첫 화면 정리 · 맨 위 운영 안내 띠 삭제: html 9개(tour·admin 제외), `css/style.css`, `js/site-config.js`, `README.md`, `rss.xml`
- 2026-10-11 최종 가격구조 · 계산기 반영: html 전부, `tour.html`, `css/style.css`, `js/site-config.js`, `js/main.js`, `js/estimate.js`(새 파일), `functions/api/inquiry.js`, `README.md`, `sitemap.xml`, `rss.xml`
- 2026-10-10 요금 반영: html 전부, `pricing.html` 추가, `css/style.css`, `js/site-config.js`, `js/main.js`, `functions/api/inquiry.js`, `admin.html`, `sitemap.xml`
- 2026-10-10 메인 영상 반영: html 전부, `tour.html`, `css/style.css`, `js/main.js`, `_headers`, `README.md`, `video/` 폴더와 `images/hero/` 폴더 새로 추가, `images/aerial/05-topview*.webp` 새 파일
- 2026-10-10 이미지 반영: html 전부, `css/style.css`, `js/main.js`, `images/og-image.jpg`, `images/space/27~39` 새 파일, `images/aerial/` 폴더 새로 추가. 저장소의 `images/space` 에서 01·02·04·05·06·13·16·19·20·21·22번 파일은 더 이상 쓰지 않으니 지워도 됩니다.

### 올린 뒤 화면이 깨져 보일 때
새 html과 브라우저에 남아 있던 예전 CSS·JS가 섞이면 레이아웃이 어긋나고 영상이 나오지 않습니다. 2026-10-10 이후 html은 CSS·JS 주소 끝에 `?v=버전` 값을 붙여 부르므로 새로 올리면 바로 새 파일을 받습니다. 그래도 이상하면 `Ctrl+Shift+R`(Mac은 `Cmd+Shift+R`)로 새로고침하거나 시크릿 창에서 확인해 주세요.
`js/site-config.js` 를 GitHub에서 직접 고친 경우에는 5분 안에 반영됩니다.

여러 번에 나눠 올릴 때는 폴더 위치를 그대로 지켜 주세요. `images` 폴더 안의 `space`, `tour` 폴더나 이미지 파일을 저장소 맨 위에 올리면 화면에는 쓰이지 않는 복사본만 늘어납니다.

### Cloudflare Pages에 연결하기
1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. GitHub 계정을 연결하고 `socialfactory` 저장소 선택
3. 설정 화면
   - Project name: **`socialfactory-kondae`** 처럼 비어 있는 이름 (`socialfactory.pages.dev` 는 다른 서비스가 이미 쓰고 있어 소셜팩토리 주소로 쓸 수 없습니다)
   - Framework preset: **None** / Build command: 비워 둠 / Build output directory: `/`
4. **Save and Deploy** → 1~2분 뒤 `https://socialfactory-kondae.pages.dev` 같은 주소가 열립니다
5. 바로 **Custom domains** 에서 `socialfactory.co.kr` 를 연결합니다 (아래 5번). 도메인을 연결하기 전까지는 Pages 주소를 `siteUrl` 등에 임시로 넣어 둡니다.

이후에는 GitHub에서 파일을 고치고 Commit 할 때마다 자동으로 다시 배포됩니다.

## 2. 내용 바꾸기

### 운영 정보 → `js/site-config.js`
GitHub에서 `js/site-config.js` 를 열고 연필 아이콘(Edit)을 눌러 값을 채운 뒤 Commit 합니다. 각 항목 옆에 예시가 적혀 있습니다. 값은 따옴표 안에만 적고 쉼표를 지우지 않도록 주의하세요.

- `status` 운영 상태 — 맨 위 안내 띠는 없앴고, 값은 나중에 다시 쓸 수 있도록 남겨 두었습니다.
- `contact` 채널 주소 — 비워 두면 버튼이 나오지 않습니다. `booking.primary` 에 `"naver"` 처럼 대표 예약 채널을 적으면 룸마다 '예약 채널에서 일정 확인' 버튼이 생깁니다.
- `pricing` — 2026년 10월 최종 가격구조도의 요금이 들어 있습니다. 룸 시간 요금(`pricing.rooms.r1~r5`의 wdEarly · wdStd · hdEarly · hdStd)과 최대 인원(`max`), 옵션(`options`), 코워킹 이용권(`coworkingPasses`), 독립사무실 월 이용료와 장기 할인(`officeRooms`, `officeDiscounts`), 취소·환불(`refund`), 공휴일(`holidays`)이 모두 여기에 있고, 메인 · 공간 안내 · 이용 요금 표와 예상 금액 계산기 · PDF가 이 값을 그대로 씁니다.
  - 시간대: 오전 07~12시(wdEarly · hdEarly), 오후·저녁 12~24시(wdStd · hdStd), 심야 24~07시는 오전 요금. 심야는 그날과 다음 날이 모두 주말·공휴일일 때만 주말 요금입니다(가격구조도의 금·토·일 기준).
  - 메인과 공간 안내의 코워킹·사무실 대표 요금 한 줄은 `pricing.coworking`, `pricing.office` 에 있습니다.
  - 계산 예시 카드(이용 요금 페이지)와 일부 설명 문장은 html에 직접 적혀 있으니, 요금을 크게 바꾸면 `pricing.html` 의 '계산 예시'도 함께 고쳐 주세요.
- `rooms`, `policy` — 룸별 장비와 배치별 실제 인원은 현장에서 확인한 뒤 채웁니다. 비어 있으면 "확인 중"으로 표시됩니다.
- 정기대관 · 제휴 별도 문의, 빠른 상담(일자·시간·인원·모임 유형), 강사·호스트·모임장 모집, 대형 공간 활용 상담 배너는 여러 페이지에 함께 들어 있습니다. 문구를 바꿀 때는 각 html에서 같은 문장을 모두 찾아 함께 바꿔 주세요.
- `inquiry.retention` — 개인정보 안내문의 보유 기간. 실제 삭제 작업과 같은 기준으로 적습니다.
- `company` — 채우면 푸터에 표기됩니다. 계약서·결제 안내의 사업자명과 같아야 합니다.

### 문구 바꾸기
각 `.html` 파일을 GitHub에서 열어 글자만 고치면 됩니다. 꺾쇠(`< >`) 안의 내용은 건드리지 않고 그 사이의 글자만 바꾸세요.
룸 상세 다섯 개와 비교표는 같은 틀로 만들어져 있습니다. 룸 이름·치수·설명을 바꾸려면 `space.html`에서 해당 글자를 찾아 고치면 됩니다.

### 사진 바꾸기
`images/` 폴더의 파일을 **같은 이름**으로 덮어쓰면 페이지 수정 없이 바뀝니다. 이미지 캐시는 하루라서 늦어도 다음 날 모든 방문자에게 반영됩니다.
룸·코워킹·사무실 이미지는 소셜팩토리 건대의 현재 공간 이미지입니다. 배치 안내에 붙은 `공간 활용 예시` 라벨은 같은 방을 다른 배치로 쓴 예시라는 뜻입니다.

조감도 위의 번호(1~5, 코·사·휴·입)는 html 안에 `style="left:43.5%;top:69.4%"` 처럼 그림 대비 위치로 적혀 있습니다. 같은 구도의 그림으로 바꿀 때는 그대로 두면 되고, 각도가 다른 그림으로 바꾸면 번호 위치도 함께 고쳐야 합니다.

| 파일 | 쓰이는 곳 |
| --- | --- |
| `space/03~39-*.webp` | 룸 1~5 · 코워킹 · 독립사무실 · 복도 (메인 카드 · 공간 페이지 · 배치 안내) |
| `aerial/01-front` | 메인 '4층 한눈에 보기' (번호 표시) |
| `aerial/02-southeast` | 공간 안내 맨 위 |
| `aerial/03-overhead` | 공간 안내 평면도 위 (번호 표시) |
| `aerial/04-panorama` | 소개 페이지 운영 이력 옆 |
| `aerial/05-topview` | 메인 첫 화면의 '4층 한눈에 보기' 카드 |
| `hero/brand-poster.webp`, `-sm` | 메인 소개 영상의 첫 장면 (영상이 재생되기 전, 동작 줄이기 설정을 켠 방문자에게 보임) |
| `scenes/01~38-*.webp` | 활용 예시 38장면 (프로그램 페이지, 메인) |
| `tour/01~32.jpg`, `tour/33.png` | 3D 안내의 참고 이미지와 원본 도면 |
| `signage.webp`, `welcome.webp` | 브랜드 이미지 |
| `og-image.jpg` | 링크를 공유할 때 보이는 미리보기 (1200×630) |
| `kakao-qr.svg` | 문의 페이지의 카카오톡 문의채널 QR (https://pf.kakao.com/_uTiFX). 채널 주소를 바꾸면 이 파일도 새 QR로 바꿔야 합니다 |

`-sm.webp` 로 끝나는 파일은 모바일용 작은 버전입니다. 같은 사진을 가로 800px로 줄여 함께 올리면 가장 좋고, 없으면 큰 파일을 같은 이름으로 두 번 올려도 됩니다.

### 메인 소개 영상
`video/brand-720.mp4`(PC) · `brand-480.mp4`(모바일)과 같은 내용의 `.webm` 두 개가 있습니다. 소리 없이 반복 재생되고, 화면에 보일 때만 재생되며 오른쪽 위 버튼으로 멈출 수 있습니다. 휴대폰의 '동작 줄이기'나 데이터 절약 모드를 켠 방문자에게는 자동 재생하지 않고 첫 장면 이미지만 보여 줍니다.
영상을 바꾸려면 네 파일을 같은 이름으로 덮어쓰고, 첫 장면 이미지(`images/hero/brand-poster.webp`, `brand-poster-sm.webp`)도 새 영상의 첫 장면으로 바꿔 주세요. GitHub 웹 업로드는 파일 하나당 25MB까지라 영상은 10MB 이하로 줄여 올리는 것이 좋습니다.

### 3D 안내
`tour.html` 에 3D 실행 코드가, `images/tour/` 에 참고 이미지가 있습니다. 공간 페이지에서 같은 자리에 끼워 보거나 새 창으로 엽니다. 방을 고르면 그 방의 사진·이용 조건과 문의로 바로 가는 링크가 나옵니다. 새 3D 파일을 받으면 같은 방식으로 이미지를 분리해 넣어야 하므로, 교체가 필요하면 제작자에게 요청하는 편이 빠릅니다.

### 평면도
공간 페이지의 평면도는 `space.html` 안에 그림(SVG)으로 들어 있습니다. 도면에 적힌 치수와 높이만 표기했고, 도면에 없는 높이는 '미기재'로 두었습니다.

## 3. 문의 접수 · 회원 기능 켜기

문의 폼과 회원 기능(이메일 가입 · 카카오 로그인 · 마이페이지)은 Cloudflare의 무료 데이터베이스 **D1** 에 저장됩니다. 모든 설정은 브라우저(Cloudflare 대시보드)에서 할 수 있습니다.

### 3-1. 데이터베이스 만들기 (처음 한 번)
1. dash.cloudflare.com → 왼쪽 메뉴 **Storage & databases** → **D1 SQL database** → **Create Database** → 이름 `socialfactory-db` → **Create**
2. 만든 데이터베이스 → **Console** 탭 → 저장소의 `schema.sql` 파일 내용 전체를 복사해 붙여 넣고 **Execute**
   - 예전에 문의 표(inquiries)를 이미 만들어 쓰고 있었다면 `schema.sql` 대신 `schema-upgrade-members.sql` 을 실행합니다 (기존 문의는 그대로 남습니다).
3. **Workers & Pages** → 소셜팩토리 Pages 프로젝트 → **Settings** → **Bindings** → **Add** → **D1 database** → Variable name `DB`, D1 database 는 위에서 만든 `socialfactory-db` → **Save**

### 3-2. 비밀 값 넣기
같은 프로젝트 → **Settings** → **Variables and Secrets** → **Add** 로 하나씩 넣습니다. 종류는 **Secret(암호화)** 으로 고릅니다.

| 이름 | 값 | 용도 |
| --- | --- | --- |
| `ADMIN_KEY` | 영문 · 숫자를 섞은 30자 이상 아무 문자열 | 관리 화면(`/admin`) 열쇠. 남에게 알려 주지 않습니다 |
| `SESSION_SECRET` | 영문 · 숫자를 섞은 40자 이상 아무 문자열 (ADMIN_KEY 와 다르게) | 카카오 로그인 가입 확인용 서명 |
| `IP_SALT` | 아무 문자열 | 스팸 방지용 IP 변환에 섞는 값 |
| `KAKAO_REST_KEY` | 카카오 앱의 REST API 키 (3-5) | 카카오 로그인 |
| `KAKAO_CLIENT_SECRET` | 카카오 앱의 클라이언트 시크릿 코드 (3-5) | 카카오 로그인 |
| `NOTIFY_WEBHOOK` | (선택) Discord · Slack 웹후크 주소 (3-4) | 새 문의 알림 |

### 3-3. 다시 배포하고 확인
1. **Deployments** → 가장 위 배포 오른쪽 **⋯** → **Retry deployment** (바인딩과 비밀 값은 새 배포부터 적용됩니다)
2. 홈페이지 문의 폼으로 시험 문의를 1건 보내 접수번호(SF-…)가 나오는지 확인합니다.
3. `https://socialfactory.co.kr/admin` 에서 ADMIN_KEY 를 넣고 **불러오기** → 문의 탭에 방금 문의가 보이면 끝입니다. 상태(새 문의 · 진행 중 · 처리 완료)를 바꾸면 회원의 마이페이지에도 '접수 · 상담 중 · 완료'로 바로 보입니다.

### 3-4. (선택) 새 문의를 휴대폰으로 알림 받기 — Discord 예시
1. Discord 앱에서 내 서버를 하나 만들고, 알림 받을 채널 옆 톱니바퀴(채널 편집) → **연동** → **웹후크** → **새 웹후크** → **웹후크 URL 복사**
2. 3-2 의 `NOTIFY_WEBHOOK` 에 붙여 넣고 다시 배포합니다. Slack 의 Incoming Webhook 주소도 그대로 쓸 수 있습니다.
3. 알림 전송 결과는 관리 화면 문의 탭의 '알림' 칸에 sent / failed 로 남습니다.

### 3-5. 카카오 로그인 연결
1. developers.kakao.com 로그인 → **내 애플리케이션** → **애플리케이션 추가하기** → 앱 이름 `소셜팩토리`, 회사명, 카테고리 입력 → 저장
2. **앱** → **플랫폼 키** → **REST API 키** 를 복사해 `KAKAO_REST_KEY` 로 넣습니다.
3. 같은 화면의 **클라이언트 시크릿** 코드를 복사해 `KAKAO_CLIENT_SECRET` 로 넣습니다 (새 앱은 기본으로 켜져 있습니다).
4. 같은 화면의 **리다이렉트 URI** 에 `https://socialfactory.co.kr/api/auth/kakao/callback` 을 등록합니다. (Pages 기본 주소로도 시험하려면 `https://프로젝트이름.pages.dev/api/auth/kakao/callback` 도 함께)
5. **카카오 로그인** → **사용 설정** → 상태 **ON**
6. **카카오 로그인** → **동의항목** → '닉네임'을 **필수 동의**로 설정합니다. '카카오계정(이메일)'은 선택 동의로 켤 수 있으면 켭니다 (비즈 앱 전환이 필요하다고 나오면 건너뛰어도 됩니다. 가입 화면에서 이메일을 직접 받습니다).
7. Cloudflare 에서 다시 배포하면 로그인 · 회원가입 화면에 '카카오 로그인' 버튼이 자동으로 나타납니다. 키가 비어 있으면 버튼은 숨겨집니다.

### 3-6. 메뉴에 '로그인' 보이게 하기
`js/site-config.js` 의 `members: { enabled: false }` 를 `true` 로 바꾸고 Commit 합니다. 데이터베이스 연결(3-1~3-3)을 마친 뒤에 켜 주세요. 켜기 전에도 `/login`, `/signup` 주소는 열리지만 "회원 기능을 준비하고 있습니다"라고 안내합니다.

### 3-7. 운영할 때
- **비밀번호를 잊은 회원**: 카카오톡 문의채널로 가입 이메일과 이름을 받아 확인한 뒤, 관리 화면 **회원** 탭 → **임시 비밀번호** → 나온 값을 회원에게 알려 줍니다. 회원은 로그인하면 새 비밀번호로 바꾸라는 안내를 받습니다.
- **소식 · 혜택 수신 명단**: 회원 탭 → '소식 수신 동의만' 체크 → **CSV 내려받기**. 광고성 정보는 동의한 회원에게만 보내고, 「정보통신망법」에 따라 동의한 날부터 2년마다 수신 동의 여부를 다시 알려야 합니다.
- **이용 정지 · 삭제**: 회원 탭의 버튼으로 처리합니다. 회원이 직접 탈퇴하면 회원 정보는 바로 지워지고, 남긴 문의는 보관 기간까지 회원과 분리해 남습니다.
- **보관 기간이 지난 문의 정리**: 관리 화면에서 CSV 로 내려받아 둘 것을 정리한 뒤 D1 Console 에서 `DELETE FROM inquiries WHERE created_at < '2026-04-01';` 처럼 삭제합니다.

### 3-8. 개인정보 처리방침 · 이용약관
- `privacy.html`(개인정보 처리방침), `terms.html`(이용약관)이 푸터에 연결되어 있습니다. 운영 법인명은 `site-config.js` 의 `company.name` 을 채우면 두 문서에 자동으로 들어갑니다(비어 있으면 '소셜팩토리').
- 개인정보 보호책임자는 '최시준 (대표)', 연락처는 `contact.email` · 카카오톡 문의채널로 적혀 있습니다. 담당자가 바뀌면 `privacy.html` 7번을 고쳐 주세요.
- 새 문의 알림(Discord · Slack 등)을 쓰면 처리방침 3번 '운영자 알림 메신저' 칸에 실제 서비스 이름을 적어 두는 것이 좋습니다.

D1 을 연결하지 않으면 문의 폼은 "접수되지 않았습니다"를 보여 주고 `contact.email` 이 있을 때만 메일 앱으로 보내는 길을 안내합니다. 둘 다 준비되지 않았다면 `inquiry.enabled: false` 로 폼을 닫아 두세요.

저장 방식: 비밀번호는 PBKDF2 로 되돌릴 수 없게 바꿔 저장하고, 로그인 유지 토큰도 해시만 저장합니다. 원본 IP와 브라우저 정보(User-Agent)는 저장하지 않습니다. 다른 사이트에서 대신 보내는 요청은 서버에서 거부하고, 로그인 실패가 반복되면 15분 동안 막습니다.

## 4. 운영 상태 바꾸기

현재 `js/site-config.js` 의 `status.mode` 는 `"open"`(운영 중)입니다. 화면 맨 위의 운영 안내 띠는 2026-10-11에 요청에 따라 없앴습니다. 다시 필요하면 html을 새로 만들 때 되살릴 수 있습니다.

## 5. 실제 주소로 바꿀 것 (도메인 연결 직후 한 번)

기본 주소는 `https://socialfactory.co.kr` 로 적혀 있습니다. 다른 주소를 쓰게 되면 GitHub 저장소 검색창에 `socialfactory.co.kr` 를 넣어 아래 파일에서 모두 바꿉니다.
- `js/site-config.js` 의 `siteUrl`
- `robots.txt`, `sitemap.xml`, `rss.xml`
- 각 html `<head>` 의 `canonical`, `og:url`, `og:image`
- 각 html 의 구조화 데이터(`application/ld+json`)

도메인 연결: Pages 프로젝트 → **Custom domains** → **Set up a custom domain** → `socialfactory.co.kr` 입력 후 안내대로 DNS 레코드를 추가합니다. 카카오톡·네이버 플레이스 등 외부 채널의 주소와 상호·전화·운영시간도 홈페이지와 같게 맞춥니다.

## 6. 검색 등록 (네이버 · 구글 · 다음)

### 홈페이지에 이미 들어 있는 것
- 페이지마다 검색 결과에 보일 제목과 설명. '건대입구 세미나실 · 강의실 · 회의실 · 모임공간 대관', '건대 스터디카페 · 코워킹', '1인 사무실' 같은 말을 자연스럽게 넣었습니다.
- 대표 주소(canonical). Cloudflare Pages는 `space.html` 을 `/space` 로 보여 주므로, 검색엔진에도 `https://socialfactory.co.kr/space` 처럼 `.html` 없는 주소를 알려 줍니다. 페이지 사이의 링크도 같은 주소를 씁니다.
- 구조화 데이터(검색엔진이 읽는 업체 정보): 상호 '소셜팩토리 건대', 주소, 운영 시간(24시간), 요금 범위(10,000~45,000원), 룸 5개의 인원과 면적, 코워킹·독립사무실, 이메일, 카카오톡 문의채널, 사이트 이름 '소셜팩토리', 페이지 경로, 자주 묻는 질문.
- `sitemap.xml`(페이지 9개와 공간 사진 주소), `rss.xml`(네이버 제출용), `robots.txt`.
- Cloudflare 기본 주소(`*.pages.dev`)는 검색에 나오지 않도록 `_headers` 에 막아 두었습니다. 검색에는 socialfactory.co.kr 주소만 나옵니다.

### 순서
1. **올린 뒤 확인** — 브라우저에서 아래 세 주소가 열리는지 봅니다.
   `https://socialfactory.co.kr/sitemap.xml` · `https://socialfactory.co.kr/rss.xml` · `https://socialfactory.co.kr/robots.txt`
2. **네이버 서치어드바이저** (searchadvisor.naver.com → 웹마스터 도구)
   - 사이트 등록에 `https://socialfactory.co.kr` 입력
   - 소유 확인은 'HTML 태그'를 고릅니다. 나온 `<meta name="naver-site-verification" ...>` 한 줄을 복사해 GitHub에서 `index.html` → 연필(Edit) → `<!-- 검색 등록 확인 태그 ... -->` 줄 바로 아래에 붙여 넣고 Commit 한 뒤, 1~2분 기다려 '소유확인'을 누릅니다.
   - 요청 → 사이트맵 제출: `https://socialfactory.co.kr/sitemap.xml`
   - 요청 → RSS 제출: `https://socialfactory.co.kr/rss.xml`
   - 요청 → 웹 페이지 수집: `https://socialfactory.co.kr/`, `/space`, `/pricing`, `/contact`, `/guide` 를 하나씩 요청
   - 검증 → robots.txt 에서 수집이 허용되는지 확인
3. **구글 서치 콘솔** (search.google.com/search-console)
   - 속성 추가 → **도메인** → `socialfactory.co.kr`. 도메인이 Cloudflare에 연결되어 있으면 안내에 따라 Cloudflare로 자동 인증하거나, 보여 주는 TXT 값을 Cloudflare DNS에 추가합니다. 파일을 고치지 않아도 되어 가장 안전합니다.
   - Sitemaps → `sitemap.xml` 제출
   - URL 검사 → `https://socialfactory.co.kr/` 입력 → 색인 생성 요청
4. **다음 웹마스터도구** (webmaster.daum.net)
   - 사이트 등록 → PIN 코드 발급 → 화면에 나온 인증 줄(`#DaumWebMasterTool:` 로 시작)을 복사해 GitHub의 `robots.txt` 둘째 줄 바로 아래에 붙여 넣고 Commit → 인증 확인
   - 수집 요청 메뉴에서 홈 주소와 주요 페이지를 요청합니다.
5. **지도 · 플레이스 등록** — '건대 세미나실'처럼 지역을 붙인 검색은 지도와 업체 정보가 먼저 나옵니다. 노출에 가장 큰 영향을 주는 단계입니다.
   - 네이버 스마트플레이스(smartplace.naver.com) 업체 등록 · 구글 비즈니스 프로필(business.google.com) · 카카오맵 장소 등록(카카오 비즈니스)
   - 세 곳 모두 상호(소셜팩토리 건대), 주소, 전화번호, 영업시간(매일 07:00~24:00), 홈페이지(https://socialfactory.co.kr)를 **같은 표기**로 적습니다.
   - 사진은 룸 5개, 코워킹, 독립사무실, 휴게 공간, 건물 입구 순서로 올리고, 네이버 대표 키워드는 예를 들어 `건대세미나실` `건대강의실대관` `건대모임공간` `건대회의실` `건대스터디카페` 처럼 실제 찾는 말로 정합니다.
   - 플레이스 주소를 받으면 `js/site-config.js` 의 `contact.naver` 등에 넣어 두세요. 홈페이지 구조화 데이터의 연결 채널(sameAs)에도 같이 반영됩니다.

**확인 태그와 인증 줄은 제작자에게도 보내 주세요.** 다음에 html을 새로 만들어 올릴 때 직접 붙여 넣은 줄이 지워지지 않도록 처음부터 넣어서 만들어 드립니다. 구글을 도메인 방식으로 인증했다면 따로 보낼 것은 없습니다.

### 등록 후
- 검색에 반영되기까지 보통 2~4주가 걸립니다. 서치어드바이저와 서치 콘솔의 '수집 현황', '색인 생성' 화면에서 진행 상황을 볼 수 있습니다.
- `js/site-config.js` 에 대표 전화번호(`contact.phone`)를 넣으면 검색엔진용 업체 정보에도 함께 들어갑니다. 지도에 등록한 번호와 같은 번호로 넣어 주세요.
- 오시는 길(`directions`)은 출구 번호와 도보 시간을 확인해 '건대입구역 ○번 출구에서 도보 ○분'처럼 적으면 검색과 방문자 모두에게 도움이 됩니다. 주차(`parking`)와 승강기(`elevator`)도 확인되는 대로 채워 주세요.
- 페이지를 새로 만들거나 크게 바꾸면 서치어드바이저·서치 콘솔에서 해당 주소의 수집을 다시 요청합니다.

## 브랜드 기준

- 컬러: 소셜 블루 `#2855E8` · 네이비 `#18233A` · 라이트 `#F7F8FA` · 라이트 블루 `#DCE7FF` · 그레이 `#BFC7D1`
- 서체: 한글 Pretendard, 영문 Montserrat
- 슬로건: 모이면 만들어진다 · TALK. PLAY. BOOK. STUDY. · EST. 2015
- 문장 기준: 넓다·편하다 같은 평가보다 인원·배치·장비·비용을 적고, 확인한 사실은 분명히, 상담이 필요한 조건은 상담이 필요하다고 씁니다.
