// ─── listen-together.js ────────────────────────────────────────────────────────
import { name1 } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

let state = null;
let getDoc = null;
let saveState = null;
let eventSource = null;
let event_types = null;
let getLyricsList = null;
let getLastActiveLineIdx = null;

export function initListenTogether(sharedState, sharedGetDoc, sharedSaveState, sharedEventSource, sharedEventTypes, sharedGetLyricsList, sharedGetLastActiveLineIdx) {
  state = sharedState;
  getDoc = sharedGetDoc;
  saveState = sharedSaveState;
  eventSource = sharedEventSource;
  event_types = sharedEventTypes;
  getLyricsList = sharedGetLyricsList;
  getLastActiveLineIdx = sharedGetLastActiveLineIdx;

  // Bind SillyTavern prompt hooks
  bindPromptHooks();
}

function isUserRole(role, userName) {
  if (typeof role !== 'string') return false;
  var r = role.toLowerCase();
  if (r === 'user') return true;
  if (userName && role === userName) return true;
  return false;
}

function injectListenTogether(chatContext) {
  if (!chatContext) return;

  // Guard: prevent double injection during a single generation cycle
  if (chatContext.listen_together_injected) {
    return;
  }

  var text = getListenTogetherPromptText();
  if (!text) return;

  var ctx = null;
  try {
    if (globalThis.SillyTavern && typeof globalThis.SillyTavern.getContext === 'function') {
      ctx = globalThis.SillyTavern.getContext();
    } else {
      ctx = getContext();
    }
  } catch (e) {}

  var userName = ctx ? ctx.name1 : (name1 || 'user');
  var rawChat = ctx ? (ctx.chat || []) : [];
  var lastUserChat = null;
  for (var i = rawChat.length - 1; i >= 0; i--) {
    if (rawChat[i].is_user) {
      lastUserChat = rawChat[i];
      break;
    }
  }
  var lastUserContent = lastUserChat ? lastUserChat.mes : '';

  // Case 1: Chat Completion format (e.g. OpenAI, Claude, DeepSeek API)
  if (Array.isArray(chatContext.chat)) {
    var userIdx = -1;
    // Attempt 1: Content + Role Match (most precise)
    if (lastUserContent) {
      for (var i = chatContext.chat.length - 1; i >= 0; i--) {
        var m = chatContext.chat[i];
        if ((m.is_user === true || isUserRole(m.role, userName)) && m.content && m.content.includes(lastUserContent)) {
          userIdx = i;
          break;
        }
      }
    }
    // Attempt 2: Case-insensitive / username role Match
    if (userIdx === -1) {
      for (var i = chatContext.chat.length - 1; i >= 0; i--) {
        var m = chatContext.chat[i];
        if (m.is_user === true || isUserRole(m.role, userName)) {
          userIdx = i;
          break;
        }
      }
    }

    if (userIdx !== -1) {
      var originalMsg = chatContext.chat[userIdx];
      if (originalMsg.content && originalMsg.content.includes(text.trim())) {
        chatContext.listen_together_injected = true;
        return;
      }
      var mutatedMsg = Object.assign({}, originalMsg);
      mutatedMsg.content = (mutatedMsg.content || '') + '\n\n' + text.trim();
      chatContext.chat[userIdx] = mutatedMsg;
      chatContext.listen_together_injected = true;
      console.log('[FIRE Listen Together] Appended listen state suffix to the last user message (Chat Completion).');
    } else {
      var sysIdx = chatContext.chat.map(function(m) { return m.role; }).lastIndexOf('system');
      var insertAt = sysIdx === -1 ? 0 : sysIdx + 1;
      chatContext.chat.splice(insertAt, 0, {
        role: 'system',
        content: text.trim(),
        injected: true,
        identifier: 'listen_together_state_injection'
      });
      chatContext.listen_together_injected = true;
      console.log('[FIRE Listen Together] Fallback: Injected listen state as system message (Chat Completion).');
    }
  }
  // Case 2: Text Generation format (e.g. KoboldAI, TextGenWebUI API)
  else if (Array.isArray(chatContext.finalMesSend)) {
    var userIdx = -1;
    // Attempt 1: Content + Role Match
    if (lastUserContent) {
      for (var i = chatContext.finalMesSend.length - 1; i >= 0; i--) {
        var m = chatContext.finalMesSend[i];
        if ((m.is_user || isUserRole(m.role, userName)) && m.message && m.message.includes(lastUserContent)) {
          userIdx = i;
          break;
        }
      }
    }
    // Attempt 2: Role Match
    if (userIdx === -1) {
      for (var i = chatContext.finalMesSend.length - 1; i >= 0; i--) {
        var m = chatContext.finalMesSend[i];
        if (m.is_user || isUserRole(m.role, userName)) {
          userIdx = i;
          break;
        }
      }
    }

    if (userIdx !== -1) {
      var originalMsg = chatContext.finalMesSend[userIdx];
      if (originalMsg.message && originalMsg.message.includes(text.trim())) {
        chatContext.listen_together_injected = true;
        return;
      }
      var mutatedMsg = Object.assign({}, originalMsg);
      mutatedMsg.message = (mutatedMsg.message || '') + '\n\n' + text.trim();
      chatContext.finalMesSend[userIdx] = mutatedMsg;
      chatContext.listen_together_injected = true;
      console.log('[FIRE Listen Together] Appended listen state suffix to the last user message (TextGen).');
    } else {
      if (chatContext.finalMesSend.length > 0) {
        var lastIdx = chatContext.finalMesSend.length - 1;
        var originalMsg = chatContext.finalMesSend[lastIdx];
        if (originalMsg.message && originalMsg.message.includes(text.trim())) {
          chatContext.listen_together_injected = true;
          return;
        }
        var mutatedMsg = Object.assign({}, originalMsg);
        mutatedMsg.message = (mutatedMsg.message || '') + '\n\n' + text.trim();
        chatContext.finalMesSend[lastIdx] = mutatedMsg;
        chatContext.listen_together_injected = true;
        console.log('[FIRE Listen Together] Fallback: Appended listen state suffix to the last message (TextGen).');
      } else {
        if (chatContext.main !== undefined) {
          if (chatContext.main.includes(text.trim())) {
            chatContext.listen_together_injected = true;
            return;
          }
          chatContext.main = (chatContext.main || '') + '\n\n' + text.trim();
          chatContext.listen_together_injected = true;
          console.log('[FIRE Listen Together] Fallback: Appended listen state to system prompt.');
        }
      }
    }
  }
}

function bindPromptHooks() {
  if (!eventSource || !event_types) return;

  // 1. GENERATE_BEFORE_COMBINE_PROMPTS hook (for TextGen, defers for Chat Completion)
  eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, async function (chatContext) {
    try {
      if (!state || !state.settings.listenTogetherEnabled) return;
      if (!state.isPlaying || !state.currentSong) return;

      if (chatContext && Array.isArray(chatContext.chat)) {
        console.log('[FIRE Listen Together] Chat Completion detected, deferring injection to CHAT_COMPLETION_PROMPT_READY.');
        return;
      }
      injectListenTogether(chatContext);
    } catch (e) {
      console.error('[FIRE Listen Together] Prompt injection failed:', e);
    }
  });

  // 2. CHAT_COMPLETION_PROMPT_READY hook (for Chat Completion)
  eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async function (chatContext) {
    try {
      if (!state || !state.settings.listenTogetherEnabled) return;
      if (!state.isPlaying || !state.currentSong) return;

      injectListenTogether(chatContext);
    } catch (e) {
      console.error('[FIRE Listen Together] Chat completion prompt injection failed:', e);
    }
  });
}

function getListenTogetherPromptText() {
  if (!state || !state.currentSong) return '';
  
  var song = state.currentSong;
  var songName = song.name || '未知歌名';
  var artistName = song.artist ? (Array.isArray(song.artist) ? song.artist.join(' / ') : song.artist) : '未知歌手';
  
  // Format tags
  var tagsStr = '';
  if (song.tags && song.tags.length > 0) {
    tagsStr = song.tags.join(', ');
  }

  // Get lyrics snippet
  var lyricsCount = state.settings.listenTogetherLyricsCount || '5';
  var list = getLyricsList ? getLyricsList() : [];
  var activeIdx = getLastActiveLineIdx ? getLastActiveLineIdx() : -1;
  var lyricsSnippet = getLyricsSnippet(lyricsCount, activeIdx, list);

  // Format template
  var ss = state.settings.storySearch || {};
  var tagTemplate = ss.tagTemplate || '♪{song} - {artist}♪';
  
  var exampleSong = { name: songName, artist: artistName };
  var exampleTag = tagTemplate
    .replace('{song}', exampleSong.name)
    .replace('{artist}', exampleSong.artist);

  var template = state.settings.listenTogetherTemplate || '[一起听]\n{{user}}当前正在听：{{song}} - {{artist}}\n标签：{{tags}}\n当前歌词：\n{{lyrics}}\n你可以按照以下格式，和{{user}}分享自己喜欢的歌（不要选择同一首）： {{play_tag}}';
  
  var result = template
    .replace(/\{\{song\}\}/g, songName)
    .replace(/\{\{artist\}\}/g, artistName)
    .replace(/\{\{tags\}\}/g, tagsStr)
    .replace(/\{\{lyrics\}\}/g, lyricsSnippet)
    .replace(/\{\{play_tag\}\}/g, tagTemplate)
    .replace(/\{\{play_example\}\}/g, exampleTag)
    .replace(/\{\{user\}\}/g, name1 || 'user');

  return result;
}

function getLyricsSnippet(count, activeIdx, list) {
  if (!list || list.length === 0) return '';
  
  function formatLine(item, isCurrent) {
    var text = item.text || '';
    if (item.translation) {
      text += ' (' + item.translation + ')';
    }
    return isCurrent ? `>>> ${text} <<<` : text;
  }

  if (count === 'all') {
    return list.map(function(item, idx) {
      return formatLine(item, idx === activeIdx);
    }).join('\n');
  }

  var num = parseInt(count, 10);
  if (isNaN(num) || num <= 0) return '';

  var offset = Math.floor((num - 1) / 2);
  var current = activeIdx >= 0 ? activeIdx : 0;
  var start = Math.max(0, current - offset);
  var end = Math.min(list.length - 1, current + offset);

  var snippetLines = [];
  for (var i = start; i <= end; i++) {
    snippetLines.push(formatLine(list[i], i === activeIdx));
  }
  return snippetLines.join('\n');
}

// ─── 安全跨域 DOM 辅助 ────────────────────────────────────────────────────────
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

// ─── 帮助弹窗相关 ─────────────────────────────────────────────────────────────
export function showListenTogetherHelp() {
  var parentDoc = getSafeParentDocument();
  var existing = parentDoc.getElementById('fire-listen-help-modal');
  if (existing) existing.remove();

  var modal = parentDoc.createElement('div');
  modal.id = 'fire-listen-help-modal';
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
          “一起听”模式说明书
        </span>
        <span id="fire-listen-help-close" style="cursor: pointer; opacity: 0.5; font-size: 20px; line-height: 1; color: var(--SmartThemeEmColor, #a1a1aa); transition: opacity 0.2s;">✕</span>
      </div>

      <div style="font-size: 12.5px; display: flex; flex-direction: column; gap: 12px; max-height: 60vh; overflow-y: auto; padding-right: 4px;">
        <div>
          <b style="color:var(--SmartThemeQuoteColor, #a855f7);">1. 什么是“一起听”？</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">“一起听”能够在大模型生成回复时，将您当前播放的歌曲信息、Tag 和部分歌词<b>动态注入</b>到您的输入文本末尾，让角色产生在和您“共听一首歌”的沉浸式体验。</p>
        </div>
        
        <div>
          <b style="color:var(--SmartThemeQuoteColor, #a855f7);">2. 动态注入（防上下文污染）</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">该功能在内存中拼装发送的数据包，<b>绝对不会</b>将歌词保存到聊天记录数据库中。因此历史消息中不会包含累积的歌词，不用担心膨胀上下文 Token 费用。</p>
        </div>

        <div>
          <b style="color:var(--SmartThemeQuoteColor, #a855f7);">3. 模板定制占位符</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">
            支持以下变量的自动填充：<br>
            • <code>{{song}}</code>：歌名<br>
            • <code>{{artist}}</code>：歌手<br>
            • <code>{{tags}}</code>：歌曲标签<br>
            • <code>{{lyrics}}</code>：当前歌词片段（高亮当前唱的那句）<br>
            • <code>{{play_tag}}</code>：点歌宏格式（如：<code>♪{song} - {artist}♪</code>）<br>
            • <code>{{play_example}}</code>：自动生成的第一个点播指令例句
          </p>
        </div>

        <div>
          <b style="color:var(--SmartThemeQuoteColor, #f43f5e);">⚠️ 与“剧情搜歌”联动注意</b>
          <p style="margin: 4px 0 0 0; opacity: 0.85;">
            <b>重点提示</b>：如果您同时开启了“一起听”和“剧情搜歌”，由于“一起听”已经将您当前听的歌和格式告知了 AI，<b>请尽量关闭“剧情搜歌”的世界书注入、固定歌单限制与多余提示词，并关闭预设中的重复指令</b>，避免向 AI 传递重复或互相矛盾的指令，产生多余的 Token 消耗或行为逻辑紊乱。
          </p>
        </div>
      </div>

      <div style="display: flex; justify-content: flex-end; border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1)); padding-top: 12px; margin-top: 4px;">
        <button id="fire-listen-help-ok" style="
          padding: 8px 20px; font-size: 13px; border-radius: 8px; border: none;
          background: var(--SmartThemeQuoteColor, #a855f7); color: var(--SmartThemeBodyColor, #ffffff); cursor: pointer; font-weight: 500; transition: all 0.2s;
        ">我知道了</button>
      </div>
    </div>
  `;
  parentDoc.body.appendChild(modal);

  parentDoc.getElementById('fire-listen-help-close').addEventListener('click', function () { modal.remove(); });
  parentDoc.getElementById('fire-listen-help-ok').addEventListener('click', function () { modal.remove(); });
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });
}

// ─── 全屏编辑器 ──────────────────────────────────────────────────────────────
export function showFullScreenListenTogetherEditor() {
  var parentDoc = getSafeParentDocument();
  var existing = parentDoc.getElementById('fire-listen-template-modal');
  if (existing) existing.remove();

  var currentVal = state.settings.listenTogetherTemplate || '[一起听]\n{{user}}当前正在听：{{song}} - {{artist}}\n标签：{{tags}}\n当前歌词：\n{{lyrics}}\n你可以按照以下格式，和{{user}}分享自己喜欢的歌（不要选择同一首）： {{play_tag}}';

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
  modal.id = 'fire-listen-template-modal';
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
          编辑“一起听”提示词模板
        </span>
        <span id="fire-listen-template-close" style="cursor: pointer; opacity: 0.5; font-size: 20px; line-height: 1; color: var(--SmartThemeEmColor, #a1a1aa); transition: opacity 0.2s;">✕</span>
      </div>

      <div style="flex: 1; display: flex; flex-direction: column; gap: 8px; min-height: 0;">
        <textarea id="fire-listen-template-textarea" style="
          flex: 1; width: 100%; height: 100%; padding: 12px; font-size: 13px; border-radius: 8px;
          background: var(--SmartThemeChatTintColor, rgba(0,0,0,0.1)); border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15)); color: var(--SmartThemeBodyColor, #ffffff);
          font-family: monospace; outline: none; resize: none; box-sizing: border-box; line-height: 1.5;
        "></textarea>
        <span style="font-size:11px;opacity:0.6;">可用占位符：{{song}} (歌名), {{artist}} (歌手), {{tags}} (标签), {{lyrics}} (歌词), {{play_tag}} (点歌宏格式), {{play_example}} (播歌指令例句)</span>
      </div>

      <div style="display: flex; gap: 10px; justify-content: flex-end; border-top: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1)); padding-top: 12px;">
        <button id="fire-listen-template-cancel" style="
          padding: 8px 16px; font-size: 13px; border-radius: 8px; border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15));
          background: transparent; color: var(--SmartThemeEmColor, #a1a1aa); cursor: pointer; transition: all 0.2s;
        ">取消</button>
        <button id="fire-listen-template-save" style="
          padding: 8px 16px; font-size: 13px; border-radius: 8px; border: none;
          background: var(--SmartThemeQuoteColor, #a855f7); color: var(--SmartThemeBodyColor, #ffffff); cursor: pointer; font-weight: 500; transition: all 0.2s;
        ">保存</button>
      </div>
    </div>
  `;
  parentDoc.body.appendChild(modal);

  var textarea = parentDoc.getElementById('fire-listen-template-textarea');
  textarea.value = currentVal;

  parentDoc.getElementById('fire-listen-template-close').addEventListener('click', function () { modal.remove(); });
  parentDoc.getElementById('fire-listen-template-cancel').addEventListener('click', function () { modal.remove(); });
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });

  parentDoc.getElementById('fire-listen-template-save').addEventListener('click', function () {
    var newVal = textarea.value;
    state.settings.listenTogetherTemplate = newVal;
    saveState();

    // Sync back to local DOM textarea if open
    var localTextarea = document.getElementById('fire-setting-listen-template');
    if (localTextarea) {
      localTextarea.value = newVal;
    }
    modal.remove();
  });
}
