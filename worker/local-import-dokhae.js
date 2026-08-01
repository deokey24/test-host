const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
const pLimit = require('p-limit');

process.env.FFMPEG_CRF = '18';
process.env.FFMPEG_PRESET = 'medium';
process.env.HLS_SEGMENT_SECONDS = '6';

const { transcode } = require('./src/transcode');
const { uploadDirectory } = require('./lib/r2');

const SOURCE_DIR = 'C:/Users/user/Downloads/독해학개론 최종본';
const WORK_DIR = 'C:/Users/user/Downloads/독해학개론-encode-work';
const RESULTS_PATH = path.join(WORK_DIR, 'results.json');
const FOLDER_ID = 9; // video_folders: "독해학개론"
const CONCURRENCY = 1;

const ITEMS = [
  { file: '1강.mp4', title: '독해학개론_1강' },
  { file: '2강.mp4', title: '독해학개론_2강' },
  { file: '3강.mp4', title: '독해학개론_3강' },
  { file: '4강.mp4', title: '독해학개론_4강' },
  { file: '5강(뒷부분x).mp4', title: '독해학개론_5강(뒷부분x)' },
  { file: '5강(뒷부분ㅇ).mp4', title: '독해학개론_5강(뒷부분ㅇ)' },
  { file: '6강.mp4', title: '독해학개론_6강' },
  { file: '7강.mp4', title: '독해학개론_7강' },
  { file: '8강.mp4', title: '독해학개론_8강' },
  { file: '9강.mp4', title: '독해학개론_9강' },
  { file: '10강.mp4', title: '독해학개론_10강' },
  { file: '11강.mp4', title: '독해학개론_11강' },
  { file: '12강.mp4', title: '독해학개론_12강' }
];

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

let results = [];

async function loadResults() {
  try {
    results = JSON.parse(await fsp.readFile(RESULTS_PATH, 'utf8'));
  } catch {
    results = [];
  }
}

async function saveResults() {
  await fsp.writeFile(RESULTS_PATH, JSON.stringify(results, null, 2));
}

function upsertResult(entry) {
  const idx = results.findIndex((r) => r.title === entry.title);
  if (idx >= 0) results[idx] = entry; else results.push(entry);
}

async function processItem(item) {
  const t0 = Date.now();
  const log = (msg) => console.log(`[${item.title}] ${msg}`);

  // 커넥션은 항목마다 새로 맺는다 — 인코딩에 수십 분~몇 시간 걸리므로 하나의 커넥션을
  // 오래 붙들면 MySQL wait_timeout에 걸려 끊길 위험이 있다.
  let conn = await newConn();
  const [[existing]] = await conn.query(
    'SELECT id, status, final_r2_key FROM lecture_videos WHERE title = ?',
    [item.title]
  );
  await conn.end();

  if (existing && existing.status === 'done' && existing.final_r2_key && existing.final_r2_key.endsWith('.m3u8')) {
    log('이미 완료됨 — 스킵 (재실행 시 이어서 진행 가능한 멱등성 체크)');
    upsertResult({ title: item.title, ok: true, skipped: true });
    await saveResults();
    return;
  }

  let videoId;
  if (existing) {
    videoId = existing.id;
    log(`기존 레코드 재사용 (id=${videoId}, status=${existing.status}) — 이어서 진행`);
  } else {
    const rawPlaceholder = `local-import/${sanitize(item.title)}.mp4`;
    const insertConn = await newConn();
    const [insertResult] = await insertConn.query(
      'INSERT INTO lecture_videos (title, raw_r2_key, folder_id, status) VALUES (?, ?, ?, ?)',
      [item.title, rawPlaceholder, FOLDER_ID, 'processing']
    );
    await insertConn.end();
    videoId = insertResult.insertId;
    log(`신규 레코드 생성 (id=${videoId})`);
  }

  const rawPath = path.join(SOURCE_DIR, item.file);
  const hlsDir = path.join(WORK_DIR, `${videoId}-hls`);

  try {
    const st = await fsp.stat(rawPath);
    const originalSize = st.size;

    await fsp.mkdir(hlsDir, { recursive: true });
    log('인코딩 중 (CRF18, medium)...');
    const encStart = Date.now();
    const encryptionKey = await transcode(rawPath, hlsDir);
    const encSeconds = Math.round((Date.now() - encStart) / 1000);
    const newSize = await dirSize(hlsDir);
    log(`인코딩 완료 (${encSeconds}초, ${fmtBytes(newSize)}, 원본 대비 ${(100 * newSize / originalSize).toFixed(0)}%)`);

    const prefix = `hls/lecture-${videoId}-${sanitize(item.title)}-crf18`;
    log(`업로드 중... (${prefix})`);
    await uploadDirectory(prefix, hlsDir);
    const finalKey = `${prefix}/master.m3u8`;

    const writeConn = await newConn();
    await writeConn.query(
      'UPDATE lecture_videos SET final_r2_key = ?, hls_key_base64 = ?, status = ? WHERE id = ?',
      [finalKey, encryptionKey.toString('base64'), 'done', videoId]
    );
    await writeConn.end();

    upsertResult({
      videoId,
      title: item.title,
      ok: true,
      originalMB: (originalSize / 1024 / 1024).toFixed(1),
      newMB: (newSize / 1024 / 1024).toFixed(1),
      encSeconds,
      totalSeconds: Math.round((Date.now() - t0) / 1000)
    });
    log(`완료 (총 ${Math.round((Date.now() - t0) / 1000)}초)`);
  } catch (err) {
    log(`실패: ${err.message}`);
    const failConn = await newConn();
    await failConn.query(
      'UPDATE lecture_videos SET status = ?, error_message = ? WHERE id = ?',
      ['failed', String(err.message).slice(0, 2000), videoId]
    );
    await failConn.end();
    upsertResult({ videoId, title: item.title, ok: false, error: err.message });
  } finally {
    await fsp.rm(hlsDir, { recursive: true, force: true }).catch(() => {});
    await saveResults();
  }
}

async function main() {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  await loadResults();

  const limit = pLimit(CONCURRENCY);
  await Promise.all(ITEMS.map((item) => limit(() => processItem(item))));

  console.log('\n=== 전체 결과 요약 ===');
  console.table(results);
  await saveResults();
}

main().catch((err) => {
  console.error('배치 작업 실패:', err);
  process.exit(1);
});
