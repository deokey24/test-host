const { spawn } = require('child_process');

const PRESET = process.env.FFMPEG_PRESET || 'medium';
const CRF = process.env.FFMPEG_CRF || '23';
const HLS_SEGMENT_SECONDS = process.env.HLS_SEGMENT_SECONDS || '6';

// outputDir에 master.m3u8 + segment%05d.ts를 생성한다.
// force_key_frames로 세그먼트 경계를 강제해, 소스 프레임레이트/GOP 구조와 무관하게
// 정확히 HLS_SEGMENT_SECONDS 간격으로 키프레임이 오도록 보장한다.
function transcode(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
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
      '-hls_segment_filename', `${outputDir}/segment%05d.ts`,
      `${outputDir}/master.m3u8`
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

module.exports = { transcode };
