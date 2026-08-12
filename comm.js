/* ============ comm.js ============
   BubbleComm — 普通全局对象（通过 <script src="comm.js"> 加载，
   并非 ES 模块），以便匹配 index.html 中的调用方式：BubbleComm.xxx(...)

   与传输协议解耦的消息传递层。应用的其他部分只需调用
   `BubbleComm.send(roomId, payload)` 并通过 `BubbleComm.onMessage(cb)` 进行订阅 —
   它永远不需要知道消息是否正在通过真实网络传输。

   实现了两种传输方式：
     - loopback: 使用 BroadcastChannel，以便你可以【立即】在本地
       通过两个浏览器标签页/窗口测试整个应用，无需任何部署。
     - websocket: 与 /cloudflare-worker 中描述的
       Cloudflare Worker + Durable Object 通信。

   调用 BubbleComm.setTransportMode('loopback' | 'websocket') 在它们之间切换 —
   由于你的 Worker/KV/TURN 已经部署，默认值为 'websocket'。
   若要进行本地多标签页测试而不触及真实中继，请在
   BubbleComm.init(userId) 之前调用 BubbleComm.setTransportMode('loopback')。
*/
const BubbleComm = (() => {

  // 部署 Worker 后在此填入地址（参见 /cloudflare-worker/README.md）。
  // const SIGNAL_ENDPOINT = 'wss://pipoim-signal.jatosi6060.workers.dev/signal';
  const SIGNAL_ENDPOINT = 'wss://wss.xxooe.com/signal';

  const TRANSPORT_MODE = { current: 'websocket' }; // 'loopback' | 'websocket'

  class LoopbackTransport {
    constructor(){
      this.channels = new Map(); // roomId -> BroadcastChannel
      this.listeners = [];
    }
    joinRoom(roomId){
      if(this.channels.has(roomId)) return;
      const ch = new BroadcastChannel('bubbleim:' + roomId);
      ch.onmessage = (ev)=> this.listeners.forEach(cb => cb(roomId, ev.data));
      this.channels.set(roomId, ch);
    }
    leaveRoom(roomId){
      const ch = this.channels.get(roomId);
      if(ch){ ch.close(); this.channels.delete(roomId); }
    }
    send(roomId, payload){
      this.joinRoom(roomId);
      this.channels.get(roomId).postMessage(payload);
    }
    onMessage(cb){ this.listeners.push(cb); }
  }

  class WebSocketTransport {
    constructor(){
      this.sockets = new Map(); // roomId -> WebSocket
      this.listeners = [];
      this.myUserId = null;
    }
    init(myUserId){ this.myUserId = myUserId; }
    joinRoom(roomId){
      if(this.sockets.has(roomId)) return;
      const url = `${SIGNAL_ENDPOINT}?room=${encodeURIComponent(roomId)}&uid=${encodeURIComponent(this.myUserId)}`;
      const ws = new WebSocket(url);
      ws.onmessage = (ev)=>{
        let payload;
        try{ payload = JSON.parse(ev.data); }catch{ return; }
        this.listeners.forEach(cb => cb(roomId, payload));
      };
      ws.onclose = ()=>{
        this.sockets.delete(roomId);
        // 基础的带退避重连 — Durable Object 在空闲时会休眠，
        // 因此重连开销很低，在无人聊天时不会产生任何费用。
        setTimeout(()=>{ if(!this.sockets.has(roomId)) this.joinRoom(roomId); }, 2000);
      };
      this.sockets.set(roomId, ws);
    }
    leaveRoom(roomId){
      const ws = this.sockets.get(roomId);
      if(ws){ ws.close(); this.sockets.delete(roomId); }
    }
    send(roomId, payload){
      this.joinRoom(roomId);
      const ws = this.sockets.get(roomId);
      const doSend = ()=> ws.send(JSON.stringify(payload));
      if(ws.readyState === WebSocket.OPEN) doSend();
      else ws.addEventListener('open', doSend, {once:true});
    }
    onMessage(cb){ this.listeners.push(cb); }
  }

  const loopback = new LoopbackTransport();
  const websocket = new WebSocketTransport();

  function activeTransport(){
    return TRANSPORT_MODE.current === 'websocket' ? websocket : loopback;
  }

  return {
    init(myUserId){ websocket.init(myUserId); },
    setTransportMode(mode){ TRANSPORT_MODE.current = mode; },
    getTransportMode(){ return TRANSPORT_MODE.current; },
    joinRoom(roomId){ activeTransport().joinRoom(roomId); },
    leaveRoom(roomId){ activeTransport().leaveRoom(roomId); },
    send(roomId, payload){ activeTransport().send(roomId, payload); },
    onMessage(cb){ loopback.onMessage(cb); websocket.onMessage(cb); },
  };
})();