const path = require('path');
const fsp = require('fs/promises');
const pLimit = require('p-limit');

const { getPool } = require('./lib/db');
const { downloadToFile, uploadDirectory } = require('./lib/r2');
const {
  receiveVideoJobs,
  deleteMessage,
  extendVisibility,
  isQueueEmpty,
  VISIBILITY_TIMEOUT_SECONDS
} = require('./lib/sqs');
const { terminateSelfViaAsg } = require('./lib/asg');
const { transcode } = require('./src/transcode');

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 5);
const TMP_DIR = process.env.WORKER_TMP_DIR || '/mnt/worker-tmp';
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MINUTES || 10) * 60 * 1000;
// visibility(30분)의 1/3 주기로 연장 — 연장 호출이 2번 연속 실패해도 메시지가 잠기지 않음
const HEARTBEAT_INTERVAL_MS = (VISIBILITY_TIMEOUT_SECONDS / 3) * 1000;

const limit = pLimit(CONCURRENCY);
let activeJobs = 0;
let lastActivityAt = Date.now();
let draining = false; // SIGTERM 수신 — 새 메시지 수신을 멈추고 진행 중 작업만 마무리

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveHlsPrefix(rawKey) {
  const withoutPrefix = rawKey.replace(/^raw\//, '');
  const withoutExt = withoutPrefix.replace(/\.[^./]+$/, '');
  return `hls/${withoutExt}`;
}

async function processJob(message) {
  const { videoId, rawKey } = JSON.parse(message.Body);

  // 재전달 멱등성: 이전 인스턴스가 처리를 끝내고 메시지 삭제만 못 한 채 죽었으면 스킵.
  // (status=processing은 처리 도중 죽은 것이므로 처음부터 정상 재처리)
  const [rows] = await getPool().query('SELECT status FROM lecture_videos WHERE id = ?', [videoId]);
  if (!rows[0] || rows[0].status === 'done') {
    console.log(`[video ${videoId}] 이미 처리됨(또는 레코드 없음) — 재전달 메시지 스킵`);
    await deleteMessage(message.ReceiptHandle).catch((err) =>
      console.error('SQS 메시지 삭제 실패:', err)
    );
    return;
  }

  const rawPath = path.join(TMP_DIR, `${videoId}-raw`);
  const hlsDir = path.join(TMP_DIR, `${videoId}-hls`);
  const hlsPrefix = deriveHlsPrefix(rawKey);
  const finalKey = `${hlsPrefix}/master.m3u8`;

  // 하트비트: 처리하는 동안 메시지 visibility를 계속 연장.
  // 인스턴스가 급사하면 연장이 끊겨 30분 내 다른 인스턴스가 재수신한다.
  const heartbeat = setInterval(() => {
    extendVisibility(message.ReceiptHandle).catch((err) =>
      console.error(`[video ${videoId}] visibility 연장 실패:`, err)
    );
  }, HEARTBEAT_INTERVAL_MS);

  try {
    console.log(`[video ${videoId}] 처리 시작: ${rawKey}`);
    await getPool().query('UPDATE lecture_videos SET status = ? WHERE id = ?', ['processing', videoId]);

    await fsp.mkdir(hlsDir, { recursive: true });
    await downloadToFile(rawKey, rawPath);
    await transcode(rawPath, hlsDir);
    await uploadDirectory(hlsPrefix, hlsDir);

    await getPool().query(
      'UPDATE lecture_videos SET status = ?, final_r2_key = ? WHERE id = ?',
      ['done', finalKey, videoId]
    );
    console.log(`[video ${videoId}] 완료: ${finalKey}`);
  } catch (err) {
    console.error(`[video ${videoId}] 처리 실패:`, err);
    await getPool().query(
      'UPDATE lecture_videos SET status = ?, error_message = ? WHERE id = ?',
      ['failed', String(err.message || err).slice(0, 2000), videoId]
    ).catch((dbErr) => console.error('DB 상태 갱신 실패:', dbErr));
  } finally {
    clearInterval(heartbeat);
    await Promise.all([
      fsp.rm(rawPath, { force: true }).catch(() => {}),
      fsp.rm(hlsDir, { recursive: true, force: true }).catch(() => {})
    ]);
    // 앱 레벨 실패(ffmpeg 에러 등)도 메시지를 삭제한다 — 재시도해도 같은 결과이므로
    // failed 기록 후 관리자 재업로드에 맡긴다. SQS 재전달은 인스턴스 급사 케이스만 담당.
    await deleteMessage(message.ReceiptHandle).catch((err) =>
      console.error('SQS 메시지 삭제 실패:', err)
    );
  }
}

// 유휴 종료 판단은 롱폴링이 빈손으로 돌아온 직후, 같은 루프 안에서만 한다.
// 수신과 종료 결정이 한 곳에서 일어나므로 "종료 결심 직후 메시지 수신" 레이스가 없다.
async function maybeTerminateSelf() {
  if (activeJobs > 0) return false;
  if (Date.now() - lastActivityAt < IDLE_TIMEOUT_MS) return false;

  const queueEmpty = await isQueueEmpty().catch((err) => {
    console.error('유휴 상태 확인 실패:', err);
    return false;
  });
  if (!queueEmpty || activeJobs > 0) return false;

  console.log(`유휴 상태가 ${IDLE_TIMEOUT_MS / 60000}분 이상 지속 — ASG desired를 낮추며 자기 자신을 종료합니다.`);
  try {
    await terminateSelfViaAsg();
    return true;
  } catch (err) {
    // ASG 밖에서 실행 중(로컬 개발 등)이거나 권한 문제 — 폴링은 계속한다
    console.error('자기 종료 실패:', err);
    lastActivityAt = Date.now(); // 매 루프 재시도로 API 호출이 폭주하지 않게 타이머 리셋
    return false;
  }
}

async function pollLoop() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  console.log(`워커 시작 (동시 처리 ${CONCURRENCY}개, 임시 디렉터리 ${TMP_DIR})`);

  while (!draining) {
    const capacity = CONCURRENCY - activeJobs;
    if (capacity <= 0) {
      await sleep(2000);
      continue;
    }

    const messages = await receiveVideoJobs(capacity);
    if (draining) break; // 롱폴링 중 SIGTERM이 왔으면 받은 메시지는 잡지 않고 visibility 만료에 맡긴다

    for (const message of messages) {
      activeJobs++;
      lastActivityAt = Date.now();
      limit(() => processJob(message)).finally(() => {
        activeJobs--;
        lastActivityAt = Date.now();
      });
    }

    if (messages.length === 0 && await maybeTerminateSelf()) {
      // 종료 요청 성공 — 곧 ASG가 인스턴스를 내리며 SIGTERM이 온다. 그때까지 대기.
      await new Promise(() => {});
    }
  }
}

// systemd stop / ASG 종료 / 수동 재시작 시: 새 작업은 받지 않고 진행 중 작업을 끝까지 마무리.
// (유닛의 TimeoutStopSec가 충분히 길어야 강제 kill되지 않는다)
async function drainAndExit(signal) {
  if (draining) return;
  draining = true;
  console.log(`${signal} 수신 — 새 작업 수신 중단, 진행 중 ${activeJobs}건 마무리 대기`);
  while (activeJobs > 0) {
    await sleep(5000);
  }
  console.log('드레인 완료 — 종료합니다.');
  process.exit(0);
}

process.on('SIGTERM', () => drainAndExit('SIGTERM'));
process.on('SIGINT', () => drainAndExit('SIGINT'));

pollLoop().catch((err) => {
  console.error('워커 루프 치명적 오류:', err);
  process.exit(1);
});
