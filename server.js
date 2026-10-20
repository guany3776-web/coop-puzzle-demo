// 两人俯视角协作解谜 —— 最小可玩 Demo 后端
// 运行：npm install 然后 npm start（默认 http://localhost:3000）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TILE = 32;
const MOVE_SPEED = 2.4;      // 每 tick 移动像素（tick=100ms）
const TICK_MS = 100;
const PLAYER_R = 11;

// 关卡地图：#墙  .地板  P左压板  Q右压板  D门（踩板开启，开启后即中央汇合点）
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

// 压板与汇合点（门格）的格子坐标（列, 行）
const PLATE_A = { c: 1, r: 3 };
const PLATE_B = { c: 17, r: 3 };
const GOAL = { c: 9, r: 3 };
const SPAWN = [
  { c: 1, r: 7 },
  { c: 17, r: 7 },
];
const COLORS = ['#4da6ff', '#ff9a3c'];

// ---------- 静态文件托管 ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

// ---------- 房间与游戏状态（权威在服务器） ----------
const rooms = new Map(); // code -> { clients: [ws, ws], players: [...], doorOpen, won }

function makeCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

function cellAt(px, py) {
  const c = Math.floor(px / TILE);
  const r = Math.floor(py / TILE);
  return { c, r };
}

function isSolid(c, r, doorOpen) {
  if (r < 0 || r >= MAP.length || c < 0 || c >= MAP[r].length) return true;
  const ch = MAP[r][c];
  if (ch === '#') return true;
  if (ch === 'D' && !doorOpen) return true; // 门关时是墙
  return false;
}

// 按移动方向采样：水平移动只探中心与左右边缘，垂直移动只探中心与上下边缘，
// 避免侧面边缘误探到相邻墙格（否则进不了单列的门）。
function blocked(x, y, doorOpen, lookLeft, lookRight, lookUp, lookDown) {
  const samples = [[x, y]];
  if (lookLeft) samples.push([x - PLAYER_R, y]);
  if (lookRight) samples.push([x + PLAYER_R, y]);
  if (lookUp) samples.push([x, y - PLAYER_R]);
  if (lookDown) samples.push([x, y + PLAYER_R]);
  for (const [sx, sy] of samples) {
    const { c, r } = cellAt(sx, sy);
    if (isSolid(c, r, doorOpen)) return true;
  }
  return false;
}

function newPlayer(idx) {
  const s = SPAWN[idx];
  return {
    idx,
    x: s.c * TILE + TILE / 2,
    y: s.r * TILE + TILE / 2,
    name: '',
    color: COLORS[idx],
    keys: { up: false, down: false, left: false, right: false },
    onPlate: false,
  };
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  const payload = {
    t: 'state',
    doorOpen: room.doorOpen,
    won: room.won,
    players: room.players.map(p => ({
      idx: p.idx, x: Math.round(p.x), y: Math.round(p.y),
      name: p.name, color: p.color, onPlate: p.onPlate,
    })),
  };
  room.clients.forEach(ws => send(ws, payload));
}

function startRoomLoop(room) {
  if (room.timer) return;
  room.timer = setInterval(() => {
    if (room.won) { broadcast(room); return; }

    // 移动（先 x 后 y，可贴墙滑动）
    for (const p of room.players) {
      let dx = 0, dy = 0;
      if (p.keys.left) dx -= MOVE_SPEED;
      if (p.keys.right) dx += MOVE_SPEED;
      if (p.keys.up) dy -= MOVE_SPEED;
      if (p.keys.down) dy += MOVE_SPEED;

      if (dx !== 0 && !blocked(p.x + dx, p.y, room.doorOpen, false, dx > 0, false, false)) p.x += dx;
      if (dy !== 0 && !blocked(p.x, p.y + dy, room.doorOpen, false, false, dy < 0, dy > 0)) p.y += dy;
    }

    // 压板：两人各站一块
    const p0 = room.players[0];
    const p1 = room.players[1];
    const a = cellAt(p0.x, p0.y);
    const b = cellAt(p1.x, p1.y);
    p0.onPlate = (a.c === PLATE_A.c && a.r === PLATE_A.r);
    p1.onPlate = (b.c === PLATE_B.c && b.r === PLATE_B.r);
    // 门一旦被双踩触发就保持开启（锁存），否则离开压板后无法前往出口
    if (p0.onPlate && p1.onPlate) room.doorOpen = true;

    // 胜利：门开后两人都到出口格
    if (room.doorOpen) {
      const g0 = cellAt(p0.x, p0.y);
      const g1 = cellAt(p1.x, p1.y);
      if (g0.c === GOAL.c && g0.r === GOAL.r && g1.c === GOAL.c && g1.r === GOAL.r) {
        room.won = true;
      }
    }

    broadcast(room);
  }, TICK_MS);
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.myIdx = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;

    if (msg.t === 'create') {
      const code = makeCode();
      const player = newPlayer(0);
      player.name = (msg.name || '玩家1').slice(0, 12);
      const newRoom = { clients: [ws], players: [player], doorOpen: false, won: false, timer: null };
      rooms.set(code, newRoom);
      ws.roomCode = code;
      ws.myIdx = 0;
      send(ws, { t: 'created', code, you: 0 });
    }

    else if (msg.t === 'join') {
      const code = String(msg.code || '').trim();
      const target = rooms.get(code);
      if (!target) return send(ws, { t: 'error', msg: '房间不存在，请核对房间码' });
      if (target.clients.length >= 2) return send(ws, { t: 'error', msg: '房间已满（2人）' });
      const player = newPlayer(1);
      player.name = (msg.name || '玩家2').slice(0, 12);
      target.players.push(player);
      target.clients.push(ws);
      ws.roomCode = code;
      ws.myIdx = 1;
      startRoomLoop(target);
      // 通知双方开始
      target.clients.forEach((c, i) => send(c, { t: 'start', you: i, code }));
    }

    else if (msg.t === 'input' && room) {
      const p = room.players[ws.myIdx];
      if (p && p.keys.hasOwnProperty(msg.key)) {
        p.keys[msg.key] = !!msg.down;
      }
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    const i = room.clients.indexOf(ws);
    if (i >= 0) room.clients.splice(i, 1);
    room.players.splice(ws.myIdx, 1);
    // 重新整理 idx 与颜色
    room.players.forEach((p, ni) => { p.idx = ni; p.color = COLORS[ni]; });
    if (room.clients.length === 0) {
      clearInterval(room.timer);
      rooms.delete(ws.roomCode);
    } else {
      const remain = room.clients[0];
      remain.myIdx = 0;
      send(remain, { t: 'partner_left' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`协作解谜 Demo 已启动：http://localhost:${PORT}`);
  console.log('两人各开一个浏览器页面，一人创建房间，另一人输入4位房间码加入。');
});
