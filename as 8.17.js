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
 * 总开关：AdConfig.isVip = true 时，不管下面每个广告位单独的 enabled 是什么，
 * 全部广告一律不展示——这是留给"用户已经是VIP会员"这个判断结果用的开关，
 * 现在先写死在这个文件顶部，以后要接真实的会员状态判断，只需要把这一个值
 * 换成读取账号的VIP标记即可，不用改下面任何渲染逻辑。
 *
 * 素材怎么配：每个广告位下面的 pc / mobile 分别是电脑端/手机端展示的素材——
 * 跟settings.js里JS广告位的思路一样，同一个广告位在两种设备上可以放不同的图/
 * 视频/链接。custom 类型时用 customHtml，支持内联 <script> 和外链 <script src>
 * （第三方广告SDK代码），见 setInnerHTMLWithScripts。
 */
(function (window) {
  'use strict';

  // ============================================================
  // 广告配置中心——以后要改广告内容/开关/频率，只改这里，不用碰下面的渲染逻辑
  // ============================================================
  const AdConfig = {
    isVip: false, // 总开关：true = 关闭全部广告（不管下面每个广告位各自的enabled是什么）

    // ---- 广告位1：开屏广告 ----
    splash: {
      enabled: true,
      frequencyHours: 0, // 0=不限制，每次打开App都出现；24=每天最多一次；1=每小时最多一次
      type: 'image', // 'image' | 'video' | 'custom'
      pc: { image: 'images/cc2.png', video: '', link: 'https://example.com' },
      mobile: { image: 'images/dd2.png', video: '', link: 'https://example.com' },
      customHtml: ''
    },

    // ---- 广告位2：通话广告（呼叫中/被叫来电界面，双方都可见） ----
    call: {
      enabled: true,
      frequencyHours: 0,
      type: 'image', // 'image' | 'video' | 'custom'
      pc: { image: 'images/cc2.png', video: '', link: 'https://example.com' },
      mobile: { image: 'images/dd2.png', video: '', link: 'https://example.com' },
      customHtml: ''
    },

    // ---- 广告位3：顶部滑入小广告（跟新消息横幅同款视觉，3秒自动收起） ----
    toast: {
      enabled: true,
      frequencyHours: 0,
      type: 'image', // 'image' | 'video' | 'custom'
      pc: { image: 'images/bb2.png', video: '', link: 'https://example.com' },
      mobile: { image: 'images/cc2.png', video: '', link: 'https://example.com' },
      customHtml: '',
      durationMs: 3000 // 停留多久自动收起——跟新消息横幅保持一致的默认3秒，可以单独调
    }
  };

  // ============================================================
  // 工具函数
  // ============================================================
  function detectDevice() {
    const ua = navigator.userAgent || navigator.vendor || window.opera || '';
    const isMobileByUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const isMobileByScreen = window.innerWidth <= 768;
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
  // fit：'cover'（铺满容器，裁切）| 'contain'（完整显示，容器按素材比例自适应，
  // 通话广告位用这个——"根据视频或图片的大小自适应"）
  function renderCreative(container, cfg, isMobile, fit){
    container.innerHTML = '';
    if (cfg.type === 'custom') {
      setInnerHTMLWithScripts(container, cfg.customHtml);
      return;
    }
    const c = isMobile ? cfg.mobile : cfg.pc;
    const wrap = document.createElement('a');
    wrap.href = c.link || 'javascript:void(0)';
    if (c.link) { wrap.target = '_blank'; wrap.rel = 'noopener noreferrer'; }
    wrap.style.cssText = 'display:block;width:100%;height:100%;';
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
    media.style.cssText = fit === 'cover'
      ? 'width:100%;height:100%;object-fit:cover;display:block;'
      : 'max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto;';
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
      .ad-splash-card{position:relative;max-width:90vw;max-height:85vh;border-radius:14px;overflow:hidden;background:#121424;box-shadow:0 20px 50px rgba(0,0,0,.7);animation:adSplashIn .25s cubic-bezier(.175,.885,.32,1.275);}
      @keyframes adSplashIn{from{transform:scale(.85);opacity:0;}to{transform:scale(1);opacity:1;}}
      .ad-splash-content{max-width:90vw;max-height:85vh;display:flex;}
      .ad-splash-close{position:absolute;top:-9px;right:-9px;width:26px;height:26px;border-radius:50%;background:#f5c84c;color:#000;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:18px;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,.5);border:2px solid #fff;z-index:3;}
      /* ---- 通话广告：呼叫界面里的一块区域，自适应素材尺寸 ---- */
      .ad-call-slot{position:relative;max-width:min(80vw,360px);max-height:32vh;margin:14px auto 0;border-radius:10px;overflow:hidden;background:rgba(255,255,255,.04);}
      .ad-call-slot img,.ad-call-slot video{max-width:100%;max-height:32vh;}
      /* ---- 顶部滑入小广告：跟新消息横幅同款结构 ---- */
      .ad-toast-banner{position:fixed;left:50%;top:calc(-140px - env(safe-area-inset-top));transform:translateX(-50%);width:min(420px,calc(100vw - 24px));background:var(--panel-bg,#1c2230);border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.35);overflow:hidden;z-index:10050;cursor:pointer;transition:top .28s ease;box-sizing:border-box;}
      .ad-toast-banner-media{width:100%;max-height:120px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#000;}
      .ad-toast-banner-media img,.ad-toast-banner-media video{width:100%;max-height:120px;object-fit:cover;display:block;}
    `;
    document.head.appendChild(style);
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
    closeBtn.innerHTML = '&times;';
    closeBtn.title = '关闭广告';
    closeBtn.onclick = () => {
      backdrop.classList.remove('show');
      setTimeout(() => backdrop.remove(), 250);
    };
    renderCreative(content, cfg, isMobile, 'contain');
    card.appendChild(content);
    card.appendChild(closeBtn);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('show'));
  }

  // ============================================================
  // 广告位2：通话广告——呼叫中('calling')/来电('incoming')界面里挂一块广告区域，
  // 接通('active')之后由调用方自己把这块区域清掉（通话广告只在还没接通的等待
  // 阶段展示，接通后让用户专心通话，不干扰通话本身）
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
    mediaWrap.style.cssText = 'width:100%;height:100%;';
    renderCreative(mediaWrap, cfg, isMobile, 'contain');
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
    const mediaWrap = document.createElement('div');
    mediaWrap.className = 'ad-toast-banner-media';
    renderCreative(mediaWrap, cfg, isMobile, 'cover');
    el.innerHTML = '';
    const badge = document.createElement('div');
    badge.className = 'ad-badge';
    badge.textContent = '广告';
    el.appendChild(badge);
    el.appendChild(mediaWrap);

    requestAnimationFrame(() => { el.style.top = 'calc(10px + env(safe-area-inset-top))'; });
    clearTimeout(el._hideT);
    const duration = cfg.durationMs || 3000;
    el.__hideTimer = setTimeout(() => {
      el.style.top = 'calc(-140px - env(safe-area-inset-top))';
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
