const { spawn } = require('child_process');

const PRESET = process.env.FFMPEG_PRESET || 'medium';
const CRF = process.env.FFMPEG_CRF || '23';

function transcode(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', PRESET,
      '-crf', CRF,
      '-c:a', 'aac',
      '-b:a', '128k',
      outputPath
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
