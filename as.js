/**
 * ads.js - 泡泡IM 广告模块（独立文件，index.html 用 <script src="ads.js"></script> 引入）
 * ------------------------------------------------------------
 * 三个广告位，风格和配置结构参考了站内视频播放器那份 as.js（同一套"配置驱动 +
 * 素材类型统一支持 image/video/custom"的思路），但完全是为聊天App重新写的，
 * 不依赖任何播放器：
 *
 *   1. splash —— 开屏广告：登录进入App后，屏幕正中间弹出，带关闭按钮
 *   2. call   —— 通话广告：呼叫中/被呼叫（还没接通）界面上的一块广告位，
 *                呼叫方和被叫方都能看到，尺寸跟着素材（图片/视频）自适应
 *   3. toast  —— 顶部滑入小广告：跟"新消息顶部横幅"同一个视觉效果，从顶部
 *                滑下来，停留3秒自动收起
 *
 * 每个广告位单独可以开关、单独设置出现频率（frequencyHours：0=不限制，每次
 * 满足触发条件都出现；比如 24 就是每天最多出现一次，1 就是每小时最多一次）、
 * 单独设置素材类型（image / video / custom，custom 支持第三方广告JS代码）。
 *
 * ---------------------------------------------------------------
 * 配置结构（这版改过一次，务必按这个层级填，不要拍平）：
 *
 *   pc: {
 *     image: { src, link, maxWidth, maxHeight },   // 或 cover时用 width/height
 *     video: { src, link, maxWidth, maxHeight }
 *   },
 *   mobile: {
 *     image: { src, link, maxWidth, maxHeight },
 *     video: { src, link, maxWidth, maxHeight }
 *   }
 *
 * 图片和视频是两套完全独立的素材+尺寸，不共用任何宽高设置——同一个广告位下，
 * 图片可能是横版banner，视频可能是竖版短片，两者的展示比例、最大宽高天然
 * 就不该是同一组数字，之前把两者的尺寸写在同一层、共用一套maxWidth/maxHeight
 * 是错的，宽视频按竖图的框子裁、竖视频按宽图的框子裁，怎么摆都难看。
 * type字段决定"这个广告位这次用image还是video这条配置"，同一个type下，
 * pc和mobile也是两条完全独立的配置，不会互相影响。
 * ---------------------------------------------------------------
 *
 * 总开关：AdConfig.isVip = true 时，不管下面每个广告位单独的 enabled 是什么，
 * 全部广告一律不展示——这是留给"用户已经是VIP会员"这个判断结果用的开关，
 * 现在先写死在这个文件顶部，以后要接真实的会员状态判断，只需要把这一个值
 * 换成读取账号的VIP标记即可，不用改下面任何渲染逻辑。
 *
 * custom 类型时用 customHtml，支持内联 <script> 和外链 <script src>
 * （第三方广告SDK代码），见 setInnerHTMLWithScripts。
 *
 * ---------------------------------------------------------------
 * 关于"尺寸依赖"这个坑，写在这里备忘（之前吃过一次亏）：
 * 下面所有素材的尺寸样式都用 vh/vw/px 这种绝对单位直接写在图片/视频元素
 * 本身上，绝不用 height:100% / max-height:100% 这种百分比去"指望"父容器
 * 撑出一个高度——父容器如果只设了 max-height 没设 height，百分比高度的子
 * 元素在很多浏览器渲染路径下会直接塌成0高度，广告整个消失不见。千万不要
 * 在这个文件里回退成百分比高度写法。
 *
 * 关于"跨设备切换要自动换素材"：开屏、通话、顶部横幅这三个广告位只要还
 * 显示在屏幕上，就会在 window resize 时检查一遍当前是不是跨过了PC/手机
 * 断点（见 handleResize），跨过了就用正确设备那一套素材（含独立的宽高）
 * 重新渲染一次——包括通话广告：呼叫中/来电这两个状态如果开着开发者工具
 * 切换设备模拟器，广告会跟着切，不需要重新发起一次呼叫才能看到对的素材。
 * ---------------------------------------------------------------
 */
(function (window) {
  'use strict';

  // ============================================================
  // 广告配置中心——以后要改广告内容/开关/频率/尺寸，只改这里，不用碰下面的渲染逻辑
  // ============================================================
  const AdConfig = {
    isVip: false, // 总开关：true = 关闭全部广告（不管下面每个广告位各自的enabled是什么）

    // ---- 广告位1：开屏广告 ----
    splash: {
      enabled: true,
      frequencyHours: 24, // 0=不限制，每次打开App都出现；24=每天最多一次；1=每小时最多一次
      type: 'image', // 'image' | 'video' | 'custom' —— 决定这次用下面哪一条素材
      pc: {
        image: { src: 'images/cc2.png', link: 'https://music.xxooe.com', maxWidth: '640px', maxHeight: '78vh' },
        video: { src: '', link: 'https://movie.xxooe.com', maxWidth: '640px', maxHeight: '78vh' }
      },
      mobile: {
        image: { src: 'images/dd2.png', link: 'https://music.xxooe.com', maxWidth: '86vw', maxHeight: '78vh' },
        video: { src: '', link: 'https://movie.xxooe.com', maxWidth: '86vw', maxHeight: '78vh' }
      },
      customHtml: ''
    },

    // ---- 广告位2：通话广告（呼叫中/被叫来电界面，双方都可见） ----
    call: {
      enabled: true,
      frequencyHours: 0,
      type: 'video', // 'image' | 'video' | 'custom'
      // 电脑端窗口大、留白多，通话广告可以给得更大一些；手机端屏幕小，
      // 广告块不能喧宾夺主，挡住上面的头像和下面的接听/挂断按钮。
      // 图片和视频分开配：图片素材通常是横版banner，视频常见是竖版短片，
      // 两者比例不同，各自的maxWidth/maxHeight互不影响。
      pc: {
        image: { src: 'images/cc2.png', link: 'https://music.xxooe.com', maxWidth: '420px', maxHeight: '34vh' },
        video: { src: 'images/video.mp4', link: 'https://movie.xxooe.com', maxWidth: '360px', maxHeight: '40vh' }
      },
      mobile: {
        image: { src: 'images/dd2.png', link: 'https://movie.xxooe.com', maxWidth: '100%', maxHeight: '' },
        video: { src: 'images/vi.mp4', link: 'https://music.xxooe.com', maxWidth: '100%', maxHeight: '46vh' }
      },
      customHtml: ''
    },

    // ---- 广告位3：顶部滑入小广告（跟新消息横幅同款视觉，3秒自动收起） ----
    toast: {
      enabled: true,
      frequencyHours: 0,
      type: 'image', // 'image' | 'video' | 'custom'
      // toast用的是"铺满裁切"（cover），所以配的是固定width/height而不是
      // maxWidth/maxHeight——图片和视频依然分开配，各自尺寸不共用
      pc: {
        image: { src: 'images/bb2.png', link: 'music.xxooe.com', width: '480px', height: '160px' },
        video: { src: 'ads/toast-pc.mp4', link: 'https://movie.xxooe.com', width: '260px', height: '380px' }
      },
      mobile: {
        image: { src: 'images/cc2.png', link: 'music.xxooe.com', width: 'min(360px, calc(100vw - 24px))', height: '110px' },
        video: { src: 'ads/toast-mobile.mp4', link: 'https://movie.xxooe.com', width: '150px', height: '220px' }
      },
      customHtml: '',
      durationMs: 3000 // 停留多久自动收起——跟新消息横幅保持一致的默认3秒，可以单独调
    }
  };

  // ============================================================
  // 工具函数
  // ============================================================
  // 设备判断：优先复用index.html主应用自己的isMobile()（900px断点），保证
  // 广告这边判断"是不是手机版"跟整个App的布局断点完全一致。如果这个文件
  // 哪天被单独拿到别的项目里用、脱离了index.html的isMobile()，才会走下面
  // 这行内部兜底判断。
  function detectDevice() {
    if (typeof window.isMobile === 'function') {
      return { isMobile: window.isMobile() };
    }
    const ua = navigator.userAgent || navigator.vendor || window.opera || '';
    const isMobileByUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const isMobileByScreen = window.innerWidth <= 900;
    return { isMobile: isMobileByUA || isMobileByScreen };
  }

  // 往一个容器塞HTML，且让里面的<script>标签真正执行——普通的innerHTML赋值
  // 不会执行里面的script（浏览器安全限制），第三方广告SDK代码基本都是靠一段
  // <script src="...">或内联<script>来跑的，必须用这个方法才能生效
  function setInnerHTMLWithScripts(container, html) {
    container.innerHTML = html;
    const scripts = container.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
      const old = scripts[i];
      const fresh = document.createElement('script');
      if (old.src) fresh.src = old.src;
      else fresh.textContent = old.textContent;
      old.parentNode.replaceChild(fresh, old);
    }
  }

  // 频率控制：每个广告位独立用 localStorage 记一个"上次展示时间"，
  // frequencyHours=0 表示不限制（每次满足触发条件就展示）
  function shouldShow(slotName, cfg){
    if (AdConfig.isVip) return false; // 总开关：VIP直接跳过一切判断
    if (!cfg || !cfg.enabled) return false;
    const freqHours = cfg.frequencyHours || 0;
    if (freqHours <= 0) return true;
    const key = 'ad_' + slotName + '_last_shown_at';
    const lastShown = localStorage.getItem(key);
    if (lastShown) {
      const passedHours = (Date.now() - parseInt(lastShown, 10)) / 3600000;
      if (passedHours < freqHours) return false;
    }
    return true;
  }
  function markShown(slotName){
    localStorage.setItem('ad_' + slotName + '_last_shown_at', String(Date.now()));
  }

  // 取"当前设备 + 当前素材类型"对应的那一条独立配置——image/video在pc/mobile
  // 下面各自是完全独立的一份，互不共享尺寸
  function mediaCfgFor(cfg, isMobile){
    if (cfg.type !== 'image' && cfg.type !== 'video') return null; // custom类型没有这个概念
    const device = isMobile ? cfg.mobile : cfg.pc;
    return device ? device[cfg.type] : null;
  }

  // 素材是否真的配置了（避免"开关是true但图片链接是空字符串"的时候硬渲染出
  // 一个空白/破图广告位）
  function creativeReady(cfg, isMobile){
    if (cfg.type === 'custom') return !!cfg.customHtml;
    const m = mediaCfgFor(cfg, isMobile);
    return !!(m && m.src);
  }

  // 统一的素材渲染：image/video/custom 三种类型，塞进传入的容器里。
  //
  // fit='contain'时用素材自己配置里的maxWidth/maxHeight当上限，原始比例不变
  // （开屏、通话广告用这个——"根据素材大小自适应"，图片和视频各自的比例、
  // 各自的最大尺寸完全独立，不互相影响）；
  // fit='cover'时用素材自己配置里的width/height精确铺满裁切（顶部横幅用这个）。
  // 这几个尺寸值全部是vh/vw/px这种绝对单位，不经过任何父容器百分比换算。
  function renderCreative(container, cfg, isMobile, fit){
    container.innerHTML = '';
    if (cfg.type === 'custom') {
      setInnerHTMLWithScripts(container, cfg.customHtml);
      return;
    }
    const m = mediaCfgFor(cfg, isMobile);
    if (!m || !m.src) return;
    const wrap = document.createElement('a');
    wrap.href = m.link || 'javascript:void(0)';
    if (m.link) { wrap.target = '_blank'; wrap.rel = 'noopener noreferrer'; }
    wrap.style.cssText = 'display:block;line-height:0;';
    let media;
    if (cfg.type === 'video') {
      media = document.createElement('video');
      media.src = m.src;
      media.autoplay = true;
      media.muted = true;
      media.loop = true;
      media.playsInline = true;
    } else {
      media = document.createElement('img');
      media.src = m.src;
      media.alt = '广告';
    }
    if (fit === 'cover') {
      media.style.cssText = `display:block;width:${m.width};height:${m.height};object-fit:cover;`;
    } else {
      media.style.cssText = `display:block;max-width:${m.maxWidth};max-height:${m.maxHeight};width:auto;height:auto;object-fit:contain;margin:0 auto;`;
    }
    wrap.appendChild(media);
    container.appendChild(wrap);
  }

  function injectStylesOnce(){
    if (document.getElementById('ad-manager-styles')) return;
    const style = document.createElement('style');
    style.id = 'ad-manager-styles';
    style.textContent = `
      .ad-badge{position:absolute;left:8px;top:8px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;letter-spacing:1px;z-index:2;pointer-events:none;}
      /* ---- 开屏广告：正中间弹窗 ---- */
      .ad-splash-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:30000;opacity:0;transition:opacity .25s ease;}
      .ad-splash-backdrop.show{opacity:1;}
      /* 卡片本身不设overflow:hidden——关闭按钮要露在卡片外面一点点，卡片裁一刀
         会把按钮也切掉。真正需要裁圆角的是里面装图/视频的ad-splash-content，
         裁剪范围只圈住素材，不会波及按钮。 */
      .ad-splash-card{position:relative;display:inline-block;border-radius:14px;background:#121424;box-shadow:0 20px 50px rgba(0,0,0,.7);animation:adSplashIn .25s cubic-bezier(.175,.885,.32,1.275);}
      @keyframes adSplashIn{from{transform:scale(.85);opacity:0;}to{transform:scale(1);opacity:1;}}
      .ad-splash-content{border-radius:14px;overflow:hidden;line-height:0;}
      .ad-splash-close{position:absolute;top:-10px;right:-10px;width:26px;height:26px;border-radius:50%;background:#f5c84c;color:#000;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:18px;line-height:1;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,.5);border:2px solid #fff;z-index:3;}
      /* ---- 通话广告：呼叫界面里的一块区域，实际盒子大小由素材自己的
         maxWidth/maxHeight决定，这里的类只负责外观（圆角/背景/间距） ---- */
      .ad-call-slot{position:relative;display:inline-block;margin:14px auto 0;border-radius:10px;overflow:hidden;background:rgba(255,255,255,.04);line-height:0;}
      /* ---- 顶部滑入小广告：跟新消息横幅同款结构 ---- */
      .ad-toast-banner{position:fixed;left:50%;top:-260px;transform:translateX(-50%);border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden;z-index:10050;cursor:pointer;transition:top .28s ease;line-height:0;background:var(--panel-bg,#1c2230);}
    `;
    document.head.appendChild(style);
  }

  // ============================================================
  // 跨设备自动切换：三个广告位只要还显示在屏幕上，就在resize时检查有没有
  // 跨过PC/手机断点，跨过了就用正确设备的那套素材（图片/视频各自独立的
  // src+尺寸）重新渲染。之前只处理了splash和toast，漏了call——呼叫中/来电
  // 界面开着的时候用开发者工具切设备模拟器，广告不会跟着换，这次一并补上。
  // ============================================================
  let liveInstances = { splash: null, call: null, toast: null };
  let lastIsMobile = null;
  function handleResize(){
    const { isMobile } = detectDevice();
    if (lastIsMobile === null) { lastIsMobile = isMobile; return; }
    if (isMobile === lastIsMobile) return; // 没跨断点，不用做任何事
    lastIsMobile = isMobile;
    if (liveInstances.splash && document.body.contains(liveInstances.splash.contentEl)) {
      const { cfg, contentEl } = liveInstances.splash;
      if (creativeReady(cfg, isMobile)) renderCreative(contentEl, cfg, isMobile, 'contain');
    }
    if (liveInstances.call && document.body.contains(liveInstances.call.container)) {
      renderCallAd(liveInstances.call.container); // 整个重走一遍（含频率判断），保持跟首次展示逻辑一致
    }
    if (liveInstances.toast && document.body.contains(liveInstances.toast.mediaEl)) {
      const { cfg, mediaEl } = liveInstances.toast;
      if (creativeReady(cfg, isMobile)) renderCreative(mediaEl, cfg, isMobile, 'cover');
    }
  }
  window.addEventListener('resize', handleResize);

  // ============================================================
  // 广告位1：开屏广告
  // ============================================================
  function showSplashIfDue(){
    const cfg = AdConfig.splash;
    const { isMobile } = detectDevice();
    if (!shouldShow('splash', cfg) || !creativeReady(cfg, isMobile)) return;
    injectStylesOnce();
    markShown('splash');

    const backdrop = document.createElement('div');
    backdrop.className = 'ad-splash-backdrop';
    const card = document.createElement('div');
    card.className = 'ad-splash-card';
    const content = document.createElement('div');
    content.className = 'ad-splash-content';
    const closeBtn = document.createElement('div');
    closeBtn.className = 'ad-splash-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = '关闭广告';
    closeBtn.onclick = () => {
      liveInstances.splash = null;
      backdrop.classList.remove('show');
      setTimeout(() => backdrop.remove(), 250);
    };
    renderCreative(content, cfg, isMobile, 'contain');
    card.appendChild(content);
    card.appendChild(closeBtn);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('show'));
    liveInstances.splash = { cfg, contentEl: content };
  }

  // ============================================================
  // 广告位2：通话广告——呼叫中('calling')/来电('incoming')界面里挂一块广告区域，
  // 接通('active')之后调用方的模板里压根不含这个广告位div（通话广告只在还
  // 没接通的等待阶段展示，接通后让用户专心通话，不干扰通话本身）
  // ============================================================
  function renderCallAd(container){
    if (!container) return;
    const cfg = AdConfig.call;
    const { isMobile } = detectDevice();
    container.innerHTML = '';
    if (!shouldShow('call', cfg) || !creativeReady(cfg, isMobile)) {
      container.style.display = 'none';
      liveInstances.call = null;
      return;
    }
    injectStylesOnce();
    markShown('call');
    container.style.display = '';
    container.classList.add('ad-call-slot');
    const badge = document.createElement('div');
    badge.className = 'ad-badge';
    badge.textContent = '广告';
    container.appendChild(badge);
    const mediaWrap = document.createElement('div');
    renderCreative(mediaWrap, cfg, isMobile, 'contain');
    container.appendChild(mediaWrap);
    liveInstances.call = { container };
  }
  function clearCallAd(container){
    if (container) { container.innerHTML = ''; container.style.display = 'none'; }
    liveInstances.call = null;
  }

  // ============================================================
  // 广告位3：顶部滑入小广告——跟"新消息横幅"同一个交互：滑下来，停留几秒
  // 自动收起，点击跳转链接。调用方（index.html）决定什么时候检查/触发一次，
  // 这里只负责"如果这次触发满足频率条件，就真的展示出来"这部分。
  // ============================================================
  function showMessageAdIfDue(){
    const cfg = AdConfig.toast;
    const { isMobile } = detectDevice();
    if (!shouldShow('toast', cfg) || !creativeReady(cfg, isMobile)) return;
    injectStylesOnce();
    markShown('toast');

    let el = document.getElementById('ad-toast-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ad-toast-banner';
      el.className = 'ad-toast-banner';
      document.body.appendChild(el);
    }
    const m = mediaCfgFor(cfg, isMobile);
    el.onclick = () => { if (m && m.link) window.open(m.link, '_blank', 'noopener,noreferrer'); };
    el.innerHTML = '';
    const badge = document.createElement('div');
    badge.className = 'ad-badge';
    badge.textContent = '广告';
    const mediaWrap = document.createElement('div');
    renderCreative(mediaWrap, cfg, isMobile, 'cover');
    el.appendChild(badge);
    el.appendChild(mediaWrap);
    liveInstances.toast = { cfg, mediaEl: mediaWrap };

    const startTop = 'calc(-1 * ' + (m.height) + ' - 40px - env(safe-area-inset-top))';
    el.style.top = startTop;
    requestAnimationFrame(() => { el.style.top = 'calc(10px + env(safe-area-inset-top))'; });
    clearTimeout(el.__hideTimer);
    const duration = cfg.durationMs || 3000;
    el.__hideTimer = setTimeout(() => {
      el.style.top = startTop;
      liveInstances.toast = null;
    }, duration);
  }

  window.AdManager = {
    AdConfig,
    showSplashIfDue,
    renderCallAd,
    clearCallAd,
    showMessageAdIfDue
  };
})(window);
