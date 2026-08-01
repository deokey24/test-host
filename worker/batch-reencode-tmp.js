const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');

const SCRATCH = 'C:/Users/user/AppData/Local/Temp/claude/C--workspace-dock/33de3ae8-6c15-4e03-9fe2-e8652034872a/scratchpad';
const WORK_DIR = path.join(SCRATCH, 'batch-reencode-work');

process.env.FFMPEG_CRF = '18';
process.env.FFMPEG_PRESET = 'medium';
process.env.HLS_SEGMENT_SECONDS = '6';

const { transcode } = require('./src/transcode');
const { getR2Client, uploadDirectory } = require('./lib/r2');
const { GetObjectCommand } = require('@aws-sdk/client-s3');

const VIDEO_IDS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];

function sanitize(title) {
  return title.replace(/[^\w.\-가-힣 ]/g, '').replace(/\s+/g, '-');
}

function fmtBytes(n) {
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

async function dirSize(dir) {
  const files = await fsp.readdir(dir);
  let total = 0;
  for (const f of files) {
    const st = await fsp.stat(path.join(dir, f));
    total += st.size;
  }
  return total;
}

function newConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME
  });
}

async function saveResults(results) {
  await fsp.writeFile(path.join(SCRATCH, 'batch-reencode-results.json'), JSON.stringify(results, null, 2));
}

async function main() {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  const results = [];

  for (const videoId of VIDEO_IDS) {
    const t0 = Date.now();
    // 커넥션은 강의마다 새로 맺는다 — 인코딩(수십 분)하는 동안 커넥션을 계속 붙들고 있으면
    // MySQL wait_timeout에 걸려 다음 UPDATE에서 끊길 위험이 있다.
    let conn = await newConn();
    const [[video]] = await conn.query('SELECT id, title, final_r2_key FROM lecture_videos WHERE id = ?', [videoId]);
    await conn.end();
    if (!video) { console.log(`[${videoId}] 레코드 없음 — 스킵`); continue; }
    if (video.final_r2_key && video.final_r2_key.endsWith('.m3u8')) {
      console.log(`[${videoId}] 이미 HLS로 처리됨 — 스킵 (재실행 시 이어서 진행)`);
      continue;
    }
    const oldKey = video.final_r2_key;
    console.log(`\n=== [${videoId}] ${video.title} 시작 ===`);
    console.log(`원본 키: ${oldKey}`);

    const rawPath = path.join(WORK_DIR, `${videoId}-raw.mp4`);
    const hlsDir = path.join(WORK_DIR, `${videoId}-hls`);

    try {
      console.log(`[${videoId}] 다운로드 중...`);
      const client = getR2Client();
      const headRes = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: oldKey }));
      const originalSize = Number(headRes.ContentLength || 0);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(rawPath);
        headRes.Body.pipe(ws);
        headRes.Body.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
      });
      console.log(`[${videoId}] 다운로드 완료 (${fmtBytes(originalSize)})`);

      await fsp.mkdir(hlsDir, { recursive: true });
      console.log(`[${videoId}] 인코딩 중 (CRF18)...`);
      const encStart = Date.now();
      const encryptionKey = await transcode(rawPath, hlsDir);
      const encSeconds = Math.round((Date.now() - encStart) / 1000);
      const newSize = await dirSize(hlsDir);
      console.log(`[${videoId}] 인코딩 완료 (${encSeconds}초, ${fmtBytes(newSize)}, 원본 대비 ${(100 * newSize / originalSize).toFixed(0)}%)`);

      const prefix = `hls/lecture-${videoId}-${sanitize(video.title)}-crf18`;
      console.log(`[${videoId}] 업로드 중... (${prefix})`);
      await uploadDirectory(prefix, hlsDir);
      const newFinalKey = `${prefix}/master.m3u8`;

      const writeConn = await newConn();
      await writeConn.query(
        'UPDATE lecture_videos SET final_r2_key = ?, hls_key_base64 = ?, status = ? WHERE id = ?',
        [newFinalKey, encryptionKey.toString('base64'), 'done', videoId]
      );
      const [linkResult] = await writeConn.query(
        'UPDATE vod_course_lectures SET video_r2_key = ? WHERE video_r2_key = ?',
        [newFinalKey, oldKey]
      );
      await writeConn.end();
      console.log(`[${videoId}] DB 갱신 완료 (vod_course_lectures 연결 ${linkResult.affectedRows}건)`);

      results.push({
        videoId, title: video.title, ok: true,
        originalMB: (originalSize / 1024 / 1024).toFixed(1),
        newMB: (newSize / 1024 / 1024).toFixed(1),
        encSeconds, totalSeconds: Math.round((Date.now() - t0) / 1000)
      });
      console.log(`=== [${videoId}] 완료 (총 ${Math.round((Date.now() - t0) / 1000)}초) ===`);
    } catch (err) {
      console.error(`[${videoId}] 실패:`, err.message);
      results.push({ videoId, title: video.title, ok: false, error: err.message });
    } finally {
      await fsp.rm(rawPath, { force: true }).catch(() => {});
      await fsp.rm(hlsDir, { recursive: true, force: true }).catch(() => {});
      // 도중에 죽더라도 여기까지 진행 상황은 파일로 남는다 — 재실행하면 이미 처리된
      // 강의는 위의 .m3u8 체크로 자동 스킵되어 이어서 진행된다.
      await saveResults(results);
    }
  }

  console.log('\n\n=== 전체 결과 요약 ===');
  console.table(results);
  await saveResults(results);
}

main().catch((err) => {
  console.error('배치 작업 실패:', err);
  process.exit(1);
});
