/* ==========================================================================
   검색으로 들어오는 사람을 받는 안내 페이지 생성기
   --------------------------------------------------------------------------
   원본                               → 만들어지는 파일
   content/landing/rooms.mjs          → rooms/1.html ~ rooms/5.html   (/rooms/1 ~ /rooms/5)
   content/landing/uses.mjs           → for/<slug>.html               (/for/seminar 등)
   content/landing/work.mjs           → coworking.html, office.html   (/coworking, /office)
   그리고 llms.txt (AI 검색 도구가 읽는 사이트 요약)

   따로 실행하지 않습니다. `node scripts/magazine.mjs` 가 이 파일을 불러 함께 만듭니다.
   머리글 · 바닥글은 매거진과 같이 about.html 에서 가져오고, 요금 · 인원은 js/booking-rates.js · js/site-config.js 값으로 채웁니다.
   ========================================================================== */
import { ROOMS, LAYOUTS } from '../content/landing/rooms.mjs';
import { USES } from '../content/landing/uses.mjs';
import { COWORKING, OFFICE } from '../content/landing/work.mjs';

const SITE = 'https://socialfactory.co.kr';
const SRC = 'content/landing';
/* 내용을 크게 고치면 이 날짜를 바꿉니다 (사이트맵 · RSS 의 수정일) */
export const LANDING_LASTMOD = '2026-11-27';

/* 매거진 본문에서 링크할 수 있는 주소 (scripts/magazine.mjs 의 검사 목록에 더해집니다) */
export const LANDING_ROUTES = [
  ...ROOMS.map((r) => `/rooms/${r.n}`), ...USES.map((u) => `/for/${u.slug}`), '/coworking', '/office'
];

/* 매거진 글 끝 '이어지는 안내' — 글의 제목 · 검색어에 맞는 안내 페이지를 최대 3개 고릅니다.
   글 머리말에 hubs: ["/rooms/3", "/for/study"] 를 적으면 그 값을 그대로 씁니다. */
const HUBS = [
  ['/rooms/1', '1번룸 · 강의실', /1번룸/g],
  ['/rooms/2', '2번룸 · 세미나실', /2번룸/g],
  ['/rooms/3', '3번룸 · 회의실 · 스터디룸', /3번룸/g],
  ['/rooms/4', '4번룸 · 워크숍 장소', /4번룸/g],
  ['/rooms/5', '5번룸 · 모임공간', /5번룸/g],
  ['/for/seminar', '세미나 · 강연 장소 안내', /세미나|강연|행사/g],
  ['/for/class', '클래스 · 강의 장소 안내', /클래스|강의실|수강|교육장|강사/g],
  ['/for/study', '스터디룸 안내', /스터디룸|스터디 모임|스터디 장소|스터디 규칙/g],
  ['/for/meeting', '회의실 안내', /회의실|회의|면접|회고/g],
  ['/for/workshop', '워크숍 장소 안내', /워크숍|조별|팀빌딩/g],
  ['/for/gathering', '모임공간 안내', /독서모임|소모임|모임 장소|모임공간|송년회|연말 모임|모임장|아이스브레이킹/g],
  ['/coworking', '24시간 코워킹 · 스터디카페', /코워킹|스터디카페|공부/g],
  ['/office', '1인 사무실 · 독립사무실', /사무실|창업/g]
];
const HUB_LABEL = Object.fromEntries(HUBS.map(([href, label]) => [href, label]));
export function hubsFor(post) {
  if (Array.isArray(post.hubs) && post.hubs.length) return post.hubs.filter((h) => HUB_LABEL[h]).slice(0, 3).map((h) => ({ href: h, label: HUB_LABEL[h] }));
  const text = `${post.title} ${post.seoTitle || ''} ${(post.tags || []).join(' ')}`;
  // 특정 방을 다룬 글이면 그 방의 안내 페이지를 맨 앞에 둡니다
  return HUBS.map(([href, label, re], i) => ({ href, label, score: (text.match(re) || []).length * (href.startsWith('/rooms/') ? 10 : 1), i }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 3).map(({ href, label }) => ({ href, label }));
}

/* 글 끝 '소셜팩토리 건대 한눈에 보기' — 어느 글에서나 같은 사실이 같은 숫자로 나오게 합니다 */
export function factsBox(data, esc) {
  const c = data.cfg, p = c.pricing.coworkingPasses;
  const won = (n) => Number(n).toLocaleString('en-US');
  const rows = [
    ['위치', `${c.address} · ${c.directions}`],
    ['공간', `룸 ${data.stat.rooms}개(최대 ${data.stat.minCap}~${data.stat.maxCap}명) · 코워킹 50석 · 독립사무실 4실`],
    ['룸 요금', `시간당 ${won(data.stat.from)}~${won(data.stat.top)}원 · 부가세 포함 · 인원 추가 요금 없음`],
    ['예약', `24시간 예약제 · 최소 ${data.booking.minHours}시간 · ${data.booking.stepMinutes}분 단위`],
    ['코워킹', `24시간 · ${p[0].name} ${won(p[0].price)}원 · ${p[1].name} ${won(p[1].price)}원 · ${p[2].name} ${won(p[2].price)}원`]
  ];
  return `<aside class="mz-facts" aria-label="소셜팩토리 건대 기본 정보"><strong>소셜팩토리 건대 한눈에 보기</strong><dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></aside>`;
}

/* --------------------------------------------------------------------------
   공통 조각
   -------------------------------------------------------------------------- */
export function landingPages(data, posts, h) {
  const { esc, imageSize, smallOf, card, resolveTokens, KAKAO, KAKAO_SVG } = h;
  const abs = (rel) => `${SITE}/${String(rel).replace(/^\//, '')}`;
  const kk = (label, cls = 'btn btn-lg btn-kakao') => `<a class="${cls}" data-channel="kakao" href="${KAKAO}" target="_blank" rel="noopener">${KAKAO_SVG}${label}</a>`;
  const img = (rel, alt, { sizes = '(max-width: 760px) 100vw, 560px', eager = false } = {}) => {
    const dim = imageSize(rel) || { w: 1600, h: 900 };
    const sm = smallOf(rel); const smDim = sm ? imageSize(sm) : null;
    const srcset = sm && smDim ? ` srcset="/${sm} ${smDim.w}w, /${rel} ${dim.w}w" sizes="${sizes}"` : '';
    return `<img src="/${rel}"${srcset} alt="${esc(alt)}" width="${dim.w}" height="${dim.h}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
  };
  const thumb = (rel, alt) => {
    const sm = smallOf(rel) || rel; const dim = imageSize(sm) || { w: 800, h: 600 };
    return `<img src="/${sm}" alt="${esc(alt)}" width="${dim.w}" height="${dim.h}" loading="lazy" decoding="async">`;
  };
  const crumbs = (trail) => `<div class="crumbs"><a href="/">Home</a>${trail.map(([label, href]) => ` / ${href ? `<a href="${href}">${esc(label)}</a>` : esc(label)}`).join('')}</div>`;
  const facts = (rows) => `<dl class="lp-facts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
  const gallery = (photos, note = '사진을 누르면 크게 볼 수 있습니다. 가구 배치는 모임에 맞춰 바꿔 쓸 수 있습니다.') => {
    const [first, ...rest] = photos; const side = rest.slice(0, 3);
    return `<div class="lp-gallery"><a class="lg-main" href="/${first[0]}" data-lightbox>${img(first[0], first[1], { sizes: '(max-width: 760px) 100vw, 700px', eager: true })}</a><div class="lg-side${side.length === 3 ? ' three' : ''}">${side.map(([rel, alt]) => `<a href="/${rel}" data-lightbox>${thumb(rel, alt)}</a>`).join('')}</div></div>
    <p class="note lp-gallery-note">${note}</p>`;
  };
  const fits = (list) => `<ul class="lp-fits">${list.map(([t, d]) => `<li><strong>${esc(t)}</strong><span>${esc(d)}</span></li>`).join('')}</ul>`;
  const faq = (list) => `<div class="faq lp-faq">${list.map(([q, a], i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(q)}</summary><div class="a">${esc(a)}</div></details>`).join('')}</div>`;
  const faqLd = (url, list) => ({ '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: list.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
  const crumbLd = (url, trail) => ({ '@type': 'BreadcrumbList', '@id': `${url}#breadcrumb`, itemListElement: [['홈', `${SITE}/`], ...trail].map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })) });
  const pageLd = (url, p, about, image) => ({ '@type': 'WebPage', '@id': `${url}#webpage`, url, name: p.title, description: p.description, inLanguage: 'ko-KR',
    isPartOf: { '@id': `${SITE}/#website` }, about, breadcrumb: { '@id': `${url}#breadcrumb` }, primaryImageOfPage: { '@type': 'ImageObject', url: abs(image) } });
  const postCards = (slugs) => {
    const list = slugs.map((s) => posts.find((p) => p.slug === s)).filter(Boolean);
    return list.length ? `<div class="mz-grid">${list.map((p) => card(p)).join('')}</div>` : '';
  };
  const xHint = '<p class="x-hint">표는 좌우로 밀어서 볼 수 있습니다.</p>';
  const exampleTable = (rows, { roomCol = false } = {}) => `${xHint}<div class="table-wrap lp-table"><table class="table"><thead><tr><th>모임</th><th>${roomCol ? '방 · 이용 시간' : '이용 시간'}</th><th class="num">대관료</th><th class="num">1인당</th></tr></thead><tbody>${rows.map(([name, time, expr, people]) => `<tr><td class="strong">${esc(name)}</td><td>${esc(time)}</td><td class="num">{{= ${expr} }}원</td><td class="num">${people ? `{{= (${expr}) / ${people} }}원` : '–'}</td></tr>`).join('')}</tbody></table></div>`;
  const rateGrid = (k) => `<div class="rate-grid">
        <div><span class="k">평일 오전 · 심야</span><span class="v">{{rate.${k}.wdEarly}}원</span><span class="t">07~12시 · 24~07시</span></div>
        <div><span class="k">평일 오후 · 저녁</span><span class="v">{{rate.${k}.wdStd}}원</span><span class="t">12~24시</span></div>
        <div class="hd"><span class="k">주말 · 공휴일 오전 · 심야</span><span class="v">{{rate.${k}.hdEarly}}원</span><span class="t">07~12시 · 24~07시</span></div>
        <div class="peak"><span class="k">주말 · 공휴일 오후 · 저녁</span><span class="v">{{rate.${k}.hdStd}}원</span><span class="t">12~24시</span></div>
      </div>`;
  const bookingSteps = `<div class="steps">
      <div class="step"><h3>방과 일정 고르기</h3><p>예약 신청 화면에서 방, 날짜, 시간, 인원을 고릅니다. 최소 {{booking.minHours}}시간부터 {{booking.stepMinutes}}분 단위로 예약합니다.</p></div>
      <div class="step"><h3>시간 확보와 결제</h3><p>신청한 시간이 다른 예약과 겹치지 않는지 확인한 뒤 결제를 안내합니다. 신청만으로는 예약이 확정되지 않습니다.</p></div>
      <div class="step"><h3>확정과 출입 안내</h3><p>결제가 확인되면 예약이 확정되고, 출입 방법과 층 안내를 문자나 메신저로 보내 드립니다.</p></div>
      <div class="step"><h3>이용과 정리</h3><p>방 안의 QR(룸 가이드)에서 와이파이와 화면 연결 방법을 봅니다. 퇴실 전에 책상과 의자를 원래대로 돌려놓습니다.</p></div>
    </div>`;
  const cta = (title, text, actions) => `<section class="section tight bg">
  <div class="container">
    <div class="cta-band">
      <div><h2>${title}</h2><p>${text}</p></div>
      <div class="actions">${actions}</div>
    </div>
  </div>
</section>`;
  const useCard = (u) => `<a class="use-card" href="/for/${u.slug}"><span class="uc-tag">${u.tag}</span><h3>${esc(u.name)}</h3><p>${esc(u.lead.split('. ')[0].replace(/\.$/, ''))}.</p><span class="uc-more">${esc(u.name)} 안내 보기 →</span></a>`;
  const address = { '@type': 'PostalAddress', streetAddress: '화양동 10-1 한아름건물 4층', addressLocality: '광진구', addressRegion: '서울특별시', addressCountry: 'KR' };
  const place = { '@id': `${SITE}/#place` };
  const roomByKey = Object.fromEntries(ROOMS.map((r) => [r.key, r]));
  const pages = [];
  const add = (out, src, p, main, ld, { priority = '0.8', images = [] } = {}) => {
    const where = `${SRC}/${src}`;
    const url = `${SITE}/${out.replace(/\.html$/, '')}`;
    const meta = JSON.parse(resolveTokens(JSON.stringify({ title: p.title, description: p.description, image: p.og, imageAlt: p.h1, ld: { '@context': 'https://schema.org', '@graph': ld } }), data, where));
    if (meta.description.length < 60 || meta.description.length > 160) throw new Error(`${where} → ${out}: description 은 60~160자로 씁니다 (지금 ${meta.description.length}자)`);
    pages.push({ file: where, out, url, landing: true, meta: { ...meta, priority, changefreq: 'monthly', images, lastmod: LANDING_LASTMOD }, main: resolveTokens(main, data, where) });
  };

  /* ------------------------------------------------------------------------
     방별 페이지
     ------------------------------------------------------------------------ */
  for (const r of ROOMS) {
    const url = `${SITE}/rooms/${r.n}`; const rate = data.rate[r.key];
    const prices = [rate.wdEarly, rate.wdStd, rate.hdEarly, rate.hdStd];
    const specs = [['크기', `${r.size} · ${r.area}`], ...(r.ceiling ? [['천장 높이', r.ceiling]] : []), ['위치', r.where], ['가능한 배치', r.layouts.join(' · ')]];
    const main = `<section class="page-hero lp-hero">
  <div class="container">
    ${crumbs([['Space', '/space'], [`${r.n}번룸`]])}
    <span class="eyebrow">소셜팩토리 건대 · ${esc(r.use)}</span>
    <h1 class="mt-16">${esc(r.h1)}</h1>
    <p class="lead">${esc(r.lead)}</p>
    <div class="actions"><a class="btn btn-primary btn-lg" href="/booking?room=${r.key}">${r.n}번룸 예약 신청</a><a class="btn btn-outline btn-lg" href="/pricing?room=${r.key}#estimate">예상 금액 계산</a>${kk('카카오톡 문의')}</div>
    ${facts([['최대 인원', `{{rate.${r.key}.max}}명`], ['면적', r.area], ['화면 · 판서', r.screen], ['시간당 요금', `{{rate.${r.key}.wdEarly}}~{{rate.${r.key}.hdStd}}원`], ['예약', `24시간 · 최소 {{booking.minHours}}시간`], ['위치', '건대입구역 도보권 · 4층']])}
  </div>
</section>
<section class="section tight" id="photos">
  <div class="container">
    <h2 class="sr-only">${r.n}번룸 사진</h2>
    ${gallery(r.photos)}
  </div>
</section>
<section class="section tight" id="about">
  <div class="container lp-two">
    <div class="lp-copy">
      <h2 class="h3">${esc(r.shapeTitle)}</h2>
      ${r.shape.map((t) => `<p>${esc(t)}</p>`).join('\n      ')}
      <dl class="rd-specs">${specs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <p class="lp-links"><a href="/space#floorplan">4층 평면도에서 위치 보기 →</a><a href="/tour">3D로 둘러보기 →</a></p>
    </div>
    <aside class="lp-side">
      <h2>${r.n}번룸은 이런 모임에 맞습니다</h2>
      ${fits(r.fits)}
    </aside>
  </div>
</section>
<section class="section tight bg" id="layout">
  <div class="container lp-two even">
    <div>
      <h2 class="h3">쓸 수 있는 배치</h2>
      <p class="lead" style="margin-top:12px;font-size:16px;">배치는 이용하는 분이 직접 바꾸고, 퇴실 전에 원래대로 돌려놓습니다. 책상을 쓰는 배치에서는 최대 인원보다 적게 앉습니다.</p>
      <ul class="lp-layouts mt-24">${r.layouts.map((n) => `<li><strong>${esc(n)}</strong><span>${esc(LAYOUTS[n])}</span></li>`).join('')}</ul>
      <p class="lp-links"><a href="/space#layouts">배치 사진으로 보기 →</a></p>
    </div>
    <div>
      <h2 class="h3">갖춘 장비</h2>
      <ul class="gear-chips mt-24">${r.gear.map(([ic, n]) => `<li class="g-main"><span class="g-ic g-${ic}" aria-hidden="true"></span>${esc(n)}</li>`).join('')}<li>와이파이</li><li>테이블 · 의자</li><li>냉난방</li></ul>
      <p class="mt-16" style="color:var(--navy-80);font-size:15.5px;">위 장비는 모두 기본 요금에 들어 있습니다. 노트북은 대당 {{cfg.pricing.options.0.price}}원에 빌려 드리고, 스피커와 전신거울은 무료로 빌려 드립니다. 같은 건물 밍글카페와 제휴한 음료 · 다과도 신청할 수 있습니다.</p>
      <p class="lp-links"><a href="/pricing#options">옵션 자세히 보기 →</a></p>
    </div>
  </div>
</section>
<section class="section tight lp-rate" id="price">
  <div class="container">
    <div class="section-head">
      <h2 class="h2">${r.n}번룸 대관 요금</h2>
      <p class="lead">${r.n}번룸은 시간당 {{rate.${r.key}.wdEarly}}~{{rate.${r.key}.hdStd}}원입니다. 부가세 포함이고, 인원 추가 요금 없이 룸과 시간으로 받습니다. 최소 {{booking.minHours}}시간부터 {{booking.stepMinutes}}분 단위로 예약합니다.</p>
    </div>
    ${rateGrid(r.key)}
    <h3 class="lp-sub">이렇게 쓰면 얼마인가요</h3>
    ${exampleTable(r.examples)}
    <p class="note mt-16">모임 시간만 계산한 금액입니다. 배치를 바꾸는 날은 준비와 정리 시간을 더해 예약해 주세요. 자정부터 아침 7시까지는 전날과 그날이 모두 주말 · 공휴일일 때만 주말 요금입니다.</p>
    <p class="lp-links"><a href="/pricing?room=${r.key}#estimate">날짜와 시간을 넣어 계산하기 →</a><a href="/pricing#refund">취소 · 환불 기준 →</a><a href="/pricing">전체 요금표 →</a></p>
  </div>
</section>
<section class="section tight bg" id="how">
  <div class="container">
    <div class="section-head"><h2 class="h2">예약은 이렇게 진행됩니다</h2></div>
    ${bookingSteps}
    <div class="actions"><a class="btn btn-primary" href="/booking?room=${r.key}">${r.n}번룸 날짜 · 시간 고르기</a><a class="btn btn-outline" href="/guide#rules">이용 원칙 보기</a></div>
  </div>
</section>
<section class="section tight" id="compare">
  <div class="container">
    <div class="section-head"><h2 class="h2">다른 방과 비교</h2><p class="lead">인원이 늘거나 진행 방식이 바뀌면 다른 방이 더 맞을 수 있습니다. 룸마다 최대 인원이 있어 넘기면 이용이 중단될 수 있습니다.</p></div>
    ${xHint}<div class="table-wrap lp-table wide"><table class="table"><thead><tr><th>룸</th><th>최대 인원</th><th>면적</th><th>화면 · 판서</th><th class="num">평일 시간당</th><th class="num">주말 · 공휴일 시간당</th></tr></thead><tbody>${ROOMS.map((x) => `<tr${x.key === r.key ? ' class="is-here"' : ''}><td class="strong">${x.key === r.key ? `${x.n}번룸 (지금 보는 방)` : `<a href="/rooms/${x.n}">${x.n}번룸 · ${esc(x.kind)}</a>`}</td><td>{{rate.${x.key}.max}}명</td><td>${esc(x.area)}</td><td>${esc(x.screen)}</td><td class="num">{{rate.${x.key}.wdEarly}}~{{rate.${x.key}.wdStd}}원</td><td class="num">{{rate.${x.key}.hdEarly}}~{{rate.${x.key}.hdStd}}원</td></tr>`).join('')}</tbody></table></div>
    <p class="note mt-16">{{stat.maxCap}}명이 넘는 행사는 여러 룸을 나눠 쓰거나, 같은 건물 2층의 대형 행사장 <a href="https://megaspot.kr" target="_blank" rel="noopener" style="color:var(--blue);font-weight:700;">메가스팟</a>(최대 200명)을 살펴보세요.</p>
  </div>
</section>
<section class="section tight bg" id="faq">
  <div class="container">
    <div class="section-head"><h2 class="h2">${r.n}번룸 자주 묻는 질문</h2></div>
    ${faq(r.faq)}
    <p class="lp-links"><a href="/guide#faq">이용 안내의 전체 질문 보기 →</a></p>
  </div>
</section>
<section class="section tight" id="more">
  <div class="container">
    <div class="lp-head"><h2 class="h3">${r.n}번룸을 쓰기 전에 읽어 보면 좋은 글</h2><a class="btn btn-ghost" href="/magazine">매거진 전체 보기 →</a></div>
    ${postCards(r.posts)}
    <div class="lp-next">
      <h3>모임 종류로 찾아보기</h3>
      <div class="use-grid">${r.uses.map((s) => useCard(USES.find((u) => u.slug === s))).join('')}</div>
    </div>
  </div>
</section>
${cta(`${r.n}번룸이 맞는지 <br>아직 고민되시나요`, '일자 · 시간 · 인원 · 모임 유형 네 가지만 알려 주시면 맞는 방과 예상 금액, 예약할 수 있는 시간을 안내해 드립니다.', `${kk('카카오톡 문의')}<a class="btn btn-primary btn-lg" href="/booking?room=${r.key}">예약 신청</a><a class="btn btn-outline btn-lg" href="/space#rooms">방 5개 한눈에 보기</a>`)}`;
    const ld = [
      pageLd(url, r, { '@id': `${url}#room` }, r.photos[0][0]),
      { '@type': 'MeetingRoom', '@id': `${url}#room`, name: `소셜팩토리 건대 ${r.n}번룸`, alternateName: r.h1, description: r.lead, url,
        image: r.photos.map(([rel]) => abs(rel)), maximumAttendeeCapacity: rate.max,
        floorSize: { '@type': 'QuantitativeValue', value: r.areaNum, unitCode: 'MTK' },
        amenityFeature: [...r.gear.map(([, n]) => n), '와이파이', '테이블 · 의자', '냉난방'].map((n) => ({ '@type': 'LocationFeatureSpecification', name: n, value: true })),
        containedInPlace: place, address,
        potentialAction: { '@type': 'ReserveAction', name: `${r.n}번룸 예약 신청`, target: { '@type': 'EntryPoint', urlTemplate: `${SITE}/booking?room=${r.key}`, inLanguage: 'ko-KR' } } },
      { '@type': 'Service', '@id': `${url}#service`, name: `소셜팩토리 건대 ${r.n}번룸 대관`, serviceType: `${r.kind} 대관`, provider: place,
        areaServed: { '@type': 'AdministrativeArea', name: '서울특별시 광진구' },
        offers: { '@type': 'AggregateOffer', priceCurrency: 'KRW', lowPrice: Math.min(...prices), highPrice: Math.max(...prices), offerCount: 4, description: '시간당 요금 · 부가세 포함 · 인원 추가 요금 없음' } },
      crumbLd(url, [['공간 안내', `${SITE}/space`], [`${r.n}번룸`, url]]),
      faqLd(url, r.faq)
    ];
    add(`rooms/${r.n}.html`, 'rooms.mjs', r, main, ld, { images: r.photos.map(([rel]) => rel) });
  }

  /* ------------------------------------------------------------------------
     용도별 페이지
     ------------------------------------------------------------------------ */
  const roomCard = ([key, when, why]) => {
    if (key === 'cowork') {
      return `<article class="lp-room"><a class="lr-media" href="/coworking">${thumb(COWORKING.photos[0][0], COWORKING.photos[0][1])}</a><div class="lr-body"><span class="lr-when">${esc(when)}</span><h3><a href="/coworking">24시간 코워킹 · 스터디카페</a></h3><p>${esc(why)}</p><ul class="lr-facts"><li>50석 · 자유석</li><li>2시간권 {{cfg.pricing.coworkingPasses.0.price}}원</li><li>24시간</li></ul><div class="lr-actions"><a class="btn btn-outline btn-sm" href="/coworking">코워킹 자세히 보기</a></div></div></article>`;
    }
    const r = roomByKey[key];
    return `<article class="lp-room"><a class="lr-media" href="/rooms/${r.n}">${thumb(r.photos[0][0], r.photos[0][1])}</a><div class="lr-body"><span class="lr-when">${esc(when)}</span><h3><a href="/rooms/${r.n}">${r.n}번룸 · ${esc(r.kind)}</a></h3><p>${esc(why)}</p><ul class="lr-facts"><li>최대 {{rate.${key}.max}}명</li><li>${esc(r.area.split(' ')[0])}</li><li>${esc(r.screen)}</li><li>평일 {{rate.${key}.wdEarly}}원부터</li></ul><div class="lr-actions"><a class="btn btn-outline btn-sm" href="/rooms/${r.n}">${r.n}번룸 자세히 보기</a><a class="btn btn-primary btn-sm" href="/booking?room=${key}">예약 신청</a></div></div></article>`;
  };
  for (const u of USES) {
    const url = `${SITE}/for/${u.slug}`;
    const main = `<section class="page-hero lp-hero with-media">
  <div class="container">
    ${crumbs([['Space', '/space'], [u.name]])}
    <span class="eyebrow">용도별 안내 · ${u.tag}</span>
    <h1 class="mt-16">${esc(u.h1)}</h1>
    <p class="lead">${esc(u.lead)}</p>
    <div class="actions"><a class="btn btn-primary btn-lg" href="/booking">방과 일정 골라 예약 신청</a><a class="btn btn-outline btn-lg" href="/pricing#estimate">예상 금액 계산</a>${kk('카카오톡 문의')}</div>
    <div class="hero-media img-wrap">${img(u.hero[0], u.hero[1], { sizes: '(max-width: 1180px) 100vw, 1180px', eager: true })}</div>
  </div>
</section>
<section class="section tight" id="points">
  <div class="container">
    <div class="section-head"><h2 class="h2">${esc(u.pointsTitle)}</h2></div>
    <ul class="lp-points">${u.points.map(([t, d]) => `<li><strong>${esc(t)}</strong><span>${esc(d)}</span></li>`).join('')}</ul>
  </div>
</section>
<section class="section tight bg" id="rooms">
  <div class="container">
    <div class="section-head"><h2 class="h2">이 모임에 맞는 방</h2><p class="lead">요금은 인원이 아니라 룸과 시간으로 받습니다. 방마다 최대 인원이 있으니 진행자와 운영진까지 세어 골라 주세요.</p></div>
    <div class="lp-rooms">${u.rooms.map(roomCard).join('')}</div>
    <p class="lp-links"><a href="/space#rooms">방 5개를 한 표로 비교하기 →</a><a href="/space#layouts">배치 사진 보기 →</a></p>
  </div>
</section>
<section class="section tight" id="cost">
  <div class="container">
    <div class="section-head"><h2 class="h2">비용은 이렇게 나옵니다</h2><p class="lead">요일과 시간대에 따라 시간당 요금이 달라집니다. 평일 오전(07~12시)과 심야(24~07시)가 가장 낮고, 주말 · 공휴일 오후 · 저녁이 가장 높습니다. 아래 금액은 부가세 포함입니다.</p></div>
    ${exampleTable(u.examples, { roomCol: true })}
    <p class="note mt-16">모임 시간만 계산한 금액입니다. 준비와 정리 시간도 예약에 넣어야 하니, 배치를 바꾸는 날은 그만큼 더해 계산해 주세요.${u.exampleNote ? ` ${esc(u.exampleNote)}` : ''}</p>
    <p class="lp-links"><a href="/pricing#estimate">날짜와 시간을 넣어 계산하기 →</a><a href="/pricing#refund">취소 · 환불 기준 →</a><a href="/magazine/room-rate-by-time">시간대별 요금 보는 법 →</a></p>
  </div>
</section>
<section class="section tight bg" id="check">
  <div class="container">
    <div class="section-head"><h2 class="h2">${esc(u.checkTitle)}</h2></div>
    <ol class="lp-checks">${u.checks.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
    <p class="lp-links"><a href="/guide#rules">이용 원칙 전체 보기 →</a>${u.extra ? `<a href="${u.extra.href}">${esc(u.extra.label)} →</a>` : ''}<a href="/play">모임 도구 · 게임 →</a></p>
  </div>
</section>
<section class="section tight" id="faq">
  <div class="container">
    <div class="section-head"><h2 class="h2">자주 묻는 질문</h2></div>
    ${faq(u.faq)}
    <p class="lp-links"><a href="/guide#faq">이용 안내의 전체 질문 보기 →</a></p>
  </div>
</section>
<section class="section tight bg" id="more">
  <div class="container">
    <div class="lp-head"><h2 class="h3">준비할 때 읽어 보면 좋은 글</h2><a class="btn btn-ghost" href="/magazine">매거진 전체 보기 →</a></div>
    ${postCards(u.posts)}
    <div class="lp-next">
      <h3>다른 모임을 준비하고 있다면</h3>
      <div class="use-grid">${u.next.map((s) => useCard(USES.find((x) => x.slug === s))).join('')}<a class="use-card" href="/space#rooms"><span class="uc-tag">룸 5개 · 최대 {{stat.minCap}}~{{stat.maxCap}}명</span><h3>전체 공간 안내</h3><p>룸 5개의 크기와 사진, 4층 평면도, 장비, 요금을 한 페이지에서 비교합니다.</p><span class="uc-more">공간 안내 보기 →</span></a></div>
    </div>
  </div>
</section>
${cta('어떤 방이 맞을지 <br>고민되시나요', '일자 · 시간 · 인원 · 모임 유형 네 가지만 알려 주시면 맞는 방과 예상 금액, 예약할 수 있는 시간을 안내해 드립니다.', `${kk('카카오톡 문의')}<a class="btn btn-primary btn-lg" href="/booking">예약 신청</a><a class="btn btn-outline btn-lg" href="/contact?purpose=rental#inquiry">문의 남기기</a>`)}`;
    const ld = [
      pageLd(url, u, place, u.hero[0]),
      { '@type': 'ItemList', '@id': `${url}#rooms`, name: `${u.name}에 맞는 방`, itemListElement: u.rooms.map(([key], i) => ({ '@type': 'ListItem', position: i + 1,
        name: key === 'cowork' ? '24시간 코워킹 · 스터디카페' : `소셜팩토리 건대 ${roomByKey[key].n}번룸`, url: key === 'cowork' ? `${SITE}/coworking` : `${SITE}/rooms/${roomByKey[key].n}` })) },
      crumbLd(url, [['공간 안내', `${SITE}/space`], [u.name, url]]),
      faqLd(url, u.faq)
    ];
    add(`for/${u.slug}.html`, 'uses.mjs', u, main, ld, { priority: '0.7', images: [u.hero[0]] });
  }

  /* ------------------------------------------------------------------------
     코워킹 · 스터디카페
     ------------------------------------------------------------------------ */
  {
    const c = COWORKING; const url = `${SITE}/coworking`; const passes = data.cfg.pricing.coworkingPasses;
    const passTime = ['결제한 시각부터 2시간', '결제한 시각부터 24시간', '다음 달 같은 날 같은 시각까지'];
    const passFor = ['모임 전후, 잠깐 들르는 날', '하루 종일 공부하거나 일하는 날', `한 달에 {{= ceil(cfg.pricing.coworkingPasses.2.price / cfg.pricing.coworkingPasses.1.price) }}일 이상 오는 분`];
    const main = `<section class="page-hero lp-hero">
  <div class="container">
    ${crumbs([['Space', '/space'], ['코워킹 · 스터디카페']])}
    <span class="eyebrow">소셜팩토리 건대 · 24시간 · 50석</span>
    <h1 class="mt-16">${esc(c.h1)}</h1>
    <p class="lead">${esc(c.lead)}</p>
    <div class="actions"><a class="btn btn-primary btn-lg" href="#pass">이용권 보기</a><a class="btn btn-outline btn-lg" href="/guide#location">오시는 길</a>${kk('코워킹 카톡 문의')}</div>
    ${facts(c.facts)}
  </div>
</section>
<section class="section tight" id="photos">
  <div class="container">
    <h2 class="sr-only">코워킹 공간 사진</h2>
    ${gallery(c.photos, '사진을 누르면 크게 볼 수 있습니다.')}
  </div>
</section>
<section class="section tight lp-rate" id="pass">
  <div class="container">
    <div class="section-head"><h2 class="h2">이용권과 요금</h2><p class="lead">2시간만 들르는 날부터 한 달 내내 쓰는 정기권까지 세 가지입니다. 모두 부가세 포함이고, 현장 무인 키오스크에서 결제합니다.</p></div>
    ${xHint}<div class="table-wrap lp-table wide"><table class="table"><thead><tr><th>이용권</th><th class="num">금액</th><th>이용 시간</th><th>이런 날에</th></tr></thead><tbody>${passes.map((p, i) => `<tr><td class="strong">${esc(p.name)}</td><td class="num">{{cfg.pricing.coworkingPasses.${i}.price}}원</td><td>${passTime[i]}</td><td>${passFor[i]}</td></tr>`).join('')}</tbody></table></div>
    <div class="lp-copy mt-32" style="max-width:860px;">${c.passNote.map((t) => `<p>${esc(t)}</p>`).join('')}</div>
    <p class="lp-links"><a href="/pricing?mode=cowork#estimate">이용권 금액 계산하기 →</a><a href="/magazine/exam-prep-study-spot-routine">시험 기간 이용권 계산 예시 →</a></p>
  </div>
</section>
<section class="section tight bg" id="how">
  <div class="container">
    <div class="section-head"><h2 class="h2">예약 없이, 키오스크에서 바로</h2></div>
    <div class="steps lp-steps three">${c.steps.map(([t, d]) => `<div class="step"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
  </div>
</section>
<section class="section tight" id="seats">
  <div class="container lp-two">
    <div class="lp-copy">
      <h2 class="h3">${esc(c.seatsTitle)}</h2>
      ${c.seats.map((t) => `<p>${esc(t)}</p>`).join('\n      ')}
      <h3 class="lp-sub">${esc(c.mannerTitle)}</h3>
      <ul class="lp-plain">${c.manners.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <p class="lp-links"><a href="/magazine/coworking-etiquette-six-habits">코워킹 매너 여섯 가지 →</a><a href="/rooms/3">3번룸 · 스터디룸 보기 →</a></p>
    </div>
    <aside class="lp-side">
      <h2>이런 분께 맞습니다</h2>
      ${fits(c.fits)}
    </aside>
  </div>
</section>
<section class="section tight bg" id="faq">
  <div class="container">
    <div class="section-head"><h2 class="h2">코워킹 자주 묻는 질문</h2></div>
    ${faq(c.faq)}
  </div>
</section>
<section class="section tight" id="more">
  <div class="container">
    <div class="lp-head"><h2 class="h3">코워킹을 쓰기 전에 읽어 보면 좋은 글</h2><a class="btn btn-ghost" href="/magazine#work">일과 공부 글 모아 보기 →</a></div>
    ${postCards(c.posts)}
    <div class="lp-next">
      <h3>함께 보면 좋은 안내</h3>
      <div class="use-grid"><a class="use-card" href="/office"><span class="uc-tag">1~3인 · 월 단위</span><h3>독립사무실</h3><p>문을 닫고 쓰는 내 자리가 필요하다면, 같은 층의 1~3인 독립사무실을 살펴보세요.</p><span class="uc-more">독립사무실 안내 보기 →</span></a>${useCard(USES.find((u) => u.slug === 'study'))}<a class="use-card" href="/magazine/coworking-vs-private-office"><span class="uc-tag">비교</span><h3>코워킹 자유석과 1인 사무실</h3><p>오는 날 수와 짐, 통화 빈도에 따라 어느 쪽이 맞는지 정리한 글입니다.</p><span class="uc-more">비교 글 읽기 →</span></a></div>
    </div>
  </div>
</section>
${cta('처음 오시나요', '건물 입구에서 4층으로 올라오면 복도 입구에 소셜팩토리 안내가 있습니다. 길을 찾기 어려우면 카카오톡으로 알려 주세요.', `${kk('카카오톡 문의')}<a class="btn btn-primary btn-lg" href="/guide#location">오시는 길</a><a class="btn btn-outline btn-lg" href="/parking">주차 안내</a>`)}`;
    const ld = [
      pageLd(url, c, { '@id': `${url}#service` }, c.photos[0][0]),
      { '@type': 'Service', '@id': `${url}#service`, name: '소셜팩토리 건대 코워킹 · 스터디카페', serviceType: '코워킹 스페이스 · 스터디카페', description: c.lead, url, provider: place,
        image: c.photos.map(([rel]) => abs(rel)), areaServed: { '@type': 'AdministrativeArea', name: '서울특별시 광진구' },
        hoursAvailable: { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], opens: '00:00', closes: '23:59' },
        offers: passes.map((p) => ({ '@type': 'Offer', name: p.name, price: p.price, priceCurrency: 'KRW', description: `${p.unit} · 부가세 포함 · 현장 무인 키오스크 결제` })) },
      crumbLd(url, [['공간 안내', `${SITE}/space`], ['코워킹 · 스터디카페', url]]),
      faqLd(url, c.faq)
    ];
    add('coworking.html', 'work.mjs', c, main, ld, { priority: '0.9', images: c.photos.map(([rel]) => rel) });
  }

  /* ------------------------------------------------------------------------
     독립사무실
     ------------------------------------------------------------------------ */
  {
    const o = OFFICE; const url = `${SITE}/office`; const rooms = data.cfg.pricing.officeRooms; const disc = data.cfg.pricing.officeDiscounts;
    const m = (i, d) => `{{= cfg.pricing.officeRooms.${i}.monthly${d == null ? '' : ` * (100 - cfg.pricing.officeDiscounts.${d}.rate) / 100`} }}`;
    const main = `<section class="page-hero lp-hero">
  <div class="container">
    ${crumbs([['Space', '/space'], ['독립사무실']])}
    <span class="eyebrow">소셜팩토리 건대 · 1~3인 · 월 단위</span>
    <h1 class="mt-16">${esc(o.h1)}</h1>
    <p class="lead">${esc(o.lead)}</p>
    <div class="actions">${kk('카카오톡으로 사무실 문의')}<a class="btn btn-primary btn-lg" href="/contact?purpose=office#inquiry">문의 남기기</a><a class="btn btn-outline btn-lg" href="/pricing?mode=office#estimate">계약 기간별 금액 계산</a></div>
    ${facts(o.facts)}
  </div>
</section>
<section class="section tight" id="rooms">
  <div class="container">
    <div class="section-head"><h2 class="h2">사무실 네 곳</h2><p class="lead">${esc(o.roomsNote)}</p></div>
    <div class="lp-rooms four">${o.rooms.map(([name, people, size, i, rel, alt]) => `<article class="lp-room"><a class="lr-media" href="/${rel}" data-lightbox>${thumb(rel, alt)}</a><div class="lr-body"><span class="lr-when">${esc(people)}</span><h3>${esc(name)}</h3><p>${esc(size)}</p><span class="lr-price">${m(i)}원<small>월 · 부가세 별도</small></span></div></article>`).join('')}</div>
    <p class="note mt-16">사진을 누르면 크게 볼 수 있습니다. 호실의 위치는 <a href="/space#floorplan" style="color:var(--blue);font-weight:700;">4층 평면도</a>에서 확인할 수 있습니다.</p>
  </div>
</section>
<section class="section tight bg lp-rate" id="price">
  <div class="container">
    <div class="section-head"><h2 class="h2">계약 기간별 월 이용료</h2><p class="lead">월 단위로 이용하고, ${disc[0].months}개월 계약은 ${disc[0].rate}%, ${disc[1].months}개월 계약은 ${disc[1].rate}% 낮은 월 이용료가 적용됩니다. 아래 금액은 모두 부가세 별도입니다.</p></div>
    ${xHint}<div class="table-wrap lp-table wide"><table class="table"><thead><tr><th>호실</th><th>인원</th><th class="num">1개월</th><th class="num">${disc[0].months}개월 계약 · 월</th><th class="num">${disc[1].months}개월 계약 · 월</th></tr></thead><tbody>${rooms.map((r, i) => `<tr><td class="strong">${esc(r.name)}</td><td>${esc(r.people)}</td><td class="num">${m(i)}원</td><td class="num">${m(i, 0)}원</td><td class="num">${m(i, 1)}원</td></tr>`).join('')}</tbody></table></div>
    <p class="note mt-16">할인 금액은 계약 기간 동안의 월 이용료입니다. 여러 실을 함께 쓰거나 안내된 기간 외의 계약은 따로 문의해 주세요.</p>
    <p class="lp-links"><a href="/pricing?mode=office#estimate">호실과 기간을 바꿔 계산하기 →</a><a href="/magazine/solo-founder-office-checklist">계약 전에 확인할 다섯 가지 →</a></p>
  </div>
</section>
<section class="section tight" id="included">
  <div class="container lp-two">
    <div class="lp-copy">
      <h2 class="h3">${esc(o.includedTitle)}</h2>
      <ul class="lp-incl mt-24">${o.included.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <h3 class="lp-sub">계약 전에 알아 두세요</h3>
      <ul class="lp-plain">${o.notIncluded.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <p class="lp-links"><a href="/rooms/3">3번룸 · 회의실 보기 →</a><a href="/coworking">코워킹 안내 보기 →</a></p>
    </div>
    <aside class="lp-side">
      <h2>이런 분께 맞습니다</h2>
      ${fits(o.fits)}
    </aside>
  </div>
</section>
<section class="section tight bg" id="ask">
  <div class="container">
    <div class="section-head"><h2 class="h2">${esc(o.askTitle)}</h2></div>
    <div class="steps lp-steps three">${o.ask.map(([t, d]) => `<div class="step"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
    <div class="actions">${kk('카카오톡으로 사무실 문의', 'btn btn-kakao')}<a class="btn btn-outline" href="/contact?purpose=office#inquiry">문의 폼으로 남기기</a></div>
  </div>
</section>
<section class="section tight" id="faq">
  <div class="container">
    <div class="section-head"><h2 class="h2">독립사무실 자주 묻는 질문</h2></div>
    ${faq(o.faq)}
  </div>
</section>
<section class="section tight bg" id="more">
  <div class="container">
    <div class="lp-head"><h2 class="h3">사무실을 고르기 전에 읽어 보면 좋은 글</h2><a class="btn btn-ghost" href="/magazine#work">일과 공부 글 모아 보기 →</a></div>
    ${postCards(o.posts)}
    <div class="lp-next">
      <h3>함께 보면 좋은 안내</h3>
      <div class="use-grid"><a class="use-card" href="/coworking"><span class="uc-tag">50석 · 24시간</span><h3>코워킹 · 스터디카페</h3><p>매일 나올지 아직 모르겠다면 자유석 이용권으로 먼저 써 보세요. 2시간권 {{cfg.pricing.coworkingPasses.0.price}}원부터입니다.</p><span class="uc-more">코워킹 안내 보기 →</span></a>${useCard(USES.find((u) => u.slug === 'meeting'))}<a class="use-card" href="/space#floorplan"><span class="uc-tag">4층 전체 약 250평</span><h3>4층 평면도</h3><p>독립사무실과 코워킹, 룸 5개, 휴게 · 대기 공간이 한 층에 어떻게 놓여 있는지 볼 수 있습니다.</p><span class="uc-more">평면도 보기 →</span></a></div>
    </div>
  </div>
</section>
${cta('입주 시기와 인원을 <br>알려 주세요', '지금 이용할 수 있는 호실과 계약 기간별 조건을 확인해 드립니다. 이용 기간이 정해지지 않았어도 괜찮습니다.', `${kk('카카오톡 문의')}<a class="btn btn-primary btn-lg" href="/contact?purpose=office#inquiry">문의 남기기</a><a class="btn btn-outline btn-lg" href="/guide#location">오시는 길</a>`)}`;
    const ld = [
      pageLd(url, o, { '@id': `${url}#service` }, o.rooms[0][4]),
      { '@type': 'Service', '@id': `${url}#service`, name: '소셜팩토리 건대 독립사무실', serviceType: '1인 사무실 · 소규모 사무실 이용', description: o.lead, url, provider: place,
        image: o.rooms.map((r) => abs(r[4])), areaServed: { '@type': 'AdministrativeArea', name: '서울특별시 광진구' },
        offers: rooms.map((r) => ({ '@type': 'Offer', name: `${r.name} (${r.people})`, price: r.monthly, priceCurrency: 'KRW', description: '월 이용료 · 부가세 별도' })) },
      crumbLd(url, [['공간 안내', `${SITE}/space`], ['독립사무실', url]]),
      faqLd(url, o.faq)
    ];
    add('office.html', 'work.mjs', o, main, ld, { priority: '0.9', images: [o.hero[0], ...o.rooms.map((r) => r[4])] });
  }

  return pages;
}

/* --------------------------------------------------------------------------
   llms.txt — AI 검색 도구가 사이트를 요약해 읽을 때 참고하는 글자 파일
   (구글 검색은 이 파일을 쓰지 않는다고 밝혔습니다. 사실을 한곳에 모아 두는 용도입니다.)
   -------------------------------------------------------------------------- */
export function llmsTxt(data) {
  const c = data.cfg, r = data.rate, won = (n) => Number(n).toLocaleString('en-US');
  const p = c.pricing.coworkingPasses, o = c.pricing.officeRooms;
  const room = (x) => `- [${x.n}번룸 · ${x.kind}](${SITE}/rooms/${x.n}): 최대 ${r[x.key].max}명, ${x.area}, ${x.screen}, 시간당 ${won(r[x.key].wdEarly)}~${won(r[x.key].hdStd)}원`;
  return `# 소셜팩토리 건대 (SOCIAL FACTORY)

> 서울 건대입구역 도보권, 광진구 화양동 한아름건물 4층 전체(약 250평)를 쓰는 모임공간입니다. 최대 ${data.stat.minCap}~${data.stat.maxCap}명이 쓰는 세미나실 · 강의실 · 회의실 룸 ${data.stat.rooms}개를 24시간 대관하고, 24시간 코워킹 50석과 1~3인 독립사무실 4실을 운영합니다. 2015년 홍대에서 시작한 브랜드이며 슬로건은 '모이면 만들어진다'입니다.

## 기본 정보

- 주소: ${c.address}
- 오시는 길: ${c.directions}
- 운영: 룸 ${c.hours.rooms} · 코워킹 ${c.hours.coworking} · 독립사무실 ${c.hours.office} (상주 직원 없이 운영)
- 룸 요금: 시간당 ${won(data.stat.from)}~${won(data.stat.top)}원, 부가세 포함, 인원 추가 요금 없음(룸 단위 요금)
- 예약: 홈페이지에서 방 · 날짜 · 시간을 골라 신청 → 시간 확보 → 결제 → 확정. 최소 ${data.booking.minHours}시간, ${data.booking.stepMinutes}분 단위
- 취소 · 환불: ${c.pricing.cancel}
- 음식: 음료 · 다과 · 식사 반입 가능. 건물이 교육환경보호구역 안에 있어 주류는 반입할 수 없음
- 소리: ${c.policy.noise}
- 주차: ${c.parking}
- 문의: 카카오톡 채널 ${c.contact.kakao} · 이메일 ${c.contact.inquiryEmail}

## 룸 5개

${ROOMS.map(room).join('\n')}

## 혼자 쓰는 자리

- [코워킹 · 스터디카페](${SITE}/coworking): 50석 자유석, 24시간, 예약 없이 현장 무인 키오스크 결제. ${p.map((x) => `${x.name} ${won(x.price)}원`).join(' · ')} (부가세 포함)
- [독립사무실](${SITE}/office): 1~3인 개별 사무실 4실, 월 단위, 개별 도어락 24시간 출입. ${o[0].name} 월 ${won(o[0].monthly)}원 · ${o.slice(1).map((x) => x.name).join(' · ')} 월 ${won(o[1].monthly)}원 (부가세 별도). 임대차가 아닌 공간 이용권이며 사업자등록 주소 · 우편 수령은 제공하지 않음

## 모임 종류별 안내

${USES.map((u) => `- [${u.name}](${SITE}/for/${u.slug})`).join('\n')}

## 주요 페이지

- [공간 안내](${SITE}/space): 룸 5개 비교표, 배치, 4층 평면도, 장비
- [이용 요금](${SITE}/pricing): 시간대별 요금표, 예상 금액 계산기, 취소 · 환불 기준
- [예약 신청](${SITE}/booking): 방 · 날짜 · 시간 선택
- [이용 안내 · 자주 묻는 질문](${SITE}/guide): 예약부터 퇴실까지, 이용 원칙, 오시는 길
- [주차 안내](${SITE}/parking)
- [모임 도구 · 게임](${SITE}/play): 타이머, 팀 나누기, 대화 카드 등 가입 없이 쓰는 진행 도구
- [매거진](${SITE}/magazine): 공간 고르는 법과 모임 진행 노하우 (RSS: ${SITE}/rss.xml)
- [커뮤니티](${SITE}/community): 소셜팩토리를 이용하는 모임 소개와 자유게시판
- [브랜드 스토리](${SITE}/story) · [대표 이야기](${SITE}/founder) · [지난 기록 2015–2021](${SITE}/history)

## 알아 둘 점

- 홍대 · 연남 · 신촌 · 합정 · 인천 지점은 2020~2021년에 운영을 종료했고, 지금 이용할 수 있는 곳은 소셜팩토리 건대입니다.
- ${data.stat.maxCap}명이 넘는 행사는 여러 룸을 나눠 쓰거나 같은 건물 2층의 대형 행사장 메가스팟(https://megaspot.kr, 최대 200명)을 이용합니다.
- 술을 곁들이는 파티는 패밀리 브랜드 쏘플파티룸(https://ssople.com) · 플레이션(https://playtion.kr)에서 합니다.
- 요금과 조건은 바뀔 수 있습니다. 가장 정확한 값은 위 페이지에 있습니다.
`;
}
