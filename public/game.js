// 双人协作解谜 前端：连接服务器、发送按键、按服务器状态绘制
const TILE = 32;

// DOM
const lobby = document.getElementById('lobby');
const roomLobby = document.getElementById('roomLobby');
const gameEl = document.getElementById('game');
const msg = document.getElementById('msg');
const roomCodeShow = document.getElementById('roomCodeShow');
const levelList = document.getElementById('levelList');
const btnStart = document.getElementById('btnStart');
const hostNote = document.getElementById('hostNote');
const joinWait = document.getElementById('joinWait');
const readyNote = document.getElementById('readyNote');
const hudCode = document.getElementById('hudCode');
const levelNameEl = document.getElementById('levelName');
const winBanner = document.getElementById('winBanner');
const btnNext = document.getElementById('btnNext');
const leaveTip = document.getElementById('leaveTip');
const bgmBtn = document.getElementById('bgmBtn');
const rotateHint = document.getElementById('rotateHint');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// WebSocket 地址（本地 localhost，部署后自动用页面所在地址）
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${wsProto}://${location.host}`);

let myIdx = -1;
let amHost = false;
let currentLevel = null;
let levelOptions = [];
let selectedLevel = 0;
let lastState = { players: [], doorOpen: false, won: false };

// ---------- 房间交互 ----------
document.getElementById('btnCreate').addEventListener('click', () => {
  startBgm();
  send({ t: 'create', name: document.getElementById('nameInput').value.trim() });
});
document.getElementById('btnJoin').addEventListener('click', () => {
  const code = document.getElementById('codeInput').value.trim();
  if (!code) { msg.textContent = '请输入4位房间码'; return; }
  startBgm();
  send({ t: 'join', code, name: document.getElementById('nameInput').value.trim() });
});

function send(obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- 选关列表 ----------
function renderLevels(highlight) {
  levelList.innerHTML = '';
  levelOptions.forEach(lv => {
    const div = document.createElement('div');
    div.className = 'level-item' + (lv.id === highlight ? ' active' : '');
    div.textContent = lv.name;
    if (amHost) {
      div.addEventListener('click', () => {
        selectedLevel = lv.id;
        send({ t: 'select_level', levelId: lv.id });
        renderLevels(lv.id);
      });
    }
    levelList.appendChild(div);
  });
}

function showRoomPanel() {
  lobby.classList.add('hidden');
  gameEl.classList.add('hidden');
  roomLobby.classList.remove('hidden');
}

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);

  if (m.t === 'created') {
    myIdx = m.you; amHost = m.host;
    roomCodeShow.textContent = m.code;
    levelOptions = m.levels; selectedLevel = m.levelId;
    hostNote.classList.remove('hidden'); joinWait.classList.add('hidden');
    btnStart.classList.remove('hidden'); readyNote.classList.add('hidden');
    renderLevels(m.levelId);
    showRoomPanel();
  } else if (m.t === 'waiting') {
    myIdx = m.you; amHost = m.host;
    roomCodeShow.textContent = m.code;
    levelOptions = m.levels; selectedLevel = m.levelId;
    hostNote.classList.add('hidden'); joinWait.classList.remove('hidden');
    btnStart.classList.add('hidden'); readyNote.classList.add('hidden');
    renderLevels(m.levelId);
    showRoomPanel();
  } else if (m.t === 'level_pick') {
    selectedLevel = m.levelId;
    renderLevels(m.levelId);
  } else if (m.t === 'partner_ready') {
    readyNote.classList.remove('hidden');
  } else if (m.t === 'start') {
    myIdx = m.you;
    currentLevel = m.level;
    hudCode.textContent = m.code;
    levelNameEl.textContent = m.level ? ((m.level.chapter || '') + ' · ' + m.level.name) : '';
    roomLobby.classList.add('hidden');
    gameEl.classList.remove('hidden');
    winBanner.classList.add('hidden');
    btnNext.classList.add('hidden');
    leaveTip.classList.add('hidden');
  } else if (m.t === 'state') {
    lastState = m;
    if (m.won) winBanner.classList.remove('hidden'); // 自动续关，无需点按钮
  } else if (m.t === 'finished') {
    winBanner.textContent = '🏆 恭喜通关第一章「热身训练」！';
    winBanner.classList.remove('hidden');
  } else if (m.t === 'error') {
    msg.textContent = m.msg;
    readyNote.textContent = m.msg;
  } else if (m.t === 'partner_left') {
    leaveTip.classList.remove('hidden');
  }
};

btnStart.addEventListener('click', () => send({ t: 'start_game' }));
btnNext.addEventListener('click', () => send({ t: 'next_level' }));

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

// ---------- 配乐（WebAudio 简易循环旋律） ----------
let audioCtx = null;
let bgmOn = true;
let bgmTimer = null;
const MELODY = [262, 330, 392, 330, 294, 349, 440, 349]; // C E G E D F A F
let noteIdx = 0;

function playNote(freq) {
  if (!audioCtx || !bgmOn) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.28);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + 0.3);
}
function startBgm() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    bgmTimer = setInterval(() => {
      playNote(MELODY[noteIdx % MELODY.length]);
      noteIdx++;
    }, 320);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
bgmBtn.addEventListener('click', () => {
  bgmOn = !bgmOn;
  bgmBtn.textContent = bgmOn ? '🔊 配乐开' : '🔇 配乐关';
});

// ---------- 横屏提示（仅手机竖屏） ----------
function checkOrientation() {
  const touchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const portrait = window.innerHeight > window.innerWidth;
  rotateHint.classList.toggle('hidden', !(touchDevice && portrait));
}
window.addEventListener('resize', checkOrientation);
checkOrientation();

// ---------- 绘制 ----------
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!currentLevel) { requestAnimationFrame(draw); return; }
  const map = currentLevel.map;

  // 地图格子
  for (let r = 0; r < map.length; r++) {
    for (let c = 0; c < map[r].length; c++) {
      const ch = map[r][c];
      const x = c * TILE, y = r * TILE;
      if (ch === '#') {
        ctx.fillStyle = '#2b3542';
        ctx.fillRect(x, y, TILE, TILE);
      } else {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#171d26' : '#1a212b';
        ctx.fillRect(x, y, TILE, TILE);
      }
    }
  }

  // 压板（用服务器下发坐标）
  for (const plate of currentLevel.plates) {
    ctx.fillStyle = '#c9a227';
    ctx.fillRect(plate.c * TILE + 6, plate.r * TILE + 6, TILE - 12, TILE - 12);
  }

  // 门 / 汇合点
  const g = currentLevel.goal;
  if (lastState.doorOpen) {
    ctx.fillStyle = 'rgba(95,206,107,.3)';
    ctx.fillRect(g.c * TILE, g.r * TILE, TILE, TILE);
    ctx.strokeStyle = '#5fce6b';
    ctx.lineWidth = 3;
    ctx.strokeRect(g.c * TILE + 3, g.r * TILE + 3, TILE - 6, TILE - 6);
  } else {
    ctx.fillStyle = '#b34545';
    ctx.fillRect(g.c * TILE, g.r * TILE, TILE, TILE);
  }

  // 踩中压板描边
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
