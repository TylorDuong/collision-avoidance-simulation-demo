// Single dashboard WebSocket with auto-reconnect. Survives view switches.

import { MSG } from '../../shared/protocol.js';

export function connect({ onState, onStatus }) {
  let ws = null;

  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    onStatus('connecting');
    ws.onopen = () => {
      onStatus('open');
      ws.send(JSON.stringify({ t: MSG.HELLO, role: 'dashboard' }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === MSG.STATE) onState(msg);
    };
    ws.onclose = () => {
      onStatus('closed');
      setTimeout(open, 1000);
    };
  };
  open();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  };
}
