import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

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
    audioQuality: '999'
  }
};

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
  try {
    if (window.parent && window.parent.document) {
      return window.parent.document;
    }
  } catch (e) {
    console.warn("[FIRE] Cannot access window.parent.document", e);
  }
  return document;
}

function getWin() {
  return window.parent || window;
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

    panel.style.setProperty('--fire-bg-opaque', opaqueColor);
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
    showToast("播放源出错，自动尝试下一首");
    playNext();
  });
}

async function playSong(song) {
  initAudio();
  state.currentSong = song;
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

  showToast("正在加载: " + song.name);

  try {
    // 1. Get Streaming URL
    var urlRes = await fetch(`https://music-api.gdstudio.xyz/api.php?types=url&source=${song.source || 'netease'}&id=${song.id}&br=${state.settings.audioQuality || 999}`);
    var urlData = await urlRes.json();
    if (!urlData || !urlData.url) {
      throw new Error("Empty URL returned from API");
    }

    var playUrl = urlData.url;
    // Force HTTPS if parent runs on HTTPS to bypass mixed-content blocker
    if (window.location.protocol === 'https:' && playUrl.startsWith('http://')) {
      playUrl = playUrl.replace('http://', 'https://');
    }

    audio.src = playUrl;
    await audio.play();
  } catch (err) {
    console.error("[FIRE] Playback failed:", err);
    showToast("播放失败，请尝试其他歌曲");
    state.isPlaying = false;
    updatePlaybackUI();
    return;
  }

  // 2. Load Lyrics asynchronously
  fetchAndParseLyrics(song.id, song.source);
}

async function fetchAndParseLyrics(songId, source) {
  try {
    var res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=lyric&source=${source || 'netease'}&id=${songId}`);
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
      renderLyrics();
    } else {
      lyricsList = [];
      renderLyrics();
    }
  } catch (e) {
    console.warn("[FIRE] Failed to load lyrics:", e);
    lyricsList = [];
    renderLyrics();
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
      if (!res.ok) {
        throw new Error(`HTTP status: ${res.status}`);
      }
      var data = await res.json();
      return data;
    } catch (err) {
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
  if (container) {
    container.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.6;"><i class="fa-solid fa-spinner fa-spin"></i> 正在全网搜索中...</div>';
  }

  try {
    var sources = ['netease', 'tencent', 'kuwo', 'bilibili'];
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
          console.warn(`[FIRE] Search source ${source} failed after retries:`, err);
          return [];
        })
    );

    var results = await Promise.all(promises);
    var merged = [];
    var maxLength = Math.max(...results.map(r => r.length));
    for (var i = 0; i < maxLength; i++) {
      for (var j = 0; j < results.length; j++) {
        if (results[j][i]) {
          merged.push(results[j][i]);
        }
      }
    }

    currentSearchSongs = merged;
    renderSearchResults();
  } catch (err) {
    console.error("[FIRE] Search failed:", err);
    if (container) {
      container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--fire-em);">搜索失败，请重试</div>';
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
      <div class="fire-settings-title">显示模式</div>
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
      
      <div class="fire-settings-title" style="margin-top: 12px; border-top: 1px solid var(--fire-border); padding-top: 8px;">播放音质</div>
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

  // Play / Pause Button
  var playBtn = doc.getElementById('fire-btn-play');
  if (playBtn) {
    playBtn.addEventListener('click', function () {
      if (!audio || !state.currentSong) {
        // If nothing is playing, play first song in current playlist
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
    });
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

  var id = song.pic_id || song.id;
  if (!id) {
    cd.src = DEFAULT_COVER;
    return;
  }

  cd.onerror = function() {
    cd.src = DEFAULT_COVER;
  };

  try {
    var res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=pic&source=${song.source || 'netease'}&id=${id}&size=500`);
    var data = await res.json();
    if (data && data.url) {
      var coverUrl = data.url;
      if (window.location.protocol === 'https:' && coverUrl.startsWith('http://')) {
        coverUrl = coverUrl.replace('http://', 'https://');
      }
      cd.src = coverUrl;
    } else {
      cd.src = DEFAULT_COVER;
    }
  } catch (e) {
    console.warn("[FIRE] Failed to fetch cover:", e);
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

// ─── Toast System ────────────────────────────────────────────────────────────
function showToast(message) {
  // Toast notifications disabled by user request
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
  var btnContainer = doc.querySelector('#qr--bar .qr--buttons') || doc.getElementById('qr--bar');
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
  btn.className = 'qr--button menu_button interactable fire-qr-btn';
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

function initQRButtonObserver() {
  try {
    var doc = getDoc();
    var win = getWin();
    var MutationObserverClass = win.MutationObserver || win.parent?.MutationObserver || window.MutationObserver;
    if (!MutationObserverClass) return;

    if (qrBtnObserver) {
      qrBtnObserver.disconnect();
    }

    qrBtnObserver = new MutationObserverClass(function () {
      var mode = state.settings.displayMode || 'wand-modal';
      if (mode.indexOf('qr-') === 0) {
        ensureQRButton();
      }
    });

    qrBtnObserver.observe(doc.body, { childList: true, subtree: true });
  } catch (e) {
    console.warn('[FIRE] Failed to initialize QR Button Observer:', e);
  }
}

// ─── Extension Initializer ────────────────────────────────────────────────────
export function init() {
  loadState();
  createUI();

  panelOpen = false;
  initTimestamp = Date.now();
  isInitDone = true;
  syncViewportHeight();

  // Viewport height sync
  try {
    var p = window.parent || window;
    if (p.visualViewport) {
      p.visualViewport.addEventListener('resize', syncViewportHeight, { passive: true });
      p.visualViewport.addEventListener('scroll', syncViewportHeight, { passive: true });
    }
    p.addEventListener('resize', syncViewportHeight, { passive: true });
  } catch (e) {}

  // Responsive layout class guard (suppress animation on breakpoint switch)
  try {
    var pw  = window.parent || window;
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
    }, { passive: true });
  } catch (e) {}
  
  // Register entry into Magic Wand Extensions menu
  try {
    var doc = getDoc();
    var menu = doc.getElementById('extensionsMenu');
    if (menu && !doc.getElementById('fire_wand_container')) {
      var container = doc.createElement('div');
      container.id = 'fire_wand_container';
      container.className = 'extension_container';
      container.innerHTML = `
        <div id="fire_wand_entry" class="list-group-item flex-container flexGap5">
          <div class="fa-solid fa-music extensionsMenuExtensionButton"></div>
          音乐
        </div>
      `;
      menu.appendChild(container);
      var wandBtn = doc.getElementById('fire_wand_entry');
      if (wandBtn) wandBtn.addEventListener('click', togglePanel);
    }
  } catch (e) {
    console.warn("[FIRE] Failed to inject Magic Wand button:", e);
  }

  // Setup MutationObserver & initial Quick Reply button render
  initQRButtonObserver();
  applyDisplayMode();
  setTimeout(ensureQRButton, 1000);
}
