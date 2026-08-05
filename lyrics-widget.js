// ─── Desktop Lyrics Widget Helper Module ──────────────────────────────────────

let state = null;
let getDoc = null;
let saveState = null;
let controls = null;

export function initLyricsWidget(sharedState, sharedGetDoc, sharedSaveState, sharedControls) {
  state = sharedState;
  getDoc = sharedGetDoc;
  saveState = sharedSaveState;
  controls = sharedControls;
  
  // Bind global toggle events (right-click / long-press / double-tap)
  bindGlobalToggleEvents();
}

let isGlobalToggleEventsBound = false;

function flashZoneFeedback(el, zone) {
  el.classList.remove('flash-left', 'flash-middle', 'flash-right');
  void el.offsetWidth; // Trigger reflow to restart animation
  el.classList.add('flash-' + zone);
  setTimeout(function() {
    el.classList.remove('flash-' + zone);
  }, 250);
}

function isClickOnPlayerUI(e) {
  if (!e || !e.target || !e.target.closest) return false;
  return !!(
    e.target.closest('#fire-panel') ||
    e.target.closest('#fire-settings-dropdown') ||
    e.target.closest('[id^="fire-export-"]') ||
    e.target.closest('[id^="fire-dup-"]')
  );
}

function bindGlobalToggleEvents() {
  if (isGlobalToggleEventsBound) return;
  isGlobalToggleEventsBound = true;
  
  // Track long press timers
  let longPressTimer = null;
  let touchStartPos = { x: 0, y: 0 };
  
  // Track last tap time for double-tap
  let lastTapTime = 0;
  let controlsTapTimeout = null;
  let doubleTapFired = false;
  
  // Helper to check if coordinate is inside widget
  function isInsideWidget(clientX, clientY) {
    if (!getDoc) return false;
    var doc = getDoc();
    var el = doc.getElementById('fire-desktop-lyrics');
    if (!el || !state || !state.settings.desktopLyricsEnabled) return false;
    var rect = el.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }
  
  function toggleLockState() {
    if (!state) return;
    state.settings.desktopLyricsLocked = !state.settings.desktopLyricsLocked;
    if (saveState) saveState();
    
    // Trigger visual updates
    applyDesktopLyricsSettings();
    
    // Sync settings checkbox if open
    if (getDoc) {
      var lockChk = getDoc().getElementById('fire-setting-lyrics-lock');
      if (lockChk) lockChk.checked = state.settings.desktopLyricsLocked;
    }
    
    // Trigger small vibrate on mobile for haptic feedback
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(50);
    }
  }
  
  var doc = (getDoc ? getDoc() : document) || document;
  
  // 1. Contextmenu (Right-click on PC)
  doc.addEventListener('contextmenu', function(e) {
    if (isClickOnPlayerUI(e)) return;
    if (!state || state.settings.desktopLyricsToggleMethod === 'none') return;
    
    // Check if click was inside widget
    if (isInsideWidget(e.clientX, e.clientY)) {
      e.preventDefault();
      toggleLockState();
    }
  });
  
  // 2. Touch/Mouse events for Mobile Long-press & Double-tap
  doc.addEventListener('touchstart', function(e) {
    if (isClickOnPlayerUI(e)) return;
    if (!state || state.settings.desktopLyricsToggleMethod === 'none') return;
    
    var touch = e.touches[0];
    if (!isInsideWidget(touch.clientX, touch.clientY)) return;
    
    // Handle Double-tap
    if (state.settings.desktopLyricsToggleMethod === 'rightclick_doubletap') {
      var now = Date.now();
      if (now - lastTapTime < 300) {
        e.preventDefault();
        doubleTapFired = true;
        if (controlsTapTimeout) {
          clearTimeout(controlsTapTimeout);
          controlsTapTimeout = null;
        }
        toggleLockState();
        lastTapTime = 0; // reset
        return;
      }
      lastTapTime = now;
    }
    
    // Handle Long-press
    if (state.settings.desktopLyricsToggleMethod === 'rightclick_longpress') {
      touchStartPos = { x: touch.clientX, y: touch.clientY };
      var duration = state.settings.desktopLyricsLongPressTime || 800;
      
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = setTimeout(function() {
        e.preventDefault();
        toggleLockState();
        longPressTimer = null;
      }, duration);
    }
  }, { passive: false });
  
  doc.addEventListener('touchmove', function(e) {
    if (longPressTimer) {
      var touch = e.touches[0];
      var dx = touch.clientX - touchStartPos.x;
      var dy = touch.clientY - touchStartPos.y;
      // If moved significantly, cancel long press
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
  });
  
  function clearLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }
  
  doc.addEventListener('touchend', clearLongPress);
  doc.addEventListener('touchcancel', clearLongPress);

  // 3. Controls Tap/Click Toggle Events (Works even when pointer-events is none or during drag cancel)
  let ctrlTouchStartX = 0;
  let ctrlTouchStartY = 0;
  let ctrlTouchStartTime = 0;
  
  doc.addEventListener('touchstart', function(e) {
    if (isClickOnPlayerUI(e)) return;
    if (e.touches.length > 0) {
      var touch = e.touches[0];
      ctrlTouchStartX = touch.clientX;
      ctrlTouchStartY = touch.clientY;
      ctrlTouchStartTime = Date.now();
    }
  }, { passive: true });
  
  doc.addEventListener('touchend', function(e) {
    if (isClickOnPlayerUI(e)) return;
    if (doubleTapFired) {
      doubleTapFired = false;
      return;
    }
    
    if (!state || !state.settings.desktopLyricsEnabled || !state.settings.desktopLyricsControlsEnabled) return;
    
    var el = doc.getElementById('fire-desktop-lyrics');
    if (!el) return;
    
    if (e.changedTouches.length > 0) {
      var touch = e.changedTouches[0];
      var dx = Math.abs(touch.clientX - ctrlTouchStartX);
      var dy = Math.abs(touch.clientY - ctrlTouchStartY);
      var duration = Date.now() - ctrlTouchStartTime;
      
      if (dx < 6 && dy < 6 && duration < 250) {
        var rect = el.getBoundingClientRect();
        var x = touch.clientX;
        var y = touch.clientY;
        
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          if (e.target && e.target.closest && e.target.closest('.action-btn')) {
            return;
          }
          if (e.cancelable) {
            e.preventDefault(); // Block synthetic mouseup/click events on mobile
          }
          var canShowControls = state.settings.desktopLyricsControlsEnabled && 
            (state.settings.desktopLyricsControlsPolicy === 'always' || !state.settings.desktopLyricsLocked);
            
          if (canShowControls) {
            var runAction = function() {
              var ctrlType = state.settings.desktopLyricsControlsType || 'buttons';
              if (ctrlType === 'zones') {
                var relativeX = x - rect.left;
                var zoneWidth = rect.width / 3;
                if (relativeX < zoneWidth) {
                  flashZoneFeedback(el, 'left');
                  if (controls && typeof controls.playPrev === 'function') {
                    controls.playPrev();
                  }
                } else if (relativeX > zoneWidth * 2) {
                  flashZoneFeedback(el, 'right');
                  if (controls && typeof controls.playNext === 'function') {
                    controls.playNext();
                  }
                } else {
                  flashZoneFeedback(el, 'middle');
                  if (controls && typeof controls.togglePlay === 'function') {
                    controls.togglePlay();
                  }
                }
              } else {
                el.classList.toggle('show-controls');
              }
            };
            
            if (state.settings.desktopLyricsToggleMethod === 'rightclick_doubletap') {
              if (controlsTapTimeout) clearTimeout(controlsTapTimeout);
              controlsTapTimeout = setTimeout(runAction, 250);
            } else {
              runAction();
            }
          }
        }
      }
    }
  }, { passive: false });

  let ctrlMouseStartX = 0;
  let ctrlMouseStartY = 0;
  let ctrlMouseStartTime = 0;
  
  doc.addEventListener('mousedown', function(e) {
    if (isClickOnPlayerUI(e)) return;
    ctrlMouseStartX = e.clientX;
    ctrlMouseStartY = e.clientY;
    ctrlMouseStartTime = Date.now();
  });
  
  doc.addEventListener('mouseup', function(e) {
    if (isClickOnPlayerUI(e)) return;
    if (!state || !state.settings.desktopLyricsEnabled || !state.settings.desktopLyricsControlsEnabled) return;
    
    var el = doc.getElementById('fire-desktop-lyrics');
    if (!el) return;
    
    var dx = Math.abs(e.clientX - ctrlMouseStartX);
    var dy = Math.abs(e.clientY - ctrlMouseStartY);
    var duration = Date.now() - ctrlMouseStartTime;
    
    if (dx < 4 && dy < 4 && duration < 250) {
      var rect = el.getBoundingClientRect();
      var x = e.clientX;
      var y = e.clientY;
      
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        if (e.target && e.target.closest && e.target.closest('.action-btn')) {
          return;
        }
        var canShowControls = state.settings.desktopLyricsControlsEnabled && 
          (state.settings.desktopLyricsControlsPolicy === 'always' || !state.settings.desktopLyricsLocked);
          
        if (canShowControls) {
          var ctrlType = state.settings.desktopLyricsControlsType || 'buttons';
          if (ctrlType === 'zones') {
            var relativeX = x - rect.left;
            var zoneWidth = rect.width / 3;
            if (relativeX < zoneWidth) {
              flashZoneFeedback(el, 'left');
              if (controls && typeof controls.playPrev === 'function') {
                controls.playPrev();
              }
            } else if (relativeX > zoneWidth * 2) {
              flashZoneFeedback(el, 'right');
              if (controls && typeof controls.playNext === 'function') {
                controls.playNext();
              }
            } else {
              flashZoneFeedback(el, 'middle');
              if (controls && typeof controls.togglePlay === 'function') {
                controls.togglePlay();
              }
            }
          } else {
            el.classList.toggle('show-controls');
          }
        }
      }
    }
  });
}

export function ensureDesktopLyrics(lyricsList, lastActiveLineIdx) {
  if (!state || !getDoc) return;
  
  var doc = getDoc();
  var el = doc.getElementById('fire-desktop-lyrics');
  
  if (!state.settings.desktopLyricsEnabled) {
    if (el) el.remove();
    return;
  }
  
  if (!el) {
    el = doc.createElement('div');
    el.id = 'fire-desktop-lyrics';
    el.innerHTML = `
      <div class="fire-desktop-lyrics-toolbar">
        <span class="drag-title"><i class="fa-solid fa-arrows-up-down-left-right"></i> 桌面歌词</span>
        <span class="action-btn lock-btn" id="fire-desktop-lyrics-widget-lock" title="锁定"><i class="fa-solid fa-lock-open"></i></span>
      </div>
      <div class="fire-desktop-lyrics-content">
        <div class="fire-desktop-lyric-line current" id="fire-desktop-lyric-line-current">FIRE 音乐</div>
        <div class="fire-desktop-lyric-line translation" id="fire-desktop-lyric-line-translation" style="display: none;"></div>
      </div>
      <div class="fire-desktop-lyrics-controls" id="fire-desktop-lyrics-controls">
        <span class="action-btn ctrl-btn prev-btn" id="fire-desktop-lyrics-prev" title="上一首"><i class="fa-solid fa-backward-step"></i></span>
        <span class="action-btn ctrl-btn play-btn" id="fire-desktop-lyrics-play" title="播放/暂停"><i class="fa-solid fa-play"></i></span>
        <span class="action-btn ctrl-btn next-btn" id="fire-desktop-lyrics-next" title="下一首"><i class="fa-solid fa-forward-step"></i></span>
      </div>
    `;
    doc.body.appendChild(el);
    

    
    // Bind controls clicks
    var prevBtn = el.querySelector('#fire-desktop-lyrics-prev');
    var playBtn = el.querySelector('#fire-desktop-lyrics-play');
    var nextBtn = el.querySelector('#fire-desktop-lyrics-next');
    
    if (prevBtn) {
      prevBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (controls && typeof controls.playPrev === 'function') {
          controls.playPrev();
        }
      });
    }
    if (playBtn) {
      playBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (controls && typeof controls.togglePlay === 'function') {
          controls.togglePlay();
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (controls && typeof controls.playNext === 'function') {
          controls.playNext();
        }
      });
    }
    
    // Bind widget lock button click
    var widgetLockBtn = el.querySelector('#fire-desktop-lyrics-widget-lock');
    if (widgetLockBtn) {
      widgetLockBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        state.settings.desktopLyricsLocked = true;
        if (saveState) saveState();
        applyDesktopLyricsSettings();
        
        // Sync setting checkbox if open
        var lockChk = doc.getElementById('fire-setting-lyrics-lock');
        if (lockChk) lockChk.checked = true;
      });
    }
    
    // Bind drag events (both mouse and touch support)
    bindDesktopLyricsDrag(el);
  }
  
  applyDesktopLyricsSettings();
  updateDesktopLyrics(lastActiveLineIdx, lyricsList);
}

export function applyDesktopLyricsSettings() {
  if (!state || !getDoc) return;
  
  var doc = getDoc();
  var el = doc.getElementById('fire-desktop-lyrics');
  if (!el) return;
  
  // Set locking class
  if (state.settings.desktopLyricsLocked) {
    el.classList.add('locked');
    el.classList.remove('unlocked');
  } else {
    el.classList.add('unlocked');
    el.classList.remove('locked');
  }
  
  // Apply colors & opacity
  el.style.color = state.settings.desktopLyricsTextColor || '#ffffff';
  
  // Apply z-index layer
  var zIndexVal = parseInt(state.settings.desktopLyricsZIndex, 10);
  if (isNaN(zIndexVal)) {
    zIndexVal = 99999; // Default fallback
  }
  el.style.setProperty('z-index', zIndexVal.toString(), 'important');
  
  // Apply font size
  var curLine = el.querySelector('.fire-desktop-lyric-line.current');
  var transLine = el.querySelector('.fire-desktop-lyric-line.translation');
  var baseSize = state.settings.desktopLyricsFontSize || 16;
  if (curLine) curLine.style.fontSize = baseSize + 'px';
  if (transLine) transLine.style.fontSize = Math.max(12, Math.round(baseSize * 0.75)) + 'px';
  
  // Apply text alignment
  var alignVal = state.settings.desktopLyricsAlign || 'center';
  el.style.textAlign = alignVal;
  var lyricLines = el.querySelectorAll('.fire-desktop-lyric-line');
  lyricLines.forEach(function(line) {
    line.style.textAlign = alignVal;
  });
  
  // Convert hex background color to rgba with opacity
  var bgColor = state.settings.desktopLyricsBgColor || '#080d14';
  var opacity = (state.settings.desktopLyricsBgOpacity !== undefined ? state.settings.desktopLyricsBgOpacity : 60) / 100;
  
  // Basic parsing for hex to rgb
  var r = 8, g = 13, b = 20; // Default '#080d14'
  if (bgColor.startsWith('#')) {
    var hex = bgColor.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  }
  el.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${opacity})`;
  
  // Position
  var isMobile = (window.parent || window).innerWidth <= 760;
  if (state.settings.desktopLyricsLeft && state.settings.desktopLyricsTop) {
    el.style.left = state.settings.desktopLyricsLeft;
    el.style.top = state.settings.desktopLyricsTop;
    el.style.bottom = 'auto';
    el.style.right = 'auto';
  } else {
    if (isMobile) {
      // Default mobile position: top center, almost full width
      el.style.left = '10px';
      el.style.right = '10px';
      el.style.top = '20px';
      el.style.bottom = 'auto';
    } else {
      // Default desktop position: top center
      el.style.left = 'calc(50% - 150px)';
      el.style.top = '20px';
      el.style.bottom = 'auto';
      el.style.right = 'auto';
    }
  }

  // Set controls classes
  if (state.settings.desktopLyricsControlsEnabled) {
    el.classList.add('controls-enabled');
    var ctrlType = state.settings.desktopLyricsControlsType || 'buttons';
    if (ctrlType === 'zones') {
      el.classList.add('controls-type-zones');
      el.classList.remove('controls-type-buttons');
    } else {
      el.classList.add('controls-type-buttons');
      el.classList.remove('controls-type-zones');
    }
  } else {
    el.classList.remove('controls-enabled', 'controls-type-buttons', 'controls-type-zones');
  }
  
  if (state.settings.desktopLyricsControlsPolicy === 'always') {
    el.classList.add('controls-always');
    el.classList.remove('controls-unlocked');
  } else {
    el.classList.add('controls-unlocked');
    el.classList.remove('controls-always');
  }

  var canShowControls = state.settings.desktopLyricsControlsEnabled && 
    (state.settings.desktopLyricsControlsPolicy === 'always' || !state.settings.desktopLyricsLocked);
  if (!canShowControls) {
    el.classList.remove('show-controls');
  }

  // Handle controls element visibility
  var controlsEl = el.querySelector('#fire-desktop-lyrics-controls');
  if (controlsEl) {
    var ctrlType = state.settings.desktopLyricsControlsType || 'buttons';
    if (state.settings.desktopLyricsControlsEnabled && ctrlType === 'buttons') {
      controlsEl.style.display = 'flex';
    } else {
      controlsEl.style.display = 'none';
    }
  }
}

function bindDesktopLyricsDrag(el) {
  var isDragging = false;
  var startX, startY;
  var startLeft, startTop;
  
  // Mouse event listeners
  el.addEventListener('mousedown', function(e) {
    if (state.settings.desktopLyricsLocked) return;
    if (e.target.closest('.action-btn')) return;
    
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    
    var rect = el.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    
    e.preventDefault();
  });
  
  function onMouseMove(e) {
    if (!isDragging) return;
    
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    
    var newLeft = startLeft + dx;
    var newTop = startTop + dy;
    
    var rect = el.getBoundingClientRect();
    
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - rect.width));
    newTop = Math.max(0, Math.min(newTop, window.innerHeight - rect.height));
    
    el.style.left = newLeft + 'px';
    el.style.top = newTop + 'px';
    el.style.bottom = 'auto';
    el.style.right = 'auto';
  }
  
  function onMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    
    state.settings.desktopLyricsLeft = el.style.left;
    state.settings.desktopLyricsTop = el.style.top;
    if (saveState) saveState();
  }

  // Touch event listeners for mobile dragging
  el.addEventListener('touchstart', function(e) {
    if (state.settings.desktopLyricsLocked) return;
    if (e.target.closest('.action-btn')) return;
    
    var touch = e.touches[0];
    isDragging = true;
    startX = touch.clientX;
    startY = touch.clientY;
    
    var rect = el.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
  
  function onTouchMove(e) {
    if (!isDragging) return;
    var touch = e.touches[0];
    
    var dx = touch.clientX - startX;
    var dy = touch.clientY - startY;
    
    var newLeft = startLeft + dx;
    var newTop = startTop + dy;
    
    var rect = el.getBoundingClientRect();
    
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - rect.width));
    newTop = Math.max(0, Math.min(newTop, window.innerHeight - rect.height));
    
    el.style.left = newLeft + 'px';
    el.style.top = newTop + 'px';
    el.style.bottom = 'auto';
    el.style.right = 'auto';
    
    if (e.cancelable) e.preventDefault();
  }
  
  function onTouchEnd() {
    if (!isDragging) return;
    isDragging = false;
    
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
    
    state.settings.desktopLyricsLeft = el.style.left;
    state.settings.desktopLyricsTop = el.style.top;
    if (saveState) saveState();
  }
}

export function updateDesktopLyrics(activeIdx, lyricsList) {
  if (!state || !getDoc) return;
  
  var doc = getDoc();
  var el = doc.getElementById('fire-desktop-lyrics');
  if (!el && state.settings.desktopLyricsEnabled) {
    ensureDesktopLyrics(lyricsList, activeIdx);
    return;
  }
  var curLine = doc.getElementById('fire-desktop-lyric-line-current');
  var transLine = doc.getElementById('fire-desktop-lyric-line-translation');
  if (!curLine) return;
  
  if (!state.settings.desktopLyricsEnabled) return;
  
  if (lyricsList && lyricsList.length > 0 && activeIdx >= 0 && activeIdx < lyricsList.length) {
    var item = lyricsList[activeIdx];
    curLine.textContent = item.text || '...';
    if (transLine) {
      transLine.textContent = item.translation || '';
      transLine.style.display = item.translation ? 'block' : 'none';
    }
  } else {
    if (state.currentSong) {
      curLine.textContent = state.currentSong.name + ' - ' + (Array.isArray(state.currentSong.artist) ? state.currentSong.artist.join(' / ') : state.currentSong.artist);
    } else {
      curLine.textContent = 'FIRE 音乐';
    }
    if (transLine) {
      transLine.textContent = '';
      transLine.style.display = 'none';
    }
  }

  if (el) {
    var playBtn = el.querySelector('#fire-desktop-lyrics-play');
    if (playBtn) {
      if (state.isPlaying) {
        playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
      } else {
        playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
      }
    }
  }
}

export function clampDesktopLyricsPosition() {
  if (!getDoc) return;
  
  var el = getDoc().getElementById('fire-desktop-lyrics');
  if (!el) return;
  var rect = el.getBoundingClientRect();
  var left = parseFloat(el.style.left);
  var top = parseFloat(el.style.top);
  if (isNaN(left) || isNaN(top)) return;
  
  var newLeft = Math.max(0, Math.min(left, window.innerWidth - rect.width));
  var newTop = Math.max(0, Math.min(top, window.innerHeight - rect.height));
  
  el.style.left = newLeft + 'px';
  el.style.top = newTop + 'px';
  state.settings.desktopLyricsLeft = el.style.left;
  state.settings.desktopLyricsTop = el.style.top;
  if (saveState) saveState();
}
