/**
 * story-search.js — 剧情搜歌模块 (FIRE Music Player)
 *
 * 职责：
 *  - 解析用户自定义播歌标签格式 → 正则
 *  - 监听 CHARACTER_MESSAGE_RENDERED 事件，将标签替换为可观察锚点
 *  - 用 IntersectionObserver 实现「读到哪里，音乐在哪里响起」
 *  - 支持歌单限制模式（模糊匹配 + fallback）
 *  - 支持多标签策略（4种）与重复触发控制
 *  - 搜歌失败自动重试（5次），写入现有日志系统
 *  - 世界书条目直接写入（新建 / 当前角色世界书）
 */

import { eventSource, event_types, this_chid, characters } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import {
  loadWorldInfo,
  saveWorldInfo,
  createWorldInfoEntry,
  createNewWorldInfo,
  updateWorldInfoList,
  reloadEditor,
} from '../../../../scripts/world-info.js';

// ─── 模块私有状态 ─────────────────────────────────────────────────────────────
var _state = null;
var _playSong = null;
var _triggerError = null;
var _showToast = null;
var _saveState = null;
var _getDoc = null;
var _setCache = null;
var _getCache = null;

var _observer = null;
var _chatObserver = null;

// 每条消息内标签触发计数 { msgId: count }
var _triggerCountByMsg = {};
// 每条消息的最后触发时间 { msgId: timestamp }
var _lastTriggerTimeByMsg = {};
var _lastTriggeredMsgId = null;

// 当前播放是否由剧情触发
var _storyTriggered = false;

// 剧情触发过的歌曲ID集合
var _storySongs = new Set();

// 预加载歌曲缓存 { msgId-song-artist: songObject }
var _preloadedSongs = {};

// ─── 标签正则构建 ─────────────────────────────────────────────────────────────
export function buildTagRegex(template) {
  var SONG_TOK = '\x01';
  var ARTIST_TOK = '\x02';

  var hasSong   = template.indexOf('{song}')   !== -1;
  var hasArtist = template.indexOf('{artist}') !== -1;

  var s = template
    .replace('{song}',   SONG_TOK)
    .replace('{artist}', ARTIST_TOK);

  // 转义所有正则特殊字符
  s = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  var groupIdx = 0;
  var songGroupIdx   = -1;
  var artistGroupIdx = -1;
  if (hasSong)   { groupIdx++; songGroupIdx   = groupIdx; }
  if (hasArtist) { groupIdx++; artistGroupIdx = groupIdx; }

  // 还原捕获组
  s = s.replace('\x01', '(.+?)').replace('\x02', '(.+?)');

  return {
    regex:          new RegExp(s, 'g'),
    hasSong:        hasSong,
    hasArtist:      hasArtist,
    songGroupIdx:   songGroupIdx,
    artistGroupIdx: artistGroupIdx,
  };
}

// ─── 模糊匹配工具 ─────────────────────────────────────────────────────────────
function normalizeName(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyMatch(a, b) {
  var na = normalizeName(a);
  var nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1;
}

function findInPlaylist(songName, artistName, playlistName) {
  var playlist = (_state.playlists || {})[playlistName] || [];
  if (artistName) {
    for (var i = 0; i < playlist.length; i++) {
      if (fuzzyMatch(songName, playlist[i].name) && fuzzyMatch(artistName, playlist[i].artist)) {
        return playlist[i];
      }
    }
  }
  for (var j = 0; j < playlist.length; j++) {
    if (fuzzyMatch(songName, playlist[j].name)) {
      return playlist[j];
    }
  }
  return null;
}

// ─── 静默搜歌（不影响搜索 Tab UI）────────────────────────────────────────────
async function silentSearchOnce(query, source) {
  try {
    var res = await fetch(
      `https://music-api.gdstudio.xyz/api.php?types=search&source=${source}&name=${encodeURIComponent(query)}&count=5&pages=1`
    );
    if (!res.ok) return null;
    var data = await res.json();
    if (Array.isArray(data)) {
      if (data.length > 0) {
        var song = data[0];
        return {
          id: song.id,
          name: song.name,
          artist: song.artist || song.ar?.[0]?.name || '未知歌手',
          album: song.album || song.al?.name || '',
          cover: song.cover || song.pic || song.al?.picUrl || '',
          source: source,
          duration: song.duration || 0
        };
      }
      return { noResults: true };
    }
  } catch (e) {
    console.warn(`[FIRE] Silent search failed for ${source}:`, e);
  }
  return null;
}

async function silentSearchSong(songName, artistName) {
  var query = artistName ? `${songName} ${artistName}` : songName;
  var sources = (_state.settings.searchSources) || ['netease', 'joox', 'bilibili'];

  for (var attempt = 0; attempt < 5; attempt++) {
    var hasNetworkFailure = false;
    for (var i = 0; i < sources.length; i++) {
      try {
        var result = await silentSearchOnce(query, sources[i]);
        if (result) {
          if (result.noResults) {
            continue; // 联网搜歌成功但无结果，不在此源重试
          }
          return result;
        } else {
          hasNetworkFailure = true; // 联网搜歌请求失败（如网络错误或API错误），允许重试
        }
      } catch (_e) {
        hasNetworkFailure = true;
      }
    }
    if (!hasNetworkFailure) {
      break; // 如果所有源均已正常返回空结果（无网络错误），直接中断不再做无意义的重试
    }
    if (attempt < 4) {
      await new Promise(function (r) { setTimeout(r, 600); });
    }
  }
  return null;
}

// ─── 播放/入队辅助 ─────────────────────────────────────────────────────────────
function doPlaySong(song) {
  _storySongs.add(song.id);
  _storyTriggered = true;

  // 如果是在剧情点歌模式下触发，并且该歌曲在歌单中没有独立起播时间，则将其标记为 storyPlayTime
  var ss = _state.settings.storySearch;
  if (ss && ss.defaultStartPos && !song.startTime) {
    song.storyPlayTime = ss.defaultStartPos;
  }

  if (Array.isArray(_state.activeQueue)) {
    _state.activeQueue = _state.activeQueue.filter(function (s) {
      return _storySongs.has(s.id);
    });
  } else {
    _state.activeQueue = [];
  }

  if (!_state.activeQueue.some(function (x) { return x.id === song.id; })) {
    _state.activeQueue.push(song);
  }

  _saveState();

  // Prevent restarting the song if it is already the current active playing song
  if (_state.currentSong && _state.currentSong.id === song.id && _state.isPlaying) {
    return;
  }

  _playSong(song);
  _triggerError(`剧情搜歌：立即播放「${song.name}」`);
}

function doQueueSong(song) {
  _storySongs.add(song.id);
  _storyTriggered = true;

  // 如果是在剧情点歌模式下入队，并且该歌曲在歌单中没有独立起播时间，则将其标记为 storyPlayTime
  var ss = _state.settings.storySearch;
  if (ss && ss.defaultStartPos && !song.startTime) {
    song.storyPlayTime = ss.defaultStartPos;
  }

  if (Array.isArray(_state.activeQueue)) {
    _state.activeQueue = _state.activeQueue.filter(function (s) {
      return _storySongs.has(s.id);
    });
  } else {
    _state.activeQueue = [];
  }

  // Prevent duplicate queue insertions
  if (!_state.activeQueue.some(function (x) { return x.id === song.id; })) {
    _state.activeQueue.push(song);
    _saveState();
    _triggerError(`剧情搜歌：「${song.name}」已加入播放队列`);
  } else {
    console.log(`[FIRE] Story Search: 「${song.name}」is already in the play queue, skipping duplicate`);
  }
}

// ─── 预加载歌曲核心 ───────────────────────────────────────────────────────────
async function preloadSong(songName, artistName, messageId) {
  var key = messageId + '-' + songName + '-' + artistName;
  if (_preloadedSongs[key]) return; // 已在预加载或已加载完

  var promise = (async () => {
    var ss = _state && _state.settings && _state.settings.storySearch;
    if (!ss || !ss.enabled) return null;

    var song = null;
    try {
      if (ss.playlistMode === 'playlist_only_stop' || ss.playlistMode === 'playlist_only_random') {
        var target = ss.targetPlaylist || _state.currentPlaylist;
        song = findInPlaylist(songName, artistName, target);
        if (!song && ss.playlistMode === 'playlist_only_random') {
          var playlist = (_state.playlists || {})[target] || [];
          if (playlist.length > 0) {
            song = playlist[Math.floor(Math.random() * playlist.length)];
          }
        }
      } else {
        song = await silentSearchSong(songName, artistName);
      }

      if (song) {
        if (ss.defaultStartPos && !song.startTime) {
          song.storyPlayTime = ss.defaultStartPos;
        }
        console.log(`[FIRE] Preloaded song metadata: ${song.name} - ${song.artist} for msg ${messageId}`);

        // 背景预加载音频直链到缓存中
        var qualities = ['999', '740', '320', '192', '128'];
        var startQuality = _state.settings.audioQuality || '999';
        var startIndex = qualities.indexOf(startQuality);
        if (startIndex === -1) startIndex = 0;
        var currentBr = qualities[startIndex];

        var cacheKey = `${song.source || 'netease'}_${song.id}_${currentBr}`;
        
        if (_getCache && !_getCache('url', cacheKey)) {
          try {
            var urlRes = await fetch(`https://music-api.gdstudio.xyz/api.php?types=url&source=${song.source || 'netease'}&id=${song.id}&br=${currentBr}`);
            if (urlRes.ok) {
              var urlData = await urlRes.json();
              if (urlData && urlData.url) {
                if (_setCache) {
                  _setCache('url', cacheKey, { url: urlData.url, br: urlData.br || currentBr, size: urlData.size || 0 }, 15 * 60 * 1000);
                  console.log(`[FIRE] Preloaded and cached URL in background for: ${song.name}`);
                }
              }
            }
          } catch (err) {
            console.warn("[FIRE] Preload audio URL failed:", err);
          }
        }
      }
    } catch (e) {
      console.error('[FIRE] Preload failed:', e);
    }
    return song;
  })();

  _preloadedSongs[key] = promise;

  try {
    var song = await promise;
    if (song) {
      _preloadedSongs[key] = song;
    } else {
      delete _preloadedSongs[key];
    }
  } catch (e) {
    delete _preloadedSongs[key];
  }
}

// ─── 触发处理核心 ─────────────────────────────────────────────────────────────
async function handleSongTrigger(songName, artistName, messageId) {
  if (!_state) return;
  var ss = _state.settings.storySearch;
  if (!ss || !ss.enabled) return;

  var now = Date.now();
  if (messageId !== _lastTriggeredMsgId) {
    _lastTriggeredMsgId = messageId;
  }
  // 仅在当前消息未触发过，或者距离上一次触发已过2秒时，重置此消息的触发计数器
  // 规避滚动多楼层交叉触发时，导致计数被清空的 Bug
  if (!_lastTriggerTimeByMsg[messageId] || (now - _lastTriggerTimeByMsg[messageId] > 2000)) {
    _triggerCountByMsg[messageId] = 0;
  }
  _lastTriggerTimeByMsg[messageId] = now;

  _triggerError(`剧情搜歌：检测到播歌标签 (歌名: 「${songName}」, 歌手: 「${artistName || '未指定'}」)`);

  if (!_triggerCountByMsg[messageId]) _triggerCountByMsg[messageId] = 0;
  var triggerIdx = _triggerCountByMsg[messageId];
  _triggerCountByMsg[messageId]++;

  var isFirstInMsg = (triggerIdx === 0);

  var effectiveMode;
  if (isFirstInMsg || !_storyTriggered) {
    effectiveMode = ss.switchMode || 'queue';
  } else {
    switch (ss.multiTagMode || 'first_cut_rest_queue') {
      case 'all_immediate':       effectiveMode = 'immediate'; break;
      case 'all_queue':           effectiveMode = 'queue';     break;
      case 'first_only':          effectiveMode = 'skip';      break;
      case 'first_cut_rest_queue':
      default:                    effectiveMode = 'queue';     break;
    }
  }

  if (effectiveMode === 'skip') {
    _triggerError(`剧情搜歌：「${songName}」已跳过 (根据多标签配置，该消息仅播放第一首)`);
    return;
  }

  var song = null;
  var key = messageId + '-' + songName + '-' + artistName;

  // 1. 优先使用预加载好的数据
  if (_preloadedSongs[key]) {
    if (_preloadedSongs[key] instanceof Promise) {
      _triggerError(`剧情搜歌：检测到歌曲正在预加载，等待加载完成...`);
      song = await _preloadedSongs[key];
    } else {
      song = _preloadedSongs[key];
      _triggerError(`剧情搜歌：直接使用预加载的歌曲数据「${song.name} - ${song.artist}」`);
    }
  }

  // 2. 退回常规检索
  if (!song) {
    if (ss.playlistMode === 'playlist_only_stop' || ss.playlistMode === 'playlist_only_random') {
      var target = ss.targetPlaylist || _state.currentPlaylist;
      _triggerError(`剧情搜歌：处于限制歌单模式，正在目标歌单「${target}」中检索...`);
      song = findInPlaylist(songName, artistName, target);
      if (!song) {
        if (ss.playlistMode === 'playlist_only_random') {
          var playlist = (_state.playlists || {})[target] || [];
          if (playlist.length > 0) {
            song = playlist[Math.floor(Math.random() * playlist.length)];
            _triggerError(`剧情搜歌：在歌单「${target}」中未检索到「${songName}」，根据设定随机选择歌单内的「${song.name} - ${song.artist}」进行播放`);
          } else {
            _triggerError(`剧情搜歌：未在歌单「${target}」中检索到「${songName}」，且目标歌单为空，跳过播放`);
            return;
          }
        } else {
          _triggerError(`剧情搜歌：未在歌单「${target}」中检索到「${songName}」，根据设定不进行播放，跳过播放`);
          return;
        }
      } else {
        _triggerError(`剧情搜歌：歌单匹配成功！已在歌单「${target}」中检索到「${song.name} - ${song.artist}」`);
      }
    } else {
      _triggerError(`剧情搜歌：处于全网搜歌模式，开始在线搜索...`);
      song = await silentSearchSong(songName, artistName);
      if (!song) {
        _triggerError(`剧情搜歌：联网搜歌失败，在全网源重试5次后均未找到匹配歌曲：「${songName}」`);
        return;
      }
      _triggerError(`剧情搜歌：联网搜索成功！匹配结果：「${song.name} - ${song.artist}」`);
    }
  }

  if (effectiveMode === 'immediate') {
    doPlaySong(song);
  } else {
    doQueueSong(song);
  }
}

/**
 * 清除消息元素内已有的剧情搜歌锚点，将其还原为纯文本节点。
 * 这样在流式输出结束后可以重新扫描完整内容。
 * 同时收集并返回已被触发过的歌曲组合，供后续重新生成锚点时恢复状态。
 */
function clearMessageAnchors(msgEl) {
  var anchors = msgEl.querySelectorAll('.fire-story-anchor');
  if (anchors.length === 0) return [];
  
  var triggeredKeys = [];
  anchors.forEach(function (anchor) {
    if (_observer) _observer.unobserve(anchor);
    if (anchor.dataset.fireTriggered === '1') {
      var song = anchor.dataset.fireSong || '';
      var artist = anchor.dataset.fireArtist || '';
      triggeredKeys.push(song + ' - ' + artist);
    }
    var text = anchor.textContent;
    var textNode = document.createTextNode(text);
    if (anchor.parentNode) {
      anchor.parentNode.replaceChild(textNode, anchor);
    }
  });

  // 同时停止观察消息元素本身
  if (_messageObserver) _messageObserver.unobserve(msgEl);

  msgEl.normalize();
  return triggeredKeys;
}

function processMessageEl(msgEl, messageId, triggeredKeys) {
  if (!msgEl || !_state) return;
  var ss = _state.settings.storySearch;
  if (!ss || !ss.enabled) return;

  var tagInfo = buildTagRegex(ss.tagTemplate || '♪{song} - {artist}♪');

  // 使用 NodeFilter 排除 pre、code、a、button 等标签内的文本节点，防止格式崩坏
  var walker = document.createTreeWalker(msgEl, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      var parent = node.parentElement;
      while (parent && parent !== msgEl) {
        var tag = parent.tagName.toLowerCase();
        if (tag === 'pre' || tag === 'code' || tag === 'a' || tag === 'button') {
          return NodeFilter.FILTER_REJECT;
        }
        parent = parent.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  }, false);
  var textNodes = [];
  var node;
  while ((node = walker.nextNode())) textNodes.push(node);

  textNodes.forEach(function (textNode) {
    var text = textNode.nodeValue;
    if (!text) return;

    tagInfo.regex.lastIndex = 0;
    var matches = [];
    var m;
    while ((m = tagInfo.regex.exec(text)) !== null) {
      matches.push({
        index:    m.index,
        length:   m[0].length,
        original: m[0],
        song:     tagInfo.songGroupIdx   > 0 ? (m[tagInfo.songGroupIdx]   || '') : '',
        artist:   tagInfo.artistGroupIdx > 0 ? (m[tagInfo.artistGroupIdx] || '') : '',
      });
    }
    if (matches.length === 0) return;

    var parent = textNode.parentNode;
    if (!parent) return;

    var fragment = document.createDocumentFragment();
    var lastIndex = 0;

    matches.forEach(function (match) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      var anchor = document.createElement('span');
      anchor.className = 'fire-story-anchor';
      anchor.dataset.fireSong   = match.song;
      anchor.dataset.fireArtist = match.artist;
      anchor.dataset.fireMsgId  = String(messageId);
      anchor.textContent = match.original;

      // 根据设置决定是否渲染高亮颜色（跟随酒馆的 --SmartThemeEmColor，若未设置则回退至 purple）
      var highlight = (_state && _state.settings && _state.settings.storySearch && _state.settings.storySearch.enableHighlight !== false);
      if (highlight) {
        anchor.style.cssText = 'color:var(--SmartThemeEmColor, var(--fire-accent,#a855f7));cursor:default;';
      } else {
        anchor.style.cssText = 'cursor:default;';
      }

      anchor.title = `剧情搜歌：${match.song}${match.artist ? ' - ' + match.artist : ''}`;

      // 恢复已触发过的标记，避免重新扫描时重复播放
      var key = match.song + ' - ' + match.artist;
      if (triggeredKeys && triggeredKeys.indexOf(key) !== -1) {
        anchor.dataset.fireTriggered = '1';
      } else {
        var ssVal = _state && _state.settings && _state.settings.storySearch;
        var scrollPlay = !ssVal || ssVal.enableScrollPlay !== false;

        if (scrollPlay) {
          if (_observer) _observer.observe(anchor);
        }
      }
      fragment.appendChild(anchor);
      lastIndex = match.index + match.length;
    });

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    parent.replaceChild(fragment, textNode);
  });

  // 不管“滚动到可视区”是否开启，只要启用了剧情点歌，我们都观察消息元素本身（楼层），在进入可视区的第一时间触发【背景搜歌和直链预加载】
  var ssVal = _state && _state.settings && _state.settings.storySearch;
  if (ssVal && ssVal.enabled) {
    var hasEligible = msgEl.querySelector('.fire-story-anchor:not([data-fire-triggered="1"])');
    if (hasEligible || ssVal.allowRetrigger) {
      if (_messageObserver) _messageObserver.observe(msgEl);
    }
  }
}

function scanAllMessages() {
  var doc = _getDoc();
  if (!doc) return;
  var msgEls = doc.querySelectorAll('.mes[mesid] .mes_text');
  msgEls.forEach(function (msgEl) {
    if (msgEl.dataset.fireStoryDone === '1') return;
    
    // 清除可能已存在的旧锚点，避免嵌套和设置更改后旧样式残留
    clearMessageAnchors(msgEl);
    
    msgEl.dataset.fireStoryDone = '1';
    var mesEl = msgEl.closest('.mes');
    var messageId = mesEl ? mesEl.getAttribute('mesid') : 'hist';
    processMessageEl(msgEl, messageId);
  });
}

// 每消息楼层可视监听器（当关闭“滚动到可视区”时，观察消息框头部进入可视区）
var _messageObserver = null;

// ─── Observer 管理 ────────────────────────────────────────────────────────────
function createObserver() {
  if (_observer) _observer.disconnect();
  _observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var anchor = entry.target;
      var ss = _state && _state.settings && _state.settings.storySearch;
      if (!ss || !ss.enabled) return;

      var alreadyTriggered = anchor.dataset.fireTriggered === '1';
      if (alreadyTriggered && !ss.allowRetrigger) return;

      anchor.dataset.fireTriggered = '1';
      if (!ss.allowRetrigger) _observer.unobserve(anchor);

      var song   = anchor.dataset.fireSong   || '';
      var artist = anchor.dataset.fireArtist || '';
      var msgId  = anchor.dataset.fireMsgId  || 'unknown';
      if (song) handleSongTrigger(song, artist, msgId);
    });
  }, { threshold: 0.05, rootMargin: '0px' });

  if (_messageObserver) _messageObserver.disconnect();
  _messageObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var msgEl = entry.target;
      var mesEl = msgEl.closest('.mes');
      var messageId = mesEl ? mesEl.getAttribute('mesid') : 'hist';
      var ss = _state && _state.settings && _state.settings.storySearch;
      if (!ss || !ss.enabled) return;

      var anchors = msgEl.querySelectorAll('.fire-story-anchor');
      var triggeredAny = false;

      anchors.forEach(function (anchor) {
        var song   = anchor.dataset.fireSong   || '';
        var artist = anchor.dataset.fireArtist || '';
        if (!song) return;

        // 1. 不管滚动开启与否，只要楼层进入视口，第一时间拉取歌曲并进行直链预加载
        preloadSong(song, artist, messageId);

        // 2. 如果【关闭】了滚动到可视区，则楼层进入可视区就要立刻触发【放歌】
        var scrollPlay = ss.enableScrollPlay !== false;
        if (!scrollPlay) {
          var alreadyTriggered = anchor.dataset.fireTriggered === '1';
          if (alreadyTriggered && !ss.allowRetrigger) return;

          anchor.dataset.fireTriggered = '1';
          handleSongTrigger(song, artist, messageId);
          triggeredAny = true;
        }
      });

      // 性能优化：如果未开启重复触发，且该消息层已完成全部预加载或触发，即可解绑，避免滚动时重复触发 IntersectionObserver 回调
      if (!ss.allowRetrigger) {
        _messageObserver.unobserve(msgEl);
      }
    });
  }, { threshold: 0.05, rootMargin: '0px' });
}

export function resetStoryObserver() {
  createObserver();
  _triggerCountByMsg = {};
  _lastTriggerTimeByMsg = {};
  _storyTriggered    = false;
  if (_storySongs) _storySongs.clear();
  _lastTriggeredMsgId = null;
}

// ─── 消息 ID 解析 ─────────────────────────────────────────────────────────────
function resolveMessageId(arg) {
  if (arg === null || arg === undefined) return null;
  if (typeof arg === 'number' || (typeof arg === 'string' && !isNaN(arg))) {
    return String(arg);
  }
  if (typeof arg === 'object') {
    try {
      var context = getContext();
      var chat = context && context.chat;
      if (Array.isArray(chat)) {
        var idx = chat.indexOf(arg);
        if (idx !== -1) return String(idx);
      }
    } catch (e) {}
    if (arg.uid !== undefined) return String(arg.uid);
    if (arg.id !== undefined) return String(arg.id);
  }
  return null;
}

// 用于记录每个消息处理的防抖定时器
var _processTimeouts = {};

/**
 * 延迟且防抖处理指定消息的辅助函数。
 * 用于规避 SillyTavern 事件频繁触发（如流式输出）时的性能损耗和 DOM 竞态问题。
 */
function processMessageWithDelay(messageIdOrObj, delay) {
  var messageId = resolveMessageId(messageIdOrObj);
  if (!messageId) return;

  if (_processTimeouts[messageId]) {
    clearTimeout(_processTimeouts[messageId]);
  }
  _processTimeouts[messageId] = setTimeout(function () {
    delete _processTimeouts[messageId];
    var doc = _getDoc();
    if (!doc) return;
    var ss = _state && _state.settings && _state.settings.storySearch;
    if (!ss || !ss.enabled) return;

    var msgEl = doc.querySelector('.mes[mesid="' + messageId + '"] .mes_text');
    if (!msgEl) return;

    var triggeredKeys = clearMessageAnchors(msgEl);
    delete msgEl.dataset.fireStoryDone;
    msgEl.dataset.fireStoryDone = '1';
    processMessageEl(msgEl, messageId, triggeredKeys);
  }, delay || 100);
}

// ─── Chat DOM 变动监听器（用于流式实时匹配） ────────────────────────────────────────
function watchChatMutations() {
  if (_chatObserver) _chatObserver.disconnect();
  var ss = _state && _state.settings && _state.settings.storySearch;
  if (!ss || !ss.enabled || !ss.enableStreamSearch) return;

  var doc = _getDoc();
  if (!doc) return;
  var chatContainer = doc.getElementById('chat');
  if (!chatContainer) return;

  _chatObserver = new MutationObserver(function (mutations) {
    var ssVal = _state && _state.settings && _state.settings.storySearch;
    if (!ssVal || !ssVal.enabled || !ssVal.enableStreamSearch) {
      if (_chatObserver) _chatObserver.disconnect();
      return;
    }

    var processedMsgs = new Set();
    mutations.forEach(function (mutation) {
      var target = mutation.target;
      if (!target) return;

      var msgEl = target.nodeType === 1 ? target.closest('.mes_text') : (target.parentNode ? target.parentNode.closest('.mes_text') : null);
      if (!msgEl) return;

      var mesEl = msgEl.closest('.mes');
      if (!mesEl) return;

      var messageId = mesEl.getAttribute('mesid');
      if (messageId && !processedMsgs.has(messageId)) {
        processedMsgs.add(messageId);
        processMessageWithDelay(messageId, 100);
      }
    });
  });

  _chatObserver.observe(chatContainer, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

function ensureChatObserver() {
  if (_chatObserver) return;
  watchChatMutations();
}

// ─── 公开初始化函数 ───────────────────────────────────────────────────────────
export function initStorySearch(state, callbacks) {
  _state        = state;
  _playSong     = callbacks.playSong;
  _triggerError = callbacks.triggerError;
  _showToast    = callbacks.showToast;
  _saveState    = callbacks.saveState;
  _getDoc       = callbacks.getDoc;
  _setCache     = callbacks.setCache;
  _getCache     = callbacks.getCache;

  var defaults = {
    enabled:        false,
    tagTemplate:    '♪{song} - {artist}♪',
    switchMode:     'queue',
    multiTagMode:   'first_cut_rest_queue',
    allowRetrigger: false,
    playlistMode:   'any', // 'any' | 'playlist_only_stop' | 'playlist_only_random'
    targetPlaylist: '',
    enableStreamSearch: false,
    enableScrollPlay:   true,
    enableHighlight:    true,
    defaultStartPos:    '',
    wiTemplate:     '[FIRE Music Reference - {{playlist_name}}]\n以下是歌单中的歌曲，可在剧情中选用：\n\n{{songs_list}}\n\n在剧情中需要播放音乐时，请在发言中包含格式：{{play_tag}}\n例如：{{play_example}}',
  };
  if (!_state.settings.storySearch) _state.settings.storySearch = {};
  
  // Migration for old playlistMode values
  if (_state.settings.storySearch.playlistMode === 'playlist_only') {
    _state.settings.storySearch.playlistMode = _state.settings.storySearch.fallbackRandom !== false
      ? 'playlist_only_random'
      : 'playlist_only_stop';
    delete _state.settings.storySearch.fallbackRandom;
  }
  
  _state.settings.storySearch = Object.assign({}, defaults, _state.settings.storySearch);

  createObserver();
  ensureChatObserver();

  // CHARACTER_MESSAGE_RENDERED：AI 消息渲染完毕（包含流式生成中和结束后的最终渲染）
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, function (messageId) {
    processMessageWithDelay(messageId, 100);
  });

  // USER_MESSAGE_RENDERED：用户消息渲染
  eventSource.on(event_types.USER_MESSAGE_RENDERED, function (messageId) {
    processMessageWithDelay(messageId, 100);
  });

  // MESSAGE_UPDATED：消息内容发生改变（如 AI 处于流式输出生成状态时）
  eventSource.on(event_types.MESSAGE_UPDATED, function (messageId) {
    processMessageWithDelay(messageId, 100);
  });

  // CHAT_CHANGED：切换聊天文件时重置状态并扫描全部消息
  eventSource.on(event_types.CHAT_CHANGED, function () {
    resetStoryObserver();
    setTimeout(function () {
      var doc = _getDoc();
      if (doc) {
        doc.querySelectorAll('.mes_text[data-fire-story-done]').forEach(function (el) {
          delete el.dataset.fireStoryDone;
        });
      }
      scanAllMessages();
      ensureChatObserver();
    }, 600);
  });

  // MESSAGE_EDITED：编辑消息后重新处理
  eventSource.on(event_types.MESSAGE_EDITED, function (messageId) {
    processMessageWithDelay(messageId, 100);
  });

  // MESSAGE_SWIPED：左右滑动切换 AI 回复时重新处理
  eventSource.on(event_types.MESSAGE_SWIPED, function (messageId) {
    processMessageWithDelay(messageId, 150);
  });

  setTimeout(scanAllMessages, 400);
}

// ─── 设置面板 HTML ────────────────────────────────────────────────────────────
export function renderStorySearchSettingsHTML() {
  return `
  <div class="fire-settings-section" style="margin-top:8px;border-top:1px solid var(--fire-border);padding-top:8px;">
    <div class="fire-settings-section-header" id="fire-settings-header-storysearch" style="display:flex; justify-content:space-between; align-items:center; width:100%;">
      <span>剧情搜歌<span class="fire-story-help-btn" style="margin-left:5px;font-size:13px;cursor:pointer;opacity:0.6;" title="查看详细教程">?</span></span>
      <i class="fa-solid fa-chevron-right fire-settings-chevron"></i>
    </div>
    <div class="fire-settings-section-content" id="fire-settings-content-storysearch" style="display:none;">

      <label class="fire-settings-item" style="justify-content:space-between;">
        <span>启用剧情搜歌</span>
        <input type="checkbox" id="fire-story-enabled">
      </label>
      
      <label class="fire-settings-item" style="justify-content:space-between;">
        <span>高亮显示标签</span>
        <input type="checkbox" id="fire-story-highlight">
      </label>

      <label class="fire-settings-item" style="justify-content:space-between;">
        <span>滚动到可视区才播放</span>
        <input type="checkbox" id="fire-story-scrollplay">
      </label>

      <label class="fire-settings-item" style="justify-content:space-between;">
        <span>流式即时搜歌</span>
        <input type="checkbox" id="fire-story-stream-enabled">
      </label>

      <div class="fire-settings-sub-item" style="flex-direction:column;align-items:stretch;gap:4px;margin-top:6px;">
        <span style="font-size:11px;">播歌标签模板</span>
        <input type="text" id="fire-story-template" class="fire-input"
          style="height:28px;padding:4px 8px;font-size:12px;"
          placeholder="♪{song} - {artist}♪">
      </div>

      <div class="fire-settings-sub-item" style="flex-direction:column;align-items:stretch;gap:4px;margin-top:6px;">
        <span style="font-size:11px;">默认起播位置</span>
        <input type="text" id="fire-story-default-start" class="fire-input"
          style="height:28px;padding:4px 8px;font-size:12px;"
          placeholder="例如 1/3 或 30%">
      </div>

      <div class="fire-settings-sub-item" style="flex-direction:column;align-items:stretch;gap:4px;margin-top:6px;">
        <span style="font-size:11px;">起播应用范围</span>
        <select id="fire-story-default-start-scope" class="fire-select" style="padding:4px 8px;font-size:12px;height:28px;">
          <option value="story_only">仅剧情点歌生效</option>
          <option value="global">全局播放生效</option>
        </select>
      </div>

      <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.05);padding-top:6px;display:flex;flex-direction:column;gap:6px;">
        <div class="fire-settings-sub-item" style="flex-direction:column;align-items:stretch;gap:4px;">
          <span style="font-size:11px;">切歌策略</span>
          <select id="fire-story-switchmode" class="fire-select" style="padding:4px 8px;font-size:12px;height:28px;">
            <option value="queue">加入播放队列</option>
            <option value="immediate">立即切歌</option>
          </select>
        </div>

        <div class="fire-settings-sub-item" style="flex-direction:column;align-items:stretch;gap:4px;">
          <span style="font-size:11px;">多标签策略</span>
          <select id="fire-story-multitagmode" class="fire-select" style="padding:4px 8px;font-size:12px;height:28px;">
            <option value="first_cut_rest_queue">第一首切歌，其余加队列</option>
            <option value="all_immediate">全部立即切歌</option>
            <option value="all_queue">全部加入队列</option>
            <option value="first_only">仅播放第一首，其余忽略</option>
          </select>
        </div>

        <label class="fire-settings-item" style="justify-content:space-between;">
          <span style="font-size:12px;">允许重复触发</span>
          <input type="checkbox" id="fire-story-retrigger">
        </label>
      </div>

      <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.05);padding-top:6px;display:flex;flex-direction:column;gap:6px;">
        <div class="fire-settings-sub-item" style="flex-direction:column;align-items:stretch;gap:4px;">
          <span style="font-size:11px;">歌曲来源与未匹配处理</span>
          <select id="fire-story-playlistmode" class="fire-select" style="padding:4px 8px;font-size:12px;height:28px;">
            <option value="any">允许所有歌曲</option>
            <option value="playlist_only_stop">仅限指定歌单（不匹配时不播放）</option>
            <option value="playlist_only_random">仅限指定歌单（不匹配时随机播放）</option>
          </select>
        </div>

        <div id="fire-story-playlist-sub" style="display:none;flex-direction:column;gap:6px;padding-left:4px;">
          <div class="fire-settings-sub-item" style="flex-direction:column;align-items:stretch;gap:4px;">
            <span style="font-size:11px;">目标歌单</span>
            <select id="fire-story-targetplaylist" class="fire-select" style="padding:4px 8px;font-size:12px;height:28px;"></select>
          </div>
        </div>
      </div>

      <div class="fire-settings-sub-item" style="flex-direction:column;align-items:stretch;gap:4px;margin-top:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:11px;">世界书条目内容模板</span>
          <i class="fa-solid fa-expand fire-story-template-expand-btn" style="cursor:pointer; opacity:0.7; font-size:12px;" title="全屏编辑"></i>
        </div>
        <textarea id="fire-story-wi-template" class="fire-textarea"
          style="height:60px;padding:6px 8px;font-size:11px;resize:vertical;font-family:monospace;background:rgba(0,0,0,0.25);border:1px solid var(--fire-border);color:inherit;border-radius:4px;"
          placeholder="支持占位符：{{playlist_name}}, {{play_tag}}, {{play_example}}, {{songs_list}}"></textarea>
        <span style="font-size:10px;opacity:0.5;line-height:1.2;">可用占位符：{{playlist_name}} (歌单名), {{play_tag}} (点歌格式), {{play_example}} (播歌示例), {{songs_list}} (歌曲列表)</span>
      </div>

      <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.05);padding-top:6px;">
        <button id="fire-story-export-wi-btn" class="fire-btn fire-btn-normal"
          style="width:100%;padding:6px;font-size:12px;">
          <i class="fa-solid fa-book-open"></i>&nbsp;生成世界书条目
        </button>
      </div>

    </div>
  </div>
  `;
}

// ─── 安全跨域 DOM 辅助函数 ──────────────────────────────────────────────────────
function getSafeParentDocument() {
  try {
    if (window.parent && window.parent.document) {
      return window.parent.document;
    }
  } catch (e) {}
  return document;
}

function getSafeParentWindow() {
  try {
    if (window.parent) {
      return window.parent;
    }
  } catch (e) {}
  return window;
}

// ─── 帮助弹窗相关 ─────────────────────────────────────────────────────────────
function showStorySearchHelp() {
  var parentDoc = getSafeParentDocument();
  var existing = parentDoc.getElementById('fire-story-help-modal');
  if (existing) existing.remove();

  var modal = parentDoc.createElement('div');
  modal.id = 'fire-story-help-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;z-index:2999999;background:rgba(9,9,11,0.65);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;box-sizing:border-box;';
  modal.innerHTML = `
    <div class="fire-story-help-card" style="
      background: var(--fire-bg-opaque, var(--SmartThemeBlurTintColor, #080d14)) !important;
      border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15)) !important;
      border-radius: 16px;
      padding: 24px;
      width: 460px;
      max-width: 90vw;
      display: flex;
      flex-direction: column;
      gap: 16px;
      color: var(--SmartThemeBodyColor, #f4f4f5) !important;
      font-family: system-ui, -apple-system, sans-serif;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2);
      box-sizing: border-box;
      line-height: 1.6;
    ">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1)); padding-bottom: 10px;">
        <span style="font-size: 15px; font-weight: 600; color: var(--SmartThemeBodyColor, #ffffff) !important; display: flex; align-items: center; gap: 8px;">
          <svg style="width: 18px; height: 18px; fill: var(--SmartThemeQuoteColor, #a855f7);" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 16h-2v-2h2v2zm1.07-7.75l-.9.92C12.45 11.9 12 12.5 12 14h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H5c0-3.87 3.13-7 7-7s7 3.13 7 7c0 1.17-.45 2.23-1.17 3.07z"/></svg>
          剧情听歌模式说明书
        </span>
        <span id="fire-story-help-close" style="cursor: pointer; opacity: 0.5; font-size: 20px; line-height: 1; color: var(--SmartThemeEmColor, #a1a1aa); transition: opacity 0.2s;">✕</span>
      </div>

      <div style="font-size: 12.5px; display: flex; flex-direction: column; gap: 12px; max-height: 60vh; overflow-y: auto; padding-right: 4px;">
        <div>
          <b style="color:var(--SmartThemeQuoteColor, #a855f7);">1. 基础用法</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">在 AI 的设定书（世界书）、人设或剧情中写入包含指定格式的文本（例如 <code>♪歌曲 - 歌手♪</code>），当该消息显示在聊天框中被插件检测到时，即可触发相应的搜歌逻辑。</p>
        </div>
        
        <div>
          <b style="color:var(--SmartThemeQuoteColor, #a855f7);">2. 起播位置设置说明</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">在全局设置或歌单编辑中，均支持以下格式控制播放偏移：</p>
          <ul style="margin: 4px 0 0 16px; padding: 0; opacity: 0.85;">
            <li><b>比例格式</b>：如 <code>1/3</code>（从 1/3 进度处起播）</li>
            <li><b>百分比格式</b>：如 <code>30%</code>（从 30% 进度处起播）</li>
            <li><b>时间格式</b>：如 <code>01:30</code> 或 <code>1:30</code>（从 1 分 30 秒处起播）</li>
            <li><b>绝对秒数</b>：如 <code>90</code>（直接跳转至第 90 秒起播）</li>
          </ul>
        </div>

        <div>
          <b style="color:var(--SmartThemeQuoteColor, #a855f7);">3. 核心配置项说明</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">
            • <b>高亮显示标签</b>：是否使用高亮（颜色自动匹配酒馆主题的强调色）。关闭后标签在视觉上与普通文本无异，仅后台静默监听。<br>
            • <b>滚动到可视区才播放</b>：控制当文本标签滚动进入屏幕时才触发播放。关闭后一解析到标签即立刻播放。<br>
            • <b>流式即时搜歌</b>：打字机输出中即刻解析匹配。默认关闭（建议关闭以避免生成时的字形闪烁）。
          </p>
        </div>

        <div>
          <b style="color:var(--SmartThemeQuoteColor, #a855f7);">4. 世界书联动与自定义内容模板</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">
            • <b>一键导出</b>：点击底部的“生成世界书条目”，自动将所选歌单列表及提示词写入指定的世界书中，使 AI 随时可以参考并准确点歌。<br>
            • <b>自定义条目模板</b>：在设置面板中，支持通过配置模板来个性化导出的世界书文本格式。点击输入框右侧的<b>全屏编辑按钮</b>（展开图标）即可进入大屏编辑状态。可用占位符：<br>
            &nbsp;&nbsp;- <code>{{playlist_name}}</code>：歌单名称。<br>
            &nbsp;&nbsp;- <code>{{play_tag}}</code>：当前配置的点歌匹配标签。<br>
            &nbsp;&nbsp;- <code>{{play_example}}</code>：自动生成的第一个点歌指令例句。<br>
            &nbsp;&nbsp;- <code>{{songs_list}}</code>：被格式化好的歌曲列表。
          </p>
        </div>

        <div>
          <b style="color:var(--SmartThemeQuoteColor, #a855f7);">5. 限制歌单与歌曲来源</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">
            • <b>允许所有歌曲 (全网搜歌)</b>：AI 可以点播全网任意歌曲，若匹配成功则自动下载/在线播放。<br>
            • <b>仅限指定歌单 (严格模式)</b>：AI 只能点播您本地指定歌单内的歌曲。支持「不匹配时不播放」以及「不匹配时随机播放歌单内一首」两种策略，有效防止 AI 幻觉乱点不存在的歌曲。
          </p>
        </div>

        <div>
          <b style="color:var(--SmartThemeQuoteColor, #a855f7);">6. 多标签与重复触发策略</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">
            • <b>多标签策略</b>：当一条 AI 回复中包含多个播歌标签时，可通过此配置控制。支持「第一首切歌，其余加入队列」、「全部立即切歌（频繁切歌）」、「全部加入队列」和「仅播放第一首（其余忽略）」。<br>
            • <b>允许重复触发</b>：开启后，若您往回滚动聊天记录，已经播放过的标签在重新进入视口时会再次触发播放。关闭后每个标签在聊天历史中仅会播放一次。
          </p>
        </div>

        <div>
          <b style="color:var(--SmartThemeQuoteColor, #a855f7);">7. 自定义播歌标签模板</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">
            您可以自定义标签格式（如 <code>[听歌: {song} - {artist}]</code>）。设置后，请在 AI 人设、世界书或 System Prompt 中告知 AI 必须以此格式输出歌曲点播，必须包含 <code>{song}</code> 占位符，<code>{artist}</code>（歌手）可选。
          </p>
        </div>
      </div>

      <div style="display: flex; justify-content: flex-end; border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1)); padding-top: 12px; margin-top: 4px;">
        <button id="fire-story-help-ok" style="
          padding: 8px 20px; font-size: 13px; border-radius: 8px; border: none;
          background: var(--SmartThemeQuoteColor, #a855f7); color: var(--SmartThemeBodyColor, #ffffff); cursor: pointer; font-weight: 500; transition: all 0.2s;
        ">我知道了</button>
      </div>
    </div>
  `;
  parentDoc.body.appendChild(modal);

  parentDoc.getElementById('fire-story-help-close').addEventListener('click', function () { modal.remove(); });
  parentDoc.getElementById('fire-story-help-ok').addEventListener('click', function () { modal.remove(); });
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });
}

// ─── 全屏模板编辑器 ────────────────────────────────────────────────────────────
function showFullScreenTemplateEditor() {
  var parentDoc = getSafeParentDocument();
  var existing = parentDoc.getElementById('fire-story-template-modal');
  if (existing) existing.remove();

  var ss = _state.settings.storySearch;
  var currentVal = ss.wiTemplate || '[FIRE Music Reference - {{playlist_name}}]\n以下是歌单中的歌曲，可在剧情中选用：\n\n{{songs_list}}\n\n在剧情中需要播放音乐时，请在发言中包含格式：{{play_tag}}\n例如：{{play_example}}';

  // Compute opaque background
  var opaqueBg = 'rgb(8, 13, 20)';
  try {
    var temp = parentDoc.createElement('div');
    temp.style.color = 'var(--SmartThemeBlurTintColor)';
    parentDoc.body.appendChild(temp);
    var parentColor = getSafeParentWindow().getComputedStyle(temp).color;
    parentDoc.body.removeChild(temp);

    var resolved = getOpaqueRGB(parentColor);
    if (!resolved) {
      var directVal = getSafeParentWindow().getComputedStyle(parentDoc.documentElement).getPropertyValue('--SmartThemeBlurTintColor');
      resolved = getOpaqueRGB(directVal);
    }
    if (resolved) {
      opaqueBg = resolved;
    }
  } catch (e) {}

  var modal = parentDoc.createElement('div');
  modal.id = 'fire-story-template-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;z-index:2999999;background:rgba(9,9,11,0.65);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;box-sizing:border-box;';
  modal.innerHTML = `
    <div style="
      background: ${opaqueBg} !important;
      border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15)) !important;
      border-radius: 16px;
      padding: 24px;
      width: 720px;
      max-width: 90vw;
      height: 600px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      gap: 16px;
      color: var(--SmartThemeBodyColor, #f4f4f5) !important;
      font-family: system-ui, -apple-system, sans-serif;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2);
      box-sizing: border-box;
    ">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1)); padding-bottom: 10px;">
        <span style="font-size: 15px; font-weight: 600; color: var(--SmartThemeBodyColor, #ffffff) !important; display: flex; align-items: center; gap: 8px;">
          <svg style="width: 18px; height: 18px; fill: var(--SmartThemeQuoteColor, #a855f7);" viewBox="0 0 24 24"><path d="M3 17h2v2H3v-2zm0-4h2v2H3v-2zm0-4h2v2H3V9zm0-4h2v2H3V5zm4 12h14v2H7v-2zm0-4h14v2H7v-2zm0-4h14v2H7V9zm0-4h14v2H7V5z"/></svg>
          编辑世界书条目模板
        </span>
        <span id="fire-story-template-close" style="cursor: pointer; opacity: 0.5; font-size: 20px; line-height: 1; color: var(--SmartThemeEmColor, #a1a1aa); transition: opacity 0.2s;">✕</span>
      </div>

      <div style="flex: 1; display: flex; flex-direction: column; gap: 8px; min-height: 0;">
        <textarea id="fire-story-template-textarea" style="
          flex: 1; width: 100%; height: 100%; padding: 12px; font-size: 13px; border-radius: 8px;
          background: var(--SmartThemeChatTintColor, rgba(0,0,0,0.1)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); color: var(--SmartThemeBodyColor, #ffffff);
          font-family: monospace; outline: none; resize: none; box-sizing: border-box; line-height: 1.5;
        "></textarea>
        <span style="font-size:11px;opacity:0.6;">可用占位符：{{playlist_name}} (歌单名), {{play_tag}} (点歌格式), {{play_example}} (播歌示例), {{songs_list}} (歌曲列表)</span>
      </div>

      <div style="display: flex; gap: 10px; justify-content: flex-end; border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1)); padding-top: 12px;">
        <button id="fire-story-template-cancel" style="
          padding: 8px 16px; font-size: 13px; border-radius: 8px; border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15));
          background: transparent; color: var(--SmartThemeEmColor, #a1a1aa); cursor: pointer; transition: all 0.2s;
        ">取消</button>
        <button id="fire-story-template-save" style="
          padding: 8px 16px; font-size: 13px; border-radius: 8px; border: none;
          background: var(--SmartThemeQuoteColor, #a855f7); color: var(--SmartThemeBodyColor, #ffffff); cursor: pointer; font-weight: 500; transition: all 0.2s;
        ">保存</button>
      </div>
    </div>
  `;
  parentDoc.body.appendChild(modal);

  var textarea = parentDoc.getElementById('fire-story-template-textarea');
  textarea.value = currentVal;

  parentDoc.getElementById('fire-story-template-close').addEventListener('click', function () { modal.remove(); });
  parentDoc.getElementById('fire-story-template-cancel').addEventListener('click', function () { modal.remove(); });
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });

  parentDoc.getElementById('fire-story-template-save').addEventListener('click', function () {
    var newVal = textarea.value;
    ss.wiTemplate = newVal;
    _saveState();

    // Sync back to the textarea in settings if it is open
    var localTextarea = document.getElementById('fire-story-wi-template');
    if (localTextarea) {
      localTextarea.value = newVal;
    }
    modal.remove();
  });
}

// ─── 设置面板事件绑定 ─────────────────────────────────────────────────────────
export function bindStorySearchUIEvents(doc) {
  function ss() {
    if (!_state.settings.storySearch) _state.settings.storySearch = {};
    return _state.settings.storySearch;
  }

  var header  = doc.getElementById('fire-settings-header-storysearch');
  var content = doc.getElementById('fire-settings-content-storysearch');
  if (header && content) {
    header.addEventListener('click', function (e) {
      // 阻止点击帮助问号按钮导致面板折叠/展开
      if (e.target.closest('.fire-story-help-btn')) return;

      var isOpen = content.style.display !== 'none';
      content.style.display = isOpen ? 'none' : 'block';
      var chevron = header.querySelector('.fire-settings-chevron');
      if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
      if (!isOpen) _populateTargetPlaylist(doc);
    });
  }

  // 绑定说明书按钮事件
  var helpBtn = doc.querySelector('.fire-story-help-btn');
  if (helpBtn) {
    helpBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      showStorySearchHelp();
    });
  }

  var chkEnabled = doc.getElementById('fire-story-enabled');
  if (chkEnabled) {
    chkEnabled.checked = !!ss().enabled;
    chkEnabled.addEventListener('change', function () {
      ss().enabled = this.checked;
      _saveState();
      if (this.checked) {
        setTimeout(scanAllMessages, 100);
        watchChatMutations();
      } else {
        if (_chatObserver) _chatObserver.disconnect();
      }
    });
  }

  var chkStreamEnabled = doc.getElementById('fire-story-stream-enabled');
  if (chkStreamEnabled) {
    chkStreamEnabled.checked = !!ss().enableStreamSearch;
    chkStreamEnabled.addEventListener('change', function () {
      ss().enableStreamSearch = this.checked;
      _saveState();
      if (this.checked && ss().enabled) {
        watchChatMutations();
      } else {
        if (_chatObserver) _chatObserver.disconnect();
      }
    });
  }

  var chkHighlight = doc.getElementById('fire-story-highlight');
  if (chkHighlight) {
    chkHighlight.checked = ss().enableHighlight !== false;
    chkHighlight.addEventListener('change', function () {
      ss().enableHighlight = this.checked;
      _saveState();
      setTimeout(function () {
        var doc = _getDoc();
        if (doc) {
          doc.querySelectorAll('.mes_text[data-fire-story-done]').forEach(function (el) {
            delete el.dataset.fireStoryDone;
          });
        }
        scanAllMessages();
      }, 100);
    });
  }

  var chkScrollPlay = doc.getElementById('fire-story-scrollplay');
  if (chkScrollPlay) {
    chkScrollPlay.checked = ss().enableScrollPlay !== false;
    chkScrollPlay.addEventListener('change', function () {
      ss().enableScrollPlay = this.checked;
      _saveState();
    });
  }

  var inputTemplate = doc.getElementById('fire-story-template');
  if (inputTemplate) {
    inputTemplate.value = ss().tagTemplate || '♪{song} - {artist}♪';
    inputTemplate.addEventListener('change', function () {
      ss().tagTemplate = this.value.trim() || '♪{song} - {artist}♪';
      _saveState();
    });
  }

  var inputDefaultStart = doc.getElementById('fire-story-default-start');
  if (inputDefaultStart) {
    inputDefaultStart.value = ss().defaultStartPos || '';
    inputDefaultStart.addEventListener('change', function () {
      ss().defaultStartPos = this.value.trim();
      _saveState();
    });
  }

  var selStartScope = doc.getElementById('fire-story-default-start-scope');
  if (selStartScope) {
    selStartScope.value = ss().defaultStartPosScope || 'story_only';
    selStartScope.addEventListener('change', function () {
      ss().defaultStartPosScope = this.value;
      _saveState();
    });
  }

  var selSwitch = doc.getElementById('fire-story-switchmode');
  if (selSwitch) {
    selSwitch.value = ss().switchMode || 'queue';
    selSwitch.addEventListener('change', function () { ss().switchMode = this.value; _saveState(); });
  }

  var selMulti = doc.getElementById('fire-story-multitagmode');
  if (selMulti) {
    selMulti.value = ss().multiTagMode || 'first_cut_rest_queue';
    selMulti.addEventListener('change', function () { ss().multiTagMode = this.value; _saveState(); });
  }

  var chkRetrigger = doc.getElementById('fire-story-retrigger');
  if (chkRetrigger) {
    chkRetrigger.checked = !!ss().allowRetrigger;
    chkRetrigger.addEventListener('change', function () { ss().allowRetrigger = this.checked; _saveState(); });
  }

  var selMode = doc.getElementById('fire-story-playlistmode');
  var subOpts = doc.getElementById('fire-story-playlist-sub');
  if (selMode) {
    selMode.value = ss().playlistMode || 'any';
    function _updateSubVis() {
      if (subOpts) {
        var isPlaylist = selMode.value === 'playlist_only_stop' || selMode.value === 'playlist_only_random';
        subOpts.style.display = isPlaylist ? 'flex' : 'none';
      }
    }
    _updateSubVis();
    selMode.addEventListener('change', function () {
      ss().playlistMode = this.value;
      _saveState();
      _updateSubVis();
      if (this.value !== 'any') _populateTargetPlaylist(doc);
    });
  }

  var selTarget = doc.getElementById('fire-story-targetplaylist');
  if (selTarget) {
    selTarget.addEventListener('change', function () { ss().targetPlaylist = this.value; _saveState(); });
  }

  var txtWiTemplate = doc.getElementById('fire-story-wi-template');
  if (txtWiTemplate) {
    txtWiTemplate.value = ss().wiTemplate || '[FIRE Music Reference - {{playlist_name}}]\n以下是歌单中的歌曲，可在剧情中选用：\n\n{{songs_list}}\n\n在剧情中需要播放音乐时，请在发言中包含格式：{{play_tag}}\n例如：{{play_example}}';
    txtWiTemplate.addEventListener('change', function () {
      ss().wiTemplate = this.value;
      _saveState();
    });
  }

  var btnExport = doc.getElementById('fire-story-export-wi-btn');
  if (btnExport) {
    btnExport.addEventListener('click', function () { showWIExportModal(doc); });
  }

  var btnExpandTemplate = doc.querySelector('.fire-story-template-expand-btn');
  if (btnExpandTemplate) {
    btnExpandTemplate.addEventListener('click', function (e) {
      e.stopPropagation();
      showFullScreenTemplateEditor();
    });
  }
}

function _populateTargetPlaylist(doc) {
  var sel = doc.getElementById('fire-story-targetplaylist');
  if (!sel || !_state) return;
  sel.innerHTML = '';
  var current = (_state.settings.storySearch || {}).targetPlaylist || _state.currentPlaylist;
  Object.keys(_state.playlists || {}).forEach(function (name) {
    var opt = doc.createElement('option');
    opt.value = name;
    opt.textContent = name;
    opt.selected = name === current;
    sel.appendChild(opt);
  });
}

// ─── 世界书导出弹窗 ───────────────────────────────────────────────────────────
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

function showWIExportModal(doc) {
  try {
    var parentDoc = getSafeParentDocument();
    var existing = parentDoc.getElementById('fire-wi-export-modal');
    if (existing) existing.remove();

    var currentCharWorld = '';
    try {
      var char = characters[this_chid];
      currentCharWorld = (char && char.data && char.data.extensions && char.data.extensions.world) || '';
    } catch (_e) {}

    var playlistOpts = Object.keys(_state.playlists || {})
      .map(function (n) {
        var escaped = n.replace(/"/g, '&quot;');
        return `<option value="${escaped}">${n}</option>`;
      })
      .join('');

    if (!playlistOpts) { _showToast('没有可用的歌单'); return; }

    // Resolve computed theme background color from the parent window
    var temp = parentDoc.createElement('div');
    temp.style.color = 'var(--SmartThemeBlurTintColor)';
    parentDoc.body.appendChild(temp);
    var parentColor = getSafeParentWindow().getComputedStyle(temp).color;
    parentDoc.body.removeChild(temp);

    var opaqueBg = getOpaqueRGB(parentColor);
    if (!opaqueBg) {
      var directVal = getSafeParentWindow().getComputedStyle(parentDoc.documentElement).getPropertyValue('--SmartThemeBlurTintColor');
      opaqueBg = getOpaqueRGB(directVal);
    }
    if (!opaqueBg) {
      opaqueBg = 'rgb(8, 13, 20)'; // fallback
    }

    var modal = parentDoc.createElement('div');
    modal.id = 'fire-wi-export-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;z-index:2999999;background:rgba(9,9,11,0.65);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;box-sizing:border-box;';
    modal.innerHTML = `
      <div class="fire-wi-export-card" style="
        background: ${opaqueBg} !important;
        border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15)) !important;
        border-radius: 16px;
        padding: 24px;
        width: 380px;
        max-width: 90vw;
        display: flex;
        flex-direction: column;
        gap: 16px;
        color: var(--SmartThemeBodyColor, #f4f4f5) !important;
        font-family: system-ui, -apple-system, sans-serif;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2);
        box-sizing: border-box;
      ">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 16px; font-weight: 600; color: var(--SmartThemeBodyColor, #ffffff) !important; display: flex; align-items: center; gap: 8px;">
            <svg style="width: 18px; height: 18px; fill: var(--SmartThemeQuoteColor, #a855f7);" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            生成世界书条目
          </span>
          <span id="fire-wi-close" style="cursor: pointer; opacity: 0.5; font-size: 20px; line-height: 1; color: var(--SmartThemeEmColor, #a1a1aa); transition: opacity 0.2s;">✕</span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--SmartThemeEmColor, #a1a1aa);">选择歌单</label>
          <select id="fire-wi-playlist" style="
            height: 36px; padding: 0 12px; font-size: 13px; border-radius: 8px;
            background: var(--SmartThemeChatTintColor, rgba(0,0,0,0.1)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); color: var(--SmartThemeBodyColor, #ffffff); outline: none;
          ">${playlistOpts}</select>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--SmartThemeEmColor, #a1a1aa);">包含字段</label>
          <div style="display: flex; flex-direction: column; gap: 8px; padding: 4px 0;">
            <label style="display: flex; align-items: center; gap: 10px; font-size: 13px; cursor: pointer; color: var(--SmartThemeBodyColor, #e4e4e7);">
              <input type="checkbox" id="fire-wi-incl-name" checked style="accent-color: var(--SmartThemeQuoteColor, #a855f7); width: 15px; height: 15px;"> 歌名
            </label>
            <label style="display: flex; align-items: center; gap: 10px; font-size: 13px; cursor: pointer; color: var(--SmartThemeBodyColor, #e4e4e7);">
              <input type="checkbox" id="fire-wi-incl-artist" checked style="accent-color: var(--SmartThemeQuoteColor, #a855f7); width: 15px; height: 15px;"> 歌手
            </label>
            <label style="display: flex; align-items: center; gap: 10px; font-size: 13px; cursor: pointer; color: var(--SmartThemeBodyColor, #e4e4e7);">
              <input type="checkbox" id="fire-wi-incl-tags" checked style="accent-color: var(--SmartThemeQuoteColor, #a855f7); width: 15px; height: 15px;"> Tag 标签
            </label>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--SmartThemeEmColor, #a1a1aa);">条目配置</label>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <div style="display: flex; flex-direction: column; gap: 4px; flex: 2; min-width: 140px;">
              <span style="font-size: 11px; opacity: 0.7; color: var(--SmartThemeBodyColor);">条目注释 (名称)</span>
              <input type="text" id="fire-wi-entry-comment" style="
                height: 32px; padding: 0 10px; font-size: 12px; border-radius: 6px;
                background: var(--SmartThemeChatTintColor, rgba(0,0,0,0.1)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); color: var(--SmartThemeBodyColor, #ffffff); outline: none;
              " placeholder="输入条目注释...">
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px; flex: 2; min-width: 140px;">
              <span style="font-size: 11px; opacity: 0.7; color: var(--SmartThemeBodyColor);">位置 (Position)</span>
              <select id="fire-wi-entry-position" style="
                height: 32px; padding: 0 10px; font-size: 12px; border-radius: 6px;
                background: var(--SmartThemeChatTintColor, rgba(0,0,0,0.1)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); color: var(--SmartThemeBodyColor, #ffffff); outline: none;
              ">
                <option value="0|0">角色定义前（↑ Char）</option>
                <option value="1|0">角色定义后（↓ Char）</option>
                <option value="5|0">示例消息前（↑ EM）</option>
                <option value="6|0">示例消息后（↓ EM）</option>
                <option value="2|0">作者注释前（↑ AN）</option>
                <option value="3|0">作者注释后（↓ AN）</option>
                <option value="4|0" selected>[系统⚙️] 插入深度 @D</option>
                <option value="4|1">[用户👤] 插入深度 @D</option>
                <option value="4|2">[AI🤖] 插入深度 @D</option>
                <option value="7|0">➡️ 锚点</option>
              </select>
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 60px;" id="fire-wi-entry-depth-container">
              <span style="font-size: 11px; opacity: 0.7; color: var(--SmartThemeBodyColor);">深度 (Depth)</span>
              <input type="number" id="fire-wi-entry-depth" style="
                height: 32px; padding: 0 10px; font-size: 12px; border-radius: 6px;
                background: var(--SmartThemeChatTintColor, rgba(0,0,0,0.1)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); color: var(--SmartThemeBodyColor, #ffffff); outline: none;
              " value="4" min="0">
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 60px;">
              <span style="font-size: 11px; opacity: 0.7; color: var(--SmartThemeBodyColor);">顺序 (Order)</span>
              <input type="number" id="fire-wi-entry-order" style="
                height: 32px; padding: 0 10px; font-size: 12px; border-radius: 6px;
                background: var(--SmartThemeChatTintColor, rgba(0,0,0,0.1)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); color: var(--SmartThemeBodyColor, #ffffff); outline: none;
              " value="100" min="0">
            </div>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px;">
          <label style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--SmartThemeEmColor, #a1a1aa);">写入目标</label>
          <div style="display: flex; flex-direction: column; gap: 8px; padding: 4px 0;">
            <label style="display: flex; align-items: center; gap: 10px; font-size: 13px; cursor: pointer; color: var(--SmartThemeBodyColor, #e4e4e7);">
              <input type="radio" name="fire-wi-target" value="new" checked style="accent-color: var(--SmartThemeQuoteColor, #a855f7); width: 15px; height: 15px;"> 新建世界书
            </label>
            <div id="fire-wi-new-name-row" style="display: flex; padding-left: 25px;">
              <input type="text" id="fire-wi-new-name" style="
                flex: 1; height: 32px; padding: 0 10px; font-size: 13px; border-radius: 6px;
                background: var(--SmartThemeChatTintColor, rgba(0,0,0,0.1)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); color: var(--SmartThemeBodyColor, #ffffff); outline: none;
              " placeholder="输入世界书名称...">
            </div>
            <label style="display: flex; align-items: center; gap: 10px; font-size: 13px; cursor: pointer; color: var(--SmartThemeBodyColor, #e4e4e7); ${currentCharWorld ? '' : 'opacity: 0.35; pointer-events: none;'}">
              <input type="radio" name="fire-wi-target" value="char" ${currentCharWorld ? '' : 'disabled'} style="accent-color: var(--SmartThemeQuoteColor, #a855f7); width: 15px; height: 15px;">
              ${currentCharWorld ? `当前角色世界书（${currentCharWorld}）` : '当前角色世界书（无）'}
            </label>
          </div>
        </div>

        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 8px;">
          <button id="fire-wi-cancel" style="
            padding: 8px 16px; font-size: 13px; border-radius: 8px; border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15));
            background: transparent; color: var(--SmartThemeEmColor, #a1a1aa); cursor: pointer; transition: all 0.2s;
          ">取消</button>
          <button id="fire-wi-confirm" style="
            padding: 8px 16px; font-size: 13px; border-radius: 8px; border: none;
            background: var(--SmartThemeQuoteColor, #a855f7); color: var(--SmartThemeBodyColor, #ffffff); cursor: pointer; font-weight: 500; transition: all 0.2s;
          ">写入世界书</button>
        </div>
      </div>
    `;
    parentDoc.body.appendChild(modal);

    parentDoc.getElementById('fire-wi-close').addEventListener('click', function () { modal.remove(); });
    parentDoc.getElementById('fire-wi-cancel').addEventListener('click', function () { modal.remove(); });
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });

    var closeBtn = parentDoc.getElementById('fire-wi-close');
    closeBtn.addEventListener('mouseenter', function() { this.style.opacity = '1'; });
    closeBtn.addEventListener('mouseleave', function() { this.style.opacity = '0.5'; });

    // Pre-fill comment field and watch playlist changes
    var playlistSel = parentDoc.getElementById('fire-wi-playlist');
    var commentInput = parentDoc.getElementById('fire-wi-entry-comment');
    if (playlistSel && commentInput) {
      playlistSel.addEventListener('change', function () {
        commentInput.value = this.value;
      });
      commentInput.value = playlistSel.value;
    }

    // Positions select dynamic depth vis logic
    var posSel = parentDoc.getElementById('fire-wi-entry-position');
    var depthContainer = parentDoc.getElementById('fire-wi-entry-depth-container');
    if (posSel && depthContainer) {
      var updateDepthVis = function() {
        var parts = posSel.value.split('|');
        var pos = parseInt(parts[0]);
        if (pos === 4) { // atDepth
          depthContainer.style.opacity = '1';
          depthContainer.style.pointerEvents = 'auto';
        } else {
          depthContainer.style.opacity = '0.35';
          depthContainer.style.pointerEvents = 'none';
        }
      };
      posSel.addEventListener('change', updateDepthVis);
      updateDepthVis();
    }

    modal.querySelectorAll('input[name="fire-wi-target"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        var row = parentDoc.getElementById('fire-wi-new-name-row');
        if (row) row.style.display = this.value === 'new' ? 'flex' : 'none';
      });
    });

    var confirmBtn = parentDoc.getElementById('fire-wi-confirm');
    confirmBtn.addEventListener('click', async function () {
      var playlist   = parentDoc.getElementById('fire-wi-playlist').value;
      var inclName   = parentDoc.getElementById('fire-wi-incl-name').checked;
      var inclArtist = parentDoc.getElementById('fire-wi-incl-artist').checked;
      var inclTags   = parentDoc.getElementById('fire-wi-incl-tags').checked;
      var targetMode = (modal.querySelector('input[name="fire-wi-target"]:checked') || {}).value || 'new';
      var newWiName  = (parentDoc.getElementById('fire-wi-new-name').value || '').trim();
      var entryComment = (parentDoc.getElementById('fire-wi-entry-comment').value || '').trim() || playlist;
      var entryOrder   = parseInt(parentDoc.getElementById('fire-wi-entry-order').value) ?? 100;
      var entryDepth   = parseInt(parentDoc.getElementById('fire-wi-entry-depth').value) ?? 4;

      var posVal = parentDoc.getElementById('fire-wi-entry-position').value;
      var posParts = posVal.split('|');
      var entryPosition = parseInt(posParts[0]);
      var entryRole = parseInt(posParts[1]);

      confirmBtn.disabled = true;
      confirmBtn.textContent = '写入中...';
      try {
        await doExportToWorldInfo({
          playlist,
          inclName,
          inclArtist,
          inclTags,
          targetMode,
          newWiName,
          currentCharWorld,
          entryComment,
          entryOrder,
          entryDepth,
          entryPosition,
          entryRole
        });
        modal.remove();
      } catch (e) {
        _triggerError('世界书写入失败: ' + e.message);
        confirmBtn.disabled = false;
        confirmBtn.textContent = '写入世界书';
      }
    });
  } catch (err) {
    console.error('[FIRE] showWIExportModal error:', err);
    if (typeof _triggerError === 'function') {
      _triggerError('世界书弹窗渲染失败: ' + err.message);
    }
  }
}

// ─── 世界书写入核心 ───────────────────────────────────────────────────────────
async function doExportToWorldInfo({ playlist, inclName, inclArtist, inclTags, targetMode, newWiName, currentCharWorld, entryComment, entryOrder, entryDepth, entryPosition, entryRole }) {
  var songs = (_state.playlists || {})[playlist] || [];
  var ss = _state.settings.storySearch || {};
  var tagTemplate = ss.tagTemplate || '♪{song} - {artist}♪';

  // Construct songs_list
  var songLines = [];
  songs.forEach(function (song) {
    var parts = [];
    if (inclName   && song.name)                         parts.push(`歌名: ${song.name}`);
    if (inclArtist && song.artist)                       parts.push(`歌手: ${song.artist}`);
    if (inclTags   && song.tags && song.tags.length > 0) parts.push(`标签: ${song.tags.join(', ')}`);
    if (parts.length > 0) songLines.push(parts.join(' | '));
  });
  var songsListStr = songLines.join('\n');

  // Resolve play_example
  var exampleSong = songs.length > 0 ? songs[0] : { name: '歌名', artist: '歌手' };
  var exampleTag = tagTemplate
    .replace('{song}', exampleSong.name)
    .replace('{artist}', exampleSong.artist || '歌手');

  // Resolve template
  var userTemplate = ss.wiTemplate || '[FIRE Music Reference - {{playlist_name}}]\n以下是歌单中的歌曲，可在剧情中选用：\n\n{{songs_list}}\n\n在剧情中需要播放音乐时，请在发言中包含格式：{{play_tag}}\n例如：{{play_example}}';
  
  var content = userTemplate
    .replace(/\{\{playlist_name\}\}/g, playlist)
    .replace(/\{\{play_tag\}\}/g, tagTemplate)
    .replace(/\{\{play_example\}\}/g, exampleTag)
    .replace(/\{\{songs_list\}\}/g, songsListStr);

  var wiName, wiData;

  if (targetMode === 'new') {
    if (!newWiName) throw new Error('请输入世界书名称');
    wiName = newWiName;
    wiData = await loadWorldInfo(wiName);
    if (!wiData) {
      var created = await createNewWorldInfo(wiName, { interactive: false });
      if (!created) throw new Error('创建世界书失败，可能名字冲突或被拒绝');
      wiData = await loadWorldInfo(wiName);
      if (!wiData) wiData = { entries: {} };
    }
  } else {
    wiName = currentCharWorld;
    if (!wiName) throw new Error('当前角色没有关联世界书');
    wiData = await loadWorldInfo(wiName);
    if (!wiData) {
      var created = await createNewWorldInfo(wiName, { interactive: false });
      if (!created) throw new Error('创建角色世界书失败');
      wiData = await loadWorldInfo(wiName);
      if (!wiData) wiData = { entries: {} };
    }
  }

  var entry = createWorldInfoEntry(wiName, wiData);
  if (!entry) throw new Error('无法创建世界书条目（UID 分配失败）');

  entry.comment  = entryComment;
  entry.content  = content;
  entry.constant = true;
  entry.selective = false; // MUST be false to make it a constant entry!
  entry.disable  = false;  // Ensure it is not disabled
  entry.order    = entryOrder;
  entry.depth    = entryDepth;
  entry.position = entryPosition;
  entry.extensions = {
    position: entryPosition,
    depth: entryDepth,
    exclude_recursion: false,
    prevent_recursion: false,
    ignore_budget: false
  };
  if (entryPosition === 4) {
    entry.role = entryRole;
    entry.extensions.role = entryRole;
  }
  entry.key      = [];
  entry.keysecondary = [];
  entry.addMemo  = true;

  await saveWorldInfo(wiName, wiData, true);
  await updateWorldInfoList(); // Sync client UI
  try {
    reloadEditor(wiName, true); // Instantly reload editor if open
  } catch (_e) {}
  _showToast(`已成功写入世界书「${wiName}」`);
}
