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
 * 单独设置素材类型（image / video / custom，custom 支持第三方广告JS代码），
 * 并且电脑端/手机端各自一套独立的素材 + 独立的展示尺寸（不是同一个盒子里
 * 换一张图，是两套真正不同大小的盒子）。
 *
 * 总开关：AdConfig.isVip = true 时，不管下面每个广告位单独的 enabled 是什么，
 * 全部广告一律不展示——这是留给"用户已经是VIP会员"这个判断结果用的开关，
 * 现在先写死在这个文件顶部，以后要接真实的会员状态判断，只需要把这一个值
 * 换成读取账号的VIP标记即可，不用改下面任何渲染逻辑。
 *
 * 素材怎么配：每个广告位下面的 pc / mobile 分别是电脑端/手机端展示的素材——
 * 同一个广告位在两种设备上可以放完全不同的图/视频/链接（比如PC放一张横版
 * 长图、手机放一张竖版长图）。custom 类型时用 customHtml，支持内联 <script>
 * 和外链 <script src>（第三方广告SDK代码），见 setInnerHTMLWithScripts。
 *
 * ---------------------------------------------------------------
 * 关于"尺寸依赖"这个坑，写在这里备忘（之前吃过一次亏）：
 * 下面所有素材的尺寸样式都用 vh/vw/px 这种绝对单位直接写在图片/视频元素
 * 本身上，绝不用 height:100% / max-height:100% 这种百分比去"指望"父容器
 * 撑出一个高度——父容器如果只设了 max-height 没设 height，百分比高度的子
 * 元素在很多浏览器渲染路径下会直接塌成0高度，广告整个消失不见（这正是
 * 之前"通话广告怎么都不显示"的根因，不是被别的图层挡住，是自己塌没了）。
 * 千万不要在这个文件里回退成百分比高度写法。
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
      frequencyHours: 0, // 0=不限制，每次打开App都出现；24=每天最多一次；1=每小时最多一次
      type: 'image', // 'image' | 'video' | 'custom'
      pc: { image: 'images/cc2.png', video: '', link: 'https://example.com', maxWidth: '640px', maxHeight: '78vh' },
      mobile: { image: 'images/dd2.png', video: '', link: 'https://example.com', maxWidth: '86vw', maxHeight: '78vh' },
      customHtml: ''
    },

    // ---- 广告位2：通话广告（呼叫中/被叫来电界面，双方都可见） ----
    call: {
      enabled: true,
      frequencyHours: 0,
      type: 'video', // 'image' | 'video' | 'custom'
      // 电脑端窗口大、留白多，通话广告可以给得更大一些；手机端屏幕小，
      // 广告块不能喧宾夺主，挡住上面的头像和下面的接听/挂断按钮
      pc: { image: 'images/cc2.png', video: 'images/video.mp4', link: 'https://example.com', maxWidth: '420px', maxHeight: '34vh' },
      mobile: { image: 'images/poster.png', video: 'images/vi.mp4', link: 'https://example.com', maxWidth: '100%', maxHeight: '78vh' },
      customHtml: ''
    },

    // ---- 广告位3：顶部滑入小广告（跟新消息横幅同款视觉，3秒自动收起） ----
    toast: {
      enabled: true,
      frequencyHours: 0,
      type: 'image', // 'image' | 'video' | 'custom'
      // 电脑端聊天窗口宽，横幅可以做得又宽又高一些；手机端窄屏，横幅保持
      // 紧凑，不要占掉太多聊天记录的可视区域
      pc: { image: 'images/bb2.png', video: '', link: 'https://example.com', width: '480px', height: '160px' },
      mobile: { image: 'images/cc2.png', video: '', link: 'https://example.com', width: 'min(360px, calc(100vw - 24px))', height: '110px' },
      customHtml: '',
      durationMs: 3000 // 停留多久自动收起——跟新消息横幅保持一致的默认3秒，可以单独调
    }
  };

  // ============================================================
  // 工具函数
  // ============================================================
  // 设备判断：优先复用index.html主应用自己的isMobile()（900px断点），保证
  // 广告这边判断"是不是手机版"跟整个App的布局断点完全一致，不会出现
  // "App已经切到单栏手机布局了，广告这边却还以为是桌面端"这种断点不一致
  // 的情况（之前就是这么一个bug：这里原来单独写了个768px，跟App实际用的
  // 900px对不上）。如果这个文件哪天被单独拿到别的项目里用、脱离了index.html
  // 的isMobile()，才会用下面这行内部兜底判断。
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

  // 素材是否真的配置了（避免"开关是true但图片链接是空字符串"的时候硬渲染出
  // 一个空白/破图广告位）
  function creativeReady(cfg, isMobile){
    if (cfg.type === 'custom') return !!cfg.customHtml;
    const c = isMobile ? cfg.mobile : cfg.pc;
    if (!c) return false;
    return cfg.type === 'video' ? !!c.video : !!c.image;
  }

  // 统一的素材渲染：image/video/custom 三种类型，塞进传入的容器里。
  //
  // sizing 参数决定这块素材的盒子多大——直接把电脑端/手机端各自配置里的
  // 宽高值（vh/vw/px这种绝对单位，见AdConfig顶部注释里"关于尺寸依赖"那段）
  // 写死在图片/视频元素自己身上，不经过任何百分比换算，也不依赖父容器有没
  // 有设置height。fit='cover'时长宽都精确等于sizing给的值（裁切铺满，横幅
  // 类广告用这个）；fit='contain'时用sizing的值当上限，素材原始比例不变
  // （通话/开屏广告用这个，"根据素材大小自适应"）。
  function renderCreative(container, cfg, isMobile, fit, sizing){
    container.innerHTML = '';
    if (cfg.type === 'custom') {
      setInnerHTMLWithScripts(container, cfg.customHtml);
      return;
    }
    const c = isMobile ? cfg.mobile : cfg.pc;
    const wrap = document.createElement('a');
    wrap.href = c.link || 'javascript:void(0)';
    if (c.link) { wrap.target = '_blank'; wrap.rel = 'noopener noreferrer'; }
    wrap.style.cssText = 'display:block;line-height:0;';
    let media;
    if (cfg.type === 'video' && c.video) {
      media = document.createElement('video');
      media.src = c.video;
      media.autoplay = true;
      media.muted = true;
      media.loop = true;
      media.playsInline = true;
    } else {
      media = document.createElement('img');
      media.src = c.image;
      media.alt = '广告';
    }
    if (fit === 'cover') {
      media.style.cssText = `display:block;width:${sizing.width};height:${sizing.height};object-fit:cover;`;
    } else {
      media.style.cssText = `display:block;max-width:${sizing.maxWidth};max-height:${sizing.maxHeight};width:auto;height:auto;object-fit:contain;margin:0 auto;`;
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
         会把按钮也切掉（之前的bug）。真正需要裁圆角的是里面装图/视频的
         ad-splash-content，裁剪范围只圈住素材，不会波及按钮。 */
      .ad-splash-card{position:relative;display:inline-block;border-radius:14px;background:#121424;box-shadow:0 20px 50px rgba(0,0,0,.7);animation:adSplashIn .25s cubic-bezier(.175,.885,.32,1.275);}
      @keyframes adSplashIn{from{transform:scale(.85);opacity:0;}to{transform:scale(1);opacity:1;}}
      .ad-splash-content{border-radius:14px;overflow:hidden;line-height:0;}
      .ad-splash-close{position:absolute;top:-8px;right:-8px;width:26px;height:26px;border-radius:50%;background:#f5c84c;color:#000;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:12px;line-height:1;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,.5);border:2px solid #fff;z-index:3;}
      /* ---- 通话广告：呼叫界面里的一块区域，盒子大小由JS按PC/手机分别写死尺寸，
         这里的类只负责外观（圆角/背景/间距），不参与定高，避免踩百分比高度的坑 ---- */
      /* .ad-call-slot{position:relative;display:inline-block;margin:14px auto 0;border-radius:10px;overflow:hidden;background:rgba(255,255,255,.04);line-height:0;} */
      .ad-call-slot{position:relative;display:inline-block;margin:14px auto 0;border-radius:10px;overflow:hidden;background:rgba(255,255,255,.04);line-height:0;}
      
      /* ---- 顶部滑入小广告：跟新消息横幅同款结构，同样不用百分比定高 ---- */
      .ad-toast-banner{position:fixed;left:50%;top:-260px;transform:translateX(-50%);border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden;z-index:10050;cursor:pointer;transition:top .28s ease;line-height:0;background:var(--panel-bg,#1c2230);}
    `;
    document.head.appendChild(style);
  }

  // 当前正显示着的开屏/顶部横幅广告，用于窗口尺寸跨越PC/手机断点时重新按
  // 正确的一套素材+尺寸重渲染（比如开着开发者工具的设备模拟器，中途切换
  // 设备预设或者拖拽调整视口宽度，不希望广告还留着切换前那套不匹配的素材）。
  // 通话广告不在这里处理——通话广告每次呼叫状态变化时（发起/来电/接通/挂断）
  // 都会重新走一遍 renderCallOverlay 的完整渲染，天然就是新鲜的。
  let liveInstances = { splash: null, toast: null };
  let lastIsMobile = null;
  function handleResize(){
    const { isMobile } = detectDevice();
    if (lastIsMobile === null) { lastIsMobile = isMobile; return; }
    if (isMobile === lastIsMobile) return; // 没跨断点，不用做任何事
    lastIsMobile = isMobile;
    if (liveInstances.splash) {
      const { cfg, contentEl } = liveInstances.splash;
      if (creativeReady(cfg, isMobile)) renderCreative(contentEl, cfg, isMobile, 'contain', sizingFor(cfg, isMobile));
    }
    if (liveInstances.toast) {
      const { cfg, mediaEl } = liveInstances.toast;
      if (creativeReady(cfg, isMobile)) renderCreative(mediaEl, cfg, isMobile, 'cover', sizingFor(cfg, isMobile));
    }
  }
  window.addEventListener('resize', handleResize);

  function sizingFor(cfg, isMobile){
    const c = isMobile ? cfg.mobile : cfg.pc;
    return {
      maxWidth: c.maxWidth || (isMobile ? '86vw' : '480px'),
      maxHeight: c.maxHeight || '70vh',
      width: c.width || (isMobile ? '100%' : '480px'),
      height: c.height || (isMobile ? '110px' : '160px')
    };
  }

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
    // closeBtn.innerHTML = '&times;';
    closeBtn.innerHTML = '❌';
    closeBtn.title = '关闭广告';
    closeBtn.onclick = () => {
      liveInstances.splash = null;
      backdrop.classList.remove('show');
      setTimeout(() => backdrop.remove(), 250);
    };
    renderCreative(content, cfg, isMobile, 'contain', sizingFor(cfg, isMobile));
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
    if (!shouldShow('call', cfg) || !creativeReady(cfg, isMobile)) { container.style.display = 'none'; return; }
    injectStylesOnce();
    markShown('call');
    container.style.display = '';
    container.classList.add('ad-call-slot');
    const badge = document.createElement('div');
    badge.className = 'ad-badge';
    badge.textContent = '广告';
    container.appendChild(badge);
    const mediaWrap = document.createElement('div');
    renderCreative(mediaWrap, cfg, isMobile, 'contain', sizingFor(cfg, isMobile));
    container.appendChild(mediaWrap);
  }
  function clearCallAd(container){
    if (container) { container.innerHTML = ''; container.style.display = 'none'; }
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
    const c = isMobile ? cfg.mobile : cfg.pc;
    el.onclick = () => { if (c && c.link) window.open(c.link, '_blank', 'noopener,noreferrer'); };
    el.innerHTML = '';
    const badge = document.createElement('div');
    badge.className = 'ad-badge';
    badge.textContent = '广告';
    const mediaWrap = document.createElement('div');
    renderCreative(mediaWrap, cfg, isMobile, 'cover', sizingFor(cfg, isMobile));
    el.appendChild(badge);
    el.appendChild(mediaWrap);
    liveInstances.toast = { cfg, mediaEl: mediaWrap };

    const startTop = 'calc(-1 * ' + (sizingFor(cfg, isMobile).height) + ' - 40px - env(safe-area-inset-top))';
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
