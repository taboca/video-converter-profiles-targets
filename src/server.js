const express = require('express');
const path = require('path');
const {promises: fs} = require('fs');
const {execFile, spawn} = require('child_process');
const {promisify} = require('util');
const crypto = require('crypto');
const multer = require('multer');

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = path.join(ROOT, 'db', 'input');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PROJECT_PREFIX = 'dir-video-';
const UPLOAD_FIELD = 'videos';

const uploadStorage = multer.diskStorage({
  destination(_req, file, cb) {
    const projectId = `${PROJECT_PREFIX}${crypto.randomUUID()}`;
    const projectDir = path.join(INPUT_DIR, projectId);
    const outputsDir = path.join(projectDir, 'outputs');
    fs.mkdir(outputsDir, {recursive: true})
      .then(() => {
        file.projectId = projectId;
        file.projectDir = projectDir;
        cb(null, projectDir);
      })
      .catch(cb);
  },
  filename(_req, file, cb) {
    const safeName = sanitizeFilename(file.originalname || 'video.mp4');
    file.storedFilename = safeName;
    cb(null, safeName);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: {fileSize: 1024 * 1024 * 1024},
  fileFilter(_req, file, cb) {
    if (isVideoFile(file.originalname || '')) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'));
    }
  },
});

const PROFILES = {
  statusSaver: {label: 'Status Saver 9:16', width: 608, height: 1080, crf: 26, format: 'mp4', fps: 24},
  storyLite: {label: 'Story Lite 9:16', width: 720, height: 1280, crf: 24, format: 'mp4', fps: 24},
  storyFull: {label: 'Story Full HD 9:16', width: 1080, height: 1920, crf: 23, format: 'mp4', fps: 30},
};

const SUPPORTED_FORMATS = ['mp4', 'webm', 'mov'];

const app = express();
app.use(express.json({limit: '2mb'}));
app.use(express.static(PUBLIC_DIR));
app.use('/media/input', express.static(INPUT_DIR));

app.get('/api/health', (_req, res) => {
  res.json({ok: true});
});

app.get('/api/profiles', (_req, res) => {
  res.json(
    Object.entries(PROFILES).map(([key, profile]) => ({
      id: key,
      ...profile,
    })),
  );
});

app.get('/api/videos', async (_req, res) => {
  try {
    const videos = await listProjects();
    res.json({videos});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to list input videos.'});
  }
});

app.post('/api/upload', upload.array(UPLOAD_FIELD, 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({error: 'No videos found in upload payload.'});
    }
    const created = [];
    for (const file of files) {
      await persistProjectMetadata(file);
      const project = await loadProject(file.projectId);
      if (project) {
        const {inputPath, projectDir, ...publicShape} = project;
        created.push(publicShape);
      }
    }
    res.json({projects: created});
  } catch (error) {
    console.error('Upload failed', error);
    res.status(500).json({error: 'Failed to receive upload.'});
  }
});

app.post('/api/convert', async (req, res) => {
  const payload = req.body || {};
  const projectId = payload.projectId;
  const width = payload.width;
  const height = payload.height;
  const crf = payload.crf;
  const format = payload.format;
  const fps = payload.fps;
  const profileId = payload.profileId;
  if (!projectId) {
    return res.status(400).json({error: 'projectId is required'});
  }

  const project = await loadProject(projectId);
  if (!project) {
    return res.status(404).json({error: 'Project not found'});
  }

  const profile =
    (profileId && PROFILES[profileId]) || {
      width: Number(width) || 720,
      height: Number(height) || 1280,
      crf: Number(crf) || 24,
      format: (format || 'mp4').toLowerCase(),
    };

  const targetFormat = (format || profile.format || 'mp4').toLowerCase();
  const targetFps = Number(fps) || profile.fps || 24;
  if (!SUPPORTED_FORMATS.includes(targetFormat)) {
    return res.status(400).json({error: `Unsupported format: ${targetFormat}`});
  }

  const safeBase = path.parse(project.storedName).name.replace(/[^a-z0-9-_]+/gi, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputName = `${safeBase}-${targetFormat}-${stamp}.${targetFormat}`;
  const projectOutputDir = path.join(project.projectDir, 'outputs');
  const outputPath = path.join(projectOutputDir, outputName);

  try {
    await runFfmpegConversion({
      inputPath: project.inputPath,
      outputPath,
      width: profile.width,
      height: profile.height,
      crf: typeof profile.crf === 'number' ? profile.crf : Number(crf) || 24,
      format: targetFormat,
      fps: targetFps,
    });
    const probe = await probeVideo(outputPath);
    const stats = await fs.stat(outputPath);
    await touchProjectMetadata(project.projectDir);
    const publicBase = `/media/input/${encodeURIComponent(projectId)}/outputs`;
    res.json({
      message: 'Conversion complete',
      output: {
        filename: outputName,
        path: `${publicBase}/${encodeURIComponent(outputName)}`,
        size: stats.size,
        projectId: projectId || null,
        probe,
      },
    });
  } catch (error) {
    console.error('ffmpeg error', error);
    res.status(500).json({error: 'Conversion failed', details: error.message});
  }
});

// History endpoint (optional)
app.get('/api/output', async (_req, res) => {
  try {
    const projects = await listProjects();
    const videos = projects.flatMap((project) =>
      (project.outputs || []).map((output) => ({
        ...output,
        projectId: project.id,
        source: {
          filename: project.filename,
          path: project.path,
        },
      })),
    );
    res.json({videos});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to list output videos.'});
  }
});

app.use((error, req, res, next) => {
  if (req.path.startsWith('/api/')) {
    if (error instanceof multer.MulterError || error.message === 'Unsupported file type') {
      console.error('Upload middleware error', error);
      return res.status(400).json({error: error.message});
    }
    console.error('API error', error);
    return res.status(500).json({error: 'Unexpected server error'});
  }
  return next(error);
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({error: 'API route not found'});
  }
  return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const configuredPort = process.env.PORT;
const port = configuredPort ? Number(configuredPort) : 4000;
app.listen(port, () => {
  console.log(`Video converter listening on http://localhost:${port}`);
});

async function safeReaddir(dir, options) {
  try {
    return await fs.readdir(dir, options);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.mkdir(dir, {recursive: true});
      return [];
    }
    throw error;
  }
}

function isVideoFile(name) {
  return /\.(mp4|mov|m4v|webm|mkv)$/i.test(name);
}

async function probeVideo(filePath) {
  try {
    const {stdout} = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration,size:stream=index,codec_name,width,height,bit_rate,r_frame_rate',
      '-of',
      'json',
      filePath,
    ]);
    return JSON.parse(stdout);
  } catch (error) {
    console.warn(`ffprobe failed for ${filePath}: ${error.message}`);
    return null;
  }
}

async function runFfmpegConversion({inputPath, outputPath, width, height, crf, format, fps}) {
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  const safeWidth = ensureEven(width);
  const safeHeight = ensureEven(height);
  const defaultCrf = format === 'webm' ? 32 : 24;
  const crfValue = typeof crf === 'number' ? crf : defaultCrf;
  const fpsValue = Number(fps) || 24;
  const scaleFilter = `scale=${safeWidth}:${safeHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const filters = [`${scaleFilter}`, `fps=${fpsValue}`].join(',');
  const videoArgs = [
    '-y',
    '-i',
    inputPath,
    '-vf',
    filters,
    '-c:v',
    format === 'webm' ? 'libvpx-vp9' : 'libx264',
    ...(format === 'webm' ? ['-b:v', '0', '-crf', String(crfValue)] : ['-crf', String(crfValue), '-preset', 'medium']),
    '-c:a',
    format === 'webm' ? 'libopus' : 'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outputPath,
  ];

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', videoArgs, {stdio: ['ignore', 'inherit', 'inherit']});
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

function ensureEven(value, fallback = 2) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return Math.max(2, Math.floor(fallback / 2) * 2);
  }
  return Math.max(2, Math.floor(num / 2) * 2);
}

async function listProjects() {
  const entries = await safeReaddir(INPUT_DIR, {withFileTypes: true});
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = await loadProject(entry.name);
    if (project) {
      projects.push(project);
    }
  }
  projects.sort((a, b) => {
    const aTime = a.modifiedAt instanceof Date ? a.modifiedAt.getTime() : new Date(a.modifiedAt).getTime();
    const bTime = b.modifiedAt instanceof Date ? b.modifiedAt.getTime() : new Date(b.modifiedAt).getTime();
    return bTime - aTime;
  });
  return projects.map(({inputPath, projectDir, ...rest}) => rest);
}

async function loadProject(projectId) {
  const projectDir = path.join(INPUT_DIR, projectId);
  const metadata = await readProjectMetadata(projectDir);
  const storedName = metadata?.storedName || (await findSourceFilename(projectDir));
  if (!storedName) {
    return null;
  }
  const inputPath = path.join(projectDir, storedName);
  let stats;
  try {
    stats = await fs.stat(inputPath);
  } catch (error) {
    console.warn(`Missing source for project ${projectId}`, error.message);
    return null;
  }
  const probe = await probeVideo(inputPath);
  const outputs = await loadProjectOutputs(projectDir, projectId);
  return {
    id: projectId,
    filename: metadata?.originalName || storedName,
    storedName,
    size: stats.size,
    modifiedAt: stats.mtime,
    createdAt: metadata?.createdAt || stats.birthtime,
    path: `/media/input/${encodeURIComponent(projectId)}/${encodeURIComponent(storedName)}`,
    probe,
    outputs,
    inputPath,
    projectDir,
  };
}

async function loadProjectOutputs(projectDir, projectId) {
  const outputDir = path.join(projectDir, 'outputs');
  const files = await safeReaddir(outputDir);
  const entries = await Promise.all(
    files
      .filter(isVideoFile)
      .map(async (filename) => {
        const fullPath = path.join(outputDir, filename);
        const stats = await fs.stat(fullPath);
        const probe = await probeVideo(fullPath);
        return {
          filename,
          size: stats.size,
          modifiedAt: stats.mtime,
          path: `/media/input/${encodeURIComponent(projectId)}/outputs/${encodeURIComponent(filename)}`,
          probe,
        };
      }),
  );
  return entries.sort((a, b) => {
    const aTime = a.modifiedAt instanceof Date ? a.modifiedAt.getTime() : new Date(a.modifiedAt).getTime();
    const bTime = b.modifiedAt instanceof Date ? b.modifiedAt.getTime() : new Date(b.modifiedAt).getTime();
    return bTime - aTime;
  });
}

async function persistProjectMetadata(file) {
  if (!file?.projectDir || !file?.projectId) {
    return;
  }
  const metadataPath = path.join(file.projectDir, 'metadata.json');
  const now = new Date().toISOString();
  const payload = {
    id: file.projectId,
    originalName: file.originalname || file.storedFilename,
    storedName: file.storedFilename,
    createdAt: now,
    updatedAt: now,
  };
  await fs.writeFile(metadataPath, JSON.stringify(payload, null, 2));
}

async function touchProjectMetadata(projectDir) {
  const metadataPath = path.join(projectDir, 'metadata.json');
  try {
    const raw = await fs.readFile(metadataPath, 'utf8');
    const json = JSON.parse(raw);
    json.updatedAt = new Date().toISOString();
    await fs.writeFile(metadataPath, JSON.stringify(json, null, 2));
  } catch (error) {
    const payload = {updatedAt: new Date().toISOString()};
    await fs.writeFile(metadataPath, JSON.stringify(payload, null, 2));
  }
}

async function readProjectMetadata(projectDir) {
  try {
    const raw = await fs.readFile(path.join(projectDir, 'metadata.json'), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

async function findSourceFilename(projectDir) {
  const entries = await safeReaddir(projectDir, {withFileTypes: true});
  const file = entries.find((entry) => entry.isFile() && isVideoFile(entry.name));
  return file ? file.name : null;
}

function sanitizeFilename(name) {
  const trimmed = (name || 'video').trim();
  const ext = path.extname(trimmed) || '.mp4';
  const baseName = path.basename(trimmed, ext);
  const safeBase = baseName.replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'clip';
  return `${safeBase}${ext.toLowerCase()}`;
}
