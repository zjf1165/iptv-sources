/**
 * IPTV Player — pure frontend player for iptv-sources
 * Parses M3U files, plays HLS streams via hls.js, shows EPG data.
 */
(function () {
  'use strict';

  // ── DOM refs ──
  const $ = (sel) => document.querySelector(sel);
  const video = $('#video-player');
  const channelListEl = $('#channelList');
  const sourceSelect = $('#sourceSelect');
  const searchInput = $('#searchInput');
  const playerPlaceholder = $('#playerPlaceholder');
  const playerOverlay = $('#playerOverlay');
  const overlaySpinner = $('#overlaySpinner');
  const overlayText = $('#overlayText');
  const nowChannelName = $('#nowChannelName');
  const nowEpgInfo = $('#nowEpgInfo');
  const epgPanel = $('#epgPanel');
  const epgPanelTitle = $('#epgPanelTitle');
  const epgList = $('#epgList');
  const btnEpg = $('#btnEpg');
  const btnPrev = $('#btnPrev');
  const btnNext = $('#btnNext');
  const sidebarToggle = $('#sidebarToggle');
  const sidebar = $('#sidebar');
  const sidebarBackdrop = $('#sidebarBackdrop');

  // ── State ──
  let allChannels = [];       // flat list: { name, url, logo, group, tvgId, tvgName }
  let filteredChannels = [];  // after search filter
  let currentIndex = -1;      // index in filteredChannels
  let hls = null;
  let epgCache = {};          // { channelName: [...programmes] }
  let epgShowPanel = false;
  let currentSourceName = '';

  // Known M3U sources list — fetched from channels.json or built from known files
  const KNOWN_SOURCES = [];

  // ── Init ──
  async function init() {
    bindEvents();
    await loadSourceList();
  }

  // ── Load source list ──
  async function loadSourceList() {
    try {
      // Try channels.json first
      const res = await fetch('/channels.json');
      if (res.ok) {
        const data = await res.json();
        // channels.json: { channels: [...], sources: [{name, f_name, ...}] }
        if (data.sources && data.sources.length) {
          data.sources.forEach((s) => {
            KNOWN_SOURCES.push({ name: s.name || s.f_name, file: s.f_name });
          });
        }
      }
    } catch (_) { /* ignore */ }

    // Fallback: some well-known files
    if (KNOWN_SOURCES.length === 0) {
      const fallbacks = ['all', 'o_all', 'epg_pw', 'youhun', 'hotel_iptv'];
      for (const f of fallbacks) {
        try {
          const r = await fetch(`/${f}.m3u`, { method: 'HEAD' });
          if (r.ok) KNOWN_SOURCES.push({ name: f, file: f });
        } catch (_) { /* skip */ }
      }
    }

    // Populate select
    sourceSelect.innerHTML = '';
    if (KNOWN_SOURCES.length === 0) {
      sourceSelect.innerHTML = '<option value="">未找到直播源</option>';
      return;
    }

    KNOWN_SOURCES.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.file;
      opt.textContent = s.name;
      sourceSelect.appendChild(opt);
    });

    // Auto-load first source
    await loadSource(KNOWN_SOURCES[0].file);
  }

  // ── Load M3U source ──
  async function loadSource(fileName) {
    if (!fileName) return;
    currentSourceName = fileName;
    channelListEl.innerHTML = '<div style="padding:20px;color:#666;text-align:center;">加载频道列表...</div>';

    try {
      const res = await fetch(`/${fileName}.m3u`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      allChannels = parseM3U(text);
      filteredChannels = allChannels;
      currentIndex = -1;
      renderChannelList(filteredChannels);
    } catch (e) {
      channelListEl.innerHTML = `<div style="padding:20px;color:#ef5350;text-align:center;">加载失败: ${e.message}</div>`;
    }
  }

  // ── Parse M3U ──
  function parseM3U(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const channels = [];
    let current = null;

    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        current = { name: '', url: '', logo: '', group: '未分组', tvgId: '', tvgName: '' };

        // Parse attributes
        const groupMatch = line.match(/group-title="([^"]*)"/);
        const logoMatch = line.match(/tvg-logo="([^"]*)"/);
        const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
        const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);

        if (groupMatch) current.group = groupMatch[1] || '未分组';
        if (logoMatch) current.logo = logoMatch[1];
        if (tvgIdMatch) current.tvgId = tvgIdMatch[1];
        if (tvgNameMatch) current.tvgName = tvgNameMatch[1];

        // Channel name is after the last comma
        const commaIdx = line.lastIndexOf(',');
        if (commaIdx !== -1) {
          current.name = line.substring(commaIdx + 1).trim();
        }
      } else if (current && !line.startsWith('#')) {
        current.url = line;
        if (current.name && current.url) {
          channels.push(current);
        }
        current = null;
      }
    }

    return channels;
  }

  // ── Render channel list ──
  function renderChannelList(channels) {
    channelListEl.innerHTML = '';

    if (channels.length === 0) {
      channelListEl.innerHTML = '<div style="padding:20px;color:#666;text-align:center;">无匹配频道</div>';
      return;
    }

    // Group channels
    const groups = new Map();
    channels.forEach((ch) => {
      const g = ch.group || '未分组';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(ch);
    });

    const fragment = document.createDocumentFragment();

    groups.forEach((chs, groupName) => {
      // Group header
      const header = document.createElement('div');
      header.className = 'group-header';
      header.innerHTML = `<span><span class="arrow">▼</span> ${escHtml(groupName)}</span><span class="count">${chs.length}</span>`;

      const container = document.createElement('div');
      container.className = 'group-channels';

      header.addEventListener('click', () => {
        header.classList.toggle('collapsed');
        container.classList.toggle('hidden');
      });

      chs.forEach((ch) => {
        const idx = channels.indexOf(ch);
        const item = document.createElement('div');
        item.className = 'channel-item';
        item.dataset.index = idx;

        const logoEl = document.createElement('div');
        logoEl.className = 'channel-logo';
        if (ch.logo) {
          const img = document.createElement('img');
          img.src = ch.logo;
          img.alt = '';
          img.loading = 'lazy';
          img.onerror = function () { this.parentElement.textContent = '📺'; this.remove(); };
          logoEl.appendChild(img);
        } else {
          logoEl.textContent = '📺';
        }

        const info = document.createElement('div');
        info.className = 'channel-info';
        info.innerHTML = `<div class="channel-name">${escHtml(ch.name)}</div><div class="channel-epg-now" data-ch="${escHtml(ch.tvgName || ch.name)}"></div>`;

        item.appendChild(logoEl);
        item.appendChild(info);

        item.addEventListener('click', () => playChannel(idx));
        container.appendChild(item);
      });

      fragment.appendChild(header);
      fragment.appendChild(container);
    });

    channelListEl.appendChild(fragment);
  }

  // ── Play channel ──
  function playChannel(index) {
    if (index < 0 || index >= filteredChannels.length) return;
    currentIndex = index;
    const ch = filteredChannels[index];

    // Update UI active state
    channelListEl.querySelectorAll('.channel-item').forEach((el) => {
      el.classList.toggle('active', parseInt(el.dataset.index) === index);
    });

    // Scroll active item into view
    const activeEl = channelListEl.querySelector('.channel-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    // Hide placeholder, show overlay
    playerPlaceholder.style.display = 'none';
    showOverlay('加载中...', true);

    // Update info bar
    nowChannelName.textContent = ch.name;
    nowEpgInfo.innerHTML = '';
    document.title = `${ch.name} - IPTV Player`;

    // Stop previous
    destroyHls();

    // Start playback
    const url = ch.url;
    if (Hls.isSupported() && isHlsUrl(url)) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startLevel: -1,
      });

      hls.loadSource(url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        hideOverlay();
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              showOverlay('网络错误，尝试恢复...', true);
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              showOverlay('媒体错误，尝试恢复...', true);
              hls.recoverMediaError();
              break;
            default:
              showOverlay('播放失败，无法恢复', false);
              destroyHls();
              break;
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari/iOS)
      video.src = url;
      video.addEventListener('loadedmetadata', () => {
        hideOverlay();
        video.play().catch(() => {});
      }, { once: true });
      video.addEventListener('error', () => {
        showOverlay('播放失败', false);
      }, { once: true });
    } else {
      // Direct play (mp4/other)
      video.src = url;
      video.addEventListener('canplay', () => {
        hideOverlay();
        video.play().catch(() => {});
      }, { once: true });
      video.addEventListener('error', () => {
        showOverlay('不支持的流格式', false);
      }, { once: true });
    }

    // Load EPG
    loadEpgForChannel(ch);

    // Close sidebar on mobile
    closeSidebar();
  }

  function isHlsUrl(url) {
    return /\.m3u8?($|\?)/.test(url) || url.includes('/live/') || url.includes('/hls/');
  }

  function destroyHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.removeAttribute('src');
    video.load();
  }

  // ── Overlay ──
  function showOverlay(text, loading) {
    overlaySpinner.style.display = loading ? 'block' : 'none';
    overlayText.textContent = text;
    playerOverlay.classList.add('visible');
  }

  function hideOverlay() {
    playerOverlay.classList.remove('visible');
  }

  // ── EPG ──
  async function loadEpgForChannel(ch) {
    const channelName = ch.tvgName || ch.name;
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

    // Try known EPG providers
    const providers = ['epg_pw', '51zmt'];
    let programmes = null;

    for (const provider of providers) {
      const cacheKey = `${provider}/${dateStr}/${channelName}`;
      if (epgCache[cacheKey]) {
        programmes = epgCache[cacheKey];
        break;
      }

      try {
        const url = `/epg/${provider}/${dateStr}/${encodeURIComponent(channelName)}.json`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          // TVBox EPG JSON format: { "epg_data": [{ "title": "...", "start": "...", "end": "..." }] }
          // or array directly
          programmes = Array.isArray(data) ? data : (data.epg_data || data.list || []);
          epgCache[cacheKey] = programmes;
          break;
        }
      } catch (_) { /* try next */ }
    }

    updateEpgDisplay(channelName, programmes);
  }

  function updateEpgDisplay(channelName, programmes) {
    const now = new Date();

    if (!programmes || programmes.length === 0) {
      nowEpgInfo.innerHTML = '';
      epgPanelTitle.textContent = `节目预告 - ${channelName}`;
      epgList.innerHTML = '<div class="epg-empty">暂无节目预告</div>';
      return;
    }

    // Find current programme
    let currentProg = null;
    let nextProg = null;

    for (let i = 0; i < programmes.length; i++) {
      const p = programmes[i];
      const start = parseEpgTime(p.start);
      const end = parseEpgTime(p.end);

      if (start && end && now >= start && now < end) {
        currentProg = p;
        if (i + 1 < programmes.length) nextProg = programmes[i + 1];
        break;
      }
    }

    // Update info bar
    if (currentProg) {
      let html = `<span class="label">正在播出:</span>${escHtml(currentProg.title)}`;
      if (nextProg) {
        html += `  <span class="label" style="margin-left:12px;">下一个:</span>${escHtml(nextProg.title)}`;
      }
      nowEpgInfo.innerHTML = html;
    } else {
      nowEpgInfo.innerHTML = '';
    }

    // Update EPG panel
    epgPanelTitle.textContent = `节目预告 - ${channelName}`;
    epgList.innerHTML = '';

    programmes.forEach((p) => {
      const start = parseEpgTime(p.start);
      const end = parseEpgTime(p.end);
      const isCurrent = start && end && now >= start && now < end;

      const item = document.createElement('div');
      item.className = 'epg-item' + (isCurrent ? ' current' : '');
      item.innerHTML = `<div class="time">${formatTime(start)} - ${formatTime(end)}</div><div class="title">${escHtml(p.title)}</div>`;

      epgList.appendChild(item);

      if (isCurrent) {
        setTimeout(() => item.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
      }
    });

    // Also try to update the sidebar EPG text for this channel
    const sidebarEpgEl = channelListEl.querySelector(`.channel-epg-now[data-ch="${CSS.escape(channelName)}"]`);
    if (sidebarEpgEl && currentProg) {
      sidebarEpgEl.textContent = `▶ ${currentProg.title}`;
    }
  }

  function parseEpgTime(str) {
    if (!str) return null;
    // Try ISO or common formats
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d;
    // Try "HH:mm" format (today)
    const m = str.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const t = new Date();
      t.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
      return t;
    }
    return null;
  }

  function formatTime(d) {
    if (!d) return '--:--';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function pad2(n) { return n.toString().padStart(2, '0'); }

  // ── Search ──
  function onSearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      filteredChannels = allChannels;
    } else {
      filteredChannels = allChannels.filter(
        (ch) => ch.name.toLowerCase().includes(q) || ch.group.toLowerCase().includes(q)
      );
    }
    currentIndex = -1;
    renderChannelList(filteredChannels);
  }

  // ── Prev/Next ──
  function playPrev() {
    if (filteredChannels.length === 0) return;
    const idx = currentIndex <= 0 ? filteredChannels.length - 1 : currentIndex - 1;
    playChannel(idx);
  }

  function playNext() {
    if (filteredChannels.length === 0) return;
    const idx = currentIndex >= filteredChannels.length - 1 ? 0 : currentIndex + 1;
    playChannel(idx);
  }

  // ── Sidebar toggle (mobile) ──
  function openSidebar() {
    sidebar.classList.add('open');
    sidebarBackdrop.classList.add('visible');
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarBackdrop.classList.remove('visible');
  }

  // ── EPG panel toggle ──
  function toggleEpgPanel() {
    epgShowPanel = !epgShowPanel;
    epgPanel.classList.toggle('hidden', !epgShowPanel);
    btnEpg.classList.toggle('active', epgShowPanel);
  }

  // ── Events ──
  function bindEvents() {
    sourceSelect.addEventListener('change', () => loadSource(sourceSelect.value));
    searchInput.addEventListener('input', debounce(onSearch, 250));
    btnPrev.addEventListener('click', playPrev);
    btnNext.addEventListener('click', playNext);
    btnEpg.addEventListener('click', toggleEpgPanel);
    sidebarToggle.addEventListener('click', openSidebar);
    sidebarBackdrop.addEventListener('click', closeSidebar);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Don't capture when typing in search
      if (e.target === searchInput) return;

      switch (e.key) {
        case 'ArrowUp':
        case 'p':
          e.preventDefault();
          playPrev();
          break;
        case 'ArrowDown':
        case 'n':
          e.preventDefault();
          playNext();
          break;
        case 'f':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            toggleFullscreen();
          }
          break;
        case ' ':
          e.preventDefault();
          if (video.paused) video.play().catch(() => {});
          else video.pause();
          break;
        case 'Escape':
          closeSidebar();
          break;
        case 'e':
          e.preventDefault();
          toggleEpgPanel();
          break;
        case '/':
          e.preventDefault();
          searchInput.focus();
          break;
      }
    });

    // Video events
    video.addEventListener('waiting', () => showOverlay('缓冲中...', true));
    video.addEventListener('playing', () => hideOverlay());
    video.addEventListener('error', () => {
      if (video.src || video.currentSrc) showOverlay('播放出错', false);
    });
  }

  function toggleFullscreen() {
    const el = $('#playerArea');
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen).call(document);
    }
  }

  // ── Util ──
  function escHtml(s) {
    const div = document.createElement('div');
    div.textContent = s || '';
    return div.innerHTML;
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  // ── Start ──
  init();
})();
