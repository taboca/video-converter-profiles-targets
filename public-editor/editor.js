(function () {
  const state = {
    projects: [],
    media: [],
    activeProjectId: null,
    project: null,
    projectDirty: false,
    transcriptionBusyLayerId: null,
    transcriptionBusyAction: null,
    transcriptionViewerLayerId: null,
    transcriptionTextCache: new Map(),
    saveStatus: 'saved',
    renderPollTimer: null,
    drag: null,
    thumbnailBusyLayerId: null,
    activeContextTab: 'tools',
    videoPanelExpanded: true,
    transcriberPanelExpanded: true,
    clippingPanelExpanded: false,
    isZoomAuto: true,
    previewPlayback: {
      layerId: null,
      currentTimeMs: 0,
      rafId: null,
      playing: false,
    },
    timelinePan: null,
    clipViewPan: null,
    clipViewScrollLeft: 0,
    clipViewScrollTop: 0,
    suppressClipSelectionClick: false,
  };

  const elements = {
    createProjectForm: document.getElementById('create-project-form'),
    createProjectName: document.getElementById('create-project-name'),
    projectSummary: document.getElementById('project-summary'),
    projectList: document.getElementById('project-list'),
    zoomRange: document.getElementById('zoom-range'),
    zoomOutBtn: document.getElementById('zoom-out-btn'),
    zoomInBtn: document.getElementById('zoom-in-btn'),
    zoomLabel: document.getElementById('zoom-label'),
    timelineWrap: document.getElementById('timeline-wrap'),
    timelineContent: document.getElementById('timeline-content'),
    timelinePanel: document.getElementById('timeline-view-panel'),
    centerRenderPanel: document.getElementById('center-render-panel'),
    addLayerBtn: document.getElementById('add-layer-btn'),
    renderPanel: document.getElementById('render-panel'),
    saveProjectBtn: document.getElementById('save-project-btn'),
    saveStateBadge: document.getElementById('save-state-badge'),
    renderBadge: document.getElementById('render-badge'),
    renderLogs: document.getElementById('render-logs'),
    renderQueueList: document.getElementById('render-queue-list'),
    renderQueueCaption: document.getElementById('render-queue-caption'),
    toolsTabBtn: document.getElementById('tools-tab-btn'),
    renderTabBtn: document.getElementById('render-tab-btn'),
    toolsTabPanel: document.getElementById('tools-tab-panel'),
    renderTabPanel: document.getElementById('render-tab-panel'),
    renderTabBody: document.getElementById('render-tab-body'),
    videoPanel: document.getElementById('video-panel'),
    transcriberPanel: document.getElementById('transcriber-panel'),
    clippingPanel: document.getElementById('clipping-panel'),
    videoPanelCollapseBtn: document.getElementById('video-panel-collapse-btn'),
    transcriberPanelCollapseBtn: document.getElementById('transcriber-panel-collapse-btn'),
    clippingPanelCollapseBtn: document.getElementById('clipping-panel-collapse-btn'),
    videoPanelTitle: document.getElementById('video-panel-title'),
    videoSourcePanelContent: document.getElementById('video-source-content'),
    transcriberPanelTitle: document.getElementById('transcriber-title'),
    transcriberPanelContent: document.getElementById('transcriber-content'),
    clippingPanelTitle: document.getElementById('clipping-title'),
    clippingPanelContent: document.getElementById('clipping-content'),
  };

  const transcribeCaptionerService = {
    async extractAudio(projectId, layerId) {
      return api(`/api/editor/transcribe/${encodeURIComponent(projectId)}/${encodeURIComponent(layerId)}/audio`, {
        method: 'POST',
      });
    },
    async runTranscription(projectId, layerId) {
      return api(`/api/editor/transcribe/${encodeURIComponent(projectId)}/${encodeURIComponent(layerId)}/transcript`, {
        method: 'POST',
        body: {
          model: 'whisper-1',
          responseFormat: 'verbose_json',
          timestampGranularities: ['segment'],
        },
      });
    },
    async fetchTranscription(projectId, layerId) {
      return api(`/api/editor/transcribe/${encodeURIComponent(projectId)}/${encodeURIComponent(layerId)}`);
    },
    async exportMarkdown(projectId, layerId, enabled = true) {
      return api(`/api/editor/transcribe/${encodeURIComponent(projectId)}/${encodeURIComponent(layerId)}/markdown`, {
        method: 'POST',
        body: {enabled},
      });
    },
    hasAudio(layer) {
      return Boolean(layer?.transcription?.audio?.path);
    },
    canTranscribe(layer) {
      return Boolean(layer?.transcription?.audio?.path);
    },
    isTranscribed(layer) {
      return layer?.transcription?.status === 'transcribed';
    },
    getStatus(layer) {
      return layer?.transcription?.status || 'idle';
    },
  };

  init().catch((error) => {
    console.error(error);
    elements.renderLogs.textContent = `Failed to initialize editor: ${error.message}`;
  });

  async function init() {
    wireEvents();
    await refreshMedia();
    await refreshProjects();
    if (state.activeProjectId) {
      await loadProject(state.activeProjectId);
      await refreshRenderStatus();
    } else {
      renderAll();
    }
  }

  function wireEvents() {
    elements.createProjectForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = (elements.createProjectName.value || '').trim();
      try {
        const data = await api('/api/editor/projects', {
          method: 'POST',
          body: {name},
        });
        elements.createProjectName.value = '';
        state.project = normalizeProject(data.project);
        state.activeProjectId = state.project.id;
        state.isZoomAuto = true;
        if (state.project?.timeline) {
          state.project.timeline.autoZoom = true;
        }
        markProjectClean();
        renderAll();
        await refreshProjects();
        await refreshRenderStatus();
      } catch (error) {
        console.error(error);
        elements.renderLogs.textContent = `Project create failed: ${error.message}`;
      }
    });

    elements.zoomRange.addEventListener('input', () => {
      applyManualZoom(Number(elements.zoomRange.value));
    });

    elements.zoomOutBtn?.addEventListener('click', () => {
      stepZoom(-1);
    });

    elements.zoomInBtn?.addEventListener('click', () => {
      stepZoom(1);
    });

    elements.addLayerBtn.addEventListener('click', () => {
      if (!state.project) return;
      const nextIndex = state.project.layers.length + 1;
      const layerId = uniqueLayerId(state.project.layers, `layer-${nextIndex}`);
      state.project.layers.push({
        id: layerId,
        name: `Layer ${nextIndex}`,
        clip: null,
        transcription: null,
        clipping: null,
      });
      if (!Array.isArray(state.project.timeline.masterOrder)) {
        state.project.timeline.masterOrder = [];
      }
      state.project.timeline.masterOrder.push(layerId);
      state.project.selectedLayerId = layerId;
      renderAll();
      markProjectDirty();
    });

    elements.saveProjectBtn.addEventListener('click', async () => {
      if (!state.project || !state.projectDirty || state.saveStatus === 'saving') return;
      try {
        await saveProject();
      } catch (error) {
        console.error(error);
        elements.renderLogs.textContent = `Project save failed: ${error.message}`;
      }
    });

    elements.toolsTabBtn?.addEventListener('click', () => {
      state.activeContextTab = 'tools';
      renderAll();
    });
    elements.renderTabBtn?.addEventListener('click', () => {
      state.activeContextTab = 'render';
      renderAll();
    });
    elements.videoPanelCollapseBtn?.addEventListener('click', () => {
      if (state.activeContextTab !== 'tools') return;
      state.videoPanelExpanded = !state.videoPanelExpanded;
      applyContextPanelVisibility();
    });
    elements.transcriberPanelCollapseBtn?.addEventListener('click', () => {
      if (state.activeContextTab !== 'tools') return;
      state.transcriberPanelExpanded = !state.transcriberPanelExpanded;
      renderAll();
    });
    elements.clippingPanelCollapseBtn?.addEventListener('click', () => {
      if (state.activeContextTab !== 'tools') return;
      state.clippingPanelExpanded = !state.clippingPanelExpanded;
      renderAll();
    });

    window.addEventListener('resize', () => {
      if (!state.project || !state.isZoomAuto) return;
      syncTimelineZoom();
      renderTimeline();
    });
  }

  async function startRender() {
    if (!state.project) return;
    state.activeContextTab = 'render';
    if (state.projectDirty || state.saveStatus === 'saving') {
      renderAll();
      elements.renderLogs.textContent = 'Project has unsaved changes. Save before rendering.';
      return;
    }
    try {
      const data = await api(`/api/editor/render/${encodeURIComponent(state.project.id)}`, {method: 'POST'});
      state.project.lastRender = normalizeRenderState(data.render);
      renderAll();
      startRenderPolling();
    } catch (error) {
      console.error(error);
      renderAll();
      elements.renderLogs.textContent = `Render start failed: ${error.message}`;
    }
  }

  async function refreshProjects() {
    const data = await api('/api/editor/projects');
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    if (!state.activeProjectId || !state.projects.some((project) => project.id === state.activeProjectId)) {
      state.activeProjectId = state.projects[0]?.id || null;
    }
    renderProjectList();
  }

  async function refreshMedia() {
    const data = await api('/api/editor/media');
    state.media = Array.isArray(data.media) ? data.media : [];
  }

  async function loadProject(projectId) {
    const data = await api(`/api/editor/projects/${encodeURIComponent(projectId)}`);
    state.project = normalizeProject(data.project);
    state.activeProjectId = state.project.id;
    const hasStoredAutoZoom = data.project?.timeline && typeof data.project.timeline.autoZoom === 'boolean';
    const storedZoom = Number(data.project?.timeline?.zoom);
    if (hasStoredAutoZoom) {
      state.isZoomAuto = Boolean(data.project.timeline.autoZoom);
    } else {
      state.isZoomAuto = !Number.isFinite(storedZoom) || Math.abs(storedZoom - 0.2) < 0.0001;
    }
    if (state.project?.timeline) {
      state.project.timeline.autoZoom = state.isZoomAuto;
    }
    markProjectClean();
    renderAll();
    if (state.project.lastRender?.status === 'running') {
      startRenderPolling();
    } else {
      stopRenderPolling();
    }
  }

  function normalizeProject(project) {
    const safeProject = project || {};
    const sourceLayers = Array.isArray(safeProject.layers) ? safeProject.layers : [];
    const normalizedLayers = sourceLayers.map((layer, index) => ({
      id: layer.id || `layer-${index + 1}`,
      name: layer.name || `Layer ${index + 1}`,
      clip: normalizeClip(layer.clip),
      transcription: normalizeTranscription(layer.transcription),
      clipping: normalizeClipping(layer.clipping),
    }));
    const layers = normalizedLayers.length ? normalizedLayers : createDefaultLayers(3);
    const masterOrder = normalizeMasterOrder(safeProject.timeline?.masterOrder, layers);
    return {
      id: safeProject.id,
      name: safeProject.name || 'Untitled Project',
      selectedLayerId: layers.some((layer) => layer.id === safeProject.selectedLayerId)
        ? safeProject.selectedLayerId
        : layers[0]?.id || null,
      timeline: {
        zoom: Number(safeProject.timeline?.zoom) || 0.2,
        durationMs: Math.max(1000, Number(safeProject.timeline?.durationMs) || 300000),
        autoZoom: typeof safeProject.timeline?.autoZoom === 'boolean' ? safeProject.timeline.autoZoom : true,
        masterOrder,
        finalTrimInMs: clampInt(Number(safeProject.timeline?.finalTrimInMs) || 0, 0, 12 * 60 * 60 * 1000),
        finalTrimOutMs: normalizeNullableMs(safeProject.timeline?.finalTrimOutMs),
      },
      layers,
      lastRender: normalizeRenderState(safeProject.lastRender),
      createdAt: safeProject.createdAt || null,
      updatedAt: safeProject.updatedAt || null,
    };
  }

  function createDefaultLayers(count) {
    const total = Math.max(1, Number(count) || 1);
    const layers = [];
    for (let i = 0; i < total; i += 1) {
      layers.push({
        id: `layer-${i + 1}`,
        name: `Layer ${i + 1}`,
        clip: null,
        transcription: null,
        clipping: null,
      });
    }
    return layers;
  }

  function normalizeMasterOrder(input, layers) {
    const layerIds = layers.map((layer) => layer.id);
    const fromInput = Array.isArray(input) ? input : [];
    const ordered = [];
    for (const id of fromInput) {
      if (layerIds.includes(id) && !ordered.includes(id)) {
        ordered.push(id);
      }
    }
    for (const id of layerIds) {
      if (!ordered.includes(id)) {
        ordered.push(id);
      }
    }
    return ordered;
  }

  function normalizeClip(clip) {
    if (!clip || !clip.sourceVideoId) {
      return null;
    }
    const duration = Math.max(0, Number(clip.sourceDurationMs) || 0);
    const trimIn = clampInt(clip.trimInMs, 0, duration);
    const trimOut = clampInt(clip.trimOutMs, trimIn, duration);
    return {
      sourceVideoId: clip.sourceVideoId,
      sourcePath: clip.sourcePath || null,
      sourceDurationMs: duration,
      startMs: clampInt(Number(clip.startMs) || 0, -trimIn, 12 * 60 * 60 * 1000),
      trimInMs: trimIn,
      trimOutMs: trimOut,
      thumbnails: Array.isArray(clip.thumbnails) ? clip.thumbnails.slice(0, 16) : [],
    };
  }

  function normalizeTranscription(input) {
    if (!input || typeof input !== 'object') {
      return null;
    }
    return {
      provider: input.provider || 'openai',
      model: input.model || 'whisper-1',
      status: input.status || 'idle',
      audio: input.audio ? normalizeTranscriptionAsset(input.audio) : null,
      transcript: input.transcript ? normalizeTranscriptionAsset(input.transcript) : null,
      markdown: input.markdown ? normalizeTranscriptionAsset(input.markdown) : null,
      responseFormat: typeof input.responseFormat === 'string' ? input.responseFormat : null,
      timestampGranularities: Array.isArray(input.timestampGranularities)
        ? input.timestampGranularities.filter((value) => typeof value === 'string')
        : [],
      segmentCount: Number.isFinite(Number(input.segmentCount)) ? Math.max(0, Number(input.segmentCount)) : null,
      wordCount: Number.isFinite(Number(input.wordCount)) ? Math.max(0, Number(input.wordCount)) : null,
      timelineMode: typeof input.timelineMode === 'string' ? input.timelineMode : null,
      timelineVisible: input.timelineVisible !== false,
      timelineSegments: Array.isArray(input.timelineSegments)
        ? input.timelineSegments.map((segment) => normalizeTimelineSegment(segment)).filter(Boolean)
        : [],
      textPreview: typeof input.textPreview === 'string' ? input.textPreview : null,
      error: typeof input.error === 'string' ? input.error : null,
      updatedAt: input.updatedAt || null,
    };
  }

  function normalizeClipping(input) {
    if (!input || typeof input !== 'object') {
      return null;
    }
    const clips = Array.isArray(input.clips)
      ? input.clips.map((clip) => normalizeClippingClip(clip)).filter(Boolean)
      : [];
    const selectedClipId = clips.some((clip) => clip.id === input.selectedClipId)
      ? input.selectedClipId
      : clips[0]?.id || null;
    return {
      selectedClipId,
      clips,
    };
  }

  function normalizeClippingClip(input) {
    if (!input || typeof input !== 'object') {
      return null;
    }
    const id = String(input.id || '').trim();
    const startMs = Number(input.startMs);
    const endMs = Number(input.endMs);
    if (!id || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return null;
    }
    return {
      id,
      startMs: Math.max(0, Math.round(startMs)),
      endMs: Math.max(0, Math.round(endMs)),
      text: typeof input.text === 'string' ? input.text : '',
      muted: Boolean(input.muted),
    };
  }

  function normalizeTimelineSegment(input) {
    if (!input || typeof input !== 'object') {
      return null;
    }
    const startMs = Number(input.startMs);
    const endMs = Number(input.endMs);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !text || endMs <= startMs) {
      return null;
    }
    return {
      startMs: Math.max(0, Math.round(startMs)),
      endMs: Math.max(0, Math.round(endMs)),
      text,
    };
  }

  function deriveTimelineSegmentsFromTranscript(payload) {
    if (!payload || !Array.isArray(payload.segments)) {
      return [];
    }
    return payload.segments
      .map((segment) =>
        normalizeTimelineSegment({
          startMs: Math.round(Number(segment?.start || 0) * 1000),
          endMs: Math.round(Number(segment?.end || 0) * 1000),
          text: typeof segment?.text === 'string' ? segment.text : '',
        }),
      )
      .filter(Boolean);
  }

  function hydrateTranscriptionWithTranscriptData(transcription, payload) {
    const next = normalizeTranscription(transcription) || normalizeTranscription({});
    if (!payload || typeof payload !== 'object') {
      return next;
    }
    const timelineSegments = deriveTimelineSegmentsFromTranscript(payload);
    return normalizeTranscription({
      ...next,
      segmentCount: timelineSegments.length,
      wordCount: Array.isArray(payload.words) ? payload.words.length : next.wordCount,
      timelineMode: 'segments',
      timelineSegments,
      responseFormat: next.responseFormat || 'verbose_json',
      timestampGranularities: ['segment'],
      textPreview:
        typeof payload.text === 'string' && payload.text
          ? payload.text.slice(0, 1200)
          : next.textPreview,
    });
  }

  function normalizeTranscriptionAsset(input) {
    if (!input || typeof input !== 'object') {
      return null;
    }
    return {
      path: input.path || null,
      sizeBytes: Number.isFinite(Number(input.sizeBytes)) ? Math.max(0, Number(input.sizeBytes)) : null,
      createdAt: input.createdAt || null,
    };
  }

  function normalizeRenderState(render) {
    const queueJobs = Array.isArray(render?.queueJobs)
      ? render.queueJobs
          .map((job, index) => normalizeRenderQueueJob(job, index))
          .filter(Boolean)
      : [];
    const summary = normalizeRenderQueueSummary(render?.queueSummary, queueJobs);
    return {
      id: render?.id || null,
      status: render?.status || 'idle',
      logs: Array.isArray(render?.logs) ? render.logs : [],
      outputPath: render?.outputPath || null,
      error: render?.error || null,
      startedAt: render?.startedAt || null,
      endedAt: render?.endedAt || null,
      queueSummary: summary,
      queueJobs,
    };
  }

  function normalizeRenderQueueJob(job, index) {
    const startMs = Number(job?.startMs);
    const endMs = Number(job?.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return null;
    }
    const sourceClipIds = Array.isArray(job?.sourceClipIds)
      ? job.sourceClipIds.filter((value) => typeof value === 'string' && value)
      : [];
    return {
      id: job?.id || `job-${index + 1}`,
      layerId: job?.layerId || 'layer',
      status: job?.status || 'pending',
      startMs: Math.max(0, Math.round(startMs)),
      endMs: Math.max(0, Math.round(endMs)),
      durationMs: Math.max(0, Math.round((Number(job?.durationMs) || endMs - startMs))),
      sourceClipIds,
      sourceSegmentCount: Math.max(
        sourceClipIds.length,
        Number.isFinite(Number(job?.sourceSegmentCount)) ? Math.max(1, Number(job.sourceSegmentCount)) : 1,
      ),
      textPreview: typeof job?.textPreview === 'string' ? job.textPreview : '',
      stagedPath: typeof job?.stagedPath === 'string' ? job.stagedPath : null,
      startedAt: job?.startedAt || null,
      endedAt: job?.endedAt || null,
      error: job?.error || null,
    };
  }

  function normalizeRenderQueueSummary(summary, queueJobs = []) {
    const jobs = Array.isArray(queueJobs) ? queueJobs : [];
    return {
      layerCount: Math.max(
        Number.isFinite(Number(summary?.layerCount)) ? Math.max(0, Number(summary.layerCount)) : 0,
        new Set(jobs.map((job) => job.layerId).filter(Boolean)).size,
      ),
      sourceSegmentCount: Math.max(
        Number.isFinite(Number(summary?.sourceSegmentCount)) ? Math.max(0, Number(summary.sourceSegmentCount)) : 0,
        jobs.reduce((sum, job) => sum + Math.max(1, Number(job.sourceSegmentCount) || 1), 0),
      ),
      consolidatedJobCount: Math.max(
        Number.isFinite(Number(summary?.consolidatedJobCount)) ? Math.max(0, Number(summary.consolidatedJobCount)) : 0,
        jobs.length,
      ),
      mutedSegmentCount: Number.isFinite(Number(summary?.mutedSegmentCount))
        ? Math.max(0, Number(summary.mutedSegmentCount))
        : 0,
      completedJobCount: jobs.filter((job) => job.status === 'completed').length,
      failedJobCount: jobs.filter((job) => job.status === 'failed').length,
      runningJobCount: jobs.filter((job) => job.status === 'running').length,
      pendingJobCount: jobs.filter((job) => job.status === 'pending').length,
    };
  }

  function renderAll() {
    renderProjectList();
    renderProjectSummary();
    renderToolbar();
    renderTimeline();
    renderRightSidebar();
    applyContextPanelVisibility();
    renderRenderPanel();
  }

  function applyContextPanelVisibility() {
    const activeTab = state.activeContextTab === 'render' ? 'render' : 'tools';
    if (elements.toolsTabPanel) {
      elements.toolsTabPanel.classList.toggle('active', activeTab === 'tools');
    }
    if (elements.renderTabPanel) {
      elements.renderTabPanel.classList.toggle('active', activeTab === 'render');
    }
    if (elements.videoPanel) {
      elements.videoPanel.classList.toggle('collapsed', !state.videoPanelExpanded);
    }
    if (elements.transcriberPanel) {
      elements.transcriberPanel.classList.toggle('collapsed', !state.transcriberPanelExpanded);
    }
    if (elements.clippingPanel) {
      elements.clippingPanel.classList.toggle('collapsed', !state.clippingPanelExpanded);
    }
    if (elements.toolsTabBtn) {
      elements.toolsTabBtn.classList.toggle('active', activeTab === 'tools');
      elements.toolsTabBtn.setAttribute('aria-selected', activeTab === 'tools' ? 'true' : 'false');
    }
    if (elements.renderTabBtn) {
      elements.renderTabBtn.classList.toggle('active', activeTab === 'render');
      elements.renderTabBtn.setAttribute('aria-selected', activeTab === 'render' ? 'true' : 'false');
    }
    if (elements.timelinePanel) {
      elements.timelinePanel.classList.toggle('active', activeTab === 'tools');
    }
    if (elements.centerRenderPanel) {
      elements.centerRenderPanel.classList.toggle('active', activeTab === 'render');
    }
    if (elements.videoPanelCollapseBtn) {
      elements.videoPanelCollapseBtn.textContent = state.videoPanelExpanded ? 'Collapse' : 'Expand';
      elements.videoPanelCollapseBtn.setAttribute('aria-expanded', state.videoPanelExpanded ? 'true' : 'false');
    }
    if (elements.transcriberPanelCollapseBtn) {
      elements.transcriberPanelCollapseBtn.textContent = state.transcriberPanelExpanded ? 'Collapse' : 'Expand';
      elements.transcriberPanelCollapseBtn.setAttribute('aria-expanded', state.transcriberPanelExpanded ? 'true' : 'false');
    }
    if (elements.clippingPanelCollapseBtn) {
      elements.clippingPanelCollapseBtn.textContent = state.clippingPanelExpanded ? 'Collapse' : 'Expand';
      elements.clippingPanelCollapseBtn.setAttribute('aria-expanded', state.clippingPanelExpanded ? 'true' : 'false');
    }
  }

  function renderProjectList() {
    elements.projectList.innerHTML = '';
    if (!state.projects.length) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'No editor projects yet. Create one from above.';
      elements.projectList.appendChild(hint);
      return;
    }
    for (const project of state.projects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `project-item${project.id === state.activeProjectId ? ' active' : ''}`;
      const name = escapeHtml(project.name || 'Untitled');
      const dateText = formatDate(project.updatedAt || project.createdAt);
      button.innerHTML = `<span>${name}</span><span class="project-meta">${dateText}</span>`;
      button.addEventListener('click', async () => {
        if (project.id === state.activeProjectId) return;
        if (state.projectDirty && state.project) {
          const confirmed = window.confirm('Current project has unsaved changes. Discard and switch project?');
          if (!confirmed) return;
        }
        state.activeProjectId = project.id;
        renderProjectList();
        await loadProject(project.id);
        await refreshRenderStatus();
      });
      elements.projectList.appendChild(button);
      if (project.id === state.activeProjectId && elements.projectSummary) {
        elements.projectSummary.classList.add('project-summary-inline');
        elements.projectList.appendChild(elements.projectSummary);
      }
    }
  }

  function renderProjectSummary() {
    if (!elements.projectSummary) return;
    if (!state.project) {
      elements.projectSummary.innerHTML = '<p class="hint">Project metrics will appear here.</p>';
      return;
    }
    const stats = computeProjectStats(state.project);
    const renderState = normalizeRenderState(state.project?.lastRender);
    const renderOutputPath = typeof renderState.outputPath === 'string' ? renderState.outputPath : '';
    const renderOutputName = renderOutputPath ? decodeURIComponent(renderOutputPath.split('/').pop() || renderOutputPath) : '';
    elements.projectSummary.innerHTML = `
      <div class="summary-row"><span>Expected Final</span><strong>${formatClock(stats.expectedFinalDurationMs)}</strong></div>
      <div class="summary-row"><span>Layers</span><strong>${stats.layerCount}</strong></div>
      <div class="summary-row"><span>Rendered Layers</span><strong>${stats.renderedLayerCount}</strong></div>
      <div class="summary-row"><span>Segments</span><strong>${stats.activeClipCount}</strong></div>
      <div class="summary-row"><span>Render Jobs</span><strong>${stats.consolidatedRenderJobCount}</strong></div>
      <div class="summary-row"><span>Muted Clips</span><strong>${stats.mutedClipCount}</strong></div>
      <div class="summary-row"><span>Canvas Span</span><strong>${formatClock(stats.timelineEndMs)}</strong></div>
      <div class="summary-render-output">
        <div class="summary-render-title">Render Context</div>
        <div class="summary-render-file">${escapeHtml(renderOutputName || 'No render output yet')}</div>
        <button id="project-render-context-btn" type="button" class="btn-accent">Render</button>
      </div>
    `;
    document.getElementById('project-render-context-btn')?.addEventListener('click', () => {
      state.activeContextTab = 'render';
      renderAll();
    });
  }

  function computeProjectStats(project) {
    const renderPreview = buildRenderPreview(project);
    const renderLayers = renderPreview.layers;
    const activeClipCount = renderPreview.summary.sourceSegmentCount;
    const mutedClipCount = project.layers.reduce((sum, layer) => {
      const clips = Array.isArray(layer?.clipping?.clips) ? layer.clipping.clips : [];
      return sum + clips.filter((clip) => clip?.muted).length;
    }, 0);
    const timelineEndMs = renderLayers.reduce((max, layer) => Math.max(max, layer.startMs + layer.durationMs), 0);
    const visibleLayers = resolveExpectedVisibleLayers(renderLayers);
    const expectedFinalDurationMs = visibleLayers.reduce((sum, layer) => sum + layer.visibleDurationMs, 0);
    return {
      expectedFinalDurationMs,
      layerCount: project.layers.length,
      renderedLayerCount: renderLayers.length,
      activeClipCount,
      consolidatedRenderJobCount: renderPreview.summary.consolidatedJobCount,
      mutedClipCount,
      timelineEndMs: Math.max(0, Math.floor(timelineEndMs)),
    };
  }

  function buildRenderPreview(project) {
    const order = Array.isArray(project?.timeline?.masterOrder) ? project.timeline.masterOrder : [];
    const orderRank = new Map(order.map((id, index) => [id, index]));
    const layers = (project?.layers || [])
      .filter((layer) => layer?.clip?.sourceVideoId)
      .map((layer) => {
        const sourceSegments = collectExpectedRenderClips(layer);
        const queueJobs = consolidateExpectedRenderJobs(layer.id, sourceSegments);
        return {
          layerId: layer.id,
          startMs: Number(layer?.clip?.startMs) || 0,
          durationMs: sourceSegments.reduce((sum, clip) => sum + (clip.endMs - clip.startMs), 0),
          orderRank: orderRank.has(layer.id) ? orderRank.get(layer.id) : Number.MAX_SAFE_INTEGER,
          sourceSegments,
          queueJobs,
        };
      })
      .filter((layer) => layer.sourceSegments.length > 0)
      .sort((a, b) => a.orderRank - b.orderRank);
    const queueJobs = layers.flatMap((layer) => layer.queueJobs);
    return {
      layers,
      queueJobs,
      summary: normalizeRenderQueueSummary(
        {
          layerCount: layers.length,
          sourceSegmentCount: layers.reduce((sum, layer) => sum + layer.sourceSegments.length, 0),
          consolidatedJobCount: queueJobs.length,
          mutedSegmentCount: (project?.layers || []).reduce((sum, layer) => {
            const clips = Array.isArray(layer?.clipping?.clips) ? layer.clipping.clips : [];
            return sum + clips.filter((clip) => clip?.muted).length;
          }, 0),
        },
        queueJobs,
      ),
    };
  }

  function collectExpectedRenderClips(layer) {
    const clippingClips = Array.isArray(layer?.clipping?.clips) ? layer.clipping.clips : [];
    if (clippingClips.length) {
      return clippingClips
        .filter((clip) => !clip?.muted)
        .map((clip) => ({
          clipId: clip.id || 'clip',
          startMs: Number(clip.startMs) || 0,
          endMs: Number(clip.endMs) || 0,
          text: typeof clip.text === 'string' ? clip.text : '',
        }))
        .filter((clip) => clip.endMs > clip.startMs);
    }
    const sourceDurationMs = Number(layer?.clip?.sourceDurationMs) || 0;
    const trimInMs = clampInt(Number(layer?.clip?.trimInMs) || 0, 0, sourceDurationMs);
    const trimOutMs = clampInt(Number(layer?.clip?.trimOutMs) || sourceDurationMs, trimInMs, sourceDurationMs);
    if (trimOutMs <= trimInMs) {
      return [];
    }
    return [{clipId: 'clip-001', startMs: trimInMs, endMs: trimOutMs, text: ''}];
  }

  function consolidateExpectedRenderJobs(layerId, sourceSegments) {
    const segments = Array.isArray(sourceSegments)
      ? sourceSegments
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
    const jobs = [];
    let current = null;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!current) {
        current = createExpectedRenderJob(layerId, segment, index);
        continue;
      }
      if (segment.startMs <= current.endMs) {
        current.endMs = Math.max(current.endMs, segment.endMs);
        current.sourceClipIds.push(segment.clipId || `clip-${index + 1}`);
        if (segment.text) {
          current.textSnippets.push(segment.text);
        }
        continue;
      }
      jobs.push(finalizeExpectedRenderJob(current));
      current = createExpectedRenderJob(layerId, segment, index);
    }
    if (current) {
      jobs.push(finalizeExpectedRenderJob(current));
    }
    return jobs;
  }

  function createExpectedRenderJob(layerId, segment, index) {
    return {
      id: `${layerId}-job-${index + 1}`,
      layerId,
      status: 'planned',
      startMs: segment.startMs,
      endMs: segment.endMs,
      sourceClipIds: [segment.clipId || `clip-${index + 1}`],
      textSnippets: segment.text ? [segment.text] : [],
    };
  }

  function finalizeExpectedRenderJob(job) {
    const preview = job.textSnippets.slice(0, 2).join(' / ');
    return {
      id: job.id,
      layerId: job.layerId,
      status: 'planned',
      startMs: job.startMs,
      endMs: job.endMs,
      durationMs: Math.max(0, job.endMs - job.startMs),
      sourceClipIds: job.sourceClipIds,
      sourceSegmentCount: job.sourceClipIds.length,
      textPreview: preview.length > 140 ? `${preview.slice(0, 137)}...` : preview,
      stagedPath: null,
      startedAt: null,
      endedAt: null,
      error: null,
    };
  }

  function resolveExpectedVisibleLayers(renderLayers) {
    const ordered = renderLayers
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
        visibleDurationMs,
      });
    }
    return visible;
  }

  function renderToolbar() {
    const zoom = Number(state.project?.timeline?.zoom || 0.2);
    elements.zoomRange.value = String(zoom);
    elements.zoomLabel.textContent = `${zoom.toFixed(2)}x`;
    const saveState = !state.project
      ? 'saved'
      : state.saveStatus === 'saving'
      ? 'saving'
      : state.saveStatus === 'error'
      ? 'error'
      : state.projectDirty
      ? 'unsaved'
      : 'saved';
    elements.saveStateBadge.className = `badge save-state ${saveState}`;
    elements.saveStateBadge.textContent =
      saveState === 'saving'
        ? 'saving'
        : saveState === 'error'
        ? 'save failed'
        : saveState === 'unsaved'
        ? 'unsaved'
        : 'saved';
    const renderState = normalizeRenderState(state.project?.lastRender);
    setRenderBadge(renderState.status);
    elements.saveProjectBtn.disabled =
      !state.project || !state.projectDirty || state.saveStatus === 'saving';
    elements.addLayerBtn.disabled = !state.project;
    if (elements.zoomOutBtn) {
      elements.zoomOutBtn.disabled = !state.project;
    }
    if (elements.zoomInBtn) {
      elements.zoomInBtn.disabled = !state.project;
    }
  }

  function applyManualZoom(value) {
    if (!state.project) return;
    state.isZoomAuto = false;
    state.project.timeline.autoZoom = false;
    state.project.timeline.zoom = Number.isFinite(value) ? value : 0.2;
    renderToolbar();
    renderTimeline();
    markProjectDirty();
  }

  function stepZoom(direction) {
    if (!state.project) return;
    const min = Number(elements.zoomRange.min || 0.01);
    const max = Number(elements.zoomRange.max || 2.5);
    const step = Number(elements.zoomRange.step || 0.01);
    const current = Number(state.project.timeline.zoom || elements.zoomRange.value || 0.2);
    const next = clamp(current + direction * step, min, max);
    applyManualZoom(next);
  }

  function renderTimeline() {
    if (!state.project) {
      elements.timelineWrap?.classList.remove('clip-view-mode');
      elements.timelineContent?.classList.remove('timeline-content-clip-view');
      elements.timelineContent.innerHTML = '<p class="hint">Select or create a project to start editing.</p>';
      return;
    }
    if (getCenterCanvasMode() === 'clipping') {
      renderClippingCanvas();
      return;
    }
    elements.timelineWrap?.classList.remove('clip-view-mode');
    elements.timelineContent?.classList.remove('timeline-content-clip-view');
    syncTimelineZoom();
    const pxPerMs = getPxPerMs();
    const timelineDurationMs = getTimelineDurationMs(state.project);
    const trackWidth = Math.max(480, Math.ceil(timelineDurationMs * pxPerMs) + 30);
    const rulerStep = pickRulerStepMs(pxPerMs);
    const rulerTicks = [];
    for (let ms = 0; ms <= timelineDurationMs; ms += rulerStep) {
      const left = Math.floor(ms * pxPerMs);
      rulerTicks.push(
        `<div class="tick" style="left:${left}px"><span class="tick-label">${formatClock(ms)}</span></div>`,
      );
    }

    const masterSegments = [];
    for (const layer of state.project.layers) {
      if (!layer.clip) continue;
      const clip = layer.clip;
      const activeStart = clip.startMs + clip.trimInMs;
      const activeDuration = Math.max(0, clip.trimOutMs - clip.trimInMs);
      if (activeDuration <= 0) continue;
      const left = Math.floor(activeStart * pxPerMs);
      const width = Math.max(8, Math.floor(activeDuration * pxPerMs));
      masterSegments.push(`<div class="master-segment" style="left:${left}px;width:${width}px;"></div>`);
    }

    const rows = state.project.layers
      .map((layer) => renderLayerRow(layer, trackWidth, pxPerMs, state.project.selectedLayerId === layer.id))
      .join('');

    elements.timelineContent.innerHTML = `
      <div class="ruler-row">
        <div class="row-label">Time</div>
        <div class="row-track ruler-track" style="width:${trackWidth}px">${rulerTicks.join('')}</div>
      </div>
      <div class="master-row">
        <div class="row-label">Master</div>
        <div class="row-track" style="width:${trackWidth}px">${masterSegments.join('')}</div>
      </div>
      ${rows}
      <div id="timeline-playhead" class="timeline-playhead hidden" aria-hidden="true"></div>
    `;
    bindTimelineEvents();
    updateTimelinePlayhead();
  }

  function renderLayerRow(layer, trackWidth, pxPerMs, selected) {
    const clipHtml = layer.clip ? renderClip(layer, pxPerMs) : '';
    const selectedClass = selected ? ' selected' : '';
    return `
      <div class="layer-row${selectedClass}" data-layer-id="${escapeHtml(layer.id)}">
        <div class="row-label">${escapeHtml(layer.name)}</div>
        <div class="row-track" style="width:${trackWidth}px">${clipHtml}</div>
      </div>
    `;
  }

  function renderClip(layer, pxPerMs) {
    const clip = layer.clip;
    const sourceDuration = Math.max(1, Number(clip.sourceDurationMs) || 1);
    const leftPx = Math.floor((Number(clip.startMs) || 0) * pxPerMs);
    const widthPx = Math.max(30, Math.floor(sourceDuration * pxPerMs));
    const trimInPct = clamp((clip.trimInMs / sourceDuration) * 100, 0, 100);
    const trimOutPct = clamp(((sourceDuration - clip.trimOutMs) / sourceDuration) * 100, 0, 100);
    const trimHotPct = clamp(100 - trimInPct - trimOutPct, 0, 100);
    const media = findMedia(clip.sourceVideoId);
    const layerId = escapeHtml(layer.id);
    const hasAudio = Boolean(layer?.transcription?.audio?.path);
    const isAudioBusy =
      state.transcriptionBusyLayerId === layer.id && state.transcriptionBusyAction === 'extract';
    const hasTranscript = Boolean(layer?.transcription?.transcript?.path);
    const isTranscriptBusy =
      state.transcriptionBusyLayerId === layer.id && state.transcriptionBusyAction === 'transcribe';
    const showAudioTrack = hasAudio || isAudioBusy;
    const transcriptVisible = layer?.transcription?.timelineVisible !== false;
    const timelineSegments = Array.isArray(layer?.transcription?.timelineSegments)
      ? layer.transcription.timelineSegments
      : [];
    const showTranscriptTrack = transcriptVisible && isTranscriptBusy;
    const showTranscriptBlocks = transcriptVisible && hasTranscript && !isTranscriptBusy && timelineSegments.length > 0;
    const label = media?.filename || clip.sourceVideoId.split('/').pop() || 'clip';
    const thumbs = (clip.thumbnails || [])
      .slice(0, 12)
      .map((url) => `<img src="${escapeAttribute(url)}" alt="" loading="lazy" />`)
      .join('');
    return `
      ${showAudioTrack ? `<div class="clip-media-track clip-media-track--audio ${isAudioBusy ? 'clip-media-track--busy' : ''}" style="left:${leftPx}px;width:${widthPx}px;" title="Layer MP3 track"></div>` : ''}
      ${showTranscriptBlocks ? renderTranscriptSegments(layer, pxPerMs) : ''}
      ${showTranscriptTrack && !showTranscriptBlocks ? `<div class="clip-media-track clip-media-track--transcript ${isTranscriptBusy ? 'clip-media-track--busy' : ''}" style="left:${leftPx}px;width:${widthPx}px;" title="Layer transcript track"></div>` : ''}
      <div class="clip" data-layer-id="${layerId}" style="left:${leftPx}px;width:${widthPx}px;">
        <div class="clip-handle clip-handle-left" data-layer-id="${layerId}"></div>
        <div class="clip-body" data-layer-id="${layerId}">
          <div class="trim-cold" style="width:${trimInPct}%"></div>
          <div class="trim-hot" style="width:${trimHotPct}%">
            <div class="thumb-strip">${thumbs}</div>
            <span class="clip-label">${escapeHtml(label)}</span>
          </div>
          <div class="trim-cold" style="width:${trimOutPct}%"></div>
        </div>
        <div class="clip-handle clip-handle-right" data-layer-id="${layerId}"></div>
      </div>
    `;
  }

  function getCenterCanvasMode() {
    if (state.activeContextTab !== 'tools') {
      return 'timeline';
    }
    return state.clippingPanelExpanded ? 'clipping' : 'timeline';
  }

  function renderClippingCanvas() {
    const layer = getSelectedLayer();
    elements.timelineWrap?.classList.add('clip-view-mode');
    elements.timelineContent?.classList.add('timeline-content-clip-view');
    if (!layer?.clip) {
      elements.timelineContent.innerHTML = '<p class="hint">Select a layer with a source video to work in clipping mode.</p>';
      return;
    }
    if (elements.timelineWrap) {
      elements.timelineWrap.scrollLeft = 0;
    }
    const clipping = normalizeClipping(layer.clipping) || {selectedClipId: null, clips: []};
    const pxPerMs = getPxPerMs();
    const sourceDurationMs = Math.max(1, Number(layer.clip.sourceDurationMs) || 1);
    const trackWidth = Math.max(720, Math.ceil(sourceDurationMs * pxPerMs) + 30);
    const rulerStep = pickRulerStepMs(pxPerMs);
    const rulerTicks = [];
    for (let ms = 0; ms <= sourceDurationMs; ms += rulerStep) {
      const left = Math.floor(ms * pxPerMs);
      rulerTicks.push(
        `<div class="tick" style="left:${left}px"><span class="tick-label">${formatClock(ms)}</span></div>`,
      );
    }
    const rows = clipping.clips
      .map((clip, index) => renderClippingRow(layer, clip, index, trackWidth, pxPerMs, clipping.selectedClipId === clip.id))
      .join('');
    elements.timelineContent.innerHTML = `
      <div class="clip-view-shell">
        <div class="clip-view-ruler-row">
          <div class="clip-view-row-label clip-view-row-label-ruler">Clips</div>
          <div class="clip-view-track-viewport clip-view-ruler-viewport">
            <div class="row-track ruler-track clip-view-ruler-track" style="width:${trackWidth}px">${rulerTicks.join('')}</div>
          </div>
        </div>
        <div class="clip-view-body">
          ${rows || '<p class="hint">Provision clips from the transcribed segments to start the clipping view.</p>'}
        </div>
      </div>
    `;
    const clipViewBody = getClipViewBody();
    if (clipViewBody) {
      clipViewBody.scrollTop = state.clipViewScrollTop;
      clipViewBody.addEventListener('scroll', onClipViewBodyScroll);
    }
    syncClipViewTrackScroll();
    bindClipViewEvents(layer);
  }

  function renderClippingRow(layer, clip, index, trackWidth, pxPerMs, selected) {
    const sourceDurationMs = Math.max(1, Number(layer?.clip?.sourceDurationMs) || 1);
    const startMs = clampInt(Number(clip.startMs) || 0, 0, sourceDurationMs);
    const endMs = clampInt(Number(clip.endMs) || 0, startMs, sourceDurationMs);
    const leftPx = Math.floor(startMs * pxPerMs);
    const widthPx = Math.max(24, Math.floor((endMs - startMs) * pxPerMs));
    const playheadMs = state.previewPlayback.layerId === layer.id ? state.previewPlayback.currentTimeMs : null;
    const playheadLeftPx = playheadMs === null ? null : Math.floor(clampInt(playheadMs, 0, sourceDurationMs) * pxPerMs);
    return `
      <div class="clip-view-row${selected ? ' selected' : ''}" data-layer-id="${escapeAttribute(layer.id)}" data-clip-id="${escapeAttribute(clip.id)}">
        <div class="clip-view-row-label" data-layer-id="${escapeAttribute(layer.id)}" data-clip-id="${escapeAttribute(clip.id)}">
          <strong>Clip ${index + 1}</strong>
          <span>${formatClockPrecise(startMs)} - ${formatClockPrecise(endMs)}</span>
        </div>
        <div class="clip-view-track-viewport" data-layer-id="${escapeAttribute(layer.id)}" data-clip-id="${escapeAttribute(clip.id)}">
          <div class="clip-view-track row-track" style="width:${trackWidth}px" data-layer-id="${escapeAttribute(layer.id)}" data-clip-id="${escapeAttribute(clip.id)}">
            <div class="clip-view-track-fill"></div>
            <div class="clip-view-segment${clip.muted ? ' muted' : ''}" style="left:${leftPx}px;width:${widthPx}px;">
              <span>${escapeHtml(clip.text || `Clip ${index + 1}`)}</span>
            </div>
            ${playheadLeftPx === null ? '' : `<div class="clip-view-playhead" style="left:${playheadLeftPx}px;"></div>`}
          </div>
        </div>
      </div>
    `;
  }

  function renderTranscriptSegments(layer, pxPerMs) {
    const clip = layer?.clip;
    const transcription = layer?.transcription;
    if (!clip || !transcription?.timelineVisible || !Array.isArray(transcription.timelineSegments)) {
      return '';
    }
    const activeStartMs = (Number(clip.startMs) || 0) + Math.max(0, Number(clip.trimInMs) || 0);
    const activeDurationMs = Math.max(0, Number(clip.trimOutMs || 0) - Number(clip.trimInMs || 0));
    if (activeDurationMs <= 0) {
      return '';
    }
    return transcription.timelineSegments
      .map((segment, index) => {
        const clampedStartMs = clampInt(segment.startMs, 0, activeDurationMs);
        const clampedEndMs = clampInt(segment.endMs, clampedStartMs, activeDurationMs);
        if (clampedEndMs <= clampedStartMs) {
          return '';
        }
        const leftPx = Math.floor((activeStartMs + clampedStartMs) * pxPerMs);
        const widthPx = Math.max(18, Math.floor((clampedEndMs - clampedStartMs) * pxPerMs));
        const toneClass = `clip-transcript-segment--tone-${index % 4}`;
        return `<div class="clip-transcript-segment ${toneClass}" data-layer-id="${escapeAttribute(layer.id)}" data-segment-start-ms="${clampedStartMs}" style="left:${leftPx}px;width:${widthPx}px;" title="${escapeAttribute(segment.text)}"><span>${escapeHtml(segment.text)}</span></div>`;
      })
      .join('');
  }

  function bindTimelineEvents() {
    const rowNodes = elements.timelineContent.querySelectorAll('.layer-row');
    rowNodes.forEach((row) => {
      row.addEventListener('click', () => {
        if (!state.project) return;
        const layerId = row.getAttribute('data-layer-id');
        if (!layerId) return;
        state.project.selectedLayerId = layerId;
        renderTimeline();
        renderRightSidebar();
      });
    });

    const bodyNodes = elements.timelineContent.querySelectorAll('.clip-body');
    bodyNodes.forEach((node) => {
      node.addEventListener('mousedown', (event) => beginClipDrag(event, 'move'));
    });

    const leftHandleNodes = elements.timelineContent.querySelectorAll('.clip-handle-left');
    leftHandleNodes.forEach((node) => {
      node.addEventListener('mousedown', (event) => beginClipDrag(event, 'trim-in'));
    });

    const rightHandleNodes = elements.timelineContent.querySelectorAll('.clip-handle-right');
    rightHandleNodes.forEach((node) => {
      node.addEventListener('mousedown', (event) => beginClipDrag(event, 'trim-out'));
    });

    const rulerTrack = elements.timelineContent.querySelector('.ruler-track');
    rulerTrack?.addEventListener('mousedown', beginTimelinePan);

    const transcriptSegmentNodes = elements.timelineContent.querySelectorAll('.clip-transcript-segment');
    transcriptSegmentNodes.forEach((node) => {
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!state.project) return;
        const layerId = node.getAttribute('data-layer-id');
        const startMs = Number(node.getAttribute('data-segment-start-ms'));
        if (!layerId || !Number.isFinite(startMs)) return;
        seekLayerPreviewToMs(layerId, startMs);
      });
    });
  }

  function bindClipViewEvents(layer) {
    const rowNodes = elements.timelineContent.querySelectorAll('.clip-view-row');
    rowNodes.forEach((row) => {
      row.addEventListener('click', () => {
        if (state.suppressClipSelectionClick) {
          state.suppressClipSelectionClick = false;
          return;
        }
        const clipId = row.getAttribute('data-clip-id');
        if (!clipId) return;
        selectClippingClip(layer.id, clipId, true);
      });
    });

    const labelNodes = elements.timelineContent.querySelectorAll('.clip-view-row-label:not(.clip-view-row-label-ruler)');
    labelNodes.forEach((label) => {
      label.addEventListener('mousedown', beginClipViewPan);
    });

    const trackNodes = elements.timelineContent.querySelectorAll('.clip-view-track-viewport');
    trackNodes.forEach((track) => {
      track.addEventListener('mousedown', beginClipTrackPan);
    });
  }

  function beginTimelinePan(event) {
    if (event.button !== 0 || !elements.timelineWrap) return;
    event.preventDefault();
    state.timelinePan = {
      startX: event.clientX,
      startScrollLeft: elements.timelineWrap.scrollLeft,
      moved: false,
    };
    elements.timelineWrap.classList.add('is-panning');
    window.addEventListener('mousemove', onTimelinePanMove);
    window.addEventListener('mouseup', endTimelinePan);
  }

  function onTimelinePanMove(event) {
    if (!state.timelinePan) return;
    const deltaX = event.clientX - state.timelinePan.startX;
    if (Math.abs(deltaX) > 3) {
      state.timelinePan.moved = true;
    }
    if (state.timelinePan.mode === 'clip-track') {
      setClipViewScrollLeft(state.timelinePan.startScrollLeft - deltaX);
      return;
    }
    if (!elements.timelineWrap) return;
    elements.timelineWrap.scrollLeft = state.timelinePan.startScrollLeft - deltaX;
  }

  function endTimelinePan() {
    if (state.timelinePan?.moved) {
      state.suppressClipSelectionClick = true;
    }
    state.timelinePan = null;
    elements.timelineWrap?.classList.remove('is-panning');
    window.removeEventListener('mousemove', onTimelinePanMove);
    window.removeEventListener('mouseup', endTimelinePan);
  }

  function beginClipTrackPan(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    state.timelinePan = {
      startX: event.clientX,
      startScrollLeft: state.clipViewScrollLeft,
      moved: false,
      mode: 'clip-track',
    };
    elements.timelineWrap?.classList.add('is-panning');
    window.addEventListener('mousemove', onTimelinePanMove);
    window.addEventListener('mouseup', endTimelinePan);
  }

  function beginClipViewPan(event) {
    const clipViewBody = getClipViewBody();
    if (event.button !== 0 || !clipViewBody) return;
    event.preventDefault();
    state.clipViewPan = {
      startY: event.clientY,
      startScrollTop: clipViewBody.scrollTop,
      moved: false,
    };
    elements.timelineWrap?.classList.add('is-panning');
    window.addEventListener('mousemove', onClipViewPanMove);
    window.addEventListener('mouseup', endClipViewPan);
  }

  function onClipViewPanMove(event) {
    const clipViewBody = getClipViewBody();
    if (!state.clipViewPan || !clipViewBody) return;
    const deltaY = event.clientY - state.clipViewPan.startY;
    if (Math.abs(deltaY) > 3) {
      state.clipViewPan.moved = true;
    }
    clipViewBody.scrollTop = state.clipViewPan.startScrollTop - deltaY;
  }

  function endClipViewPan() {
    if (state.clipViewPan?.moved) {
      state.suppressClipSelectionClick = true;
    }
    state.clipViewPan = null;
    elements.timelineWrap?.classList.remove('is-panning');
    window.removeEventListener('mousemove', onClipViewPanMove);
    window.removeEventListener('mouseup', endClipViewPan);
  }

  function setClipViewScrollLeft(nextValue) {
    state.clipViewScrollLeft = Math.max(0, Math.floor(nextValue || 0));
    syncClipViewTrackScroll();
  }

  function getClipViewBody() {
    return elements.timelineContent?.querySelector('.clip-view-body') || null;
  }

  function onClipViewBodyScroll(event) {
    state.clipViewScrollTop = event.currentTarget.scrollTop;
  }

  function syncClipViewTrackScroll() {
    const viewports = elements.timelineContent.querySelectorAll('.clip-view-track-viewport');
    viewports.forEach((viewport) => {
      viewport.scrollLeft = state.clipViewScrollLeft;
    });
  }

  function beginClipDrag(event, mode) {
    if (!state.project || event.button !== 0) return;
    event.preventDefault();
    const layerId = event.currentTarget.getAttribute('data-layer-id');
    const layer = findLayer(layerId);
    if (!layer || !layer.clip) return;
    state.project.selectedLayerId = layer.id;
    const clip = layer.clip;
    state.drag = {
      mode,
      layerId,
      startX: event.clientX,
      initialStartMs: clip.startMs,
      initialTrimInMs: clip.trimInMs,
      initialTrimOutMs: clip.trimOutMs,
      changed: false,
    };
    renderTimeline();
    renderRightSidebar();
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragUp);
  }

  function onDragMove(event) {
    if (!state.drag || !state.project) return;
    const layer = findLayer(state.drag.layerId);
    if (!layer || !layer.clip) return;
    const clip = layer.clip;
    const pxPerMs = getPxPerMs();
    const deltaMs = Math.round((event.clientX - state.drag.startX) / pxPerMs);
    if (state.drag.mode === 'move') {
      const minStart = -Math.max(0, Number(clip.trimInMs) || 0);
      clip.startMs = clampInt(state.drag.initialStartMs + deltaMs, minStart, 12 * 60 * 60 * 1000);
    } else if (state.drag.mode === 'trim-in') {
      const maxTrimIn = Math.max(0, clip.trimOutMs);
      clip.trimInMs = clampInt(state.drag.initialTrimInMs + deltaMs, 0, maxTrimIn);
      clip.startMs = clampInt(clip.startMs, -clip.trimInMs, 12 * 60 * 60 * 1000);
    } else if (state.drag.mode === 'trim-out') {
      const maxTrimOut = Math.max(clip.trimInMs, clip.sourceDurationMs);
      clip.trimOutMs = clampInt(state.drag.initialTrimOutMs + deltaMs, clip.trimInMs, maxTrimOut);
    }
    state.drag.changed =
      clip.startMs !== state.drag.initialStartMs ||
      clip.trimInMs !== state.drag.initialTrimInMs ||
      clip.trimOutMs !== state.drag.initialTrimOutMs;
    renderTimeline();
    renderRightSidebar();
  }

  function onDragUp() {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
    if (state.drag?.changed) {
      syncTimelineZoom();
      renderProjectSummary();
      markProjectDirty();
    }
    state.drag = null;
  }

  function renderRightSidebar() {
    applyContextPanelVisibility();
    if (state.activeContextTab === 'tools') {
      renderToolsPanel();
    } else {
      renderRenderInspector();
    }
  }

  function getCurrentRenderDisplayData() {
    const renderState = normalizeRenderState(state.project?.lastRender);
    const preview = buildRenderPreview(state.project);
    const hasTrackedQueue = renderState.queueJobs.length > 0;
    const useTrackedQueue =
      renderState.status === 'running' || (hasTrackedQueue && !state.projectDirty && state.saveStatus !== 'saving');
    return {
      renderState,
      preview,
      queueJobs: useTrackedQueue ? renderState.queueJobs : preview.queueJobs,
      queueSummary: useTrackedQueue ? renderState.queueSummary : preview.summary,
      queueMode:
        renderState.status === 'running'
          ? 'Tracked Live Queue'
          : useTrackedQueue
            ? 'Last Tracked Queue'
            : 'Planned Queue',
    };
  }

  function renderRenderInspector() {
    if (!elements.renderTabBody) return;
    if (!state.project) {
      if (elements.renderTabBtn) {
        elements.renderTabBtn.textContent = 'Render';
      }
      elements.renderTabBody.innerHTML = '<p class="hint">Select a project to inspect its render queue.</p>';
      return;
    }
    const {renderState, queueSummary, queueMode} = getCurrentRenderDisplayData();
    const outputPath = renderState.outputPath || '';
    const outputName = outputPath ? decodeURIComponent(outputPath.split('/').pop() || outputPath) : '';
    const canStartRender =
      Boolean(state.project) &&
      renderState.status !== 'running' &&
      !state.projectDirty &&
      state.saveStatus !== 'saving' &&
      queueSummary.consolidatedJobCount > 0;
    if (elements.renderTabBtn) {
      const suffix = queueSummary.consolidatedJobCount ? ` (${queueSummary.consolidatedJobCount})` : '';
      elements.renderTabBtn.textContent = `Render${suffix}`;
    }
    elements.renderTabBody.innerHTML = `
      <div class="inspector-card">
        <div class="meta-line">Status</div>
        <div class="render-status-pill render-status-pill-${escapeAttribute(renderState.status || 'idle')}">${escapeHtml(
          renderState.status || 'idle',
        )}</div>
        <div class="meta-line">Queue Source: ${escapeHtml(queueMode)}</div>
        <div class="meta-line">Layers to Resolve: ${queueSummary.layerCount}</div>
        <div class="meta-line">Segments: ${queueSummary.sourceSegmentCount}</div>
        <div class="meta-line">Consolidated Jobs: ${queueSummary.consolidatedJobCount}</div>
        <div class="meta-line">Muted Segments: ${queueSummary.mutedSegmentCount}</div>
        <div class="toolbar-group toolbar-group-vertical">
          <button id="start-render-btn" type="button" class="btn-accent" ${canStartRender ? '' : 'disabled'}>Start Render</button>
        </div>
        ${
          !canStartRender && state.projectDirty
            ? '<p class="hint">Save the project before starting a new render.</p>'
            : !canStartRender && queueSummary.consolidatedJobCount === 0
              ? '<p class="hint">There are no active render jobs in the current queue.</p>'
              : ''
        }
      </div>
      <div class="inspector-card">
        <div class="meta-line">Queue Progress</div>
        <div class="meta-line">Pending: ${queueSummary.pendingJobCount}</div>
        <div class="meta-line">Running: ${queueSummary.runningJobCount}</div>
        <div class="meta-line">Completed: ${queueSummary.completedJobCount}</div>
        <div class="meta-line">Failed: ${queueSummary.failedJobCount}</div>
        ${renderState.startedAt ? `<div class="meta-line">Started: ${escapeHtml(formatDate(renderState.startedAt))}</div>` : ''}
        ${renderState.endedAt ? `<div class="meta-line">Ended: ${escapeHtml(formatDate(renderState.endedAt))}</div>` : ''}
        ${renderState.error ? `<div class="meta-line">Error: ${escapeHtml(renderState.error)}</div>` : ''}
      </div>
      <div class="inspector-card">
        <div class="meta-line">Last Output</div>
        <div class="render-output-file">${escapeHtml(outputName || 'No output yet')}</div>
        ${
          outputPath
            ? `<a class="summary-render-link" href="${escapeAttribute(outputPath)}" target="_blank" rel="noopener">Open Render</a>`
            : '<p class="hint">Run the queue to produce an output file.</p>'
        }
      </div>
    `;
    document.getElementById('start-render-btn')?.addEventListener('click', () => {
      startRender().catch((error) => {
        console.error(error);
      });
    });
  }

  function renderToolsPanel() {
    const project = state.project;
    const emptyProjectHint = '<p class="hint">Select a project to edit layers.</p>';
    const emptyLayerHint = '<p class="hint">Select a layer to inspect.</p>';
    if (!project) {
      if (elements.toolsTabBtn) {
        elements.toolsTabBtn.textContent = 'Layer';
      }
      elements.videoPanelTitle.textContent = 'Video';
      elements.videoSourcePanelContent.innerHTML = emptyProjectHint;
      elements.transcriberPanelTitle.textContent = 'Transcriber';
      elements.transcriberPanelContent.innerHTML = emptyProjectHint;
      elements.clippingPanelTitle.textContent = 'Clipping';
      elements.clippingPanelContent.innerHTML = emptyProjectHint;
      return;
    }
    const layer = getSelectedLayer();
    if (!layer) {
      if (elements.toolsTabBtn) {
        elements.toolsTabBtn.textContent = 'Layer';
      }
      elements.videoPanelTitle.textContent = 'Video';
      elements.videoSourcePanelContent.innerHTML = emptyLayerHint;
      elements.transcriberPanelTitle.textContent = 'Transcriber';
      elements.transcriberPanelContent.innerHTML = emptyLayerHint;
      elements.clippingPanelTitle.textContent = 'Clipping';
      elements.clippingPanelContent.innerHTML = emptyLayerHint;
      return;
    }
    const layerLabel = layer.name || 'Layer 1';
    if (elements.toolsTabBtn) {
      elements.toolsTabBtn.textContent = `Layer: ${layerLabel}`;
    }
    elements.videoPanelTitle.textContent = `Video: ${layerLabel}`;
    elements.transcriberPanelTitle.textContent = `Transcriber: ${layerLabel}`;
    elements.clippingPanelTitle.textContent = `Clipping: ${layerLabel}`;
    const clip = layer.clip;
    const selectedMediaId = clip?.sourceVideoId || '';
    const mediaOptions = [
      `<option value="">Choose converted video</option>`,
      ...state.media.map((item) => {
        const selected = item.id === selectedMediaId ? ' selected' : '';
        return `<option value="${escapeAttribute(item.id)}"${selected}>${escapeHtml(item.sourceProjectId)} / ${escapeHtml(item.filename)}</option>`;
      }),
    ];
    const media = clip ? findMedia(clip.sourceVideoId) : null;
    const previewSource = clip?.sourcePath || media?.path || '';
    const transcription = layer.transcription || null;
    const textPreview = transcription?.textPreview
      ? `Preview: ${escapeHtml(transcription.textPreview.slice(0, 220))}${transcription.textPreview.length > 220 ? '…' : ''}`
      : '';
    const metadata = media
      ? [
          `Duration: ${formatClock(media.durationMs || clip.sourceDurationMs)}`,
          `Resolution: ${media.width || '-'} x ${media.height || '-'}`,
          `Codec: ${media.codec || '-'}`,
          `Size: ${formatBytes(media.size || 0)}`,
        ]
        : [];
    const isThumbBusy = state.thumbnailBusyLayerId === layer.id;
    const audioForLayer = Boolean(transcription?.audio?.path);
    const transcriptionBusy = state.transcriptionBusyLayerId === layer.id;
    const transcriptionBusyAction = transcriptionBusy ? (state.transcriptionBusyAction || '') : '';
    const transcriberStatus = transcriptionBusy
      ? transcriptionBusyAction === 'extract'
        ? 'extracting'
        : transcriptionBusyAction === 'transcribe'
          ? 'transcribing'
          : 'processing'
      : transcribeCaptionerService.getStatus(layer);
    const transcriberStatusClass = transcriptionBusy ? 'busy' : transcriberStatus.replace(/[^a-z0-9-]/gi, '');
    const transcriberStatusLine =
      transcriptionBusy && transcriptionBusyAction === 'extract'
        ? 'Rendering layer audio (FFmpeg) and saving MP3...'
        : transcriptionBusy && transcriptionBusyAction === 'transcribe'
          ? 'Running OpenAI transcription...'
          : transcriberStatus === 'audio-ready'
            ? 'Audio ready to transcribe'
            : transcriberStatus === 'transcribed'
              ? 'Transcription ready'
              : transcriberStatus === 'error'
                ? `Transcription error: ${escapeHtml(transcription?.error || 'unknown')}`
                : '';
    elements.videoSourcePanelContent.innerHTML = `
      <div class="inspector-card">
        <select id="inspector-media-select">${mediaOptions.join('')}</select>
        ${isThumbBusy ? '<p class="meta-line">Generating thumbnail strip...</p>' : ''}
        ${
          previewSource
            ? `<video class="inspector-video" controls preload="metadata" src="${escapeAttribute(previewSource)}"></video>`
            : '<p class="hint">Select a source video for this layer to preview it here.</p>'
        }
        ${
          audioForLayer
            ? `<div class="transcription-audio-link ${transcriptionBusy ? 'transcription-audio-link--busy' : ''}">
                <span class="transcription-audio-dot"></span>
                <span>Layer MP3 associated: ${formatBytes(transcription.audio.sizeBytes || 0)}</span>
              </div>`
            : transcriptionBusy && transcriptionBusyAction === 'extract'
              ? `<div class="transcription-audio-link transcription-audio-link--busy">
                   <span class="transcription-audio-dot"></span>
                   <span>Layer MP3: rendering in progress...</span>
                 </div>`
              : ''
        }
      </div>
      <div class="inspector-card">
        <div class="field-grid">
          <div class="field">
            <label>Start (ms)</label>
            <input id="inspector-start-ms" type="number" min="${clip ? -Math.max(0, clip.trimInMs || 0) : 0}" max="43200000" step="100" value="${clip ? clip.startMs : 0}" ${clip ? '' : 'disabled'} />
          </div>
          <div class="field">
            <label>Source Duration (ms)</label>
            <input type="number" value="${clip ? clip.sourceDurationMs : 0}" disabled />
          </div>
          <div class="field">
            <label>Trim In (ms)</label>
            <input id="inspector-trim-in-ms" type="number" min="0" max="${clip ? clip.sourceDurationMs : 0}" step="100" value="${clip ? clip.trimInMs : 0}" ${clip ? '' : 'disabled'} />
          </div>
          <div class="field">
            <label>Trim Out (ms)</label>
            <input id="inspector-trim-out-ms" type="number" min="${clip ? clip.trimInMs : 0}" max="${clip ? clip.sourceDurationMs : 0}" step="100" value="${clip ? clip.trimOutMs : 0}" ${clip ? '' : 'disabled'} />
          </div>
        </div>
        <div class="toolbar-group toolbar-group-vertical">
          <button id="inspector-reset-trim" type="button" ${clip ? '' : 'disabled'}>Reset Trims</button>
          <button id="inspector-clear-clip" type="button" ${clip ? '' : 'disabled'}>Clear Clip</button>
          <button id="inspector-remove-layer" type="button" ${project.layers.length <= 1 ? 'disabled' : ''}>Remove Layer</button>
        </div>
      </div>
      <div class="inspector-card">
        ${metadata.length ? metadata.map((line) => `<div class="meta-line">${escapeHtml(line)}</div>`).join('') : '<p class="hint">No source selected for this layer.</p>'}
      </div>
    `;
    elements.transcriberPanelTitle.textContent = `Transcriber: ${layerLabel}`;
    elements.transcriberPanelContent.innerHTML = `
      <div class="inspector-card">
        <div class="meta-line">Transcriber</div>
        <label class="transcription-visibility-toggle">
          <input id="transcriber-timeline-visible" type="checkbox" ${
            transcription?.timelineVisible !== false ? 'checked' : ''
          } ${transcription?.transcript?.path ? '' : 'disabled'} />
          <span>Show transcript on timeline</span>
        </label>
        <div class="meta-line">Status: <span class="transcriber-status-pill transcriber-status-pill-${escapeAttribute(transcriberStatusClass)}">${escapeHtml(
          transcriberStatus,
        )}</span></div>
        ${transcription?.model ? `<div class="meta-line">Model: ${escapeHtml(transcription.model)}</div>` : ''}
        ${transcription?.responseFormat ? `<div class="meta-line">Format: ${escapeHtml(transcription.responseFormat)}</div>` : ''}
        ${transcription?.timelineMode ? `<div class="meta-line">Timeline Data: ${escapeHtml(transcription.timelineMode)}</div>` : ''}
        ${transcription?.segmentCount !== null && transcription?.segmentCount !== undefined ? `<div class="meta-line">Segments: ${escapeHtml(String(transcription.segmentCount))}</div>` : ''}
        ${transcription?.wordCount !== null && transcription?.wordCount !== undefined ? `<div class="meta-line">Words: ${escapeHtml(String(transcription.wordCount))}</div>` : ''}
        ${transcription?.timestampGranularities?.length ? `<div class="meta-line">Timestamps: ${escapeHtml(transcription.timestampGranularities.join(', '))}</div>` : ''}
        ${transcriberStatusLine ? `<div class="meta-line transcription-progress">${escapeHtml(transcriberStatusLine)}</div>` : ''}
        ${transcription?.audio?.path ? `<div class="meta-line">Audio: ${formatBytes(transcription.audio.sizeBytes || 0)} (${escapeHtml(transcription.audio.path)})</div>` : ''}
        ${transcription?.transcript?.path ? `<div class="meta-line">Transcript: ${formatBytes(transcription.transcript.sizeBytes || 0)} (${escapeHtml(transcription.transcript.path)})</div>` : ''}
        ${transcription?.markdown?.path ? `<div class="meta-line">Markdown: ${formatBytes(transcription.markdown.sizeBytes || 0)} (${escapeHtml(transcription.markdown.path)})</div>` : ''}
        ${textPreview ? `<div class="meta-line">${textPreview}</div>` : ''}
        <div class="toolbar-group toolbar-group-vertical">
          <button id="transcriber-extract-btn" type="button" ${clip && !transcriptionBusy ? '' : 'disabled'}>${
            transcriptionBusy && transcriptionBusyAction === 'extract' ? 'Converting to Audio...' : 'Convert to Audio'
          }</button>
          <button id="transcriber-run-btn" type="button" ${
            !transcriptionBusy && transcribeCaptionerService.canTranscribe(layer) ? '' : 'disabled'
          }>${transcriptionBusy && transcriptionBusyAction === 'transcribe' ? 'Running Transcription...' : 'Run Transcription'}</button>
          <button id="transcriber-view-json-btn" type="button" ${
            transcription?.transcript?.path && !transcriptionBusy ? '' : 'disabled'
          } data-visible="${state.transcriptionViewerLayerId === layer.id}">View Transcript JSON</button>
          <label class="transcription-visibility-toggle">
            <input id="transcriber-export-markdown-toggle" type="checkbox" ${
              transcription?.markdown?.path ? 'checked' : ''
            } ${transcription?.transcript?.path && !transcriptionBusy ? '' : 'disabled'} />
            <span>Export transcript markdown</span>
          </label>
          <button id="transcriber-view-markdown-btn" type="button" ${
            transcription?.markdown?.path && !transcriptionBusy ? '' : 'disabled'
          }>View Transcript Markdown</button>
        </div>
        <pre id="transcriber-json" class="transcriber-json ${state.transcriptionViewerLayerId === layer.id ? '' : 'hidden'}">${escapeHtml(
          formatTranscriberJson(
            state.transcriptionTextCache.get(layer.id) || (transcription?.textPreview ? {text: transcription.textPreview} : null),
          ),
        )}
</pre>
      </div>
    `;
    const clipping = normalizeClipping(layer.clipping) || {selectedClipId: null, clips: []};
    const selectedClippingClip = clipping.clips.find((item) => item.id === clipping.selectedClipId) || clipping.clips[0] || null;
    const currentPlayheadMs = state.previewPlayback.layerId === layer.id ? state.previewPlayback.currentTimeMs : 0;
    const hasTranscriptSegments = Array.isArray(transcription?.timelineSegments) && transcription.timelineSegments.length > 0;
    elements.clippingPanelContent.innerHTML = `
      <div class="inspector-card">
        <div class="meta-line">ClipUI</div>
        <div class="meta-line">Clips: ${clipping.clips.length}</div>
        <div class="meta-line">Playhead: ${formatClock(currentPlayheadMs)}</div>
        <div class="toolbar-group toolbar-group-vertical">
          <button id="clipping-provision-btn" type="button" ${hasTranscriptSegments ? '' : 'disabled'}>Provision Clips</button>
        </div>
      </div>
      <div class="inspector-card">
        ${
          selectedClippingClip
            ? `
              <div class="meta-line">Selected: ${escapeHtml(selectedClippingClip.id)}</div>
              <div class="field-grid">
                <div class="field">
                  <label>Start (ms)</label>
                  <input id="clipping-start-ms" type="number" min="0" step="100" value="${selectedClippingClip.startMs}" />
                </div>
                <div class="field">
                  <label>End (ms)</label>
                  <input id="clipping-end-ms" type="number" min="${selectedClippingClip.startMs}" step="100" value="${selectedClippingClip.endMs}" />
                </div>
              </div>
              <div class="clipping-stepper-row">
                <button id="clipping-start-minus-btn" type="button">Start -</button>
                <button id="clipping-start-plus-btn" type="button">Start +</button>
                <button id="clipping-end-minus-btn" type="button">End -</button>
                <button id="clipping-end-plus-btn" type="button">End +</button>
              </div>
              <div class="field">
                <label>Clip Text</label>
                <textarea id="clipping-text">${escapeHtml(selectedClippingClip.text || '')}</textarea>
              </div>
              <label class="transcription-visibility-toggle">
                <input id="clipping-muted-toggle" type="checkbox" ${selectedClippingClip.muted ? 'checked' : ''} />
                <span>Muted</span>
              </label>
              <div class="toolbar-group toolbar-group-vertical">
                <button id="clipping-split-btn" type="button">Split Clip At Playhead</button>
                <button id="clipping-delete-btn" type="button">Delete Clip</button>
              </div>
            `
            : '<p class="hint">Provision clips from the transcript to inspect and edit them here.</p>'
        }
      </div>
    `;
    bindVideoSourceEvents(layer);
    bindTranscriberEvents(layer);
    bindClippingEvents(layer);
  }

  function bindVideoSourceEvents(layer) {
    const mediaSelect = document.getElementById('inspector-media-select');
    const startInput = document.getElementById('inspector-start-ms');
    const trimInInput = document.getElementById('inspector-trim-in-ms');
    const trimOutInput = document.getElementById('inspector-trim-out-ms');
    const resetTrimButton = document.getElementById('inspector-reset-trim');
    const clearClipButton = document.getElementById('inspector-clear-clip');
    const removeLayerButton = document.getElementById('inspector-remove-layer');
    const previewVideo = document.querySelector('.inspector-video');

    const refreshNumericBounds = () => {
      if (!layer.clip) return;
      if (startInput) {
        startInput.min = String(-Math.max(0, Number(layer.clip.trimInMs) || 0));
        startInput.max = '43200000';
      }
      if (trimInInput) {
        trimInInput.min = '0';
        trimInInput.max = String(layer.clip.sourceDurationMs);
      }
      if (trimOutInput) {
        trimOutInput.min = String(layer.clip.trimInMs);
        trimOutInput.max = String(layer.clip.sourceDurationMs);
      }
    };

    const refreshNumericValues = () => {
      if (!layer.clip) return;
      if (startInput) {
        startInput.value = String(layer.clip.startMs);
      }
      if (trimInInput) {
        trimInInput.value = String(layer.clip.trimInMs);
      }
      if (trimOutInput) {
        trimOutInput.value = String(layer.clip.trimOutMs);
      }
      refreshNumericBounds();
    };

    mediaSelect?.addEventListener('change', async () => {
      stopPreviewPlayback();
      const mediaId = mediaSelect.value;
      if (!mediaId) {
        layer.clip = null;
        layer.transcription = null;
        layer.clipping = null;
        state.transcriptionTextCache.delete(layer.id);
        state.transcriptionViewerLayerId = null;
        syncTimelineZoom();
        renderTimeline();
        renderRightSidebar();
        renderProjectSummary();
        markProjectDirty();
        return;
      }
      const media = findMedia(mediaId);
      if (!media) return;
      const durationMs = Math.max(0, Number(media.durationMs) || 0);
      const previousStart = layer.clip?.startMs || 0;
      layer.clip = {
        sourceVideoId: media.id,
        sourcePath: media.path,
        sourceDurationMs: durationMs,
        startMs: previousStart,
        trimInMs: 0,
        trimOutMs: durationMs,
        thumbnails: [],
      };
      layer.transcription = null;
      layer.clipping = null;
      state.transcriptionTextCache.delete(layer.id);
      state.transcriptionViewerLayerId = null;
      syncTimelineZoom();
      renderTimeline();
      renderRightSidebar();
      renderProjectSummary();
      markProjectDirty();
      await generateLayerThumbnails(layer.id, media.id);
    });

    const applyStartInput = () => {
      if (!layer.clip || !startInput) return;
      const raw = String(startInput.value || '').trim();
      if (!raw) return;
      const minStart = -Math.max(0, Number(layer.clip.trimInMs) || 0);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      layer.clip.startMs = clampInt(parsed, minStart, 12 * 60 * 60 * 1000);
      startInput.value = String(layer.clip.startMs);
      refreshNumericBounds();
      syncTimelineZoom();
      renderTimeline();
      renderProjectSummary();
      markProjectDirty();
    };

    const applyTrimInInput = () => {
      if (!layer.clip || !trimInInput) return;
      const raw = String(trimInInput.value || '').trim();
      if (!raw) return;
      const durationMs = layer.clip.sourceDurationMs;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      const trimIn = clampInt(parsed, 0, durationMs);
      layer.clip.trimInMs = trimIn;
      layer.clip.trimOutMs = clampInt(layer.clip.trimOutMs, trimIn, durationMs);
      layer.clip.startMs = clampInt(layer.clip.startMs, -trimIn, 12 * 60 * 60 * 1000);
      refreshNumericValues();
      syncTimelineZoom();
      renderTimeline();
      renderProjectSummary();
      markProjectDirty();
    };

    const applyTrimOutInput = () => {
      if (!layer.clip || !trimOutInput) return;
      const raw = String(trimOutInput.value || '').trim();
      if (!raw) return;
      const durationMs = layer.clip.sourceDurationMs;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      layer.clip.trimOutMs = clampInt(parsed, layer.clip.trimInMs, durationMs);
      trimOutInput.value = String(layer.clip.trimOutMs);
      refreshNumericBounds();
      syncTimelineZoom();
      renderTimeline();
      renderProjectSummary();
      markProjectDirty();
    };

    startInput?.addEventListener('input', applyStartInput);
    startInput?.addEventListener('change', applyStartInput);
    trimInInput?.addEventListener('input', applyTrimInInput);
    trimInInput?.addEventListener('change', applyTrimInInput);
    trimOutInput?.addEventListener('input', applyTrimOutInput);
    trimOutInput?.addEventListener('change', applyTrimOutInput);

    resetTrimButton?.addEventListener('click', () => {
      if (!layer.clip) return;
      layer.clip.trimInMs = 0;
      layer.clip.trimOutMs = layer.clip.sourceDurationMs;
      layer.clip.startMs = clampInt(layer.clip.startMs, 0, 12 * 60 * 60 * 1000);
      syncTimelineZoom();
      renderTimeline();
      refreshNumericValues();
      renderProjectSummary();
      markProjectDirty();
    });

    clearClipButton?.addEventListener('click', () => {
      layer.clip = null;
      layer.transcription = null;
      layer.clipping = null;
      state.transcriptionTextCache.delete(layer.id);
      state.transcriptionViewerLayerId = null;
      syncTimelineZoom();
      renderTimeline();
      renderRightSidebar();
      renderProjectSummary();
      markProjectDirty();
    });

    removeLayerButton?.addEventListener('click', () => {
      if (state.previewPlayback.layerId === layer.id) {
        stopPreviewPlayback();
      }
      if (!state.project) return;
      if (state.project.layers.length <= 1) return;
      const index = state.project.layers.findIndex((item) => item.id === layer.id);
      if (index < 0) return;
      state.project.layers.splice(index, 1);
      state.project.timeline.masterOrder = (state.project.timeline.masterOrder || []).filter((id) => id !== layer.id);
      if (!state.project.timeline.masterOrder.length) {
        state.project.timeline.masterOrder = state.project.layers.map((item) => item.id);
      }
      const nextSelected =
        state.project.layers[Math.min(index, state.project.layers.length - 1)] || state.project.layers[0] || null;
      state.project.selectedLayerId = nextSelected ? nextSelected.id : null;
      syncTimelineZoom();
      renderAll();
      markProjectDirty();
    });

    if (previewVideo && layer.clip) {
      const preservedPreviewTimeMs =
        state.previewPlayback.layerId === layer.id ? Math.max(0, state.previewPlayback.currentTimeMs) : null;
      let restoredPreviewTime = false;

      const restorePreviewPlaybackPosition = () => {
        if (restoredPreviewTime || preservedPreviewTimeMs === null || previewVideo.readyState < 1) {
          return;
        }
        previewVideo.currentTime = preservedPreviewTimeMs / 1000;
        state.previewPlayback.layerId = layer.id;
        state.previewPlayback.currentTimeMs = preservedPreviewTimeMs;
        restoredPreviewTime = true;
        updateTimelinePlayhead();
      };

      const syncPreviewPlayback = () => {
        if (state.project?.selectedLayerId !== layer.id) {
          stopPreviewPlayback();
          return;
        }
        state.previewPlayback.layerId = layer.id;
        state.previewPlayback.currentTimeMs = Math.max(0, Math.round((previewVideo.currentTime || 0) * 1000));
        updateTimelinePlayhead();
      };

      const tickPreviewPlayback = () => {
        if (!state.previewPlayback.playing) {
          return;
        }
        syncPreviewPlayback();
        state.previewPlayback.rafId = window.requestAnimationFrame(tickPreviewPlayback);
      };

      previewVideo.addEventListener('loadedmetadata', () => {
        restorePreviewPlaybackPosition();
        syncPreviewPlayback();
      });
      previewVideo.addEventListener('timeupdate', syncPreviewPlayback);
      previewVideo.addEventListener('seeked', syncPreviewPlayback);
      previewVideo.addEventListener('pause', () => {
        state.previewPlayback.playing = false;
        if (state.previewPlayback.rafId !== null) {
          window.cancelAnimationFrame(state.previewPlayback.rafId);
          state.previewPlayback.rafId = null;
        }
        syncPreviewPlayback();
      });
      previewVideo.addEventListener('ended', () => {
        state.previewPlayback.playing = false;
        if (state.previewPlayback.rafId !== null) {
          window.cancelAnimationFrame(state.previewPlayback.rafId);
          state.previewPlayback.rafId = null;
        }
        syncPreviewPlayback();
      });
      previewVideo.addEventListener('play', () => {
        state.previewPlayback.playing = true;
        syncPreviewPlayback();
        if (state.previewPlayback.rafId === null) {
          state.previewPlayback.rafId = window.requestAnimationFrame(tickPreviewPlayback);
        }
      });
      restorePreviewPlaybackPosition();
      syncPreviewPlayback();
    } else if (state.previewPlayback.layerId === layer.id) {
      stopPreviewPlayback();
    }
  }

  function stopPreviewPlayback() {
    state.previewPlayback.playing = false;
    if (state.previewPlayback.rafId !== null) {
      window.cancelAnimationFrame(state.previewPlayback.rafId);
      state.previewPlayback.rafId = null;
    }
    state.previewPlayback.layerId = null;
    state.previewPlayback.currentTimeMs = 0;
    updateTimelinePlayhead();
  }

  function ensureClippingState(layer) {
    const existing = normalizeClipping(layer?.clipping);
    if (existing) {
      layer.clipping = existing;
      return existing;
    }
    const next = {selectedClipId: null, clips: []};
    if (layer) {
      layer.clipping = next;
    }
    return next;
  }

  function getSelectedClippingClip(layer) {
    const clipping = ensureClippingState(layer);
    return clipping.clips.find((clip) => clip.id === clipping.selectedClipId) || clipping.clips[0] || null;
  }

  function provisionClipsFromTranscription(layer) {
    const segments = Array.isArray(layer?.transcription?.timelineSegments) ? layer.transcription.timelineSegments : [];
    const clips = segments.map((segment, index) => ({
      id: `clip-${index + 1}`,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text || '',
      muted: false,
    }));
    layer.clipping = {
      selectedClipId: clips[0]?.id || null,
      clips,
    };
  }

  function selectClippingClip(layerId, clipId, shouldSeek = false) {
    const layer = findLayer(layerId);
    if (!layer) return;
    const clipping = ensureClippingState(layer);
    if (!clipping.clips.some((clip) => clip.id === clipId)) return;
    clipping.selectedClipId = clipId;
    state.project.selectedLayerId = layerId;
    const clip = clipping.clips.find((item) => item.id === clipId);
    if (shouldSeek && clip) {
      state.previewPlayback.layerId = layerId;
      state.previewPlayback.currentTimeMs = clip.startMs;
    }
    renderAll();
    if (shouldSeek && clip) {
      syncPreviewElementToPlaybackState(layerId);
    }
  }

  function applyClipBoundaryChange(layer, clipId, field, value) {
    const clipping = ensureClippingState(layer);
    const clips = clipping.clips;
    const index = clips.findIndex((clip) => clip.id === clipId);
    if (index < 0 || !layer?.clip) return;
    const current = clips[index];
    const sourceDurationMs = Math.max(1, Number(layer.clip.sourceDurationMs) || 1);
    if (field === 'startMs') {
      const previous = clips[index - 1] || null;
      const min = previous ? previous.startMs + 100 : 0;
      const max = Math.max(min, current.endMs - 100);
      current.startMs = clampInt(value, min, max);
      if (previous) {
        previous.endMs = current.startMs;
      }
    } else if (field === 'endMs') {
      const next = clips[index + 1] || null;
      const min = current.startMs + 100;
      const max = next ? next.endMs - 100 : sourceDurationMs;
      current.endMs = clampInt(value, min, max);
      if (next) {
        next.startMs = current.endMs;
      }
    }
    layer.clipping = normalizeClipping(clipping);
  }

  function splitSelectedClipAtPlayhead(layer) {
    const clipping = ensureClippingState(layer);
    const clips = clipping.clips;
    const clip = getSelectedClippingClip(layer);
    if (!clip) return;
    const index = clips.findIndex((item) => item.id === clip.id);
    if (index < 0) return;
    const splitMs = clampInt(state.previewPlayback.currentTimeMs, clip.startMs + 100, clip.endMs - 100);
    if (splitMs <= clip.startMs || splitMs >= clip.endMs) {
      return;
    }
    const originalEndMs = clip.endMs;
    const nextClip = {
      id: `clip-${Date.now()}`,
      startMs: splitMs,
      endMs: originalEndMs,
      text: clip.text,
      muted: clip.muted,
    };
    clips.splice(index + 1, 0, nextClip);
    clips[index].endMs = splitMs;
    clips[index + 1].startMs = splitMs;
    clipping.selectedClipId = nextClip.id;
    layer.clipping = normalizeClipping(clipping);
  }

  function deleteSelectedClip(layer) {
    const clipping = ensureClippingState(layer);
    const clips = clipping.clips;
    const clip = getSelectedClippingClip(layer);
    if (!clip) return;
    const index = clips.findIndex((item) => item.id === clip.id);
    if (index < 0) return;
    const previous = clips[index - 1] || null;
    const next = clips[index + 1] || null;
    if (previous && next) {
      previous.endMs = next.startMs;
    } else if (previous) {
      previous.endMs = clip.endMs;
    } else if (next) {
      next.startMs = clip.startMs;
    }
    clips.splice(index, 1);
    clipping.selectedClipId = clips[Math.min(index, clips.length - 1)]?.id || clips[0]?.id || null;
    layer.clipping = normalizeClipping(clipping);
  }

  function seekLayerPreviewToMs(layerId, timeMs, options = {}) {
    if (!state.project) return;
    const layer = findLayer(layerId);
    if (!layer?.clip) return;
    const shouldRender = options.render !== false;
    state.project.selectedLayerId = layerId;
    const targetMs = clampInt(timeMs, 0, Math.max(0, Number(layer.clip.sourceDurationMs) || 0));
    state.previewPlayback.layerId = layerId;
    state.previewPlayback.currentTimeMs = targetMs;
    if (shouldRender) {
      renderTimeline();
      renderRightSidebar();
    }
    syncPreviewElementToPlaybackState(layerId);
    updateTimelinePlayhead();
  }

  function syncPreviewElementToPlaybackState(layerId) {
    const previewVideo = document.querySelector('.inspector-video');
    if (!previewVideo || state.previewPlayback.layerId !== layerId) {
      return;
    }
    const targetSeconds = state.previewPlayback.currentTimeMs / 1000;
    if (Math.abs((previewVideo.currentTime || 0) - targetSeconds) > 0.05) {
      previewVideo.currentTime = targetSeconds;
    }
  }

  function updateTimelinePlayhead() {
    if (!state.project) {
      return;
    }
    const layer = getSelectedLayer();
    const timelinePlayhead = document.getElementById('timeline-playhead');
    const clipPlayheads = elements.timelineContent.querySelectorAll('.clip-view-playhead');
    if (!layer?.clip || state.previewPlayback.layerId !== layer.id) {
      timelinePlayhead?.classList.add('hidden');
      clipPlayheads.forEach((node) => {
        node.classList.add('hidden');
      });
      return;
    }
    const pxPerMs = getPxPerMs();
    const sourceLeftPx = Math.floor(state.previewPlayback.currentTimeMs * pxPerMs);
    clipPlayheads.forEach((node) => {
      node.style.left = `${Math.max(0, sourceLeftPx)}px`;
      node.classList.remove('hidden');
    });
    if (!timelinePlayhead) {
      return;
    }
    const timelineMs = (Number(layer.clip.startMs) || 0) + state.previewPlayback.currentTimeMs;
    const leftPx = Math.floor(timelineMs * pxPerMs) + 152;
    timelinePlayhead.style.left = `${Math.max(12, leftPx)}px`;
    timelinePlayhead.classList.remove('hidden');
  }

  function bindTranscriberEvents(layer) {
    const extractButton = document.getElementById('transcriber-extract-btn');
    const runButton = document.getElementById('transcriber-run-btn');
    const viewButton = document.getElementById('transcriber-view-json-btn');
    const exportMarkdownToggle = document.getElementById('transcriber-export-markdown-toggle');
    const viewMarkdownButton = document.getElementById('transcriber-view-markdown-btn');
    const timelineToggle = document.getElementById('transcriber-timeline-visible');
    const transcriptArea = document.getElementById('transcriber-json');

    const syncTranscriberState = (nextLayer = layer) => {
      if (!state.project) return;
      const current = nextLayer?.transcription;
      const currentLayerId = nextLayer?.id;
      if (state.transcriptionBusyLayerId === currentLayerId) {
        if (state.transcriptionBusyAction === 'extract') {
          elements.renderLogs.textContent = `Transcriber: extracting audio for ${currentLayerId}...`;
        } else if (state.transcriptionBusyAction === 'transcribe') {
          elements.renderLogs.textContent = `Transcriber: running transcription for ${currentLayerId}...`;
        } else {
          elements.renderLogs.textContent = `Transcriber: processing ${currentLayerId}...`;
        }
      } else if (current?.error) {
        elements.renderLogs.textContent = `Transcriber: ${current.error}`;
      }
      renderToolsPanel();
      renderTimeline();
    };

    extractButton?.addEventListener('click', async () => {
      if (!state.project || !layer.clip) return;
      state.transcriptionBusyLayerId = layer.id;
      state.transcriptionBusyAction = 'extract';
      layer.transcription = {
        ...(layer.transcription || {}),
        status: 'processing',
        updatedAt: new Date().toISOString(),
      };
      syncTranscriberState();
      try {
        const data = await transcribeCaptionerService.extractAudio(state.project.id, layer.id);
        layer.transcription = data.transcription || layer.transcription || null;
        layer.transcription = normalizeTranscription(layer.transcription);
        state.transcriptionTextCache.delete(layer.id);
        state.transcriptionViewerLayerId = null;
        markProjectDirty();
      } catch (error) {
        console.error(error);
        layer.transcription = {
          ...normalizeTranscription(layer.transcription),
          status: 'error',
          error: error.message,
          updatedAt: new Date().toISOString(),
        };
        elements.renderLogs.textContent = `Transcriber failed: ${error.message}`;
        markProjectDirty();
      } finally {
        state.transcriptionBusyLayerId = null;
        state.transcriptionBusyAction = null;
        syncTranscriberState(layer);
      }
    });

    runButton?.addEventListener('click', async () => {
      if (!state.project || !layer.transcription?.audio?.path) return;
      state.transcriptionBusyLayerId = layer.id;
      state.transcriptionBusyAction = 'transcribe';
      layer.transcription = {
        ...(layer.transcription || {}),
        status: 'processing',
        updatedAt: new Date().toISOString(),
      };
      syncTranscriberState();
      try {
        const data = await transcribeCaptionerService.runTranscription(state.project.id, layer.id);
        layer.transcription = hydrateTranscriptionWithTranscriptData(
          data.transcription || layer.transcription || null,
          data?.transcript,
        );
        if (data?.transcript) {
          state.transcriptionTextCache.set(layer.id, data.transcript);
        }
        state.transcriptionViewerLayerId = layer.id;
        markProjectDirty();
      } catch (error) {
        console.error(error);
        layer.transcription = {
          ...normalizeTranscription(layer.transcription),
          status: 'error',
          error: error.message,
          updatedAt: new Date().toISOString(),
        };
        elements.renderLogs.textContent = `Transcriber failed: ${error.message}`;
        markProjectDirty();
      } finally {
        state.transcriptionBusyLayerId = null;
        state.transcriptionBusyAction = null;
        syncTranscriberState(layer);
      }
    });

    viewButton?.addEventListener('click', async () => {
      if (!state.project) return;
      if (!state.transcriptionTextCache.has(layer.id)) {
        viewButton.disabled = true;
        viewButton.textContent = 'Loading...';
        try {
          const data = await transcribeCaptionerService.fetchTranscription(state.project.id, layer.id);
          layer.transcription = hydrateTranscriptionWithTranscriptData(
            data.transcription || layer.transcription || null,
            data?.transcript,
          );
          if (data?.transcript) {
            state.transcriptionTextCache.set(layer.id, data.transcript);
          }
        } catch (error) {
          console.error(error);
          elements.renderLogs.textContent = `Transcriber fetch failed: ${error.message}`;
        } finally {
          viewButton.disabled = false;
          viewButton.textContent = 'View Transcript JSON';
        }
      }
      state.transcriptionViewerLayerId =
        state.transcriptionViewerLayerId === layer.id ? null : layer.id;
      if (transcriptArea) {
        transcriptArea.classList.toggle('hidden', state.transcriptionViewerLayerId !== layer.id);
      }
      if (viewButton) {
        viewButton.setAttribute(
          'data-visible',
          state.transcriptionViewerLayerId === layer.id ? 'true' : 'false',
        );
      }
      syncTranscriberState(layer);
    });

    exportMarkdownToggle?.addEventListener('change', async () => {
      if (!state.project || !layer.transcription?.transcript?.path) return;
      if (!exportMarkdownToggle.checked) {
        exportMarkdownToggle.disabled = true;
        try {
          const data = await transcribeCaptionerService.exportMarkdown(state.project.id, layer.id, false);
          layer.transcription = normalizeTranscription(data.transcription || layer.transcription || null);
          renderToolsPanel();
        } catch (error) {
          console.error(error);
          exportMarkdownToggle.checked = true;
          elements.renderLogs.textContent = `Transcript markdown export failed: ${error.message}`;
        } finally {
          exportMarkdownToggle.disabled = false;
        }
        return;
      }
      exportMarkdownToggle.disabled = true;
      try {
        const data = await transcribeCaptionerService.exportMarkdown(state.project.id, layer.id);
        layer.transcription = normalizeTranscription(data.transcription || layer.transcription || null);
        renderToolsPanel();
      } catch (error) {
        console.error(error);
        exportMarkdownToggle.checked = false;
        elements.renderLogs.textContent = `Transcript markdown export failed: ${error.message}`;
      } finally {
        exportMarkdownToggle.disabled = false;
      }
    });

    viewMarkdownButton?.addEventListener('click', async () => {
      if (!state.project) return;
      if (!layer.transcription?.markdown?.path && layer.transcription?.transcript?.path) {
        try {
          const data = await transcribeCaptionerService.exportMarkdown(state.project.id, layer.id);
          layer.transcription = normalizeTranscription(data.transcription || layer.transcription || null);
          renderToolsPanel();
        } catch (error) {
          console.error(error);
          elements.renderLogs.textContent = `Transcript markdown export failed: ${error.message}`;
          return;
        }
      }
      if (layer.transcription?.markdown?.path) {
        window.open(layer.transcription.markdown.path, '_blank', 'noopener');
      }
    });

    timelineToggle?.addEventListener('change', async () => {
      const nextVisible = Boolean(timelineToggle.checked);
      layer.transcription = normalizeTranscription({
        ...(layer.transcription || {}),
        timelineVisible: nextVisible,
        updatedAt: new Date().toISOString(),
      });
      renderToolsPanel();
      renderTimeline();
      if (
        nextVisible &&
        state.project &&
        layer.transcription?.transcript?.path &&
        (!Array.isArray(layer.transcription.timelineSegments) || !layer.transcription.timelineSegments.length)
      ) {
        try {
          const data = await transcribeCaptionerService.fetchTranscription(state.project.id, layer.id);
          layer.transcription = hydrateTranscriptionWithTranscriptData(
            {
              ...(data.transcription || layer.transcription || {}),
              timelineVisible: true,
            },
            data?.transcript,
          );
          if (data?.transcript) {
            state.transcriptionTextCache.set(layer.id, data.transcript);
          }
          renderToolsPanel();
          renderTimeline();
        } catch (error) {
          console.error(error);
          elements.renderLogs.textContent = `Transcriber fetch failed: ${error.message}`;
        }
      }
      markProjectDirty();
    });
  }

  function bindClippingEvents(layer) {
    const provisionButton = document.getElementById('clipping-provision-btn');
    const startInput = document.getElementById('clipping-start-ms');
    const endInput = document.getElementById('clipping-end-ms');
    const textInput = document.getElementById('clipping-text');
    const mutedToggle = document.getElementById('clipping-muted-toggle');
    const splitButton = document.getElementById('clipping-split-btn');
    const deleteButton = document.getElementById('clipping-delete-btn');
    const startMinusButton = document.getElementById('clipping-start-minus-btn');
    const startPlusButton = document.getElementById('clipping-start-plus-btn');
    const endMinusButton = document.getElementById('clipping-end-minus-btn');
    const endPlusButton = document.getElementById('clipping-end-plus-btn');

    provisionButton?.addEventListener('click', () => {
      provisionClipsFromTranscription(layer);
      state.clippingPanelExpanded = true;
      renderAll();
      markProjectDirty();
    });

    const selectedClip = getSelectedClippingClip(layer);
    if (!selectedClip) {
      return;
    }

    const updateSelectedClip = (field, value) => {
      applyClipBoundaryChange(layer, selectedClip.id, field, value);
      renderAll();
      markProjectDirty();
    };

    startInput?.addEventListener('change', () => {
      updateSelectedClip('startMs', Number(startInput.value) || selectedClip.startMs);
    });
    endInput?.addEventListener('change', () => {
      updateSelectedClip('endMs', Number(endInput.value) || selectedClip.endMs);
    });
    textInput?.addEventListener('input', () => {
      const clipping = ensureClippingState(layer);
      const clip = clipping.clips.find((item) => item.id === selectedClip.id);
      if (!clip) return;
      clip.text = textInput.value;
      layer.clipping = normalizeClipping(clipping);
      renderTimeline();
      markProjectDirty();
    });
    mutedToggle?.addEventListener('change', () => {
      const clipping = ensureClippingState(layer);
      const clip = clipping.clips.find((item) => item.id === selectedClip.id);
      if (!clip) return;
      clip.muted = Boolean(mutedToggle.checked);
      layer.clipping = normalizeClipping(clipping);
      renderAll();
      markProjectDirty();
    });
    splitButton?.addEventListener('click', () => {
      splitSelectedClipAtPlayhead(layer);
      renderAll();
      markProjectDirty();
    });
    deleteButton?.addEventListener('click', () => {
      deleteSelectedClip(layer);
      renderAll();
      markProjectDirty();
    });
    startMinusButton?.addEventListener('click', () => updateSelectedClip('startMs', selectedClip.startMs - 100));
    startPlusButton?.addEventListener('click', () => updateSelectedClip('startMs', selectedClip.startMs + 100));
    endMinusButton?.addEventListener('click', () => updateSelectedClip('endMs', selectedClip.endMs - 100));
    endPlusButton?.addEventListener('click', () => updateSelectedClip('endMs', selectedClip.endMs + 100));
  }

  async function generateLayerThumbnails(layerId, sourceVideoId) {
    if (!state.project) return;
    state.thumbnailBusyLayerId = layerId;
    renderRightSidebar();
    try {
      const data = await api('/api/editor/thumbnails', {
        method: 'POST',
        body: {
          projectId: state.project.id,
          layerId,
          sourceVideoId,
        },
      });
      const layer = findLayer(layerId);
      if (!layer || !layer.clip || layer.clip.sourceVideoId !== sourceVideoId) {
        return;
      }
      layer.clip.thumbnails = Array.isArray(data.thumbnails) ? data.thumbnails : [];
      renderTimeline();
      renderRightSidebar();
      markProjectDirty();
    } catch (error) {
      console.error(error);
      elements.renderLogs.textContent = `Thumbnail generation failed: ${error.message}`;
    } finally {
      state.thumbnailBusyLayerId = null;
      renderRightSidebar();
    }
  }

  async function refreshRenderStatus() {
    if (!state.project) return;
    try {
      const data = await api(`/api/editor/render/${encodeURIComponent(state.project.id)}/status`);
      state.project.lastRender = normalizeRenderState(data.render);
      renderRenderPanel();
      if (state.project.lastRender.status === 'running') {
        startRenderPolling();
      }
    } catch (error) {
      console.error(error);
    }
  }

  function renderRenderPanel() {
    const {renderState, queueJobs, queueSummary, queueMode} = getCurrentRenderDisplayData();
    setRenderBadge(renderState.status);
    if (elements.renderTabBtn) {
      const suffix = queueSummary.consolidatedJobCount ? ` (${queueSummary.consolidatedJobCount})` : '';
      elements.renderTabBtn.textContent = `Render${suffix}`;
    }
    if (elements.renderQueueCaption) {
      elements.renderQueueCaption.textContent =
        `${queueMode}: ${queueSummary.consolidatedJobCount} job(s), ${queueSummary.sourceSegmentCount} source segment(s)`;
    }
    if (elements.renderQueueList) {
      elements.renderQueueList.innerHTML = queueJobs.length
        ? queueJobs
            .map(
              (job, index) => `
                <article class="render-queue-item render-queue-item-${escapeAttribute(job.status || 'planned')}">
                  <div class="render-queue-item-head">
                    <strong>Job ${index + 1}</strong>
                    <span class="render-queue-status render-queue-status-${escapeAttribute(job.status || 'planned')}">${escapeHtml(
                      job.status || 'planned',
                    )}</span>
                  </div>
                  <div class="render-queue-meta">Layer ${escapeHtml(job.layerId)} | ${formatClockPrecise(job.startMs)} - ${formatClockPrecise(job.endMs)}</div>
                  <div class="render-queue-meta">${job.sourceSegmentCount} source segment(s) | ${formatClock(job.durationMs)}</div>
                  ${job.textPreview ? `<div class="render-queue-text">${escapeHtml(job.textPreview)}</div>` : ''}
                  ${job.error ? `<div class="render-queue-error">${escapeHtml(job.error)}</div>` : ''}
                </article>
              `,
            )
            .join('')
        : '<p class="hint">No render jobs are planned for this project yet.</p>';
    }
    elements.renderLogs.textContent = renderState.logs.length
      ? renderState.logs.join('\n')
      : 'Render logs will appear here.';
    elements.renderLogs.scrollTop = elements.renderLogs.scrollHeight;
    renderProjectSummary();
    if (state.activeContextTab === 'render') {
      renderRenderInspector();
    }
    renderToolbar();
  }

  function setRenderBadge(status) {
    elements.renderBadge.className = `badge ${status}`;
    elements.renderBadge.textContent = status || 'idle';
  }

  function startRenderPolling() {
    stopRenderPolling();
    state.renderPollTimer = window.setInterval(async () => {
      if (!state.project) return;
      try {
        const data = await api(`/api/editor/render/${encodeURIComponent(state.project.id)}/status`);
        state.project.lastRender = normalizeRenderState(data.render);
        renderRenderPanel();
        if (state.project.lastRender.status !== 'running') {
          stopRenderPolling();
          await refreshProjects();
        }
      } catch (error) {
        console.error(error);
        stopRenderPolling();
      }
    }, 1200);
  }

  function stopRenderPolling() {
    if (state.renderPollTimer) {
      window.clearInterval(state.renderPollTimer);
      state.renderPollTimer = null;
    }
  }

  function markProjectDirty() {
    if (!state.project) return;
    if (state.saveStatus !== 'saving') {
      state.saveStatus = 'saved';
    }
    state.projectDirty = true;
    renderToolbar();
  }

  function markProjectClean() {
    state.projectDirty = false;
    state.saveStatus = 'saved';
    renderToolbar();
  }

  async function saveProject() {
    if (!state.project) return;
    state.saveStatus = 'saving';
    renderToolbar();
    const payload = {
      name: state.project.name,
      selectedLayerId: state.project.selectedLayerId,
      timeline: state.project.timeline,
      layers: state.project.layers,
    };
    try {
      const data = await api(`/api/editor/projects/${encodeURIComponent(state.project.id)}`, {
        method: 'PUT',
        body: payload,
      });
      state.project = normalizeProject(data.project);
      replaceProjectMeta(state.project);
      markProjectClean();
      renderProjectList();
      renderToolbar();
    } catch (error) {
      state.saveStatus = 'error';
      state.projectDirty = true;
      renderToolbar();
      throw error;
    }
  }

  function replaceProjectMeta(projectState) {
    const entry = state.projects.find((item) => item.id === projectState.id);
    if (!entry) {
      state.projects.unshift({
        id: projectState.id,
        name: projectState.name,
        createdAt: projectState.createdAt,
        updatedAt: projectState.updatedAt,
      });
      return;
    }
    entry.name = projectState.name;
    entry.updatedAt = projectState.updatedAt;
  }

  function getSelectedLayer() {
    if (!state.project) return null;
    const selected = state.project.layers.find((layer) => layer.id === state.project.selectedLayerId);
    return selected || state.project.layers[0] || null;
  }

  function findLayer(layerId) {
    return state.project?.layers.find((layer) => layer.id === layerId) || null;
  }

  function findMedia(mediaId) {
    return state.media.find((item) => item.id === mediaId) || null;
  }

  function getPxPerMs() {
    const zoom = Number(state.project?.timeline?.zoom || 0.2);
    return (100 * zoom) / 1000;
  }

  function getTimelineDurationMs(project) {
    const clipEnd = project.layers.reduce((max, layer) => {
      if (!layer.clip) return max;
      const sourceDuration = Math.max(0, Number(layer.clip.sourceDurationMs) || 0);
      const startMs = Number(layer.clip.startMs) || 0;
      const trimOut = Math.max(0, Number(layer.clip.trimOutMs) || 0);
      const activeDuration = Math.min(trimOut, sourceDuration);
      const activeEnd = startMs + activeDuration;
      return Math.max(max, activeEnd);
    }, 0);
    const minDurationMs = Math.max(project.timeline.durationMs || 0, 300000);
    return Math.max(minDurationMs, clipEnd);
  }

  function pickRulerStepMs(pxPerMs) {
    const candidates = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000];
    for (const value of candidates) {
      if (value * pxPerMs >= 80) {
        return value;
      }
    }
    return 120000;
  }

  function clampInt(value, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.floor(clamp(num, min, max));
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function normalizeNullableMs(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return null;
    }
    return Math.floor(num);
  }

  function uniqueLayerId(layers, base) {
    let index = 0;
    let candidate = base;
    const taken = new Set(layers.map((layer) => layer.id));
    while (taken.has(candidate)) {
      index += 1;
      candidate = `${base}-${index}`;
    }
    return candidate;
  }

  function syncTimelineZoom() {
    if (!state.project || !state.isZoomAuto) {
      return;
    }
    const fitZoom = getAutoFitZoomForProject(state.project);
    if (!Number.isFinite(fitZoom)) {
      return;
    }
    const current = Number(state.project.timeline.zoom || 0);
    if (Math.abs(current - fitZoom) > 0.0004) {
      state.project.timeline.zoom = fitZoom;
      state.project.timeline.autoZoom = true;
      renderToolbar();
    }
  }

  function getAutoFitZoomForProject(project) {
    const timelineMs = Math.max(1, getTimelineDurationMs(project));
    const containerWidth = elements.timelineWrap?.clientWidth || elements.timelinePanel?.clientWidth || 0;
    if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
      return 0.2;
    }
    const effectiveWidth = Math.max(320, containerWidth - 44);
    const pxPerMs = effectiveWidth / timelineMs;
    return clamp(pxPerMs * 10, 0.01, 2.5);
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function formatClockPrecise(ms) {
    const totalMs = Math.max(0, Math.floor(Number(ms) || 0));
    const totalSeconds = Math.floor(totalMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const millis = totalMs % 1000;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString([], {month: 'short', day: 'numeric'});
  }

  function formatBytes(value) {
    const size = Number(value) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatTranscriberJson(payload) {
    try {
      return JSON.stringify(payload, null, 2);
    } catch (_error) {
      return '';
    }
  }

  function escapeHtml(input) {
    return String(input || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function escapeAttribute(input) {
    return escapeHtml(input).replaceAll('`', '&#96;');
  }

  async function api(url, options = {}) {
    const request = {
      method: options.method || 'GET',
      headers: {},
    };
    if (options.body !== undefined) {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, request);
    let json = {};
    try {
      json = await response.json();
    } catch (_error) {
      json = {};
    }
    if (!response.ok) {
      throw new Error(json.error || `HTTP ${response.status}`);
    }
    return json;
  }
})();
