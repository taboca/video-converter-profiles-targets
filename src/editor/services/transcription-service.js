import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const OPENAI_TRANSCRIPT_LIMIT_BYTES = 25 * 1024 * 1024;

export const transcriptionService = {
  resolveTranscriptionPaths,
  extractLayerAudio,
  transcribeAudioWithOpenAI,
  saveTranscript,
  readTranscript,
  exportTranscriptMarkdown,
};

function resolveTranscriptionPaths({editorProjectsDir, projectId, layerId}) {
  const safeProjectId = sanitizeSlug(projectId);
  const safeLayerId = sanitizeSlug(layerId);
  const transcriptDir = path.join(editorProjectsDir, safeProjectId, 'transcripts');
  const audioFileName = `${safeLayerId}.mp3`;
  const transcriptFileName = `${safeLayerId}.transcript.json`;
  const markdownFileName = `${safeLayerId}.transcript.md`;
  return {
    transcriptionDir: transcriptDir,
    audioAbsolutePath: path.join(transcriptDir, audioFileName),
    transcriptAbsolutePath: path.join(transcriptDir, transcriptFileName),
    markdownAbsolutePath: path.join(transcriptDir, markdownFileName),
    audioPublicPath: `/media/editor/projects/${encodeURIComponent(safeProjectId)}/transcripts/${encodeURIComponent(audioFileName)}`,
    transcriptPublicPath: `/media/editor/projects/${encodeURIComponent(safeProjectId)}/transcripts/${encodeURIComponent(transcriptFileName)}`,
    markdownPublicPath: `/media/editor/projects/${encodeURIComponent(safeProjectId)}/transcripts/${encodeURIComponent(markdownFileName)}`,
  };
}

async function extractLayerAudio({sourceVideoPath, outputPath, trimInMs, trimOutMs}) {
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, {recursive: true});
  const start = toSec(trimInMs || 0);
  const end = toSec(trimOutMs || 0);
  if (end <= start) {
    throw new Error('Invalid segment to extract. trimOutMs must be greater than trimInMs.');
  }
  const args = [
    '-y',
    '-ss',
    start,
    '-to',
    end,
    '-i',
    sourceVideoPath,
    '-vn',
    '-c:a',
    'libmp3lame',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '128k',
    outputPath,
  ];
  await runFfmpeg(args, 'editor-transcription-audio');
  const stats = await fs.stat(outputPath);
  if (!stats.size) {
    throw new Error('No content extracted');
  }
  return {sizeBytes: stats.size, size: stats.size};
}

async function transcribeAudioWithOpenAI({
  apiKey,
  audioPath,
  model,
  responseFormat = 'json',
  timestampGranularities = [],
}) {
  const stats = await fs.stat(audioPath);
  if (stats.size > OPENAI_TRANSCRIPT_LIMIT_BYTES) {
    throw new Error(
      'Audio file exceeds OpenAI upload limit (25MB). Split the audio into chunks and transcribe sequentially.',
    );
  }
  const buffer = await fs.readFile(audioPath);
  const formData = new FormData();
  const file = new Blob([buffer], {type: 'audio/mpeg'});
  formData.append('file', file, path.basename(audioPath));
  formData.append('model', model);
  formData.append('response_format', responseFormat);
  for (const granularity of timestampGranularities) {
    formData.append('timestamp_granularities[]', String(granularity));
  }
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Transcription request failed with ${response.status}`);
  }
  return payload;
}

async function saveTranscript(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function readTranscript(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

async function exportTranscriptMarkdown(filePath, transcriptPayload) {
  const markdown = buildTranscriptMarkdown(transcriptPayload);
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, markdown, 'utf8');
  const stats = await fs.stat(filePath);
  return {
    markdown,
    sizeBytes: stats.size,
  };
}

function buildTranscriptMarkdown(payload) {
  const segments = Array.isArray(payload?.segments)
    ? payload.segments
        .map((segment) => normalizeTranscriptSegment(segment))
        .filter(Boolean)
    : [];
  if (!segments.length) {
    const fallbackText = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!fallbackText) {
      throw new Error('Transcript JSON has no segment data to export');
    }
    return `# Transcript\n\n${fallbackText}\n`;
  }
  const lines = ['# Transcript', ''];
  for (const segment of segments) {
    lines.push(`## ${formatSegmentSeconds(segment.startSec)} - ${formatSegmentSeconds(segment.endSec)}`);
    lines.push('');
    lines.push(segment.text);
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

function normalizeTranscriptSegment(segment) {
  if (!segment || typeof segment !== 'object') {
    return null;
  }
  const startSec = Number(segment.start);
  const endSec = Number(segment.end);
  const text = typeof segment.text === 'string' ? segment.text.trim() : '';
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec || !text) {
    return null;
  }
  return {
    startSec,
    endSec,
    text,
  };
}

function formatSegmentSeconds(value) {
  return `${Number(value || 0).toFixed(3)}s`;
}

function sanitizeSlug(value) {
  const safe = String(value || '').trim();
  return safe.replace(/[^a-zA-Z0-9-_\.]/g, '-').replace(/-+/g, '-');
}

function toSec(ms) {
  return `${Math.max(0, Number(ms || 0)) / 1000}`;
}

async function runFfmpeg(args, context) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${context}: ffmpeg exited with code ${code}. ${stderr.trim()}`));
      }
    });
  });
}
