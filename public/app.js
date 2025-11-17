const els = {
  videoList: document.getElementById('video-list'),
  currentTitle: document.getElementById('current-title'),
  currentVideo: document.getElementById('current-video'),
  currentDetails: document.getElementById('current-details'),
  candidateDetails: document.getElementById('candidate-details'),
  candidatePreview: document.getElementById('candidate-preview'),
  profileSelect: document.getElementById('profile-select'),
  widthInput: document.getElementById('width-input'),
  heightInput: document.getElementById('height-input'),
  crfInput: document.getElementById('crf-input'),
  crfValue: document.getElementById('crf-value'),
  formatSelect: document.getElementById('format-select'),
  fpsSelect: document.getElementById('fps-select'),
  renderBtn: document.getElementById('render-btn'),
  statusPill: document.getElementById('status-pill'),
  lastOutput: document.getElementById('last-output'),
  gridToggle: document.getElementById('grid-toggle'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
};

const state = {
  videos: [],
  profiles: [],
  selectedVideo: null,
  selectedOutput: null,
  busy: false,
  uploading: false,
  dropZoneResetTimer: null,
  settings: {
    profileId: '',
    width: Number(els.widthInput.value),
    height: Number(els.heightInput.value),
    crf: Number(els.crfInput.value),
    format: els.formatSelect.value,
    fps: Number(els.fpsSelect.value) || 24,
  },
};

init();

function init() {
  bindEvents();
  loadProfiles();
  loadVideos();
}

function bindEvents() {
  bindUploadEvents();
  els.profileSelect.addEventListener('change', handleProfileChange);
  els.widthInput.addEventListener('input', () => handleSettingsChange(true));
  els.heightInput.addEventListener('input', () => handleSettingsChange(true));
  els.crfInput.addEventListener('input', () => {
    els.crfValue.textContent = els.crfInput.value;
    handleSettingsChange(true);
  });
  els.formatSelect.addEventListener('change', () => handleSettingsChange(true));
  els.fpsSelect.addEventListener('change', () => handleSettingsChange(true));
  els.renderBtn.addEventListener('click', handleRender);
  els.gridToggle.addEventListener('click', toggleGrid);
  if (els.lastOutput) {
    els.lastOutput.addEventListener('click', handleOutputChipClick);
  }
  document.querySelectorAll('.accordion-panel header').forEach((header) => {
    header.addEventListener('click', () => {
      const panel = header.parentElement;
      panel.classList.toggle('open');
    });
  });
}

function bindUploadEvents() {
  if (!els.dropZone) return;
  const prevent = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  ['dragenter', 'dragover'].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      prevent(event);
      els.dropZone.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      prevent(event);
      els.dropZone.classList.remove('dragging');
    });
  });
  els.dropZone.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files;
    handleIncomingFiles(files);
  });
  els.dropZone.addEventListener('click', () => {
    if (!state.uploading && els.fileInput) {
      els.fileInput.click();
    }
  });
  els.dropZone.addEventListener('keydown', (event) => {
    if (!els.fileInput || state.uploading) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  if (els.fileInput) {
    els.fileInput.addEventListener('change', (event) => handleIncomingFiles(event.target.files));
  }
  setDropZoneMessage('Drag videos here', 'or click to browse');
}

async function handleIncomingFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith('video/'));
  if (!files.length || state.uploading) return;
  state.uploading = true;
  els.dropZone?.classList.add('uploading');
  setDropZoneMessage('Uploading…', `${files.length} file${files.length > 1 ? 's' : ''}`);
  try {
    const formData = new FormData();
    files.forEach((file) => formData.append('videos', file));
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const details = await res.json().catch(() => ({}));
      throw new Error(details.error || 'Upload failed');
    }
    await loadVideos(true);
    setDropZoneMessage('Uploaded!', 'Ready for another drop');
  } catch (error) {
    console.error('Upload failed', error);
    setDropZoneMessage('Upload failed', error.message || 'Try again');
  } finally {
    state.uploading = false;
    els.dropZone?.classList.remove('uploading');
    els.dropZone?.classList.remove('dragging');
    if (els.fileInput) {
      els.fileInput.value = '';
    }
    scheduleDropZoneReset();
  }
}

function setDropZoneMessage(primary, secondary) {
  if (!els.dropZone) return;
  const heading = els.dropZone.querySelector('strong');
  const subline = els.dropZone.querySelector('span');
  if (heading) heading.textContent = primary;
  if (subline) subline.textContent = secondary || '';
}

function scheduleDropZoneReset(delay = 2400) {
  if (state.uploading) return;
  if (state.dropZoneResetTimer) {
    clearTimeout(state.dropZoneResetTimer);
  }
  state.dropZoneResetTimer = window.setTimeout(() => {
    if (!state.uploading) {
      setDropZoneMessage('Drag videos here', 'or click to browse');
    }
  }, delay);
}

async function loadProfiles() {
  try {
    const res = await fetch('/api/profiles');
    if (!res.ok) throw new Error('profiles failed');
    state.profiles = await res.json();
    populateProfiles();
  } catch (error) {
    console.warn('profiles load error', error);
  }
}

async function loadVideos(keepSelection = false) {
  const previousId = keepSelection && state.selectedVideo ? state.selectedVideo.id : null;
  const previousOutput = keepSelection && state.selectedOutput ? state.selectedOutput.filename : null;
  try {
    const res = await fetch('/api/videos');
    if (!res.ok) throw new Error('videos failed');
    const data = await res.json();
    state.videos = data.videos || [];
  } catch (error) {
    console.error('video load failed', error);
  }
  if (previousId) {
    const next = state.videos.find((video) => video.id === previousId);
    if (next) {
      state.selectedVideo = next;
      state.selectedOutput = resolveOutput(next, previousOutput);
    }
  } else if (!keepSelection) {
    state.selectedVideo = null;
    state.selectedOutput = null;
  }
  renderVideoList();
  updateCurrentPanel();
  updateCandidatePanel();
  updateLastOutput();
  updateRenderButtonState();
}

function populateProfiles() {
  state.profiles.forEach((profile) => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.label;
    option.dataset.width = profile.width;
    option.dataset.height = profile.height;
    option.dataset.crf = profile.crf;
    option.dataset.format = profile.format;
    option.dataset.fps = profile.fps;
    els.profileSelect.appendChild(option);
  });
}

function renderVideoList() {
  els.videoList.innerHTML = '';
  if (!state.videos.length) {
    const empty = document.createElement('p');
    empty.textContent = 'Drop a video in the tray above to get started.';
    empty.className = 'hint';
    els.videoList.appendChild(empty);
    return;
  }

  state.videos.forEach((video) => {
    const card = document.createElement('article');
    card.className = 'video-card';
    const outputCount = (video.outputs && video.outputs.length) || 0;
    const status = outputCount ? `${outputCount} render${outputCount > 1 ? 's' : ''}` : 'No renders yet';
    card.innerHTML = `
      <h4>${video.filename}</h4>
      <p>${formatBytes(video.size)} • ${formatDims(video.probe)}</p>
      <p class="status-line">${status}</p>
    `;
    card.addEventListener('click', () => selectVideo(video));
    if (state.selectedVideo && state.selectedVideo.id === video.id) {
      card.classList.add('active');
    }
    els.videoList.appendChild(card);
  });
}

function selectVideo(video) {
  state.selectedVideo = video;
  state.selectedOutput = pickLatestOutput(video);
  applySourceDefaults(video);
  renderVideoList();
  updateCurrentPanel();
  updateCandidatePanel();
  updateLastOutput();
  updateRenderButtonState();
}

function updateCurrentPanel() {
  if (!state.selectedVideo) {
    els.currentTitle.textContent = 'Pick a video';
    els.currentVideo.removeAttribute('src');
    els.currentDetails.innerHTML = '';
    return;
  }
  const {filename, path: src, probe, size} = state.selectedVideo;
  els.currentTitle.textContent = filename;
  els.currentVideo.src = src;
  const summary = summarizeProbe(probe);
  els.currentDetails.innerHTML = renderMetaList([
    {label: 'Resolution', value: summary.resolution},
    {label: 'Duration', value: summary.duration},
    {label: 'Codec', value: summary.codec},
    {label: 'Size', value: formatBytes(size)},
    {label: 'Bitrate', value: summary.bitrate},
  ]);
}

function updateCandidatePanel() {
  const list = [
    {label: 'Target', value: `${state.settings.width} x ${state.settings.height}`},
    {label: 'CRF', value: state.settings.crf},
    {label: 'Format', value: state.settings.format},
    {label: 'FPS', value: `${state.settings.fps} fps`},
  ];
  if (state.selectedOutput && state.selectedOutput.probe) {
    const summary = summarizeProbe(state.selectedOutput.probe);
    list.push(
      {label: 'Output Resolution', value: summary.resolution || '-'},
      {label: 'Output Size', value: formatBytes(state.selectedOutput.size)},
      {label: 'Output Duration', value: summary.duration || '-'},
      {label: 'Output Bitrate', value: summary.bitrate || '-'},
    );
  } else if (state.selectedVideo) {
    list.push({label: 'Output', value: 'No renders yet'});
  }
  els.candidateDetails.innerHTML = renderMetaList(list);
  updateCandidatePreview();
}

function updateCandidatePreview() {
  els.candidatePreview.innerHTML = '';
  if (state.selectedOutput && state.selectedOutput.path) {
    const video = document.createElement('video');
    video.controls = true;
    video.loop = true;
    video.src = state.selectedOutput.path;
    els.candidatePreview.appendChild(video);
  } else if (state.selectedVideo) {
    els.candidatePreview.textContent = 'Render to preview';
  } else {
    els.candidatePreview.textContent = 'GRID';
  }
}

function handleProfileChange() {
  const selected = state.profiles.find((p) => p.id === els.profileSelect.value);
  if (selected) {
    els.widthInput.value = selected.width;
    els.heightInput.value = selected.height;
    els.crfInput.value = selected.crf;
    els.crfValue.textContent = selected.crf;
    els.formatSelect.value = selected.format;
    if (selected.fps) {
      els.fpsSelect.value = selected.fps;
    }
    state.settings.profileId = selected.id;
  } else {
    state.settings.profileId = '';
  }
  handleSettingsChange(false);
}

function handleSettingsChange(isManual) {
  if (isManual && els.profileSelect.value) {
    els.profileSelect.value = '';
    state.settings.profileId = '';
  } else {
    state.settings.profileId = els.profileSelect.value || '';
  }
  const width = ensureEven(Number(els.widthInput.value) || 720, 320);
  const height = ensureEven(Number(els.heightInput.value) || 1280, 480);
  if (width !== Number(els.widthInput.value)) {
    els.widthInput.value = width;
  }
  if (height !== Number(els.heightInput.value)) {
    els.heightInput.value = height;
  }
  state.settings = {
    profileId: state.settings.profileId,
    width,
    height,
    crf: Number(els.crfInput.value),
    format: els.formatSelect.value,
    fps: Number(els.fpsSelect.value) || 24,
  };
  updateCandidatePanel();
}

function applySourceDefaults(video) {
  if (!video || !video.probe) return;
  const dims = extractDimensions(video.probe);
  if (!dims) return;
  const maxDimension = 1280;
  const largestSide = Math.max(dims.width, dims.height);
  let width = dims.width;
  let height = dims.height;
  if (largestSide > maxDimension) {
    const scale = maxDimension / largestSide;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  width = ensureEven(width, 320);
  height = ensureEven(height, 480);
  els.widthInput.value = width;
  els.heightInput.value = height;
  handleSettingsChange(false);
}

async function handleRender() {
  if (!state.selectedVideo || state.busy) return;
  setBusy(true, 'Rendering…');
  const payload = {
    filename: state.selectedVideo.storedName || state.selectedVideo.filename,
    projectId: state.selectedVideo.id,
    width: state.settings.width,
    height: state.settings.height,
    crf: state.settings.crf,
    format: state.settings.format,
    fps: state.settings.fps,
    profileId: state.settings.profileId || undefined,
  };
  try {
    const res = await fetch('/api/convert', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Conversion failed');
    }
    await loadVideos(true);
    updateLastOutput(`Saved as ${data.output.filename}`);
    setBusy(false, 'Done');
  } catch (error) {
    console.error(error);
    updateLastOutput(`Error: ${error.message}`);
    setBusy(false, 'Error');
  }
}

function setBusy(flag, label) {
  state.busy = flag;
  els.statusPill.textContent = label;
  els.statusPill.classList.toggle('busy', flag);
  els.statusPill.classList.toggle('idle', !flag);
  if (flag) {
    els.renderBtn.classList.add('pulse');
  } else {
    els.renderBtn.classList.remove('pulse');
  }
  updateRenderButtonState();
}

function updateLastOutput(message) {
  if (!els.lastOutput) return;
  if (!state.selectedVideo) {
    els.lastOutput.innerHTML = `<p>${message || 'Select a video to review renders.'}</p>`;
    return;
  }
  const outputs = state.selectedVideo.outputs || [];
  if (!outputs.length) {
    els.lastOutput.innerHTML = `<p>${message || 'No renders yet.'}</p>`;
    return;
  }
  if (!state.selectedOutput) {
    state.selectedOutput = pickLatestOutput(state.selectedVideo);
  }
  const current = state.selectedOutput;
  const summary = summarizeProbe(current?.probe);
  const chips = outputs
    .map((output) => {
      const isActive = current && output.filename === current.filename;
      return `<button type="button" class="output-chip${isActive ? ' active' : ''}" data-output="${output.filename}">${formatTimestamp(
        output.modifiedAt,
      )}</button>`;
    })
    .join('');
  els.lastOutput.innerHTML = `
    <strong>${message || `Latest render (${current.filename})`}</strong>
    <span>${summary.resolution || '--'} • ${summary.duration || '--'} • ${summary.bitrate || '--'} • ${formatBytes(
    current.size,
  )}</span>
    <a href="${current.path}" target="_blank" rel="noopener">Open output ↗︎</a>
    <div class="output-history">${chips}</div>
  `;
}

function toggleGrid() {
  const pressed = els.gridToggle.getAttribute('aria-pressed') === 'true';
  const next = !pressed;
  els.gridToggle.setAttribute('aria-pressed', String(next));
  els.candidatePreview.classList.toggle('off', !next);
}

function renderMetaList(items) {
  return items
    .filter((item) => item.value && item.value !== 'undefined')
    .map((item) => `<li><span>${item.label}</span><strong>${item.value}</strong></li>`)
    .join('');
}

function handleOutputChipClick(event) {
  const target = event.target.closest('[data-output]');
  if (!target || !state.selectedVideo) return;
  const outputs = state.selectedVideo.outputs || [];
  const next = outputs.find((output) => output.filename === target.dataset.output);
  if (!next || (state.selectedOutput && next.filename === state.selectedOutput.filename)) return;
  state.selectedOutput = next;
  updateCandidatePanel();
  updateCandidatePreview();
  updateLastOutput(`Loaded ${next.filename}`);
}

function extractDimensions(probe) {
  if (!probe) return null;
  const streams = (probe && probe.streams) || [];
  const stream = streams.find((s) => s.width && s.height);
  if (!stream) return null;
  return {
    width: Number(stream.width),
    height: Number(stream.height),
  };
}

function summarizeProbe(probe) {
  if (!probe) {
    return {resolution: '-', duration: '-', codec: '-', bitrate: '-'};
  }
  const streams = (probe && probe.streams) || [];
  const stream = streams.find((s) => s.width && s.height) || streams[0] || {};
  const format = probe.format || {};
  const duration = Number(format.duration || stream.duration || 0);
  const bitrate = Number(format.bit_rate || stream.bit_rate || 0);
  return {
    resolution: stream.width && stream.height ? `${stream.width} x ${stream.height}` : '-',
    duration: duration ? formatDuration(duration) : '-',
    codec: stream.codec_name || '-',
    bitrate: bitrate ? `${(bitrate / 1000).toFixed(0)} kbps` : '-',
  };
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value > 10 ? 0 : 1)} ${units[i]}`;
}

function formatDims(probe) {
  if (!probe) return '--';
  const dims = extractDimensions(probe);
  return dims ? `${dims.width}x${dims.height}` : '--';
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60)
    .toString()
    .padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function ensureEven(value, min) {
  const fallback = min || 2;
  if (!Number.isFinite(value) || value <= 0) {
    return Math.max(2, Math.floor(fallback / 2) * 2);
  }
  return Math.max(2, Math.floor(value / 2) * 2);
}

function pickLatestOutput(video) {
  const outputs = (video && video.outputs) || [];
  return outputs.length ? outputs[0] : null;
}

function resolveOutput(video, preferredFilename) {
  if (!video) return null;
  const outputs = video.outputs || [];
  if (preferredFilename) {
    const match = outputs.find((output) => output.filename === preferredFilename);
    if (match) return match;
  }
  return pickLatestOutput(video);
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}

function updateRenderButtonState() {
  els.renderBtn.disabled = state.busy || !state.selectedVideo;
}
