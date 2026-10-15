# 관리자: 사이드바 고정(PC) + 매출 "표로 보기" → 달력 보기

작성일: 2026-10-14. 조사 결과를 바탕으로 한 구현 계획. 서버 코드·DB 변경 없음(프론트 전용: `admin/index.html`, `admin/cms.css`, `admin/marketing.js`).

## 1. PC에서 사이드바가 스크롤해도 항상 보이게

### 현재 구조 (조사 결과)
- `admin/index.html:12-37` — `<div class="layout">` 안에 `<aside class="sidebar">`(로고 + `.sidebar-nav` 버튼 16개 + 구분선) 와 `<div class="main-wrap">`(header + main)이 나란히 있음.
- `admin/cms.css:29` — `.layout { display: flex; min-height: 100vh; }`. 사이드바는 `width:240px; flex-shrink:0; display:flex; flex-direction:column; padding:24px 0;` (`cms.css:32-39`). 문서 전체가 스크롤되므로 페이지가 길면 사이드바가 위로 사라짐.
- `admin/cms.css:103-111` — `@media (max-width: 900px)`에서 레이아웃이 세로로 바뀌고 사이드바가 가로 스크롤 탭 형태가 됨. **이 모바일 동작은 건드리지 않는다.**

### 변경
`admin/cms.css`의 `.sidebar` 규칙에 PC 전용으로 sticky를 추가한다 (기존 `.sidebar` 블록 바로 아래에 추가, 900px 이하 미디어쿼리에서 되돌림):

```css
/* PC: 스크롤해도 사이드바 전체가 보이도록 화면 높이에 고정 */
@media (min-width: 901px) {
  .sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;      /* 작은 세로 해상도에서 메뉴가 100vh를 넘으면 사이드바 안에서만 스크롤 */
    align-self: flex-start;
  }
}
```

- `position: sticky` + `top:0` + `height:100vh`: 부모 `.layout`이 flex 컨테이너이고 `.main-wrap`이 길어지면 `.layout` 높이도 함께 커지므로 sticky가 그 범위 안에서 정상 동작한다. `position: fixed` 를 쓰면 `.main-wrap`에 `margin-left:240px`를 따로 줘야 하므로 sticky 가 더 단순.
- `overflow-y:auto`는 메뉴 16개(약 44px × 16 + 로고 ≈ 800px)가 세로 해상도 768px 노트북에서 잘리는 경우를 위한 보험. 사이드바 내부 스크롤바가 어두운 배경에서 거슬리면 `scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent;` 를 함께 넣는다.
- `box-sizing`: `.sidebar`에 `padding: 24px 0`이 있으므로 `height:100vh`가 패딩을 포함하도록 전역 `box-sizing: border-box` 가 적용되어 있는지 `cms.css` 상단(1~20행)을 확인하고, 없으면 `.sidebar`에만 `box-sizing: border-box` 추가.
- `@media (max-width: 900px)` 블록(cms.css:103)은 그대로. `min-width:901px`로 범위를 나눴으므로 모바일에서는 sticky 가 적용되지 않는다. 안전을 위해 900px 블록 안에 `.sidebar { position: static; height: auto; overflow-y: visible; }` 한 줄을 명시적으로 넣어도 됨(선택).

### 검증
- 로컬 `npm start` → `/admin` 로그인(`dockAdmin`) → 결제 관리 또는 마케팅 섹션처럼 긴 페이지에서 1280×800 뷰포트로 맨 아래까지 스크롤한 스크린샷: 사이드바 로고와 "마케팅" 메뉴까지 모두 보여야 함.
- 1280×600 처럼 낮은 높이에서 사이드바 내부 스크롤이 동작하고 본문 스크롤과 분리되는지 확인.
- 800px 너비(모바일 레이아웃)에서 기존 가로 탭 형태가 유지되는지 확인.

## 2. 마케팅 "일별 추이" 카드의 "표로 보기" → 달력 보기

### 현재 구조 (조사 결과)
- 마크업 `admin/index.html:1224-1236`:
  ```html
  <div class="card" id="mkDailyCard">
    <h2>일별 추이</h2>
    <div id="mkDailyCounts" class="mk-chart"></div>
    <div id="mkDailyRevenue" class="mk-chart"></div>
    <details class="mk-details">
      <summary>표로 보기</summary>
      <div class="mk-table-wrap"><table>…<tbody id="mkDailyTable"></tbody></table></div>
    </details>
  </div>
  ```
- 렌더 `admin/marketing.js:663-673` `renderDaily(days)` — `days`는 `fillDaily()`(142행)가 기간 내 모든 날짜를 `{date:'YYYY-MM-DD', signups, approved, revenue}`로 채운 배열(최대 400일, 빈 날은 0). 테이블은 최신일부터 역순으로 `#mkDailyTable`에 행을 찍는다.
- `#mkDailyTable`은 `SUMMARY_TARGETS`(55행, 실패 시 `emptyRow(4,…)`)와 `renderDaily` 빈 데이터 분기(666행)에서도 참조된다.
- 헬퍼: `num()`, `won()`(원 단위 포맷), `parseYmd()`, `ymd()`, `escapeHtml()`가 같은 IIFE 안에 이미 있음. 차트 툴팁 로직(`.mk-hit` + `.mk-tip`, 640~660행)은 `#marketingSection` 전체에 mousemove 위임이라 달력 칸에도 `class="mk-hit" data-tip="…"` 를 주면 **같은 툴팁을 그대로 재사용**할 수 있다(단, 툴팁 위치 기준인 `.mk-chart-box` 래퍼와 그 안의 `.mk-tip` 요소가 필요).
- 매출 색 토큰: `SERIES.revenue.color = '#1baf7a'`(566행). 관리자 CSS 변수 `--green-dark`, `--grey-bg`, `--border`, `--text-soft` 등은 `cms.css :root`에 있음.

### 변경 내용

#### 2-1. 마크업 (`admin/index.html`)
`<details class="mk-details">` 블록을 통째로 아래로 교체한다. `<details>`/"표로 보기"는 없애고 달력을 **항상 펼쳐진 상태**로 차트 아래에 둔다(사용자 요구: "표가 아니고 달력으로").

```html
<h3 class="mk-h3" style="margin-top:16px;">매출 달력</h3>
<p class="field-hint" style="margin:0 0 8px;">날짜별 승인 매출(원)입니다. 칸 색이 진할수록 매출이 큽니다. 조회 기간 밖의 날은 흐리게 표시됩니다.</p>
<div id="mkDailyCalendar" class="mk-cal-wrap mk-chart-box"><div class="mk-tip" hidden></div></div>
```

`#mkDailyTable` id는 사라지므로 JS 참조 3곳(55행 `SUMMARY_TARGETS`, 666행, 671행)을 함께 정리한다(아래).

#### 2-2. 렌더 (`admin/marketing.js`)
`renderDaily(days)` 끝의 테이블 렌더를 `renderCalendar(days)` 호출로 바꾸고 새 함수를 추가한다.

```js
// 일별 매출 달력. days = fillDaily() 결과(기간 내 모든 날짜, 오름차순).
function renderCalendar(days) {
  const wrap = $('mkDailyCalendar');
  const tip = '<div class="mk-tip" hidden></div>';
  if (!days.length) { wrap.innerHTML = tip + '<p class="field-hint">데이터가 없습니다.</p>'; return; }
  const byDate = new Map(days.map(d => [d.date, d]));
  const maxRev = Math.max(0, ...days.map(d => d.revenue));
  const first = parseYmd(days[0].date), last = parseYmd(days[days.length - 1].date);
  const today = ymd(new Date());
  const months = [];
  for (let m = new Date(first.getFullYear(), first.getMonth(), 1); m <= last; m.setMonth(m.getMonth() + 1)) {
    months.push(new Date(m));
  }
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const html = months.map(m => {
    const y = m.getFullYear(), mo = m.getMonth();
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    const lead = new Date(y, mo, 1).getDay();
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<div class="mk-cal-cell mk-cal-empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const key = ymd(new Date(y, mo, d));
      const row = byDate.get(key);
      const dow = (lead + d - 1) % 7;
      if (!row) { cells += `<div class="mk-cal-cell mk-cal-out${dow === 0 ? ' mk-cal-sun' : dow === 6 ? ' mk-cal-sat' : ''}"><span class="mk-cal-day">${d}</span></div>`; continue; }
      const level = row.revenue <= 0 ? 0 : Math.max(1, Math.ceil((row.revenue / maxRev) * 4)); // 0~4 단계
      const tipText = `${key}\n매출 ${won(row.revenue)}\n승인 ${num(row.approved)}건 · 가입 ${num(row.signups)}명`;
      cells += `<div class="mk-cal-cell mk-hit mk-cal-l${level}${key === today ? ' mk-cal-today' : ''}${dow === 0 ? ' mk-cal-sun' : dow === 6 ? ' mk-cal-sat' : ''}" data-tip="${escapeHtml(tipText)}">
        <span class="mk-cal-day">${d}</span>
        <span class="mk-cal-rev">${row.revenue > 0 ? wonShort(row.revenue) : ''}</span>
        ${row.approved > 0 ? `<span class="mk-cal-cnt">${num(row.approved)}건</span>` : ''}
      </div>`;
    }
    const monthTotal = days.filter(x => x.date.startsWith(`${y}-${String(mo + 1).padStart(2, '0')}`)).reduce((s, x) => s + x.revenue, 0);
    return `<section class="mk-cal-month">
      <div class="mk-cal-month-head"><b>${y}년 ${mo + 1}월</b><span class="mk-cal-month-total">월 매출 ${won(monthTotal)}</span></div>
      <div class="mk-cal-grid">${DOW.map((n, i) => `<div class="mk-cal-dow${i === 0 ? ' mk-cal-sun' : i === 6 ? ' mk-cal-sat' : ''}">${n}</div>`).join('')}${cells}</div>
    </section>`;
  }).join('');
  wrap.innerHTML = tip + `<div class="mk-cal-months">${html}</div>`;
}

// 칸 안에 들어갈 짧은 금액: 1,250,000 → "125만", 3,200 → "3.2천", 12,000,000 → "1,200만"
function wonShort(v) {
  v = Number(v) || 0;
  if (v >= 10000) { const man = v / 10000; return (man >= 100 ? Math.round(man).toLocaleString('ko-KR') : (Math.round(man * 10) / 10).toLocaleString('ko-KR')) + '만'; }
  if (v >= 1000) return (Math.round(v / 100) / 10) + '천';
  return v.toLocaleString('ko-KR');
}
```

- 구현 에이전트는 `parseYmd`/`ymd`의 실제 시그니처(타임존 처리)를 확인해 로컬 Date 기준으로 맞춘다. `fillDaily`가 같은 헬퍼로 키를 만들므로 `ymd(new Date(y, mo, d))`와 `days[].date`가 일치해야 함.
- 테이블 참조 정리:
  - 55행 `SUMMARY_TARGETS`에서 `['mkDailyTable', 4]` 제거. 대신 `loadSummary` catch 분기에서 `$('mkDailyCalendar').innerHTML = '<p class="mk-error">불러오지 못했습니다.</p>'` 한 줄 추가.
  - 666행 빈 데이터 분기: `renderCalendar([])` 호출로 교체.
  - 671~672행 테이블 렌더 → `renderCalendar(days)`.
- 560~562행 주석("표로 보기 테이블을 함께 제공(relief rule)")을 "매출 달력을 함께 제공"으로 갱신.
- 시안(demo) 모드는 유입·전환 카드(`loadAttribution`)에만 적용되고 `summary.daily`에는 없으므로 달력은 영향 없음.

#### 2-3. 스타일 (`admin/cms.css`, 마케팅 블록 `.mk-details` 근처에 추가)

```css
/* 매출 달력 */
.mk-cal-wrap { position: relative; }
.mk-cal-months { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
.mk-cal-month-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; font-size: 13px; }
.mk-cal-month-total { color: var(--text-soft); font-size: 12px; font-variant-numeric: tabular-nums; }
.mk-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
.mk-cal-dow { text-align: center; font-size: 11px; font-weight: 700; color: var(--text-soft); padding: 2px 0; }
.mk-cal-cell { min-height: 52px; border-radius: 6px; border: 1px solid var(--border); background: var(--white); padding: 4px 5px; display: flex; flex-direction: column; gap: 1px; font-variant-numeric: tabular-nums; cursor: default; }
.mk-cal-empty { border: none; background: transparent; }
.mk-cal-out { opacity: .35; }
.mk-cal-day { font-size: 11px; font-weight: 700; color: var(--text-soft); }
.mk-cal-rev { font-size: 12px; font-weight: 800; color: var(--text); margin-top: auto; }
.mk-cal-cnt { font-size: 10.5px; color: var(--text-soft); }
.mk-cal-sun .mk-cal-day { color: #c0392b; }
.mk-cal-sat .mk-cal-day { color: #2a78d6; }
.mk-cal-today { box-shadow: inset 0 0 0 2px var(--green-dark); }
/* 매출 단계: SERIES.revenue(#1baf7a) 기반 순차 농도. 글자는 항상 텍스트 토큰(대비 유지) */
.mk-cal-l1 { background: #e6f7ef; }
.mk-cal-l2 { background: #c4ecd9; }
.mk-cal-l3 { background: #9ddfbf; }
.mk-cal-l4 { background: #6fcfa2; }
.mk-cal-l4 .mk-cal-day, .mk-cal-l4 .mk-cal-cnt { color: #1f3b2e; }
@media (max-width: 600px) {
  .mk-cal-months { grid-template-columns: 1fr; }
  .mk-cal-cell { min-height: 44px; padding: 3px 4px; }
  .mk-cal-rev { font-size: 11px; }
}
```

- 농도 4단계는 `niceMax` 대신 기간 최대 매출 대비 비율. 하루라도 매출이 있으면 최소 1단계라 "0원"과 구분된다.
- 90일 조회 시 3~4개월 그리드가 `auto-fill minmax(300px)`로 PC에서 2~3열, 모바일에서 1열. 400일(최대)이면 14개 월 섹션이 쌓이지만 카드가 `main` 안에서 자연 스크롤되므로 문제 없음.
- 툴팁: 칸에 `.mk-hit` + `data-tip`을 주고 `#mkDailyCalendar`에 `.mk-chart-box`를 붙여 두면 기존 마우스 위임 코드(640~660행)가 그대로 동작. `.mk-chart-box`에 다른 스타일(높이 고정 등)이 걸려 있으면 `.mk-cal-wrap`에서 덮어쓴다 — 구현 시 `cms.css`에서 `.mk-chart-box` 규칙을 확인할 것.

### 검증
- 로컬 `/admin` → 마케팅 → 30일 조회: 차트 아래 "매출 달력"이 1~2개월 그리드로 보이고, 매출 있는 날은 금액(`125만` 형식)·승인 건수·녹색 농도, 매출 없는 날은 흰 칸, 기간 밖 날은 흐림. 오늘 칸 테두리 강조.
- 칸 위에 마우스를 올리면 날짜·매출·승인·가입 툴팁이 뜨는지.
- 90일 조회: 월 섹션 3~4개, 월 합계가 각 섹션 머리에 표시. 월 합계의 합 = KPI 카드 "매출"과 일치하는지 숫자로 확인.
- 날짜 역전(시작>종료) 오류·API 실패 시 달력 영역에 오류 문구가 뜨고 콘솔 에러가 없는지(`mkDailyTable` 참조가 모두 제거됐는지 `grep`으로 확인).
- 600px 폭에서 1열로 떨어지는지.

## 3. 역할 분담
- 구현(Opus 1명): 1·2 전부. 두 작업은 파일이 겹치지만(`cms.css`) 규모가 작아 한 에이전트가 순서대로 처리.
- 검증(구현과 다른 Opus 1명): 로컬 서버를 띄워 위 검증 항목을 스크린샷(1280px, 2x)과 `grep` 결과로 증빙. 실서버 배포·git push 없음.
