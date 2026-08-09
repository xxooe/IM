/* ============ crypto.js ============
   BubbleCrypto — plain global object (loaded via <script src="crypto.js">,
   NOT a module) so it matches how index.html calls it: BubbleCrypto.xxx(...)

   First-version E2E scheme (as agreed): static ECDH (P-256) key agreement + AES-GCM.
   No Double Ratchet / forward secrecy yet — intentional v1 trade-off, can be
   layered in later without changing the message format (still ciphertext+iv envelopes).

   The private key is generated non-extractable and stored directly as a CryptoKey
   object in IndexedDB (modern browsers support structured-cloning CryptoKey), so the
   raw private key material never has to touch JS memory as a byte array at all.

   Also includes password hashing (PBKDF2) used for local account login —
   this never leaves the device, it's just to gate access to the local account,
   not for any server-side auth.
*/
const BubbleCrypto = (() => {

  async function generateIdentityKeyPair(){
    const keyPair = await crypto.subtle.generateKey(
      { name:'ECDH', namedCurve:'P-256' },
      false,                 // not extractable — private key stays inside the browser's key store
      ['deriveKey','deriveBits']
    );
    const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    return {
      privateKey: keyPair.privateKey,     // CryptoKey, non-extractable — store as-is in IndexedDB
      publicKeyB64: bufToB64(publicKeyRaw) // safe to share with friends / publish to KV
    };
  }

  async function importPeerPublicKey(publicKeyB64){
    const raw = b64ToBuf(publicKeyB64);
    return crypto.subtle.importKey('raw', raw, {name:'ECDH', namedCurve:'P-256'}, false, []);
  }

  // Derives a per-conversation AES-256-GCM key from my private key + their public key.
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

  /* ---------- local account password hashing (PBKDF2-SHA256) ----------
     This only gates the local device's account unlock — nothing is sent
     anywhere, so it doesn't need to be server-verifiable, just slow to
     brute-force if someone gets the IndexedDB file. */
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

  /* ---------- group chat key (shared symmetric key, wrapped per-member) ----------
     1:1 chats derive a shared key via ECDH (above). A group has no single
     "other side" to do ECDH with, so instead: the group creator generates one
     random AES-256 key for the group, and hands a copy to each member —
     individually encrypted for them via the same 1:1 ECDH scheme above, so
     only that member can unwrap it. Every group message is then encrypted
     with this one shared key. Simple, and enough for v1 (matches the
     no-forward-secrecy trade-off already accepted for 1:1). */
  async function generateGroupKey(){
    const key = await crypto.subtle.generateKey({name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
    const raw = await crypto.subtle.exportKey('raw', key);
    return { key, rawB64: bufToB64(raw) };
  }
  async function importGroupKey(rawB64){
    const raw = b64ToBuf(rawB64);
    return crypto.subtle.importKey('raw', raw, {name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
  }

  /* ---------- base64 helpers (ArrayBuffer <-> string, for JSON transport) ---------- */
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
