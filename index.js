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
import {
  initStorySearch,
  renderStorySearchSettingsHTML,
  bindStorySearchUIEvents,
} from './story-search.js';
import {
  initListenTogether,
  showFullScreenListenTogetherEditor,
  showListenTogetherHelp,
  updateListenTogetherPrompt,
} from './listen-together.js';

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
    desktopLyricsAlign: 'center',
    desktopLyricsContextCount: 0,
    desktopLyricsWidth: 0,
    desktopLyricsHeight: 0,
    desktopLyricsPadding: 14,
    listenTogetherEnabled: false,
    listenTogetherTemplate: '[一起听]\n{{user}}当前正在听：{{song}} - {{artist}}\n标签：{{tags}}\n当前歌词：\n{{lyrics}}\n你可以按照以下格式，和{{user}}分享自己喜欢的歌（不要选择同一首）： {{play_tag}}',
    listenTogetherLyricsCount: '5',
    listenTogetherPosition: 1, // Default In-chat @ Depth
    listenTogetherDepth: 4,     // Default depth 4
    listenTogetherRole: 0,      // Default System (0)
    searchSources: ['netease', 'joox', 'bilibili', 'vkeys_tencent'],
    showErrorToasts: false,
    localPlaybackEnabled: false,
    enabledDiscoverCharts: [19723756, 3779629, 3778678, 2884035, 2250011882, 5453912201, 71385702, 71384707, 10520166, 60198, 60131, 2809577409],
    enableSimiSongs: true,
    storySearch: {
      enabled:        false,
      tagTemplate:    '♪{song} - {artist}♪',
      switchMode:     'queue',
      multiTagMode:   'first_cut_rest_queue',
      allowRetrigger: false,
      playlistMode:   'any',
      targetPlaylist: '',
      fallbackRandom: true,
    }
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
var isInjectionPending = false;
var injectionRetryCount = 0;
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

function getOpaqueRGB(colorStr) {
  if (!colorStr) return null;
  colorStr = colorStr.trim();
  var match = colorStr.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (match) {
    return 'rgb(' + match[1] + ', ' + match[2] + ', ' + match[3] + ')';
  }
  if (colorStr.startsWith('#')) {
    var hex = colorStr.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      return 'rgb(' + parseInt(hex[0]+hex[0], 16) + ', ' + parseInt(hex[1]+hex[1], 16) + ', ' + parseInt(hex[2]+hex[2], 16) + ')';
    }
    if (hex.length === 6 || hex.length === 8) {
      return 'rgb(' + parseInt(hex.slice(0, 2), 16) + ', ' + parseInt(hex.slice(2, 4), 16) + ', ' + parseInt(hex.slice(4, 6), 16) + ')';
    }
  }
  return null;
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



    var opaqueColor = getOpaqueRGB(color);

    if (!opaqueColor) {
      var directVal = p.getComputedStyle(doc.documentElement).getPropertyValue('--SmartThemeBlurTintColor');
      opaqueColor = getOpaqueRGB(directVal);
    }

    if (!opaqueColor) {
      var inlineVal = doc.documentElement.style.getPropertyValue('--SmartThemeBlurTintColor');
      opaqueColor = getOpaqueRGB(inlineVal);
    }

    if (!opaqueColor) {
      opaqueColor = 'rgb(8, 13, 20)'; // default dark
    }

    doc.body.style.setProperty('--fire-bg-opaque', opaqueColor);
    panel.style.setProperty('background', opaqueColor, 'important');
  } catch (e) {
    console.warn('[FIRE] updateDynamicThemeColors error:', e);
  }
}

// ─── Playback Offset Utils ───────────────────────────────────────────────────
var pendingStartVal = null;

function parseStartTime(val, duration) {
  if (!val) return 0;
  val = String(val).trim();
  if (!val) return 0;

  // 1. 百分比: 如 30%
  if (val.endsWith('%')) {
    var pct = parseFloat(val) / 100;
    if (!isNaN(pct)) return duration * pct;
  }

  // 2. 分数: 如 1/3
  if (val.indexOf('/') !== -1) {
    var parts = val.split('/');
    var num = parseFloat(parts[0]);
    var den = parseFloat(parts[1]);
    if (!isNaN(num) && !isNaN(den) && den !== 0) {
      return duration * (num / den);
    }
  }

  // 3. 时间格式: 如 01:30 或 1:30
  if (val.indexOf(':') !== -1) {
    var parts = val.split(':');
    var mins = parseFloat(parts[0]);
    var secs = parseFloat(parts[1]);
    if (!isNaN(mins) && !isNaN(secs)) {
      return mins * 60 + secs;
    }
  }

  // 4. 绝对秒数: 如 90
  var sec = parseFloat(val);
  if (!isNaN(sec)) {
    return sec;
  }

  return 0;
}

// ─── Audio Engine & Playback Logic ───────────────────────────────────────────
function initAudio() {
  if (audio) return;
  audio = new Audio();
  audio.volume = state.volume;

  // 监听 loadedmetadata 拿到时长后设定起播时间偏移量
  audio.addEventListener('loadedmetadata', function () {
    if (pendingStartVal) {
      var targetTime = parseStartTime(pendingStartVal, audio.duration);
      pendingStartVal = null; // 清除避免重复触发
      if (targetTime > 0 && targetTime < audio.duration) {
        audio.currentTime = targetTime;
        console.log(`[FIRE] Setting start playback time to: ${targetTime}s (duration: ${audio.duration}s)`);
      }
    }
  });

  audio.addEventListener('play', function () {
    state.isPlaying = true;
    consecutiveFailures = 0; // Reset failure counter on successful play
    lastFailedSongId = null;
    updatePlaybackUI();
    updateListenTogetherPrompt();
  });

  audio.addEventListener('pause', function () {
    state.isPlaying = false;
    updatePlaybackUI();
    updateListenTogetherPrompt();
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

  // 获取起播时间（歌曲特有起播设置优先，其次是剧情触发时的起播设置，最后根据全局范围配置使用起播设置）
  var globalStartPos = state.settings.storySearch && state.settings.storySearch.defaultStartPos;
  var globalStartScope = state.settings.storySearch && state.settings.storySearch.defaultStartPosScope || 'story_only';

  var startVal = song.startTime;
  if (!startVal) {
    if (song.storyPlayTime) {
      startVal = song.storyPlayTime;
    } else if (globalStartScope === 'global') {
      startVal = globalStartPos;
    }
  }
  pendingStartVal = startVal;

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
    var playUrl = null;
    var finalBr = null;
    var size = null;
    var rateLimitHit = false;

    if (song.source === 'local') {
      playUrl = song.url;
      finalBr = 'local';
      size = 0;
    } else if (song.source === 'vkeys_tencent') {
      // vkeys.cn tencent URL resolution
      var vkeysCacheKey = `vkeys_tencent_${song.id}`;
      var vkeysCached = getCache('url', vkeysCacheKey);
      if (vkeysCached) {
        playUrl = vkeysCached.url;
        finalBr = vkeysCached.br;
        size = vkeysCached.size;
      } else {
        try {
          var vkeysRes = await fetch(`https://api.vkeys.cn/music/tencent/song/link?id=${song.id}`);
          var vkeysData = await vkeysRes.json();
          if (vkeysData.code === 0 && vkeysData.data && vkeysData.data.url) {
            playUrl = vkeysData.data.url;
            finalBr = vkeysData.data.kbps || '320';
            size = 0;
            setCache('url', vkeysCacheKey, { url: playUrl, br: finalBr, size: 0 }, 15 * 60 * 1000);
          }
        } catch (err) {
          console.warn('[FIRE] vkeys_tencent URL fetch failed:', err);
        }
      }
    } else {
      // Quality fallbacks: 999 -> 740 -> 320 -> 192 -> 128
      var qualities = ['999', '740', '320', '192', '128'];
      var startQuality = state.settings.audioQuality || '999';
      var startIndex = qualities.indexOf(startQuality);
      if (startIndex === -1) startIndex = 0;

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
    var brStr = finalBr === 'local' ? '本地音源' : (finalBr === '999' ? '24bit无损' : finalBr === '740' ? '16bit无损' : finalBr + 'kbps');
    var sizeStr = size ? ` (${(size / 1024).toFixed(2)}MB)` : '';
    var logMsg = `正在播放: ${song.name} - 音质: ${brStr}${sizeStr}`;
    var time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    errorLogs.unshift(`[${time}] ${logMsg}`);
    if (errorLogs.length > MAX_ERROR_LOGS) errorLogs.pop();
    renderLogsUI();

  } catch (err) {
    console.error("[FIRE] Playback failed:", err);
    // Ignore AbortError / pause interruptions as they are normal lifecycle changes, not actual stream errors
    if (err.name === 'AbortError' || (err.message && err.message.includes('interrupted by a call to pause'))) {
      return;
    }
    handlePlaybackFailure(song, err.message);
    return;
  }

  // 2. Load Lyrics asynchronously
  fetchAndParseLyrics(song.id, song.source);
  // 3. Load Similar Songs recommendation
  fetchAndRenderSimiSongs(song);
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

  if (source === 'local') {
    var currentSong = state.currentSong;
    if (currentSong && currentSong.lyricUrl) {
      try {
        var lyricRes = await fetch(currentSong.lyricUrl);
        if (lyricRes.ok) {
          var lyricText = await lyricRes.text();
          lyricsList = parseLRC(lyricText);
          setCache('lyric', cacheKey, lyricsList);
          renderLyrics();
          updateDesktopLyrics(-1, lyricsList);
          return;
        } else {
          console.warn(`[FIRE] Failed to fetch local lyrics from: ${currentSong.lyricUrl}`);
        }
      } catch (err) {
        console.warn("[FIRE] Failed to load local lyrics:", err);
      }
    }
    lyricsList = [];
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

var _simiSongsCache = [];

async function fetchAndRenderSimiSongs(song) {
  var doc = getDoc();
  var box = doc.getElementById('fire-simi-songs-box');
  var container = doc.getElementById('fire-simi-songs-list');
  if (!box || !container) return;

  if (state.settings.enableSimiSongs === false || !song) {
    box.style.display = 'none';
    return;
  }

  // Only re-fetch if song changed
  if (box.getAttribute('data-loaded-song-id') === String(song.id)) {
    return;
  }

  container.innerHTML = '<div style="opacity:0.5;font-size:11px;text-align:center;padding:4px;"><i class="fa-solid fa-spinner fa-spin"></i> 加载推荐中...</div>';

  var fetchedSongs = [];
  var artistName = Array.isArray(song.artist) ? song.artist[0] : String(song.artist || '').split('/')[0].trim();

  if (artistName) {
    try {
      var gdRes = await fetch(`https://music-api.gdstudio.xyz/api.php?types=search&source=${song.source || 'netease'}&name=${encodeURIComponent(artistName)}&count=10`);
      if (gdRes.ok) {
        var gdData = await gdRes.json();
        if (Array.isArray(gdData)) {
          fetchedSongs = gdData
            .filter(s => String(s.id) !== String(song.id))
            .slice(0, 5)
            .map(s => {
              s.source = song.source || 'netease';
              return s;
            });
        }
      }
    } catch (err) {
      console.warn('[FIRE] SimiSong recommendation fetch failed silently:', err);
    }
  }

  if (fetchedSongs.length > 0) {
    _simiSongsCache = fetchedSongs;
    box.setAttribute('data-loaded-song-id', String(song.id));

    container.innerHTML = _simiSongsCache.map((s, idx) => `
      <div class="fire-simi-item" data-simi-idx="${idx}" title="点击直接播放 ${s.name}">
        <span class="fire-simi-name">${s.name}</span>
        <span class="fire-simi-artist">${Array.isArray(s.artist) ? s.artist.join(' / ') : s.artist}</span>
      </div>
    `).join('');

    container.querySelectorAll('.fire-simi-item').forEach(item => {
      item.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(this.getAttribute('data-simi-idx'), 10);
        if (_simiSongsCache[idx]) {
          playSong(_simiSongsCache[idx]);
        }
      });
    });
  } else {
    container.innerHTML = '<div style="opacity:0.4;font-size:11px;text-align:center;padding:4px;">暂无相似歌曲推荐</div>';
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

    // Separate vkeys sources from gdstudio sources
    var gdSources = sources.filter(s => s !== 'vkeys_tencent');
    var useVkeys = sources.includes('vkeys_tencent');

    var gdPromises = gdSources.map(source =>
      fetchWithRetry(`https://music-api.gdstudio.xyz/api.php?types=search&source=${source}&name=${encodeURIComponent(query)}&count=10&pages=${page}`, {}, 3, 500)
        .then(data => {
          if (!Array.isArray(data)) return [];
          return data.map(song => { song.source = source; return song; });
        })
        .catch(err => {
          if (err.message === "429") rateLimitHit = true;
          else failedSources.push(source);
          console.warn(`[FIRE] Search source ${source} failed:`, err);
          return [];
        })
    );

    var vkeysPromise = useVkeys
      ? fetch(`https://api.vkeys.cn/music/tencent/search/song?keyword=${encodeURIComponent(query)}&page=${page}&limit=10`)
          .then(r => r.json())
          .then(data => {
            if (data.code !== 0 || !data.data || !Array.isArray(data.data.list)) return [];
            return data.data.list.map(item => ({
              id: item.songID,
              name: item.title,
              artist: item.singerList ? item.singerList.map(s => s.name) : [item.singer],
              album: item.album,
              pic_id: item.cover,
              url_id: item.songID,
              lyric_id: item.songMID,
              source: 'vkeys_tencent',
              _vkeys_mid: item.songMID
            }));
          })
          .catch(err => {
            failedSources.push('vkeys_tencent');
            console.warn('[FIRE] vkeys_tencent search failed:', err);
            return [];
          })
      : Promise.resolve([]);

    var promises = [...gdPromises, vkeysPromise];

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
          <div class="fire-settings-sub-item" style="flex-direction: column; align-items: stretch; gap: 4px; margin-top: 4px;">
            <span style="font-size: 11px;">歌词对齐方式</span>
            <select id="fire-setting-lyrics-align" class="fire-select" style="padding: 4px 8px; font-size: 12px; height: 28px;">
              <option value="left">左对齐</option>
              <option value="center">居中对齐</option>
              <option value="right">右对齐</option>
            </select>
          </div>
          <div class="fire-settings-sub-item-slider">
            <div style="display: flex; justify-content: space-between; font-size: 11px;">
              <span>背景不透明度</span>
              <span id="fire-setting-lyrics-opacity-val">60%</span>
            </div>
            <input type="range" id="fire-setting-lyrics-bgopacity" min="0" max="100">
          </div>
          <div class="fire-settings-sub-item" style="flex-direction: column; align-items: stretch; gap: 4px; margin-top: 4px;">
            <span style="font-size: 11px;">歌词显示行数</span>
            <select id="fire-setting-lyrics-contextcount" class="fire-select" style="padding: 4px 8px; font-size: 12px; height: 28px;">
              <option value="0">单行模式 (仅当前句)</option>
              <option value="1">前后各 1 行 (共 3 行)</option>
              <option value="2">前后各 2 行 (共 5 行)</option>
              <option value="3">前后各 3 行 (共 7 行)</option>
            </select>
          </div>
          <div class="fire-settings-sub-item-slider" style="margin-top: 8px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px;">
              <span>歌词字号大小</span>
              <span id="fire-setting-lyrics-fontsize-val">16px</span>
            </div>
            <input type="range" id="fire-setting-lyrics-fontsize" min="12" max="32">
          </div>
          <div class="fire-settings-sub-item-slider" style="margin-top: 8px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px;">
              <span>背景条宽度</span>
              <span id="fire-setting-lyrics-width-val">自适应</span>
            </div>
            <input type="range" id="fire-setting-lyrics-width" min="0" max="800" step="20">
          </div>
          <div class="fire-settings-sub-item-slider" style="margin-top: 8px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px;">
              <span>背景条高度</span>
              <span id="fire-setting-lyrics-height-val">自适应</span>
            </div>
            <input type="range" id="fire-setting-lyrics-height" min="0" max="400" step="10">
          </div>
          <div class="fire-settings-sub-item-slider" style="margin-top: 8px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px;">
              <span>背景条边距 (宽距)</span>
              <span id="fire-setting-lyrics-padding-val">14px</span>
            </div>
            <input type="range" id="fire-setting-lyrics-padding" min="4" max="30" step="1">
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
            <input type="checkbox" name="fire-search-source" value="kugou">
            <span>酷狗音乐 (资源多)</span>
          </label>
          <label class="fire-settings-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer;">
            <input type="checkbox" name="fire-search-source" value="migu">
            <span>咪咕音乐 (版权全/推荐)</span>
          </label>
          <label class="fire-settings-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer;">
            <input type="checkbox" name="fire-search-source" value="tencent">
            <span>QQ 音乐 (部分关闭)</span>
          </label>
          <label class="fire-settings-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer;">
            <input type="checkbox" name="fire-search-source" value="kuwo">
            <span>酷我音乐 (部分关闭)</span>
          </label>
          <label class="fire-settings-item" style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer;">
            <input type="checkbox" name="fire-search-source" value="vkeys_tencent">
            <span>落月QQ音乐 (备用/稳定)</span>
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
          <label class="fire-settings-item" style="display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 13px; cursor: pointer; margin-top: 4px;">
            <span>开启相似歌曲推荐</span>
            <input type="checkbox" id="fire-setting-simi-songs-enable">
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
          <!-- Local Music Toggle -->
          <label class="fire-settings-item" style="display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 13px; cursor: pointer; margin-bottom: 8px;">
            <span>启用本地音乐</span>
            <input type="checkbox" id="fire-setting-local-music-enable">
          </label>
          
          <!-- Part 1: Multi-platform Playlist Import -->
          <div style="margin-bottom: 12px; display: flex; flex-direction: column; gap: 6px;">
            <span style="font-size: 11px; opacity: 0.8;">导入在线歌单 (网易云/酷我/酷狗UID)</span>
            <div style="display: flex; gap: 6px;">
              <select id="fire-import-source-select" class="fire-select" style="height: 28px; padding: 2px 6px; font-size: 12px; width: 95px; flex-shrink: 0;">
                <option value="auto">自动识别</option>
                <option value="netease">网易云</option>
                <option value="kuwo">酷我音乐</option>
                <option value="kugou">酷狗 (UID)</option>
              </select>
              <input type="text" id="fire-import-netease-input" class="fire-input" style="height: 28px; padding: 4px 8px; font-size: 12px; min-width: 0; width: 100%;" placeholder="输入歌单ID、链接或酷狗UID...">
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

      <!-- Section 6.5: Discover Charts Selection -->
      <div class="fire-settings-section" style="margin-top: 8px; border-top: 1px solid var(--fire-border); padding-top: 8px;">
        <div class="fire-settings-section-header" id="fire-settings-header-discovercharts">
          <span>发现榜单展示设置</span>
          <i class="fa-solid fa-chevron-right fire-settings-chevron"></i>
        </div>
        <div class="fire-settings-section-content" id="fire-settings-content-discovercharts" style="display: none; padding-top: 6px;">
          <div style="display: flex; gap: 6px; margin-bottom: 8px;">
            <button id="fire-btn-charts-select-all" class="fire-btn fire-btn-normal" style="padding: 2px 8px; font-size: 11px;">全选</button>
            <button id="fire-btn-charts-clear-all" class="fire-btn fire-btn-normal" style="padding: 2px 8px; font-size: 11px;">清空</button>
            <button id="fire-btn-charts-reset-default" class="fire-btn fire-btn-normal" style="padding: 2px 8px; font-size: 11px;">恢复默认</button>
          </div>
          <div id="fire-discover-charts-selector" style="max-height: 220px; overflow-y: auto; padding-right: 4px;" class="fire-scroll"></div>
        </div>
      </div>

      <!-- Section 7: Story Search (injected from story-search.js) -->
      ${renderStorySearchSettingsHTML()}

      <div class="fire-settings-section" style="margin-top: 8px; border-top: 1px solid var(--fire-border); padding-top: 8px;">
        <div class="fire-settings-section-header" id="fire-settings-header-listen">
          <span>一起听设置<span class="fire-listen-help-btn" style="margin-left:5px;font-size:13px;cursor:pointer;opacity:0.6;" title="查看说明书">?</span></span>
          <i class="fa-solid fa-chevron-right fire-settings-chevron"></i>
        </div>
        <div class="fire-settings-section-content" id="fire-settings-content-listen" style="display: none; padding-top: 4px;">
          <label class="fire-settings-item" style="justify-content: space-between;">
            <span>启用一起听</span>
            <input type="checkbox" id="fire-setting-listen-enabled">
          </label>
          <div class="fire-settings-sub-item" style="flex-direction: column; align-items: stretch; gap: 4px; margin-top: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 11px;">提示词内容模板</span>
              <i class="fa-solid fa-expand fire-listen-template-expand-btn" style="cursor: pointer; opacity: 0.7; font-size: 12px;" title="全屏编辑"></i>
            </div>
            <textarea id="fire-setting-listen-template" class="fire-textarea"
              style="height: 60px; padding: 6px 8px; font-size: 11px; resize: vertical; font-family: monospace; background: rgba(0,0,0,0.25); border: 1px solid var(--fire-border); color: inherit; border-radius: 4px;"
              placeholder="支持占位符：{{song}}, {{artist}}, {{tags}}, {{lyrics}}, {{play_tag}}, {{play_example}}"></textarea>
            <span style="font-size: 10px; opacity: 0.5; line-height: 1.2;">可用占位符：{{song}} (歌名), {{artist}} (歌手), {{tags}} (标签), {{lyrics}} (歌词), {{play_tag}} (点歌宏格式), {{play_example}} (播歌指令例句)</span>
          </div>
          <div class="fire-settings-sub-item" style="flex-direction: column; align-items: stretch; gap: 4px; margin-top: 4px;">
            <span style="font-size: 11px;">歌词发送范围</span>
            <select id="fire-setting-listen-lyricscount" class="fire-select" style="padding: 4px 8px; font-size: 12px; height: 28px;">
              <option value="0">不发送歌词</option>
              <option value="3">发送 3 行（当前行 + 前后各 1 行）</option>
              <option value="5" selected>发送 5 行（当前行 + 前后各 2 行）</option>
              <option value="7">发送 7 行（当前行 + 前后各 3 行）</option>
              <option value="all">发送全部歌词</option>
            </select>
          </div>
          <div class="fire-settings-sub-item" style="flex-direction: column; align-items: stretch; gap: 4px; margin-top: 4px;">
            <span style="font-size: 11px;">注入位置</span>
            <select id="fire-setting-listen-position" class="fire-select" style="padding: 4px 8px; font-size: 12px; height: 28px;">
              <option value="-1">不注入 (None)</option>
              <option value="1">In-chat @ Depth (聊天中指定深度)</option>
            </select>
          </div>
          <div id="fire-setting-listen-depth-container" class="fire-settings-sub-item" style="display: none; flex-direction: column; align-items: stretch; gap: 4px; margin-top: 4px;">
            <div style="display: flex; gap: 8px;">
              <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                <span style="font-size: 11px;">插入深度</span>
                <input type="number" id="fire-setting-listen-depth" class="fire-textarea" style="height: 28px; padding: 4px 8px; font-size: 12px; border: 1px solid var(--fire-border); border-radius: 4px; background: rgba(0,0,0,0.25); color: inherit;" min="0" max="999" value="4">
              </div>
              <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
                <span style="font-size: 11px;">插入角色</span>
                <select id="fire-setting-listen-role" class="fire-select" style="padding: 4px 8px; font-size: 12px; height: 28px;">
                  <option value="0">System (系统)</option>
                  <option value="1">User (用户)</option>
                  <option value="2">Assistant (助手)</option>
                </select>
              </div>
            </div>
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
        <button id="fire-tab-btn-discover" class="fire-tab-btn" title="发现榜单">
          <i class="fa-solid fa-fire"></i>
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
          <div class="fire-song-title-row" style="display: flex; align-items: center; justify-content: center; gap: 6px; position: relative;">
            <div id="fire-song-title" class="fire-song-title">无正在播放歌曲</div>
            <button id="fire-btn-simi-toggle" class="fire-btn-simi-toggle" style="display: none; background: none; border: none; padding: 2px 4px; font-size: 12px; color: var(--fire-accent, #a855f7); cursor: pointer; opacity: 0.85; transition: opacity 0.2s;" title="查看相似歌曲推荐">
              <i class="fa-solid fa-shuffle"></i>
            </button>
          </div>
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

        <!-- Similar Songs Recommendation Box (Default Hidden) -->
        <div id="fire-simi-songs-box" class="fire-simi-songs-box" style="display: none; margin-top: 10px; width: 100%;">
          <div class="fire-simi-header" style="display: flex; align-items: center; justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: bold;">
              <i class="fa-solid fa-shuffle" style="color: var(--fire-accent, #a855f7);"></i>
              <span>相似歌曲推荐</span>
            </div>
            <button id="fire-simi-append-all-btn" class="fire-btn fire-btn-normal" style="padding: 1px 6px; font-size: 10px;" title="将推荐歌曲追加到当前播放列表">
              <i class="fa-solid fa-plus" style="font-size: 9px; margin-right: 2px;"></i>全部追加
            </button>
          </div>
          <div id="fire-simi-songs-list" class="fire-simi-songs-list" style="margin-top: 6px;">
            <div style="opacity:0.5;font-size:11px;text-align:center;">暂无推荐</div>
          </div>
        </div>
      </div>
      
      <!-- Right Side Tab Lists -->
      <div class="fire-tabs-column" id="fire-tabs-column">
        <div class="fire-tab-panels">
          <!-- Search Tab -->
          <div id="fire-tab-panel-search" class="fire-tab-panel active">
            <form id="fire-search-form" class="fire-search-form" onsubmit="return false;">
              <input type="text" id="fire-search-input" class="fire-input" placeholder="输入歌名或歌手搜索..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
              <button type="submit" id="fire-search-btn" class="fire-btn">搜索</button>
            </form>
            <div id="fire-search-source-filter" class="fire-source-filter-bar"></div>
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
              <button id="fire-btn-playlist-add-local" class="fire-btn" style="padding: 8px 10px; display: ${state.settings.localPlaybackEnabled ? '' : 'none'};" title="添加本地/直链歌曲">
                <i class="fa-solid fa-file-audio"></i>
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

          <!-- Discover Tab -->
          <div id="fire-tab-panel-discover" class="fire-tab-panel">
            <div class="fire-discover-header">
              <span class="fire-discover-title">网易云热门榜单</span>
              <button id="fire-discover-refresh-btn" class="fire-btn fire-btn-normal" style="padding:4px 10px;font-size:11px;" title="重新加载">刷新</button>
            </div>
            <div class="fire-discover-list fire-scroll" id="fire-discover-list">
              <div style="text-align:center;padding:20px;opacity:0.5;font-size:12px;">点击「发现」标签加载榜单</div>
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
  bindStorySearchUIEvents(doc);
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

  // 本地音乐 Settings Loading
  var chkLocalMusic = doc.getElementById('fire-setting-local-music-enable');
  if (chkLocalMusic) chkLocalMusic.checked = !!state.settings.localPlaybackEnabled;

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

  var selectAlign = doc.getElementById('fire-setting-lyrics-align');
  if (selectAlign) selectAlign.value = state.settings.desktopLyricsAlign || 'center';

  var inputBgOpacity = doc.getElementById('fire-setting-lyrics-bgopacity');
  var valOpacity = doc.getElementById('fire-setting-lyrics-opacity-val');
  var initialOpacity = state.settings.desktopLyricsBgOpacity !== undefined ? state.settings.desktopLyricsBgOpacity : 60;
  if (inputBgOpacity) inputBgOpacity.value = initialOpacity;
  if (valOpacity) valOpacity.textContent = initialOpacity + '%';

  var selectContextCount = doc.getElementById('fire-setting-lyrics-contextcount');
  if (selectContextCount) selectContextCount.value = state.settings.desktopLyricsContextCount !== undefined ? state.settings.desktopLyricsContextCount.toString() : '0';

  var inputFontSize = doc.getElementById('fire-setting-lyrics-fontsize');
  var valFontSize = doc.getElementById('fire-setting-lyrics-fontsize-val');
  var initialFontSize = state.settings.desktopLyricsFontSize !== undefined ? state.settings.desktopLyricsFontSize : 16;
  if (inputFontSize) inputFontSize.value = initialFontSize;
  if (valFontSize) valFontSize.textContent = initialFontSize + 'px';

  var inputWidth = doc.getElementById('fire-setting-lyrics-width');
  var valWidth = doc.getElementById('fire-setting-lyrics-width-val');
  var initialWidth = state.settings.desktopLyricsWidth !== undefined ? state.settings.desktopLyricsWidth : 0;
  if (inputWidth) inputWidth.value = initialWidth;
  if (valWidth) valWidth.textContent = initialWidth === 0 ? '自适应' : initialWidth + 'px';

  var inputHeight = doc.getElementById('fire-setting-lyrics-height');
  var valHeight = doc.getElementById('fire-setting-lyrics-height-val');
  var initialHeight = state.settings.desktopLyricsHeight !== undefined ? state.settings.desktopLyricsHeight : 0;
  if (inputHeight) inputHeight.value = initialHeight;
  if (valHeight) valHeight.textContent = initialHeight === 0 ? '自适应' : initialHeight + 'px';

  var inputPadding = doc.getElementById('fire-setting-lyrics-padding');
  var valPadding = doc.getElementById('fire-setting-lyrics-padding-val');
  var initialPadding = state.settings.desktopLyricsPadding !== undefined ? state.settings.desktopLyricsPadding : 14;
  if (inputPadding) inputPadding.value = initialPadding;
  if (valPadding) valPadding.textContent = initialPadding + 'px';

  var inputToggleMethod = doc.getElementById('fire-setting-lyrics-togglemethod');
  if (inputToggleMethod) inputToggleMethod.value = state.settings.desktopLyricsToggleMethod || 'none';

  // 一起听 Settings Loading
  var chkListenEnabled = doc.getElementById('fire-setting-listen-enabled');
  if (chkListenEnabled) chkListenEnabled.checked = !!state.settings.listenTogetherEnabled;

  var txtListenTemplate = doc.getElementById('fire-setting-listen-template');
  if (txtListenTemplate) {
    txtListenTemplate.value = state.settings.listenTogetherTemplate || '[一起听]\n用户当前正在听：{{song}} - {{artist}}\n标签：{{tags}}\n当前歌词：\n{{lyrics}}';
  }

  var selListenLyricsCount = doc.getElementById('fire-setting-listen-lyricscount');
  if (selListenLyricsCount) {
    selListenLyricsCount.value = state.settings.listenTogetherLyricsCount || '5';
  }

  var selListenPosition = doc.getElementById('fire-setting-listen-position');
  if (selListenPosition) {
    selListenPosition.value = state.settings.listenTogetherPosition !== undefined ? state.settings.listenTogetherPosition : '1';
  }

  var inputListenDepth = doc.getElementById('fire-setting-listen-depth');
  if (inputListenDepth) {
    inputListenDepth.value = state.settings.listenTogetherDepth !== undefined ? state.settings.listenTogetherDepth : 4;
  }

  var selListenRole = doc.getElementById('fire-setting-listen-role');
  if (selListenRole) {
    selListenRole.value = state.settings.listenTogetherRole !== undefined ? state.settings.listenTogetherRole : '0';
  }

  var depthContainer = doc.getElementById('fire-setting-listen-depth-container');
  if (depthContainer) {
    depthContainer.style.display = (selListenPosition && selListenPosition.value === '1') ? 'flex' : 'none';
  }

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
    state.settings.searchSources = ['netease', 'joox', 'bilibili', 'vkeys_tencent'];
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
    setupCollapsibleSetting('fire-settings-header-discovercharts', 'fire-settings-content-discovercharts');
    setupCollapsibleSetting('fire-settings-header-listen', 'fire-settings-content-listen');

    renderDiscoverChartsSettings();
  }

  // Playlist Manager - Local Music Toggle Event
  var chkLocalMusic = doc.getElementById('fire-setting-local-music-enable');
  if (chkLocalMusic) {
    chkLocalMusic.addEventListener('change', function () {
      state.settings.localPlaybackEnabled = !!this.checked;
      saveState();
      var btnAddLocal = doc.getElementById('fire-btn-playlist-add-local');
      if (btnAddLocal) {
        btnAddLocal.style.display = state.settings.localPlaybackEnabled ? '' : 'none';
      }
    });
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

  // Similar Songs Toggle Button Event (Next to song title)
  var btnSimiToggle = doc.getElementById('fire-btn-simi-toggle');
  var simiBox = doc.getElementById('fire-simi-songs-box');
  if (btnSimiToggle && simiBox) {
    btnSimiToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      var isHidden = simiBox.style.display === 'none';
      if (isHidden) {
        simiBox.style.display = 'block';
        if (state.currentSong) {
          fetchAndRenderSimiSongs(state.currentSong);
        }
      } else {
        simiBox.style.display = 'none';
      }
    });
  }

  // Similar Songs Toggle Event in Settings
  var chkSimiSongs = doc.getElementById('fire-setting-simi-songs-enable');
  if (chkSimiSongs) {
    chkSimiSongs.checked = state.settings.enableSimiSongs !== false;
    chkSimiSongs.addEventListener('change', function () {
      state.settings.enableSimiSongs = !!this.checked;
      saveState();
      updatePlaybackUI();
    });
  }

  // Similar Songs Append All Event
  var btnSimiAppend = doc.getElementById('fire-simi-append-all-btn');
  if (btnSimiAppend) {
    btnSimiAppend.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!_simiSongsCache || _simiSongsCache.length === 0) {
        showToast('暂无推荐歌曲可追加');
        return;
      }
      var targetName = state.currentPlaylist;
      if (targetName === '__active_queue__') {
        if (!Array.isArray(state.activeQueue)) state.activeQueue = [];
        var existingIds = new Set(state.activeQueue.map(s => s.id));
        var newSongs = _simiSongsCache.filter(s => !existingIds.has(s.id));
        state.activeQueue = state.activeQueue.concat(newSongs);
      } else {
        if (!targetName || !state.playlists[targetName]) {
          targetName = Object.keys(state.playlists)[0] || '默认歌单';
          if (!state.playlists[targetName]) state.playlists[targetName] = [];
          state.currentPlaylist = targetName;
        }
        var existingIds = new Set((state.playlists[targetName] || []).map(s => s.id));
        var newSongs = _simiSongsCache.filter(s => !existingIds.has(s.id));
        state.playlists[targetName] = (state.playlists[targetName] || []).concat(newSongs);
      }
      saveState();
      renderPlaylistOptions();
      renderPlaylistSongs();
      showToast(`已追加 ${_simiSongsCache.length} 首相似推荐歌曲`);
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
      ensureDesktopLyrics(lyricsList, lastActiveLineIdx);
    });
  }

  // Control Buttons Type Dropdown
  var selectCtrlType = doc.getElementById('fire-setting-lyrics-ctrl-type');
  if (selectCtrlType) {
    selectCtrlType.addEventListener('change', function () {
      state.settings.desktopLyricsControlsType = this.value;
      saveState();
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

  // Alignment Selector
  var selectAlign = doc.getElementById('fire-setting-lyrics-align');
  if (selectAlign) {
    selectAlign.addEventListener('change', function () {
      state.settings.desktopLyricsAlign = this.value;
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

  // Context Count Selector
  var selectContextCount = doc.getElementById('fire-setting-lyrics-contextcount');
  if (selectContextCount) {
    selectContextCount.addEventListener('change', function () {
      state.settings.desktopLyricsContextCount = parseInt(this.value, 10) || 0;
      saveState();
      updateDesktopLyrics(lastActiveLineIdx, lyricsList);
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

  // Width Slider
  var inputWidth = doc.getElementById('fire-setting-lyrics-width');
  var valWidth = doc.getElementById('fire-setting-lyrics-width-val');
  if (inputWidth) {
    inputWidth.addEventListener('input', function () {
      var val = parseInt(this.value, 10) || 0;
      state.settings.desktopLyricsWidth = val;
      if (valWidth) valWidth.textContent = val === 0 ? '自适应' : val + 'px';
      saveState();
      applyDesktopLyricsSettings();
    });
  }

  // Height Slider
  var inputHeight = doc.getElementById('fire-setting-lyrics-height');
  var valHeight = doc.getElementById('fire-setting-lyrics-height-val');
  if (inputHeight) {
    inputHeight.addEventListener('input', function () {
      var val = parseInt(this.value, 10) || 0;
      state.settings.desktopLyricsHeight = val;
      if (valHeight) valHeight.textContent = val === 0 ? '自适应' : val + 'px';
      saveState();
      applyDesktopLyricsSettings();
    });
  }

  // Padding Slider
  var inputPadding = doc.getElementById('fire-setting-lyrics-padding');
  var valPadding = doc.getElementById('fire-setting-lyrics-padding-val');
  if (inputPadding) {
    inputPadding.addEventListener('input', function () {
      var val = parseInt(this.value, 10) || 14;
      state.settings.desktopLyricsPadding = val;
      if (valPadding) valPadding.textContent = val + 'px';
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

  // 一起听 Settings Bindings
  var chkListenEnabled = doc.getElementById('fire-setting-listen-enabled');
  if (chkListenEnabled) {
    chkListenEnabled.addEventListener('change', function () {
      state.settings.listenTogetherEnabled = this.checked;
      saveState();
      updateListenTogetherPrompt();
    });
  }

  var txtListenTemplate = doc.getElementById('fire-setting-listen-template');
  if (txtListenTemplate) {
    txtListenTemplate.addEventListener('change', function () {
      state.settings.listenTogetherTemplate = this.value;
      saveState();
      updateListenTogetherPrompt();
    });
  }

  var selListenLyricsCount = doc.getElementById('fire-setting-listen-lyricscount');
  if (selListenLyricsCount) {
    selListenLyricsCount.addEventListener('change', function () {
      state.settings.listenTogetherLyricsCount = this.value;
      saveState();
      updateListenTogetherPrompt();
    });
  }

  var selListenPosition = doc.getElementById('fire-setting-listen-position');
  if (selListenPosition) {
    selListenPosition.addEventListener('change', function () {
      state.settings.listenTogetherPosition = parseInt(this.value, 10);
      saveState();
      updateListenTogetherPrompt();
      var depthContainer = doc.getElementById('fire-setting-listen-depth-container');
      if (depthContainer) {
        depthContainer.style.display = (this.value === '1') ? 'flex' : 'none';
      }
    });
  }

  var inputListenDepth = doc.getElementById('fire-setting-listen-depth');
  if (inputListenDepth) {
    inputListenDepth.addEventListener('change', function () {
      var val = parseInt(this.value, 10);
      if (isNaN(val) || val < 0) val = 0;
      state.settings.listenTogetherDepth = val;
      saveState();
      updateListenTogetherPrompt();
    });
  }

  var selListenRole = doc.getElementById('fire-setting-listen-role');
  if (selListenRole) {
    selListenRole.addEventListener('change', function () {
      state.settings.listenTogetherRole = parseInt(this.value, 10);
      saveState();
      updateListenTogetherPrompt();
    });
  }

  var btnListenHelp = doc.querySelector('.fire-listen-help-btn');
  if (btnListenHelp) {
    btnListenHelp.addEventListener('click', function (e) {
      e.stopPropagation();
      showListenTogetherHelp();
    });
  }

  var btnListenExpand = doc.querySelector('.fire-listen-template-expand-btn');
  if (btnListenExpand) {
    btnListenExpand.addEventListener('click', function (e) {
      e.stopPropagation();
      showFullScreenListenTogetherEditor();
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
  var tabDiscover = doc.getElementById('fire-tab-btn-discover');
  if (tabDiscover) {
    tabDiscover.addEventListener('click', function () {
      switchTab('discover');
    });
  }

  // Search Submit
  var searchForm = doc.getElementById('fire-search-form');
  var searchInput = doc.getElementById('fire-search-input');
  if (searchForm && searchInput) {
    // Prevent key/input events from bubbling up to SillyTavern global keyboard listeners (resolves typing lag)
    ['keydown', 'keyup', 'keypress', 'input', 'compositionstart', 'compositionend'].forEach(function(evtType) {
      searchInput.addEventListener(evtType, function(e) {
        e.stopPropagation();
      });
    });

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

  // Playlist Actions: New, Add Local, Rename, Delete
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

  var btnAddLocal = doc.getElementById('fire-btn-playlist-add-local');
  if (btnAddLocal) {
    btnAddLocal.addEventListener('click', function () {
      if (state.currentPlaylist === "__active_queue__") {
        showToast("无法直接添加本地歌曲到当前队列，请先选择一个歌单");
        return;
      }
      showAddLocalSongDialog().then(songData => {
        if (!songData) return;
        
        var songId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        var newSong = {
          id: songId,
          name: songData.name,
          artist: songData.artist,
          album: '本地歌曲',
          coverUrl: songData.cover || DEFAULT_COVER,
          source: 'local',
          url: songData.url,
          lyricUrl: songData.lyric || null
        };
        
        if (!state.playlists[state.currentPlaylist]) {
          state.playlists[state.currentPlaylist] = [];
        }
        state.playlists[state.currentPlaylist].push(newSong);
        saveState();
        renderPlaylistSongs();
        showToast(`已成功添加本地歌曲 "${songData.name}"`);
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
  if (tabName === 'discover') {
    renderDiscoverTab();
  }
}

function updateTabUI() {
  var doc = getDoc();
  var tabNowPlaying = doc.getElementById('fire-tab-btn-nowplaying');
  var tabSearch = doc.getElementById('fire-tab-btn-search');
  var tabPlaylists = doc.getElementById('fire-tab-btn-playlists');
  var tabDiscover = doc.getElementById('fire-tab-btn-discover');
  
  var panelPlayer = doc.getElementById('fire-player-column');
  var panelTabs = doc.getElementById('fire-tabs-column');
  
  var panelSearch = doc.getElementById('fire-tab-panel-search');
  var panelPlaylists = doc.getElementById('fire-tab-panel-playlists');
  var panelDiscover = doc.getElementById('fire-tab-panel-discover');

  if (!tabNowPlaying || !tabSearch || !tabPlaylists) return;

  // Remove active class from all tabs
  [tabNowPlaying, tabSearch, tabPlaylists, tabDiscover].filter(Boolean).forEach(t => t.classList.remove('active'));

  // Add active to current
  if (activeTab === 'nowplaying') {
    tabNowPlaying.classList.add('active');
  } else if (activeTab === 'search') {
    tabSearch.classList.add('active');
  } else if (activeTab === 'playlists') {
    tabPlaylists.classList.add('active');
  } else if (activeTab === 'discover') {
    if (tabDiscover) tabDiscover.classList.add('active');
  }

  var isMobile = (window.parent || window).innerWidth <= 760;

  if (isMobile) {
    if (activeTab === 'nowplaying') {
      if (panelPlayer) panelPlayer.style.setProperty('display', 'flex', 'important');
      if (panelTabs) panelTabs.style.setProperty('display', 'none', 'important');
    } else {
      if (panelPlayer) panelPlayer.style.setProperty('display', 'none', 'important');
      if (panelTabs) panelTabs.style.setProperty('display', 'flex', 'important');
      
      [panelSearch, panelPlaylists, panelDiscover].filter(Boolean).forEach(p => p.classList.remove('active'));
      if (activeTab === 'search' && panelSearch) panelSearch.classList.add('active');
      else if (activeTab === 'playlists' && panelPlaylists) panelPlaylists.classList.add('active');
      else if (activeTab === 'discover' && panelDiscover) panelDiscover.classList.add('active');
    }
  } else {
    // Desktop: Player is always shown, tabs column is always shown
    if (panelPlayer) panelPlayer.style.removeProperty('display');
    if (panelTabs) panelTabs.style.removeProperty('display');

    [panelSearch, panelPlaylists, panelDiscover].filter(Boolean).forEach(p => p.classList.remove('active'));
    if (activeTab === 'search' && panelSearch) panelSearch.classList.add('active');
    else if (activeTab === 'playlists' && panelPlaylists) panelPlaylists.classList.add('active');
    else if (activeTab === 'discover' && panelDiscover) panelDiscover.classList.add('active');
  }
}

// ─── Discover Tab ─────────────────────────────────────────────────────────────

var DEFAULT_ENABLED_CHARTS = [19723756, 3779629, 3778678, 2884035, 2250011882, 5453912201, 71385702, 71384707, 10520166, 60198, 60131, 2809577409];

var DISCOVER_CHARTS = [
  // 🏆 核心主打
  { id: 19723756,   name: '飙升榜',         category: '核心主打', desc: '上升最快的歌曲排行，每日更新' },
  { id: 3779629,    name: '新歌榜',         category: '核心主打', desc: '最新上线的热门歌曲，每日更新' },
  { id: 3778678,    name: '热歌榜',         category: '核心主打', desc: '一周内用户收听最热歌曲，每日更新' },
  { id: 2884035,    name: '原创榜',         category: '核心主打', desc: '独立原创音乐排行榜，每周四更新' },

  // 🔥 流行热度
  { id: 8246775932, name: '实时热度榜',     category: '流行热度', desc: '实时热度上升最快100首，每小时更新' },
  { id: 18176153161,name: '实时分享榜',     category: '流行热度', desc: '站内实时分享热度高的歌曲' },
  { id: 6723173524, name: '网络热歌榜',     category: '流行热度', desc: '热门网络爆款歌曲，每周五更新' },
  { id: 13372522766,name: '潮流风向榜',     category: '流行热度', desc: '潮流音乐风向标，每日更新' },
  { id: 5338990334, name: '潜力爆款榜',     category: '流行热度', desc: '全民PICK潜力好歌，每周二更新' },
  { id: 6688069460, name: '听歌识曲榜',     category: '流行热度', desc: '按用户听歌识曲次数排列，每周四更新' },
  { id: 21845217,   name: 'KTV唛榜',       category: '流行热度', desc: 'KTV热唱好歌榜，每周五更新' },
  { id: 7775163417, name: '赏音榜',         category: '流行热度', desc: '歌曲鉴赏互动热度榜，每日更新' },
  { id: 7603212484, name: 'LOOK直播榜',    category: '流行热度', desc: 'LOOK直播近7日热度最高歌曲，每周二更新' },
  { id: 9651277674, name: 'AI歌曲榜',       category: '流行热度', desc: '最新最热AI生成歌曲，每日更新' },

  // 💿 黑胶VIP
  { id: 5453912201, name: '黑胶VIP爱听榜',  category: '黑胶VIP', desc: '黑胶VIP高频播放热歌，每周四更新' },
  { id: 7785066739, name: '黑胶VIP热歌榜',  category: '黑胶VIP', desc: '播放和付费热度会员歌曲，每日更新' },
  { id: 7785123708, name: '黑胶VIP新歌榜',  category: '黑胶VIP', desc: '新晋会员歌曲TOP50，每日更新' },
  { id: 7785091694, name: '黑胶VIP爱搜榜',  category: '黑胶VIP', desc: '会员搜索播放热度TOP50，每日更新' },
  { id: 12344472377,name: '黑胶VIP限免榜',  category: '黑胶VIP', desc: '热度最高限免播放歌曲TOP50，每日更新' },

  // 🎵 细分曲风
  { id: 5059642708, name: '国风榜',         category: '细分曲风', desc: '国风古风精品歌曲，每周五更新' },
  { id: 991319590,  name: '中文说唱榜',     category: '细分曲风', desc: '热门中文Hip-Hop说唱，每周五更新' },
  { id: 14028249541,name: '全球说唱榜',     category: '细分曲风', desc: '全球Hip-Hop说唱单曲，每周五更新' },
  { id: 1978921795, name: '电音榜',         category: '细分曲风', desc: '热门电子音乐舞曲，每周五更新' },
  { id: 5059633707, name: '摇滚榜',         category: '细分曲风', desc: '一周内收听摇滚歌曲TOP，每周五更新' },
  { id: 5059661515, name: '民谣榜',         category: '细分曲风', desc: '一周内收听民谣歌曲TOP，每周五更新' },
  { id: 71384707,   name: '古典榜',         category: '细分曲风', desc: '一周内收听古典歌曲TOP，每周四更新' },
  { id: 6886768100, name: '中文慢摇DJ榜',   category: '细分曲风', desc: '慢摇DJ网络热歌，每周四更新' },
  { id: 7356827205, name: 'BEAT排行榜',     category: '细分曲风', desc: '热门Beat作品排行榜，每周四更新' },
  { id: 12225155968,name: '欧美R&B榜',      category: '细分曲风', desc: '节奏布鲁斯(R&B)官方TOP，每周五更新' },
  { id: 3812895,    name: 'Beatport电音榜', category: '细分曲风', desc: 'Beatport全球电子舞曲榜，每周三更新' },
  { id: 8537588450, name: '星电音潮音榜',   category: '细分曲风', desc: '星电音联盟派对潮音榜，每周五更新' },
  { id: 8661209031, name: '乐夏榜',         category: '细分曲风', desc: '乐队的夏天官方榜单，每周一更新' },

  // 🎮 ACG二次元
  { id: 71385702,   name: 'ACG综合榜',      category: 'ACG二次元', desc: 'ACG二次元音乐排行榜，每周四更新' },
  { id: 3001835560, name: 'ACG动画榜',      category: 'ACG二次元', desc: '每天热度上升最快100首ACG动画单曲，每日更新' },
  { id: 3001795926, name: 'ACG游戏榜',      category: 'ACG二次元', desc: '每天热度上升最快100首ACG游戏单曲，每日更新' },
  { id: 3001890046, name: 'VOCALOID榜',     category: 'ACG二次元', desc: 'V家虚拟歌手歌曲榜，每日更新' },

  // 🌐 全球语种
  { id: 2809513713, name: '欧美热歌榜',     category: '全球语种', desc: '一周内收听欧美歌曲TOP，每周四更新' },
  { id: 2809577409, name: '欧美新歌榜',     category: '全球语种', desc: '欧美新晋热门歌曲，每日更新' },
  { id: 5059644681, name: '日语榜',         category: '全球语种', desc: '一周内收听日语歌曲TOP，每周二更新' },
  { id: 745956260,  name: '韩语榜',         category: '全球语种', desc: '一周内收听韩语歌曲TOP，每周四更新' },
  { id: 60198,      name: 'Billboard榜',    category: '全球语种', desc: '美国公告牌周榜，每周三更新' },
  { id: 180106,     name: 'UK英国榜',       category: '全球语种', desc: '英国UK官方周榜，每日更新' },
  { id: 60131,      name: '日本Oricon榜',   category: '全球语种', desc: '日本公信榜热门歌曲，每日更新' },
  { id: 6732051320, name: '俄语榜',         category: '全球语种', desc: '俄罗斯语歌曲TOP，每周四更新' },
  { id: 6939992364, name: '俄罗斯top hit榜', category: '全球语种', desc: '俄罗斯全球广播YouTube热播榜，每周五更新' },
  { id: 27135204,   name: '法国NRJ榜',      category: '全球语种', desc: '法国NRJ Vos Hits周榜，每周五更新' },
  { id: 7095271308, name: '泰语榜',         category: '全球语种', desc: '泰语歌曲TOP排行榜，每周四更新' },
  { id: 6732014811, name: '越南语榜',       category: '全球语种', desc: '越南语歌曲TOP排行榜，每周四更新' },

  // 🚘 车载与品牌
  { id: 8703179781, name: '特斯拉车友榜',   category: '车载电台', desc: '特斯拉车主热播音乐，每周一更新' },
  { id: 8703052295, name: '理想车友榜',     category: '车载电台', desc: '理想车主热播音乐，每周一更新' },
  { id: 8702582160, name: '比亚迪车友榜',   category: '车载电台', desc: '比亚迪车主热播音乐，每周一更新' },
  { id: 8703220480, name: '蔚来车友榜',     category: '车载电台', desc: '蔚来车主热播音乐，每周一更新' },
  { id: 8702982391, name: '极氪车友榜',     category: '车载电台', desc: '极氪车主热播音乐，每周一更新' },
  { id: 12717025277,name: '吉利车友榜',     category: '车载电台', desc: '吉利车主热播音乐，每周一更新' },

  // 🤝 音乐合伙人与游戏
  { id: 12911403728,name: '合伙人推荐榜',   category: '音乐合伙人', desc: '音乐合伙人推荐榜，每周一更新' },
  { id: 12911589513,name: '合伙人热歌榜',   category: '音乐合伙人', desc: '音乐合伙人热歌榜，每周一更新' },
  { id: 12911619970,name: '合伙人留名榜',   category: '音乐合伙人', desc: '音乐合伙人留名榜，每周一更新' },
  { id: 12768855486,name: '合伙人高分榜',   category: '音乐合伙人', desc: '音乐合伙人高分榜，每日更新' },
  { id: 8532443277, name: '蛋仔派对听歌榜',  category: '音乐合伙人', desc: '蛋仔派对官方游戏原声榜，每周五更新' }
];

var _discoverCache = {};

function renderDiscoverChartsSettings() {
  var doc = getDoc();
  var container = doc.getElementById('fire-discover-charts-selector');
  if (!container) return;

  if (!state.settings.enabledDiscoverCharts) {
    state.settings.enabledDiscoverCharts = [...DEFAULT_ENABLED_CHARTS];
  }

  var enabledSet = new Set(state.settings.enabledDiscoverCharts);

  // Group by category
  var categories = {};
  DISCOVER_CHARTS.forEach(chart => {
    var cat = chart.category || '其他榜单';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(chart);
  });

  var html = '';
  Object.keys(categories).forEach(cat => {
    html += `<div style="font-weight:bold;font-size:11px;opacity:0.8;margin:6px 0 3px 0;border-bottom:1px dashed rgba(255,255,255,0.1);padding-bottom:2px;">${cat}</div>`;
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;">';
    categories[cat].forEach(chart => {
      var isChecked = enabledSet.has(chart.id) ? 'checked' : '';
      html += `
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${chart.name} (${chart.desc})">
          <input type="checkbox" class="fire-chart-select-chk" value="${chart.id}" ${isChecked}>
          <span>${chart.name}</span>
        </label>
      `;
    });
    html += '</div>';
  });

  container.innerHTML = html;

  // Bind checkbox changes
  container.querySelectorAll('.fire-chart-select-chk').forEach(chk => {
    chk.addEventListener('change', function() {
      var val = parseInt(this.value, 10);
      var current = new Set(state.settings.enabledDiscoverCharts || []);
      if (this.checked) {
        current.add(val);
      } else {
        current.delete(val);
      }
      state.settings.enabledDiscoverCharts = Array.from(current);
      saveState();
      renderDiscoverTab(false);
    });
  });

  // Bind Top Action Buttons (All, Clear, Reset)
  var btnSelectAll = doc.getElementById('fire-btn-charts-select-all');
  var btnClearAll = doc.getElementById('fire-btn-charts-clear-all');
  var btnResetDefault = doc.getElementById('fire-btn-charts-reset-default');

  if (btnSelectAll) {
    btnSelectAll.onclick = function() {
      state.settings.enabledDiscoverCharts = DISCOVER_CHARTS.map(c => c.id);
      saveState();
      renderDiscoverChartsSettings();
      renderDiscoverTab(false);
    };
  }
  if (btnClearAll) {
    btnClearAll.onclick = function() {
      state.settings.enabledDiscoverCharts = [];
      saveState();
      renderDiscoverChartsSettings();
      renderDiscoverTab(false);
    };
  }
  if (btnResetDefault) {
    btnResetDefault.onclick = function() {
      state.settings.enabledDiscoverCharts = [...DEFAULT_ENABLED_CHARTS];
      saveState();
      renderDiscoverChartsSettings();
      renderDiscoverTab(false);
    };
  }
}

async function renderDiscoverTab(forceRefresh) {
  var doc = getDoc();
  var container = doc.getElementById('fire-discover-list');
  if (!container) return;

  var enabledIds = state.settings.enabledDiscoverCharts || DEFAULT_ENABLED_CHARTS;
  var visibleCharts = DISCOVER_CHARTS.filter(c => enabledIds.includes(c.id));

  if (visibleCharts.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:30px 10px;opacity:0.6;font-size:12px;">
        <i class="fa-solid fa-folder-open" style="font-size:24px;margin-bottom:8px;display:block;"></i>
        暂无展示的榜单<br>
        <span style="font-size:11px;opacity:0.8;">请在右上角设置 ⚙️ -> 发现榜单展示设置 中勾选要显示的榜单</span>
      </div>
    `;
    return;
  }

  container.innerHTML = '<div style="text-align:center;padding:20px;opacity:0.6;font-size:13px;"><i class="fa-solid fa-spinner fa-spin"></i> 正在加载榜单...</div>';

  // Bind refresh button (safe to re-bind)
  var refreshBtn = doc.getElementById('fire-discover-refresh-btn');
  if (refreshBtn) {
    refreshBtn.onclick = function() {
      _discoverCache = {};
      renderDiscoverTab(true);
    };
  }

  // Render chart cards (lazy: fetch previews in background)
  container.innerHTML = visibleCharts.map((chart, idx) => `
    <div class="fire-chart-card" id="fire-chart-card-${idx}" data-chart-idx="${idx}">
      <div class="fire-chart-card-info">
        <div class="fire-chart-card-name">${chart.name}</div>
        <div class="fire-chart-card-desc">${chart.desc}</div>
        <div class="fire-chart-card-preview" id="fire-chart-preview-${idx}">
          <span style="opacity:0.4;font-size:11px;">加载中...</span>
        </div>
      </div>
      <div class="fire-chart-card-actions">
        <button class="fire-btn fire-btn-discover-append" data-chart-idx="${idx}" title="追加到当前播放列表末尾">+ 追加</button>
        <button class="fire-btn fire-btn-normal fire-btn-discover-replace" data-chart-idx="${idx}" title="替换当前播放列表">替换</button>
      </div>
    </div>
  `).join('');

  // Bind action buttons
  container.querySelectorAll('.fire-btn-discover-append').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var cardIdx = parseInt(this.getAttribute('data-chart-idx'));
      var chart = visibleCharts[cardIdx];
      if (chart) {
        var realIdx = DISCOVER_CHARTS.findIndex(c => c.id === chart.id);
        loadChartIntoPlaylist(realIdx, 'append');
      }
    });
  });
  container.querySelectorAll('.fire-btn-discover-replace').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var cardIdx = parseInt(this.getAttribute('data-chart-idx'));
      var chart = visibleCharts[cardIdx];
      if (chart) {
        var realIdx = DISCOVER_CHARTS.findIndex(c => c.id === chart.id);
        loadChartIntoPlaylist(realIdx, 'replace');
      }
    });
  });

  // Fetch all charts in background to fill previews
  visibleCharts.forEach((chart, idx) => {
    fetchChartData(chart.id, idx, forceRefresh);
  });
}

async function fetchChartData(chartId, idx, forceRefresh) {
  var doc = getDoc();
  var cacheKey = 'chart_' + chartId;

  var cached = !forceRefresh && _discoverCache[cacheKey];
  if (!cached) {
    try {
      var res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=playlist&source=netease&id=${chartId}`);
      var data = await res.json();
      if (data && data.playlist) {
        _discoverCache[cacheKey] = data;
        cached = data;
      }
    } catch(e) {
      console.warn('[FIRE] Discover: Failed to fetch chart', chartId, e);
    }
  }

  if (!cached) return;

  var playlist = cached.playlist;

  // Update preview (top 5 songs)
  var previewEl = doc.getElementById('fire-chart-preview-' + idx);
  if (previewEl && playlist.tracks && playlist.tracks.length > 0) {
    var top5 = playlist.tracks.slice(0, 5).map((t, i) => {
      var artistNames = Array.isArray(t.ar) ? t.ar.map(a => a.name).join(' / ') : '';
      return `<div class="fire-chart-preview-row"><span class="fire-chart-rank">${i+1}</span><span class="fire-chart-preview-name">${t.name}</span><span class="fire-chart-preview-artist">${artistNames}</span></div>`;
    }).join('');
    var total = playlist.trackCount || playlist.tracks.length;
    previewEl.innerHTML = top5 + `<div style="opacity:0.4;font-size:11px;margin-top:4px;">共 ${total} 首歌曲</div>`;
  }
}

async function loadChartIntoPlaylist(chartIdx, mode) {
  var chart = DISCOVER_CHARTS[chartIdx];
  if (!chart) return;

  var cacheKey = 'chart_' + chart.id;
  var cached = _discoverCache[cacheKey];

  showToast('正在加载 ' + chart.name + '...');

  if (!cached) {
    try {
      var res = await fetch(`https://music-api.gdstudio.xyz/api.php?types=playlist&source=netease&id=${chart.id}`);
      var data = await res.json();
      if (data && data.playlist) {
        _discoverCache[cacheKey] = data;
        cached = data;
      }
    } catch(e) {
      showToast('加载失败: ' + (e.message || e));
      return;
    }
  }

  if (!cached || !cached.playlist || !cached.playlist.tracks) {
    showToast('榜单数据为空或加载失败');
    return;
  }

  var tracks = cached.playlist.tracks;
  var songs = tracks.map(t => ({
    id: t.id,
    name: t.name,
    artist: Array.isArray(t.ar) ? t.ar.map(a => a.name) : [],
    album: t.al ? t.al.name : '',
    pic_id: t.al ? (t.al.pic_str || String(t.al.pic || '')) : '',
    url_id: t.id,
    lyric_id: t.id,
    source: 'netease',
    coverUrl: t.al && t.al.picUrl ? t.al.picUrl : ''
  }));

  var targetName = state.currentPlaylist;

  if (targetName === '__active_queue__') {
    if (!Array.isArray(state.activeQueue)) state.activeQueue = [];
    if (mode === 'replace') {
      state.activeQueue = songs;
    } else {
      var existingIds = new Set(state.activeQueue.map(s => s.id));
      var newSongs = songs.filter(s => !existingIds.has(s.id));
      state.activeQueue = state.activeQueue.concat(newSongs);
    }
  } else {
    if (!targetName || !state.playlists[targetName]) {
      var keys = Object.keys(state.playlists);
      if (keys.length > 0) {
        targetName = keys[0];
      } else {
        targetName = '默认歌单';
        state.playlists[targetName] = [];
      }
      state.currentPlaylist = targetName;
    }

    if (mode === 'replace') {
      state.playlists[targetName] = songs;
    } else {
      var existingIds = new Set((state.playlists[targetName] || []).map(s => s.id));
      var newSongs = songs.filter(s => !existingIds.has(s.id));
      state.playlists[targetName] = (state.playlists[targetName] || []).concat(newSongs);
    }
  }

  saveState();
  renderPlaylistOptions();
  renderPlaylistSongs();
  showToast((mode === 'replace' ? '已替换' : '已追加') + '「' + chart.name + '」（' + songs.length + ' 首）');
  switchTab('playlists');
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
  var simiBtn = doc.getElementById('fire-btn-simi-toggle');

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
    if (simiBtn) simiBtn.style.display = (state.settings.enableSimiSongs !== false) ? 'inline-block' : 'none';
  } else {
    if (cd) {
      cd.src = DEFAULT_COVER;
      cd.classList.remove('playing');
    }
    if (title) title.textContent = "无正在播放歌曲";
    if (artist) artist.textContent = "请选择歌曲播放";
    if (simiBtn) simiBtn.style.display = 'none';
    var box = doc.getElementById('fire-simi-songs-box');
    if (box) box.style.display = 'none';
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
    updateListenTogetherPrompt();
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
var currentSearchSourceFilter = 'all';

var SOURCE_NAMES = {
  'all': '全部',
  'netease': '网易云',
  'vkeys_tencent': 'QQ音乐',
  'tencent': 'QQ音乐',
  'joox': 'JOOX',
  'bilibili': 'B站',
  'kugou': '酷狗',
  'kuwo': '酷我',
  'migu': '咪咕'
};

function renderSourceFilterBar() {
  var doc = getDoc();
  var container = doc.getElementById('fire-search-source-filter');
  if (!container) return;

  var activeSources = state.settings.searchSources || ['netease', 'joox', 'bilibili'];
  var filterOptions = ['all', ...activeSources];

  container.innerHTML = filterOptions.map(src => {
    var name = SOURCE_NAMES[src] || src;
    var isActive = currentSearchSourceFilter === src ? 'active' : '';
    return `<button class="fire-filter-chip ${isActive}" data-source="${src}">${name}</button>`;
  }).join('');

  container.querySelectorAll('.fire-filter-chip').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var targetSource = this.getAttribute('data-source');
      currentSearchSourceFilter = targetSource;
      renderSourceFilterBar();
      renderSearchResults();
    });
  });
}

function renderSearchResults() {
  var doc = getDoc();
  var container = doc.getElementById('fire-search-results');
  var pagination = doc.getElementById('fire-search-pagination');
  if (!container) return;

  renderSourceFilterBar();

  var displaySongs = currentSearchSongs;
  if (currentSearchSourceFilter !== 'all') {
    displaySongs = currentSearchSongs.filter(s => s.source === currentSearchSourceFilter);
  }

  if (displaySongs.length === 0) {
    if (pagination) pagination.style.display = 'none';
    if (!currentSearchQuery) {
      container.innerHTML = '<div style="text-align:center;padding:4px;opacity:0.5;font-size:12px;margin-top:20px;">在上方输入关键词搜索歌曲</div>';
    } else {
      var srcName = SOURCE_NAMES[currentSearchSourceFilter] || currentSearchSourceFilter;
      container.innerHTML = `<div style="text-align:center;padding:4px;opacity:0.5;font-size:12px;margin-top:20px;">未在【${srcName}】音源中找到匹配歌曲</div>`;
    }
    return;
  }

  if (pagination) {
    pagination.style.display = 'flex';
    var pageNum = doc.getElementById('fire-page-num');
    if (pageNum) pageNum.textContent = `第 ${currentSearchPage} 页`;
  }

  container.innerHTML = '';
  displaySongs.forEach(song => {
    var item = doc.createElement('div');
    var isPlayingThis = state.currentSong && state.currentSong.id === song.id;
    item.className = 'fire-music-item' + (isPlayingThis ? ' playing' : '');
    
    var artistName = Array.isArray(song.artist) ? song.artist.join(' / ') : song.artist;
    
    var sourceBadges = {
      'netease': '<span class="fire-source-badge netease">网易</span>',
      'tencent': '<span class="fire-source-badge tencent">QQ</span>',
      'kuwo': '<span class="fire-source-badge kuwo">酷我</span>',
      'kugou': '<span class="fire-source-badge kugou">酷狗</span>',
      'migu': '<span class="fire-source-badge migu">咪咕</span>',
      'joox': '<span class="fire-source-badge joox">JOOX</span>',
      'bilibili': '<span class="fire-source-badge bilibili">B站</span>',
      'vkeys_tencent': '<span class="fire-source-badge vkeys">落月QQ</span>'
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
      'bilibili': '<span class="fire-source-badge bilibili">B站</span>',
      'local': '<span class="fire-source-badge local">本地</span>'
    };
    var badge = sourceBadges[song.source] || '<span class="fire-source-badge">其它</span>';

    var tagBadges = Array.isArray(song.tags) && song.tags.length > 0
      ? song.tags.map(function(t) { return `<span class="fire-tag-badge" data-tag="${t.replace(/"/g,'&quot;')}">${t}</span>`; }).join('')
      : '';
    var startTimeBadge = song.startTime
      ? `<span class="fire-time-badge" style="background:rgba(59, 130, 246, 0.15);color:#60a5fa;border:1px solid rgba(59, 130, 246, 0.3);padding:2px 6px;border-radius:4px;font-size:10px;margin-right:4px;cursor:pointer;" title="点击修改起播时间"><i class="fa-solid fa-clock"></i> ${song.startTime}</span>`
      : '';
    var tagDisplay = !isVirtual
      ? `<div class="fire-tag-row">${startTimeBadge}${tagBadges}<span class="fire-tag-add">＋标签</span></div>`
      : '';

    item.innerHTML = `
      <div style="font-size:11px;opacity:0.5;width:16px;text-align:right;">${idx + 1}</div>
      <div class="fire-music-item-info">
        <div class="fire-music-item-title">${badge} ${song.name}</div>
        <div class="fire-music-item-meta">${artistName} - ${song.album || '未知专辑'}</div>
        ${tagDisplay}
      </div>
      <div class="fire-music-item-actions">
        ${song.album ? `<button class="fire-music-item-btn album-btn" title="查看专辑"><i class="fa-solid fa-compact-disc"></i></button>` : ''}
        ${!isVirtual ? `<button class="fire-music-item-btn time-btn" title="编辑起播时间"><i class="fa-solid fa-clock"></i></button>` : ''}
        ${!isVirtual ? `<button class="fire-music-item-btn tag-btn" title="编辑 Tag"><i class="fa-solid fa-tag"></i></button>` : ''}
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

    if (!isVirtual) {
      // Tag 按钮
      var tagBtn = item.querySelector('.tag-btn');
      if (tagBtn) {
        tagBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          openTagEditor(song, function () { saveState(); renderPlaylistSongs(); });
        });
      }
      // 起播时间按钮
      var timeBtn = item.querySelector('.time-btn');
      if (timeBtn) {
        timeBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          openStartTimeEditor(song, function () { saveState(); renderPlaylistSongs(); });
        });
      }
      // 点击已有标签删除
      item.querySelectorAll('.fire-tag-badge').forEach(function (badge) {
        badge.addEventListener('click', function (e) {
          e.stopPropagation();
          var tag = this.dataset.tag;
          if (!Array.isArray(song.tags)) return;
          var tidx = song.tags.indexOf(tag);
          if (tidx !== -1) { song.tags.splice(tidx, 1); saveState(); renderPlaylistSongs(); }
        });
      });
      // 点击起播时间标签修改
      var timeBadge = item.querySelector('.fire-time-badge');
      if (timeBadge) {
        timeBadge.addEventListener('click', function (e) {
          e.stopPropagation();
          openStartTimeEditor(song, function () { saveState(); renderPlaylistSongs(); });
        });
      }
      // 「＋标签」快捷添加
      var addTagEl = item.querySelector('.fire-tag-add');
      if (addTagEl) {
        addTagEl.addEventListener('click', function (e) {
          e.stopPropagation();
          openTagEditor(song, function () { saveState(); renderPlaylistSongs(); });
        });
      }
    }

    if (song.album) {
      item.querySelector('.album-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        viewAlbum(song.album, song.source);
      });
    }

    container.appendChild(item);
  });
}

// ─── Tag 编辑器 ───────────────────────────────────────────────────────────────
function openTagEditor(song, onSave) {
  if (!Array.isArray(song.tags)) song.tags = [];
  var current = song.tags.join(', ');
  showPrompt(
    '输入 Tag（多个用逗号分隔，点击歌单中的标签可删除）：',
    current,
    `编辑 Tag —— ${song.name}`
  ).then(function (val) {
    if (val === null || val === undefined) return; // 取消
    var tags = val.split(/[,，]+/).map(function (t) { return t.trim(); }).filter(Boolean);
    song.tags = tags;
    saveState();
    if (typeof onSave === 'function') onSave();
  });
}

function openStartTimeEditor(song, onSave) {
  showPrompt(
    '请输入这首歌的起播时间（支持：分数如 1/3，百分比如 30%，分:秒如 01:20，秒数如 45，留空为默认）：',
    song.startTime || '',
    `编辑起播时间 —— ${song.name}`
  ).then(function (timeVal) {
    if (timeVal !== null && timeVal !== undefined) {
      var cleanTime = timeVal.trim();
      if (cleanTime) {
        song.startTime = cleanTime;
      } else {
        delete song.startTime;
      }
      saveState();
      if (typeof onSave === 'function') onSave();
    }
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
              var exists = localSongs.some(ls => String(ls.id) === String(song.id));
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

async function importPlaylist(inputStr) {
  if (!inputStr) return;

  var doc = getDoc();
  var sourceSelect = doc.getElementById('fire-import-source-select');
  var selectedSource = sourceSelect ? sourceSelect.value : 'auto';

  var trimmed = inputStr.trim();
  var source = selectedSource;

  if (source === 'auto') {
    if (/kuwo\.cn/.test(trimmed)) {
      source = 'kuwo';
    } else if (/kugou\.com/.test(trimmed)) {
      source = 'kugou';
    } else if (/qq\.com|y\.qq\.com/.test(trimmed)) {
      source = 'tencent';
    } else {
      source = 'netease';
    }
  }

  if (source === 'tencent' || source === 'migu') {
    showToast("QQ/咪咕歌单由于平台加密机制限制，暂不支持在线链接直接导入，建议导入网易云/酷我歌单");
    return;
  }

  var playlistId = '';
  if (source === 'kugou') {
    var uidMatch = trimmed.match(/[?&](?:uid|userid|specialid)=([0-9]+)/i) || trimmed.match(/\/u\/([0-9]+)/i);
    if (uidMatch) {
      playlistId = uidMatch[1];
    } else if (/^[0-9]+$/.test(trimmed)) {
      playlistId = trimmed;
    }
    if (!playlistId) {
      showToast("未在链接中检测到酷狗数字 UID。请使用带有 uid= 的链接或纯数字 UID(如 569471137)");
      return;
    }
  } else {
    // Check query parameters like ?id=, &id=
    var paramMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/i);
    if (paramMatch) {
      playlistId = paramMatch[1];
    } else {
      // Check path patterns like /playlist/xxx, /playlist_detail/xxx, /album/xxx, /special/xxx
      var pathMatch = trimmed.match(/\/(?:playlist|songlist|playlist_detail|album|special|detail|id)\/([a-zA-Z0-9_-]+)/i);
      if (pathMatch) {
        playlistId = pathMatch[1];
      } else if (/^[\w-]+$/.test(trimmed)) {
        playlistId = trimmed;
      }
    }
  }

  if (!playlistId) {
    showToast("无法解析出有效的歌单ID或链接，请检查输入");
    return;
  }

  var sourceNames = {
    'netease': '网易云',
    'kuwo': '酷我音乐',
    'kugou': '酷狗音乐'
  };
  var sName = sourceNames[source] || '网易云';
  showToast(`正在拉取${sName}歌单中...`);

  try {
    var tracks = [];
    var playlistName = source === 'kugou' ? `酷狗收藏歌单_${playlistId}` : `${sName}导入歌单_${playlistId}`;

    // Primary Attempt: GD Studio API (NetEase/KuWo)
    if (source !== 'kugou') {
      try {
        var gdData = await fetchWithRetry(`https://music-api.gdstudio.xyz/api.php?types=playlist&source=${source}&id=${playlistId}`, {}, 2, 800);
        if (gdData && (!gdData.detail || !gdData.detail.includes('not supported'))) {
          if (Array.isArray(gdData)) {
            tracks = gdData;
          } else if (gdData && typeof gdData === 'object') {
            if (gdData.playlist) {
              if (Array.isArray(gdData.playlist)) {
                tracks = gdData.playlist;
              } else if (typeof gdData.playlist === 'object') {
                playlistName = (gdData.playlist.name || playlistName).trim();
                tracks = gdData.playlist.tracks || gdData.playlist.list || gdData.playlist.songs || [];
              }
            } else if (gdData.tracks || gdData.list || gdData.songs) {
              playlistName = (gdData.name || gdData.title || playlistName).trim();
              tracks = gdData.tracks || gdData.list || gdData.songs || [];
            }
          }
        }
      } catch (e) {
        console.warn('[FIRE] Primary GD Studio playlist API fetch failed, trying Meting fallback...', e);
      }
    }

    // Meting API (supports KuGou numeric UID/IDs as well as NetEase/KuWo fallback)
    if (!tracks || tracks.length === 0) {
      try {
        var metingData = await fetchWithRetry(`https://api.injahow.cn/meting/?server=${source}&type=playlist&id=${playlistId}`, {}, 2, 800);
        if (Array.isArray(metingData) && metingData.length > 0) {
          tracks = metingData;
        }
      } catch (e) {
        console.warn('[FIRE] Meting playlist API fetch failed:', e);
      }
    }

    if (!tracks || tracks.length === 0) {
      showToast("该歌单中没有可导入的曲目或未能获取到数据");
      return;
    }

    var importedSongs = tracks.map(track => {
      var urlIdMatch = (track.url || '').match(/[?&]id=([a-zA-Z0-9_-]+)/);
      var songId = track.id || track.songid || track.mid || (urlIdMatch ? urlIdMatch[1] : ('id_' + Math.random().toString(36).substr(2, 6)));
      var songName = track.name || track.songname || track.title || '未知歌曲';

      var artistName = '未知歌手';
      if (track.ar && Array.isArray(track.ar)) {
        artistName = track.ar.map(a => a.name).join(' / ');
      } else if (track.artist) {
        artistName = Array.isArray(track.artist) ? track.artist.join(' / ') : track.artist;
      } else if (track.singer && Array.isArray(track.singer)) {
        artistName = track.singer.map(s => s.name || s).join(' / ');
      }

      var albumName = (track.al && track.al.name) || track.album || track.albumname || '未知专辑';
      var coverUrl = track.cover || track.pic || (track.al && track.al.picUrl) || null;
      if (coverUrl && window.location.protocol === 'https:' && coverUrl.startsWith('http://')) {
        coverUrl = coverUrl.replace('http://', 'https://');
      }

      var picId = track.pic_id || (track.al && (track.al.pic_str || track.al.pic)) || null;

      return {
        id: songId,
        name: songName,
        artist: artistName,
        album: albumName,
        pic_id: picId,
        coverUrl: coverUrl,
        source: source
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
      var exists = localSongs.some(ls => String(ls.id) === String(song.id));
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
    var errMsg = err.message || '';
    if (errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError') || errMsg.includes('fetch')) {
      errMsg = "网络连接异常/接口被拦截 (请检查网络或代理软件)";
    }
    triggerError("歌单导入失败: " + errMsg);
  }
}

// Alias for backwards compatibility
var importNetEasePlaylist = importPlaylist;

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

function isButtonMounted() {
  var doc = getDoc();
  var mode = state.settings.displayMode || 'wand-modal';
  if (mode.indexOf('qr-') === 0) {
    var btn = doc.getElementById('fire-qr-btn');
    var container = doc.querySelector('#qr--bar .qr--buttons') || 
                    doc.querySelector('#qr-bar .qr--buttons') || 
                    doc.getElementById('qr--bar') || 
                    doc.getElementById('qr-bar');
    return !!(btn && container && container.contains(btn));
  } else if (mode.indexOf('wand-') === 0) {
    var wandBtn = doc.getElementById('fire_wand_entry');
    var wandContainer = doc.getElementById('FIRE_wand_container') || 
                        doc.getElementById('fire_wand_container') || 
                        doc.getElementById('extensionsMenu') || 
                        doc.querySelector('#extensionsMenu.options-content');
    return !!(wandBtn && wandContainer && wandContainer.contains(wandBtn));
  }
  return true;
}

function runSelfHealingInjection() {
  ensureWandButton();
  ensureQRButton();
}

function throttledRunSelfHealingInjection() {
  var doc = getDoc();
  if (doc.hidden) return; // Do not execute DOM queries when tab is in background

  if (isInjectionPending) return;
  isInjectionPending = true;
  var win = getWin();
  var raf = win.requestAnimationFrame || window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
  raf(function () {
    runSelfHealingInjection();
    isInjectionPending = false;

    // Self-terminating interval optimization:
    // If button is successfully mounted, stop the polling interval immediately!
    if (isButtonMounted() && window.fireInjectionInterval) {
      clearInterval(window.fireInjectionInterval);
      window.fireInjectionInterval = null;
    }
  });
}

function initUIInjection() {
  throttledRunSelfHealingInjection();

  // 1. Subscribe to SillyTavern native eventSource events
  try {
    if (eventSource && event_types) {
      eventSource.on(event_types.CHAT_CHANGED, throttledRunSelfHealingInjection);
      eventSource.on(event_types.APP_READY, throttledRunSelfHealingInjection);
    }
  } catch (e) {}

  // 2. Scoped MutationObserver listening on #send_form
  try {
    var doc = getDoc();
    var win = getWin();
    var MutationObserverClass = win.MutationObserver || win.parent?.MutationObserver || window.MutationObserver;
    var targetNode = doc.getElementById('send_form') || doc.body;

    if (MutationObserverClass && targetNode) {
      if (qrBtnObserver) {
        qrBtnObserver.disconnect();
      }
      qrBtnObserver = new MutationObserverClass(function (mutations) {
        if (!isButtonMounted()) {
          var hasChildChanges = mutations.some(function (m) { return m.type === 'childList'; });
          if (hasChildChanges) {
            throttledRunSelfHealingInjection();
          }
        }
      });
      qrBtnObserver.observe(targetNode, { childList: true, subtree: true });
    }
  } catch (err) {
    console.warn("[FIRE] MutationObserver initialization delayed:", err);
  }

  // 3. Limited discrete polling fallback (max 5 retries, self-terminates on success or after 15s)
  if (window.fireInjectionInterval) {
    clearInterval(window.fireInjectionInterval);
  }
  injectionRetryCount = 0;
  window.fireInjectionInterval = setInterval(function () {
    injectionRetryCount++;
    throttledRunSelfHealingInjection();

    if (isButtonMounted() || injectionRetryCount >= 5) {
      clearInterval(window.fireInjectionInterval);
      window.fireInjectionInterval = null;
    }
  }, 3000);

  // 4. Page Visibility API: check once when returning from background
  try {
    var docVis = getDoc();
    if (!window.fireVisibilityListenerAdded) {
      window.fireVisibilityListenerAdded = true;
      docVis.addEventListener('visibilitychange', function () {
        if (!docVis.hidden) {
          throttledRunSelfHealingInjection();
        }
      });
    }
  } catch (e) {}
}

function showAddLocalSongDialog() {
  return new Promise((resolve) => {
    var doc = getDoc();
    var modal = doc.createElement('div');
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.backgroundColor = 'rgba(0,0,0,0.6)';
    modal.style.zIndex = '999999';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.backdropFilter = 'blur(4px)';

    modal.innerHTML = `
      <div style="background: var(--fire-bg-opaque, #080d14); border: 1px solid var(--fire-border, rgba(255,255,255,0.15)); border-radius: 8px; width: 400px; padding: 20px; color: var(--fire-text, #f3f4f6); font-family: sans-serif; box-shadow: 0 4px 20px rgba(0,0,0,0.5); display: flex; flex-direction: column; gap: 16px;">
        <h3 style="margin: 0; font-size: 16px; border-bottom: 1px solid var(--fire-border); padding-bottom: 8px; color: var(--fire-text);">添加本地/直链歌曲</h3>
        
        <!-- 教程部分 -->
        <div style="background: rgba(255, 255, 255, 0.05); border: 1px dashed var(--fire-border); border-radius: 6px; padding: 10px; font-size: 11px; line-height: 1.4; color: var(--fire-text); opacity: 0.9;">
          <strong>💡 快速使用教程：</strong><br>
          1. <strong>本地音乐</strong>：将文件放入 SillyTavern <code>public</code> 目录中（推荐新建 <code>public/scripts/extensions/third-party/FIRE/songs/</code>）并输入相对路径。<br>
          2. <strong>网络直链</strong>：支持直接在第一栏填入完整的网络音频直链（如 <code>https://example.com/music.mp3</code>）进行流媒体播放！
        </div>

        <!-- 📂 扫描文件夹导入 -->
        <button id="local-song-scan-folder-btn" class="fire-btn" style="padding: 6px 12px; font-size: 12px; height: 32px; display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: bold;">
          <i class="fa-solid fa-folder-open"></i> 一键扫描文件夹导入全部歌曲
        </button>
        <input type="file" id="local-song-folder-input" webkitdirectory directory multiple style="display: none;">

        <div style="text-align: center; font-size: 11px; opacity: 0.5; margin: -4px 0;">— 或者手动添加单曲 —</div>

        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <label style="font-size: 12px; font-weight: bold; color: var(--fire-text); opacity: 0.9;">音频相对路径/直链 *</label>
            <input type="text" id="local-song-url" class="fire-input" style="height: 28px; padding: 4px 8px; font-size: 12px; color: var(--fire-text); background: rgba(0, 0, 0, 0.2); border: 1px solid var(--fire-border);" placeholder="输入路径后会自动解析其他字段...">
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <label style="font-size: 12px; font-weight: bold; color: var(--fire-text); opacity: 0.9;">歌曲名称 *</label>
            <input type="text" id="local-song-name" class="fire-input" style="height: 28px; padding: 4px 8px; font-size: 12px; color: var(--fire-text); background: rgba(0, 0, 0, 0.2); border: 1px solid var(--fire-border);" placeholder="例如: 晴天">
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <label style="font-size: 12px; font-weight: bold; color: var(--fire-text); opacity: 0.9;">歌手名称</label>
            <input type="text" id="local-song-artist" class="fire-input" style="height: 28px; padding: 4px 8px; font-size: 12px; color: var(--fire-text); background: rgba(0, 0, 0, 0.2); border: 1px solid var(--fire-border);" placeholder="例如: 周杰伦">
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <label style="font-size: 12px; font-weight: bold; color: var(--fire-text); opacity: 0.9;">封面相对路径/直链 (可选)</label>
            <input type="text" id="local-song-cover" class="fire-input" style="height: 28px; padding: 4px 8px; font-size: 12px; color: var(--fire-text); background: rgba(0, 0, 0, 0.2); border: 1px solid var(--fire-border);" placeholder="留空则自动生成或使用默认封面">
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <label style="font-size: 12px; font-weight: bold; color: var(--fire-text); opacity: 0.9;">歌词相对路径/直链 (可选)</label>
            <input type="text" id="local-song-lyric" class="fire-input" style="height: 28px; padding: 4px 8px; font-size: 12px; color: var(--fire-text); background: rgba(0, 0, 0, 0.2); border: 1px solid var(--fire-border);" placeholder="留空则自动生成或不加载歌词">
          </div>
        </div>
        
        <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--fire-border); padding-top: 12px;">
          <button id="local-song-cancel" class="fire-btn fire-btn-normal" style="padding: 6px 12px; font-size: 12px; height: 30px;">取消</button>
          <button id="local-song-ok" class="fire-btn" style="padding: 6px 12px; font-size: 12px; height: 30px;">确认添加</button>
        </div>
      </div>
    `;

    doc.body.appendChild(modal);

    var urlInput = modal.querySelector('#local-song-url');
    var nameInput = modal.querySelector('#local-song-name');
    var artistInput = modal.querySelector('#local-song-artist');
    var coverInput = modal.querySelector('#local-song-cover');
    var lyricInput = modal.querySelector('#local-song-lyric');

    var scanFolderBtn = modal.querySelector('#local-song-scan-folder-btn');
    var folderInput = modal.querySelector('#local-song-folder-input');

    // 扫描文件夹事件绑定
    if (scanFolderBtn && folderInput) {
      scanFolderBtn.addEventListener('click', function () {
        folderInput.click();
      });

      folderInput.addEventListener('change', function (e) {
        var files = e.target.files;
        if (!files || files.length === 0) return;

        showPrompt(
          "系统将根据该文件夹下的文件自动生成歌曲、封面和歌词映射。\n请输入此文件夹在 SillyTavern 中的网页相对访问根路径：",
          "/scripts/extensions/third-party/FIRE/songs/",
          "自动扫描文件夹"
        ).then(function (basePath) {
          if (basePath === null) return;
          basePath = basePath.trim();
          if (!basePath.endsWith('/')) {
            basePath += '/';
          }

          // 分组文件（按去后缀的文件名）
          var fileGroups = {};
          for (var i = 0; i < files.length; i++) {
            var file = files[i];
            var name = file.name;
            var lastDot = name.lastIndexOf('.');
            if (lastDot === -1) continue;

            var baseName = name.substring(0, lastDot);
            var ext = name.substring(lastDot).toLowerCase();

            if (!fileGroups[baseName]) {
              fileGroups[baseName] = {};
            }

            if (['.mp3', '.flac', '.wav', '.ogg', '.m4a'].indexOf(ext) !== -1) {
              fileGroups[baseName].audio = name;
            } else if (['.jpg', '.jpeg', '.png', '.webp'].indexOf(ext) !== -1) {
              fileGroups[baseName].cover = name;
            } else if (ext === '.lrc') {
              fileGroups[baseName].lyric = name;
            }
          }

          var importedCount = 0;
          var playlist = state.playlists[state.currentPlaylist] || [];

          for (var baseName in fileGroups) {
            var group = fileGroups[baseName];
            if (!group.audio) continue; // 没有音频文件跳过

            // 从文件名解析歌名与歌手
            var songName = baseName;
            var artistName = '本地歌手';
            var separators = [' - ', ' -', '- ', '-'];
            for (var j = 0; j < separators.length; j++) {
              var s = separators[j];
              var idx = baseName.indexOf(s);
              if (idx !== -1) {
                artistName = baseName.substring(0, idx).trim();
                songName = baseName.substring(idx + s.length).trim();
                break;
              }
            }

            var songId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
            var newSong = {
              id: songId,
              name: songName,
              artist: artistName,
              album: '本地歌曲',
              coverUrl: group.cover ? (basePath + group.cover) : DEFAULT_COVER,
              source: 'local',
              url: basePath + group.audio,
              lyricUrl: group.lyric ? (basePath + group.lyric) : null
            };

            playlist.push(newSong);
            importedCount++;
          }

          if (importedCount > 0) {
            state.playlists[state.currentPlaylist] = playlist;
            saveState();
            renderPlaylistSongs();
            showToast(`已自动扫描并成功导入 ${importedCount} 首歌曲！`);
            modal.remove();
            resolve(null);
          } else {
            showToast("所选文件夹中未找到任何音频文件（支持 mp3, flac, wav, m4a 等）");
          }
        });
      });
    }

    // 单曲智能解析逻辑
    urlInput.addEventListener('input', function () {
      var val = urlInput.value.trim();
      if (!val) return;

      // 提取文件名
      var lastSlash = Math.max(val.lastIndexOf('/'), val.lastIndexOf('\\'));
      var filename = lastSlash !== -1 ? val.substring(lastSlash + 1) : val;

      // 去除后缀
      var lastDot = filename.lastIndexOf('.');
      var nameWithoutExt = lastDot !== -1 ? filename.substring(0, lastDot) : filename;

      var songName = nameWithoutExt;
      var artistName = '';

      // 检测 "歌手 - 歌名" 格式
      var separators = [' - ', ' -', '- ', '-'];
      for (var i = 0; i < separators.length; i++) {
        var s = separators[i];
        var idx = nameWithoutExt.indexOf(s);
        if (idx !== -1) {
          artistName = nameWithoutExt.substring(0, idx).trim();
          songName = nameWithoutExt.substring(idx + s.length).trim();
          break;
        }
      }

      // 如果尚未输入或者为默认，则自动填充
      if (!nameInput.value.trim() || nameInput.value.trim() === songName) {
        nameInput.value = songName;
      }
      if ((!artistInput.value.trim() || artistInput.value.trim() === '本地歌手') && artistName) {
        artistInput.value = artistName;
      }

      // 自动推断同名封面与歌词路径
      var basePart = lastDot !== -1 ? val.substring(0, lastDot) : val;
      if (!coverInput.value.trim() || coverInput.value.trim() === basePart + '.jpg') {
        coverInput.value = basePart + '.jpg';
      }
      if (!lyricInput.value.trim() || lyricInput.value.trim() === basePart + '.lrc') {
        lyricInput.value = basePart + '.lrc';
      }
    });

    modal.querySelector('#local-song-cancel').addEventListener('click', function () {
      modal.remove();
      resolve(null);
    });

    modal.querySelector('#local-song-ok').addEventListener('click', function () {
      var name = nameInput.value.trim();
      var artist = artistInput.value.trim() || '本地歌手';
      var url = urlInput.value.trim();
      var cover = coverInput.value.trim();
      var lyric = lyricInput.value.trim();

      if (!name || !url) {
        showToast("请填写歌曲名称和音频相对路径！");
        return;
      }

      modal.remove();
      resolve({ name: name, artist: artist, url: url, cover: cover, lyric: lyric });
    });
  });
}

// ─── Extension Initializer ────────────────────────────────────────────────────
export function init() {
  loadState();
  initLyricsWidget(state, getDoc, saveState, {
    playNext: playNext,
    playPrev: playPrev,
    togglePlay: togglePlayPause
  });
  initStorySearch(state, {
    playSong:     playSong,
    triggerError: triggerError,
    showToast:    showToast,
    saveState:    saveState,
    getDoc:       getDoc,
    setCache:     setCache,
    getCache:     getCache,
  });
  initListenTogether(
    state,
    getDoc,
    saveState,
    eventSource,
    event_types,
    function () { return lyricsList; },
    function () { return lastActiveLineIdx; }
  );
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
