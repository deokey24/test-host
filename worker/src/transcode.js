const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRESET = process.env.FFMPEG_PRESET || 'medium';
const CRF = process.env.FFMPEG_CRF || '23';
const HLS_SEGMENT_SECONDS = process.env.HLS_SEGMENT_SECONDS || '6';

// outputDir에 master.m3u8 + segment%05d.ts를 생성하고 AES-128로 세그먼트를 암호화한다.
// force_key_frames로 세그먼트 경계를 강제해, 소스 프레임레이트/GOP 구조와 무관하게
// 정확히 HLS_SEGMENT_SECONDS 간격으로 키프레임이 오도록 보장한다.
//
// 암호화 키 파일은 outputDir 밖의 별도 임시 디렉터리(keyDir)에만 존재한다 — outputDir 전체가
// 그대로 R2에 업로드되므로, 키가 실수로도 업로드 대상에 섞이면 안 된다. 매니페스트에는
// ffmpeg가 key_info의 첫 줄(placeholder URI)만 #EXT-X-KEY로 그대로 적어넣고, 실제 키
// 배포는 서버가 요청마다 인증 후 별도 엔드포인트로 내려준다 (server.js renderSignedManifest).
// IV는 지정하지 않음 — HLS 스펙 기본값(세그먼트 미디어 시퀀스 번호)을 그대로 사용.
function transcode(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    const keyDir = `${outputDir}-keymaterial`;
    fs.mkdirSync(keyDir, { recursive: true });
    const key = crypto.randomBytes(16);
    const keyPath = path.join(keyDir, 'enc.key');
    const keyInfoPath = path.join(keyDir, 'key_info');
    fs.writeFileSync(keyPath, key);
    fs.writeFileSync(keyInfoPath, `key.bin\n${keyPath}\n`);

    const cleanupKeyMaterial = () => fs.rm(keyDir, { recursive: true, force: true }, () => {});

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', PRESET,
      '-crf', CRF,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
      '-hls_time', HLS_SEGMENT_SECONDS,
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-hls_key_info_file', keyInfoPath,
      '-hls_segment_filename', `${outputDir}/segment%05d.ts`,
      `${outputDir}/master.m3u8`
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', (err) => {
      cleanupKeyMaterial();
      reject(err);
    });
    ffmpeg.on('close', (code) => {
      cleanupKeyMaterial();
      if (code === 0) {
        resolve(key);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

module.exports = { transcode };
