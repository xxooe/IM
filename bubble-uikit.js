/* ============ bubble-uikit.js ============
   BubbleUIKit — 把 index.html 里几个跟"业务状态"完全无关、纯 DOM 操作的
   小工具（toast、确认弹窗、输入弹窗、头像方块）收成一个可复用的对象。
   跟 state/BubbleDB/currentLang 这些全局量彻底解耦：文案由调用方传入，
   不在这里写死中英文判断。

   这不是要替换掉 index.html 里全部的 UI 代码（screenFriendInfo 那些
   拼 HTML 字符串的函数强耦合了业务数据，拆出来意义不大），只是把"纯
   工具型"的那一层先独立出来，后续可以直接在别的项目里复用。
*/
const BubbleUIKit = (() => {
  function ensureToastEl() {
    let el = document.getElementById('bubble-toast-el');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bubble-toast-el';
      el.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:rgba(20,20,20,.92);color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:9999;max-width:80vw;text-align:center;pointer-events:none;opacity:0;transition:opacity .2s;';
      document.body.appendChild(el);
    }
    return el;
  }

  function showToast(msg, durationMs = 2200) {
    const el = ensureToastEl();
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, durationMs);
  }

  /** @returns {Promise<boolean>} 用户点了确认就 resolve(true)，取消/点遮罩就 resolve(false) */
  function confirmModal({ title, body, confirmLabel = '确定', cancelLabel = '取消', hideCancel = false }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'bubble-modal-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9998;';
      overlay.innerHTML = `<div class="bubble-modal-card" style="background:#fff;border-radius:14px;padding:20px;max-width:320px;width:88vw;">
        <div style="font-weight:600;font-size:16px;margin-bottom:8px;">${title || ''}</div>
        <div style="font-size:13px;color:#666;margin-bottom:18px;">${body || ''}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          ${hideCancel ? '' : `<button data-act="cancel" style="padding:8px 16px;border-radius:8px;border:none;background:#eee;">${cancelLabel}</button>`}
          <button data-act="confirm" style="padding:8px 16px;border-radius:8px;border:none;background:#3D6FCB;color:#fff;">${confirmLabel}</button>
        </div>
      </div>`;
      const close = (result) => { overlay.remove(); resolve(result); };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      overlay.querySelector('[data-act="cancel"]')?.addEventListener('click', () => close(false));
      overlay.querySelector('[data-act="confirm"]').addEventListener('click', () => close(true));
      document.body.appendChild(overlay);
    });
  }

  /** @returns {Promise<string|null>} 用户输入并确认的字符串，取消则 resolve(null) */
  function promptInput({ title, value = '', placeholder = '', confirmLabel = '确定', cancelLabel = '取消' }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'bubble-modal-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9998;';
      overlay.innerHTML = `<div class="bubble-modal-card" style="background:#fff;border-radius:14px;padding:20px;max-width:320px;width:88vw;">
        <div style="font-weight:600;font-size:16px;margin-bottom:12px;">${title || ''}</div>
        <input data-act="input" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #ddd;margin-bottom:16px;" />
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button data-act="cancel" style="padding:8px 16px;border-radius:8px;border:none;background:#eee;">${cancelLabel}</button>
          <button data-act="confirm" style="padding:8px 16px;border-radius:8px;border:none;background:#3D6FCB;color:#fff;">${confirmLabel}</button>
        </div>
      </div>`;
      const input = overlay.querySelector('[data-act="input"]');
      input.value = value;
      input.placeholder = placeholder;
      const close = (result) => { overlay.remove(); resolve(result); };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      const submit = () => { const v = input.value.trim(); close(v || null); };
      overlay.querySelector('[data-act="confirm"]').addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      document.body.appendChild(overlay);
      requestAnimationFrame(() => input.focus());
    });
  }

  /** 生成头像方块的 HTML；entity 形如 {nickname/name/userId, avatarEmoji, color}。
      第三个参数 isOnline 控制头像右下角的在线圆点——v3 起，这个圆点代表
      的是"好友在线"（BubblePresence 的实时状态），不是"P2P 直连是否已经
      打通"：那是纯传输层细节，用户不需要关心，也不应该在 UI 上体现。 */
  function avatarHtml(entity, size, isOnline) {
    const cls = size ? `avatar ${size}` : 'avatar';
    const bg = entity.color || colorFromString(entity.nickname || entity.name || entity.userId || '?');
    const dot = isOnline ? '<span class="online-dot"></span>' : '';
    return `<div class="${cls}" style="background:${bg};position:relative;">${entity.avatarEmoji || '🙂'}${dot}</div>`;
  }

  function colorFromString(s) {
    const palette = ['#D98A8A', '#F7B5BD', '#3EA6E0', '#739C9B', '#E0B84A', '#8CAE7E', '#C4680E', '#4C7444'];
    let h = 0;
    for (let i = 0; i < s.length; i++) h = h * 31 + s.charCodeAt(i) >>> 0;
    return palette[h % palette.length];
  }

  /* ---------- 顶部下拉通知（v3 新增） ----------
     好友上线、收到新消息（对方不在当前聊天窗口时）共用同一套视觉：
     顶部滑下一张卡片，带头像+标题+副标题，点一下触发 onClick，几秒后
     自动收起。同一时间只保留一张——新的通知进来，旧的直接顶掉，避免
     堆叠出一长条通知刷屏。 */
  let bannerTimer = null;
  function ensureBannerEl() {
    let el = document.getElementById('bubble-banner-el');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bubble-banner-el';
      el.style.cssText = 'position:fixed;left:50%;top:-100px;transform:translate(-50%,0);width:92vw;max-width:420px;background:#fff;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:12px 14px;display:flex;align-items:center;gap:10px;z-index:10000;transition:top .25s ease;cursor:pointer;';
      document.body.appendChild(el);
    }
    return el;
  }

  function showBanner({ avatarHtml: avatarHtmlStr, title, subtitle, onClick, durationMs = 3500 }) {
    const el = ensureBannerEl();
    el.innerHTML = `<div class="banner-avatar">${avatarHtmlStr || ''}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title || ''}</div>
        ${subtitle ? `<div style="font-size:12px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${subtitle}</div>` : ''}
      </div>`;
    el.onclick = () => { hideBanner(); if (onClick) onClick(); };
    requestAnimationFrame(() => { el.style.top = '14px'; });
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, durationMs);
  }

  function hideBanner() {
    const el = document.getElementById('bubble-banner-el');
    if (el) el.style.top = '-100px';
  }

  return { showToast, confirmModal, promptInput, avatarHtml, colorFromString, showBanner, hideBanner };
})();

if (typeof window !== 'undefined') window.BubbleUIKit = BubbleUIKit;
if (typeof module !== 'undefined' && module.exports) module.exports = BubbleUIKit;
