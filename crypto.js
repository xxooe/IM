/* ============ crypto.js ============
   BubbleCrypto — 普通全局对象（通过 <script src="crypto.js"> 加载，
   并非 ES 模块），以便匹配 index.html 中的调用方式：BubbleCrypto.xxx(...)

   首版端到端加密方案（按约定）：静态 ECDH (P-256) 密钥协商 + AES-GCM。
   暂未实现双棘轮算法（Double Ratchet）/ 前向安全性 — 这是 v1 版本有意的权衡，
   后续可以在不改变消息格式的前提下叠加引入（依然是密文 + IV 信封）。

   私钥生成为不可导出状态，并作为 CryptoKey 对象直接存储在 IndexedDB 中
   （现代浏览器支持结构化克隆 CryptoKey），因此原始私钥材料
   完全不需要以字节数组形式出现在 JS 内存中。

   还包含用于本地账户登录的密码哈希 (PBKDF2) —
   这绝不会离开设备，仅用于限制对本地账户的访问，
   不用于任何服务端身份验证。
*/
const BubbleCrypto = (() => {

  async function generateIdentityKeyPair(){
    const keyPair = await crypto.subtle.generateKey(
      { name:'ECDH', namedCurve:'P-256' },
      false,                 // 不可导出 — 私钥保存在浏览器的密钥存储库内部
      ['deriveKey','deriveBits']
    );
    const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    return {
      privateKey: keyPair.privateKey,     // CryptoKey，不可导出 — 原样存入 IndexedDB
      publicKeyB64: bufToB64(publicKeyRaw) // 可安全地与好友共享 / 发布到 KV
    };
  }

  async function importPeerPublicKey(publicKeyB64){
    const raw = b64ToBuf(publicKeyB64);
    return crypto.subtle.importKey('raw', raw, {name:'ECDH', namedCurve:'P-256'}, false, []);
  }

  // 根据我的私钥 + 对方的公钥衍生出单次会话的 AES-256-GCM 密钥。
  async function deriveSharedKey(myPrivateKey, peerPublicKey){
    return crypto.subtle.deriveKey(
      { name:'ECDH', public: peerPublicKey },
      myPrivateKey,
      { name:'AES-GCM', length:256 },
      false,
      ['encrypt','decrypt']
    );
  }

  async function encryptText(aesKey, plaintext){
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt({name:'AES-GCM', iv}, aesKey, data);
    return { iv: bufToB64(iv), ciphertext: bufToB64(cipherBuf) };
  }

  async function decryptText(aesKey, envelope){
    const iv = b64ToBuf(envelope.iv);
    const cipherBuf = b64ToBuf(envelope.ciphertext);
    const plainBuf = await crypto.subtle.decrypt({name:'AES-GCM', iv}, aesKey, cipherBuf);
    return new TextDecoder().decode(plainBuf);
  }

  /* ---------- 本地账户密码哈希 (PBKDF2-SHA256) ----------
     这仅用于把守本地设备的账户解锁 — 不会发送到任何地方，
     因此不需要服务端验证，只需确保有人拿到 IndexedDB 文件时
     暴力破解足够缓慢即可。 */
  const PBKDF2_ITERATIONS = 150000;

  async function hashPassword(password, existingSaltB64){
    const salt = existingSaltB64 ? b64ToBuf(existingSaltB64) : crypto.getRandomValues(new Uint8Array(16)).buffer;
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name:'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash:'SHA-256' },
      keyMaterial,
      256
    );
    return { hashB64: bufToB64(bits), saltB64: bufToB64(salt) };
  }

  async function verifyPassword(password, saltB64, expectedHashB64){
    const { hashB64 } = await hashPassword(password, saltB64);
    return timingSafeEqual(hashB64, expectedHashB64);
  }

  function timingSafeEqual(a, b){
    if(typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for(let i=0;i<a.length;i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /* ---------- 群聊密钥（共享对称密钥，逐个成员包裹） ----------
     1:1 聊天通过 ECDH（见上文）衍生共享密钥。群聊没有单一的
     "另一方"来进行 ECDH，因此替代方案为：群创建者为群生成一个
     随机 AES-256 密钥，并将副本分发给每个成员 —
     通过上述相同的 1:1 ECDH 方案为他们单独加密，以便
     只有该成员能解包。之后的每条群消息都用这同一个共享密钥加密。
     简单且足够满足 v1 版本需求（符合 1:1 中已接受的无前向安全性权衡）。 */
  async function generateGroupKey(){
    const key = await crypto.subtle.generateKey({name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
    const raw = await crypto.subtle.exportKey('raw', key);
    return { key, rawB64: bufToB64(raw) };
  }
  async function importGroupKey(rawB64){
    const raw = b64ToBuf(rawB64);
    return crypto.subtle.importKey('raw', raw, {name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
  }

  /* ---------- Base64 辅助函数 (ArrayBuffer <-> 字符串，用于 JSON 传输) ---------- */
  function bufToB64(buf){
    const bytes = new Uint8Array(buf);
    let bin = '';
    for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBuf(b64){
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  return {
    generateIdentityKeyPair,
    importPeerPublicKey,
    deriveSharedKey,
    encryptText,
    decryptText,
    generateGroupKey,
    importGroupKey,
    hashPassword,
    verifyPassword
  };
})();