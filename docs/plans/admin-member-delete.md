# 관리자 회원 삭제 기능 — 구현 계획

- 작성일: 2026-10-09
- 요청: "관리자 사이트에서 회원삭제도 가능하게 해줘"
- 참고 커밋: `90e9a17 관리자: 회원 상세에서 등록 기기 조회·삭제 지원` (같은 패턴: `server.js` 관리자 라우트 + `admin/members.js` + `admin/index.html` 회원 상세 모달)
- **스키마 변경 없음** (DDL·마이그레이션 불필요, 운영 DB 수동 적용 항목 없음)

---

## 1. 조사 결과 요약

### 1.1 members를 참조하는 테이블 (운영 DB `information_schema`로 실제 확인, schema.sql과 일치)

| 테이블 | FK | ON DELETE | 비고 |
|---|---|---|---|
| `member_devices` | fk_member_devices_member | CASCADE | `session_id`(웹 세션 ID), `token_id`(api_tokens.id) 보관 |
| `api_tokens` | fk_api_tokens_member | CASCADE | 앱 Bearer 토큰(SHA-256 해시) |
| `member_class_enrollments` | fk_enrollment_member | CASCADE | |
| `member_vod_enrollments` | fk_vod_enrollment_member | CASCADE | 재생 권한의 근거 |
| `member_lecture_progress` | fk_mlp_member | CASCADE | 진도 기록 |
| `vod_course_questions` | fk_vcq_member | CASCADE | 강좌 Q&A 게시글 |
| **`payments`** | fk_payment_member | **CASCADE** | **회원 하드 삭제 시 결제 기록까지 같이 사라짐** |
| `coupons` | fk_coupon_member | SET NULL | 하드 삭제 시 `status='등록됨'`인데 `member_id=NULL`인 고아 쿠폰이 생김 |

- 그 외 `member_id` 컬럼을 가진 테이블 없음(`reviews`, `cert_posts`는 자유 텍스트 작성자, FK 없음).
- 운영 DB 현황(2026-10-09 조회): members 1,879명(`member_group` '1000' 1,773 / '1001' 106, NULL 없음), payments approved 44건(34명), expired 98건(36명), failed 2건. DB는 MariaDB 10.11.
- `members` 컬럼: id, username(UNIQUE), password(NULL 허용), name, birth_date, member_group VARCHAR(50), phone, mobile, email, signup_channel, search_keyword, referrer_code, email/sms_marketing_consent, joined_at, general_notes, consultation_notes, created_at, reset_token, reset_token_expires, postal_code, road_address, detail_address.

### 1.2 인증/세션

- `requireAdminApi` (`server.js:126`) — `req.session.isAdmin` 확인. 신규 관리자 라우트에 그대로 사용.
- 웹 회원 세션: `app.use(session({...}))` (`server.js:96-101`) — `store` 미지정 = express-session 기본 **MemoryStore**(v1.19.0). `requireMember`(`server.js:131`)는 `req.session.memberId` 존재만 본다 → **회원을 지워도 기존 세션은 만료(최대 12시간/로그인 유지 시 더 김)까지 살아 있음**. 해당 세션으로 `/api/payments/init` 등을 호출하면 FK 오류나 고아 데이터가 생길 수 있으므로 삭제 시 세션도 즉시 파기해야 한다.
- MemoryStore는 `all(cb)`(sid → session 맵)과 `destroy(sid, cb)`를 제공(`node_modules/express-session/session/memory.js:58`). PM2 fork 단일 프로세스 전제(현재도 MemoryStore라 클러스터면 로그인이 이미 깨졌을 것이므로 단일 프로세스로 판단).
- 앱 토큰: `requireApiToken`(`server.js:142`)이 매 요청 `api_tokens`를 조회 → 행을 지우면 즉시 401. 추가 작업 불필요.
- 로그인(`/api/members/login` `server.js:2212`, `/api/v1/auth/login` `server.js:2322`)은 `!member.password`면 거부, 비밀번호 찾기(`server.js:2238`)는 username으로 조회 → username을 바꾸고 password를 NULL로 하면 로그인·재설정 모두 차단된다.

### 1.3 관리자 회원 UI

- 목록: `admin/index.html:1139-1160` (`#memberSection`, `#memberSearch`, `#memberList`), 로직 `admin/members.js:7-59` (`loadMembers()`, 15건/페이지).
- 상세 모달: `admin/index.html:1237-1254` (`#memberDetailModalOverlay`, `#memberDetailBody`, 등록 기기 `#memberDeviceList`/`#memberDeviceStatus`), 로직 `admin/members.js:61-147` (`openMemberDetailModal()`, `loadMemberDevices()`, `detailMemberId`).
- 공용 헬퍼: `apiFetch()`, `setStatus()` (`admin/cms.js:18-32`), `escapeHtml()`. CSS: `.row-btn.danger`, `.badge-off`, `.badge-new` (`admin/cms.css`).
- 쿠폰 "학생 지정 발급" 회원 검색도 `/admin/api/members?search=`를 재사용(`admin/coupons.js:114`).

---

## 2. 핵심 결정 — 권장안: "결제 이력 유무에 따른 하이브리드"

| 조건 | 처리 | 이유 |
|---|---|---|
| `payments` 행이 **0건** | **하드 삭제** (`DELETE FROM members`) | 보존 의무 대상 기록이 없음. 개인정보 완전 파기가 원칙에 가장 부합 |
| `payments` 행이 **1건 이상** (상태 무관) | **익명화(소프트 삭제)** — 회원 행은 남기고 개인정보 제거 + 로그인 불가 처리 | `payments.member_id`가 `ON DELETE CASCADE`라 하드 삭제하면 결제 기록이 같이 사라짐 → 전자상거래법(대금결제·재화공급 기록 5년 보존) 위반. FK를 바꾸는 스키마 변경 없이 기록을 지킬 수 있음 |
| `status='pending'` 결제가 있음 | **삭제 거부(409)** | 결제창 진행 중. pending은 30분 후 `expireStalePendingPayments()`가 expired로 내리므로 그 뒤 다시 시도하면 됨 |

- expired/failed만 있는 회원도 익명화로 보낸다: expired는 "뒤늦은 승인 콜백/수동승인이 그대로 통하는" 상태(`schema.sql` 주석)라 PG 실결제와 어긋날 여지가 있고, 규칙을 "결제 행 존재 여부" 하나로 단순화하는 편이 안전하다.
- **왜 전면 소프트 삭제가 아닌가**: 결제 이력 없는 회원(대다수, 1,879명 중 약 1,800명)까지 행을 남길 이유가 없고, 개인정보는 목적 달성 시 파기가 원칙.
- **왜 `deleted_at` 컬럼을 추가하지 않는가**: 탈퇴 표식은 기존 `member_group VARCHAR(50)`에 `'withdrawn'` 값을 넣는 것으로 충분(현재 값은 '1000'/'1001'뿐이고 로직상 '1001' 여부만 판별). 운영 DB 수동 마이그레이션이 필요 없어 배포가 단순.

### 2.1 익명화 시 남기는 것 / 지우는 것

- **남김**: `id`, `name`(결제 기록의 거래 당사자 식별), `joined_at`, `created_at`, 그리고 `general_notes`를 아래 보존 메모로 **덮어씀**:
  `[탈퇴처리 2026-10-09 14:03 관리자] 결제기록 보존(전자상거래법 5년). 원 아이디: foo@bar.com`
  (원 아이디는 결제 분쟁/환불 문의 시 당사자 확인용 최소 식별자)
- **변경**: `username` → `withdrawn_<id>_<unix초>` (예: `withdrawn_1532_1791523380`). 이메일 형식이 아니므로 `USERNAME_RE` 때문에 누구도 이 값으로 가입 불가, 원래 아이디는 UNIQUE에서 풀려 **재가입 가능**. `member_group` → `'withdrawn'`.
- **NULL 처리**: password, birth_date, phone, mobile, email, postal_code, road_address, detail_address, signup_channel, search_keyword, referrer_code, email_marketing_consent, sms_marketing_consent, consultation_notes, reset_token, reset_token_expires.
- 5년 경과 후 최종 파기(익명화 회원 하드 삭제 배치)는 **이번 범위 밖** — 후속 과제로 문서 말미에 기록.

### 2.2 연관 데이터 처리 (두 경로 공통)

| 데이터 | 처리 | 이유 |
|---|---|---|
| api_tokens | DELETE | 앱 토큰 즉시 무효화 |
| member_devices | DELETE | |
| member_lecture_progress | DELETE | |
| member_vod_enrollments / member_class_enrollments | DELETE | 수강 권한 회수(결제 근거는 payments에 남음) |
| vod_course_questions | DELETE | 탈퇴자 게시글 정리(하드 삭제 CASCADE와 동작 통일) |
| coupons `status='등록됨'`(미사용) | `status='미등록', member_id=NULL, claimed_at=NULL` 로 되돌림 | 하드 삭제 시 SET NULL로 "주인 없는 등록됨" 고아가 생기는 것을 방지. 같은 사람이 재가입하면 같은 코드로 다시 등록 가능, 관리자는 쿠폰관리에서 삭제도 가능 |
| coupons `status='사용완료'` | 그대로 | payments에 묶인 기록. 사용완료 쿠폰은 결제 행이 있으므로 항상 익명화 경로 → member_id 유지 |
| payments | 익명화 경로에서는 그대로 | 법정 보존 |
| 웹 세션 | 커밋 후 MemoryStore에서 해당 memberId 세션 전부 destroy | 즉시 로그아웃 |

하드 삭제 경로에서도 CASCADE에 기대지 않고 자식 행을 **명시적으로** 지운 뒤 members를 지운다(의도 명확화, 향후 FK 변경에도 안전).

---

## 3. 서버 구현 (`server.js`)

### 3.1 세션 스토어를 변수로 노출 (`server.js:96-101`)

```js
const sessionStore = new session.MemoryStore();
app.use(session({
  store: sessionStore,
  secret: ...,  // 기존 그대로
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 12 }
}));
```
동작은 기존 기본값과 동일(기본값도 MemoryStore). 바로 아래에 헬퍼 추가:

```js
// 관리자가 회원을 삭제/탈퇴 처리했을 때 그 회원의 웹 로그인 세션을 즉시 끊는다.
// requireMember는 session.memberId 존재만 보므로, 이걸 안 하면 쿠키 만료까지 로그인 상태가 유지된다.
function destroyMemberSessions(memberId) {
  return new Promise((resolve) => {
    sessionStore.all((err, sessions) => {
      if (err || !sessions) { resolve(0); return; }
      const sids = Object.keys(sessions).filter(sid => String(sessions[sid].memberId) === String(memberId));
      let pending = sids.length;
      if (!pending) { resolve(0); return; }
      sids.forEach(sid => sessionStore.destroy(sid, () => { if (--pending === 0) resolve(sids.length); }));
    });
  });
}
```
(관리자 세션은 `isAdmin`만 있고 memberId가 없으므로 영향 없음. 같은 브라우저에서 관리자+회원이 동시 로그인된 세션이면 관리자 세션도 같이 끊기는데, 실제로는 같은 쿠키를 공유하므로 감수 — 테스트 시 관리자/회원 쿠키를 분리할 것.)

### 3.2 상수

`server.js` 상단 상수 영역(예: `ADMIN_PASSWORD` 근처 `server.js:18`)에:
```js
const WITHDRAWN_MEMBER_GROUP = 'withdrawn'; // 결제기록 보존 때문에 행을 남긴 탈퇴(익명화) 회원 표식
```

### 3.3 공용 요약 헬퍼 — 기기 삭제 라우트(`server.js:1307-1325`) 바로 아래에 추가

```js
// 회원 삭제 미리보기/실행이 공유하는 집계. conn을 받는 이유: 실행 시에는 트랜잭션 안에서 FOR UPDATE로 잠근 뒤 같은 값을 다시 계산한다.
async function getMemberDeletionSummary(conn, memberId, { lock = false } = {}) {
  const forUpdate = lock ? ' FOR UPDATE' : '';
  const [[member]] = await conn.query(
    `SELECT id, username, name, member_group FROM members WHERE id = ?${forUpdate}`, [memberId]);
  if (!member) return null;
  const [payRows] = await conn.query(
    `SELECT status, COUNT(*) AS cnt FROM payments WHERE member_id = ? GROUP BY status${forUpdate}`, [memberId]);
  const pay = Object.fromEntries(payRows.map(r => [r.status, Number(r.cnt)]));
  const count = async (sql) => Number((await conn.query(sql, [memberId]))[0][0].cnt);
  const totalPayments = payRows.reduce((s, r) => s + Number(r.cnt), 0);
  return {
    member,
    withdrawn: member.member_group === WITHDRAWN_MEMBER_GROUP,
    mode: totalPayments > 0 ? 'anonymize' : 'delete',
    blockedReason: (pay.pending || 0) > 0 ? '결제 진행 중(pending)인 주문이 있어 지금은 삭제할 수 없습니다. 30분 후 다시 시도해주세요.' : null,
    counts: {
      approvedPayments: pay.approved || 0,
      canceledPayments: pay.canceled || 0,
      otherPayments: (pay.failed || 0) + (pay.expired || 0),
      pendingPayments: pay.pending || 0,
      vodEnrollments: await count('SELECT COUNT(*) AS cnt FROM member_vod_enrollments WHERE member_id = ?'),
      classEnrollments: await count('SELECT COUNT(*) AS cnt FROM member_class_enrollments WHERE member_id = ?'),
      devices: await count('SELECT COUNT(*) AS cnt FROM member_devices WHERE member_id = ?'),
      questions: await count('SELECT COUNT(*) AS cnt FROM vod_course_questions WHERE member_id = ?'),
      claimedCoupons: await count("SELECT COUNT(*) AS cnt FROM coupons WHERE member_id = ? AND status = '등록됨'")
    }
  };
}
```
(MariaDB에서 `GROUP BY ... FOR UPDATE` 허용됨. 문제 시 `SELECT id, status FROM payments WHERE member_id = ? FOR UPDATE`로 행을 받아 JS에서 집계해도 됨.)

### 3.4 `GET /admin/api/members/:id/delete-preview`

```js
app.get('/admin/api/members/:id/delete-preview', requireAdminApi, wrapAsync(async (req, res) => {
  const s = await getMemberDeletionSummary(getPool(), req.params.id);
  if (!s) { res.status(404).json({ error: '회원을 찾을 수 없습니다.' }); return; }
  res.json({ username: s.member.username, name: s.member.name, withdrawn: s.withdrawn,
             mode: s.mode, blockedReason: s.blockedReason, counts: s.counts });
}));
```

### 3.5 `DELETE /admin/api/members/:id`

요청 body: `{ "confirmUsername": "<회원 아이디>" }` (UI에서 아이디 재입력값).

처리 순서 (`server.js:1830-1868` 쿠폰 발급의 `getConnection()/beginTransaction()/commit/rollback/release` 패턴 그대로):

1. `conn = await getPool().getConnection(); await conn.beginTransaction();`
2. `s = await getMemberDeletionSummary(conn, id, { lock: true })`
   - 없으면 rollback → **404** `회원을 찾을 수 없습니다.`
   - `s.withdrawn` → rollback → **409** `이미 탈퇴 처리된 회원입니다.`
   - `String(req.body.confirmUsername || '').trim() !== s.member.username` → rollback → **400** `아이디가 일치하지 않습니다.`
   - `s.blockedReason` → rollback → **409** `s.blockedReason`
3. 쿠폰 반환:
   `UPDATE coupons SET status = '미등록', member_id = NULL, claimed_at = NULL WHERE member_id = ? AND status = '등록됨'`
4. 자식 행 삭제(순서대로):
   `DELETE FROM api_tokens WHERE member_id = ?` →
   `DELETE FROM member_devices WHERE member_id = ?` →
   `DELETE FROM member_lecture_progress WHERE member_id = ?` →
   `DELETE FROM member_vod_enrollments WHERE member_id = ?` →
   `DELETE FROM member_class_enrollments WHERE member_id = ?` →
   `DELETE FROM vod_course_questions WHERE member_id = ?`
5. 분기
   - `s.mode === 'delete'`: `DELETE FROM members WHERE id = ?`
   - `s.mode === 'anonymize'`:
     ```sql
     UPDATE members SET
       username = ?,               -- `withdrawn_${id}_${Math.floor(Date.now()/1000)}`
       password = NULL, birth_date = NULL, phone = NULL, mobile = NULL, email = NULL,
       postal_code = NULL, road_address = NULL, detail_address = NULL,
       signup_channel = NULL, search_keyword = NULL, referrer_code = NULL,
       email_marketing_consent = NULL, sms_marketing_consent = NULL,
       consultation_notes = NULL, reset_token = NULL, reset_token_expires = NULL,
       general_notes = ?,          -- `[탈퇴처리 ${KST yyyy-mm-dd HH:MM} 관리자] 결제기록 보존(전자상거래법 5년). 원 아이디: ${원 username}`
       member_group = ?            -- WITHDRAWN_MEMBER_GROUP
     WHERE id = ?
     ```
6. `await conn.commit()` — 예외 시 `rollback` 후 throw, `finally`에서 `conn.release()`.
7. 커밋 **후** `const killed = await destroyMemberSessions(id);` (트랜잭션 롤백 시 세션을 끊지 않기 위해 커밋 뒤에 실행)
8. 감사 로그: `console.log('[admin] member ${mode} id=${id} username=${원username} sessions=${killed} ip=${req.ip}')`
9. 응답 `{ ok: true, mode: s.mode, counts: s.counts }`

### 3.6 회원 목록에서 탈퇴 회원 기본 제외 (`server.js:1249-1271`)

현재 `where` 문자열을 조건 배열로 재구성:
```js
const includeWithdrawn = req.query.includeWithdrawn === '1';
const conditions = [];
const params = [];
if (!includeWithdrawn) { conditions.push('(member_group IS NULL OR member_group <> ?)'); params.push(WITHDRAWN_MEMBER_GROUP); }
if (search) { conditions.push('(username LIKE ? OR name LIKE ? OR email LIKE ? OR phone LIKE ? OR mobile LIKE ?)'); params.push(...Array(5).fill(`%${search}%`)); }
const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
```
**검색 OR 조건을 반드시 괄호로 감쌀 것**(안 감싸면 AND 우선순위로 제외 조건이 깨짐). COUNT/SELECT 두 쿼리 모두 `params` 사용.
→ 쿠폰 "학생 지정 발급" 검색(`admin/coupons.js:114`)도 자동으로 탈퇴 회원 제외.

### 3.7 쿠폰 학생 지정 발급 방어 (`server.js:1832-1835`)

`SELECT id, name, username FROM members WHERE id IN (...)` 에 `AND (member_group IS NULL OR member_group <> ?)` 추가(파라미터 끝에 `WITHDRAWN_MEMBER_GROUP`). 탈퇴 회원이 섞이면 기존 "존재하지 않는 회원이 포함되어 있습니다." 400으로 떨어짐.

(관리자 수강 등록 POST 라우트 등 나머지는 UI에서 탈퇴 회원 버튼을 숨기는 것으로 충분 — 서버 가드는 이번 범위에서 생략.)

---

## 4. 관리자 UI 구현

### 4.1 `admin/index.html`

**(a) 목록 검색줄** (`admin/index.html:1144-1147`)의 검색 버튼 뒤에 추가:
```html
<label style="display:flex; align-items:center; gap:4px; white-space:nowrap; font-size:13px;">
  <input type="checkbox" id="memberIncludeWithdrawn"> 탈퇴 회원 포함
</label>
```

**(b) 회원 상세 모달** — `#memberDeviceStatus`(`admin/index.html:1252`) 바로 아래, `</div>`(modal-box 닫힘) 전에 추가:
```html
<div id="memberDeleteSection">
  <h3 style="margin:28px 0 6px; color:var(--danger);">회원 삭제</h3>
  <p class="field-hint" style="margin-bottom:10px;">
    결제 이력이 없는 회원은 완전히 삭제됩니다. 결제 이력이 있으면 결제기록 보존(전자상거래법 5년)을 위해
    이름·결제내역만 남기고 개인정보를 지운 뒤 탈퇴 처리합니다. 어느 경우든 수강 등록·진도·기기·Q&A가 삭제되고
    즉시 로그아웃되며, 같은 아이디로 재가입할 수 있습니다. 되돌릴 수 없습니다.
  </p>
  <button class="row-btn danger" id="memberDeleteBtn" type="button">회원 삭제…</button>
  <div id="memberDeletePanel" style="display:none; margin-top:12px; padding:12px; border:1px solid var(--danger); border-radius:8px;">
    <div id="memberDeleteSummary" style="font-size:13px; line-height:1.6;"></div>
    <div style="display:flex; gap:8px; margin-top:10px;">
      <input type="text" id="memberDeleteConfirmInput" placeholder="확인을 위해 회원 아이디를 입력하세요" style="flex:1;" autocomplete="off">
      <button class="row-btn danger" id="memberDeleteConfirmBtn" type="button" disabled>삭제 실행</button>
      <button class="row-btn" id="memberDeleteCancelBtn" type="button">취소</button>
    </div>
  </div>
  <div class="status-text" id="memberDeleteStatus"></div>
</div>
<p id="memberWithdrawnNotice" class="field-hint" style="display:none; margin-top:20px;">
  탈퇴(익명화) 처리된 회원입니다. 결제기록 보존 목적으로만 남아 있습니다.
</p>
```

### 4.2 `admin/members.js`

**(a) `loadMembers()`** (`:7-32`)
- `params`에 `if (document.getElementById('memberIncludeWithdrawn').checked) params.set('includeWithdrawn', '1');`
- 구분 배지: `m.member_group === 'withdrawn'`이면 `<span class="badge badge-off">탈퇴</span>`, 아니면 기존 신규/기존.
- 탈퇴 회원 행은 "강좌 관리" 버튼 대신 `-` 표시(상세는 열람 가능).
- 체크박스 `change` 이벤트 → `memberPage = 1; loadMembers();` (`:48` 부근 리스너들 옆에 추가).

**(b) `openMemberDetailModal()`** (`:118-140`)
- 열 때 초기화: `#memberDeletePanel` 숨김, `#memberDeleteConfirmInput` 비움, `#memberDeleteConfirmBtn.disabled = true`, `setStatus(#memberDeleteStatus, '')`.
- 회원 정보를 받은 뒤 `m.member_group === 'withdrawn'`이면 `#memberDeleteSection` 숨김 + `#memberWithdrawnNotice` 표시, 아니면 반대. 로딩 실패 시 삭제 섹션 숨김.
- 상세 표의 `member_group` 표시값: `'withdrawn'` → `탈퇴(익명화)`.

**(c) 신규 핸들러** (`:147` 모달 닫기 리스너 뒤)
- `let deletePreview = null;`
- `#memberDeleteBtn` click → `deletePreview = await apiFetch(`/admin/api/members/${detailMemberId}/delete-preview`)` →
  `#memberDeleteSummary` 렌더(모두 `escapeHtml`):
  - 대상: `이름 (아이디)`
  - 처리 방식: `mode === 'delete'` → "**완전 삭제** (결제 이력 없음)" / `'anonymize'` → "**탈퇴 처리(익명화)** — 결제 N건(승인 a·취소 b·기타 c) 기록 보존"
  - 함께 삭제: VOD 수강 n개, 클래스 수강 n개, 등록 기기 n대, Q&A n건, 미사용 등록 쿠폰 n장(미등록으로 반환)
  - 승인 결제가 있고 VOD 수강이 있으면 경고 문구: "환불 여부를 먼저 결제관리에서 확인하세요."
  - `blockedReason`이 있으면 그 문구를 빨간색으로 표시하고 입력/실행 버튼 비활성 유지.
  - 패널 표시, 입력란 focus.
- `#memberDeleteConfirmInput` input → `confirmBtn.disabled = !(deletePreview && !deletePreview.blockedReason && input.value.trim() === deletePreview.username)`.
- `#memberDeleteCancelBtn` → 패널 숨김.
- `#memberDeleteConfirmBtn` click →
  ```js
  const r = await apiFetch(`/admin/api/members/${detailMemberId}`, {
    method: 'DELETE', body: JSON.stringify({ confirmUsername: input.value.trim() })
  });
  ```
  성공: 모달 닫기 → `alert(r.mode === 'delete' ? '회원이 삭제되었습니다.' : '탈퇴 처리되었습니다. (결제기록 보존)')` → `loadMembers()` (현재 페이지가 비면 `memberPage`를 한 칸 줄여 재조회).
  실패: `setStatus(#memberDeleteStatus, err.message, 'error')`, 버튼 재활성. 요청 중에는 버튼 disabled로 중복 클릭 방지.

---

## 5. 변경하지 않는 것 / 범위 밖

- `infra/schema.sql`, 운영 DB — **변경 없음**(마이그레이션 없음).
- 회원 본인 탈퇴(마이페이지) 기능 — 요청 범위 밖. 추후 같은 트랜잭션 로직을 함수(`withdrawMember(conn, memberId)`)로 빼서 재사용 가능하도록, 구현 시 3.5의 3~5단계를 별도 async 함수로 분리해두면 좋음(필수 아님).
- 익명화 회원의 5년 경과 후 최종 파기 배치 — 후속 과제(마지막 결제일 + 5년 경과 시 payments·members 삭제).
- `public/`(v1) 사이트 — 무관.

---

## 6. 검증 계획 (구현 에이전트와 **다른** 에이전트가 수행, 증거 제출)

> 로컬 `.env`가 **운영 DB에 직결**되어 있다. 테스트는 아래 접두사의 테스트 데이터만 만들고, 끝나면 반드시 정리한다. 실회원 데이터에는 어떤 쓰기도 하지 않는다. 가입 API(`/api/members/signup`)는 SES로 실메일을 보내므로 쓰지 말고, 테스트 회원은 스크립트로 직접 INSERT 한다.

### 6.1 준비

- 서버: `PORT=5090 npm start` (운영 3000과 겹치지 않게; 로컬 서버도 pending 만료 스윕 등 기존 주기작업이 운영 DB에 도는 건 평소와 동일).
- 테스트 데이터 식별자(스크래치 스크립트, 프로젝트 밖 scratchpad에 작성):
  - 회원 username: `deltest+<번호>-<ts>@dockteacher.test`, name `삭제테스트<번호>`, member_group `'1001'`, password = `bcryptjs.hash('Test1234!', 10)`
  - 결제: `order_number = 'DELTEST-<ts>-<번호>'`, `amount = 0`(매출 통계 오염 방지), `item_name = '삭제테스트'`, `vod_course_id` = 기존 아무 강좌 id
  - 쿠폰: `code = 'ZZDELTEST' + 7자리`(16자), `status='등록됨'`
  - 생성한 member id 목록을 scratchpad JSON에 기록(익명화 후 username이 바뀌므로 id로 추적)

| 회원 | 구성 |
|---|---|
| A (하드 삭제) | VOD 수강 1, 기기는 로그인으로 생성, 등록됨 쿠폰 1, Q&A 1 |
| B (익명화) | approved 결제 1(DELTEST), VOD 수강 1 |
| C (차단) | pending 결제 1(DELTEST) |

### 6.2 시나리오 및 기대 결과

1. **세션/토큰 준비**: A·B로 `POST /api/members/login`(deviceId 지정, 쿠키 저장) 및 `POST /api/v1/auth/login`(platform electron) → `GET /api/members/my-info` 200, `GET /api/v1/me` 200 확인.
2. **권한**: 관리자 쿠키 없이 `DELETE /admin/api/members/<A>` → 401.
3. **미리보기**: `GET .../<A>/delete-preview` → `mode:"delete"`, counts 일치. `<B>` → `mode:"anonymize"`, approvedPayments 1. `<C>` → `blockedReason` 존재.
4. **입력 불일치**: `DELETE .../<A>` body `confirmUsername:"wrong"` → 400, DB 변화 없음.
5. **차단**: `DELETE .../<C>` → 409, DB 변화 없음.
6. **A 하드 삭제** → 200 `mode:"delete"`. DB: `members` 행 없음; api_tokens/member_devices/member_vod_enrollments/member_lecture_progress/vod_course_questions의 member_id=A 행 0; 테스트 쿠폰 `status='미등록', member_id NULL, claimed_at NULL`. A의 기존 쿠키로 `/api/members/my-info` → 401, A 토큰으로 `/api/v1/me` → 401. `POST /api/members/check-username` 원 아이디 → `available:true`.
7. **B 익명화** → 200 `mode:"anonymize"`. DB: members 행 존재, `username LIKE 'withdrawn_<B>_%'`, `member_group='withdrawn'`, password/email/phone/mobile/주소/birth_date NULL, name 유지, general_notes에 원 아이디 포함; payments DELTEST 행 그대로; 수강·기기·토큰 0. 세션/토큰 401. 원 아이디·비밀번호로 로그인 → 401. check-username 원 아이디 → available true. `GET /admin/api/payments?search=DELTEST` → member_name '삭제테스트2'로 조회됨.
8. **재삭제**: `DELETE .../<B>` → 409 `이미 탈퇴 처리된 회원입니다.`
9. **목록**: `GET /admin/api/members?search=삭제테스트` → B 미포함, `&includeWithdrawn=1` → B 포함(member_group withdrawn). 검색어 없이 기본 목록 total = (전체 - withdrawn 수) 확인.
10. **UI(Playwright, 뷰포트 1280, deviceScaleFactor 2)**: 관리자 로그인 → 회원목록에서 테스트 회원 상세 → "회원 삭제…" 클릭 → 요약 패널 스크린샷 → 아이디 틀리게 입력 시 버튼 비활성, 정확히 입력 시 활성 스크린샷 → 실행 후 모달 닫힘·목록 갱신 스크린샷. "탈퇴 회원 포함" 체크 시 `탈퇴` 배지 스크린샷, 탈퇴 회원 상세에서 삭제 섹션 숨김 확인.
11. **회귀**: 기존 회원 상세/기기 삭제/강좌 관리 모달, 쿠폰 학생 지정 발급 검색이 정상 동작.

### 6.3 정리 (반드시 실행, 결과 증거 첨부)

```sql
DELETE FROM payments WHERE order_number LIKE 'DELTEST-%';
DELETE FROM coupons  WHERE code LIKE 'ZZDELTEST%';
DELETE FROM members  WHERE id IN (<scratchpad에 기록한 A,B,C id>);   -- CASCADE로 잔여 자식 행 정리
-- 확인: 아래가 모두 0
SELECT COUNT(*) FROM members  WHERE id IN (...) OR username LIKE 'deltest+%';
SELECT COUNT(*) FROM payments WHERE order_number LIKE 'DELTEST-%';
SELECT COUNT(*) FROM coupons  WHERE code LIKE 'ZZDELTEST%';
```
삭제 조건은 반드시 위 접두사/기록된 id로만 한정할 것(범위 없는 DELETE 금지).

### 6.4 증거 요구

API 응답 JSON(각 시나리오 상태코드 포함), DB 조회 결과(삭제 전/후), 스크린샷 파일 경로, 정리 후 0건 조회 결과.

---

## 7. 커밋 / 배포 메모

- 변경 파일: `server.js`, `admin/members.js`, `admin/index.html` (선택: `CLAUDE.md` 관리자 페이지 절에 "회원 삭제: 결제 이력 없으면 하드 삭제, 있으면 익명화(member_group='withdrawn')" 한 줄 추가).
- 커밋 메시지 예: `관리자: 회원 삭제 지원 (결제 이력 있으면 익명화로 결제기록 보존)`
- **스키마 변경 없음 → 운영 DB 수동 적용 불필요.** `git push`는 사용자가 `git-push`라고 입력할 때만(push = 실서비스 배포).
