/**
 * FIRE Extension Floating Action Ball (纯图标磁吸贴边半隐藏悬浮球)
 * 
 * 参考 Zero 拓展架构重构：
 * 1. 紧凑纯圆精致黑胶碟片（~42px 毛玻璃质感 + 主题微光发光边框，移动端自动缩放至 38px）
 * 2. 跨端高性能平滑拖拽（统一 Touch/Mouse 捕获引擎，零丢帧、智能防误触、毫秒级轻点判定）
 * 3. 磁吸贴边（Magnetic Edge Snap）：松手后以弹性缓动自动吸附至最近的屏幕左/右边缘
 * 4. 纯 CSS 自动折叠半隐藏（Docked Edge Half-Hide）：贴边后自动向外折叠 50%，仅留精致圆弧提手；悬停/触摸即刻呼出
 * 5. 视口自适应固定（Viewport Adaptive Snapping）：锁定 left: 0 或 right: 0，任何屏幕缩放与横竖屏永不出界、永不悬空
 * 6. 支持用户偏好开关（可在设置面板随时开启/关闭「贴边半隐藏」）
 * 7. 迷你音乐控制胶囊（Pill）：随贴边方向自动智能翻转方位，包含歌曲信息、播放/暂停、下一首与面板还原
 */

const BALL_ID = 'fire-float-ball';
const POS_KEY = 'fire_floating_ball_pos';

let state = null;
let getDoc = null;
let saveState = null;
let controls = null;

class FloatingBallManager {
  constructor() {
    this.ballEl = null;
    this.innerEl = null;
    this.coverEl = null;
    this.centerDotEl = null;
    this.waveEl = null;
    this.iconEl = null;
    this.pillEl = null;
    this.pillTitleEl = null;
    this.pillArtistEl = null;
    this.pillToggleEl = null;
    this.pillNextEl = null;
    this.pillExpandEl = null;
    this.pillInfoEl = null;

    // Drag & tracking state
    this.isTracking = false;
    this.hasDragged = false;
    this.startX = 0;
    this.startY = 0;
    this.initialLeft = 0;
    this.initialTop = 0;
    this.startTime = 0;

    this.dockSide = 'right'; // 'left' | 'right'
    this.currentTop = 0;
    this.isEventsBound = false;
  }

  /**
   * 初始化依赖状态与控制句柄
   */
  init(sharedState, sharedGetDoc, sharedSaveState, sharedControls) {
    state = sharedState;
    getDoc = sharedGetDoc;
    saveState = sharedSaveState;
    controls = sharedControls;

    this.ensureDom();
  }

  /**
   * 唤起并显示悬浮球
   */
  show() {
    this.ensureDom();
    this.updateUI();
    this.updateAutoHideState();
    if (this.ballEl) {
      this.ballEl.style.display = 'flex';
      this.snapToEdge(false);
    }
  }

  /**
   * 隐藏悬浮球
   */
  hide() {
    if (this.ballEl) {
      this.ballEl.classList.remove('show-pill', 'is-hovered');
      this.ballEl.style.display = 'none';
    }
  }

  /**
   * 确保 DOM 结构挂载与引用初始化
   */
  ensureDom() {
    const doc = getDoc ? getDoc() : document;
    let ball = doc.getElementById(BALL_ID);

    if (!ball) {
      ball = doc.createElement('div');
      ball.id = BALL_ID;
      ball.className = 'fire-float-ball interactable';
      ball.style.display = 'none';
      ball.innerHTML = `
        <div class="fire-float-ball-inner" id="fire-float-ball-inner">
          <img id="fire-float-ball-cover" style="display: none;" alt="cover" />
          <div class="fire-float-center-dot" id="fire-float-center-dot" style="display: none;"></div>
          <div class="fire-float-wave" id="fire-float-wave" style="display: none;">
            <span></span><span></span><span></span>
          </div>
          <i id="fire-float-ball-icon" class="fa-solid fa-music fire-float-ball-icon"></i>
        </div>
        <div class="fire-float-pill pill-left" id="fire-float-pill">
          <div class="fire-float-pill-info" title="点击展开播放器">
            <span class="fire-float-pill-title" id="fire-float-pill-title">FIRE 音乐</span>
            <span class="fire-float-pill-artist" id="fire-float-pill-artist">点击展开</span>
          </div>
          <div class="fire-float-pill-actions">
            <button class="fire-pill-btn" id="fire-float-pill-toggle" title="播放/暂停"><i class="fa-solid fa-play"></i></button>
            <button class="fire-pill-btn" id="fire-float-pill-next" title="下一首"><i class="fa-solid fa-forward-step"></i></button>
            <button class="fire-pill-btn" id="fire-float-pill-expand" title="展开面板"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button>
          </div>
        </div>
      `;
      doc.body.appendChild(ball);
    }

    this.ballEl = ball;
    this.innerEl = ball.querySelector('#fire-float-ball-inner');
    this.coverEl = ball.querySelector('#fire-float-ball-cover');
    this.centerDotEl = ball.querySelector('#fire-float-center-dot');
    this.waveEl = ball.querySelector('#fire-float-wave');
    this.iconEl = ball.querySelector('#fire-float-ball-icon');
    this.pillEl = ball.querySelector('#fire-float-pill');
    this.pillTitleEl = ball.querySelector('#fire-float-pill-title');
    this.pillArtistEl = ball.querySelector('#fire-float-pill-artist');
    this.pillToggleEl = ball.querySelector('#fire-float-pill-toggle');
    this.pillNextEl = ball.querySelector('#fire-float-pill-next');
    this.pillExpandEl = ball.querySelector('#fire-float-pill-expand');
    this.pillInfoEl = ball.querySelector('.fire-float-pill-info');

    this.initPosition();
    this.bindEvents();
  }

  /**
   * 初始化位置与侧边贴靠
   */
  initPosition() {
    if (!this.ballEl) return;
    const saved = this.loadPosition();
    const vh = window.innerHeight;
    const bh = this.ballEl.offsetHeight || 42;

    this.dockSide = saved?.side || 'right';
    let top = saved?.top ?? Math.round(vh * 0.65);
    top = Math.max(20, Math.min(top, vh - bh - 20));
    this.currentTop = top;

    this.ballEl.style.top = `${top}px`;
    if (this.dockSide === 'right') {
      this.ballEl.style.left = 'auto';
      this.ballEl.style.right = '0px';
      this.ballEl.classList.remove('docked-left');
      this.ballEl.classList.add('docked-right');
    } else {
      this.ballEl.style.left = '0px';
      this.ballEl.style.right = 'auto';
      this.ballEl.classList.remove('docked-right');
      this.ballEl.classList.add('docked-left');
    }
    this.updateAutoHideState();
    this.updatePillOrientation();
  }

  /**
   * 读取保存的方位与高度配置
   */
  loadPosition() {
    try {
      // 优先从 state.settings 中加载
      if (state && state.settings) {
        let side = state.settings.floatingBallSide;
        let top = typeof state.settings.floatingBallTop === 'number' 
          ? state.settings.floatingBallTop 
          : parseFloat(state.settings.floatingBallTop);

        // 兼容旧版写入的像素 left
        if (!side && state.settings.floatingBallLeft) {
          const leftVal = parseFloat(state.settings.floatingBallLeft) || 0;
          side = (leftVal < window.innerWidth / 2) ? 'left' : 'right';
        }
        if (side && !isNaN(top)) {
          return { side, top };
        }
      }

      // 降级兼容 localStorage
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const side = parsed.side || (typeof parsed.x === 'number' && parsed.x < window.innerWidth / 2 ? 'left' : 'right');
        const top = typeof parsed.top === 'number' ? parsed.top : (typeof parsed.y === 'number' ? parsed.y : null);
        return { side, top };
      }
    } catch (e) {}
    return null;
  }

  /**
   * 保存方位与高度
   */
  savePosition(side, top) {
    const roundTop = Math.round(top);
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ side, top: roundTop }));
    } catch (e) {}

    if (state && state.settings) {
      state.settings.floatingBallSide = side;
      state.settings.floatingBallTop = `${roundTop}px`;
      state.settings.floatingBallLeft = (side === 'left' ? '0px' : `${Math.max(0, window.innerWidth - 42)}px`);
      if (typeof saveState === 'function') {
        saveState();
      }
    }
  }

  /**
   * 贴边半隐藏类同步 (.no-autohide)
   */
  updateAutoHideState() {
    if (!this.ballEl) return;
    const autoHide = state && state.settings ? (state.settings.floatingBallAutoHide !== false) : true;
    if (autoHide) {
      this.ballEl.classList.remove('no-autohide');
    } else {
      this.ballEl.classList.add('no-autohide');
    }
  }

  /**
   * 磁吸贴边吸附核心算法 (平滑缓动 + 视口锚定)
   */
  snapToEdge(animate = true) {
    const ball = this.ballEl;
    if (!ball) return;

    const rect = ball.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = ball.offsetWidth || 42;
    const bh = ball.offsetHeight || 42;

    const centerX = rect.left + bw / 2;
    const snapToRight = centerX >= vw / 2;
    this.dockSide = snapToRight ? 'right' : 'left';

    const finalTop = Math.max(20, Math.min(vh - bh - 20, rect.top));
    this.currentTop = finalTop;
    this.savePosition(this.dockSide, finalTop);

    if (animate) {
      const targetLeft = snapToRight ? vw - bw : 0;
      ball.style.transition = 'left 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), top 0.22s cubic-bezier(0.2, 0.9, 0.3, 1), transform 0.22s ease, opacity 0.22s ease';
      ball.style.left = `${targetLeft}px`;
      ball.style.right = 'auto';
      ball.style.top = `${finalTop}px`;

      setTimeout(() => {
        if (!ball) return;
        ball.style.transition = '';
        if (this.dockSide === 'right') {
          ball.style.left = 'auto';
          ball.style.right = '0px';
          ball.classList.remove('docked-left');
          ball.classList.add('docked-right');
        } else {
          ball.style.left = '0px';
          ball.style.right = 'auto';
          ball.classList.remove('docked-right');
          ball.classList.add('docked-left');
        }
        this.updateAutoHideState();
        this.updatePillOrientation();
      }, 220);
    } else {
      ball.style.transition = 'none';
      ball.style.top = `${finalTop}px`;
      if (this.dockSide === 'right') {
        ball.style.left = 'auto';
        ball.style.right = '0px';
        ball.classList.remove('docked-left');
        ball.classList.add('docked-right');
      } else {
        ball.style.left = '0px';
        ball.style.right = 'auto';
        ball.classList.remove('docked-right');
        ball.classList.add('docked-left');
      }
      this.updateAutoHideState();
      this.updatePillOrientation();
    }
  }

  /**
   * 根据贴边位置同步胶囊弹出方位
   */
  updatePillOrientation() {
    if (!this.pillEl) return;
    if (this.dockSide === 'left') {
      this.pillEl.classList.remove('pill-left');
      this.pillEl.classList.add('pill-right');
    } else {
      this.pillEl.classList.remove('pill-right');
      this.pillEl.classList.add('pill-left');
    }
  }

  /**
   * 刷新悬浮球音乐播放状态 UI
   */
  updateUI() {
    if (!this.ballEl) return;
    const currentSong = state ? state.currentSong : null;
    const isPlaying = state ? !!state.isPlaying : false;

    this.ballEl.classList.toggle('playing', isPlaying);

    if (currentSong) {
      this.ballEl.removeAttribute('title');
      if (this.pillTitleEl) this.pillTitleEl.textContent = currentSong.name || '未知曲目';
      if (this.pillArtistEl) this.pillArtistEl.textContent = currentSong.artist || '未知歌手';

      const cover = currentSong.coverUrl || currentSong.picUrl;
      if (cover) {
        if (this.coverEl) {
          if (this.coverEl.src !== cover) this.coverEl.src = cover;
          this.coverEl.style.display = 'block';
        }
        if (this.centerDotEl) this.centerDotEl.style.display = 'block';
        if (this.waveEl) this.waveEl.style.display = 'none';
        if (this.iconEl) this.iconEl.style.display = 'none';
      } else {
        if (this.coverEl) this.coverEl.style.display = 'none';
        if (this.centerDotEl) this.centerDotEl.style.display = 'none';
        if (isPlaying) {
          if (this.waveEl) this.waveEl.style.display = 'flex';
          if (this.iconEl) this.iconEl.style.display = 'none';
        } else {
          if (this.waveEl) this.waveEl.style.display = 'none';
          if (this.iconEl) this.iconEl.style.display = 'block';
        }
      }
    } else {
      this.ballEl.removeAttribute('title');
      if (this.pillTitleEl) this.pillTitleEl.textContent = 'FIRE 音乐';
      if (this.pillArtistEl) this.pillArtistEl.textContent = '暂无播放曲目';
      if (this.coverEl) this.coverEl.style.display = 'none';
      if (this.centerDotEl) this.centerDotEl.style.display = 'none';
      if (this.waveEl) this.waveEl.style.display = 'none';
      if (this.iconEl) this.iconEl.style.display = 'block';
    }

    if (this.pillToggleEl) {
      this.pillToggleEl.innerHTML = isPlaying
        ? '<i class="fa-solid fa-pause"></i>'
        : '<i class="fa-solid fa-play"></i>';
    }

    this.updatePillOrientation();
  }

  /**
   * 绑定手势拖拽、触屏交互与按钮事件
   */
  bindEvents() {
    const ball = this.ballEl;
    if (!ball || (this.isEventsBound && this.boundBallEl === ball)) return;
    this.isEventsBound = true;
    this.boundBallEl = ball;

    // 桌面端鼠标平滑悬停处理
    let ballHoverTimer = null;
    ball.addEventListener('mouseenter', () => {
      if (ballHoverTimer) {
        clearTimeout(ballHoverTimer);
        ballHoverTimer = null;
      }
      ball.classList.add('is-hovered');
    });

    ball.addEventListener('mouseleave', (e) => {
      if (this.isTracking) return;
      if (e.relatedTarget && ball.contains(e.relatedTarget)) return;
      if (ballHoverTimer) clearTimeout(ballHoverTimer);
      ballHoverTimer = setTimeout(() => {
        ball.classList.remove('is-hovered');
      }, 250);
    });

    // 跨端统一事件捕获 (Mouse & Touch)
    const onStart = (e) => {
      if (e.target.closest('.fire-pill-btn') || e.target.closest('.fire-float-pill-info')) return;
      if (e.type === 'mousedown' && e.button !== 0) return;

      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      this.startX = clientX;
      this.startY = clientY;
      this.startTime = Date.now();
      this.hasDragged = false;
      this.isTracking = true;

      const rect = ball.getBoundingClientRect();
      this.initialLeft = rect.left;
      this.initialTop = rect.top;

      document.addEventListener('mousemove', onMove, { passive: false });
      document.addEventListener('mouseup', onEnd, { capture: true });
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd, { capture: true });
      document.addEventListener('touchcancel', onEnd, { capture: true });
    };

    const onMove = (e) => {
      if (!this.isTracking) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      const deltaX = clientX - this.startX;
      const deltaY = clientY - this.startY;

      // 超过 6 像素阈值确认为拖拽
      if (!this.hasDragged && Math.hypot(deltaX, deltaY) > 6) {
        this.hasDragged = true;
        ball.classList.remove('docked-left', 'docked-right', 'show-pill');
        ball.classList.add('is-dragging');
      }

      if (this.hasDragged) {
        if (e.cancelable) e.preventDefault();

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const bw = ball.offsetWidth || 42;
        const bh = ball.offsetHeight || 42;

        const newLeft = Math.max(0, Math.min(vw - bw, this.initialLeft + deltaX));
        const newTop = Math.max(20, Math.min(vh - bh - 20, this.initialTop + deltaY));

        ball.style.left = `${newLeft}px`;
        ball.style.right = 'auto';
        ball.style.top = `${newTop}px`;
      }
    };

    const onEnd = (e) => {
      if (!this.isTracking) return;
      this.isTracking = false;

      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd, { capture: true });
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd, { capture: true });
      document.removeEventListener('touchcancel', onEnd, { capture: true });

      const duration = Date.now() - this.startTime;
      ball.classList.remove('is-dragging');

      // 毫秒级轻触判定为点击
      if (!this.hasDragged || duration < 220) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        this.handleClick(e);
        return;
      }

      // 拖拽结束：磁吸至最近边缘
      this.snapToEdge(true);
    };

    ball.addEventListener('mousedown', onStart);
    ball.addEventListener('touchstart', onStart, { passive: true });

    // 胶囊播放/暂停控制
    if (this.pillToggleEl) {
      this.pillToggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (controls && typeof controls.togglePlayPause === 'function') {
          controls.togglePlayPause();
        }
      });
    }

    // 胶囊切下一首
    if (this.pillNextEl) {
      this.pillNextEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (controls && typeof controls.playNext === 'function') {
          controls.playNext();
        }
      });
    }

    // 胶囊展开主面板
    if (this.pillExpandEl) {
      this.pillExpandEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.restore();
      });
    }

    // 点击歌曲标题区域恢复展开主面板
    if (this.pillInfoEl) {
      this.pillInfoEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.restore();
      });
    }

    // 窗口尺寸变化保持贴边
    if (!this.isResizeBound) {
      this.isResizeBound = true;
      window.addEventListener('resize', () => {
        if (this.ballEl && this.ballEl.style.display !== 'none' && !this.isTracking) {
          this.snapToEdge(false);
        }
      });
    }
  }

  /**
   * 点击/轻触处理 (手机端首击弹胶囊，二击或桌面端直接恢复展开)
   */
  handleClick(e) {
    if (e && e.target && (e.target.closest('.fire-pill-btn') || e.target.closest('.fire-float-pill-info'))) {
      return;
    }

    const isTouch = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) && (e && e.pointerType !== 'mouse');
    const ball = this.ballEl;

    if (isTouch) {
      // 触屏端：未展示胶囊时首击呼出完整悬浮球与胶囊
      if (!ball.classList.contains('show-pill')) {
        ball.classList.add('show-pill');
        const dismissPill = (ev) => {
          if (!ball.contains(ev.target)) {
            ball.classList.remove('show-pill');
            document.removeEventListener('touchstart', dismissPill);
            document.removeEventListener('click', dismissPill);
          }
        };
        setTimeout(() => {
          document.addEventListener('touchstart', dismissPill, { passive: true });
          document.addEventListener('click', dismissPill);
        }, 100);
        return;
      }
    }

    // 桌面端点击或触屏端再次点击：恢复展开主面板
    this.restore();
  }

  /**
   * 恢复展开主播放器
   */
  restore() {
    if (this.ballEl) {
      this.ballEl.classList.remove('show-pill', 'is-hovered');
    }
    if (controls && typeof controls.minimizePlayer === 'function') {
      controls.minimizePlayer(false);
    }
  }
}

export const FloatingBall = new FloatingBallManager();
