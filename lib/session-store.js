// express-session 저장소 — 웹 로그인 세션을 MySQL web_sessions 테이블에 둔다.
// MemoryStore는 pm2 reload(배포)·재시작마다 전원 로그아웃시켜서 교체했다. 외부 패키지 없이 기존 풀(getPool)을 쓴다.
// 시간대: 풀이 timezone:'Z'이므로 expires_at은 JS Date를 그대로 바인딩(UTC 저장)하고 비교는 UTC_TIMESTAMP()로 통일.
const session = require('express-session');
const { getPool } = require('./db');

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 12;

function computeExpiresAt(sess) {
  const cookie = sess && sess.cookie;
  if (cookie) {
    if (cookie.expires) {
      const d = new Date(cookie.expires);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const maxAge = typeof cookie.maxAge === 'number' ? cookie.maxAge : cookie.originalMaxAge;
    if (typeof maxAge === 'number' && maxAge > 0) return new Date(Date.now() + maxAge);
  }
  return new Date(Date.now() + DEFAULT_TTL_MS);
}

function memberIdOf(sess) {
  const id = sess && sess.memberId;
  return id === undefined || id === null || id === '' ? null : id;
}

class MySQLSessionStore extends session.Store {
  constructor(options = {}) {
    super(options);
    this.tableName = 'web_sessions';
  }

  get(sid, cb) {
    getPool().query(
      'SELECT data, expires_at > UTC_TIMESTAMP() AS alive FROM web_sessions WHERE sid = ?',
      [sid]
    ).then(([rows]) => {
      const row = rows[0];
      if (!row) return cb(null, null);
      if (!Number(row.alive)) {
        // 만료된 행은 읽지 않고 지운다.
        getPool().query('DELETE FROM web_sessions WHERE sid = ?', [sid]).catch(() => {});
        return cb(null, null);
      }
      let sess;
      try {
        sess = JSON.parse(row.data);
      } catch (e) {
        return cb(null, null);
      }
      cb(null, sess);
    }).catch(err => cb(err));
  }

  set(sid, sess, cb) {
    const done = cb || (() => {});
    let data;
    try {
      data = JSON.stringify(sess);
    } catch (e) {
      done(e);
      return;
    }
    getPool().query(
      `INSERT INTO web_sessions (sid, member_id, expires_at, data) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE member_id = VALUES(member_id), expires_at = VALUES(expires_at), data = VALUES(data)`,
      [sid, memberIdOf(sess), computeExpiresAt(sess), data]
    ).then(() => done(null)).catch(err => done(err));
  }

  destroy(sid, cb) {
    const done = cb || (() => {});
    getPool().query('DELETE FROM web_sessions WHERE sid = ?', [sid])
      .then(() => done(null)).catch(err => done(err));
  }

  // rolling/resave:false일 때 express-session이 호출 — 만료만 갱신한다.
  // data 안의 cookie.expires도 같이 맞춰 둬야 다음 get에서 express-session이 옛 만료를 보지 않는다.
  touch(sid, sess, cb) {
    const done = cb || (() => {});
    let data;
    try {
      data = JSON.stringify(sess);
    } catch (e) {
      done(e);
      return;
    }
    getPool().query(
      'UPDATE web_sessions SET expires_at = ?, data = ? WHERE sid = ?',
      [computeExpiresAt(sess), data, sid]
    ).then(() => done(null)).catch(err => done(err));
  }

  // 회원 삭제/익명화 시 그 회원의 웹 세션을 전부 끊는다. 삭제 건수를 반환.
  destroyByMember(memberId) {
    return getPool().query('DELETE FROM web_sessions WHERE member_id = ?', [memberId])
      .then(([result]) => result.affectedRows || 0);
  }

  cleanup() {
    return getPool().query('DELETE FROM web_sessions WHERE expires_at <= UTC_TIMESTAMP()')
      .then(([result]) => result.affectedRows || 0);
  }
}

module.exports = { MySQLSessionStore };
