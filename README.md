# 소셜팩토리 홈페이지 (SOCIAL FACTORY)

2015년 홍대에서 시작한 모임·강연·스터디 공간 소셜팩토리의 공식 홈페이지입니다.
빌드 과정이 없는 정적 사이트라 GitHub에 올리고 Cloudflare Pages에 연결하면 바로 배포됩니다.

## 폴더 구성

```
index.html        메인
about.html        브랜드 이야기 (경영이념 · 로고 · 스프레드 스페이스 · 대표 소개)
space.html        공간 안내 (평면도 · 3D 둘러보기 · 룸 1~5 · 코워킹 · 독립사무실 · 이용 안내 · 오시는 길)
tour.html         3D 공간 둘러보기 (단일 파일, 약 5MB · 3D 모델과 참고 이미지가 모두 들어 있음)
program.html      프로그램 · 파트너 (소셜아카데미 · 소셜패밀리 · 제휴 · 기업 이용 · 레퍼런스)
history.html      아카이브 2015–2021 (연혁 · 지점 기록 · 선정 · 협력처)
contact.html      예약 · 문의 (채널 · 문의 폼 · 공간 제안 · FAQ)
404.html          없는 주소 안내
css/style.css     디자인 (컬러 · 서체 · 레이아웃)
js/site-config.js ★ 연락처 · 예약 채널 · 운영 정보 설정 파일
js/main.js        메뉴 · 설정값 반영 · 문의 폼 동작
images/           로고(svg) · 브랜드 무드 이미지 · OG 이미지
images/space/     4층 완성 예상 이미지 26장 (룸·코워킹·독립사무실, 큰 파일 + -sm 작은 파일)
images/scenes/    활용 예시 이미지 38장 (강연·클래스·모임 장면)
fonts/            영문 서체 Montserrat (한글 Pretendard는 CDN에서 불러옵니다)
functions/api/inquiry.js  문의 폼 저장 API (Cloudflare Pages Functions, 선택)
schema.sql        문의 저장용 D1 테이블 (선택)
_headers          보안 · 캐시 헤더
robots.txt, sitemap.xml   검색엔진용
```

## 1. 배포하기 (브라우저만으로 가능)

### GitHub에 올리기
1. github.com 에 로그인 → 오른쪽 위 **+** → **New repository**
2. Repository name: `socialfactory` (원하는 이름), **Public**, 나머지는 그대로 두고 **Create repository**
3. 만들어진 빈 저장소 화면에서 **uploading an existing file** 링크 클릭
4. 이 압축을 푼 폴더 안의 **모든 파일과 폴더**를 드래그해서 올립니다
   (`css`, `js`, `images`, `fonts`, `functions` 폴더째로 올리면 됩니다. `_headers`처럼 밑줄로 시작하는 파일도 꼭 포함)
   GitHub는 한 번에 100개 파일까지만 받으므로, 전체 파일 수가 많다고 나오면 세 번에 나눠 올립니다.
   ① `images` 폴더를 뺀 나머지 전부 → Commit ② **Add file → Upload files**에서 `images` 폴더만 → Commit
   (그래도 많다고 하면 `images/space`와 `images/scenes`를 따로 한 번씩 더 올립니다)
5. 아래 **Commit changes** 클릭

### Cloudflare Pages에 연결하기
1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. GitHub 계정을 연결하고 방금 만든 `socialfactory` 저장소 선택
3. 설정 화면
   - Project name: `socialfactory` → 주소가 `https://socialfactory.pages.dev` 가 됩니다 (이미 쓰는 이름이면 `socialfactory-kondae` 처럼 바꿉니다)
   - Framework preset: **None**
   - Build command: 비워 둠
   - Build output directory: `/` (또는 비워 둠)
4. **Save and Deploy** → 1~2분 뒤 주소가 열립니다

이후에는 GitHub에서 파일을 고치고 Commit 할 때마다 자동으로 다시 배포됩니다.

## 2. 내용 바꾸기

### 연락처 · 예약 채널 · 운영 정보 → `js/site-config.js`
GitHub에서 `js/site-config.js` 를 열고 연필 아이콘(Edit)을 눌러 값을 채운 뒤 Commit 하면 됩니다.

| 항목 | 설명 |
| --- | --- |
| `contact.kakao` 등 | 카카오톡 채널 · 네이버 예약 · 스페이스클라우드 · 인스타그램 주소, 전화, 이메일. 비워 두면 그 버튼은 화면에 나오지 않습니다 |
| `directions`, `parking` | 오시는 길 · 주차 안내. 비워 두면 해당 줄이 숨겨집니다 |
| `pricing` | `show: true` 로 바꾸고 문구를 채우면 공간 페이지에 요금 안내가 나타납니다 |
| `company` | 운영 법인명 · 대표 · 사업자등록번호. 채우면 푸터에 표기됩니다 |
| `siteUrl` | 배포된 실제 주소 (도메인을 연결하면 그 주소로) |
| `openLabel` | 상단 배너의 "2026 OPEN" 표기 |

### 문구 바꾸기
각 `.html` 파일을 GitHub에서 열어 글자만 고치면 됩니다. 꺾쇠(`< >`) 안의 내용은 건드리지 않고 그 사이의 글자만 바꾸세요.
공간 인원·용도는 `index.html`(메인 공간 카드), `space.html`(공간 구성), `contact.html`(FAQ) 세 곳에 있습니다.

### 3D 둘러보기
`tour.html` 한 파일에 3D 모델과 참고 이미지가 모두 들어 있습니다(약 5MB). 메뉴의 '3D 둘러보기', 메인 배너, 공간 페이지의 '3D로 미리 둘러보기'에서 열리고, 공간 페이지에서는 같은 자리에 끼워서 볼 수도 있습니다. 새 버전의 3D 파일을 받으면 `tour.html`을 같은 이름으로 덮어쓰면 됩니다. 상단의 '← 공간 안내' 링크와 색상만 홈페이지에 맞춰 손봤습니다.

### 평면도
공간 페이지의 평면도는 `space.html` 안에 그림(SVG)으로 들어 있습니다. 룸 이름·인원·치수를 바꾸려면 `space.html`에서 해당 글자를 찾아 고치면 되고, 구획 자체가 바뀌면 다시 만들어 드리는 편이 빠릅니다. 평면도 아래의 치수 표도 같은 파일에 있습니다.

### 사진 바꾸기
`images/` 폴더의 파일을 **같은 이름**으로 덮어쓰면 페이지 수정 없이 바뀝니다.
파일은 가로 1536px 안팎의 webp 또는 jpg를 권장합니다. (jpg로 바꿀 때는 html 안의 `.webp` 를 `.jpg` 로 함께 고쳐 주세요)

| 파일 | 쓰이는 곳 |
| --- | --- |
| `space/01~26-*.webp` | 룸 1~5 · 코워킹 · 독립사무실의 완성 예상 이미지 (메인 공간 카드 · 갤러리 · 공간 페이지). 실제 사진이 나오면 같은 이름으로 덮어쓰기 |
| `scenes/01~38-*.webp` | 활용 예시 38장면 (프로그램 페이지 갤러리, 메인 '이렇게 쓰입니다') |
| `signage.webp` | 문의 페이지 공간 제안 섹션 (브랜드 로고 월) |
| `welcome.webp` | 브랜드 페이지 포스터 |
| `og-image.jpg` | 카카오톡 · 문자 · SNS에 링크를 공유할 때 보이는 미리보기 이미지 (1200×630) |

`-sm.webp` 로 끝나는 파일은 모바일용 작은 버전입니다. 같은 사진을 가로 800px로 줄여 함께 올리면 가장 좋고, 없으면 큰 파일 하나를 같은 이름으로 두 번 올려도 됩니다. 메인과 공간 페이지에서 어떤 룸에 어떤 이미지를 썼는지는 `space.html`의 ROOM 01~05 블록에서 파일명으로 확인할 수 있습니다.

### 실제 주소로 바꿀 것 (배포 직후 한 번)
- `js/site-config.js` 의 `siteUrl`
- `robots.txt`, `sitemap.xml`, 각 html `<head>` 안의 `https://socialfactory.pages.dev` → 실제 주소 (GitHub 검색으로 한 번에 찾을 수 있습니다)

## 3. 문의 폼 저장하기 (선택)

기본 상태에서는 문의 폼을 보내면 방문자의 메일 앱이 열려 `contact.email` 주소로 메일을 보내도록 되어 있습니다.
(이메일을 비워 두면 문의 내용을 복사해 카카오톡 채널에 붙여 넣도록 안내합니다.)
문의를 Cloudflare에 저장하고 싶을 때만 아래를 진행합니다.

1. Cloudflare → **Workers & Pages** → **D1 SQL Database** → **Create** → 이름 `socialfactory-db`
2. 만든 DB의 **Console** 탭에 `schema.sql` 내용을 붙여 넣고 **Execute**
3. Pages 프로젝트 → **Settings** → **Bindings** → **Add** → **D1 database** → Variable name `DB`, 위 DB 선택
4. (선택) **Variables and Secrets** 에 `ADMIN_KEY` 를 추가하면 `https://주소/api/inquiry?key=값` 으로 최근 문의 100건을 JSON으로 볼 수 있습니다
5. (선택) `NOTIFY_WEBHOOK` 에 Slack · Discord · Make 등의 웹훅 주소를 넣으면 새 문의가 들어올 때마다 전송됩니다
6. **Deployments** 에서 **Retry deployment** 한 번 (바인딩 반영)

## 4. 도메인 연결 (선택)

Pages 프로젝트 → **Custom domains** → **Set up a custom domain** → 보유한 도메인(예: `socialfactory.co.kr`) 입력 후 안내대로 DNS 레코드를 추가합니다. 연결 후 `siteUrl` 과 sitemap 주소를 바꿔 주세요.

## 브랜드 기준

- 컬러: 소셜 블루 `#2855E8` · 네이비 `#18233A` · 라이트 `#F7F8FA` · 라이트 블루 `#DCE7FF` · 그레이 `#BFC7D1`
- 서체: 한글 Pretendard Bold / SemiBold, 영문 Montserrat Bold / SemiBold
- 슬로건: 모이면 만들어진다 · TALK. PLAY. BOOK. STUDY. · EST. 2015
- 경영이념: 사람들의 시간과 즐거움을 기억하는 공간
