/* ============ comm.js ============
   BubbleComm — plain global object (loaded via <script src="comm.js">,
   NOT a module) so it matches how index.html calls it: BubbleComm.xxx(...)

   Transport-agnostic messaging layer. The rest of the app only calls
   `BubbleComm.send(roomId, payload)` and subscribes with `BubbleComm.onMessage(cb)` —
   it never knows whether messages are going over a real network or not.

   Two transports are implemented:
     - loopback: uses BroadcastChannel so you can test the whole app RIGHT NOW,
       locally, across two browser tabs/windows, with zero deployment.
       (Replaces the old standalone comm1.js — delete that file, this covers it.)
     - websocket: talks to the Cloudflare Worker + Durable Object described
       in /cloudflare-worker.

   Call BubbleComm.setTransportMode('loopback' | 'websocket') to flip between
   them — defaults to 'websocket' since your Worker/KV/TURN are already deployed.
   For local multi-tab testing without hitting the real relay, call
   BubbleComm.setTransportMode('loopback') before BubbleComm.init(userId).
*/
const BubbleComm = (() => {

  // Fill in once you deploy the Worker (see /cloudflare-worker/README.md).
  const SIGNAL_ENDPOINT = 'wss://pipoim-signal.jatosi6060.workers.dev/signal';

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
        // basic reconnect with backoff — the Durable Object hibernates when idle,
        // so reconnecting is cheap and doesn't cost anything while nobody's chatting.
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
