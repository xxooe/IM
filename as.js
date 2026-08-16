/**
 * as.js - 广告管理模块（统一广告中心）
 * ------------------------------------------------------------
 * 功能总览：
 *  1. banner  —— 底部通栏广告（原有功能保留）
 *  2. popup   —— 屏幕居中弹窗广告（原有功能保留，带频控）
 *  3. preroll —— 视频播放前贴片广告（新增）：
 *                首次加载 / 每次切换视频时，在正片播放前插入一段贴片广告
 *  4. pauseAd —— 视频暂停时的角标广告（新增）：
 *                用户暂停播放时，在播放器角落展示小尺寸广告，恢复播放自动隐藏
 *
 * 广告素材形式统一支持三种：
 *   'image'  —— 静态图片 + 跳转链接
 *   'video'  —— 视频广告（mp4/m3u8 等 <video> 支持的格式）
 *   'custom' —— 自定义 HTML / 第三方广告 JS 代码（支持内联 <script> 与 src 外链）
 *
 * 使用方（index.html / 播放器逻辑）只需调用：
 *   AdManager.playPreroll(art, callback)   // 播放贴片广告，播完/跳过后执行 callback
 *   AdManager.attachPauseAd(art)           // 给 ArtPlayer 实例绑定"暂停展示广告"能力（幂等，多次调用只绑定一次）
 * 所有广告内容、形式、时长、跳过规则都只需要改这个文件顶部的 AdConfig，不用碰播放器代码。
 */
(function (window) {
  'use strict';

  // ============================================================
  // 1. 广告配置中心：统一修改广告内容、链接和外接 JS 代码
  // ============================================================
  const AdConfig = {
    // ---- 广告位 1：底部 Banner 广告 (ban-slot) ----
    banner: {
      type: 'image', // 'image' | 'custom'
      pcImage: 'images/bb3.png',
      pcLink: 'https://music.xxooe.com',
      mobileImage: 'images/cc3.png',
      mobileLink: 'https://github.com/jatosi/jatosi.github.io/releases/download/1.10/miaoyin.1.1.0.apk',
      customHtml: '<div id="third-party-banner-ad"></div><script src="https://example.com/ad-sdk.js"></script>'
    },

    // ---- 广告位 2：屏幕正中间弹窗广告 (popup) ----
    popup: {
      enabled: true,
      type: 'image', // 'image' | 'custom'
      frequencyHours: 0,
      pc: { image: 'images/cc2.png', link: 'https://music.xxooe.com' },
      mobile: { image: 'images/dd4.png', link: 'https://github.com/jatosi/jatosi.github.io/releases/download/1.10/miaoyin.1.1.0.apk' },
      customHtml: '<div id="popup-ad-widget"></div>'
    },

    // ---- 广告位 3【新增】：视频播放前贴片广告 (preroll) ----
    preroll: {
      enabled: true,
      type: 'image', // 'image' | 'video' | 'custom'
      everySwitch: true,
      minIntervalSeconds: 0,
      skipAfterSeconds: 3,
      image: 'images/cc4.png',
      imageDuration: 8,
      link: 'https://music.xxooe.com',
      videoUrl: 'images/video.mp4',
      customHtml: '<div id="preroll-ad-widget"></div>'
    },

    // ---- 广告位 4【新增】：视频暂停时的角标广告 (pauseAd) ----
    pauseAd: {
      enabled: true,
      type: 'image', // 'image' | 'video' | 'custom'
      image: 'images/cc3.png',
      link: 'https://music.xxooe.com',
      videoUrl: '',
      customHtml: '<div id="pause-ad-widget"></div>'
    },

    // ---- 播放器顶部跑马灯【新增】：防诈骗提示语，不是广告位，但和"视频里的广告"强相关，
    //      放在一起方便统一管理 ----
    safetyMarquee: {
      enabled: true,
      text: '请勿相信视频中任何广告，以免造成财产损失，谨防诈骗！',
      speedSeconds: 18 // 滚动一整屏所需时间，数值越大滚得越慢
    }
  };

  let currentDeviceType = null;
  let popupClosedByUser = false;
  let prerollLastShownAt = 0;

  function detectDevice() {
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    const isMobileByUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
    const isMobileByScreen = window.innerWidth <= 768;
    const isMobile = isMobileByUA || isMobileByScreen;
    return { isMobile, deviceType: isMobile ? 'mobile' : 'desktop' };
  }

  function setInnerHTMLWithScripts(container, html) {
    container.innerHTML = html;
    const scripts = container.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
      const script = document.createElement('script');
      if (scripts[i].src) {
        script.src = scripts[i].src;
      } else {
        script.textContent = scripts[i].textContent;
      }
      document.head.appendChild(script).parentNode.removeChild(script);
    }
  }

  function injectAdStyles() {
    if (document.getElementById('ad-manager-styles')) return;
    const style = document.createElement('style');
    style.id = 'ad-manager-styles';
    style.textContent = `
      .ban-slot { width: 100%; display: flex; justify-content: center; align-items: center; }
      .ban-slot a { display: block; width: 100%; }
      .ban-slot img { height: 120px; width: 100%; border-radius: 12px; object-fit: cover; cursor: pointer; display: block; }
      @media (max-width: 768px) {
        .ban-slot { height: 90px; border-radius: 12px; margin-bottom: 6px; }
        .ban-slot img { height: 90px; }
      }

      .apop-backdrop {
        position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(5px); display: flex; align-items: center; justify-content: center;
        z-index: 9999; opacity: 0; transition: opacity 0.3s ease;
      }
      .apop-backdrop.show { opacity: 1; }
      .apop-container {
        position: relative; background: #121424; border-radius: 16px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.8), 0 0 20px rgba(245, 200, 76, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.2); display: flex; flex-direction: column;
        align-items: center; padding: 12px; max-width: 90vw; max-height: 85vh; box-sizing: border-box;
        animation: adPopupScale 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      }
      @keyframes adPopupScale { from { transform: scale(0.8); } to { transform: scale(1); } }
      .apop-content {
        width: 100%; overflow: hidden; border-radius: 10px; min-height: 100px;
        display: flex; justify-content: center; align-items: center;
      }
      .apop-content a { display: block; width: 100%; }
      .apop-content img {
        width: 100%; max-width: 100%; height: auto; max-height: 60vh;
        object-fit: contain; display: block; border-radius: 10px; cursor: pointer;
      }
      .apop-close-x {
        position: absolute; top: -7px; right: -7px; width: 20px; height: 20px;
        background: #f5c84c; color: #000; border-radius: 50%; display: flex;
        align-items: center; justify-content: center; font-size: 18px; font-weight: bold;
        cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.5); border: 2px solid #fff;
        z-index: 10; transition: transform 0.2s;
      }
      .apop-close-x:hover { transform: scale(1.15); }

      /* pointer-events: auto 必须保留——这个覆盖层要接住"跳过广告"按钮和广告本身的点击，
         删掉这条会导致贴片广告整个点不动（包括跳过按钮）。JS 里也重复设置了一遍作为双保险。 */
      .mv-ad-overlay {
        position: absolute; inset: 0; z-index: 2147483647; background: #000;
        display: flex; align-items: center; justify-content: center;
        opacity: 1; transition: opacity 0.25s ease; pointer-events: auto;
      }
      .mv-ad-overlay.mv-ad-hide { opacity: 0; }
      .mv-ad-overlay .mv-ad-content { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
      .mv-ad-overlay .mv-ad-content a { display: flex; width: 100%; height: 100%; align-items: center; justify-content: center; }
      .mv-ad-image, .mv-ad-video { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; }
      .mv-ad-badge {
        position: absolute; left: 12px; top: 12px; background: rgba(0,0,0,0.6); color: #fff;
        font-size: 12px; padding: 2px 9px; border-radius: 4px; letter-spacing: 1px; z-index: 2;
      }
      .mv-ad-skip {
        position: absolute; right: 12px; top: 12px; background: rgba(0,0,0,0.7); color: #fff;
        font-size: 12px; padding: 6px 14px; border-radius: 999px; display: flex; align-items: center;
        gap: 4px; user-select: none; z-index: 2; pointer-events: auto; cursor: pointer;
      }
      .mv-ad-skip.mv-ad-skip-ready { cursor: pointer; background: rgba(245,200,76,0.95); color: #1a1400; font-weight: 600; }
      .mv-ad-skip.mv-ad-skip-ready:hover { background: #fff; }
      .mv-ad-loading-tip {
        position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%);
        display: none; align-items: center; gap: 10px; background: rgba(0,0,0,0.7); color: #fff;
        font-size: 16px; font-weight: 600; padding: 10px 22px; border-radius: 999px; z-index: 3;
        white-space: nowrap; pointer-events: none;
      }
      .mv-ad-loading-tip::before {
        content: ''; width: 16px; height: 16px; border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.35); border-top-color: #f5c84c;
        animation: mvAdSpin 0.8s linear infinite; flex-shrink: 0;
      }
      @keyframes mvAdSpin { to { transform: rotate(360deg); } }
      @media (max-width: 768px) {
        .mv-ad-loading-tip { font-size: 14px; padding: 8px 16px; bottom: 14px; }
      }

      /* 同上：pointer-events: auto 必须保留，否则暂停广告的关闭按钮点不动 */
      .mv-ad-pause {
        // position: absolute;top: 50%;left: 50%;transform: translate(-50%, -50%);max-width: 42%;
        position: absolute;top: 50%;left: 50%;transform: translate(-50%, -50%); width: 50%; min-width: 40%; max-width: 60%;

        z-index: 2147483647; background: rgba(10,12,26,0.88); border: 1px solid rgba(255,255,255,0.18);
        border-radius: 10px; padding: 6px; box-shadow: 0 10px 26px rgba(0,0,0,0.6);
        animation: mvPauseAdIn 0.25s ease; pointer-events: auto;
      }
      @keyframes mvPauseAdIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      .mv-ad-pause .mv-ad-content { width: 100%; height: 100%; }
      .mv-ad-pause-close {
        position: absolute; top: -8px; right: -8px; width: 20px; height: 20px; border-radius: 50%;
        background: #f5c84c; color: #000; display: flex; align-items: center; justify-content: center;
        font-weight: bold; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.5); border: 2px solid #fff;
        z-index: 3; pointer-events: auto;
      }
      @media (max-width: 768px) {
        .mv-ad-pause { max-width: 60%; }
      }

      /* ---------- 播放器顶部：防诈骗跑马灯 ---------- */
      .mv-safety-marquee {
        position: absolute; left: 0; right: 0; top: 0; height: 28px; overflow: hidden;
        background: linear-gradient(180deg, rgba(0,0,0,0.6), rgba(0,0,0,0));
        z-index: 30; pointer-events: none; display: flex; align-items: center;
      }
      .mv-safety-marquee-track {
        display: inline-block; white-space: nowrap; font-size: 13px; color: #fff;
        font-weight: 600; padding-left: 100%;
        animation-name: mvMarqueeScroll; animation-timing-function: linear; animation-iteration-count: infinite;
        text-shadow: 0 1px 2px rgba(0,0,0,0.6);
      }
      @keyframes mvMarqueeScroll {
        from { transform: translateX(0); }
        to { transform: translateX(-100%); }
      }
      @media (max-width: 768px) {
        .mv-safety-marquee { height: 22px; }
        .mv-safety-marquee-track { font-size: 11px; }
      }
    `;
    document.head.appendChild(style);
  }

  function renderAdCreative(container, cfg, opts) {
    opts = opts || {};
    container.innerHTML = '';
    container.style.pointerEvents = 'auto';

    if (cfg.type === 'custom' && cfg.customHtml) {
      setInnerHTMLWithScripts(container, cfg.customHtml);
      return null;
    }

    if (cfg.type === 'video' && cfg.videoUrl) {
      const video = document.createElement('video');
      video.src = cfg.videoUrl;
      video.autoplay = true;
      video.playsInline = true;
      video.className = 'mv-ad-video';
      video.muted = !!opts.muted;
      video.loop = !!opts.loop;
      video.style.pointerEvents = 'auto';
      if (cfg.link) {
        video.style.cursor = 'pointer';
        video.addEventListener('click', () => window.open(cfg.link, '_blank', 'noopener,noreferrer'));
      }
      container.appendChild(video);
      return video;
    }

    const a = document.createElement('a');
    a.href = cfg.link || 'javascript:void(0)';
    if (cfg.link) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.style.pointerEvents = 'auto';
    const img = document.createElement('img');
    img.src = cfg.image;
    img.alt = 'Advertisement';
    img.className = 'mv-ad-image';
    a.appendChild(img);
    container.appendChild(a);
    return img;
  }

  function renderBannerSlot() {
    const slot = document.getElementById('ban-slot');
    if (!slot) return;
    const cfg = AdConfig.banner;
    const { isMobile } = detectDevice();
    slot.innerHTML = '';

    if (cfg.type === 'custom') {
      setInnerHTMLWithScripts(slot, cfg.customHtml);
      return;
    }
    const imgSrc = isMobile ? cfg.mobileImage : cfg.pcImage;
    const targetLink = isMobile ? cfg.mobileLink : cfg.pcLink;
    const a = document.createElement('a');
    a.href = targetLink || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const img = document.createElement('img');
    img.src = imgSrc;
    img.alt = 'Advertisement';
    a.appendChild(img);
    slot.appendChild(a);
  }

  function shouldShowPopup() {
    const cfg = AdConfig.popup;
    if (!cfg.enabled) return false;
    if (popupClosedByUser) return false;

    const freqHours = cfg.frequencyHours || 0;
    if (freqHours < 0) return false;
    if (freqHours == 0) return true;

    const lastShown = localStorage.getItem('ad_popup_last_shown_time');
    if (lastShown) {
      const passHours = (Date.now() - parseInt(lastShown, 10)) / (1000 * 60 * 60);
      if (passHours < freqHours) return false;
    }
    return true;
  }

  function renderPopupAd() {
    let backdrop = document.getElementById('apop-backdrop');

    if (!shouldShowPopup()) {
      if (backdrop) backdrop.remove();
      return;
    }

    const cfg = AdConfig.popup;
    const { isMobile } = detectDevice();

    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'apop-backdrop';
      backdrop.className = 'apop-backdrop';

      const container = document.createElement('div');
      container.id = 'apop-container';
      container.className = 'apop-container ' + (isMobile ? 'mobile-view' : 'pc-view');

      const closeX = document.createElement('div');
      closeX.className = 'apop-close-x';
      closeX.innerHTML = '&times;';
      closeX.title = '关闭广告';

      const content = document.createElement('div');
      content.id = 'apop-content';
      content.className = 'apop-content';

      const closeAd = () => {
        popupClosedByUser = true;
        backdrop.classList.remove('show');
        setTimeout(() => backdrop.remove(), 300);
      };
      closeX.addEventListener('click', closeAd);

      container.appendChild(closeX);
      container.appendChild(content);
      backdrop.appendChild(container);
      document.body.appendChild(backdrop);

      localStorage.setItem('ad_popup_last_shown_time', Date.now().toString());
      requestAnimationFrame(() => backdrop.classList.add('show'));
    } else {
      const container = document.getElementById('apop-container');
      if (container) container.className = 'apop-container ' + (isMobile ? 'mobile-view' : 'pc-view');
    }

    const content = document.getElementById('apop-content');
    if (content) {
      if (cfg.type === 'custom') {
        setInnerHTMLWithScripts(content, cfg.customHtml);
      } else {
        const popData = isMobile ? cfg.mobile : cfg.pc;
        renderAdCreative(content, { type: 'image', image: popData.image, link: popData.link });
      }
    }
  }

  // 旧的兜底方式：直接猜测 ArtPlayer 内部 DOM 结构来挂载覆盖层。
  // 问题就出在这里——播放器进入"窗口全屏"或"网页全屏"时，只有 ArtPlayer 自己管理的模板节点
  // （包括下面用 art.layers 创建的节点）才会保证还在可见的那棵 DOM 树里；我们自己猜测挂载的节点
  // 很容易被晾在全屏视图之外，导致贴片广告、暂停广告、跑马灯这些全部"消失"。
  // 现在只在 art.layers 这个原生 API 不可用时才会退回到这个兜底方案。
  function getAdHostContainer(art) {
    try {
      if (art && art.template && art.template.$container) return art.template.$container;
    } catch (e) { /* ignore */ }
    return document.querySelector('.video-stage') || document.body;
  }

  // 用 ArtPlayer 原生的 layers（图层）系统创建/复用一个持久化的挂载节点。
  // layers 是 ArtPlayer 自己模板树里的正式成员，所以不管播放器切到窗口全屏、网页全屏、
  // 迷你窗口还是画中画，这个节点始终跟着播放器一起可见。
  // 每个 name 只会真正创建一次（幂等），之后重复调用会拿到同一个节点，方便反复显示/隐藏内容。
  //
  // interactive=true 时会强制内联设置 pointer-events:auto 和一个足够高的 z-index——
  // 这是让"跳过广告"这类按钮能被点到的关键：ArtPlayer 对没有配置 click 回调的 layer，
  // 内部可能默认不接收点击（或者被它自己处理播放/暂停的点击层挡在上面）；不管具体是哪种机制，
  // 用内联样式强制覆盖都能保证生效，因为内联样式的优先级高于任何样式表规则。
  // 顶部跑马灯这类不需要点击、且不应该挡住底下视频点击的层，保持 interactive=false 即可。
  function ensureLayer(art, name, className, interactive) {
    try {
      if (art && art.layers) {
        if (!art.layers[name]) {
          art.layers.add({ name: name, html: '', style: {} });
        }
        const el = art.layers[name];
        if (el) {
          if (className && el.className !== className) el.className = className;
          if (interactive) {
            el.style.pointerEvents = 'auto';
            el.style.zIndex = '2147483647'; // 浏览器允许的最大 z-index，确保不会被播放器自己的任何内部图层压住
          }
          return el;
        }
      }
    } catch (e) { /* 走下面的 return null，调用方会自行兜底 */ }
    return null;
  }

  function shouldPlayPreroll() {
    const cfg = AdConfig.preroll;
    if (!cfg || !cfg.enabled) return false;
    if (cfg.everySwitch) return true;
    const interval = cfg.minIntervalSeconds || 0;
    if (interval <= 0) return true;
    if (!prerollLastShownAt) return true;
    return (Date.now() - prerollLastShownAt) / 1000 >= interval;
  }

  /**
   * 播放贴片广告。播放器每次切换视频（含首次加载）前调用一次。
   * @param {Object} art ArtPlayer 实例（用于挂载覆盖层、暂停/恢复状态标记）
   * @param {Function} callback 广告结束（播完/被跳过/加载失败自动跳过）后的回调，用于继续播放正片
   * @param {Object} [opts]
   * @param {Promise} [opts.waitFor] 正片资源加载的 Promise（例如 art.switchUrl(...) 返回值）。
   *        贴片广告应当从"用户点击/切换视频的那一刻"就立刻出现，和正片加载并行进行；
   *        如果广告已经放完但正片还没加载好，就先在广告层里显示一个简短的"加载中"提示继续占位，
   *        等正片真正 ready 了再一起消失去播放——这样用户永远看到的是广告，而不是播放器自己的转圈。
   */
  // 贴片广告被关闭 / 未满足展示条件时的兜底：不放广告，但正片加载期间该有的
  // "视频加载中"提示不能跟着消失——不管有没有广告，切视频时都应该看到这个提示。
  function showLoadingOnlyOverlay(art, waitFor, done) {
    if (!art) { waitFor.then(done); return; }

    // 和播放贴片广告一样，切视频这一刻要先关掉可能还挂着的暂停角标广告
    if (typeof art._hidePauseAd === 'function') art._hidePauseAd();

    injectAdStyles();
    let overlay = ensureLayer(art, 'mvAdPrerollLayer', 'mv-ad-overlay', true);
    let usingFallback = false;
    if (!overlay) {
      usingFallback = true;
      const host = getAdHostContainer(art);
      if (!host) { waitFor.then(done); return; }
      overlay = document.createElement('div');
      overlay.className = 'mv-ad-overlay';
      host.appendChild(overlay);
    }

    overlay.innerHTML = '';
    overlay.classList.remove('mv-ad-hide');
    overlay.style.display = '';

    const loadingTip = document.createElement('div');
    loadingTip.className = 'mv-ad-loading-tip';
    loadingTip.textContent = '视频加载中…';
    loadingTip.style.display = 'flex';
    overlay.appendChild(loadingTip);

    waitFor.then(() => {
      overlay.classList.add('mv-ad-hide');
      setTimeout(() => {
        if (usingFallback) {
          overlay.remove();
        } else {
          overlay.style.display = 'none';
          overlay.innerHTML = '';
          overlay.classList.remove('mv-ad-hide');
        }
        done();
      }, 250);
    });
  }

  function playPreroll(art, callback, opts) {
    opts = opts || {};
    const done = typeof callback === 'function' ? callback : function () {};
    const waitFor = (opts.waitFor && typeof opts.waitFor.then === 'function')
      ? opts.waitFor.catch(function () {})
      : Promise.resolve();

    if (!art || !shouldPlayPreroll()) {
      // 不满足贴片广告展示条件（比如 preroll.enabled = false）：不放广告，
      // 但仍然要走"加载中"占位逻辑，等正片加载完成再回调，保持行为一致。
      showLoadingOnlyOverlay(art, waitFor, done);
      return;
    }

    const cfg = AdConfig.preroll;
    injectAdStyles();

    // 优先用 art.layers 挂载（全屏安全）；万一这个 ArtPlayer 版本没有 layers，退回旧的手动挂载方式
    let overlay = ensureLayer(art, 'mvAdPrerollLayer', 'mv-ad-overlay', true);
    let usingFallback = false;
    if (!overlay) {
      usingFallback = true;
      const host = getAdHostContainer(art);
      if (!host) { waitFor.then(done); return; }
      overlay = document.createElement('div');
      overlay.className = 'mv-ad-overlay';
      host.appendChild(overlay);
    }

    // 贴片广告即将展示：先关掉可能还挂着的暂停角标广告（用户暂停后没恢复播放就
    // 直接切了下一个视频的场景），避免两个广告同时出现在画面上。
    if (typeof art._hidePauseAd === 'function') art._hidePauseAd();

    art._prerollActive = true;
    prerollLastShownAt = Date.now();

    overlay.innerHTML = '';
    overlay.classList.remove('mv-ad-hide');
    overlay.style.display = ''; // 清掉可能残留的 display:none（沿用 CSS 类自带的 flex 布局）

    const badge = document.createElement('div');
    badge.className = 'mv-ad-badge';
    badge.textContent = '广告';

    const skipBtn = document.createElement('div');
    skipBtn.className = 'mv-ad-skip';
    skipBtn.style.display = 'none';
    skipBtn.style.pointerEvents = 'auto';

    const content = document.createElement('div');
    content.className = 'mv-ad-content';

    const loadingTip = document.createElement('div');
    loadingTip.className = 'mv-ad-loading-tip';
    loadingTip.textContent = '视频加载中…';

    overlay.appendChild(content);
    overlay.appendChild(badge);
    overlay.appendChild(skipBtn);
    overlay.appendChild(loadingTip);

    let finished = false;
    let durationTimer = null;
    let videoLoaded = false;
    let adVideoEl = null;

    // 从广告一开始展示，就同时显示"视频加载中"提示——让用户从点击的那一刻起就知道
    // 正片正在后台加载，而不是等广告放完了才突然冒出来这句提示。
    loadingTip.style.display = 'flex';
    waitFor.then(() => {
      videoLoaded = true;
      // 正片一旦加载完成就隐藏提示：不管广告是不是还在播，都不需要再提示"加载中"了
      loadingTip.style.display = 'none';
    });

    function reallyClose() {
      art._prerollActive = false;
      overlay.classList.add('mv-ad-hide');
      setTimeout(() => {
        if (usingFallback) {
          overlay.remove();
        } else {
          overlay.style.display = 'none';
          overlay.innerHTML = '';
          overlay.classList.remove('mv-ad-hide');
        }
      }, 250);
      done();
    }

    // 广告本身播完/被跳过时调用。若正片这时候还没加载好，就先不关闭覆盖层，
    // 让"视频加载中"提示继续占位，等正片真正 ready 了再一起淡出。
    function finish() {
      if (finished) return;
      finished = true;
      if (durationTimer) clearTimeout(durationTimer);
      skipBtn.style.display = 'none';

      if (videoLoaded) {
        reallyClose();
        return;
      }

      // 正片还没加载好：广告本身（视频/图片）必须立刻停下并清空，只保留"视频加载中"
      // 提示继续占位——否则用户点了"跳过广告"，画面上广告却还在照常播放，
      // 会让人以为跳过没生效。
      if (adVideoEl) {
        adVideoEl.pause();
      }
      content.innerHTML = '';
      waitFor.then(reallyClose);
    }



    function setupSkipButton(skipAfter) {
      if (skipAfter < 0) { skipBtn.style.display = 'none'; return; }
      skipBtn.style.display = 'flex';

      function markReady() {
        skipBtn.textContent = '跳过广告 >';
        skipBtn.classList.add('mv-ad-skip-ready');
        skipBtn.onclick = finish;
      }

      if (skipAfter === 0) { markReady(); return; }

      let remaining = skipAfter;
      skipBtn.textContent = remaining + ' 秒后可跳过';
      const timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) { clearInterval(timer); markReady(); }
        else { skipBtn.textContent = remaining + ' 秒后可跳过'; }
      }, 1000);
    }

    if (cfg.type === 'video' && cfg.videoUrl) {
      const video = renderAdCreative(content, cfg, { muted: false, loop: false });
      if (video) {
        adVideoEl = video;
        video.addEventListener('ended', finish);
        video.addEventListener('error', finish);
        video.play().catch(finish);
      } else {
        finish();
      }
      setupSkipButton(cfg.skipAfterSeconds);
    } else {
      const mediaEl = renderAdCreative(content, cfg);
      if (mediaEl && mediaEl.tagName === 'IMG') mediaEl.onerror = finish;
      setupSkipButton(cfg.skipAfterSeconds);
      const dur = cfg.imageDuration > 0 ? cfg.imageDuration : 5;
      durationTimer = setTimeout(finish, dur * 1000);
    }
  }

  function attachPauseAd(art) {
    if (!art || art._pauseAdBound) return;
    art._pauseAdBound = true;

    let overlay = null;
    let usingFallback = false;

    function ensureOverlay() {
      if (overlay) return overlay;
      overlay = ensureLayer(art, 'mvAdPauseLayer', 'mv-ad-pause', true);
      if (!overlay) {
        usingFallback = true;
        const host = getAdHostContainer(art);
        if (!host) return null;
        overlay = document.createElement('div');
        overlay.className = 'mv-ad-pause';
        host.appendChild(overlay);
      }
      overlay.style.display = 'none';
      return overlay;
    }

    let isShowing = false;

    function showPauseAd() {
      const cfg = AdConfig.pauseAd;
      if (!cfg || !cfg.enabled) return;
      if (art._prerollActive) return;   // 贴片广告播放期间（本身就处于暂停态）不重复展示
      if (art._switchingVideo) return;  // 正在切换视频源（准备插播贴片广告）的短暂暂停，不展示角标广告
      if (isShowing) return;

      injectAdStyles();
      const el = ensureOverlay();
      if (!el) return;

      el.innerHTML = '';

      const badge = document.createElement('div');
      badge.className = 'mv-ad-badge';
      badge.textContent = '广告';

      const closeBtn = document.createElement('div');
      closeBtn.className = 'mv-ad-pause-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.title = '关闭广告';
      closeBtn.style.pointerEvents = 'auto';
      closeBtn.onclick = hidePauseAd;

      const content = document.createElement('div');
      content.className = 'mv-ad-content';
      renderAdCreative(content, cfg, { muted: true, loop: true });

      el.appendChild(content);
      el.appendChild(badge);
      el.appendChild(closeBtn);
      el.style.display = 'block';
      isShowing = true;
    }

    function hidePauseAd() {
      if (!isShowing) return;
      isShowing = false;
      if (!overlay) return;
      if (usingFallback) {
        overlay.remove();
        overlay = null;
      } else {
        overlay.style.display = 'none';
        overlay.innerHTML = '';
      }
    }

    art.on('pause', showPauseAd);
    art.on('play', hidePauseAd);
    art.on('video:ended', hidePauseAd);
    art.on('destroy', hidePauseAd);

    // 暴露给 playPreroll：切换视频、准备展示贴片广告（或"加载中"占位）时，
    // 需要能主动关掉可能还挂在屏幕上的暂停角标广告——否则"暂停后直接切下一个视频"
    // 这种情况下，贴片广告和暂停广告会同时出现在画面上。
    art._hidePauseAd = hidePauseAd;
  }

  // ============================================================
  // 7. 播放器顶部【新增】：防诈骗跑马灯
  // ============================================================

  /**
   * 给 ArtPlayer 实例挂载一条常驻的顶部跑马灯提示（防诈骗提醒），幂等——多次调用只挂载一次。
   * 文案 / 是否启用 / 滚动速度都在 AdConfig.safetyMarquee 里配置。
   */
  function attachSafetyMarquee(art) {
    if (!art || art._marqueeBound) return;
    art._marqueeBound = true;

    const cfg = AdConfig.safetyMarquee;
    if (!cfg || !cfg.enabled || !cfg.text) return;

    injectAdStyles();

    let bar = ensureLayer(art, 'mvSafetyMarqueeLayer', 'mv-safety-marquee');
    if (!bar) {
      const host = getAdHostContainer(art);
      if (!host) return;
      bar = document.createElement('div');
      bar.className = 'mv-safety-marquee';
      host.appendChild(bar);
    }

    bar.innerHTML = '';
    const track = document.createElement('div');
    track.className = 'mv-safety-marquee-track';
    track.textContent = cfg.text;
    track.style.animationDuration = (cfg.speedSeconds || 14) + 's';
    bar.appendChild(track);
  }

  function renderAllAds() {
    injectAdStyles();
    renderBannerSlot();
    renderPopupAd();
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const { deviceType } = detectDevice();
      renderAllAds();
      currentDeviceType = deviceType;
    }, 200);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAllAds);
  } else {
    renderAllAds();
  }

  window.AdManager = {
    config: AdConfig,
    reload: renderAllAds,
    playPreroll: playPreroll,
    attachPauseAd: attachPauseAd,
    attachSafetyMarquee: attachSafetyMarquee,
    resetPopupTimer: () => localStorage.removeItem('ad_popup_last_shown_time'),
    resetPrerollTimer: () => { prerollLastShownAt = 0; }
  };

})(window);