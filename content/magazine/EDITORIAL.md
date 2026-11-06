# 소셜팩토리 매거진 편집 기준

socialfactory.co.kr/magazine 에 매일 낮 12시 한 편씩 올리는 글의 기준입니다.
사람이 쓰든 Claude 가 쓰든 이 문서를 먼저 읽고 씁니다. 발행 계획(주제 목록)은 같은 폴더의 `PLAN.md` 에 있습니다.

---

## 1. 이 매거진이 하는 일

- 건대입구 · 광진구에서 세미나실, 강의실, 회의실, 스터디룸, 코워킹, 1인 사무실을 찾는 사람이 검색으로 들어와 **실제로 도움을 받고**, 소셜팩토리 건대를 떠올리게 하는 것.
- 2015년부터 이어 온 소셜팩토리의 이야기와 공간의 매력을 사실대로 전하는 것.
- 검색엔진(네이버 · 구글 · 다음)은 양보다 쓸모를 봅니다. 같은 말을 돌려 쓰는 글, 검색어만 채운 글은 쓰지 않습니다. 한 편마다 읽는 사람이 **하나는 새로 알게 되거나, 하나는 바로 해 볼 수 있게** 씁니다.

## 2. 매일 발행 순서 (Claude 예약 작업 기준)

1. 한국 시간 오늘 날짜를 확인합니다: `TZ=Asia/Seoul date +%F`
2. 오늘 날짜로 `time: 12:00` 인 글이 `content/magazine/posts/` 에 이미 있으면 **아무것도 하지 않고 끝냅니다** (하루 한 편).
3. `PLAN.md` 에서 체크되지 않은 첫 주제를 고릅니다. 계절이나 날짜와 맞지 않으면(예: 12월에 새 학기 이야기) 다음 주제로 넘어가고, 넘긴 주제는 그대로 둡니다.
   목록이 10개 아래로 줄면 같은 규칙으로 주제를 10개 이상 보탭니다.
4. 같은 검색어를 노리는 기존 글이 있는지 확인합니다: `grep -l "핵심 검색어" content/magazine/posts/*.md`
   있으면 각도를 바꾸거나(예: '고르는 법' → '비용 계산') 다른 주제를 고릅니다. 60일 안에 같은 주제를 다시 쓰지 않습니다.
5. 사실을 확인합니다 (3장). 숫자와 조건은 반드시 저장소 파일에서 읽습니다.
6. `content/magazine/posts/YYYY-MM-DD-<slug>.md` 를 씁니다 (4장 형식).
7. 실행합니다:
   ```
   python3 scripts/magazine_og.py      # 공유 미리보기 이미지 (images/og/<slug>.jpg)
   node scripts/magazine.mjs           # 글 · 목록 · 메인 최신 글 · 사이트맵 · RSS 갱신
   node --test tests/magazine.test.mjs # 검사
   ```
   오류가 나면 고치고 다시 실행합니다. '경고'도 가능하면 고칩니다.
8. 6장의 마지막 점검표로 글을 한 번 더 읽습니다.
9. `PLAN.md` 의 그 주제를 `- [x] YYYY-MM-DD · /magazine/<slug> · 제목` 으로 바꿉니다.
10. 커밋하고 main 에 바로 올립니다 (Cloudflare Pages 가 1~2분 안에 배포).
    ```
    git add content/magazine magazine magazine.html index.html sitemap.xml rss.xml images/og story.html founder.html
    git commit -m "매거진: <글 제목>"
    git fetch origin main && git rebase origin/main
    node scripts/magazine.mjs && git add -A magazine magazine.html index.html sitemap.xml rss.xml && git diff --cached --quiet || git commit -m "매거진 생성 파일 갱신"
    git push origin HEAD:main
    ```
    rebase 충돌이 생성 파일(magazine/*.html, index.html, sitemap.xml, rss.xml)에서 나면, 원격 쪽을 받아들인 뒤 `node scripts/magazine.mjs` 로 다시 만들면 됩니다. 다른 사람이 고친 파일은 되돌리지 않습니다.
11. 위에 적은 파일 말고는 고치지 않습니다. 홈페이지 다른 부분의 오류를 발견하면 고치지 말고 결과 보고에 적습니다.

## 3. 사실 기준 — 쓰기 전에 확인할 곳

| 무엇 | 어디서 확인 |
| --- | --- |
| 룸 요금 · 최대 인원 · 최소 예약 시간 · 공휴일 | `js/booking-rates.js` |
| 장비 · 옵션 · 코워킹 이용권 · 사무실 요금과 할인 · 취소 기준 · 이용 정책 · 주소 · 주차 | `js/site-config.js` |
| 룸 크기 · 천장 높이 · 위치 · 가능한 배치 · 코워킹 키오스크 | `space.html` |
| 예약 절차(신청 → 시간 확보 → 페이앱 결제 → 확정 → 출입 안내) · 이용 원칙 · FAQ | `guide.html`, `booking.html` |
| 2015~2021 지난 기록 · 수치 | `history.html`, `about.html`, `story.html` |
| 대표 이력 | `founder.html` |
| 패밀리 브랜드 소개 | `js/site-config.js` 의 `family` |

- **요금과 인원은 숫자로 직접 쓰지 말고 자리표시로 씁니다.** 설정이 바뀌면 다음 날 자동으로 고쳐집니다.
  - `{{rate.r3.max}}` 3번룸 최대 인원 · `{{rate.r4.wdEarly}}` 4번룸 평일 오전 · 심야 요금 (`wdStd` 평일 오후 · 저녁, `hdEarly` 주말 · 공휴일 오전 · 심야, `hdStd` 주말 · 공휴일 오후 · 저녁)
  - `{{stat.minCap}}` 가장 작은 방 인원 · `{{stat.maxCap}}` 가장 큰 방 인원 · `{{stat.from}}` 가장 낮은 시간당 요금 · `{{booking.minHours}}` 최소 예약 시간
  - `{{cfg.pricing.coworkingPasses.0.price}}` 처럼 `site-config.js` 의 값은 `cfg.` 로 시작합니다. `{{cfg.pricing.cancel}}` 은 취소 기준 한 줄입니다.
  - 계산: `{{= rate.r3.wdEarly * 3 }}`, `{{= ceil(cfg.pricing.coworkingPasses.2.price / cfg.pricing.coworkingPasses.1.price) }}` (반올림 · 쉼표 자동)
- 지난 수치(2015~2021)는 **연도와 '당시 자체 집계'를 함께** 씁니다. 340곳은 '2015~2026 자체 집계', 1,500곳은 '내부 집계'입니다.
- 위치는 '지하철 2 · 7호선 건대입구역 도보권'까지만 씁니다. 출구 번호와 도보 시간은 아직 확인되지 않았습니다(`site-config.js` 의 `directions` 가 바뀌면 그 값을 씁니다). 승강기 정보도 확인 전입니다.
- 코워킹의 15일권 · 3개월권 · 친구 동반 할인은 '현장 키오스크에서 확인'으로만 씁니다.
- 바깥 정보(시험 일정, 제도, 통계 등)를 쓸 때는 공식 출처를 웹에서 확인하고, 확인하지 못하면 쓰지 않습니다. 글 끝에 출처 링크를 둡니다.

### 쓰지 않는 것

- 지어낸 이용 후기, 고객의 말, 인용, 사례, 숫자, 설문 결과. "많은 분들이 ~라고 하십니다" 같은 문장도 근거가 없으면 쓰지 않습니다.
- 확인되지 않은 행사 · 프로그램 · 할인 · 제휴 · 수상 · 방송 이력. 앞으로의 계획을 약속처럼 쓰는 것.
- '업계 1위', '최초', '최고', '유일' 같은 최상급 표현 (표시광고법 위험).
- 매출 · 정산 · 투자 · 재개발 이야기, '구 학원 건물' 같은 건물 이력. 대표 최시준 외 사람 이름.
- 대표의 생각이나 말을 지어내는 것. 대표의 말은 `founder.html` '남아 있는 문장들'에 있는 것만 인용합니다.
- 술이 들어가는 모임 제안. 건물이 교육환경보호구역 안이라 주류 반입이 안 됩니다. 술 파티 · 생일 파티는 패밀리 브랜드(쏘플파티룸 · 플레이션)로 안내합니다.
- 미성년자를 대상으로 하는 모임 홍보, 정치 · 종교 주제, 다른 공간 업체를 깎아내리는 비교.

## 4. 글 파일 형식

```
---
title: 사람이 읽는 제목 (40자 안팎, 핵심 검색어를 자연스럽게 앞쪽에)
seoTitle: 검색 결과에 보일 제목 (선택, 없으면 title)
slug: english-kebab-case
date: 2026-11-08
time: "12:00"
category: space
description: 검색 결과 아래에 보일 설명 60~160자. 무엇을 알 수 있는지 구체적으로.
lead: 제목 아래 첫 문단 한두 문장 (선택)
cover: images/space/room-3-02-meeting.webp
coverAlt: 이미지 설명 (5장 목록의 설명을 그대로 써도 됩니다)
coverNote: 공간 활용 예시 이미지입니다.   ← images/scenes/ 를 쓸 때만
tags: ["검색어 1", "검색어 2", "검색어 3"]
related: ["다른-글-slug"]
cta: rooms
---
본문 (마크다운)
```

- `category`: `space` 공간 가이드 · `meeting` 모임 준비 · `work` 일과 공부 · `host` 호스트 · 클래스 · `story` 소셜팩토리 이야기 · `local` 건대 · 동네
- `cta`(글 끝 안내 상자): `rooms` 대관 · `work` 코워킹 · 사무실 · `host` 호스트 모집 · `story` 브랜드
- 본문 문법: `## 소제목`, `### 작은 소제목`, 문단, `- 목록`, `1. 번호 목록`, `**굵게**`, `[글자](/space#rooms)`, 표(`| a | b |` + `| --- | --- |`), 안내 상자(`> **제목**` 다음 줄부터 `> 내용`), 인용(`> 내용`), 이미지(`![설명](/images/... "캡션")`). html 은 쓰지 않습니다.
- 쓸 수 있는 내부 주소: `/` `/space` `/pricing` `/booking` `/guide` `/contact` `/about` `/story` `/founder` `/history` `/family` `/shop` `/program` `/parking` `/tour` `/magazine` `/magazine/<다른 글>`. 자주 쓰는 위치: `/space#rooms` `/space#room-1`~`#room-5` `/space#layouts` `/space#floorplan` `/space#coworking` `/space#office` `/pricing#estimate` `/pricing#office` `/pricing#refund` `/guide#rules` `/guide#location` `/guide#faq` `/program#host` `/contact?purpose=partner#inquiry` `/contact?purpose=proposal#inquiry`
- 검사(`node scripts/magazine.mjs --check`)가 막는 것: 머리말 빠짐, 설명 길이, 본문 1,500자 미만, 소제목 3개 미만, 내부 링크 3개 미만, 없는 주소 · 이미지, 금지 표현.

## 5. 대표 이미지 고르기

실제 사진(images/space/room-*, 35~39)을 먼저 씁니다. `images/scenes/` 는 활용 예시 이미지라 `coverNote: 공간 활용 예시 이미지입니다.` 를 꼭 붙입니다. 바로 앞 3편과 같은 이미지는 피합니다.

- 1번룸 `images/space/room-1-01-lecture-rear.webp` · `room-1-02-u-shape.webp` · `room-1-03-lecture-front.webp` · `room-1-20261030-0{1,2,3}.webp`(세로)
- 2번룸 `room-2-01-lecture-angle.webp` · `room-2-02-lecture-front.webp` · `room-2-03-u-shape.webp`
- 3번룸 `room-3-01-lecture.webp` · `room-3-02-meeting.webp` · `room-3-03-meeting-reverse.webp`
- 4번룸 `room-4-01-lecture-angle.webp` · `room-4-02-lecture-front.webp` · `room-4-03-theater.webp`
- 5번룸 `room-5-01-theater.webp` · `room-5-02-u-shape.webp` · `room-5-03-lecture.webp`
- 코워킹 `35-cowork-sage.webp` · `36-cowork-green-brick.webp` · `37-cowork-night-brick.webp` / 사무실 `23-office-single.webp` · `24-office-double.webp` · `25-office-double-navy.webp` · `26-office-compact.webp` · `38-office-corridor.webp` · `39-corridor-warm.webp`
- 조감도 `images/aerial/01-front.webp` · `02-southeast.webp` · `03-overhead.webp` · `04-panorama.webp` · `05-topview.webp` (가구는 예시라고 coverNote 에 적습니다)
- 활용 예시 `images/scenes/01-lecture` ~ `38-meditation` (강연, 세미나, 기업 워크숍, ㄷ자 토론, 프로젝트 회의, 독서 스터디, 네트워킹, 커뮤니티 토크, 스타트업 피칭, AI 클래스, 언어교류, 플라워, 북클럽, 에세이, 보드게임, 사진 리뷰, 숏폼, 여행 계획, 모의 면접, 스피치, 수채화, 가죽공예, 캘리그래피, 뜨개질, 독립영화, 동문 모임, 봉사 기획, 청소년 진로, 팀빌딩, 좌식 요가, 영화, 스포츠 관람, 콘솔게임, 여행영상, 사진 동호회, 공연영상, 영상 시사, 명상)
- 기존 alt 문구는 `space.html` · `program.html` 의 img alt 를 그대로 가져다 쓰면 됩니다.

## 6. 문체

- 친절하되 과장하지 않는 합니다체. 사람이 직접 쓴 것처럼 자연스럽게. 홈페이지의 다른 글(about, guide)과 같은 목소리.
- 첫 문단은 읽는 사람의 상황이나 문제로 시작합니다. 인사, 자기소개, "오늘은 ~에 대해 알아보겠습니다" 로 시작하지 않습니다.
- 공간은 '넓다 · 편하다 · 아늑하다'보다 **인원 · 배치 · 장비 · 비용 · 시간** 같은 조건으로 설명합니다.
- 한 문장에 한 가지만. 문단은 2~4문장. 소제목은 3~6개, 소제목만 읽어도 내용이 보이게.
- 표나 번호 목록을 한 번 이상 써서 훑어보기 쉽게 합니다. 계산 예시가 있으면 좋습니다.
- 본문 1,800~3,000자. 소셜팩토리 홍보는 본문 안에서 자연스럽게 한두 번, 마지막 문단에서 행동(예약 · 문의 · 다른 글)으로 잇습니다. 끝 안내 상자는 자동으로 붙습니다.
- 쓰지 않는 표현: '알아보겠습니다/알아볼까요', '결론적으로', '마무리하며', '다양한'(반복), '특별한 경험', '잊지 못할', '최적의', '완벽한/완벽 가이드', '혁신적', '여러분', 이모지, 느낌표 연발, '~것입니다.'로 끝나는 문장 반복, 번역투('~에 있어서', '~를 통해', '~하는 것이 중요합니다' 반복).
- 띄어쓰기는 홈페이지 표기를 따릅니다: '소셜팩토리 건대', '1번룸', '24시간', '건대입구역', '오후 · 저녁'(가운뎃점 앞뒤 띄움).

### 마지막 점검표

- [ ] 제목만 보고 무엇을 얻는 글인지 알 수 있나
- [ ] 숫자는 모두 자리표시이거나, 저장소 · 공식 출처에서 확인한 값인가
- [ ] 지어낸 후기 · 인용 · 사례 · 통계가 없나
- [ ] 위치를 '건대입구역 도보권'보다 자세히 쓰지 않았나 (출구 · 도보 시간 미확정)
- [ ] 주류 · 최상급 표현 · 다른 사람 이름 · 매출 이야기가 없나
- [ ] 소리 내 읽었을 때 어색한 문장, 같은 어미가 세 번 넘게 이어지는 곳이 없나
- [ ] 내부 링크 3개 이상, 그중 하나는 예약 · 문의 · 요금 중 하나인가

## 7. 주제 고르기

- 순서: `space → meeting → work → host → story → local` 을 돌아가며 섞습니다 (`PLAN.md` 순서가 이미 섞여 있습니다).
- 검색어는 사람들이 실제로 치는 말로: '건대 세미나실', '건대입구 스터디룸', '광진구 회의실 대관', '강의실 대관 체크리스트', '워크숍 진행표' 처럼.
- 시기에 맞춥니다: 연말(송년 · 회고 · 워크숍), 1~2월(새해 계획 · 스터디 시작 · 신입 교육), 3월 · 9월(새 학기 · 동아리), 방학(스터디 · 클래스), 공휴일이 낀 달(요금 · 예약 팁).
- `local`(건대 · 동네) 글은 웹에서 공식 자료로 확인한 내용만 씁니다. 가게 이름 · 영업시간처럼 바뀌기 쉬운 정보는 쓰지 않습니다.

## 8. 실패했을 때

- 검사가 계속 실패하면 글을 줄이거나 다른 주제로 바꿉니다. 검사를 끄거나 `scripts/magazine.mjs` 의 기준을 느슨하게 고치지 않습니다.
- push 가 거절되면 `git fetch` → `rebase` → 다시 만들기 → push 를 두 번까지 다시 해 봅니다. 그래도 안 되면 무엇이 막혔는지 결과에 적고 끝냅니다.
- 그날 글을 못 올렸다고 다음 날 두 편을 올리지 않습니다.
