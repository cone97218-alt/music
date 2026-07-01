import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { 
  initLyricsWidget, 
  ensureDesktopLyrics, 
  applyDesktopLyricsSettings, 
  updateDesktopLyrics, 
  clampDesktopLyricsPosition 
} from './lyrics-widget.js';

// ─── Playback & App State ──────────────────────────────────────────────────────
var state = {
  playlists: {
    "默认歌单": []
  },
  currentPlaylist: "默认歌单",
  currentSong: null,
  isPlaying: false,
  loopMode: 'list', // 'list', 'single', 'shuffle'
  volume: 0.5,
  activeQueue: [],
  settings: {
    displayMode: 'wand-modal',
    audioQuality: '999',
    desktopLyricsEnabled: false,
    desktopLyricsLocked: false,
    desktopLyricsTextColor: '#ffffff',
    desktopLyricsBgColor: '#080d14',
    desktopLyricsBgOpacity: 60,
    desktopLyricsFontSize: 16,
    desktopLyricsToggleMethod: 'none',
    desktopLyricsLongPressTime: 800,
    desktopLyricsZIndex: 99999,
    desktopLyricsLeft: '',
    desktopLyricsTop: '',
    desktopLyricsControlsEnabled: false,
    desktopLyricsControlsType: 'buttons',
    desktopLyricsControlsPolicy: 'always',
    searchSources: ['netease', 'joox', 'bilibili'],
    showErrorToasts: false
  }
};

// ─── In-Memory Caches & Logging ───────────────────────────────────────────────
var apiCache = {
  search: new Map(), // key: query_page_sources -> Array<Song>
  url: new Map(),    // key: source_id_br -> { url, br, size, expireAt }
  pic: new Map(),    // key: source_id_size -> coverUrl
  lyric: new Map()   // key: source_id -> lyricData
};

var errorLogs = [];
var MAX_ERROR_LOGS = 10;

function getCache(type, key) {
  var entry = apiCache[type].get(key);
  if (!entry) return null;
  if (entry.expireAt && entry.expireAt < Date.now()) {
    apiCache[type].delete(key);
    return null;
  }
  return entry.value;
}

function setCache(type, key, value, ttl = 0) {
  var expireAt = ttl ? Date.now() + ttl : 0;
  if (apiCache[type].size >= 100) {
    var firstKey = apiCache[type].keys().next().value;
    apiCache[type].delete(firstKey);
  }
  apiCache[type].set(key, { value: value, expireAt: expireAt });
}

function triggerError(msg) {
  console.error("[FIRE Error]", msg);
  var time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  errorLogs.unshift(`[${time}] ${msg}`);
  if (errorLogs.length > MAX_ERROR_LOGS) {
    errorLogs.pop();
  }
  renderLogsUI();
  
  if (state.settings.showErrorToasts) {
    showToast(msg);
  }
}

function renderLogsUI() {
  var doc = getDoc();
  var container = doc.getElementById('fire-logs-container');
  if (!container) return;
  if (errorLogs.length === 0) {
    container.innerHTML = '<div style="opacity:0.5;text-align:center;padding:4px;">暂无运行日志</div>';
    return;
  }
  container.innerHTML = errorLogs.map(log => {
    var isErr = log.indexOf('错误') !== -1 || log.indexOf('失败') !== -1 || log.indexOf('限流') !== -1;
    var color = isErr ? 'color:var(--fire-em, #ffbaba);' : 'opacity:0.8;';
    return `<div style="margin-bottom:4px;line-height:1.2;word-break:break-all;${color}">${log}</div>`;
  }).join('');
}

var consecutiveFailures = 0;
var lastFailedSongId = null;

function handlePlaybackFailure(song, errorMsg) {
  if (!song) return;
  if (lastFailedSongId === song.id) return;
  lastFailedSongId = song.id;

  consecutiveFailures++;
  triggerError(`播放失败: ${song.name} (${errorMsg})`);

  var queue = state.activeQueue || state.playlists[state.currentPlaylist] || [];
  var limit = Math.min(3, queue.length || 3);

  if (consecutiveFailures >= limit) {
    consecutiveFailures = 0;
    state.isPlaying = false;
    if (audio) audio.pause();
    updatePlaybackUI();
    triggerError("已连续失败多次，自动停止播放");
  } else {
    if (state.isPlaying) {
      triggerError("正在自动尝试下一首...");
      playNext();
    } else {
      updatePlaybackUI();
    }
  }
}

var audio = null;
var qrBtnObserver = null;
var currentSearchSongs = [];
var lastSearchQueryState = null;
var currentSearchPage = 1;
var currentSearchQuery = '';
var activeTab = 'search'; // 'search', 'playlists'
var lastActiveLineIdx = -1;
var lyricsList = [];
var lastToggleTime = 0;
var isInitDone = false;
var initTimestamp = 0;
var panelOpen = false;
var DEFAULT_COVER = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%231a1a1a"/><circle cx="50" cy="50" r="35" fill="none" stroke="%23333" stroke-width="8"/><circle cx="50" cy="50" r="20" fill="none" stroke="%23444" stroke-width="4"/></svg>';

// ─── DOM Helper Functions ─────────────────────────────────────────────────────
function getDoc() {
  // Always use the local document of the script's execution context.
  // If SillyTavern is embedded in an iframe (e.g. portals, dashboards, mobile wrappers),
  // window.parent refers to the outer wrapper which does not contain SillyTavern's DOM.
  return document;
}

function getWin() {
  return window;
}

function showPrompt(text, defaultValue, title) {
  return new Promise((resolve) => {
    var win = getWin();
    if (win.parent && win.parent.SillyTavern && typeof win.parent.SillyTavern.userPrompt === 'function') {
      win.parent.SillyTavern.userPrompt(text, defaultValue, title).then(resolve);
    } else if (win.SillyTavern && typeof win.SillyTavern.userPrompt === 'function') {
      win.SillyTavern.userPrompt(text, defaultValue, title).then(resolve);
    } else {
      var val = win.prompt(text, defaultValue);
      resolve(val);
    }
  });
}

function showConfirm(text, title) {
  return new Promise((resolve) => {
    var win = getWin();
    if (win.parent && win.parent.SillyTavern && typeof win.parent.SillyTavern.userConfirm === 'function') {
      win.parent.SillyTavern.userConfirm(text, title).then(resolve);
    } else if (win.SillyTavern && typeof win.SillyTavern.userConfirm === 'function') {
      win.SillyTavern.userConfirm(text, title).then(resolve);
    } else {
      var ok = win.confirm(text);
      resolve(ok);
    }
  });
}

// ─── LocalStorage Persistence ─────────────────────────────────────────────────
function saveState() {
  try {
    localStorage.setItem('fire_playlists', JSON.stringify(state.playlists));
    localStorage.setItem('fire_current_playlist', state.currentPlaylist);
    localStorage.setItem('fire_loop_mode', state.loopMode);
    localStorage.setItem('fire_volume', String(state.volume));
    localStorage.setItem('fire_settings', JSON.stringify(state.settings));
    if (state.activeQueue) {
      localStorage.setItem('fire_active_queue', JSON.stringify(state.activeQueue));
    } else {
      localStorage.removeItem('fire_active_queue');
    }
  } catch (e) {
    console.error("[FIRE] Failed to save state to localStorage:", e);
  }
}

function loadState() {
  try {
    var savedPlaylists = localStorage.getItem('fire_playlists');
    if (savedPlaylists) {
      state.playlists = JSON.parse(savedPlaylists);
    }
    
    var savedCurrentPlaylist = localStorage.getItem('fire_current_playlist');
    if (savedCurrentPlaylist && (savedCurrentPlaylist === "__active_queue__" || state.playlists[savedCurrentPlaylist])) {
      state.currentPlaylist = savedCurrentPlaylist;
    }

    var savedLoopMode = localStorage.getItem('fire_loop_mode');
    if (savedLoopMode) {
      state.loopMode = savedLoopMode;
    }

    var savedVolume = localStorage.getItem('fire_volume');
    if (savedVolume !== null) {
      state.volume = parseFloat(savedVolume);
    }

    var savedSettings = localStorage.getItem('fire_settings');
    if (savedSettings) {
      state.settings = Object.assign({}, state.settings, JSON.parse(savedSettings));
    }

    var savedQueue = localStorage.getItem('fire_active_queue');
    if (savedQueue) {
      state.activeQueue = JSON.parse(savedQueue);
    } else {
      state.activeQueue = state.playlists[state.currentPlaylist] || [];
    }

    state.viewMode = localStorage.getItem('fire_view_mode') || 'cd';
  } catch (e) {
    console.error("[FIRE] Failed to load state from localStorage:", e);
  }
}

// ─── Viewport & Theme Helpers ──────────────────────────────────────────────────
function syncViewportHeight() {
  try {
    var p = getWin();
    var h = (p.visualViewport && p.visualViewport.height) || p.innerHeight || 640;
    p.document.documentElement.style.setProperty('--fire-vvh', Math.max(320, Math.round(h)) + 'px');
  } catch (e) {}
}

function updateDynamicThemeColors() {
  try {
    var p = getWin();
    var doc = getDoc();
    var panel = doc.getElementById('fire-panel');
    if (!panel) return;

    var temp = doc.createElement('div');
    temp.style.color = 'var(--SmartThemeBlurTintColor)';
    doc.body.appendChild(temp);
    var color = p.getComputedStyle(temp).color;
    doc.body.removeChild(temp);

    var opaqueColor = '#080d14'; // fallback
    var match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      opaqueColor = 'rgb(' + match[1] + ', ' + match[2] + ', ' + match[3] + ')';
    } else if (color.startsWith('#')) {
      opaqueColor = color;
    }

    doc.body.style.setProperty('--fire-bg-opaque', opaqueColor);
  } catch (e) {
    console.warn('[FIRE] updateDynamicThemeColors error:', e);
  }
}

// ─── Audio Engine & Playback Logic ───────────────────────────────────────────
function initAudio() {
  if (audio) return;
  audio = new Audio();
  audio.volume = state.volume;

  audio.addEventListener('play', function () {
    state.isPlaying = true;
    consecutiveFailures = 0; // Reset failure counter on successful play
    lastFailedSongId = null;
    updatePlaybackUI();
  });

  audio.addEventListener('pause', function () {
    state.isPlaying = false;
    updatePlaybackUI();
  });

  audio.addEventListener('timeupdate', function () {
    updateProgressBar();
    updateLyricsHighlight();
  });

  audio.addEventListener('ended', function () {
    handleSongEnded();
  });

  audio.addEventListener('error', function (e) {
    console.error("[FIRE] Audio error:", e);
    handlePlaybackFailure(state.currentSong, "播放源出错或解码失败");
  });
}

async function playSong(song) {
  initAudio();
  state.currentSong = song;
  lastFailedSongId = null; // Clear duplicate failure check for new play attempt
  updatePlaybackUI();

  // On mobile, auto-switch to Now Playing tab when playing a song
  var isMobile = (window.parent || window).innerWidth <= 760;
  if (isMobile) {
    switchTab('nowplaying');
  }

  // Reset progress and lyrics
  var doc = getDoc();
  var slider = doc.getElementById('fire-progress-slider');
  if (slider) slider.value = 0;
  var timeCur = doc.getElementById('fire-time-current');
  if (timeCur) timeCur.textContent = '00:00';
  var timeDur = doc.getElementById('fire-time-duration');
  if (timeDur) timeDur.textContent = '00:00';
  
  lyricsList = [];
  lastActiveLineIdx = -1;
  renderLyrics();
  updateDesktopLyrics(-1, lyricsList);

  if (state.settings.showErrorToasts) {
    showToast("正在加载: " + song.name);
  }

  try {
    // Quality fallbacks: 999 -> 740 -> 320 -> 192 -> 128
    var qualities = ['999', '740', '320', '192', '128'];
    var startQuality = state.settings.audioQuality || '999';
    var startIndex = qualities.indexOf(startQuality);
    if (startIndex === -1) startIndex = 0;

    var playUrl = null;
    var finalBr = null;
    var size = null;
    var rateLimitHit = false;

    for (var idx = startIndex; idx < qualities.length; idx++) {
      var currentBr = qualities[idx];
      var cacheKey = `${song.source || 'netease'}_${song.id}_${currentBr}`;
      
      // Try URL Cache
      var cachedUrlData = getCache('url', cacheKey);
      if (cachedUrlData) {
        playUrl = cachedUrlData.url;
        finalBr = cachedUrlData.br;
        size = cachedUrlData.size;
        break;
      }

      try {
        var urlRes = await fetch(`https://music-api.gdstudio.xyz/api.php?types=url&source=${song.source || 'netease'}&id=${song.id}&br=${currentBr}`);
        if (urlRes.status === 429) {
          rateLimitHit = true;
          break;
        }
        if (!urlRes.ok) {
          throw new Error(`HTTP status: ${urlRes.status}`);
        }
        var urlData = await urlRes.json();
        if (urlData && urlData.url) {
          playUrl = urlData.url;
          finalBr = urlData.br || currentBr;
          size = urlData.size || 0;
          // Cache URL data (TTL: 15 minutes)
          setCache('url', cacheKey, { url: playUrl, br: finalBr, size: size }, 15 * 60 * 1000);
          break;
        } else {
          console.warn(`[FIRE] Empty URL for quality ${currentBr}, trying next...`);
        }
      } catch (err) {
        console.warn(`[FIRE] Fetch URL failed for quality ${currentBr}:`, err);
      }
    }

    if (rateLimitHit) {
      triggerError("播放请求被限流，请稍后再试");
      state.isPlaying = false;
      updatePlaybackUI();
      return;
    }

    if (!playUrl) {
      throw new Error("所有音质均无法获取音频直链");
    }

    // Force HTTPS if parent runs on HTTPS to bypass mixed-content blocker
    if (window.location.protocol === 'https:' && playUrl.startsWith('http://')) {
      playUrl = playUrl.replace('http://', 'https://');
    }

    audio.src = playUrl;
    await audio.play();
    
    // Add positive run log
    var brStr = finalBr === '999' ? '24bit无损' : finalBr === '740' ? '16bit无损' : finalBr + 'kbps';
    var sizeStr = size ? ` (${(size / 1024).toFixed(2)}MB)` : '';
    var logMsg = `正在播放: ${song.name} - 音质: ${brStr}${sizeStr}`;
    var time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    errorLogs.unshift(`[${time}] ${logMsg}`);
    if (errorLogs.length > MAX_ERROR_LOGS) errorLogs.pop();
    renderLogsUI();

  } catch (err) {
    console.error("[FIRE] Playback failed:", err);
    handlePlaybackFailure(song, err.message);
    return;
  }

  // 2. Load Lyrics asynchronously
  fetchAndParseLyrics(song.id, song.source);
}

async function fetchAndParseLyrics(songId, source) {
  var cacheKey = `${source || 'netease'}_${songId}`;
  var cachedLyrics = getCache('lyric', cacheKey);
  if (cachedLyrics) {
    lyricsList = cachedLyrics;
    renderLyrics();
    updateDesktopLyrics(-1, lyricsList);
    return;
  }

  try {
    var res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=lyric&source=${source || 'netease'}&id=${songId}`);
    if (res.status === 429) {
      triggerError("获取歌词被限流");
      lyricsList = [];
      renderLyrics();
      updateDesktopLyrics(-1, lyricsList);
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP status: ${res.status}`);
    }
    var data = await res.json();
    if (data && data.lyric) {
      var original = parseLRC(data.lyric);
      
      // Parse translation if exists
      var tlyricText = '';
      if (data.tlyric) {
        if (typeof data.tlyric === 'string') {
          tlyricText = data.tlyric;
        } else if (typeof data.tlyric === 'object' && data.tlyric.lyric) {
          tlyricText = data.tlyric.lyric;
        }
      }
      
      if (tlyricText) {
        var translated = parseLRC(tlyricText);
        // Merge translated lyrics into original lyrics by closest timestamp matching
        original.forEach(line => {
          var match = null;
          var minDiff = 0.5; // 500ms tolerance
          translated.forEach(tLine => {
            var diff = Math.abs(line.time - tLine.time);
            if (diff < minDiff) {
              minDiff = diff;
              match = tLine;
            }
          });
          if (match && match.text.trim()) {
            line.translation = match.text.trim();
          } else {
            line.translation = '';
          }
        });
      }
      
      lyricsList = original;
      setCache('lyric', cacheKey, lyricsList);
      renderLyrics();
      updateDesktopLyrics(-1, lyricsList);
    } else {
      lyricsList = [];
      setCache('lyric', cacheKey, lyricsList);
      renderLyrics();
      updateDesktopLyrics(-1, lyricsList);
    }
  } catch (e) {
    console.warn("[FIRE] Failed to load lyrics:", e);
    triggerError("获取歌词失败: " + e.message);
    lyricsList = [];
    renderLyrics();
    updateDesktopLyrics(-1, lyricsList);
  }
}

function parseLRC(lrcText) {
  var list = [];
  if (!lrcText) return list;
  var lines = lrcText.split('\n');
  var timeReg = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    var matches = [];
    timeReg.lastIndex = 0;
    
    var text = line.replace(timeReg, function (m) {
      matches.push(m);
      return '';
    }).trim();

    for (var j = 0; j < matches.length; j++) {
      var timeStr = matches[j];
      var timeParts = /\[(\d+):(\d+)(?:\.(\d+))?\]/.exec(timeStr);
      if (timeParts) {
        var minutes = parseInt(timeParts[1], 10);
        var seconds = parseInt(timeParts[2], 10);
        var ms = timeParts[3] ? parseInt(timeParts[3], 10) : 0;
        if (timeParts[3] && timeParts[3].length === 2) ms *= 10;
        var totalSeconds = minutes * 60 + seconds + ms / 1000;
        list.push({ time: totalSeconds, text: text || '...' });
      }
    }
  }

  // Sort by timeline
  list.sort((a, b) => a.time - b.time);
  return list;
}

function togglePlayPause() {
  if (!audio || !state.currentSong) {
    var list = state.playlists[state.currentPlaylist] || [];
    if (list.length > 0) {
      playSong(list[0]);
    } else {
      showToast("请先在搜索栏中搜歌并添加");
    }
    return;
  }
  if (state.isPlaying) {
    audio.pause();
  } else {
    audio.play().catch(e => console.error(e));
  }
}

function handleSongEnded() {
  if (state.loopMode === 'single') {
    if (audio) {
      audio.currentTime = 0;
      audio.play().catch(e => console.error(e));
    }
  } else {
    playNext();
  }
}

function playNext() {
  var list = state.activeQueue || state.playlists[state.currentPlaylist] || [];
  if (list.length === 0) return;

  var nextIdx = 0;
  if (state.loopMode === 'shuffle') {
    nextIdx = Math.floor(Math.random() * list.length);
  } else {
    var currIdx = findCurrentSongIndex();
    if (currIdx !== -1 && currIdx < list.length - 1) {
      nextIdx = currIdx + 1;
    } else {
      nextIdx = 0; // Loop back
    }
  }

  playSong(list[nextIdx]);
}

function playPrev() {
  var list = state.activeQueue || state.playlists[state.currentPlaylist] || [];
  if (list.length === 0) return;

  var prevIdx = list.length - 1;
  if (state.loopMode === 'shuffle') {
    prevIdx = Math.floor(Math.random() * list.length);
  } else {
    var currIdx = findCurrentSongIndex();
    if (currIdx !== -1 && currIdx > 0) {
      prevIdx = currIdx - 1;
    } else {
      prevIdx = list.length - 1; // Loop back to end
    }
  }

  playSong(list[prevIdx]);
}

function findCurrentSongIndex() {
  if (!state.currentSong) return -1;
  var list = state.activeQueue || state.playlists[state.currentPlaylist] || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === state.currentSong.id) {
      return i;
    }
  }
  return -1;
}

// ─── Search API Query ────────────────────────────────────────────────────────
async function fetchWithRetry(url, options = {}, retries = 3, delay = 500) {
  for (var i = 0; i < retries; i++) {
    try {
      var res = await fetch(url, options);
      if (res.status === 429) {
        throw new Error("429");
      }
      if (!res.ok) {
        throw new Error(`HTTP status: ${res.status}`);
      }
      var data = await res.json();
      return data;
    } catch (err) {
      if (err.message === "429") {
        throw err; // Fail immediately on 429
      }
      if (i === retries - 1) {
        throw err;
      }
      console.warn(`[FIRE] Fetch failed (attempt ${i + 1}/${retries}). Retrying in ${delay}ms...`, err);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function performSearch(query, page) {
  if (!query) return;
  currentSearchQuery = query;
  currentSearchPage = page;
  lastSearchQueryState = null;

  var doc = getDoc();
  var container = doc.getElementById('fire-search-results');
  var pagination = doc.getElementById('fire-search-pagination');

  var sources = state.settings.searchSources || ['netease', 'joox', 'bilibili'];
  var cacheKey = `${query}_page_${page}_sources_${sources.join('_')}`;
  
  // Try Cache
  var cachedResult = getCache('search', cacheKey);
  if (cachedResult) {
    currentSearchSongs = cachedResult;
    renderSearchResults();
    return;
  }

  if (container) {
    container.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.6;"><i class="fa-solid fa-spinner fa-spin"></i> 正在全网搜索中...</div>';
  }
  if (pagination) pagination.style.display = 'none';

  try {
    var rateLimitHit = false;
    var failedSources = [];

    var promises = sources.map(source => 
      fetchWithRetry(`https://music-api.gdstudio.xyz/api.php?types=search&source=${source}&name=${encodeURIComponent(query)}&count=10&pages=${page}`, {}, 3, 500)
        .then(data => {
          if (!Array.isArray(data)) return [];
          return data.map(song => {
            song.source = source;
            return song;
          });
        })
        .catch(err => {
          if (err.message === "429") {
            rateLimitHit = true;
          } else {
            failedSources.push(source);
          }
          console.warn(`[FIRE] Search source ${source} failed:`, err);
          return [];
        })
    );

    var results = await Promise.all(promises);

    if (rateLimitHit) {
      triggerError("搜索请求被限流（5分钟内超50次），请稍后再试");
      if (container) {
        container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--fire-em);">搜索限制：5分钟内请求超50次限制，请稍候</div>';
      }
      return;
    }

    if (failedSources.length > 0) {
      triggerError(`部分音源搜索失败: ${failedSources.join(', ')}`);
    }

    var merged = [];
    var maxLength = Math.max(...results.map(r => r.length));
    for (var i = 0; i < maxLength; i++) {
      for (var j = 0; j < results.length; j++) {
        if (results[j][i]) {
          merged.push(results[j][i]);
        }
      }
    }

    // Cache successful search results (TTL: 10 minutes)
    setCache('search', cacheKey, merged, 10 * 60 * 1000);

    currentSearchSongs = merged;
    renderSearchResults();
  } catch (err) {
    console.error("[FIRE] Search failed:", err);
    triggerError("搜索出错: " + err.message);
    if (container) {
      container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--fire-em);">搜索发生异常，请重试</div>';
    }
  }
}

// ─── UI Rendering & Bindings ──────────────────────────────────────────────────
function createUI() {
  var p = getWin();
  var doc = p.document;

  // Tear down existing elements if any (supports hot reload)
  ['fire-overlay', 'fire-panel', 'fire-toast-element'].forEach(id => {
    var el = doc.getElementById(id);
    if (el) el.remove();
  });

  // Overlay
  var overlay = doc.createElement('div');
  overlay.id = 'fire-overlay';
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) togglePanel(e);
  });
  doc.body.appendChild(overlay);

  // Main Panel Shell
  var panel = doc.createElement('div');
  panel.id = 'fire-panel';
  
  // Follow SillyTavern's color variable with 100% opacity backdrop layer
  panel.innerHTML = `
    <div class="fire-header">
      <div class="fire-header-title">
        <i class="fa-solid fa-music"></i>
      </div>
      <div class="fire-header-actions">
        <div id="fire-settings-toggle" class="fire-header-btn" title="显示模式设置">
          <i class="fa-solid fa-gear"></i>
        </div>
        <div id="fire-close-btn" class="fire-header-btn" title="关闭">
          ✕
        </div>
      </div>
    </div>
    
    <div class="fire-settings-dropdown" id="fire-settings-dropdown">
      <!-- Section 1: Display Mode -->
      <div class="fire-settings-section">
        <div class="fire-settings-section-header" id="fire-settings-header-display">
          <span>显示模式</span>
          <i class="fa-solid fa-chevron-right fire-settings-chevron"></i>
        </div>
        <div class="fire-settings-section-content" id="fire-settings-content-display" style="display: none;">
          <label class="fire-settings-item">
            <input type="radio" name="fire-display-mode" value="wand-modal">
            <span>魔法棒 (普通弹窗)</span>
          </label>
          <label class="fire-settings-item">
            <input type="radio" name="fire-display-mode" value="wand-fullscreen">
            <span>魔法棒 (全屏模式)</span>
          </label>
          <label class="fire-settings-item">
            <input type="radio" name="fire-display-mode" value="qr-bar">
            <span>QR 栏 (普通弹窗)</span>
          </label>
          <label class="fire-settings-item">
            <input type="radio" name="fire-display-mode" value="qr-top">
            <span>QR 栏 (顶部滑出)</span>
          </label>
          <label class="fire-settings-item">
            <input type="radio" name="fire-display-mode" value="qr-bottom">
            <span>QR 栏 (底部滑出)</span>
          </label>
          <label class="fire-settings-item">
            <input type="radio" name="fire-display-mode" value="qr-left">
            <span>QR 栏 (左侧滑出)</span>
          </label>
          <label class="fire-settings-item">
            <input type="radio" name="fire-display-mode" value="qr-right">
            <span>QR 栏 (右侧滑出)</span>
          </label>
        </div>
      </div>
      
      <!-- Section 2: Audio Quality -->
      <div class="fire-settings-section" style="margin-top: 8px; border-top: 1px solid var(--fire-border); padding-top: 8px;">
        <div class="fire-settings-section-header" id="fire-settings-header-quality">
          <span>播放音质</span>
          <i class="fa-solid fa-chevron-right fire-settings-chevron"></i>
        </div>
        <div class="fire-settings-section-content" id="fire-settings-content-quality" style="display: none;">
          <label class="fire-settings-item">
            <input type="radio" name="fire-audio-quality" value="128">
            <span>流畅 (128kbps)</span>
          </label>
          <label class="fire-settings-item">
            <input type="radio" name="fire-audio-quality" value="320">
            <span>极高 (320kbps)</span>
          </label>
          <label class="fire-settings-item">
            <input type="radio" name="fire-audio-quality" value="999">
            <span>无损 (Master/Lossless)</span>
          </label>
        </div>
      </div>
      
      <!-- Section 3: Desktop Lyrics -->
      <div class="fire-settings-section" style="margin-top: 8px; border-top: 1px solid var(--fire-border); padding-top: 8px;">
        <div class="fire-settings-section-header" id="fire-settings-header-lyrics">
          <span>桌面歌词</span>
          <i class="fa-solid fa-chevron-right fire-settings-chevron"></i>
        </div>
        <div class="fire-settings-section-content" id="fire-settings-content-lyrics" style="display: none;">
          <label class="fire-settings-item" style="justify-content: space-between;">
            <span>开启桌面歌词</span>
            <input type="checkbox" id="fire-setting-lyrics-enable">
          </label>
          <label class="fire-settings-item" style="justify-content: space-between;">
            <span>锁定歌词位置</span>
            <input type="checkbox" id="fire-setting-lyrics-lock">
          </label>
          <label class="fire-settings-item" style="justify-content: space-between;">
            <span>启用歌词播放控制</span>
            <input type="checkbox" id="fire-setting-lyrics-ctrl-enable">
          </label>
          <div id="fire-setting-lyrics-ctrl-sub-container" style="display: none; flex-direction: column; gap: 6px; margin-top: 4px;">
            <div class="fire-settings-sub-item" style="flex-direction: column; align-items: stretch; gap: 4px;">
              <span style="font-size: 11px;">控制方式</span>
              <select id="fire-setting-lyrics-ctrl-type" class="fire-select" style="padding: 4px 8px; font-size: 12px; height: 28px;">
                <option value="buttons">独立控制按钮</option>
                <option value="zones">区域触控 (左:上一首/中:播暂/右:下一首)</option>
              </select>
            </div>
            <div class="fire-settings-sub-item" style="flex-direction: column; align-items: stretch; gap: 4px;">
              <span style="font-size: 11px;">播放控制可用时机</span>
              <select id="fire-setting-lyrics-ctrl-policy" class="fire-select" style="padding: 4px 8px; font-size: 12px; height: 28px;">
                <option value="always">随时可用 (允许穿透点击)</option>
                <option value="unlocked">仅解锁状态下可用</option>
              </select>
            </div>
          </div>
          <div class="fire-settings-sub-item" style="flex-direction: column; align-items: stretch; gap: 4px;">
            <span style="font-size: 11px;">锁定切换触发方式</span>
            <select id="fire-setting-lyrics-togglemethod" class="fire-select" style="padding: 4px 8px; font-size: 12px; height: 28px;">
              <option value="none">仅设置菜单</option>
              <option value="rightclick_longpress">右键 (PC) / 长按 (手机)</option>
              <option value="rightclick_doubletap">右键 (PC) / 双击 (手机)</option>
            </select>
          </div>
          <div class="fire-settings-sub-item" style="flex-direction: column; align-items: stretch; gap: 4px; margin-top: 4px;">
            <span style="font-size: 11px;">歌词层级关系 (z-index)</span>
            <input type="number" id="fire-setting-lyrics-zindex" class="fire-input" style="padding: 4px 8px; font-size: 12px; height: 28px;" placeholder="默认 99999">
          </div>
          <div class="fire-settings-sub-item-slider" id="fire-setting-lyrics-longpress-container" style="display: none; margin-top: 6px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px;">
              <span>手机长按时间</span>
              <span id="fire-setting-lyrics-longpress-val">800ms</span>
            </div>
            <input type="range" id="fire-setting-lyrics-longpress" min="300" max="2000" step="50">
          </div>
          <div class="fire-settings-sub-item">
            <span>歌词颜色</span>
            <input type="color" id="fire-setting-lyrics-textcolor">
          </div>
          <div class="fire-settings-sub-item">
            <span>背景颜色</span>
            <input type="color" id="fire-setting-lyrics-bgcolor">
          </div>
          <div class="fire-settings-sub-item-slider">
            <div style="display: flex; justify-content: space-between; font-size: 11px;">
              <span>背景不透明度</span>
              <span id="fire-setting-lyrics-opacity-val">60%</span>
            </div>
            <input type="range" id="fire-setting-lyrics-bgopacity" min="0" max="100">
          </div>
          <div class="fire-settings-sub-item-slider" style="margin-top: 8px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px;">
              <span>歌词字号大小</span>
              <span id="fire-setting-lyrics-fontsize-val">16px</span>
            </div>
            <input type="range" id="fire-setting-lyrics-fontsize" min="12" max="32">
          </div>
          <div class="fire-settings-sub-item" style="justify-content: flex-end; margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 8px;">
            <button id="fire-setting-lyrics-resetpos" class="fire-btn fire-btn-normal" style="padding: 4px 10px; font-size: 11px; height: 26px;">重置歌词位置 (顶部居中)</button>
          </div>
        </div>
      </div>

      <!-- Section 4: Search Sources -->
      <div class="fire-settings-section" style="margin-top: 8px; border-top: 1px solid var(--fire-border); padding-top: 8px;">
        <div class="fire-settings-section-header" id="fire-settings-header-sources">
          <span>搜索音源</span>
          <i class="fa-solid fa-chevron-right fire-settings-chevron"></i>
        </div>
        <div class="fire-settings-section-content" id="fire-settings-content-sources" style="display: none; padding-top: 4px;">
          <label class="fire-settings-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer;">
            <input type="checkbox" name="fire-search-source" value="netease">
            <span>网易云音乐 (稳定)</span>
          </label>
          <label class="fire-settings-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer;">
            <input type="checkbox" name="fire-search-source" value="joox">
            <span>JOOX (稳定)</span>
          </label>
          <label class="fire-settings-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer;">
            <input type="checkbox" name="fire-search-source" value="bilibili">
            <span>Bilibili (稳定)</span>
          </label>
          <label class="fire-settings-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer;">
            <input type="checkbox" name="fire-search-source" value="tencent">
            <span>QQ 音乐 (部分关闭)</span>
          </label>
          <label class="fire-settings-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer;">
            <input type="checkbox" name="fire-search-source" value="kuwo">
            <span>酷我音乐 (部分关闭)</span>
          </label>
        </div>
      </div>

      <!-- Section 5: Logs & Alerts -->
      <div class="fire-settings-section" style="margin-top: 8px; border-top: 1px solid var(--fire-border); padding-top: 8px;">
        <div class="fire-settings-section-header" id="fire-settings-header-logs">
          <span>通知与日志</span>
          <i class="fa-solid fa-chevron-right fire-settings-chevron"></i>
        </div>
        <div class="fire-settings-section-content" id="fire-settings-content-logs" style="display: none; padding-top: 4px;">
          <label class="fire-settings-item" style="display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 13px; cursor: pointer;">
            <span>启用错误弹窗提示</span>
            <input type="checkbox" id="fire-setting-show-error-toasts">
          </label>
          <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; opacity: 0.8;">
              <span>运行日志 (最近10条)</span>
              <span id="fire-clear-logs-btn" style="cursor: pointer; color: var(--fire-accent);" title="清除日志">清除</span>
            </div>
            <div id="fire-logs-container" class="fire-scroll" style="background: rgba(0,0,0,0.3); border: 1px solid var(--fire-border); border-radius: 4px; padding: 6px; font-family: monospace; font-size: 11px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;">
              暂无运行日志
            </div>
          </div>
        </div>
      </div>

      <!-- Section 6: Playlist Manager -->
      <div class="fire-settings-section" style="margin-top: 8px; border-top: 1px solid var(--fire-border); padding-top: 8px;">
        <div class="fire-settings-section-header" id="fire-settings-header-playlistmgr">
          <span>歌单导入与备份</span>
          <i class="fa-solid fa-chevron-right fire-settings-chevron"></i>
        </div>
        <div class="fire-settings-section-content" id="fire-settings-content-playlistmgr" style="display: none; padding-top: 6px;">
          <!-- Part 1: NetEase Playlist Import -->
          <div style="margin-bottom: 12px; display: flex; flex-direction: column; gap: 6px;">
            <span style="font-size: 11px; opacity: 0.8;">导入网易云歌单 (链接/ID)</span>
            <div style="display: flex; gap: 6px;">
              <input type="text" id="fire-import-netease-input" class="fire-input" style="height: 28px; padding: 4px 8px; font-size: 12px; min-width: 0; width: 100%;" placeholder="输入歌单ID或分享链接...">
              <button id="fire-import-netease-btn" class="fire-btn" style="padding: 4px 10px; font-size: 11px; height: 28px; flex-shrink: 0;">导入</button>
            </div>
          </div>
          
          <!-- Part 2: Playlist Backup & Restore -->
          <div style="border-top: 1px solid rgba(255,255,255,0.05); padding-top: 8px; display: flex; flex-direction: column; gap: 6px;">
            <span style="font-size: 11px; opacity: 0.8;">本地歌单备份与恢复</span>
            <div style="display: flex; gap: 8px;">
              <button id="fire-export-backup-btn" class="fire-btn fire-btn-normal" style="flex: 1; padding: 4px; font-size: 11px; height: 28px;" title="备份并导出本地歌单">备份歌单</button>
              <button id="fire-import-backup-btn" class="fire-btn fire-btn-normal" style="flex: 1; padding: 4px; font-size: 11px; height: 28px;" title="从JSON备份中恢复歌单">恢复歌单</button>
            </div>
            <input type="file" id="fire-import-backup-file" style="display: none;" accept=".json">
          </div>
        </div>
      </div>
    </div>

    <div id="fire-panel-body">
      <!-- Tabs Header (shared across all columns) -->
      <div class="fire-tabs-header" id="fire-tabs-header">
        <button id="fire-tab-btn-nowplaying" class="fire-tab-btn" title="正在播放">
          <i class="fa-solid fa-compact-disc"></i>
        </button>
        <button id="fire-tab-btn-search" class="fire-tab-btn active" title="搜索歌曲">
          <i class="fa-solid fa-magnifying-glass"></i>
        </button>
        <button id="fire-tab-btn-playlists" class="fire-tab-btn" title="我的歌单">
          <i class="fa-solid fa-list-ul"></i>
        </button>
      </div>

      <!-- Player Column -->
      <div class="fire-player-column" id="fire-player-column">
        <!-- Flip Card Wrapper -->
        <div class="fire-card-flip" id="fire-card-flip">
          <div class="fire-card-inner" id="fire-card-inner">
            <!-- Front Face: Spinning CD -->
            <div class="fire-card-front" id="fire-card-front">
              <div class="fire-cd-wrapper" id="fire-cd-wrapper">
                <img id="fire-cd-cover" class="fire-cd-cover" src="" alt="Album Art">
                <div class="fire-cd-center"></div>
              </div>
            </div>
            <!-- Back Face: Lyrics -->
            <div class="fire-card-back" id="fire-card-back">
              <button id="fire-btn-flip-back" class="fire-flip-back-btn" title="查看唱片">
                <i class="fa-solid fa-compact-disc"></i>
              </button>
              <div class="fire-lyrics-container fire-scroll" id="fire-lyrics-container">
                <div class="fire-lyrics-scroller" id="fire-lyrics-scroller">
                  <div class="fire-lyric-line active">暂无播放歌曲</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Bottom Controls -->
        <div class="fire-meta-container">
          <div id="fire-song-title" class="fire-song-title">无正在播放歌曲</div>
          <div id="fire-song-artist" class="fire-song-artist">请选择歌曲播放</div>
        </div>
        
        <div class="fire-progress-container">
          <span id="fire-time-current">00:00</span>
          <input type="range" id="fire-progress-slider" class="fire-progress-slider" min="0" max="100" value="0">
          <span id="fire-time-duration">00:00</span>
        </div>
        
        <div class="fire-controls">
          <button id="fire-btn-loop" class="fire-btn-ctrl" title="循环模式">
            <i class="fa-solid fa-repeat"></i>
          </button>
          <button id="fire-btn-prev" class="fire-btn-ctrl" title="上一首">
            <i class="fa-solid fa-backward-step"></i>
          </button>
          <button id="fire-btn-play" class="fire-btn-ctrl fire-btn-play" title="播放/暂停">
            <i class="fa-solid fa-play"></i>
          </button>
          <button id="fire-btn-next" class="fire-btn-ctrl" title="下一首">
            <i class="fa-solid fa-forward-step"></i>
          </button>
          <button id="fire-btn-volume-mute" class="fire-btn-ctrl" title="静音">
            <i class="fa-solid fa-volume-high"></i>
          </button>
        </div>
        
        <div class="fire-volume-container">
          <i class="fa-solid fa-volume-low fire-volume-icon" id="fire-volume-icon"></i>
          <input type="range" id="fire-volume-slider" class="fire-volume-slider" min="0" max="100" value="50">
        </div>
      </div>
      
      <!-- Right Side Tab Lists -->
      <div class="fire-tabs-column" id="fire-tabs-column">
        <div class="fire-tab-panels">
          <!-- Search Tab -->
          <div id="fire-tab-panel-search" class="fire-tab-panel active">
            <form id="fire-search-form" class="fire-search-form" onsubmit="return false;">
              <input type="text" id="fire-search-input" class="fire-input" placeholder="输入歌名或歌手搜索...">
              <button type="submit" id="fire-search-btn" class="fire-btn">搜索</button>
            </form>
            <div class="fire-music-list fire-scroll" id="fire-search-results">
              <div style="text-align:center;padding:4px;opacity:0.5;font-size:12px;margin-top:20px;">
                在上方输入关键词搜索歌曲
              </div>
            </div>
            <div class="fire-pagination" id="fire-search-pagination" style="display:none;">
              <button id="fire-btn-page-prev" class="fire-btn fire-btn-normal" style="padding:4px 10px;">上一页</button>
              <span id="fire-page-num">第 1 页</span>
              <button id="fire-btn-page-next" class="fire-btn fire-btn-normal" style="padding:4px 10px;">下一页</button>
            </div>
          </div>
          
          <!-- Playlist Tab -->
          <div id="fire-tab-panel-playlists" class="fire-tab-panel">
            <div class="fire-playlist-selector-bar">
              <select id="fire-playlist-select" class="fire-select"></select>
              <button id="fire-btn-playlist-new" class="fire-btn" style="padding: 8px 10px;" title="新建歌单">
                <i class="fa-solid fa-plus"></i>
              </button>
              <button id="fire-btn-playlist-rename" class="fire-btn fire-btn-normal" style="padding: 8px 10px;" title="重命名当前歌单">
                <i class="fa-solid fa-pen-to-square"></i>
              </button>
              <button id="fire-btn-playlist-delete" class="fire-btn fire-btn-normal" style="padding: 8px 10px;" title="删除当前歌单">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
            <div class="fire-music-list fire-scroll" id="fire-playlist-songs">
              <div style="text-align:center;padding:4px;opacity:0.5;font-size:12px;margin-top:20px;">
                歌单中暂无歌曲，去搜索并添加吧！
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Quick Dropdown Menu for Playlist selection -->
    <div id="fire-add-menu" class="fire-add-menu"></div>
  `;
  doc.body.appendChild(panel);

  // Toast Container
  var toastEl = doc.createElement('div');
  toastEl.id = 'fire-toast-element';
  toastEl.className = 'fire-toast';
  doc.body.appendChild(toastEl);

  // Set initial settings state in DOM
  updateVolumeUI();
  updateLoopModeUI();
  bindUIEvents();
  updateTabUI();
  setViewMode(state.viewMode || 'cd');
  renderPlaylistOptions();
  renderPlaylistSongs();
  
  // Set default settings selection in dropdown
  var displayRadios = doc.querySelectorAll('input[name="fire-display-mode"]');
  displayRadios.forEach(radio => {
    if (radio.value === state.settings.displayMode) {
      radio.checked = true;
    }
  });

  // Set default audio quality selection
  if (!state.settings.audioQuality) {
    state.settings.audioQuality = '999';
  }
  var qualityRadios = doc.querySelectorAll('input[name="fire-audio-quality"]');
  qualityRadios.forEach(radio => {
    if (radio.value === state.settings.audioQuality) {
      radio.checked = true;
    }
  });

  // Set default desktop lyrics selection
  var chkEnable = doc.getElementById('fire-setting-lyrics-enable');
  if (chkEnable) chkEnable.checked = !!state.settings.desktopLyricsEnabled;

  var chkLock = doc.getElementById('fire-setting-lyrics-lock');
  if (chkLock) chkLock.checked = !!state.settings.desktopLyricsLocked;

  var chkCtrlEnable = doc.getElementById('fire-setting-lyrics-ctrl-enable');
  if (chkCtrlEnable) chkCtrlEnable.checked = !!state.settings.desktopLyricsControlsEnabled;

  var selectCtrlType = doc.getElementById('fire-setting-lyrics-ctrl-type');
  if (selectCtrlType) selectCtrlType.value = state.settings.desktopLyricsControlsType || 'buttons';

  var selectCtrlPolicy = doc.getElementById('fire-setting-lyrics-ctrl-policy');
  if (selectCtrlPolicy) selectCtrlPolicy.value = state.settings.desktopLyricsControlsPolicy || 'always';

  var ctrlSubContainer = doc.getElementById('fire-setting-lyrics-ctrl-sub-container');
  if (ctrlSubContainer) {
    ctrlSubContainer.style.display = state.settings.desktopLyricsControlsEnabled ? 'flex' : 'none';
  }

  var inputTextColor = doc.getElementById('fire-setting-lyrics-textcolor');
  if (inputTextColor) inputTextColor.value = state.settings.desktopLyricsTextColor || '#ffffff';

  var inputBgColor = doc.getElementById('fire-setting-lyrics-bgcolor');
  if (inputBgColor) inputBgColor.value = state.settings.desktopLyricsBgColor || '#080d14';

  var inputBgOpacity = doc.getElementById('fire-setting-lyrics-bgopacity');
  var valOpacity = doc.getElementById('fire-setting-lyrics-opacity-val');
  var initialOpacity = state.settings.desktopLyricsBgOpacity !== undefined ? state.settings.desktopLyricsBgOpacity : 60;
  if (inputBgOpacity) inputBgOpacity.value = initialOpacity;
  if (valOpacity) valOpacity.textContent = initialOpacity + '%';

  var inputFontSize = doc.getElementById('fire-setting-lyrics-fontsize');
  var valFontSize = doc.getElementById('fire-setting-lyrics-fontsize-val');
  var initialFontSize = state.settings.desktopLyricsFontSize !== undefined ? state.settings.desktopLyricsFontSize : 16;
  if (inputFontSize) inputFontSize.value = initialFontSize;
  if (valFontSize) valFontSize.textContent = initialFontSize + 'px';

  var inputToggleMethod = doc.getElementById('fire-setting-lyrics-togglemethod');
  if (inputToggleMethod) inputToggleMethod.value = state.settings.desktopLyricsToggleMethod || 'none';

  var inputLongPress = doc.getElementById('fire-setting-lyrics-longpress');
  var valLongPress = doc.getElementById('fire-setting-lyrics-longpress-val');
  var initialLongPress = state.settings.desktopLyricsLongPressTime || 800;
  if (inputLongPress) inputLongPress.value = initialLongPress;
  if (valLongPress) valLongPress.textContent = initialLongPress + 'ms';

  var longPressContainer = doc.getElementById('fire-setting-lyrics-longpress-container');
  if (longPressContainer) {
    longPressContainer.style.display = (state.settings.desktopLyricsToggleMethod === 'rightclick_longpress') ? 'block' : 'none';
  }

  var inputZIndex = doc.getElementById('fire-setting-lyrics-zindex');
  if (inputZIndex) inputZIndex.value = state.settings.desktopLyricsZIndex !== undefined ? state.settings.desktopLyricsZIndex : 99999;

  // Set default search sources checkboxes
  if (!state.settings.searchSources) {
    state.settings.searchSources = ['netease', 'joox', 'bilibili'];
  }
  var sourceChks = doc.querySelectorAll('input[name="fire-search-source"]');
  sourceChks.forEach(chk => {
    chk.checked = state.settings.searchSources.indexOf(chk.value) !== -1;
  });

  // Set default show error toasts checkbox
  var chkShowError = doc.getElementById('fire-setting-show-error-toasts');
  if (chkShowError) {
    chkShowError.checked = !!state.settings.showErrorToasts;
  }

  // Initial logs rendering
  renderLogsUI();

  // Ensure widget is generated and synchronized
  ensureDesktopLyrics(lyricsList, lastActiveLineIdx);
  syncLyricsCtrlPolicyDropdown();
}

function syncLyricsCtrlPolicyDropdown() {
  var doc = getDoc();
  var selectPolicy = doc.getElementById('fire-setting-lyrics-ctrl-policy');
  if (!selectPolicy) return;
  
  var optAlways = selectPolicy.querySelector('option[value="always"]');
  if (!optAlways) return;
  
  var isLocked = !!state.settings.desktopLyricsLocked;
  var ctrlType = state.settings.desktopLyricsControlsType || 'buttons';
  
  if (isLocked && ctrlType === 'buttons') {
    optAlways.disabled = true;
    if (state.settings.desktopLyricsControlsPolicy === 'always') {
      state.settings.desktopLyricsControlsPolicy = 'unlocked';
      selectPolicy.value = 'unlocked';
      saveState();
      applyDesktopLyricsSettings();
    }
  } else {
    optAlways.disabled = false;
  }
}

function bindUIEvents() {
  var doc = getDoc();

  // Close Button
  var closeBtn = doc.getElementById('fire-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', togglePanel);

  // Settings Gear Dropdown Toggle
  var settingsBtn = doc.getElementById('fire-settings-toggle');
  var settingsDropdown = doc.getElementById('fire-settings-dropdown');
  if (settingsBtn && settingsDropdown) {
    settingsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var show = settingsDropdown.style.display === 'block';
      settingsDropdown.style.display = show ? 'none' : 'block';
    });
    
    // Hide dropdown when clicking elsewhere
    doc.addEventListener('click', function () {
      settingsDropdown.style.display = 'none';
    });
    settingsDropdown.addEventListener('click', function(e) {
      e.stopPropagation();
    });

    // Collapsible Settings Sections
    var setupCollapsibleSetting = function (headerId, contentId) {
      var header = doc.getElementById(headerId);
      var content = doc.getElementById(contentId);
      if (header && content) {
        header.addEventListener('click', function (e) {
          e.stopPropagation();
          var isHidden = content.style.display === 'none';
          content.style.display = isHidden ? 'block' : 'none';
          var chevron = header.querySelector('.fire-settings-chevron');
          if (chevron) {
            if (isHidden) {
              chevron.style.transform = 'rotate(90deg)';
            } else {
              chevron.style.transform = 'rotate(0deg)';
            }
          }
        });
      }
    };
    setupCollapsibleSetting('fire-settings-header-display', 'fire-settings-content-display');
    setupCollapsibleSetting('fire-settings-header-quality', 'fire-settings-content-quality');
    setupCollapsibleSetting('fire-settings-header-lyrics', 'fire-settings-content-lyrics');
    setupCollapsibleSetting('fire-settings-header-sources', 'fire-settings-content-sources');
    setupCollapsibleSetting('fire-settings-header-logs', 'fire-settings-content-logs');
    setupCollapsibleSetting('fire-settings-header-playlistmgr', 'fire-settings-content-playlistmgr');
  }

  // Playlist Manager - NetEase Import Event
  var importNeteaseBtn = doc.getElementById('fire-import-netease-btn');
  if (importNeteaseBtn) {
    importNeteaseBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var input = doc.getElementById('fire-import-netease-input');
      if (input) {
        var val = input.value.trim();
        if (val) {
          importNetEasePlaylist(val);
          input.value = '';
        } else {
          showToast("请输入网易云歌单ID或链接");
        }
      }
    });
  }

  // Playlist Manager - Export Backup Event
  var exportBackupBtn = doc.getElementById('fire-export-backup-btn');
  if (exportBackupBtn) {
    exportBackupBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      exportPlaylistsBackup();
    });
  }

  // Playlist Manager - Import Backup File Upload trigger
  var importBackupBtn = doc.getElementById('fire-import-backup-btn');
  var importBackupFile = doc.getElementById('fire-import-backup-file');
  if (importBackupBtn && importBackupFile) {
    importBackupBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      importBackupFile.click();
    });
    importBackupFile.addEventListener('change', function (e) {
      importPlaylistsBackup(e);
    });
  }

  // Search Sources Checkboxes Events
  var sourceChks = doc.querySelectorAll('input[name="fire-search-source"]');
  sourceChks.forEach(chk => {
    chk.addEventListener('change', function () {
      var activeSources = [];
      sourceChks.forEach(c => {
        if (c.checked) activeSources.push(c.value);
      });
      // Ensure at least one source is checked
      if (activeSources.length === 0) {
        showToast("请至少选择一个音源！");
        this.checked = true;
        return;
      }
      state.settings.searchSources = activeSources;
      saveState();
    });
  });

  // Show Error Toasts Checkbox Event
  var chkShowError = doc.getElementById('fire-setting-show-error-toasts');
  if (chkShowError) {
    chkShowError.addEventListener('change', function () {
      state.settings.showErrorToasts = !!this.checked;
      saveState();
    });
  }

  // Clear Logs Button Event
  var clearLogsBtn = doc.getElementById('fire-clear-logs-btn');
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      errorLogs = [];
      renderLogsUI();
    });
  }

  // Display Mode Radios
  var displayRadios = doc.querySelectorAll('input[name="fire-display-mode"]');
  displayRadios.forEach(radio => {
    radio.addEventListener('change', function () {
      state.settings.displayMode = this.value;
      saveState();
      applyDisplayMode();
      showToast("显示模式已更改");
    });
  });

  // Audio Quality Radios
  var qualityRadios = doc.querySelectorAll('input[name="fire-audio-quality"]');
  qualityRadios.forEach(radio => {
    radio.addEventListener('change', function () {
      state.settings.audioQuality = this.value;
      saveState();
    });
  });

  // Desktop Lyrics Settings Binding
  // Enable Switch
  var chkEnable = doc.getElementById('fire-setting-lyrics-enable');
  if (chkEnable) {
    chkEnable.addEventListener('change', function () {
      state.settings.desktopLyricsEnabled = !!this.checked;
      saveState();
      ensureDesktopLyrics(lyricsList, lastActiveLineIdx);
    });
  }

  // Lock Switch
  var chkLock = doc.getElementById('fire-setting-lyrics-lock');
  if (chkLock) {
    chkLock.addEventListener('change', function () {
      state.settings.desktopLyricsLocked = !!this.checked;
      saveState();
      applyDesktopLyricsSettings();
      syncLyricsCtrlPolicyDropdown();
      ensureDesktopLyrics(lyricsList, lastActiveLineIdx);
    });
  }

  // Control Buttons Switch
  var chkCtrlEnable = doc.getElementById('fire-setting-lyrics-ctrl-enable');
  var ctrlSubContainer = doc.getElementById('fire-setting-lyrics-ctrl-sub-container');
  if (chkCtrlEnable) {
    chkCtrlEnable.addEventListener('change', function () {
      state.settings.desktopLyricsControlsEnabled = !!this.checked;
      if (ctrlSubContainer) {
        ctrlSubContainer.style.display = this.checked ? 'flex' : 'none';
      }
      saveState();
      applyDesktopLyricsSettings();
      syncLyricsCtrlPolicyDropdown();
      ensureDesktopLyrics(lyricsList, lastActiveLineIdx);
    });
  }

  // Control Buttons Type Dropdown
  var selectCtrlType = doc.getElementById('fire-setting-lyrics-ctrl-type');
  if (selectCtrlType) {
    selectCtrlType.addEventListener('change', function () {
      state.settings.desktopLyricsControlsType = this.value;
      saveState();
      syncLyricsCtrlPolicyDropdown();
      ensureDesktopLyrics(lyricsList, lastActiveLineIdx);
    });
  }

  // Control Buttons Policy Dropdown
  var selectCtrlPolicy = doc.getElementById('fire-setting-lyrics-ctrl-policy');
  if (selectCtrlPolicy) {
    selectCtrlPolicy.addEventListener('change', function () {
      state.settings.desktopLyricsControlsPolicy = this.value;
      saveState();
      applyDesktopLyricsSettings();
    });
  }

  // Toggle Trigger Method
  var inputToggleMethod = doc.getElementById('fire-setting-lyrics-togglemethod');
  var longPressContainer = doc.getElementById('fire-setting-lyrics-longpress-container');
  if (inputToggleMethod) {
    inputToggleMethod.addEventListener('change', function () {
      state.settings.desktopLyricsToggleMethod = this.value;
      if (longPressContainer) {
        longPressContainer.style.display = (this.value === 'rightclick_longpress') ? 'block' : 'none';
      }
      saveState();
    });
  }

  // Long Press Duration Slider
  var inputLongPress = doc.getElementById('fire-setting-lyrics-longpress');
  var valLongPress = doc.getElementById('fire-setting-lyrics-longpress-val');
  if (inputLongPress) {
    inputLongPress.addEventListener('input', function () {
      var val = parseInt(this.value, 10);
      state.settings.desktopLyricsLongPressTime = val;
      if (valLongPress) valLongPress.textContent = val + 'ms';
      saveState();
    });
  }

  // Layer (z-index) Selection
  var inputZIndex = doc.getElementById('fire-setting-lyrics-zindex');
  if (inputZIndex) {
    inputZIndex.addEventListener('input', function () {
      var val = parseInt(this.value, 10);
      if (isNaN(val)) {
        val = 99999;
      }
      state.settings.desktopLyricsZIndex = val;
      saveState();
      applyDesktopLyricsSettings();
    });
  }

  // Text Color Picker
  var inputTextColor = doc.getElementById('fire-setting-lyrics-textcolor');
  if (inputTextColor) {
    inputTextColor.addEventListener('input', function () {
      state.settings.desktopLyricsTextColor = this.value;
      saveState();
      applyDesktopLyricsSettings();
    });
  }

  // Bg Color Picker
  var inputBgColor = doc.getElementById('fire-setting-lyrics-bgcolor');
  if (inputBgColor) {
    inputBgColor.addEventListener('input', function () {
      state.settings.desktopLyricsBgColor = this.value;
      saveState();
      applyDesktopLyricsSettings();
    });
  }

  // Bg Opacity Slider
  var inputBgOpacity = doc.getElementById('fire-setting-lyrics-bgopacity');
  var valOpacity = doc.getElementById('fire-setting-lyrics-opacity-val');
  if (inputBgOpacity) {
    inputBgOpacity.addEventListener('input', function () {
      var val = parseInt(this.value, 10);
      state.settings.desktopLyricsBgOpacity = val;
      if (valOpacity) valOpacity.textContent = val + '%';
      saveState();
      applyDesktopLyricsSettings();
    });
  }

  // Font Size Slider
  var inputFontSize = doc.getElementById('fire-setting-lyrics-fontsize');
  var valFontSize = doc.getElementById('fire-setting-lyrics-fontsize-val');
  if (inputFontSize) {
    inputFontSize.addEventListener('input', function () {
      var val = parseInt(this.value, 10);
      state.settings.desktopLyricsFontSize = val;
      if (valFontSize) valFontSize.textContent = val + 'px';
      saveState();
      applyDesktopLyricsSettings();
    });
  }

  // Reset Position Button
  var btnResetPos = doc.getElementById('fire-setting-lyrics-resetpos');
  if (btnResetPos) {
    btnResetPos.addEventListener('click', function (e) {
      e.stopPropagation();
      state.settings.desktopLyricsLeft = '';
      state.settings.desktopLyricsTop = '';
      saveState();
      applyDesktopLyricsSettings();
      showToast("悬浮歌词位置已重置为顶部居中");
    });
  }

  // Play / Pause Button
  var playBtn = doc.getElementById('fire-btn-play');
  if (playBtn) {
    playBtn.addEventListener('click', togglePlayPause);
  }

  // Next / Prev Buttons
  var nextBtn = doc.getElementById('fire-btn-next');
  if (nextBtn) nextBtn.addEventListener('click', playNext);
  var prevBtn = doc.getElementById('fire-btn-prev');
  if (prevBtn) prevBtn.addEventListener('click', playPrev);

  // Loop Mode Button
  var loopBtn = doc.getElementById('fire-btn-loop');
  if (loopBtn) {
    loopBtn.addEventListener('click', function () {
      if (state.loopMode === 'list') {
        state.loopMode = 'single';
        showToast("单曲循环");
      } else if (state.loopMode === 'single') {
        state.loopMode = 'shuffle';
        showToast("随机播放");
      } else {
        state.loopMode = 'list';
        showToast("列表循环");
      }
      saveState();
      updateLoopModeUI();
    });
  }

  // Volume Slider & Mute Toggle
  var volumeSlider = doc.getElementById('fire-volume-slider');
  if (volumeSlider) {
    volumeSlider.addEventListener('input', function () {
      state.volume = parseFloat(this.value) / 100;
      if (audio) audio.volume = state.volume;
      saveState();
      updateVolumeUI();
    });
  }

  var muteBtn = doc.getElementById('fire-btn-volume-mute');
  var volumeIcon = doc.getElementById('fire-volume-icon');
  var muteHandler = function () {
    if (!audio) return;
    if (audio.volume > 0) {
      audio.volume = 0;
      showToast("已静音");
    } else {
      audio.volume = state.volume;
      showToast("恢复音量");
    }
    updateVolumeUI();
  };
  if (muteBtn) muteBtn.addEventListener('click', muteHandler);
  if (volumeIcon) volumeIcon.addEventListener('click', muteHandler);

  // Progress Seek Slider
  var progressSlider = doc.getElementById('fire-progress-slider');
  if (progressSlider) {
    progressSlider.addEventListener('input', function () {
      if (audio && audio.duration) {
        var newTime = (parseFloat(this.value) / 100) * audio.duration;
        audio.currentTime = newTime;
      }
    });
  }

  // Tabs Switches
  var tabNowPlaying = doc.getElementById('fire-tab-btn-nowplaying');
  var tabSearch = doc.getElementById('fire-tab-btn-search');
  var tabPlaylists = doc.getElementById('fire-tab-btn-playlists');

  if (tabNowPlaying) {
    tabNowPlaying.addEventListener('click', function () {
      switchTab('nowplaying');
    });
  }
  if (tabSearch) {
    tabSearch.addEventListener('click', function () {
      switchTab('search');
    });
  }
  if (tabPlaylists) {
    tabPlaylists.addEventListener('click', function () {
      switchTab('playlists');
    });
  }

  // Search Submit
  var searchForm = doc.getElementById('fire-search-form');
  var searchInput = doc.getElementById('fire-search-input');
  if (searchForm && searchInput) {
    var handleSearch = function () {
      var val = searchInput.value.trim();
      if (val) {
        performSearch(val, 1);
      } else {
        showToast("请输入歌曲或歌手名称");
      }
    };
    searchForm.addEventListener('submit', function (e) {
      e.preventDefault();
      handleSearch();
    });
  }

  // Search Pagination Buttons
  var pagePrev = doc.getElementById('fire-btn-page-prev');
  var pageNext = doc.getElementById('fire-btn-page-next');
  if (pagePrev) {
    pagePrev.addEventListener('click', function () {
      if (currentSearchPage > 1) {
        performSearch(currentSearchQuery, currentSearchPage - 1);
      }
    });
  }
  if (pageNext) {
    pageNext.addEventListener('click', function () {
      performSearch(currentSearchQuery, currentSearchPage + 1);
    });
  }

  // Playlists Select Dropdown Changed
  var playlistSelect = doc.getElementById('fire-playlist-select');
  if (playlistSelect) {
    playlistSelect.addEventListener('change', function () {
      state.currentPlaylist = this.value;
      saveState();
      renderPlaylistSongs();
    });
  }

  // Playlist Actions: New, Rename, Delete
  var btnNew = doc.getElementById('fire-btn-playlist-new');
  if (btnNew) {
    btnNew.addEventListener('click', function () {
      showPrompt("请输入新歌单名称：", "", "新建歌单").then(name => {
        if (!name) return;
        name = name.trim();
        if (state.playlists[name]) {
          showToast("该歌单已存在");
          return;
        }
        state.playlists[name] = [];
        state.currentPlaylist = name;
        saveState();
        renderPlaylistOptions();
        renderPlaylistSongs();
        showToast(`歌单 "${name}" 创建成功`);
      });
    });
  }

  var btnRename = doc.getElementById('fire-btn-playlist-rename');
  if (btnRename) {
    btnRename.addEventListener('click', function () {
      var oldName = state.currentPlaylist;
      if (oldName === "__active_queue__") return;
      showPrompt(`将歌单 "${oldName}" 重命名为：`, oldName, "重命名歌单").then(newName => {
        if (!newName) return;
        newName = newName.trim();
        if (newName === oldName) return;
        if (state.playlists[newName]) {
          showToast("同名歌单已存在");
          return;
        }
        state.playlists[newName] = state.playlists[oldName];
        delete state.playlists[oldName];
        state.currentPlaylist = newName;
        saveState();
        renderPlaylistOptions();
        renderPlaylistSongs();
        showToast("重命名成功");
      });
    });
  }

  var btnDelete = doc.getElementById('fire-btn-playlist-delete');
  if (btnDelete) {
    btnDelete.addEventListener('click', function () {
      var name = state.currentPlaylist;
      if (name === "__active_queue__") return;
      if (Object.keys(state.playlists).length <= 1) {
        return;
      }
      delete state.playlists[name];
      state.currentPlaylist = Object.keys(state.playlists)[0];
      saveState();
      renderPlaylistOptions();
      renderPlaylistSongs();
    });
  }

  // Dismiss dropdown menu when clicking anywhere on body
  doc.addEventListener('click', function () {
    var menu = doc.getElementById('fire-add-menu');
    if (menu) menu.style.display = 'none';
  });

  // Flip Card Toggles
  var cdWrapper = doc.getElementById('fire-cd-wrapper');
  if (cdWrapper) {
    cdWrapper.addEventListener('click', function () {
      setViewMode('lyrics');
    });
  }

  var btnFlipBack = doc.getElementById('fire-btn-flip-back');
  if (btnFlipBack) {
    btnFlipBack.addEventListener('click', function (e) {
      e.stopPropagation();
      setViewMode('cd');
    });
  }

  var cardBack = doc.getElementById('fire-card-back');
  if (cardBack) {
    cardBack.addEventListener('click', function (e) {
      // Only flip back if they clicked the container itself or the lyrics container spacing (not lyric lines)
      if (e.target === cardBack || e.target.classList.contains('fire-lyrics-container')) {
        setViewMode('cd');
      }
    });
  }
}

function setViewMode(mode) {
  state.viewMode = mode;
  try {
    localStorage.setItem('fire_view_mode', mode);
  } catch (e) {}

  var doc = getDoc();
  var cardInner = doc.getElementById('fire-card-inner');
  if (cardInner) {
    if (mode === 'lyrics') {
      cardInner.classList.add('flipped');
    } else {
      cardInner.classList.remove('flipped');
    }
  }
}

function switchTab(tabName) {
  activeTab = tabName;
  updateTabUI();
  if (tabName === 'playlists') {
    renderPlaylistOptions();
    renderPlaylistSongs();
  }
}

function updateTabUI() {
  var doc = getDoc();
  var tabNowPlaying = doc.getElementById('fire-tab-btn-nowplaying');
  var tabSearch = doc.getElementById('fire-tab-btn-search');
  var tabPlaylists = doc.getElementById('fire-tab-btn-playlists');
  
  var panelPlayer = doc.getElementById('fire-player-column');
  var panelTabs = doc.getElementById('fire-tabs-column');
  
  var panelSearch = doc.getElementById('fire-tab-panel-search');
  var panelPlaylists = doc.getElementById('fire-tab-panel-playlists');

  if (!tabNowPlaying || !tabSearch || !tabPlaylists) return;

  // Remove active class from all tabs
  [tabNowPlaying, tabSearch, tabPlaylists].forEach(t => t.classList.remove('active'));

  // Add active to current
  if (activeTab === 'nowplaying') {
    tabNowPlaying.classList.add('active');
  } else if (activeTab === 'search') {
    tabSearch.classList.add('active');
  } else if (activeTab === 'playlists') {
    tabPlaylists.classList.add('active');
  }

  var isMobile = (window.parent || window).innerWidth <= 760;

  if (isMobile) {
    if (activeTab === 'nowplaying') {
      if (panelPlayer) panelPlayer.style.setProperty('display', 'flex', 'important');
      if (panelTabs) panelTabs.style.setProperty('display', 'none', 'important');
    } else {
      if (panelPlayer) panelPlayer.style.setProperty('display', 'none', 'important');
      if (panelTabs) panelTabs.style.setProperty('display', 'flex', 'important');
      
      if (activeTab === 'search') {
        if (panelSearch) panelSearch.classList.add('active');
        if (panelPlaylists) panelPlaylists.classList.remove('active');
      } else {
        if (panelPlaylists) panelPlaylists.classList.add('active');
        if (panelSearch) panelSearch.classList.remove('active');
      }
    }
  } else {
    // Desktop: Player is always shown, tabs column is always shown
    if (panelPlayer) panelPlayer.style.removeProperty('display');
    if (panelTabs) panelTabs.style.removeProperty('display');

    if (activeTab === 'search') {
      if (panelSearch) panelSearch.classList.add('active');
      if (panelPlaylists) panelPlaylists.classList.remove('active');
    } else if (activeTab === 'playlists') {
      if (panelPlaylists) panelPlaylists.classList.add('active');
      if (panelSearch) panelSearch.classList.remove('active');
    }
  }
}

async function fetchAndSetCover(song) {
  var cd = getDoc().getElementById('fire-cd-cover');
  if (!cd) return;

  cd.onerror = function() {
    cd.src = DEFAULT_COVER;
  };

  // Shortcut if we already have the direct cover URL
  if (song.coverUrl) {
    cd.src = song.coverUrl;
    return;
  }

  var id = song.pic_id || song.id;
  if (!id) {
    cd.src = DEFAULT_COVER;
    return;
  }

  var cacheKey = `${song.source || 'netease'}_${id}_500`;
  var cachedCover = getCache('pic', cacheKey);
  if (cachedCover) {
    cd.src = cachedCover;
    return;
  }

  try {
    var res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=pic&source=${song.source || 'netease'}&id=${id}&size=500`);
    if (res.status === 429) {
      triggerError("加载专辑封面被限流");
      cd.src = DEFAULT_COVER;
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP status: ${res.status}`);
    }
    var data = await res.json();
    if (data && data.url) {
      var coverUrl = data.url;
      if (window.location.protocol === 'https:' && coverUrl.startsWith('http://')) {
        coverUrl = coverUrl.replace('http://', 'https://');
      }
      cd.src = coverUrl;
      setCache('pic', cacheKey, coverUrl);
    } else {
      cd.src = DEFAULT_COVER;
    }
  } catch (e) {
    console.warn("[FIRE] Failed to fetch cover:", e);
    triggerError("加载封面失败: " + e.message);
    cd.src = DEFAULT_COVER;
  }
}

function updatePlaybackUI() {
  var doc = getDoc();
  var cd = doc.getElementById('fire-cd-cover');
  var title = doc.getElementById('fire-song-title');
  var artist = doc.getElementById('fire-song-artist');
  var playBtn = doc.getElementById('fire-btn-play');

  if (state.currentSong) {
    fetchAndSetCover(state.currentSong);
    if (cd) {
      if (state.isPlaying) {
        cd.classList.add('playing');
      } else {
        cd.classList.remove('playing');
      }
    }
    if (title) title.textContent = state.currentSong.name;
    if (artist) artist.textContent = state.currentSong.artist;
  } else {
    if (cd) {
      cd.src = DEFAULT_COVER;
      cd.classList.remove('playing');
    }
    if (title) title.textContent = "无正在播放歌曲";
    if (artist) artist.textContent = "请选择歌曲播放";
  }

  if (playBtn) {
    var icon = playBtn.querySelector('i');
    if (icon) {
      icon.className = state.isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play';
    }
  }

  // Refresh lists to highlight currently playing item
  renderSearchResults();
  renderPlaylistSongs();
}

function updateVolumeUI() {
  var doc = getDoc();
  var slider = doc.getElementById('fire-volume-slider');
  var icon = doc.getElementById('fire-volume-icon');
  var muteBtn = doc.getElementById('fire-btn-volume-mute');

  var currentVol = audio ? audio.volume : state.volume;
  if (slider) slider.value = Math.round(currentVol * 100);

  var setIconClass = function (el) {
    if (!el) return;
    var i = el.querySelector('i') || el;
    if (currentVol === 0) {
      i.className = 'fa-solid fa-volume-xmark';
    } else if (currentVol < 0.4) {
      i.className = 'fa-solid fa-volume-low';
    } else {
      i.className = 'fa-solid fa-volume-high';
    }
  };

  setIconClass(icon);
  setIconClass(muteBtn);
}

function updateLoopModeUI() {
  var doc = getDoc();
  var btn = doc.getElementById('fire-btn-loop');
  if (!btn) return;
  var icon = btn.querySelector('i');
  if (!icon) return;

  if (state.loopMode === 'list') {
    icon.className = 'fa-solid fa-repeat';
    btn.classList.add('active');
    btn.title = "列表循环";
  } else if (state.loopMode === 'single') {
    icon.className = 'fa-solid fa-rotate-left';
    btn.classList.add('active');
    btn.title = "单曲循环";
  } else {
    icon.className = 'fa-solid fa-shuffle';
    btn.classList.add('active');
    btn.title = "随机播放";
  }
}

function updateProgressBar() {
  if (!audio || !audio.duration) return;
  var doc = getDoc();
  var slider = doc.getElementById('fire-progress-slider');
  var timeCur = doc.getElementById('fire-time-current');
  var timeDur = doc.getElementById('fire-time-duration');

  var pct = (audio.currentTime / audio.duration) * 100;
  if (slider) slider.value = pct;

  if (timeCur) timeCur.textContent = formatTime(audio.currentTime);
  if (timeDur) timeDur.textContent = formatTime(audio.duration);
}

function formatTime(secs) {
  if (isNaN(secs)) return '00:00';
  var m = Math.floor(secs / 60);
  var s = Math.floor(secs % 60);
  return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
}

function updateLyricsHighlight() {
  if (!audio || lyricsList.length === 0) return;
  var currentTime = audio.currentTime;
  var activeIdx = 0;

  for (var i = 0; i < lyricsList.length; i++) {
    if (currentTime >= lyricsList[i].time) {
      activeIdx = i;
    } else {
      break;
    }
  }

  if (activeIdx !== lastActiveLineIdx) {
    var doc = getDoc();
    if (lastActiveLineIdx !== -1) {
      var prevEl = doc.getElementById('fire-lyric-line-' + lastActiveLineIdx);
      if (prevEl) prevEl.classList.remove('active');
    }
    var activeEl = doc.getElementById('fire-lyric-line-' + activeIdx);
    if (activeEl) {
      activeEl.classList.add('active');
      var container = doc.getElementById('fire-lyrics-container');
      if (container) {
        var containerHeight = container.clientHeight;
        var activeOffsetTop = activeEl.offsetTop;
        var activeHeight = activeEl.clientHeight;
        var targetScroll = activeOffsetTop - (containerHeight / 2) + (activeHeight / 2);
        
        var scroller = doc.getElementById('fire-lyrics-scroller');
        if (scroller) {
          scroller.style.transform = `translateY(${-targetScroll}px)`;
        }
      }
    }
    lastActiveLineIdx = activeIdx;
    updateDesktopLyrics(activeIdx, lyricsList);
  }
}

function renderLyrics() {
  var doc = getDoc();
  var scroller = doc.getElementById('fire-lyrics-scroller');
  if (!scroller) return;
  scroller.innerHTML = '';
  
  // reset scroller offset
  scroller.style.transform = 'translateY(0px)';

  if (lyricsList.length === 0) {
    scroller.innerHTML = `<div class="fire-lyric-line active">${state.currentSong ? '暂无歌词' : '暂无播放歌曲'}</div>`;
    return;
  }

  for (var i = 0; i < lyricsList.length; i++) {
    var div = doc.createElement('div');
    div.className = 'fire-lyric-line';
    div.id = 'fire-lyric-line-' + i;

    // Create container for original text
    var origDiv = doc.createElement('div');
    origDiv.className = 'fire-lyric-original';
    origDiv.textContent = lyricsList[i].text;
    div.appendChild(origDiv);

    // Create container for translation if exists
    if (lyricsList[i].translation) {
      var transDiv = doc.createElement('div');
      transDiv.className = 'fire-lyric-translation';
      transDiv.textContent = lyricsList[i].translation;
      div.appendChild(transDiv);
    }

    scroller.appendChild(div);
  }
}

// ─── List Renderers ───────────────────────────────────────────────────────────
function renderSearchResults() {
  var doc = getDoc();
  var container = doc.getElementById('fire-search-results');
  var pagination = doc.getElementById('fire-search-pagination');
  if (!container) return;

  if (currentSearchSongs.length === 0) {
    if (pagination) pagination.style.display = 'none';
    if (!currentSearchQuery) {
      container.innerHTML = '<div style="text-align:center;padding:4px;opacity:0.5;font-size:12px;margin-top:20px;">在上方输入关键词搜索歌曲</div>';
    } else {
      container.innerHTML = '<div style="text-align:center;padding:4px;opacity:0.5;font-size:12px;margin-top:20px;">未找到匹配歌曲</div>';
    }
    return;
  }

  if (pagination) {
    pagination.style.display = 'flex';
    var pageNum = doc.getElementById('fire-page-num');
    if (pageNum) pageNum.textContent = `第 ${currentSearchPage} 页`;
  }

  container.innerHTML = '';
  currentSearchSongs.forEach(song => {
    var item = doc.createElement('div');
    var isPlayingThis = state.currentSong && state.currentSong.id === song.id;
    item.className = 'fire-music-item' + (isPlayingThis ? ' playing' : '');
    
    var artistName = Array.isArray(song.artist) ? song.artist.join(' / ') : song.artist;
    
    var sourceBadges = {
      'netease': '<span class="fire-source-badge netease">网易</span>',
      'tencent': '<span class="fire-source-badge tencent">QQ</span>',
      'kuwo': '<span class="fire-source-badge kuwo">酷我</span>',
      'bilibili': '<span class="fire-source-badge bilibili">B站</span>'
    };
    var badge = sourceBadges[song.source] || '<span class="fire-source-badge">其它</span>';

    item.innerHTML = `
      <div class="fire-music-item-info">
        <div class="fire-music-item-title">${badge} ${song.name}</div>
        <div class="fire-music-item-meta">${artistName} - ${song.album || '未知专辑'}</div>
      </div>
      <div class="fire-music-item-actions">
        ${song.album ? `<button class="fire-music-item-btn album-btn" title="查看专辑"><i class="fa-solid fa-compact-disc"></i></button>` : ''}
        <button class="fire-music-item-btn play-btn" title="立刻播放">
          <i class="fa-solid fa-play"></i>
        </button>
        <button class="fire-music-item-btn add-btn" title="添加到歌单">
          <i class="fa-solid fa-plus"></i>
        </button>
      </div>
    `;

    // Click on item body plays it
    item.addEventListener('click', function(e) {
      if (e.target.closest('.fire-music-item-btn')) return;
      state.activeQueue = [song];
      saveState();
      playSong(song);
    });

    item.querySelector('.play-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      state.activeQueue = [song];
      saveState();
      playSong(song);
    });

    item.querySelector('.add-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      showAddToPlaylistMenu(e, song);
    });

    if (song.album) {
      item.querySelector('.album-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        viewAlbum(song.album, song.source);
      });
    }

    container.appendChild(item);
  });
}

function renderPlaylistOptions() {
  var doc = getDoc();
  var select = doc.getElementById('fire-playlist-select');
  if (!select) return;
  select.innerHTML = '';

  // Add Virtual Option for Active Queue
  var optQueue = doc.createElement('option');
  optQueue.value = "__active_queue__";
  optQueue.textContent = "🎵 当前播放队列";
  optQueue.selected = state.currentPlaylist === "__active_queue__";
  select.appendChild(optQueue);

  Object.keys(state.playlists).forEach(name => {
    var opt = doc.createElement('option');
    opt.value = name;
    opt.textContent = name;
    opt.selected = name === state.currentPlaylist;
    select.appendChild(opt);
  });
}

function renderPlaylistSongs() {
  var doc = getDoc();
  var container = doc.getElementById('fire-playlist-songs');
  if (!container) return;

  var isVirtual = state.currentPlaylist === "__active_queue__";
  
  // Decouple Rename and Delete buttons when viewing virtual queue
  var btnRename = doc.getElementById('fire-btn-playlist-rename');
  var btnDelete = doc.getElementById('fire-btn-playlist-delete');
  if (btnRename) btnRename.style.display = isVirtual ? 'none' : '';
  if (btnDelete) btnDelete.style.display = isVirtual ? 'none' : '';

  var list = isVirtual ? (state.activeQueue || []) : (state.playlists[state.currentPlaylist] || []);
  if (!Array.isArray(list)) {
    list = [];
  }

  if (list.length === 0) {
    container.innerHTML = `<div style="text-align:center;padding:4px;opacity:0.5;font-size:12px;margin-top:20px;">${isVirtual ? '当前播放队列为空' : '歌单中暂无歌曲，去搜索并添加吧！'}</div>`;
    return;
  }

  container.innerHTML = '';
  list.forEach((song, idx) => {
    var item = doc.createElement('div');
    var isPlayingThis = state.currentSong && state.currentSong.id === song.id;
    item.className = 'fire-music-item' + (isPlayingThis ? ' playing' : '');

    var artistName = Array.isArray(song.artist) ? song.artist.join(' / ') : song.artist;

    var sourceBadges = {
      'netease': '<span class="fire-source-badge netease">网易</span>',
      'tencent': '<span class="fire-source-badge tencent">QQ</span>',
      'kuwo': '<span class="fire-source-badge kuwo">酷我</span>',
      'bilibili': '<span class="fire-source-badge bilibili">B站</span>'
    };
    var badge = sourceBadges[song.source] || '<span class="fire-source-badge">其它</span>';

    item.innerHTML = `
      <div style="font-size:11px;opacity:0.5;width:16px;text-align:right;">${idx + 1}</div>
      <div class="fire-music-item-info">
        <div class="fire-music-item-title">${badge} ${song.name}</div>
        <div class="fire-music-item-meta">${artistName} - ${song.album || '未知专辑'}</div>
      </div>
      <div class="fire-music-item-actions">
        ${song.album ? `<button class="fire-music-item-btn album-btn" title="查看专辑"><i class="fa-solid fa-compact-disc"></i></button>` : ''}
        <button class="fire-music-item-btn remove remove-btn" title="${isVirtual ? '从队列移出' : '从歌单移除'}">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `;

    item.addEventListener('click', function (e) {
      if (e.target.closest('.fire-music-item-btn')) return;
      if (!isVirtual) {
        state.activeQueue = list;
      }
      saveState();
      playSong(song);
    });

    item.querySelector('.remove-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      if (isVirtual) {
        state.activeQueue.splice(idx, 1);
        saveState();
        renderPlaylistSongs();
      } else {
        removeSongFromPlaylist(idx);
      }
    });

    if (song.album) {
      item.querySelector('.album-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        viewAlbum(song.album, song.source);
      });
    }

    container.appendChild(item);
  });
}

function showAddAlbumToPlaylistMenu(event, albumSongs) {
  var doc = getDoc();
  var menu = doc.getElementById('fire-add-menu');
  if (!menu) return;

  menu.innerHTML = '';
  Object.keys(state.playlists).forEach(name => {
    var item = doc.createElement('div');
    item.className = 'fire-add-menu-item';
    item.textContent = name;
    item.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.style.display = 'none';
      
      albumSongs.forEach(s => {
        var list = state.playlists[name];
        var exists = list.some(exist => exist.id === s.id);
        if (!exists) {
          list.push(s);
        }
      });
      saveState();
      if (state.currentPlaylist === name) {
        renderPlaylistSongs();
      }
    });
    menu.appendChild(item);
  });

  // Calculate position
  var rect = event.currentTarget.getBoundingClientRect();
  var docEl = doc.documentElement;
  var scrollLeft = window.pageXOffset || docEl.scrollLeft;
  var scrollTop = window.pageYOffset || docEl.scrollTop;

  menu.style.top = (rect.bottom + scrollTop) + 'px';
  menu.style.left = (rect.left + scrollLeft - 50) + 'px';
  menu.style.display = 'block';

  event.stopPropagation();
}

async function viewAlbum(albumName, source) {
  var doc = getDoc();
  var container = doc.getElementById('fire-search-results');
  var pagination = doc.getElementById('fire-search-pagination');
  if (!container) return;

  if (!lastSearchQueryState) {
    lastSearchQueryState = {
      query: currentSearchQuery,
      page: currentSearchPage,
      songs: currentSearchSongs
    };
  }

  switchTab('search');

  container.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.6;"><i class="fa-solid fa-spinner fa-spin"></i> 正在加载专辑...</div>';
  if (pagination) pagination.style.display = 'none';

  try {
    var data = await fetchWithRetry(`https://music-api.gdstudio.xyz/api.php?types=search&source=${source}_album&name=${encodeURIComponent(albumName)}&count=50`, {}, 3, 500);
    var albumSongs = Array.isArray(data) ? data : [];

    albumSongs.forEach(s => {
      s.source = source;
    });

    container.innerHTML = '';

    // Create Album Header
    var header = doc.createElement('div');
    header.className = 'fire-album-header';
    header.innerHTML = `
      <div class="fire-album-header-title">专辑: ${albumName}</div>
      <div class="fire-album-header-actions">
        <button id="fire-btn-album-playall" class="fire-btn" style="padding: 4px 8px; font-size:11px;">播放全部</button>
        <button id="fire-btn-album-addall" class="fire-btn fire-btn-normal" style="padding: 4px 8px; font-size:11px; margin-left: 5px;">导入歌单</button>
        <button id="fire-btn-album-back" class="fire-btn fire-btn-normal" style="padding: 4px 8px; font-size:11px; margin-left: 5px;">返回</button>
      </div>
    `;
    container.appendChild(header);

    if (albumSongs.length === 0) {
      var noSongs = doc.createElement('div');
      noSongs.style.cssText = 'text-align:center;padding:20px;opacity:0.5;font-size:12px;';
      noSongs.textContent = '未在该专辑中找到曲目';
      container.appendChild(noSongs);
    } else {
      albumSongs.forEach(song => {
        var item = doc.createElement('div');
        var isPlayingThis = state.currentSong && state.currentSong.id === song.id;
        item.className = 'fire-music-item' + (isPlayingThis ? ' playing' : '');
        var artistName = Array.isArray(song.artist) ? song.artist.join(' / ') : song.artist;
        
        item.innerHTML = `
          <div class="fire-music-item-info">
            <div class="fire-music-item-title">${song.name}</div>
            <div class="fire-music-item-meta">${artistName}</div>
          </div>
          <div class="fire-music-item-actions">
            <button class="fire-music-item-btn play-btn" title="立刻播放">
              <i class="fa-solid fa-play"></i>
            </button>
            <button class="fire-music-item-btn add-btn" title="添加到歌单">
              <i class="fa-solid fa-plus"></i>
            </button>
          </div>
        `;

        item.addEventListener('click', function(e) {
          if (e.target.closest('.fire-music-item-btn')) return;
          state.activeQueue = albumSongs;
          saveState();
          playSong(song);
        });

        item.querySelector('.play-btn').addEventListener('click', function (e) {
          e.stopPropagation();
          state.activeQueue = albumSongs;
          saveState();
          playSong(song);
        });

        item.querySelector('.add-btn').addEventListener('click', function (e) {
          e.stopPropagation();
          showAddToPlaylistMenu(e, song);
        });

        container.appendChild(item);
      });
    }

    var btnPlayAll = doc.getElementById('fire-btn-album-playall');
    if (btnPlayAll) {
      btnPlayAll.addEventListener('click', function () {
        if (albumSongs.length === 0) return;
        state.activeQueue = albumSongs;
        saveState();
        playSong(albumSongs[0]);
      });
    }

    var btnAddAll = doc.getElementById('fire-btn-album-addall');
    if (btnAddAll) {
      btnAddAll.addEventListener('click', function (e) {
        showAddAlbumToPlaylistMenu(e, albumSongs);
      });
    }

    var btnBack = doc.getElementById('fire-btn-album-back');
    if (btnBack) {
      btnBack.addEventListener('click', function () {
        restoreLastSearch();
      });
    }

  } catch (err) {
    console.error("[FIRE] Fetch album failed:", err);
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--fire-em);">载入专辑失败，请重试</div>';
  }
}

function restoreLastSearch() {
  if (lastSearchQueryState) {
    currentSearchQuery = lastSearchQueryState.query;
    currentSearchPage = lastSearchQueryState.page;
    currentSearchSongs = lastSearchQueryState.songs;
    lastSearchQueryState = null;
    renderSearchResults();
  }
}

// ─── Playlist Modifications ──────────────────────────────────────────────────
function showAddToPlaylistMenu(event, song) {
  var doc = getDoc();
  var menu = doc.getElementById('fire-add-menu');
  if (!menu) return;

  menu.innerHTML = '';
  Object.keys(state.playlists).forEach(name => {
    var item = doc.createElement('div');
    item.className = 'fire-add-menu-item';
    item.textContent = name;
    item.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.style.display = 'none';
      addSongToPlaylist(name, song);
    });
    menu.appendChild(item);
  });

  // Calculate position
  var rect = event.currentTarget.getBoundingClientRect();
  var docEl = doc.documentElement;
  var scrollLeft = window.pageXOffset || docEl.scrollLeft;
  var scrollTop = window.pageYOffset || docEl.scrollTop;

  menu.style.top = (rect.bottom + scrollTop) + 'px';
  menu.style.left = (rect.left + scrollLeft - 100) + 'px';
  menu.style.display = 'block';

  event.stopPropagation();
}

function addSongToPlaylist(playlistName, song) {
  if (!state.playlists[playlistName]) return;
  
  // Check if song already exists in playlist to prevent duplicates
  var list = state.playlists[playlistName];
  var exists = list.some(s => s.id === song.id);
  if (exists) {
    showToast(`"${song.name}" 已经在歌单 "${playlistName}" 中`);
    return;
  }

  list.push(song);
  saveState();
  showToast(`已添加 "${song.name}" 到歌单 "${playlistName}"`);
  if (state.currentPlaylist === playlistName) {
    renderPlaylistSongs();
  }
}

function removeSongFromPlaylist(index) {
  var list = state.playlists[state.currentPlaylist];
  if (!list || !list[index]) return;

  list.splice(index, 1);
  saveState();
  renderPlaylistSongs();
}

// ─── Playlist Import, Export & Backup Utilities ───────────────────────────────
function showPlaylistSelectionDialog() {
  return new Promise((resolve) => {
    var doc = getDoc();
    var overlay = doc.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:200000;display:flex;align-items:center;justify-content:center;font-family:sans-serif;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';
    
    var dialog = doc.createElement('div');
    dialog.style.cssText = 'background:var(--fire-bg-opaque, #080d14) !important;border:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)) !important;border-radius:12px;padding:20px;width:320px;max-width:90vw;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 25px var(--SmartThemeShadowColor, rgba(0,0,0,0.5)) !important;color:var(--SmartThemeBodyColor, #f3f4f6) !important;';
    
    dialog.innerHTML = `
      <div style="font-weight:bold;font-size:14px;border-bottom:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));padding-bottom:8px;display:flex;justify-content:space-between;align-items:center;color:var(--SmartThemeBodyColor, #f3f4f6);">
        <span>选择要导出的歌单</span>
        <span id="fire-export-select-all" style="font-size:11px;color:var(--fire-accent);cursor:pointer;user-select:none;">取消全选</span>
      </div>
      <div id="fire-export-dialog-list" class="fire-scroll" style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:4px 0;">
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
        <button id="fire-export-dialog-cancel" class="fire-btn fire-btn-normal" style="padding:4px 12px;font-size:11px;height:26px;">取消</button>
        <button id="fire-export-dialog-ok" class="fire-btn" style="padding:4px 12px;font-size:11px;height:26px;">导出</button>
      </div>
    `;
    
    overlay.appendChild(dialog);
    doc.body.appendChild(overlay);
    
    var listContainer = dialog.querySelector('#fire-export-dialog-list');
    var playlistsKeys = Object.keys(state.playlists);
    
    playlistsKeys.forEach(name => {
      var label = doc.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;user-select:none;color:var(--SmartThemeBodyColor, #f3f4f6);';
      label.innerHTML = `<input type="checkbox" value="${name}" checked style="cursor:pointer;"> <span>${name}</span>`;
      listContainer.appendChild(label);
    });
    
    var allSelected = true;
    dialog.querySelector('#fire-export-select-all').addEventListener('click', function(e) {
      e.stopPropagation();
      var chks = listContainer.querySelectorAll('input[type="checkbox"]');
      allSelected = !allSelected;
      chks.forEach(c => c.checked = allSelected);
      this.textContent = allSelected ? '取消全选' : '全选';
    });
    
    dialog.querySelector('#fire-export-dialog-cancel').addEventListener('click', function(e) {
      e.stopPropagation();
      overlay.remove();
      resolve(null);
    });
    
    dialog.querySelector('#fire-export-dialog-ok').addEventListener('click', function(e) {
      e.stopPropagation();
      var chks = listContainer.querySelectorAll('input[type="checkbox"]');
      var selected = [];
      chks.forEach(c => {
        if (c.checked) selected.push(c.value);
      });
      overlay.remove();
      resolve(selected);
    });
  });
}

function showDuplicatePlaylistDecisionDialog(playlistName) {
  return new Promise((resolve) => {
    var doc = getDoc();
    var overlay = doc.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:200000;display:flex;align-items:center;justify-content:center;font-family:sans-serif;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';
    
    var dialog = doc.createElement('div');
    dialog.style.cssText = 'background:var(--fire-bg-opaque, #080d14) !important;border:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)) !important;border-radius:12px;padding:20px;width:340px;max-width:90vw;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 25px var(--SmartThemeShadowColor, rgba(0,0,0,0.5)) !important;color:var(--SmartThemeBodyColor, #f3f4f6) !important;';
    
    dialog.innerHTML = `
      <div style="font-weight:bold;font-size:14px;border-bottom:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));padding-bottom:8px;color:var(--SmartThemeBodyColor, #f3f4f6);">
        <span>歌单冲突提示</span>
      </div>
      <div style="font-size:12px;line-height:1.4;color:var(--SmartThemeBodyColor, #f3f4f6);">
        导入的文件中包含歌单 <strong>"${playlistName}"</strong>，但本地已存在同名歌单。请选择您的处理方式：
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px;">
        <button id="fire-dup-merge" class="fire-btn" style="padding:6px;font-size:12px;text-align:center;">合并歌曲 (去重追加)</button>
        <button id="fire-dup-overwrite" class="fire-btn fire-btn-normal" style="padding:6px;font-size:12px;text-align:center;">覆盖原有歌单 (本地数据将被替换)</button>
        <button id="fire-dup-skip" class="fire-btn fire-btn-normal" style="padding:6px;font-size:12px;text-align:center;">跳过该歌单</button>
      </div>
    `;
    
    overlay.appendChild(dialog);
    doc.body.appendChild(overlay);
    
    dialog.querySelector('#fire-dup-merge').addEventListener('click', function(e) {
      e.stopPropagation();
      overlay.remove();
      resolve('merge');
    });
    
    dialog.querySelector('#fire-dup-overwrite').addEventListener('click', function(e) {
      e.stopPropagation();
      overlay.remove();
      resolve('overwrite');
    });
    
    dialog.querySelector('#fire-dup-skip').addEventListener('click', function(e) {
      e.stopPropagation();
      overlay.remove();
      resolve('skip');
    });
  });
}

async function exportPlaylistsBackup() {
  var selectedPlaylists = await showPlaylistSelectionDialog();
  if (!selectedPlaylists || selectedPlaylists.length === 0) {
    return;
  }
  
  var backupData = {};
  selectedPlaylists.forEach(name => {
    backupData[name] = state.playlists[name] || [];
  });
  
  try {
    var jsonString = JSON.stringify(backupData, null, 2);
    var blob = new Blob([jsonString], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    
    var a = document.createElement('a');
    var dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    var fileName = '';
    if (selectedPlaylists.length === 1) {
      fileName = `fire_playlist_${selectedPlaylists[0]}_backup_${dateStr}.json`;
    } else {
      fileName = `fire_playlists_backup_${selectedPlaylists.length}个_${dateStr}.json`;
    }
    
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("备份文件已开始下载");
  } catch (err) {
    console.error("[FIRE] Export failed:", err);
    triggerError("备份导出失败: " + err.message);
  }
}

async function importPlaylistsBackup(event) {
  var file = event.target.files[0];
  if (!file) return;
  
  var fileInput = event.target;
  var reader = new FileReader();
  
  reader.onload = async function (e) {
    try {
      var importedPlaylists = JSON.parse(e.target.result);
      if (typeof importedPlaylists !== 'object' || Array.isArray(importedPlaylists) || importedPlaylists === null) {
        throw new Error("备份数据格式不正确（应为JSON对象格式）");
      }
      
      var keys = Object.keys(importedPlaylists);
      if (keys.length === 0) {
        throw new Error("备份文件中未找到任何歌单");
      }
      
      var importedCount = 0;
      for (var i = 0; i < keys.length; i++) {
        var playlistName = keys[i];
        var importedSongs = importedPlaylists[playlistName];
        if (!Array.isArray(importedSongs)) continue;
        
        var cleanedSongs = importedSongs.filter(s => s && s.id && s.name).map(s => {
          return {
            id: s.id,
            name: s.name,
            artist: s.artist || '未知歌手',
            album: s.album || '未知专辑',
            pic_id: s.pic_id || null,
            coverUrl: s.coverUrl || null,
            source: s.source || 'netease'
          };
        });

        if (state.playlists[playlistName]) {
          var decision = await showDuplicatePlaylistDecisionDialog(playlistName);
          if (decision === 'overwrite') {
            state.playlists[playlistName] = cleanedSongs;
            importedCount++;
          } else if (decision === 'merge') {
            var localSongs = state.playlists[playlistName];
            cleanedSongs.forEach(song => {
              var exists = localSongs.some(ls => ls.id === song.id);
              if (!exists) {
                localSongs.push(song);
              }
            });
            importedCount++;
          }
        } else {
          state.playlists[playlistName] = cleanedSongs;
          importedCount++;
        }
      }
      
      if (importedCount > 0) {
        saveState();
        renderPlaylistOptions();
        renderPlaylistSongs();
        showToast(`恢复成功！已导入 ${importedCount} 个歌单`);
      } else {
        showToast("未导入任何歌单");
      }
    } catch (err) {
      console.error("[FIRE] Import backup failed:", err);
      triggerError("歌单恢复失败: " + err.message);
    } finally {
      fileInput.value = '';
    }
  };
  reader.readAsText(file);
}

async function importNetEasePlaylist(inputStr) {
  if (!inputStr) return;
  
  var playlistId = '';
  var trimmed = inputStr.trim();
  if (/^\d+$/.test(trimmed)) {
    playlistId = trimmed;
  } else {
    var idMatch = trimmed.match(/(?:\?id=|\/playlist\/)(\d+)/);
    if (idMatch) {
      playlistId = idMatch[1];
    }
  }
  
  if (!playlistId) {
    showToast("无法解析出有效的网易云歌单ID，请检查输入");
    return;
  }
  
  showToast("正在拉取网易云歌单中...");
  
  try {
    var res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=playlist&source=netease&id=${playlistId}`);
    if (res.status === 429) {
      throw new Error("歌单请求频次过高，请 5 分钟后再试");
    }
    if (!res.ok) {
      throw new Error(`HTTP status: ${res.status}`);
    }
    
    var data = await res.json();
    if (!data || data.code !== 200 || !data.playlist) {
      throw new Error((data && data.message) || "接口返回歌单数据为空或错误");
    }
    
    var ncmPlaylist = data.playlist;
    var playlistName = (ncmPlaylist.name || "网易云导入歌单").trim();
    var tracks = ncmPlaylist.tracks || [];
    
    if (tracks.length === 0) {
      showToast("该歌单中没有可导入的曲目");
      return;
    }
    
    var importedSongs = tracks.map(track => {
      var artistName = '未知歌手';
      if (track.ar && Array.isArray(track.ar)) {
        artistName = track.ar.map(a => a.name).join(' / ');
      }
      
      var coverUrl = null;
      if (track.al && track.al.picUrl) {
        coverUrl = track.al.picUrl;
        if (window.location.protocol === 'https:' && coverUrl.startsWith('http://')) {
          coverUrl = coverUrl.replace('http://', 'https://');
        }
      }
      
      return {
        id: track.id,
        name: track.name || '未知歌曲',
        artist: artistName,
        album: (track.al && track.al.name) || '未知专辑',
        pic_id: (track.al && (track.al.pic_str || track.al.pic)) || null,
        coverUrl: coverUrl,
        source: 'netease'
      };
    });
    
    var isNew = false;
    if (!state.playlists[playlistName]) {
      state.playlists[playlistName] = [];
      isNew = true;
    }
    
    var localSongs = state.playlists[playlistName];
    var addedCount = 0;
    
    importedSongs.forEach(song => {
      var exists = localSongs.some(ls => ls.id === song.id);
      if (!exists) {
        localSongs.push(song);
        addedCount++;
      }
    });
    
    saveState();
    
    if (isNew) {
      state.currentPlaylist = playlistName;
      saveState();
    }
    
    renderPlaylistOptions();
    renderPlaylistSongs();
    
    var time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    var msg = `成功导入歌单 "${playlistName}"：拉取到 ${tracks.length} 首，入库 ${addedCount} 首`;
    errorLogs.unshift(`[${time}] ${msg}`);
    if (errorLogs.length > MAX_ERROR_LOGS) errorLogs.pop();
    renderLogsUI();
    
    showToast(msg);
  } catch (err) {
    console.error("[FIRE] Import playlist failed:", err);
    triggerError("歌单导入失败: " + err.message);
  }
}

// ─── Toast System ────────────────────────────────────────────────────────────
function showToast(message) {
  var doc = getDoc();
  var toast = doc.getElementById('fire-toast-element');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  
  if (window.fireToastTimeout) clearTimeout(window.fireToastTimeout);
  window.fireToastTimeout = setTimeout(function() {
    toast.classList.remove('show');
  }, 3000);
}

// ─── Panel Entrance Toggle ────────────────────────────────────────────────────
function togglePanel(e) {
  if (e) {
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }

  if (!isInitDone) return;
  if (Date.now() - initTimestamp < 500) return;
  var now = Date.now();
  if (now - lastToggleTime < 300) return;
  lastToggleTime = now;

  var doc = getDoc();
  var overlay = doc.getElementById('fire-overlay');
  var panel = doc.getElementById('fire-panel');
  if (!overlay || !panel) {
    createUI();
    return;
  }

  if (panelOpen) {
    overlay.style.display = 'none';
    panel.classList.remove('fire-open');
    panelOpen = false;
  } else {
    syncViewportHeight();
    updateDynamicThemeColors();
    applyDisplayMode();
    updateTabUI();

    overlay.style.display = 'block';
    panel.classList.add('fire-open');
    panelOpen = true;
    
    // Auto-focus search input if search tab is active
    setTimeout(() => {
      var searchInput = doc.getElementById('fire-search-input');
      if (searchInput && activeTab === 'search') {
        searchInput.focus();
      }
    }, 200);
  }
}

function applyDisplayMode() {
  var doc = getDoc();
  var panel = doc.getElementById('fire-panel');
  if (!panel) return;

  // Remove only the display mode classes
  panel.classList.remove('fire-fullscreen', 'fire-qr-top', 'fire-qr-bottom', 'fire-qr-left', 'fire-qr-right');
  
  var mode = state.settings.displayMode || 'wand-modal';
  if (mode === 'wand-fullscreen') {
    panel.classList.add('fire-fullscreen');
  } else if (mode === 'qr-top') {
    panel.classList.add('fire-qr-top');
  } else if (mode === 'qr-bottom') {
    panel.classList.add('fire-qr-bottom');
  } else if (mode === 'qr-left') {
    panel.classList.add('fire-qr-left');
  } else if (mode === 'qr-right') {
    panel.classList.add('fire-qr-right');
  }

  ensureQRButton();
  ensureWandButton();
}

// ─── Quick Reply (QR) Button Persistence ──────────────────────────────────────
function removeQRButton() {
  try {
    var doc = getDoc();
    var btn = doc.getElementById('fire-qr-btn');
    if (btn) btn.remove();
  } catch (e) {}
}

function ensureQRButton() {
  var mode = state.settings.displayMode || 'wand-modal';
  if (mode.indexOf('qr-') !== 0) {
    removeQRButton();
    return;
  }

  var doc = getDoc();
  var btnContainer = doc.querySelector('#qr--bar .qr--buttons') || 
                     doc.querySelector('#qr-bar .qr--buttons') || 
                     doc.getElementById('qr--bar') || 
                     doc.getElementById('qr-bar');
  if (!btnContainer) return;

  var btn = doc.getElementById('fire-qr-btn');
  if (btn) {
    if (!btnContainer.contains(btn)) {
      btnContainer.appendChild(btn);
    }
    return;
  }

  btn = doc.createElement('div');
  btn.id = 'fire-qr-btn';
  btn.className = 'qr--button qr-button menu_button interactable fire-qr-btn';
  btn.tabIndex = 0;
  btn.role = 'button';
  btn.title = '音乐';
  btn.innerHTML = '<i class="fa-solid fa-music"></i>';

  btn.style.setProperty('display', 'inline-flex', 'important');
  btn.style.alignItems = 'center';
  btn.style.justifyContent = 'center';
  btn.style.color = 'var(--SmartThemeBodyColor, #f3f4f6)';

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    togglePanel(e);
  });

  btnContainer.appendChild(btn);
}

function removeWandButton() {
  try {
    var doc = getDoc();
    var btn = doc.getElementById('fire_wand_entry');
    if (btn) btn.remove();
  } catch (e) {}
}

export function ensureWandButton() {
  var mode = state.settings.displayMode || 'wand-modal';
  if (mode.indexOf('wand-') !== 0) {
    removeWandButton();
    return;
  }

  try {
    var doc = getDoc();
    
    // Check if the button is already in the DOM
    var existing = doc.getElementById('fire_wand_entry');
    if (existing) {
      // Ensure it is still attached to a valid container
      var container = doc.getElementById('FIRE_wand_container') || 
                      doc.getElementById('fire_wand_container') || 
                      doc.getElementById('extensionsMenu') || 
                      doc.querySelector('#extensionsMenu.options-content');
      if (container && !container.contains(existing)) {
        container.appendChild(existing);
      }
      return;
    }

    // Determine the best target container
    var target = doc.getElementById('FIRE_wand_container') || 
                 doc.getElementById('fire_wand_container');
                 
    if (!target) {
      target = doc.getElementById('extensionsMenu') || 
               doc.querySelector('#extensionsMenu.options-content');
    }
    
    if (!target) return; // Wait for DOM to load

    var btn = doc.createElement('div');
    btn.id = 'fire_wand_entry';
    // Combine classes from old and new SillyTavern versions to support both
    btn.className = 'list_item list-group-item interactable flex-container flexGap5';
    btn.title = '音乐';
    btn.innerHTML = `
      <i class="fa-solid fa-music extensionsMenuExtensionButton"></i>
      <span class="list_item_text">音乐</span>
    `;
    target.appendChild(btn);
    btn.addEventListener('click', togglePanel);
  } catch (e) {
    console.warn("[FIRE] Failed to inject Magic Wand button:", e);
  }
}

function runSelfHealingInjection() {
  ensureWandButton();
  ensureQRButton();
}

function initUIInjection() {
  runSelfHealingInjection();

  try {
    var doc = getDoc();
    var win = getWin();
    var MutationObserverClass = win.MutationObserver || win.parent?.MutationObserver || window.MutationObserver;
    if (MutationObserverClass && doc.body) {
      if (qrBtnObserver) {
        qrBtnObserver.disconnect();
      }
      qrBtnObserver = new MutationObserverClass(function () {
        runSelfHealingInjection();
      });
      qrBtnObserver.observe(doc.body, { childList: true, subtree: true });
    }
  } catch (err) {
    console.warn("[FIRE] MutationObserver initialization delayed:", err);
  }

  // Interval polling fallback (runs every 1500ms)
  if (window.fireInjectionInterval) {
    clearInterval(window.fireInjectionInterval);
  }
  window.fireInjectionInterval = setInterval(function () {
    runSelfHealingInjection();
    if (!qrBtnObserver) {
      var d = getDoc();
      if (d && d.body) {
        initUIInjection();
      }
    }
  }, 1500);
}

// ─── Extension Initializer ────────────────────────────────────────────────────
export function init() {
  loadState();
  initLyricsWidget(state, getDoc, saveState, {
    playNext: playNext,
    playPrev: playPrev,
    togglePlay: togglePlayPause
  });
  createUI();

  panelOpen = false;
  initTimestamp = Date.now();
  isInitDone = true;
  syncViewportHeight();

  // Viewport height sync
  try {
    var p = window;
    if (p.visualViewport) {
      p.visualViewport.addEventListener('resize', syncViewportHeight, { passive: true });
      p.visualViewport.addEventListener('scroll', syncViewportHeight, { passive: true });
    }
    p.addEventListener('resize', syncViewportHeight, { passive: true });
    p.addEventListener('resize', clampDesktopLyricsPosition, { passive: true });
  } catch (e) {}

  // Responsive layout class guard (suppress animation on breakpoint switch)
  try {
    var pw  = window;
    var vw  = (pw.innerWidth || 768) > 760 ? 'desktop' : 'mobile';
    pw.addEventListener('resize', function () {
      var nv = (pw.innerWidth || 768) > 760 ? 'desktop' : 'mobile';
      if (vw !== nv) {
        vw = nv;
        var pn = pw.document.getElementById('fire-panel');
        if (pn && pn.classList.contains('fire-open')) {
          pn.classList.add('fire-no-animation');
          setTimeout(function () { pn.classList.remove('fire-no-animation'); }, 30);
        }
      }
      updateTabUI();
      clampDesktopLyricsPosition();
    }, { passive: true });
  } catch (e) {}

  // Initialize self-healing injection observer and interval polling
  initUIInjection();
  applyDisplayMode();

  // ─── Escape Hatch / Backup Entry Points ─────────────────────────────────────
  // 1. Slash Command: /fire (type /fire in chat bar to open)
  try {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
      name: 'fire',
      callback: () => {
        togglePanel();
        return '';
      },
      helpString: '打开/关闭音乐播放器界面 (Toggle FIRE Music Player)',
    }));
  } catch (e) {
    console.warn("[FIRE] Failed to register slash command /fire:", e);
  }

  // 2. Keyboard Shortcut: Alt + M (press Alt + M globally to open)
  try {
    window.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'm' || e.key === 'M' || e.keyCode === 77)) {
        e.preventDefault();
        togglePanel();
      }
    });
  } catch (e) {}

  // 3. Console Escape Hatch: type fireTogglePlayer() in F12 console
  try {
    window.fireTogglePlayer = togglePanel;
  } catch (e) {}
}
