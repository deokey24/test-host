const path = require('path');
const fsp = require('fs/promises');
const pLimit = require('p-limit');

const { getPool } = require('./lib/db');
const { downloadToFile, uploadFromFile } = require('./lib/r2');
const { receiveVideoJobs, deleteMessage, isQueueEmpty } = require('./lib/sqs');
const { stopSelf } = require('./lib/ec2');
const { transcode } = require('./src/transcode');

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 5);
const TMP_DIR = process.env.WORKER_TMP_DIR || '/mnt/worker-tmp';
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MINUTES || 10) * 60 * 1000;

const limit = pLimit(CONCURRENCY);
let activeJobs = 0;
let lastActivityAt = Date.now();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveFinalKey(rawKey) {
  const withoutPrefix = rawKey.replace(/^raw\//, '');
  const withoutExt = withoutPrefix.replace(/\.[^./]+$/, '');
  return `final/${withoutExt}.mp4`;
}

async function processJob(message) {
  const { videoId, rawKey } = JSON.parse(message.Body);
  const rawPath = path.join(TMP_DIR, `${videoId}-raw`);
  const finalPath = path.join(TMP_DIR, `${videoId}-final.mp4`);
  const finalKey = deriveFinalKey(rawKey);

  try {
    console.log(`[video ${videoId}] 처리 시작: ${rawKey}`);
    await getPool().query('UPDATE lecture_videos SET status = ? WHERE id = ?', ['processing', videoId]);

    await downloadToFile(rawKey, rawPath);
    await transcode(rawPath, finalPath);
    await uploadFromFile(finalKey, finalPath);

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
    await Promise.all(
      [rawPath, finalPath].map((p) => fsp.rm(p, { force: true }).catch(() => {}))
    );
    await deleteMessage(message.ReceiptHandle).catch((err) =>
      console.error('SQS 메시지 삭제 실패:', err)
    );
  }
}

async function pollLoop() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  console.log(`워커 시작 (동시 처리 ${CONCURRENCY}개, 임시 디렉터리 ${TMP_DIR})`);

  while (true) {
    const capacity = CONCURRENCY - activeJobs;
    if (capacity <= 0) {
      await sleep(2000);
      continue;
    }

    const messages = await receiveVideoJobs(capacity);
    for (const message of messages) {
      activeJobs++;
      lastActivityAt = Date.now();
      limit(() => processJob(message)).finally(() => {
        activeJobs--;
        lastActivityAt = Date.now();
      });
    }
  }
}

async function idleShutdownWatcher() {
  setInterval(async () => {
    if (activeJobs > 0) return;
    if (Date.now() - lastActivityAt < IDLE_TIMEOUT_MS) return;

    try {
      const queueEmpty = await isQueueEmpty();
      if (queueEmpty) {
        console.log(`유휴 상태가 ${IDLE_TIMEOUT_MS / 60000}분 이상 지속되어 인스턴스를 정지합니다.`);
        await stopSelf();
      }
    } catch (err) {
      console.error('유휴 상태 확인 실패:', err);
    }
  }, 60 * 1000);
}

pollLoop().catch((err) => {
  console.error('워커 루프 치명적 오류:', err);
  process.exit(1);
});
idleShutdownWatcher();
