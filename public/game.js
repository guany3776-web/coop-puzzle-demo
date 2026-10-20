// 双人协作解谜 前端：连接服务器、发送按键、按服务器状态绘制
const TILE = 32;

// 与 server.js 保持一致的地图（#墙 .地板 P左压板 Q右压板 D门=中央汇合点）
const MAP = [
  '###################',
  '#........#........#',
  '#........#........#',
  '#P.......D.......Q#',
  '#........#........#',
  '#........#........#',
  '#........#........#',
  '#........#........#',
  '###################',
];

// DOM
const lobby = document.getElementById('lobby');
const gameEl = document.getElementById('game');
const msg = document.getElementById('msg');
const waitBox = document.getElementById('waitBox');
const roomCodeShow = document.getElementById('roomCodeShow');
const hudCode = document.getElementById('hudCode');
const winBanner = document.getElementById('winBanner');
const leaveTip = document.getElementById('leaveTip');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// WebSocket 地址（本地 localhost，部署后自动用页面所在地址）
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${wsProto}://${location.host}`);

let myIdx = -1;
let lastState = { players: [], doorOpen: false, won: false };

// ---------- 房间交互 ----------
document.getElementById('btnCreate').addEventListener('click', () => {
  send({ t: 'create', name: document.getElementById('nameInput').value.trim() });
});
document.getElementById('btnJoin').addEventListener('click', () => {
  const code = document.getElementById('codeInput').value.trim();
  if (!code) { msg.textContent = '请输入4位房间码'; return; }
  send({ t: 'join', code, name: document.getElementById('nameInput').value.trim() });
});

function send(obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.t === 'created') {
    roomCodeShow.textContent = m.code;
    waitBox.classList.remove('hidden');
    msg.textContent = '';
  } else if (m.t === 'start') {
    myIdx = m.you;
    hudCode.textContent = m.code;
    lobby.classList.add('hidden');
    waitBox.classList.add('hidden');
    gameEl.classList.remove('hidden');
    winBanner.classList.add('hidden');
    leaveTip.classList.add('hidden');
  } else if (m.t === 'state') {
    lastState = m;
    if (m.won) winBanner.classList.remove('hidden');
  } else if (m.t === 'error') {
    msg.textContent = m.msg;
  } else if (m.t === 'partner_left') {
    leaveTip.classList.remove('hidden');
  }
};

// ---------- 键盘输入 ----------
const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};
const held = {};

window.addEventListener('keydown', (e) => {
  const key = KEYMAP[e.code];
  if (!key) return;
  e.preventDefault();
  if (e.repeat || held[key]) return;
  held[key] = true;
  send({ t: 'input', key, down: true });
});
window.addEventListener('keyup', (e) => {
  const key = KEYMAP[e.code];
  if (!key) return;
  held[key] = false;
  send({ t: 'input', key, down: false });
});

// 触屏 / 鼠标虚拟方向键
document.querySelectorAll('.dpad-btn').forEach((btn) => {
  const key = btn.dataset.key;
  const press = (e) => {
    e.preventDefault();
    if (held[key]) return;
    held[key] = true;
    send({ t: 'input', key, down: true });
  };
  const release = (e) => {
    e.preventDefault();
    held[key] = false;
    send({ t: 'input', key, down: false });
  };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
});

// ---------- 绘制 ----------
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 地图格子
  for (let r = 0; r < MAP.length; r++) {
    for (let c = 0; c < MAP[r].length; c++) {
      const ch = MAP[r][c];
      const x = c * TILE, y = r * TILE;
      if (ch === '#') {
        ctx.fillStyle = '#2b3542';
        ctx.fillRect(x, y, TILE, TILE);
      } else {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#171d26' : '#1a212b';
        ctx.fillRect(x, y, TILE, TILE);
      }
      if (ch === 'P' || ch === 'Q') {
        ctx.fillStyle = '#c9a227';
        ctx.fillRect(x + 6, y + 6, TILE - 12, TILE - 12);
      }
      if (ch === 'G') {
        ctx.strokeStyle = '#5fce6b';
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 4, y + 4, TILE - 8, TILE - 8);
      }
      if (ch === 'D') {
        if (lastState.doorOpen) {
          ctx.fillStyle = 'rgba(95,206,107,.3)';
          ctx.fillRect(x, y, TILE, TILE);
          ctx.strokeStyle = '#5fce6b';
          ctx.lineWidth = 3;
          ctx.strokeRect(x + 3, y + 3, TILE - 6, TILE - 6);
        } else {
          ctx.fillStyle = '#b34545';
          ctx.fillRect(x, y, TILE, TILE);
        }
      }
    }
  }

  // 压板点亮：被自己/队友踩中时提示由玩家圆点颜色表达，这里把踩中的板描边
  for (const p of lastState.players) {
    if (p.onPlate) {
      const c = Math.floor(p.x / TILE), r = Math.floor(p.y / TILE);
      ctx.strokeStyle = '#8be08b';
      ctx.lineWidth = 3;
      ctx.strokeRect(c * TILE + 4, r * TILE + 4, TILE - 8, TILE - 8);
    }
  }

  // 玩家
  for (const p of lastState.players) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    if (p.idx === myIdx) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = '#e8ecf1';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, p.x, p.y - 16);
  }

  requestAnimationFrame(draw);
}
draw();
