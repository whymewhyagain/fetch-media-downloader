/* ═══════════════════════════════════════════════════════
   FETCH v3 — app.js
   Features: History, Hotkeys, Drag-reorder, Sound, Parallel,
             Pause/Resume, Auto-analyze, Rename, ID3 meta,
             Size estimate, Particle background
═══════════════════════════════════════════════════════ */

// ─── STATE ────────────────────────────────────────────────
const S = {
  info: null,
  selectedFormat: null,
  selectedThumb: null,
  type: 'video',
  downloadPath: '',
  proxy: '',
  downloads: {},
  activeCount: 0,
  queueTotal: 0,
  // Settings
  soundEnabled: true,
  maxParallel: 3,
  // Drag state
  dragSrc: null,
  // Auto-analyze debounce
  analyzeTimer: null,
  // Pause state
  pausedDownloads: new Set(),
};

// ─── HISTORY (localStorage JSON) ──────────────────────────
const History = {
  KEY: 'fetch_dl_history',
  MAX: 100,

  load() {
    try {
      return JSON.parse(localStorage.getItem(this.KEY) || '[]');
    } catch { return []; }
  },

  save(items) {
    try { localStorage.setItem(this.KEY, JSON.stringify(items)); } catch {}
  },

  add(entry) {
    const items = this.load();
    // Avoid exact URL duplicates within last 10
    const recent = items.slice(0, 10);
    if (recent.some(i => i.url === entry.url && i.status === 'success')) return;
    items.unshift({ ...entry, id: Date.now(), ts: new Date().toISOString() });
    this.save(items.slice(0, this.MAX));
  },

  clear() {
    localStorage.removeItem(this.KEY);
  }
};

// ─── SETTINGS (localStorage) ──────────────────────────────
const Prefs = {
  KEY: 'fetch_prefs',

  load() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '{}'); } catch { return {}; }
  },

  save(obj) {
    try { localStorage.setItem(this.KEY, JSON.stringify(obj)); } catch {}
  },

  get(key, def) {
    const p = this.load();
    return key in p ? p[key] : def;
  },

  set(key, val) {
    const p = this.load();
    p[key] = val;
    this.save(p);
  }
};

// ─── SOUND ────────────────────────────────────────────────
const Sound = {
  ctx: null,

  init() {
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  },

  play(type = 'done') {
    if (!S.soundEnabled || !this.ctx) return;
    try {
      const notes = type === 'done'
        ? [{ f: 880, t: 0, d: 0.08 }, { f: 1100, t: 0.09, d: 0.08 }, { f: 1320, t: 0.18, d: 0.14 }]
        : [{ f: 440, t: 0, d: 0.1 }, { f: 330, t: 0.12, d: 0.15 }];

      notes.forEach(({ f, t, d }) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain); gain.connect(this.ctx.destination);
        osc.frequency.value = f;
        osc.type = 'sine';
        const now = this.ctx.currentTime + t;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.18, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + d);
        osc.start(now); osc.stop(now + d + 0.05);
      });
    } catch {}
  }
};

// ─── PARTICLES BACKGROUND ────────────────────────────────
const Particles = {
  canvas: null, ctx: null, particles: [], raf: null,

  init() {
    this.canvas = document.getElementById('particle-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.spawn();
    this.loop();
  },

  resize() {
    if (!this.canvas) return;
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  },

  spawn() {
    const N = 55;
    for (let i = 0; i < N; i++) {
      this.particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        r: Math.random() * 1.4 + 0.2,
        vx: (Math.random() - 0.5) * 0.12,
        vy: (Math.random() - 0.5) * 0.12,
        a: Math.random() * 0.25 + 0.03,
        pulse: Math.random() * Math.PI * 2,
      });
    }
  },

  loop() {
    const c = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    c.clearRect(0, 0, w, h);

    // Connection lines
    for (let i = 0; i < this.particles.length; i++) {
      for (let j = i + 1; j < this.particles.length; j++) {
        const p = this.particles[i], q = this.particles[j];
        const dx = p.x - q.x, dy = p.y - q.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 100) {
          c.beginPath();
          c.moveTo(p.x, p.y);
          c.lineTo(q.x, q.y);
          c.strokeStyle = `rgba(255,255,255,${0.022 * (1 - dist / 100)})`;
          c.lineWidth = 0.5;
          c.stroke();
        }
      }
    }

    this.particles.forEach(p => {
      p.pulse += 0.008;
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
      const alpha = p.a * (0.6 + 0.4 * Math.sin(p.pulse));
      c.beginPath();
      c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      c.fillStyle = `rgba(255,255,255,${alpha})`;
      c.fill();
    });

    this.raf = requestAnimationFrame(() => this.loop());
  }
};

// ─── INIT ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load prefs
  S.soundEnabled = Prefs.get('soundEnabled', true);
  S.maxParallel = Prefs.get('maxParallel', 3);

  // Tab nav
  document.querySelectorAll('.ni').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );

  // Enter key on URL
  document.getElementById('url-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doFetch();
  });

  // Auto-analyze on URL paste/input
  document.getElementById('url-input').addEventListener('input', e => {
    clearTimeout(S.analyzeTimer);
    const url = e.target.value.trim();
    if (url.startsWith('http') && url.length > 12) {
      S.analyzeTimer = setTimeout(() => {
        showAutoAnalyzePill();
        doFetch();
      }, 900);
    }
  });

  // Accordion state init
  document.querySelectorAll('.accordion-head').forEach(h => {
    h.setAttribute('aria-expanded', 'true');
  });

  // Load defaults
  try {
    S.downloadPath = await eel.get_default_path()();
    updatePathDisplay(S.downloadPath);
    document.getElementById('s-dl-path').textContent = S.downloadPath;
  } catch (e) {}

  try {
    const ver = await eel.get_ydlp_version()();
    document.getElementById('ydlp-ver').textContent = `yt-dlp ${ver}`;
    document.getElementById('s-engine-ver').textContent = `yt-dlp v${ver}`;
  } catch (e) {}

  checkFFmpeg();

  // Settings UI sync
  syncSettingsUI();

  // Hotkeys
  initHotkeys();

  // Particles
  Particles.init();

  // Sound init (lazy, requires user gesture)
  document.addEventListener('click', () => {
    if (!Sound.ctx) Sound.init();
  }, { once: true });

  // Render history
  renderHistory();
});

function showAutoAnalyzePill() {
  let pill = document.getElementById('auto-analyze-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'auto-analyze-pill';
    pill.className = 'auto-analyze-pill';
    pill.textContent = '⚡ Автоанализ...';
    document.getElementById('url-box').appendChild(pill);
  }
  pill.style.opacity = '1';
  setTimeout(() => { if (pill) pill.style.opacity = '0'; }, 3000);
}

// ─── HOTKEYS ──────────────────────────────────────────────
function initHotkeys() {
  document.addEventListener('keydown', async e => {
    const tag = document.activeElement?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA';
    // Is focus in the URL input specifically?
    const inUrlInput = document.activeElement === document.getElementById('url-input');

    // Ctrl+V — paste URL into URL field when not focused on any other input
    // If focus is already on url-input, let the browser handle it natively
    if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
      if (!inInput) {
        // No input focused — intercept and paste into URL field
        e.preventDefault();
        await pasteClip();
      }
      // If inUrlInput: browser handles natively — auto-analyze listener picks it up
      // If inInput but NOT urlInput: let browser handle natively for that field
      return;
    }

    // Ctrl+Enter — start download / fetch
    if (e.ctrlKey && (e.key === 'Enter')) {
      e.preventDefault();
      if (S.info) startDownload();
      else doFetch();
      return;
    }

    // Escape — clear (works everywhere)
    if (e.key === 'Escape') {
      if (inUrlInput) {
        // Blur first so user can press Esc again to clear if needed
        document.getElementById('url-input').blur();
      }
      clearAll();
    }
  });
}

function checkFFmpeg() {
  document.getElementById('ffmpeg-tag').textContent = 'Требуется';
  document.getElementById('ffmpeg-tag').style.color = 'var(--warn)';
}

// ─── TABS ─────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.ni').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  document.getElementById(`tab-${name}`).classList.add('active');
  if (name === 'history') renderHistory();
}

// ─── CLIPBOARD ────────────────────────────────────────────
async function pasteClip() {
  try {
    const t = await navigator.clipboard.readText();
    document.getElementById('url-input').value = t.trim();
    document.getElementById('url-input').focus();
  } catch (e) {
    toast('Нет доступа к буферу обмена', 'warn');
  }
}

function clearAll() {
  document.getElementById('url-input').value = '';
  document.getElementById('info-panel').style.display = 'none';
  S.info = null; S.selectedFormat = null; S.selectedThumb = null;
  document.getElementById('url-input').focus();
}

// ─── FETCH INFO ───────────────────────────────────────────
async function doFetch() {
  const url = document.getElementById('url-input').value.trim();
  if (!url) { toast('Введите URL', 'error'); return; }

  const proxy = document.getElementById('proxy-input').value.trim() ||
                document.getElementById('s-proxy').value.trim() || null;

  const btn = document.getElementById('fetch-btn');
  btn.classList.add('loading');
  document.getElementById('fetch-label').textContent = 'Анализируем...';
  document.getElementById('info-panel').style.display = 'none';

  try {
    const info = await eel.get_video_info(url, proxy)();
    if (info.success) {
      S.info = info;
      renderInfoPanel(info);
      toast(info.is_playlist ? `Плейлист: ${info.playlist_count} видео` : 'Информация получена', 'success');
    } else {
      toast('Ошибка: ' + (info.error || '').substring(0, 80), 'error');
    }
  } catch (e) {
    toast('Нет связи с бэкендом', 'error');
  } finally {
    btn.classList.remove('loading');
    document.getElementById('fetch-label').textContent = 'Анализировать';
    const pill = document.getElementById('auto-analyze-pill');
    if (pill) pill.style.opacity = '0';
  }
}

// ─── RENDER INFO ──────────────────────────────────────────
function renderInfoPanel(info) {
  const panel = document.getElementById('info-panel');

  const thumb = document.getElementById('vcard-thumb');
  thumb.src = info.thumbnail || '';
  document.getElementById('vcard-title').textContent =
    info.is_playlist ? info.playlist_title : (info.title || '—');
  document.getElementById('vcard-uploader').textContent = info.uploader || '—';
  document.getElementById('vcard-platform').textContent = info.platform || 'Web';
  document.getElementById('vcard-duration').textContent =
    info.is_playlist ? `${info.playlist_count} видео` : (info.duration || '0:00');

  const views = document.getElementById('vcard-views');
  const date = document.getElementById('vcard-date');
  const dateDot = document.getElementById('vcard-date-dot');
  views.textContent = info.view_count || '';
  date.textContent = info.upload_date || '';
  dateDot.style.display = info.upload_date ? '' : 'none';

  // Playlist
  const plInd = document.getElementById('playlist-indicator');
  const plSec = document.getElementById('pl-section');
  if (info.is_playlist) {
    plInd.style.display = 'flex';
    document.getElementById('pl-count-label').textContent = `${info.playlist_count} видео в плейлисте`;
    plSec.style.display = 'block';
    renderPlaylistItems(info.items || []);
  } else {
    plInd.style.display = 'none';
    plSec.style.display = 'none';
  }

  // Quality grid with size estimates
  renderQualityGrid(info.formats || []);
  renderThumbPicker(info.thumbnails || []);

  // Pre-fill rename field
  const renameInput = document.getElementById('rename-input');
  if (renameInput) {
    renameInput.value = info.title || '';
    renameInput.placeholder = info.title || 'Имя файла (необязательно)';
  }

  // Show estimated file size
  updateSizeEstimate();

  setType('video');
  updateOutputFormatOptions('video');

  panel.style.display = 'flex';
  const body = document.getElementById('opts-accordion-body');
  body.classList.add('open');
  document.querySelector('#opts-accordion .acc-chevron').style.transform = 'rotate(180deg)';
  document.querySelector('#opts-accordion .accordion-head').setAttribute('aria-expanded', 'true');
}

function renderPlaylistItems(items) {
  const list = document.getElementById('pl-items-list');
  list.innerHTML = '';
  items.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'pl-item-row';
    div.innerHTML = `
      <span class="pl-item-num">${i + 1}</span>
      ${item.thumbnail ? `<img class="pl-item-thumb" src="${escH(item.thumbnail)}" alt="" loading="lazy"/>` : ''}
      <div class="pl-item-info">
        <div class="pl-item-title">${escH(item.title)}</div>
        <div class="pl-item-dur">${escH(item.duration)}</div>
      </div>
    `;
    list.appendChild(div);
  });
  document.getElementById('pl-start').max = items.length;
  document.getElementById('pl-end').max = items.length;
}

function renderQualityGrid(formats) {
  const grid = document.getElementById('quality-grid');
  grid.innerHTML = '';
  S.selectedFormat = null;

  if (!formats.length) {
    grid.innerHTML = '<span style="font-family:var(--fM);font-size:11px;color:var(--text3)">Авто</span>';
    return;
  }

  formats.forEach((f, i) => {
    const btn = document.createElement('button');
    btn.className = 'qbtn' + (i === 0 ? ' sel' : '');
    const fps = f.fps ? `${f.fps}fps` : '';
    const meta = [f.ext?.toUpperCase(), fps, f.size].filter(Boolean).join(' · ');
    btn.innerHTML = `
      <span class="qbtn-quality">${escH(f.quality)}</span>
      <span class="qbtn-meta">${escH(meta)}</span>
      ${f.filesize_approx ? `<span class="qbtn-size">${formatBytes(f.filesize_approx)}</span>` : ''}
    `;
    btn.onclick = () => {
      document.querySelectorAll('.qbtn').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      S.selectedFormat = f.format_id;
      updateSizeEstimate(f.filesize_approx);
    };
    grid.appendChild(btn);
    if (i === 0) {
      S.selectedFormat = f.format_id;
      if (f.filesize_approx) updateSizeEstimate(f.filesize_approx);
    }
  });
}

function updateSizeEstimate(bytes) {
  const el = document.getElementById('size-estimate');
  if (!el) return;
  if (bytes && bytes > 0) {
    el.textContent = `~${formatBytes(bytes)}`;
    el.style.display = 'inline-flex';
  } else if (S.info?.filesize_approx) {
    el.textContent = `~${formatBytes(S.info.filesize_approx)}`;
    el.style.display = 'inline-flex';
  } else {
    el.style.display = 'none';
  }
}

function formatBytes(b) {
  if (!b) return '';
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b > 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}

function renderThumbPicker(thumbs) {
  const grid = document.getElementById('thumb-picker-grid');
  grid.innerHTML = '';
  S.selectedThumb = thumbs.length ? thumbs[0].url : null;

  thumbs.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.className = 'tpbtn' + (i === 0 ? ' sel' : '');
    const res = t.width && t.height ? `${t.width}×${t.height}` : '';
    btn.innerHTML = `
      <img src="${escH(t.url)}" alt="" loading="lazy"/>
      ${res ? `<span class="tpbtn-res">${escH(res)}</span>` : ''}
    `;
    btn.onclick = () => {
      document.querySelectorAll('.tpbtn').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      S.selectedThumb = t.url;
    };
    grid.appendChild(btn);
  });
}

// ─── TYPE TOGGLE ──────────────────────────────────────────
function setType(type) {
  S.type = type;
  ['video', 'audio', 'thumb'].forEach(t => {
    document.getElementById(`tbtn-${t}`).classList.toggle('active', t === type);
  });

  const qualityBlock = document.getElementById('quality-block');
  const thumbBlock = document.getElementById('thumb-picker-block');
  const colFmt = document.getElementById('col-output-fmt');
  const subtitlesLabel = document.getElementById('subtitles-label');
  const metaBlock = document.getElementById('metadata-block');

  qualityBlock.style.display = type === 'video' ? 'block' : 'none';
  thumbBlock.style.display = type === 'thumb' ? 'block' : 'none';
  colFmt.style.display = type === 'thumb' ? 'none' : 'block';
  subtitlesLabel.style.display = type === 'video' ? '' : 'none';
  if (metaBlock) metaBlock.style.display = (type === 'audio' || type === 'video') ? 'block' : 'none';

  updateOutputFormatOptions(type);
  updateDlBtnLabel();
  updateSizeEstimate();
}

function updateOutputFormatOptions(type) {
  const sel = document.getElementById('output-format');
  const videoOpts = ['mp4', 'mkv', 'webm'];
  const audioOpts = ['mp3', 'aac', 'flac', 'wav', 'opus', 'm4a'];

  Array.from(sel.options).forEach(o => {
    if (type === 'video') o.hidden = !videoOpts.includes(o.value);
    else o.hidden = !audioOpts.includes(o.value);
  });

  if (type === 'video' && !videoOpts.includes(sel.value)) sel.value = 'mp4';
  if (type === 'audio' && !audioOpts.includes(sel.value)) sel.value = 'mp3';
}

function updateDlBtnLabel() {
  const labels = { video: 'Загрузить видео', audio: 'Загрузить аудио', thumb: 'Скачать превью' };
  document.getElementById('dl-btn-label').textContent = labels[S.type] || 'Загрузить';
}

// ─── ACCORDION ────────────────────────────────────────────
function toggleAccordion(id) {
  const body = document.getElementById(`${id}-body`);
  const head = document.querySelector(`#${id} .accordion-head`);
  const chevron = document.querySelector(`#${id} .acc-chevron`);
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  chevron.style.transform = !isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
  head.setAttribute('aria-expanded', String(!isOpen));
}

// ─── PATH ─────────────────────────────────────────────────
function updatePathDisplay(path) {
  const display = document.getElementById('path-display');
  const settingsPath = document.getElementById('s-dl-path');
  if (display) display.textContent = path || '—';
  if (settingsPath) settingsPath.textContent = path || '—';
}

async function changePath() {
  try {
    const chosen = await eel.choose_folder()();
    if (chosen) {
      S.downloadPath = chosen;
      updatePathDisplay(chosen);
      try { await eel.set_default_path(chosen)(); } catch {}
      toast('Папка сохранения изменена', 'success');
    }
  } catch (e) {
    toast('Не удалось открыть диалог выбора папки', 'error');
  }
}

// Keep these as no-ops / aliases for backward compat
function cancelPathEdit() {}
async function savePath() {}

function openSaveDir() {
  eel.open_folder(S.downloadPath)();
}

// ─── PROXY ────────────────────────────────────────────────
async function testProxy() {
  const proxy = document.getElementById('proxy-input').value.trim();
  if (!proxy) { toast('Введите адрес прокси', 'warn'); return; }

  const btn = document.getElementById('proxy-test-btn');
  const status = document.getElementById('proxy-status');
  btn.classList.add('testing');
  status.textContent = '...'; status.className = 'proxy-status';

  try {
    const res = await eel.test_proxy(proxy)();
    if (res.success) {
      status.textContent = '✓ OK'; status.className = 'proxy-status ok';
      toast('Прокси работает', 'success');
    } else {
      status.textContent = '✗ Ошибка'; status.className = 'proxy-status err';
      toast('Прокси недоступен: ' + (res.error || ''), 'error');
    }
  } catch (e) {
    status.textContent = '✗'; status.className = 'proxy-status err';
  } finally {
    btn.classList.remove('testing');
  }
}

// ─── START DOWNLOAD ───────────────────────────────────────
async function startDownload() {
  if (!S.info) { toast('Сначала анализируйте ссылку', 'warn'); return; }

  // Check parallel limit
  if (S.activeCount >= S.maxParallel) {
    toast(`Достигнут лимит параллельных загрузок (${S.maxParallel})`, 'warn');
    return;
  }

  const url = document.getElementById('url-input').value.trim();
  const outputFormat = document.getElementById('output-format').value;
  const proxy = document.getElementById('proxy-input').value.trim() ||
                document.getElementById('s-proxy').value.trim() || '';
  const id = 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  // Rename support
  const renameVal = document.getElementById('rename-input')?.value.trim();
  const title = renameVal || (S.info.is_playlist ? S.info.playlist_title : (S.info.title || url));

  // Metadata
  const embedMeta = document.getElementById('chk-embed-meta')?.checked || false;
  const metaTitle = document.getElementById('meta-title')?.value.trim() || S.info.title || '';
  const metaArtist = document.getElementById('meta-artist')?.value.trim() || S.info.uploader || '';
  const metaYear = document.getElementById('meta-year')?.value.trim() || (S.info.upload_date || '').substring(0, 4) || '';

  const opts = {
    output_path: S.downloadPath,
    proxy: proxy || null,
    is_playlist: !!S.info.is_playlist,
    playlist_start: parseInt(document.getElementById('pl-start')?.value) || 1,
    playlist_end: document.getElementById('pl-end')?.value || null,
    subtitles: document.getElementById('chk-subtitles').checked,
    download_thumbnail: document.getElementById('chk-embed-thumb').checked,
    custom_filename: renameVal || null,
    embed_metadata: embedMeta,
    meta_title: metaTitle,
    meta_artist: metaArtist,
    meta_year: metaYear,
    meta_thumb: S.info.thumbnail || '',
  };

  if (S.type === 'thumb') {
    if (!S.selectedThumb && !S.info.thumbnail) {
      toast('Нет доступных превью', 'error'); return;
    }
    const thumbUrl = S.selectedThumb || S.info.thumbnail;
    addQueueItem(id, title, S.info.thumbnail || '', 'thumb');
    switchTab('queue');
    eel.download_thumbnail_only(id, thumbUrl, title, S.downloadPath)();
    return;
  }

  if (S.type === 'audio') {
    opts.audio_only = true;
    opts.audio_format = outputFormat;
  } else {
    opts.audio_only = false;
    opts.format_id = S.selectedFormat || 'bestvideo+bestaudio/best';
    opts.video_format = outputFormat;
  }

  addQueueItem(id, title, S.info.thumbnail || '', S.type);
  switchTab('queue');

  try {
    await eel.start_download(id, url, opts)();
  } catch (e) {
    downloadComplete(id, 'error', 'Ошибка запуска');
  }
}

// ─── QUEUE ────────────────────────────────────────────────
function addQueueItem(id, title, thumb, type) {
  const emptyEl = document.getElementById('empty-queue');
  if (emptyEl) emptyEl.style.display = 'none';

  S.downloads[id] = { title, thumb, percent: 0, status: 'pending' };
  S.queueTotal++;
  S.activeCount++;
  updateActiveIndicator();
  updateQueueBadge();

  const typeLabels = { video: 'VIDEO', audio: 'AUDIO', thumb: 'IMAGE' };
  const typeLabel = typeLabels[type] || 'MEDIA';

  const el = document.createElement('div');
  el.className = 'qi';
  el.id = `qi_${id}`;
  el.draggable = true;
  el.dataset.id = id;
  el.innerHTML = `
    <div class="qi-drag-handle" title="Перетащить для изменения порядка">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
        <circle cx="8" cy="6" r="1.5" fill="currentColor"/>
        <circle cx="16" cy="6" r="1.5" fill="currentColor"/>
        <circle cx="8" cy="12" r="1.5" fill="currentColor"/>
        <circle cx="16" cy="12" r="1.5" fill="currentColor"/>
        <circle cx="8" cy="18" r="1.5" fill="currentColor"/>
        <circle cx="16" cy="18" r="1.5" fill="currentColor"/>
      </svg>
    </div>
    <div class="qi-inner">
      <div class="qi-thumb-wrap">
        ${thumb ? `
          <img class="qi-thumb qi-thumb-bw" src="${escH(thumb)}" alt="" id="qi_bw_${id}"/>
          <img class="qi-thumb qi-thumb-color" src="${escH(thumb)}" alt="" id="qi_color_${id}" style="clip-path:inset(0 100% 0 0)"/>
        ` : ''}
      </div>
      <div class="qi-meta">
        <div class="qi-title" title="${escH(title)}">${escH(title)}</div>
        <div class="qi-sub">
          <span class="qi-status-badge qsb-pending" id="qi_badge_${id}">ОЖИДАНИЕ</span>
          <span id="qi_speed_${id}"></span>
          <span id="qi_eta_${id}"></span>
          <span id="qi_pl_${id}" style="color:var(--text4)"></span>
        </div>
      </div>
      <div class="qi-actions">
        <button class="qi-pause-btn" id="qi_pbtn_${id}" onclick="togglePause('${id}')" title="Пауза">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
            <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/>
            <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>
          </svg>
        </button>
        <button class="qi-cancel-btn" id="qi_xbtn_${id}" onclick="cancelDl('${id}')" title="Отмена">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="qi-progress">
      <div class="prog-track">
        <div class="prog-fill" id="qi_bar_${id}" style="width:0%"></div>
      </div>
      <div class="prog-stats">
        <span class="prog-left" id="qi_fname_${id}">Подготовка...</span>
        <span id="qi_pct_${id}">0%</span>
      </div>
    </div>
  `;

  // Drag events
  el.addEventListener('dragstart', onDragStart);
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('drop', onDrop);
  el.addEventListener('dragend', onDragEnd);

  document.getElementById('queue-list').prepend(el);

  setTimeout(() => {
    const badge = document.getElementById(`qi_badge_${id}`);
    if (badge && badge.textContent === 'ОЖИДАНИЕ') {
      badge.className = 'qi-status-badge qsb-dl';
      badge.textContent = 'ЗАГРУЗКА';
    }
  }, 400);
}

// ─── DRAG & DROP QUEUE REORDER ────────────────────────────
function onDragStart(e) {
  S.dragSrc = this;
  this.classList.add('qi-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.id);
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const list = document.getElementById('queue-list');
  const items = [...list.querySelectorAll('.qi:not(.qi-dragging)')];
  const after = items.find(el => {
    const box = el.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2;
  });
  if (after) list.insertBefore(S.dragSrc, after);
  else list.appendChild(S.dragSrc);
}

function onDrop(e) {
  e.preventDefault();
}

function onDragEnd() {
  this.classList.remove('qi-dragging');
  S.dragSrc = null;
}

// ─── PAUSE / RESUME ───────────────────────────────────────
async function togglePause(id) {
  const btn = document.getElementById(`qi_pbtn_${id}`);
  const badge = document.getElementById(`qi_badge_${id}`);
  const isPaused = S.pausedDownloads.has(id);

  if (isPaused) {
    // Resume
    S.pausedDownloads.delete(id);
    try { await eel.resume_download(id)(); } catch {}
    if (btn) btn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none"><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/></svg>`;
    if (btn) btn.title = 'Пауза';
    if (badge) { badge.className = 'qi-status-badge qsb-dl'; badge.textContent = 'ЗАГРУЗКА'; }
    toast('Загрузка возобновлена', 'info');
  } else {
    // Pause
    S.pausedDownloads.add(id);
    try { await eel.pause_download(id)(); } catch {}
    if (btn) btn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>`;
    if (btn) btn.title = 'Продолжить';
    if (badge) { badge.className = 'qi-status-badge qsb-pause'; badge.textContent = 'ПАУЗА'; }
    toast('Загрузка приостановлена', 'warn');
  }
}

// ─── EEL CALLBACKS ────────────────────────────────────────
eel.expose(update_progress);
function update_progress(id, percent, speed, eta, filename, plIndex, plTotal) {
  const dl = S.downloads[id];
  if (dl) dl.percent = percent;

  const bar = document.getElementById(`qi_bar_${id}`);
  const pct = document.getElementById(`qi_pct_${id}`);
  const spd = document.getElementById(`qi_speed_${id}`);
  const etaEl = document.getElementById(`qi_eta_${id}`);
  const fname = document.getElementById(`qi_fname_${id}`);
  const plEl = document.getElementById(`qi_pl_${id}`);
  const colorImg = document.getElementById(`qi_color_${id}`);

  if (bar) bar.style.width = `${percent}%`;
  if (pct) pct.textContent = `${percent}%`;
  if (spd) spd.textContent = speed || '';
  if (etaEl) etaEl.textContent = eta ? `ETA ${eta}` : '';
  if (fname && filename) fname.textContent = filename;
  if (plEl && plIndex != null && plTotal != null)
    plEl.textContent = `${plIndex}/${plTotal}`;

  if (colorImg) {
    const remain = Math.max(0, 100 - percent);
    colorImg.style.clipPath = `inset(0 ${remain}% 0 0)`;
  }
}

eel.expose(download_complete);
function download_complete(id, status, info) {
  const dl = S.downloads[id];
  if (!dl) return;

  dl.status = status;
  S.activeCount = Math.max(0, S.activeCount - 1);
  S.pausedDownloads.delete(id);
  updateActiveIndicator();

  const el = document.getElementById(`qi_${id}`);
  const bar = document.getElementById(`qi_bar_${id}`);
  const badge = document.getElementById(`qi_badge_${id}`);
  const xbtn = document.getElementById(`qi_xbtn_${id}`);
  const pbtn = document.getElementById(`qi_pbtn_${id}`);
  const fname = document.getElementById(`qi_fname_${id}`);
  const colorImg = document.getElementById(`qi_color_${id}`);
  const spd = document.getElementById(`qi_speed_${id}`);
  const etaEl = document.getElementById(`qi_eta_${id}`);

  if (xbtn) xbtn.style.display = 'none';
  if (pbtn) pbtn.style.display = 'none';
  if (spd) spd.textContent = '';
  if (etaEl) etaEl.textContent = '';

  if (status === 'success') {
    if (el) el.classList.add('qi-done');
    if (bar) { bar.style.width = '100%'; bar.classList.add('pf-done'); }
    if (badge) { badge.className = 'qi-status-badge qsb-done'; badge.textContent = 'ГОТОВО'; }
    if (fname) fname.textContent = 'Загрузка завершена';
    if (colorImg) colorImg.style.clipPath = 'inset(0 0% 0 0)';

    if (el && info) {
      const openBtn = document.createElement('button');
      openBtn.className = 'qi-open-btn';
      openBtn.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" stroke="currentColor" stroke-width="1.4"/>
        </svg>
        Открыть папку
      `;
      openBtn.onclick = () => eel.open_folder(info)();
      el.appendChild(openBtn);
    }

    // Play sound
    Sound.play('done');

    // Add to history
    History.add({
      url: document.getElementById('url-input').value.trim(),
      title: dl.title,
      thumb: dl.thumb,
      status: 'success',
      path: typeof info === 'string' ? info : S.downloadPath,
    });

    toast(`Готово: ${(dl.title || '').substring(0, 45)}`, 'success');

  } else if (status === 'cancelled') {
    if (el) el.classList.add('qi-cancelled');
    if (badge) { badge.className = 'qi-status-badge qsb-cancel'; badge.textContent = 'ОТМЕНЕНО'; }
    if (fname) fname.textContent = 'Отменено пользователем';

  } else {
    if (el) el.classList.add('qi-error');
    if (bar) bar.classList.add('pf-err');
    if (badge) { badge.className = 'qi-status-badge qsb-err'; badge.textContent = 'ОШИБКА'; }
    const errMsg = typeof info === 'string' ? info.substring(0, 70) : 'Ошибка загрузки';
    if (fname) fname.textContent = errMsg;

    // Add retry button
    if (el) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'qi-open-btn qi-retry-btn';
      retryBtn.innerHTML = `↺ Докачать (Resume)`;
      retryBtn.onclick = () => retryDownload(id);
      el.appendChild(retryBtn);
    }

    Sound.play('error');
    toast('Ошибка: ' + errMsg.substring(0, 60), 'error');
  }

  updateQueueSub();
}

// ─── RETRY / RESUME FAILED ────────────────────────────────
async function retryDownload(id) {
  const dl = S.downloads[id];
  if (!dl) return;
  const url = document.getElementById('url-input').value.trim();
  if (!url) { toast('Вставьте URL и попробуйте снова', 'warn'); return; }

  if (S.activeCount >= S.maxParallel) {
    toast('Достигнут лимит параллельных загрузок', 'warn'); return;
  }

  // Reset UI
  const el = document.getElementById(`qi_${id}`);
  if (el) {
    el.classList.remove('qi-error', 'qi-cancelled');
    el.querySelectorAll('.qi-retry-btn').forEach(b => b.remove());
  }
  const bar = document.getElementById(`qi_bar_${id}`);
  const badge = document.getElementById(`qi_badge_${id}`);
  const fname = document.getElementById(`qi_fname_${id}`);
  const xbtn = document.getElementById(`qi_xbtn_${id}`);
  const pbtn = document.getElementById(`qi_pbtn_${id}`);
  const colorImg = document.getElementById(`qi_color_${id}`);

  if (bar) { bar.style.width = '0%'; bar.className = 'prog-fill'; }
  if (badge) { badge.className = 'qi-status-badge qsb-dl'; badge.textContent = 'ДОКАЧКА'; }
  if (fname) fname.textContent = 'Возобновление...';
  if (xbtn) xbtn.style.display = '';
  if (pbtn) pbtn.style.display = '';
  if (colorImg) colorImg.style.clipPath = 'inset(0 100% 0 0)';

  dl.status = 'pending';
  dl.percent = 0;
  S.activeCount++;
  updateActiveIndicator();

  try {
    await eel.start_download(id, url, { output_path: S.downloadPath, resume: true })();
  } catch (e) {
    downloadComplete(id, 'error', 'Ошибка возобновления');
  }
}

async function cancelDl(id) {
  try { await eel.cancel_download(id)(); } catch (e) {}
}

function clearCompleted() {
  document.querySelectorAll('.qi.qi-done, .qi.qi-error, .qi.qi-cancelled').forEach(el => {
    el.style.transition = 'opacity 0.2s, transform 0.2s';
    el.style.opacity = '0'; el.style.transform = 'scale(0.95)';
    setTimeout(() => el.remove(), 200);
  });
  setTimeout(() => {
    if (document.querySelectorAll('.qi').length === 0) {
      const empty = document.getElementById('empty-queue');
      if (empty) empty.style.display = 'flex';
    }
  }, 300);
}

// ─── HISTORY TAB ──────────────────────────────────────────
function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  const items = History.load();
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = `
      <div class="empty-queue">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" opacity="0.12">
          <path d="M12 8v4l3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.2"/>
        </svg>
        <div class="empty-queue-text">История пуста</div>
        <div class="empty-queue-sub">Завершённые загрузки появятся здесь</div>
      </div>`;
    return;
  }

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'hist-item';
    const date = new Date(item.ts);
    const dateStr = date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
    div.innerHTML = `
      ${item.thumb ? `<img class="hist-thumb" src="${escH(item.thumb)}" alt="" loading="lazy"/>` : '<div class="hist-thumb hist-thumb-empty"></div>'}
      <div class="hist-meta">
        <div class="hist-title">${escH(item.title || item.url)}</div>
        <div class="hist-sub">
          <span class="hist-date">${dateStr}</span>
          ${item.path ? `<span class="hist-path">${escH(item.path.substring(item.path.length - 40))}</span>` : ''}
        </div>
      </div>
      <button class="hist-reuse-btn" onclick="reuseHistoryItem('${escH(item.url)}')" title="Загрузить снова">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <path d="M12 3v13M6 11l6 6 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M3 19h18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    `;
    list.appendChild(div);
  });
}

function reuseHistoryItem(url) {
  document.getElementById('url-input').value = url;
  switchTab('download');
  doFetch();
}

function clearHistory() {
  History.clear();
  renderHistory();
  toast('История очищена', 'info');
}

// ─── SETTINGS UI ──────────────────────────────────────────
function syncSettingsUI() {
  const soundToggle = document.getElementById('s-sound-toggle');
  const parallelSel = document.getElementById('s-parallel');
  if (soundToggle) soundToggle.checked = S.soundEnabled;
  if (parallelSel) parallelSel.value = String(S.maxParallel);
}

function toggleSound(val) {
  S.soundEnabled = val;
  Prefs.set('soundEnabled', val);
  if (val) {
    if (!Sound.ctx) Sound.init();
    Sound.play('done');
  }
  toast(val ? 'Звук включён' : 'Звук выключен', 'info');
}

function setParallel(val) {
  S.maxParallel = parseInt(val) || 3;
  Prefs.set('maxParallel', S.maxParallel);
  toast(`Параллельные загрузки: ${S.maxParallel}`, 'info');
}

// ─── UI HELPERS ───────────────────────────────────────────
function updateActiveIndicator() {
  const ind = document.getElementById('active-indicator');
  const count = document.getElementById('active-count');
  ind.classList.toggle('visible', S.activeCount > 0);
  count.textContent = `${S.activeCount} активных`;
}

function updateQueueBadge() {
  const badge = document.getElementById('queue-badge');
  badge.style.display = 'flex';
  badge.textContent = S.queueTotal;
}

function updateQueueSub() {
  const sub = document.getElementById('queue-sub');
  const done = document.querySelectorAll('.qi.qi-done').length;
  const total = document.querySelectorAll('.qi').length;
  sub.textContent = total ? `${done} завершено из ${total}` : 'Нет активных загрузок';
}

// ─── TOAST ────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const wrap = document.getElementById('toast-wrap');
  const t = document.createElement('div');
  t.className = `toast t-${type}`;
  t.innerHTML = `<div class="toast-dot"></div><span>${escH(msg)}</span>`;
  wrap.appendChild(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 260); }, 3600);
}

// ─── UTILS ────────────────────────────────────────────────
function escH(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}