import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {openAIConfig} from './config.js';
import {transcriptionService} from './services/transcription-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const INPUT_DIR = path.join(ROOT, 'db', 'input');
const EDITOR_DIR = path.join(ROOT, 'db', 'editor');
const EDITOR_INDEX_PATH = path.join(EDITOR_DIR, 'index.json');
const EDITOR_PROJECTS_DIR = path.join(EDITOR_DIR, 'projects');
const PUBLIC_EDITOR_DIR = path.join(ROOT, 'public-editor');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const DEFAULT_LAYER_COUNT = 3;
const DEFAULT_PROJECT_DURATION_MS = 300000;
const DEFAULT_ZOOM = 0.2;
const THUMBNAIL_COUNT = 8;

const renderJobs = new Map();
const app = express();

app.use(express.json({limit: '4mb'}));
app.use('/media/input', express.static(INPUT_DIR));
app.use('/media/editor/projects', express.static(EDITOR_PROJECTS_DIR));
app.use(express.static(PUBLIC_EDITOR_DIR));

app.get('/api/editor/health', (_req, res) => {
  res.json({ok: true});
});

app.get('/api/editor/projects', async (_req, res) => {
  try {
    const index = await loadEditorIndex();
    res.json({projects: index.projects});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to load editor projects'});
  }
});

app.post('/api/editor/projects', async (req, res) => {
  try {
    const name = sanitizeProjectName(req.body?.name);
    const projectId = `ed-${crypto.randomUUID()}`;
    const state = createDefaultProjectState(projectId, name);
    await saveProjectState(state);
    await appendProjectToIndex(state);
    res.status(201).json({project: state});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to create project'});
  }
});

app.get('/api/editor/projects/:projectId', async (req, res) => {
  try {
    const state = await loadProjectState(req.params.projectId);
    if (!state) {
      return res.status(404).json({error: 'Project not found'});
    }
    const reconciled = await reconcilePersistedRenderIfNeeded(state);
    res.json({project: reconciled});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to load project'});
  }
});

app.put('/api/editor/projects/:projectId', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const current = await loadProjectState(projectId);
    if (!current) {
      return res.status(404).json({error: 'Project not found'});
    }
    const merged = mergeProjectState(current, req.body || {});
    await saveProjectState(merged);
    await updateProjectMetaInIndex(merged);
    res.json({project: merged});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to save project'});
  }
});

app.get('/api/editor/media', async (_req, res) => {
  try {
    const media = await listConvertedMedia();
    res.json({media});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to list converted videos'});
  }
});

app.post('/api/editor/thumbnails', async (req, res) => {
  try {
    const projectId = req.body?.projectId;
    const layerId = req.body?.layerId;
    const sourceVideoId = req.body?.sourceVideoId;
    if (!projectId || !layerId || !sourceVideoId) {
      return res.status(400).json({error: 'projectId, layerId, and sourceVideoId are required'});
    }
    const project = await loadProjectState(projectId);
    if (!project) {
      return res.status(404).json({error: 'Project not found'});
    }
    const sourcePath = resolveSourceVideoPath(sourceVideoId);
    const thumbs = await createThumbnails({
      projectId,
      layerId,
      sourceVideoId,
      sourcePath,
      count: THUMBNAIL_COUNT,
    });
    res.json({thumbnails: thumbs});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to generate thumbnails', details: error.message});
  }
});

app.post('/api/editor/render/:projectId', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const running = renderJobs.get(projectId);
    if (running && running.status === 'running') {
      return res.status(409).json({error: 'Render already running', render: toPublicRenderState(running)});
    }
    const project = await loadProjectState(projectId);
    if (!project) {
      return res.status(404).json({error: 'Project not found'});
    }
    const renderPlan = createRenderPlan(project);
    if (!renderPlan.queueJobs.length) {
      return res.status(400).json({error: 'No active layer clips configured for rendering'});
    }
    const job = createRenderJob(projectId, renderPlan);
    renderJobs.set(projectId, job);
    runRenderJob(project, job).catch((error) => {
      console.error('Render crash', error);
    });
    res.status(202).json({render: toPublicRenderState(job)});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to start render'});
  }
});

app.get('/api/editor/render/:projectId/status', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const running = renderJobs.get(projectId);
    if (running && running.status === 'running') {
      return res.json({render: toPublicRenderState(running)});
    }
    const project = await loadProjectState(projectId);
    if (!project) {
      return res.status(404).json({error: 'Project not found'});
    }
    const reconciled = await reconcilePersistedRenderIfNeeded(project);
    res.json({render: reconciled.lastRender || defaultRenderState()});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to load render status'});
  }
});

app.post('/api/editor/transcribe/:projectId/:layerId/audio', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const layerId = req.params.layerId;
    const project = await loadProjectState(projectId);
    if (!project) {
      return res.status(404).json({error: 'Project not found'});
    }
    const layer = findLayerForProject(project, layerId);
    if (!layer) {
      return res.status(404).json({error: 'Layer not found'});
    }
    if (!layer.clip?.sourceVideoId) {
      return res.status(400).json({error: 'Selected layer has no source video'});
    }
    const sourcePath = resolveSourceVideoPath(layer.clip.sourceVideoId);
    const paths = transcriptionService.resolveTranscriptionPaths({
      editorProjectsDir: EDITOR_PROJECTS_DIR,
      projectId,
      layerId: layer.id,
    });
    const audioResult = await transcriptionService.extractLayerAudio({
      sourceVideoPath: sourcePath,
      outputPath: paths.audioAbsolutePath,
      trimInMs: layer.clip.trimInMs,
      trimOutMs: layer.clip.trimOutMs,
    });
    const now = new Date().toISOString();
    layer.transcription = {
      provider: 'openai',
      model: 'whisper-1',
      status: 'audio-ready',
      audio: {
        path: paths.audioPublicPath,
        sizeBytes: audioResult.sizeBytes,
        createdAt: now,
      },
      transcript: null,
      markdown: null,
      responseFormat: 'verbose_json',
      timestampGranularities: ['segment'],
      segmentCount: null,
      wordCount: null,
      timelineMode: 'segments',
      timelineVisible: layer.transcription?.timelineVisible !== false,
      timelineSegments: [],
      textPreview: null,
      error: null,
      updatedAt: now,
    };
    project.updatedAt = now;
    await saveProjectState(project);
    await updateProjectMetaInIndex(project);
    res.json({transcription: layer.transcription});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to extract audio', details: error.message});
  }
});

app.post('/api/editor/transcribe/:projectId/:layerId/transcript', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const layerId = req.params.layerId;
    const model = String(req.body?.model || 'whisper-1');
    const responseFormat =
      typeof req.body?.responseFormat === 'string' && req.body.responseFormat
        ? req.body.responseFormat
        : model === 'whisper-1'
        ? 'verbose_json'
        : 'json';
    const timestampGranularities = Array.isArray(req.body?.timestampGranularities)
      ? req.body.timestampGranularities.filter((value) => typeof value === 'string' && value)
      : model === 'whisper-1'
      ? ['segment']
      : [];
    const project = await loadProjectState(projectId);
    if (!project) {
      return res.status(404).json({error: 'Project not found'});
    }
    const layer = findLayerForProject(project, layerId);
    if (!layer) {
      return res.status(404).json({error: 'Layer not found'});
    }
    if (!layer.transcription?.audio?.path) {
      return res.status(400).json({error: 'No audio file available. Convert to audio first.'});
    }
    if (!openAIConfig.apiKey) {
      return res.status(500).json({error: 'Missing OPENAI_API_KEY'});
    }
    const paths = transcriptionService.resolveTranscriptionPaths({
      editorProjectsDir: EDITOR_PROJECTS_DIR,
      projectId,
      layerId: layer.id,
    });
    const result = await transcriptionService.transcribeAudioWithOpenAI({
      apiKey: openAIConfig.apiKey,
      audioPath: paths.audioAbsolutePath,
      model,
      responseFormat,
      timestampGranularities,
    });
    await transcriptionService.saveTranscript(paths.transcriptAbsolutePath, result);
    const transcriptStats = await fs.stat(paths.transcriptAbsolutePath);
    const transcriptSummary = summarizeTranscriptPayload(result);
    const timelineSegments = extractTimelineSegments(result);
    const now = new Date().toISOString();
    const textPreview =
      typeof result?.text === 'string' && result.text ? result.text.slice(0, 1200) : null;
    layer.transcription = {
      provider: 'openai',
      model,
      status: 'transcribed',
      audio: layer.transcription.audio,
      transcript: {
        path: paths.transcriptPublicPath,
        sizeBytes: transcriptStats.size,
        createdAt: now,
      },
      markdown: null,
      responseFormat,
      timestampGranularities,
      segmentCount: transcriptSummary.segmentCount,
      wordCount: transcriptSummary.wordCount,
      timelineMode: transcriptSummary.timelineMode,
      timelineVisible: layer.transcription?.timelineVisible !== false,
      timelineSegments,
      textPreview,
      error: null,
      updatedAt: now,
    };
    project.updatedAt = now;
    await saveProjectState(project);
    await updateProjectMetaInIndex(project);
    res.json({transcription: layer.transcription, transcript: result, summary: transcriptSummary});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to transcribe audio', details: error.message});
  }
});

app.post('/api/editor/transcribe/:projectId/:layerId/markdown', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const layerId = req.params.layerId;
    const project = await loadProjectState(projectId);
    if (!project) {
      return res.status(404).json({error: 'Project not found'});
    }
    const layer = findLayerForProject(project, layerId);
    if (!layer) {
      return res.status(404).json({error: 'Layer not found'});
    }
    const enabled = req.body?.enabled !== false;
    if (!enabled) {
      const now = new Date().toISOString();
      layer.transcription = {
        ...layer.transcription,
        markdown: null,
        updatedAt: now,
      };
      project.updatedAt = now;
      await saveProjectState(project);
      await updateProjectMetaInIndex(project);
      return res.json({
        transcription: layer.transcription,
        markdown: null,
      });
    }
    if (!layer.transcription?.transcript?.path) {
      return res.status(400).json({error: 'No transcript JSON available'});
    }
    const paths = transcriptionService.resolveTranscriptionPaths({
      editorProjectsDir: EDITOR_PROJECTS_DIR,
      projectId,
      layerId: layer.id,
    });
    const transcript = await transcriptionService.readTranscript(paths.transcriptAbsolutePath);
    if (!transcript) {
      return res.status(404).json({error: 'Transcript JSON not found'});
    }
    const markdownResult = await transcriptionService.exportTranscriptMarkdown(paths.markdownAbsolutePath, transcript);
    const now = new Date().toISOString();
    layer.transcription = {
      ...layer.transcription,
      markdown: {
        path: paths.markdownPublicPath,
        sizeBytes: markdownResult.sizeBytes,
        createdAt: now,
      },
      updatedAt: now,
    };
    project.updatedAt = now;
    await saveProjectState(project);
    await updateProjectMetaInIndex(project);
    res.json({
      transcription: layer.transcription,
      markdown: layer.transcription.markdown,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to export transcript markdown', details: error.message});
  }
});

app.get('/api/editor/transcribe/:projectId/:layerId', async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const layerId = req.params.layerId;
    const project = await loadProjectState(projectId);
    if (!project) {
      return res.status(404).json({error: 'Project not found'});
    }
    const layer = findLayerForProject(project, layerId);
    if (!layer) {
      return res.status(404).json({error: 'Layer not found'});
    }
    let transcript = null;
    if (layer.transcription?.transcript?.path) {
      const paths = transcriptionService.resolveTranscriptionPaths({
        editorProjectsDir: EDITOR_PROJECTS_DIR,
        projectId,
        layerId: layer.id,
      });
      transcript = await transcriptionService.readTranscript(paths.transcriptAbsolutePath);
    }
    res.json({transcription: layer.transcription || null, transcript});
  } catch (error) {
    console.error(error);
    res.status(500).json({error: 'Failed to load transcription', details: error.message});
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({error: 'API route not found'});
  }
  return next();
});

app.use((_req, res) => {
  res.sendFile(path.join(PUBLIC_EDITOR_DIR, 'index.html'));
});

await ensureEditorStorage();

const configuredPort = process.env.EDITOR_PORT || process.env.PORT;
const port = configuredPort ? Number(configuredPort) : 4100;
app.listen(port, () => {
  console.log(`Editor server listening on http://localhost:${port}`);
});

async function ensureEditorStorage() {
  await fs.mkdir(INPUT_DIR, {recursive: true});
  await fs.mkdir(EDITOR_PROJECTS_DIR, {recursive: true});
  try {
    await fs.access(EDITOR_INDEX_PATH);
  } catch (_error) {
    const seed = {
      version: 1,
      projects: [],
    };
    await writeJson(EDITOR_INDEX_PATH, seed);
  }
}

function sanitizeProjectName(input) {
  const value = String(input || '').trim();
  return value || 'Untitled Project';
}

function sanitizeLayerId(input, fallback = 'layer-1') {
  const value = String(input || '').trim().replace(/[^a-z0-9-_]+/gi, '-');
  return value || fallback;
}

function normalizeVideoExt(filePath) {
  return path.extname(filePath || '').toLowerCase();
}

function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(normalizeVideoExt(filePath));
}

function createDefaultProjectState(id, name) {
  const now = new Date().toISOString();
  const layers = ensureLayers([], DEFAULT_LAYER_COUNT);
  return {
    id,
    name,
    timeline: {
      zoom: DEFAULT_ZOOM,
      autoZoom: true,
      durationMs: DEFAULT_PROJECT_DURATION_MS,
      masterOrder: layers.map((layer) => layer.id),
      finalTrimInMs: 0,
      finalTrimOutMs: null,
    },
    selectedLayerId: layers[0]?.id || null,
    layers,
    lastRender: defaultRenderState(),
    createdAt: now,
    updatedAt: now,
  };
}

function defaultRenderState() {
  return {
    id: null,
    status: 'idle',
    logs: [],
    outputPath: null,
    startedAt: null,
    endedAt: null,
    error: null,
    queueSummary: defaultRenderQueueSummary(),
    queueJobs: [],
  };
}

function defaultRenderQueueSummary() {
  return {
    layerCount: 0,
    sourceSegmentCount: 0,
    consolidatedJobCount: 0,
    mutedSegmentCount: 0,
    completedJobCount: 0,
    failedJobCount: 0,
    runningJobCount: 0,
    pendingJobCount: 0,
  };
}

function mergeProjectState(current, incoming) {
  const now = new Date().toISOString();
  const hasIncomingLayers = Array.isArray(incoming.layers) && incoming.layers.length > 0;
  const incomingLayers = hasIncomingLayers ? incoming.layers : current.layers;
  const mappedLayers = incomingLayers.map((layer, index) => {
    const id = sanitizeLayerId(layer?.id, `layer-${index + 1}`);
    const name = String(layer?.name || `Layer ${index + 1}`).trim() || `Layer ${index + 1}`;
    return {
      id,
      name,
      clip: sanitizeClipState(layer?.clip),
      transcription: sanitizeTranscriptionState(layer?.transcription),
      clipping: sanitizeClippingState(layer?.clipping),
    };
  });
  const layers = ensureLayers(mappedLayers, DEFAULT_LAYER_COUNT);
  const defaultSelected = layers[0]?.id || null;
  const selectedLayerId = layers.some((layer) => layer.id === incoming.selectedLayerId)
    ? incoming.selectedLayerId
    : layers.some((layer) => layer.id === current.selectedLayerId)
      ? current.selectedLayerId
      : defaultSelected;
  const timeline = sanitizeTimeline(incoming.timeline, current.timeline, layers);
  return {
    id: current.id,
    name: sanitizeProjectName(incoming.name || current.name),
    timeline,
    selectedLayerId,
    layers,
    lastRender: sanitizeRenderState(current.lastRender || defaultRenderState()),
    createdAt: current.createdAt || now,
    updatedAt: now,
  };
}

function normalizePersistedProjectState(raw, fallbackId = null) {
  const now = new Date().toISOString();
  const id = sanitizeLayerId(raw?.id || fallbackId, '');
  if (!id) {
    return null;
  }
  const incomingLayers = Array.isArray(raw?.layers) ? raw.layers : [];
  const mappedLayers = incomingLayers.map((layer, index) => {
    const layerId = sanitizeLayerId(layer?.id, `layer-${index + 1}`);
    const name = String(layer?.name || `Layer ${index + 1}`).trim() || `Layer ${index + 1}`;
    return {
      id: layerId,
      name,
      clip: sanitizeClipState(layer?.clip),
      transcription: sanitizeTranscriptionState(layer?.transcription),
      clipping: sanitizeClippingState(layer?.clipping),
    };
  });
  const layers = ensureLayers(mappedLayers, DEFAULT_LAYER_COUNT);
  const timeline = sanitizeTimeline(raw?.timeline, raw?.timeline, layers);
  const selectedLayerId = layers.some((layer) => layer.id === raw?.selectedLayerId)
    ? raw.selectedLayerId
    : layers[0]?.id || null;
  const render = raw?.lastRender && typeof raw.lastRender === 'object' ? raw.lastRender : defaultRenderState();
  return {
    id,
    name: sanitizeProjectName(raw?.name),
    timeline,
    selectedLayerId,
    layers,
    lastRender: sanitizeRenderState(render),
    createdAt: raw?.createdAt || now,
    updatedAt: raw?.updatedAt || raw?.createdAt || now,
  };
}

function sanitizeRenderState(input) {
  const render = input && typeof input === 'object' ? input : {};
  const queueJobs = Array.isArray(render.queueJobs) ? render.queueJobs.map((job) => sanitizeRenderQueueJob(job)).filter(Boolean) : [];
  return {
    ...defaultRenderState(),
    ...render,
    logs: Array.isArray(render.logs) ? render.logs.slice(-200) : [],
    queueSummary: summarizeRenderQueueJobs(queueJobs, render.queueSummary),
    queueJobs,
  };
}

function sanitizeRenderQueueJob(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const startMs = toNonNegativeInt(input.startMs, 0);
  const endMs = toNonNegativeInt(input.endMs, startMs);
  if (endMs <= startMs) {
    return null;
  }
  const allowedStatus = new Set(['pending', 'running', 'completed', 'failed']);
  const sourceClipIds = Array.isArray(input.sourceClipIds)
    ? input.sourceClipIds.map((value) => sanitizeLayerId(value, '')).filter(Boolean)
    : [];
  return {
    id: sanitizeLayerId(input.id, ''),
    layerId: sanitizeLayerId(input.layerId, ''),
    status: allowedStatus.has(input.status) ? input.status : 'pending',
    startMs,
    endMs,
    durationMs: Math.max(0, endMs - startMs),
    sourceClipIds,
    sourceSegmentCount: Math.max(sourceClipIds.length, toPositiveInt(input.sourceSegmentCount, sourceClipIds.length || 1)),
    textPreview: typeof input.textPreview === 'string' ? input.textPreview : '',
    stagedPath: typeof input.stagedPath === 'string' ? input.stagedPath : null,
    startedAt: typeof input.startedAt === 'string' ? input.startedAt : null,
    endedAt: typeof input.endedAt === 'string' ? input.endedAt : null,
    error: typeof input.error === 'string' ? input.error : null,
  };
}

function summarizeRenderQueueJobs(queueJobs, summaryOverride = null) {
  const summary = {
    ...defaultRenderQueueSummary(),
    ...(summaryOverride && typeof summaryOverride === 'object' ? summaryOverride : {}),
  };
  summary.layerCount = Math.max(
    toNonNegativeInt(summary.layerCount, 0),
    new Set(queueJobs.map((job) => job.layerId).filter(Boolean)).size,
  );
  summary.sourceSegmentCount = Math.max(
    toNonNegativeInt(summary.sourceSegmentCount, 0),
    queueJobs.reduce((sum, job) => sum + Math.max(1, toPositiveInt(job.sourceSegmentCount, 1)), 0),
  );
  summary.consolidatedJobCount = Math.max(toNonNegativeInt(summary.consolidatedJobCount, 0), queueJobs.length);
  summary.completedJobCount = queueJobs.filter((job) => job.status === 'completed').length;
  summary.failedJobCount = queueJobs.filter((job) => job.status === 'failed').length;
  summary.runningJobCount = queueJobs.filter((job) => job.status === 'running').length;
  summary.pendingJobCount = queueJobs.filter((job) => job.status === 'pending').length;
  summary.mutedSegmentCount = toNonNegativeInt(summary.mutedSegmentCount, 0);
  return summary;
}

function sanitizeTimeline(incoming, current, layers) {
  const base = current || {};
  const zoomRaw = Number(incoming?.zoom ?? base.zoom ?? DEFAULT_ZOOM);
  const zoom = Number.isFinite(zoomRaw) ? clamp(zoomRaw, 0.01, 2.5) : DEFAULT_ZOOM;
  const autoZoomRaw = incoming?.autoZoom;
  const autoZoom =
    typeof autoZoomRaw === 'boolean' ? autoZoomRaw : typeof base?.autoZoom === 'boolean' ? Boolean(base.autoZoom) : true;
  const durationRaw = Number(incoming?.durationMs ?? base.durationMs ?? DEFAULT_PROJECT_DURATION_MS);
  const durationMs = Number.isFinite(durationRaw) ? Math.max(1000, Math.floor(durationRaw)) : DEFAULT_PROJECT_DURATION_MS;
  const layerIds = layers.map((layer) => layer.id);
  const orderInput = Array.isArray(incoming?.masterOrder) ? incoming.masterOrder : base.masterOrder;
  const order = [];
  for (const id of orderInput || []) {
    if (layerIds.includes(id) && !order.includes(id)) {
      order.push(id);
    }
  }
  for (const id of layerIds) {
    if (!order.includes(id)) {
      order.push(id);
    }
  }
  return {
    zoom,
    autoZoom,
    durationMs,
    masterOrder: order,
    finalTrimInMs: toNonNegativeInt(incoming?.finalTrimInMs ?? base.finalTrimInMs ?? 0),
    finalTrimOutMs: toNullableNonNegativeInt(incoming?.finalTrimOutMs ?? base.finalTrimOutMs ?? null),
  };
}

function findLayerForProject(project, layerId) {
  if (!project || !Array.isArray(project.layers)) {
    return null;
  }
  const requested = String(layerId || '').trim();
  return project.layers.find((item) => item.id === requested) || null;
}

function ensureLayers(layers, minimumCount = DEFAULT_LAYER_COUNT) {
  const normalized = Array.isArray(layers) ? layers.filter(Boolean) : [];
  const next = normalized.slice();
  const target = Math.max(1, Number(minimumCount) || 1);
  while (next.length < target) {
    const index = next.length + 1;
    next.push({
      id: `layer-${index}`,
      name: `Layer ${index}`,
      clip: null,
      transcription: null,
      clipping: null,
    });
  }
  return next;
}

function sanitizeTranscriptionState(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const allowedStatus = new Set(['idle', 'audio-ready', 'transcribed', 'error']);
  const status = allowedStatus.has(input.status) ? input.status : 'idle';
  return {
    provider: typeof input.provider === 'string' ? input.provider : 'openai',
    model: typeof input.model === 'string' ? input.model : 'whisper-1',
    status,
    audio: sanitizeTranscriptionAsset(input.audio),
    transcript: sanitizeTranscriptionAsset(input.transcript),
    markdown: sanitizeTranscriptionAsset(input.markdown),
    responseFormat: typeof input.responseFormat === 'string' ? input.responseFormat : null,
    timestampGranularities: Array.isArray(input.timestampGranularities)
      ? input.timestampGranularities.filter((value) => typeof value === 'string')
      : [],
    segmentCount: toNonNegativeInt(input.segmentCount, null),
    wordCount: toNonNegativeInt(input.wordCount, null),
    timelineMode: typeof input.timelineMode === 'string' ? input.timelineMode : null,
    timelineVisible: input.timelineVisible !== false,
    timelineSegments: sanitizeTimelineSegments(input.timelineSegments),
    textPreview: typeof input.textPreview === 'string' ? input.textPreview : null,
    error: typeof input.error === 'string' ? input.error : null,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
  };
}

function summarizeTranscriptPayload(payload) {
  const segments = Array.isArray(payload?.segments) ? payload.segments.filter(Boolean) : [];
  const words = Array.isArray(payload?.words) ? payload.words.filter(Boolean) : [];
  const timelineMode = segments.length
    ? segments.some((segment) => typeof segment?.speaker === 'string')
      ? 'diarized-segments'
      : 'segments'
    : words.length
    ? 'words'
    : 'text';
  return {
    segmentCount: segments.length || null,
    wordCount: words.length || null,
    timelineMode,
  };
}

function extractTimelineSegments(payload) {
  if (!Array.isArray(payload?.segments)) {
    return [];
  }
  return payload.segments
    .map((segment) => {
      const startMs = Math.max(0, Math.round(Number(segment?.start || 0) * 1000));
      const endMs = Math.max(startMs, Math.round(Number(segment?.end || 0) * 1000));
      const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
      if (!text || endMs <= startMs) {
        return null;
      }
      return {startMs, endMs, text};
    })
    .filter(Boolean);
}

function sanitizeTimelineSegments(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((segment) => {
      if (!segment || typeof segment !== 'object') {
        return null;
      }
      const startMs = toNonNegativeInt(segment.startMs, 0);
      const endMs = toNonNegativeInt(segment.endMs, startMs);
      const text = typeof segment.text === 'string' ? segment.text.trim() : '';
      if (!text || endMs <= startMs) {
        return null;
      }
      return {startMs, endMs, text};
    })
    .filter(Boolean);
}

function sanitizeTranscriptionAsset(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const sizeBytes = toNonNegativeInt(input.sizeBytes, null);
  return {
    path: typeof input.path === 'string' ? input.path : null,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : null,
  };
}

function sanitizeClipState(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const sourceVideoId = typeof input.sourceVideoId === 'string' ? input.sourceVideoId : null;
  const sourcePath = typeof input.sourcePath === 'string' ? input.sourcePath : null;
  const sourceDurationMs = toPositiveInt(input.sourceDurationMs);
  const startRawMs = toInt(input.startMs);
  let trimInMs = toNonNegativeInt(input.trimInMs);
  let trimOutMs = toNonNegativeInt(input.trimOutMs);
  let startMs = 0;
  if (sourceDurationMs > 0) {
    trimInMs = clamp(trimInMs, 0, sourceDurationMs);
    trimOutMs = clamp(trimOutMs || sourceDurationMs, trimInMs, sourceDurationMs);
    startMs = clamp(startRawMs, -trimInMs, 12 * 60 * 60 * 1000);
  } else {
    trimInMs = 0;
    trimOutMs = 0;
    startMs = 0;
  }
  const thumbnails = Array.isArray(input.thumbnails)
    ? input.thumbnails.filter((value) => typeof value === 'string')
    : [];
  if (!sourceVideoId) {
    return null;
  }
  return {
    sourceVideoId,
    sourcePath,
    sourceDurationMs,
    startMs,
    trimInMs,
    trimOutMs,
    thumbnails,
  };
}

function sanitizeClippingState(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const clips = Array.isArray(input.clips)
    ? input.clips.map((clip) => sanitizeClippingClipState(clip)).filter(Boolean)
    : [];
  const selectedClipId = clips.some((clip) => clip.id === input.selectedClipId)
    ? input.selectedClipId
    : clips[0]?.id || null;
  return {
    selectedClipId,
    clips,
  };
}

function sanitizeClippingClipState(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const id = sanitizeLayerId(input.id, '');
  const startMs = toNonNegativeInt(input.startMs, 0);
  const endMs = toNonNegativeInt(input.endMs, startMs);
  const text = typeof input.text === 'string' ? input.text : '';
  if (!id || endMs <= startMs) {
    return null;
  }
  return {
    id,
    startMs,
    endMs,
    text,
    muted: Boolean(input.muted),
  };
}

function toPositiveInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return Math.floor(num);
}

function toInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.floor(num);
}

function toNonNegativeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return fallback;
  }
  return Math.floor(num);
}

function toNullableNonNegativeInt(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return toNonNegativeInt(value, fallback === null ? 0 : fallback);
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function projectStatePath(projectId) {
  const safeId = sanitizeLayerId(projectId, '');
  if (!safeId) {
    throw new Error('Invalid project id');
  }
  return path.join(EDITOR_PROJECTS_DIR, `${safeId}.json`);
}

async function loadEditorIndex() {
  const json = await readJson(EDITOR_INDEX_PATH, {version: 1, projects: []});
  const projects = Array.isArray(json?.projects) ? json.projects : [];
  return {
    version: 1,
    projects: projects.filter(Boolean),
  };
}

async function appendProjectToIndex(project) {
  const index = await loadEditorIndex();
  const entry = projectToIndexEntry(project);
  index.projects = [entry, ...index.projects.filter((item) => item.id !== project.id)];
  await writeJson(EDITOR_INDEX_PATH, index);
}

async function updateProjectMetaInIndex(project) {
  const index = await loadEditorIndex();
  const entry = projectToIndexEntry(project);
  const exists = index.projects.some((item) => item.id === project.id);
  index.projects = exists
    ? index.projects.map((item) => (item.id === project.id ? entry : item))
    : [entry, ...index.projects];
  await writeJson(EDITOR_INDEX_PATH, index);
}

function projectToIndexEntry(project) {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    stateFile: `db/editor/projects/${project.id}.json`,
  };
}

async function loadProjectState(projectId) {
  const statePath = projectStatePath(projectId);
  const data = await readJson(statePath, null);
  if (!data) {
    return null;
  }
  return normalizePersistedProjectState(data, projectId);
}

async function saveProjectState(state) {
  const statePath = projectStatePath(state.id);
  await fs.mkdir(path.dirname(statePath), {recursive: true});
  await writeJson(statePath, state);
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function safeReaddir(dirPath, options = {}) {
  try {
    return await fs.readdir(dirPath, options);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function listConvertedMedia() {
  const projects = await safeReaddir(INPUT_DIR, {withFileTypes: true});
  const mediaItems = [];
  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    const inputProjectId = entry.name;
    const outputsDir = path.join(INPUT_DIR, inputProjectId, 'outputs');
    const files = await safeReaddir(outputsDir, {withFileTypes: true});
    for (const file of files) {
      if (!file.isFile() || !isVideoFile(file.name)) continue;
      const absolutePath = path.join(outputsDir, file.name);
      const stats = await fs.stat(absolutePath);
      const probe = await probeVideo(absolutePath);
      const rel = path.posix.join(inputProjectId, 'outputs', file.name);
      mediaItems.push({
        id: rel,
        filename: file.name,
        sourceProjectId: inputProjectId,
        path: `/media/input/${encodeURIComponent(inputProjectId)}/outputs/${encodeURIComponent(file.name)}`,
        size: stats.size,
        modifiedAt: stats.mtime,
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
      });
    }
  }
  mediaItems.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return mediaItems;
}

function resolveSourceVideoPath(sourceVideoId) {
  const normalized = path.posix.normalize(String(sourceVideoId || ''));
  if (!normalized || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error('Invalid source video id');
  }
  const absolute = path.resolve(INPUT_DIR, normalized);
  const inputPrefix = `${INPUT_DIR}${path.sep}`;
  if (!absolute.startsWith(inputPrefix)) {
    throw new Error('Source path escapes input directory');
  }
  return absolute;
}

async function probeVideo(filePath) {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration,size:stream=index,codec_type,codec_name,width,height',
    '-of',
    'json',
    filePath,
  ];
  const {stdout} = await execBinary('ffprobe', args, {captureStdout: true});
  const parsed = JSON.parse(stdout || '{}');
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video') || streams[0] || {};
  const durationSec = Number(parsed.format?.duration || 0);
  return {
    durationMs: durationSec > 0 ? Math.round(durationSec * 1000) : 0,
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    codec: video.codec_name || null,
  };
}

async function createThumbnails({projectId, layerId, sourceVideoId, sourcePath, count}) {
  const safeLayerId = sanitizeLayerId(layerId);
  const thumbDir = path.join(EDITOR_PROJECTS_DIR, projectId, 'thumbs', safeLayerId);
  await fs.rm(thumbDir, {recursive: true, force: true});
  await fs.mkdir(thumbDir, {recursive: true});
  const probe = await probeVideo(sourcePath);
  const durationMs = Math.max(1, probe.durationMs || 1);
  const total = clamp(Number(count) || THUMBNAIL_COUNT, 3, 16);
  const urls = [];
  for (let i = 0; i < total; i += 1) {
    const ratio = total === 1 ? 0 : i / (total - 1);
    const timestampSec = (durationMs * ratio) / 1000;
    const name = `thumb-${String(i + 1).padStart(2, '0')}.jpg`;
    const outPath = path.join(thumbDir, name);
    const args = [
      '-y',
      '-ss',
      timestampSec.toFixed(3),
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-q:v',
      '4',
      '-vf',
      'scale=220:-1',
      outPath,
    ];
    await runFfmpegConsole(args, `editor-thumbs:${projectId}:${safeLayerId}`);
    urls.push(`/media/editor/projects/${encodeURIComponent(projectId)}/thumbs/${encodeURIComponent(safeLayerId)}/${encodeURIComponent(name)}`);
  }
  const project = await loadProjectState(projectId);
  if (!project) {
    return urls;
  }
  const layer = project.layers.find((item) => item.id === layerId);
  if (layer && layer.clip && layer.clip.sourceVideoId === sourceVideoId) {
    layer.clip.thumbnails = urls;
    project.updatedAt = new Date().toISOString();
    await saveProjectState(project);
    await updateProjectMetaInIndex(project);
  }
  return urls;
}

function createRenderJob(projectId, renderPlan) {
  const startedAt = new Date().toISOString();
  const queueJobs = Array.isArray(renderPlan?.queueJobs)
    ? renderPlan.queueJobs.map((queueJob) => ({
        ...queueJob,
        status: 'pending',
        stagedPath: null,
        startedAt: null,
        endedAt: null,
        error: null,
      }))
    : [];
  return {
    id: `render-${crypto.randomUUID()}`,
    projectId,
    status: 'running',
    logs: [`[${startedAt}] Render started`],
    outputPath: null,
    error: null,
    startedAt,
    endedAt: null,
    layerPlans: Array.isArray(renderPlan?.layers) ? renderPlan.layers : [],
    queueSummary: summarizeRenderQueueJobs(queueJobs, renderPlan?.queueSummary),
    queueJobs,
  };
}

function toPublicRenderState(job) {
  return {
    id: job.id,
    status: job.status,
    logs: job.logs,
    outputPath: job.outputPath,
    error: job.error,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    queueSummary: summarizeRenderQueueJobs(job.queueJobs || [], job.queueSummary),
    queueJobs: Array.isArray(job.queueJobs) ? job.queueJobs : [],
  };
}

async function runRenderJob(projectState, job) {
  const projectId = projectState.id;
  const renderStateOnStart = {
    ...defaultRenderState(),
    ...toPublicRenderState(job),
  };
  await updateProjectRenderState(projectId, renderStateOnStart);
  try {
    const renderRoot = path.join(EDITOR_PROJECTS_DIR, projectId, 'renders', job.id);
    const resolvedLayers = await renderProjectLayers(projectState, job, renderRoot);
    if (!resolvedLayers.length) {
      throw new Error('No active layer clips configured for rendering');
    }
    logRender(job, `Resolved ${resolvedLayers.length} layer output(s)`);
    const finalName = `${projectId}-${job.id}.mp4`;
    const finalPath = path.join(renderRoot, finalName);
    const finalComposition = await composeResolvedLayers(projectState, resolvedLayers, job, renderRoot);
    logRender(job, `Final duration=${finalComposition.durationMs}ms`);
    await fs.copyFile(finalComposition.outputPath, finalPath);
    job.status = 'completed';
    job.endedAt = new Date().toISOString();
    job.outputPath = `/media/editor/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(job.id)}/${encodeURIComponent(finalName)}`;
    logRender(job, 'Render completed');
    await updateProjectRenderState(projectId, toPublicRenderState(job));
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.endedAt = new Date().toISOString();
    logRender(job, `Render failed: ${error.message}`);
    await updateProjectRenderState(projectId, toPublicRenderState(job));
  } finally {
    if (job.status !== 'running') {
      setTimeout(() => {
        const current = renderJobs.get(projectId);
        if (current && current.id === job.id) {
          renderJobs.delete(projectId);
        }
      }, 10 * 60 * 1000);
    }
  }
}

async function updateProjectRenderState(projectId, renderState) {
  const project = await loadProjectState(projectId);
  if (!project) {
    return;
  }
  project.lastRender = sanitizeRenderState(renderState);
  project.updatedAt = new Date().toISOString();
  await saveProjectState(project);
  await updateProjectMetaInIndex(project);
}

async function reconcilePersistedRenderIfNeeded(project) {
  const persisted = project?.lastRender || defaultRenderState();
  if (persisted.status !== 'running') {
    return project;
  }
  const inMemory = renderJobs.get(project.id);
  if (inMemory && inMemory.status === 'running') {
    return project;
  }
  const hasLiveProcess = await hasLiveFfmpegRenderProcess(project.id, persisted.id);
  if (hasLiveProcess) {
    return project;
  }
  const now = new Date().toISOString();
  const logs = Array.isArray(persisted.logs) ? persisted.logs.slice(-200) : [];
  logs.push(`[${now}] Render interrupted or server restarted. No active ffmpeg process detected.`);
  const queueJobs = Array.isArray(persisted.queueJobs)
    ? persisted.queueJobs.map((item) =>
        item?.status === 'running'
          ? {
              ...item,
              status: 'failed',
              endedAt: item.endedAt || now,
              error: item.error || 'Render interrupted',
            }
          : item,
      )
    : [];
  project.lastRender = sanitizeRenderState({
    ...persisted,
    status: 'failed',
    error: persisted.error || 'Render interrupted',
    endedAt: persisted.endedAt || now,
    logs: logs.slice(-200),
    queueJobs,
  });
  project.updatedAt = now;
  await saveProjectState(project);
  await updateProjectMetaInIndex(project);
  return project;
}

async function hasLiveFfmpegRenderProcess(projectId, renderId) {
  if (!projectId || !renderId) {
    return false;
  }
  const markerRel = path
    .posix.join('db', 'editor', 'projects', projectId, 'renders', renderId)
    .toLowerCase();
  try {
    const {stdout} = await execBinary('ps', ['-eo', 'args='], {captureStdout: true});
    const lines = String(stdout || '').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const normalized = line.replaceAll('\\', '/').toLowerCase();
      if (normalized.includes('ffmpeg') && normalized.includes(markerRel)) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.warn(`Process scan failed while reconciling render state: ${error.message}`);
    return false;
  }
}

function createRenderPlan(project) {
  const order = Array.isArray(project.timeline?.masterOrder) ? project.timeline.masterOrder : [];
  const layerOrder = order.length ? order : project.layers.map((layer) => layer.id);
  const orderRank = new Map(layerOrder.map((id, index) => [id, index]));
  const layers = [];
  const queueJobs = [];
  let sourceSegmentCount = 0;
  let mutedSegmentCount = 0;
  let queueOrdinal = 0;
  for (const layer of project.layers) {
    if (!layer.clip || !layer.clip.sourceVideoId) continue;
    const sourcePath = resolveSourceVideoPath(layer.clip.sourceVideoId);
    const sourceSegments = collectLayerSourceRenderSegments(layer);
    mutedSegmentCount += sourceSegments.mutedSegmentCount;
    sourceSegmentCount += sourceSegments.activeSegments.length;
    const consolidatedJobs = consolidateLayerRenderJobs(layer.id, sourceSegments.activeSegments);
    if (!consolidatedJobs.length) continue;
    const layerQueueJobs = consolidatedJobs.map((queueJob) => {
      queueOrdinal += 1;
      return {
        id: `job-${String(queueOrdinal).padStart(3, '0')}`,
        layerId: layer.id,
        status: 'pending',
        startMs: queueJob.startMs,
        endMs: queueJob.endMs,
        durationMs: queueJob.endMs - queueJob.startMs,
        sourceClipIds: queueJob.sourceClipIds,
        sourceSegmentCount: queueJob.sourceClipIds.length,
        textPreview: queueJob.textPreview,
        stagedPath: null,
        startedAt: null,
        endedAt: null,
        error: null,
      };
    });
    layers.push({
      layerId: layer.id,
      sourcePath,
      startMs: toInt(layer.clip.startMs),
      orderRank: orderRank.has(layer.id) ? orderRank.get(layer.id) : Number.MAX_SAFE_INTEGER,
      queueJobIds: layerQueueJobs.map((queueJob) => queueJob.id),
    });
    queueJobs.push(...layerQueueJobs);
  }
  const sortedLayers = layers.sort((a, b) => {
    if (a.orderRank !== b.orderRank) {
      return a.orderRank - b.orderRank;
    }
    return 0;
  });
  return {
    layers: sortedLayers,
    queueJobs,
    queueSummary: summarizeRenderQueueJobs(queueJobs, {
      layerCount: sortedLayers.length,
      sourceSegmentCount,
      consolidatedJobCount: queueJobs.length,
      mutedSegmentCount,
    }),
  };
}

function collectLayerSourceRenderSegments(layer) {
  const sourceDurationMs = toPositiveInt(layer?.clip?.sourceDurationMs);
  if (sourceDurationMs <= 0) {
    return {activeSegments: [], mutedSegmentCount: 0};
  }
  const clipping = layer?.clipping;
  if (clipping && Array.isArray(clipping.clips) && clipping.clips.length) {
    const activeSegments = [];
    let mutedSegmentCount = 0;
    for (let index = 0; index < clipping.clips.length; index += 1) {
      const clip = clipping.clips[index];
      const startMs = clamp(toNonNegativeInt(clip?.startMs, 0), 0, sourceDurationMs);
      const endMs = clamp(toNonNegativeInt(clip?.endMs, startMs), startMs, sourceDurationMs);
      if (endMs <= startMs) {
        continue;
      }
      if (clip?.muted) {
        mutedSegmentCount += 1;
        continue;
      }
      activeSegments.push({
        clipId: clip?.id || `clip-${index + 1}`,
        startMs,
        endMs,
        text: typeof clip?.text === 'string' ? clip.text : '',
      });
    }
    return {activeSegments, mutedSegmentCount};
  }
  const trimInMs = clamp(toNonNegativeInt(layer?.clip?.trimInMs, 0), 0, sourceDurationMs);
  const trimOutMs = clamp(toNonNegativeInt(layer?.clip?.trimOutMs, sourceDurationMs), trimInMs, sourceDurationMs);
  if (trimOutMs <= trimInMs) {
    return {activeSegments: [], mutedSegmentCount: 0};
  }
  return {
    activeSegments: [
      {
        clipId: 'clip-001',
        startMs: trimInMs,
        endMs: trimOutMs,
        text: '',
      },
    ],
    mutedSegmentCount: 0,
  };
}

function consolidateLayerRenderJobs(layerId, activeSegments) {
  const segments = Array.isArray(activeSegments)
    ? activeSegments
        .filter(Boolean)
        .slice()
        .sort((a, b) => {
          if (a.startMs !== b.startMs) {
            return a.startMs - b.startMs;
          }
          return a.endMs - b.endMs;
        })
    : [];
  if (!segments.length) {
    return [];
  }
  const layers = [];
  let current = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!current) {
      current = {
        id: `${sanitizeLayerId(layerId)}-segment-${String(index + 1).padStart(3, '0')}`,
        startMs: segment.startMs,
        endMs: segment.endMs,
        sourceClipIds: [segment.clipId],
        textSnippets: segment.text ? [segment.text] : [],
      };
      continue;
    }
    if (segment.startMs <= current.endMs) {
      current.endMs = Math.max(current.endMs, segment.endMs);
      current.sourceClipIds.push(segment.clipId);
      if (segment.text) {
        current.textSnippets.push(segment.text);
      }
      continue;
    }
    layers.push(finalizeConsolidatedLayerRenderJob(current));
    current = {
      id: `${sanitizeLayerId(layerId)}-segment-${String(index + 1).padStart(3, '0')}`,
      startMs: segment.startMs,
      endMs: segment.endMs,
      sourceClipIds: [segment.clipId],
      textSnippets: segment.text ? [segment.text] : [],
    };
  }
  if (current) {
    layers.push(finalizeConsolidatedLayerRenderJob(current));
  }
  return layers;
}

function finalizeConsolidatedLayerRenderJob(item) {
  const snippets = Array.isArray(item.textSnippets)
    ? item.textSnippets.map((text) => String(text || '').trim()).filter(Boolean)
    : [];
  const textPreview = snippets.slice(0, 2).join(' / ');
  return {
    id: item.id,
    startMs: item.startMs,
    endMs: item.endMs,
    sourceClipIds: item.sourceClipIds,
    textPreview: textPreview.length > 140 ? `${textPreview.slice(0, 137)}...` : textPreview,
  };
}

function updateRenderQueueJob(job, queueJobId, patch) {
  if (!Array.isArray(job?.queueJobs)) {
    return null;
  }
  const queueJob = job.queueJobs.find((item) => item.id === queueJobId);
  if (!queueJob) {
    return null;
  }
  Object.assign(queueJob, patch);
  job.queueSummary = summarizeRenderQueueJobs(job.queueJobs, job.queueSummary);
  return queueJob;
}

async function renderProjectLayers(project, job, renderRoot) {
  const layerPlans = Array.isArray(job.layerPlans) && job.layerPlans.length ? job.layerPlans : createRenderPlan(project).layers;
  const queueJobsById = new Map((job.queueJobs || []).map((queueJob) => [queueJob.id, queueJob]));
  const resolvedLayers = [];
  for (let layerIndex = 0; layerIndex < layerPlans.length; layerIndex += 1) {
    const layerPlan = layerPlans[layerIndex];
    const layerDir = path.join(renderRoot, 'layers', sanitizeLayerId(layerPlan.layerId, `layer-${layerIndex + 1}`));
    const stageDir = path.join(layerDir, 'stage');
    await fs.mkdir(stageDir, {recursive: true});
    const layerQueueJobs = (layerPlan.queueJobIds || [])
      .map((queueJobId) => queueJobsById.get(queueJobId))
      .filter(Boolean);
    const layerSourceSegmentCount = layerQueueJobs.reduce(
      (sum, queueJob) => sum + Math.max(1, toPositiveInt(queueJob.sourceSegmentCount, 1)),
      0,
    );
    logRender(
      job,
      `Layer ${layerPlan.layerId}: rendering ${layerQueueJobs.length} consolidated job(s) from ${layerSourceSegmentCount} source segment(s)`,
    );
    const stagedPaths = [];
    for (let clipIndex = 0; clipIndex < layerQueueJobs.length; clipIndex += 1) {
      const clipJob = layerQueueJobs[clipIndex];
      const stagedPath = path.join(stageDir, `${sanitizeLayerId(clipJob.id, `job-${clipIndex + 1}`)}.mp4`);
      updateRenderQueueJob(job, clipJob.id, {
        status: 'running',
        stagedPath,
        startedAt: new Date().toISOString(),
        endedAt: null,
        error: null,
      });
      await updateProjectRenderState(job.projectId, toPublicRenderState(job));
      logRender(
        job,
        `Layer ${layerPlan.layerId} job ${clipIndex + 1}: trim ${clipJob.startMs}-${clipJob.endMs}ms from ${clipJob.sourceSegmentCount} segment(s)${clipJob.textPreview ? ` text="${clipJob.textPreview.slice(0, 60)}"` : ''}`,
      );
      try {
        await runFfmpegLogged(
          [
            '-y',
            '-ss',
            msToSec(clipJob.startMs),
            '-to',
            msToSec(clipJob.endMs),
            '-i',
            layerPlan.sourcePath,
            '-vf',
            'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,fps=30',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            stagedPath,
          ],
          job,
        );
        updateRenderQueueJob(job, clipJob.id, {
          status: 'completed',
          stagedPath,
          endedAt: new Date().toISOString(),
          error: null,
        });
      } catch (error) {
        updateRenderQueueJob(job, clipJob.id, {
          status: 'failed',
          stagedPath,
          endedAt: new Date().toISOString(),
          error: error.message,
        });
        await updateProjectRenderState(job.projectId, toPublicRenderState(job));
        throw error;
      }
      await updateProjectRenderState(job.projectId, toPublicRenderState(job));
      stagedPaths.push(stagedPath);
    }
    const resolvedPath = path.join(layerDir, `${sanitizeLayerId(layerPlan.layerId)}-resolved.mp4`);
    logRender(job, `Layer ${layerPlan.layerId}: concatenating staged clips`);
    await concatRenderedFiles(stagedPaths, resolvedPath, job, layerDir);
    resolvedLayers.push({
      layerId: layerPlan.layerId,
      resolvedPath,
      durationMs: layerQueueJobs.reduce((sum, clip) => sum + (clip.endMs - clip.startMs), 0),
      startMs: layerPlan.startMs,
      orderRank: layerPlan.orderRank,
    });
  }
  return resolvedLayers.sort((a, b) => a.orderRank - b.orderRank);
}

async function composeResolvedLayers(project, resolvedLayers, job, renderRoot) {
  if (resolvedLayers.length === 1) {
    logRender(job, `Single active layer ${resolvedLayers[0].layerId}: using resolved layer output directly`);
    return {
      outputPath: resolvedLayers[0].resolvedPath,
      durationMs: resolvedLayers[0].durationMs,
    };
  }
  const visibilityPlan = resolveVisibleLayerSequence(resolvedLayers);
  if (!visibilityPlan.length) {
    throw new Error('No visible layer output remained after overlap resolution');
  }
  const finalStageDir = path.join(renderRoot, 'final-stage');
  await fs.mkdir(finalStageDir, {recursive: true});
  const stagedPaths = [];
  for (let index = 0; index < visibilityPlan.length; index += 1) {
    const visible = visibilityPlan[index];
    const outputPath = path.join(finalStageDir, `visible-${String(index + 1).padStart(3, '0')}.mp4`);
    logRender(
      job,
      `Final selection ${index + 1}: layer=${visible.layerId} start=${visible.startMs}ms end=${visible.endMs}ms visibleDuration=${visible.visibleDurationMs}ms`,
    );
    await runFfmpegLogged(
      [
        '-y',
        '-ss',
        msToSec(0),
        '-to',
        msToSec(visible.visibleDurationMs),
        '-i',
        visible.resolvedPath,
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      job,
    );
    stagedPaths.push(outputPath);
  }
  const finalSequencePath = path.join(renderRoot, 'final-sequence.mp4');
  logRender(job, 'Concatenating visible layer outputs');
  await concatRenderedFiles(stagedPaths, finalSequencePath, job, finalStageDir);
  return {
    outputPath: finalSequencePath,
    durationMs: visibilityPlan.reduce((sum, item) => sum + item.visibleDurationMs, 0),
  };
}

function resolveVisibleLayerSequence(resolvedLayers) {
  const ordered = resolvedLayers
    .map((layer) => ({
      ...layer,
      endMs: layer.startMs + layer.durationMs,
    }))
    .sort((a, b) => {
      if (a.startMs !== b.startMs) {
        return a.startMs - b.startMs;
      }
      return b.orderRank - a.orderRank;
    });
  const visible = [];
  for (const layer of ordered) {
    const coveredByHigher = ordered.some(
      (other) =>
        other.layerId !== layer.layerId &&
        other.orderRank > layer.orderRank &&
        other.startMs <= layer.startMs &&
        other.endMs > layer.startMs,
    );
    if (coveredByHigher) {
      continue;
    }
    let endMs = layer.endMs;
    for (const other of ordered) {
      if (other.layerId === layer.layerId) continue;
      if (other.orderRank <= layer.orderRank) continue;
      if (other.startMs <= layer.startMs) continue;
      if (other.startMs >= endMs) continue;
      endMs = Math.min(endMs, other.startMs);
    }
    const visibleDurationMs = endMs - layer.startMs;
    if (visibleDurationMs <= 0) {
      continue;
    }
    visible.push({
      layerId: layer.layerId,
      resolvedPath: layer.resolvedPath,
      startMs: layer.startMs,
      endMs,
      visibleDurationMs,
      orderRank: layer.orderRank,
    });
  }
  return visible.sort((a, b) => a.startMs - b.startMs);
}

async function concatRenderedFiles(inputPaths, outputPath, job, workdir) {
  if (!inputPaths.length) {
    throw new Error('No staged clips available for concatenation');
  }
  const concatListPath = path.join(workdir, `concat-${path.basename(outputPath, path.extname(outputPath))}.txt`);
  const concatContents = inputPaths.map((filePath) => `file '${filePath.replaceAll("'", "'\\''")}'`).join('\n');
  await fs.writeFile(concatListPath, `${concatContents}\n`, 'utf8');
  await runFfmpegLogged(
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    job,
  );
}

function logRender(job, line) {
  const now = new Date().toISOString();
  job.logs.push(`[${now}] ${line}`);
  if (job.logs.length > 200) {
    job.logs.splice(0, job.logs.length - 200);
  }
}

function msToSec(ms) {
  return (Number(ms || 0) / 1000).toFixed(3);
}

async function runFfmpegLogged(args, job) {
  const context = `editor-render:${job.projectId}:${job.id}`;
  console.log(`[${context}] ${formatCommand('ffmpeg', args)}`);
  await execBinary('ffmpeg', args, {
    onStderrLine: (line) => {
      if (!line) return;
      const compact = line.length > 180 ? `${line.slice(0, 177)}...` : line;
      logRender(job, compact);
      console.log(`[${context}] ${compact}`);
    },
  });
}

async function runFfmpegConsole(args, context) {
  const safeContext = context || 'editor-ffmpeg';
  console.log(`[${safeContext}] ${formatCommand('ffmpeg', args)}`);
  await execBinary('ffmpeg', args, {
    onStderrLine: (line) => {
      if (!line) return;
      const compact = line.length > 180 ? `${line.slice(0, 177)}...` : line;
      console.log(`[${safeContext}] ${compact}`);
    },
  });
}

function formatCommand(command, args) {
  return `${command} ${args.map((arg) => String(arg)).join(' ')}`.trim();
}

async function execBinary(command, args, options = {}) {
  const captureStdout = Boolean(options.captureStdout);
  const stdoutChunks = [];
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', reject);
    child.stdout.on('data', (chunk) => {
      if (captureStdout) {
        stdoutChunks.push(chunk);
      }
    });
    let stderrBuffer = '';
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      let newLineIndex = stderrBuffer.indexOf('\n');
      while (newLineIndex >= 0) {
        const line = stderrBuffer.slice(0, newLineIndex).trim();
        stderrBuffer = stderrBuffer.slice(newLineIndex + 1);
        if (options.onStderrLine) {
          options.onStderrLine(line);
        }
        newLineIndex = stderrBuffer.indexOf('\n');
      }
    });
    child.on('close', (code) => {
      const remaining = stderrBuffer.trim();
      if (remaining && options.onStderrLine) {
        options.onStderrLine(remaining);
      }
      if (code === 0) {
        resolve({
          stdout: captureStdout ? Buffer.concat(stdoutChunks).toString('utf8') : '',
        });
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}
