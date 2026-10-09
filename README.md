# 소셜팩토리 홈페이지 (SOCIAL FACTORY)

2015년 홍대에서 시작한 모임공간 소셜팩토리의 공식 홈페이지입니다. 현재 공간은 소셜팩토리 건대(서울 광진구 화양동 10-1 한아름건물 4층)입니다.
빌드 과정이 없는 정적 사이트라 GitHub에 올리고 Cloudflare Pages에 연결하면 바로 배포됩니다.

## 폴더 구성

```
index.html        메인 — 룸 고르기(인원·진행 방식), 배치 안내, 요금·정기대관, 코워킹·사무실, 소개, 오시는 길·FAQ
space.html        공간 안내 — 룸 1~5 비교표와 상세(사진 · 배치별 인원 · 장비 · 요금 · 입퇴실), 배치 이름, 코워킹, 독립사무실, 요금 표, 평면도, 3D, 오시는 길
guide.html        이용 안내 — 예약부터 퇴실까지, 이용 원칙, 운영 시간, 요금·취소, 오시는 길, FAQ
contact.html      대관과 이용 문의 — 채널, 문의 폼(접수번호 발급), 제휴·공간 제안
about.html        소셜팩토리 소개 — 운영 기준, 로고, 이력, 창업자
program.html      프로그램·파트너 — 현재 모집, 제휴, 소셜아카데미, 소셜패밀리, 기업·단체, 활용 예시, 홍대 시절 기록
history.html      지난 기록 2015–2021
tour.html         3D 공간 안내 (three.js 포함, 약 0.8MB · 참고 이미지는 images/tour/ 에서 필요할 때 불러옴)
admin.html        문의 관리 화면 (관리자 키 입력 · 검색엔진 제외)
404.html          없는 주소 안내
css/style.css     디자인
js/site-config.js ★ 운영 상태 · 연락처 · 예약 채널 · 요금 · 장비 · 정책 설정 파일 (여기만 고치면 전 페이지에 반영)
js/main.js        메뉴 · 설정값 반영 · 룸 고르기 · 문의 폼 동작
images/           로고(svg) · 브랜드 이미지 · OG 이미지
images/space/     4층 완성 예상 이미지 26장 (큰 파일 + -sm 작은 파일)
images/scenes/    활용 예시 이미지 38장
images/tour/      3D 안내의 참고 이미지 32장과 원본 도면 1장
fonts/            영문 서체 Montserrat (한글 Pretendard는 CDN)
functions/api/inquiry.js  문의 접수 API (Cloudflare Pages Functions)
schema.sql        문의 저장용 D1 테이블
_headers          보안 · 캐시 헤더
robots.txt, sitemap.xml   검색엔진용
```

## 0. 공개 전에 꼭 정할 것

홈페이지는 값이 비어 있어도 깨지지 않도록 만들어져 있지만, 아래 항목은 **공개 전에** `js/site-config.js`에 채우거나 결정해야 고객 안내가 정확해집니다.

| 항목 | 설정 위치 | 비어 있을 때 화면 |
| --- | --- | --- |
| 정식 주소(도메인) | `siteUrl` + 각 html의 canonical/OG, robots.txt, sitemap.xml (아래 5번) | 기본값 `https://socialfactory.co.kr` |
| 운영 상태 | `status.mode` (`preparing`/`open`), `status.text` | 상단 배너에 "오픈 준비 중" |
| 예약 채널 · 상담 채널 | `contact.*`, `booking.primary` | 채널 버튼 숨김, 예약 버튼은 '대관 문의하기'로 대체 |
| 룸별 요금 · 추가 비용 · 취소 기준 | `pricing.*` | "확정 후 안내" 표시 |
| 룸별 장비 · 배치별 인원 | `rooms.r1~r5` | "확인 중" 표시 |
| 코워킹 좌석 수 · 이용권 · 운영시간 | `rooms.coworking`, `pricing.coworking`, `hours.coworking` | 계획 인원 최대 30명만 표시 |
| 사무실 비용 · 포함 시설 · 주소지 정책 | `pricing.office`, `rooms.office`, `policy.address` | "입주 상담 때 안내" 문구 |
| 입퇴실 · 가구 이동 · 음식물 정책 | `policy.*` | 일반 안내 문구 |
| 주차 · 대중교통 · 승강기 | `parking`, `directions`, `elevator` | 해당 줄 숨김 또는 "확인 후 안내" |
| 개인정보 보유 기간 | `inquiry.retention` (실제 삭제 기준과 같게) | 기본 "문의 처리 완료 후 6개월" |
| 문의 폼 공개 여부 | `inquiry.enabled` — D1(3번)도 메일(`contact.email`)도 없으면 `false` 권장 | 폼 대신 준비 중 안내 |

## 1. 배포하기 (브라우저만으로 가능)

### GitHub에 올리기
1. github.com 에 로그인 → 오른쪽 위 **+** → **New repository**
2. Repository name: `socialfactory`, **Public**, 나머지는 그대로 두고 **Create repository**
3. 만들어진 빈 저장소 화면에서 **uploading an existing file** 링크 클릭
4. 이 압축을 푼 폴더 안의 **모든 파일과 폴더**를 드래그해서 올립니다
   (`css`, `js`, `images`, `fonts`, `functions` 폴더째로 올리면 됩니다. `_headers`처럼 밑줄로 시작하는 파일도 꼭 포함)
   GitHub는 한 번에 100개 파일까지만 받으므로, 전체 파일 수가 많다고 나오면 나눠 올립니다.
   ① `images` 폴더를 뺀 나머지 전부 → Commit ② **Add file → Upload files**에서 `images/space` → Commit ③ `images/scenes` → Commit ④ `images/tour` 와 나머지 이미지 → Commit
5. **Commit changes** 클릭

이미 저장소가 있다면 바뀐 파일만 같은 자리에 다시 올리면 됩니다. (이번 개편에서 바뀐 것: html 전부, `guide.html`·`admin.html` 추가, `css/style.css`, `js/*`, `functions/api/inquiry.js`, `schema.sql`, `_headers`, `robots.txt`, `sitemap.xml`, `tour.html`, `images/tour/` 추가)

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

- `status` 운영 상태와 배너 문장 — 날짜는 확정된 것만 적습니다.
- `contact` 채널 주소 — 비워 두면 버튼이 나오지 않습니다. `booking.primary` 에 `"naver"` 처럼 대표 예약 채널을 적으면 룸마다 '예약 채널에서 일정 확인' 버튼이 생깁니다.
- `pricing`, `rooms`, `policy` — 확정된 값만 적습니다. 비어 있으면 화면에 "확정 후 안내"로 표시됩니다.
- `inquiry.retention` — 개인정보 안내문의 보유 기간. 실제 삭제 작업과 같은 기준으로 적습니다.
- `company` — 채우면 푸터에 표기됩니다. 계약서·결제 안내의 사업자명과 같아야 합니다.

### 문구 바꾸기
각 `.html` 파일을 GitHub에서 열어 글자만 고치면 됩니다. 꺾쇠(`< >`) 안의 내용은 건드리지 않고 그 사이의 글자만 바꾸세요.
룸 상세 다섯 개와 비교표는 같은 틀로 만들어져 있습니다. 룸 이름·치수·설명을 바꾸려면 `space.html`에서 해당 글자를 찾아 고치면 됩니다.

### 사진 바꾸기
`images/` 폴더의 파일을 **같은 이름**으로 덮어쓰면 페이지 수정 없이 바뀝니다. 이미지 캐시는 하루라서 늦어도 다음 날 모든 방문자에게 반영됩니다.
현재 룸 사진은 모두 도면을 바탕으로 만든 **완성 예상 이미지**이며 사진마다 표기가 붙어 있습니다. 실제 사진으로 바꾼 뒤에는 각 html에서 `완성 예상 이미지` 라벨(`<span class="img-tag">…</span>`)을 지우거나 "2026.11 촬영"처럼 바꿔 주세요.

| 파일 | 쓰이는 곳 |
| --- | --- |
| `space/01~26-*.webp` | 룸 1~5 · 코워킹 · 독립사무실 (메인 카드 · 공간 페이지 · 배치 안내) |
| `scenes/01~38-*.webp` | 활용 예시 38장면 (프로그램 페이지, 메인) |
| `tour/01~32.jpg`, `tour/33.png` | 3D 안내의 참고 이미지와 원본 도면 |
| `signage.webp`, `welcome.webp` | 브랜드 이미지 |
| `og-image.jpg` | 링크를 공유할 때 보이는 미리보기 (1200×630) |

`-sm.webp` 로 끝나는 파일은 모바일용 작은 버전입니다. 같은 사진을 가로 800px로 줄여 함께 올리면 가장 좋고, 없으면 큰 파일을 같은 이름으로 두 번 올려도 됩니다.

### 3D 안내
`tour.html` 에 3D 실행 코드가, `images/tour/` 에 참고 이미지가 있습니다. 공간 페이지에서 같은 자리에 끼워 보거나 새 창으로 엽니다. 방을 고르면 그 방의 사진·이용 조건과 문의로 바로 가는 링크가 나옵니다. 새 3D 파일을 받으면 같은 방식으로 이미지를 분리해 넣어야 하므로, 교체가 필요하면 제작자에게 요청하는 편이 빠릅니다.

### 평면도
공간 페이지의 평면도는 `space.html` 안에 그림(SVG)으로 들어 있습니다. 도면에 적힌 치수와 높이만 표기했고, 도면에 없는 높이는 '미기재'로 두었습니다.

## 3. 문의 폼 저장하기 (권장)

문의 폼은 Cloudflare D1 데이터베이스에 저장되고 접수번호를 고객에게 보여 줍니다. **저장에 성공했을 때만** "접수되었습니다"라고 안내하며, 실패하면 작성 내용을 남긴 채 다시 보내기와 (설정된 경우) 메일 앱·상담 채널을 안내합니다.

1. Cloudflare → **Workers & Pages** → **D1 SQL Database** → **Create** → 이름 `socialfactory-db`
2. 만든 DB의 **Console** 탭에 `schema.sql` 내용을 붙여 넣고 **Execute**
3. Pages 프로젝트 → **Settings** → **Bindings** → **Add** → **D1 database** → Variable name `DB`, 위 DB 선택
4. **Variables and Secrets** 에 추가
   - `ADMIN_KEY` : 관리자 키 (영문·숫자 20자 이상 권장). `https://주소/admin.html` 에서 이 키를 넣으면 문의 목록을 보고 처리 상태를 바꿀 수 있습니다. 키는 주소창에 남지 않습니다.
   - `IP_SALT` : 아무 문자열 (스팸 방지용 IP 해시에 섞임, 권장)
   - `NOTIFY_WEBHOOK` : (선택) Slack · Discord · Make 등의 웹훅 주소. 새 문의가 들어올 때마다 전송되고, 전송 실패는 관리 화면의 '알림' 칸에 표시됩니다.
5. **Deployments** 에서 **Retry deployment** 한 번 (바인딩 반영)
6. 검수: 실제로 문의 1건을 보내 접수번호가 나오는지, 관리 화면에 보이는지, 동의 없이 보내면 거부되는지 확인합니다.

D1 을 연결하지 않으면 폼은 "접수되지 않았습니다"를 보여 주고 `contact.email` 이 있을 때만 메일 앱으로 보내는 길을 안내합니다. 둘 다 준비되지 않았다면 `inquiry.enabled: false` 로 폼을 닫아 두세요.

개인정보: 저장하는 항목은 폼 아래 '수집 항목과 보유 기간 보기'에 적힌 것과 같습니다 (이름, 연락처, 이메일, 문의 내용, 희망 일시·인원, 접수 시각, 동의 여부와 안내문 버전, IP 해시 일부). 브라우저 정보(User-Agent)와 원본 IP는 저장하지 않습니다. 보유 기간이 지난 문의는 관리 화면에서 CSV로 내려받아 보관할 것을 정리한 뒤 D1 Console 에서 `DELETE FROM inquiries WHERE created_at < '2026-04-01';` 처럼 삭제합니다.

## 4. 운영 상태 바꾸기

오픈하면 `js/site-config.js` 의 `status.mode` 를 `"open"` 으로, `status.text` 를 `"소셜팩토리 건대 이용 안내"` 처럼 바꿉니다. 배너 색과 문구가 바뀝니다.

## 5. 실제 주소로 바꿀 것 (도메인 연결 직후 한 번)

기본 주소는 `https://socialfactory.co.kr` 로 적혀 있습니다. 다른 주소를 쓰게 되면 GitHub 저장소 검색창에 `socialfactory.co.kr` 를 넣어 아래 파일에서 모두 바꿉니다.
- `js/site-config.js` 의 `siteUrl`
- `robots.txt`, `sitemap.xml`
- 각 html `<head>` 의 `canonical`, `og:url`, `og:image`
- `index.html` 의 구조화 데이터(`application/ld+json`)

도메인 연결: Pages 프로젝트 → **Custom domains** → **Set up a custom domain** → `socialfactory.co.kr` 입력 후 안내대로 DNS 레코드를 추가합니다. 카카오톡·네이버 플레이스 등 외부 채널의 주소와 상호·전화·운영시간도 홈페이지와 같게 맞춥니다.

## 브랜드 기준

- 컬러: 소셜 블루 `#2855E8` · 네이비 `#18233A` · 라이트 `#F7F8FA` · 라이트 블루 `#DCE7FF` · 그레이 `#BFC7D1`
- 서체: 한글 Pretendard, 영문 Montserrat
- 슬로건: 모이면 만들어진다 · TALK. PLAY. BOOK. STUDY. · EST. 2015
- 문장 기준: 넓다·편하다 같은 평가보다 인원·배치·장비·비용을 적고, 확인한 사실은 분명히, 상담이 필요한 조건은 상담이 필요하다고 씁니다.
