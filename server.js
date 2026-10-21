// 两人俯视角协作解谜 —— 多关卡版后端
// 运行：npm install 然后 npm start（默认 http://localhost:3000）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TILE = 32;
const MOVE_SPEED = 3.12;     // 原 2.4 ×1.3
const TICK_MS = 100;
const PLAYER_R = 11;

// ---------- 关卡定义（权威在服务器） ----------
// map: 19列×9行。#墙 .地板 D=门(过关通道) G=汇合绿格 P/Q=压板(仅图示，以plates为准)
// doorMode:
//   'hold'     两块压板同时踩下 → 永久开门（教学）
//   'timed'    任一人踩压板 → 门开；两块板都没人踩后 8 秒自动关门（接力冲刺）
//   'sequence' 必须按 plates 顺序逐块踩对 → 永久开门（顺序密码）
// plates: 压板坐标数组；goal: 汇合格；spawn: 两人生成点
const CHAPTER = '第一章 · 热身训练';
const LEVELS = [
  {
    chapter: CHAPTER,
    name: '并肩开门',
    doorMode: 'hold',
    map: [
      '###################',
      '#........#........#',
      '#........#........#',
      '#........D........#',
      '#........#........#',
      '#........#........#',
      '#........#........#',
      '#........#........#',
      '###################',
    ],
    plates: [{ c: 1, r: 3 }, { c: 17, r: 3 }],
    goal: { c: 9, r: 3 },
    spawn: [{ c: 1, r: 7 }, { c: 17, r: 7 }],
  },
  {
    chapter: CHAPTER,
    name: '限时接力',
    doorMode: 'timed',
    doorTimerMs: 8000,
    map: [
      '###################',
      '#........#........#',
      '#........#........#',
      '#........#........#',
      '#........D........#',
      '#........#........#',
      '#........#........#',
      '#........#........#',
      '###################',
    ],
    plates: [{ c: 1, r: 4 }, { c: 17, r: 4 }],
    goal: { c: 17, r: 1 },
    spawn: [{ c: 1, r: 7 }, { c: 1, r: 1 }],
  },
  {
    chapter: CHAPTER,
    name: '顺序密码',
    doorMode: 'sequence',
    map: [
      '###################',
      '#........#........#',
      '#........#........#',
      '#........D........#',
      '#........#........#',
      '#........#........#',
      '#........#........#',
      '#........#........#',
      '###################',
    ],
    // 顺序：先左 → 再右 → 最后中间
    plates: [{ c: 1, r: 4 }, { c: 17, r: 4 }, { c: 9, r: 7 }],
    goal: { c: 9, r: 1 },
    spawn: [{ c: 1, r: 7 }, { c: 17, r: 7 }],
  },
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
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '/index.html') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
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
const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

function cellAt(px, py) {
  return { c: Math.floor(px / TILE), r: Math.floor(py / TILE) };
}

function plateIndexAt(cell, level) {
  for (let i = 0; i < level.plates.length; i++) {
    if (level.plates[i].c === cell.c && level.plates[i].r === cell.r) return i;
  }
  return -1;
}

function isSolid(map, c, r, doorOpen) {
  if (r < 0 || r >= map.length || c < 0 || c >= map[r].length) return true;
  const ch = map[r][c];
  if (ch === '#') return true;
  if (ch === 'D' && !doorOpen) return true; // 门关时是墙
  return false;
}

// 按移动方向采样，避免边缘误探相邻墙格
function blocked(x, y, level, doorOpen, lookLeft, lookRight, lookUp, lookDown) {
  const samples = [[x, y]];
  if (lookLeft) samples.push([x - PLAYER_R, y]);
  if (lookRight) samples.push([x + PLAYER_R, y]);
  if (lookUp) samples.push([x, y - PLAYER_R]);
  if (lookDown) samples.push([x, y + PLAYER_R]);
  for (const [sx, sy] of samples) {
    const { c, r } = cellAt(sx, sy);
    if (isSolid(level.map, c, r, doorOpen)) return true;
  }
  return false;
}

function makePlayer(idx, level) {
  const s = level.spawn[idx] || level.spawn[0];
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

function publicLevel(lv) {
  return {
    chapter: lv.chapter,
    name: lv.name,
    map: lv.map,
    doorMode: lv.doorMode,
    plates: lv.plates,
    goal: lv.goal,
    spawn: lv.spawn,
  };
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
  const level = LEVELS[room.levelId];
  room.timer = setInterval(() => {
    if (room.won) { broadcast(room); return; }

    for (const p of room.players) {
      let dx = 0, dy = 0;
      if (p.keys.left) dx -= MOVE_SPEED;
      if (p.keys.right) dx += MOVE_SPEED;
      if (p.keys.up) dy -= MOVE_SPEED;
      if (p.keys.down) dy += MOVE_SPEED;
      if (dx !== 0 && !blocked(p.x + dx, p.y, level, room.doorOpen, false, dx > 0, false, false)) p.x += dx;
      if (dy !== 0 && !blocked(p.x, p.y + dy, level, room.doorOpen, false, false, dy < 0, dy > 0)) p.y += dy;
    }

    const p0 = room.players[0];
    const p1 = room.players[1];
    const idxs = [cellAt(p0.x, p0.y), cellAt(p1.x, p1.y)].map(c => plateIndexAt(c, level));
    p0.onPlate = idxs[0] >= 0;
    p1.onPlate = idxs[1] >= 0;
    const anyoneOn = idxs.some(i => i >= 0);

    if (level.doorMode === 'hold') {
      if (idxs[0] === 0 && idxs[1] === 1) room.doorOpen = true;
    } else if (level.doorMode === 'timed') {
      if (anyoneOn) {
        room.doorOpen = true;
        room.doorTimer = level.doorTimerMs || 8000;
      } else if (room.doorOpen) {
        room.doorTimer -= TICK_MS;
        if (room.doorTimer <= 0) room.doorOpen = false;
      }
    } else if (level.doorMode === 'sequence') {
      [0, 1].forEach((pi) => {
        const cur = idxs[pi];
        const prev = room.prevPlate[pi];
        if (cur >= 0 && cur !== prev) {
          if (cur === room.seqProgress) room.seqProgress += 1;
          else room.seqProgress = 0;
        }
        room.prevPlate[pi] = cur;
      });
      if (room.seqProgress >= level.plates.length) room.doorOpen = true;
    }

    if (room.doorOpen) {
      const g0 = cellAt(p0.x, p0.y);
      const g1 = cellAt(p1.x, p1.y);
      if (g0.c === level.goal.c && g0.r === level.goal.r &&
          g1.c === level.goal.c && g1.r === level.goal.r) {
        room.won = true;
        if (!room.autoScheduled) {
          room.autoScheduled = true;
          setTimeout(() => advanceRoom(room), 2500);
        }
      }
    }

    broadcast(room);
  }, TICK_MS);
}

// 通关后自动进入下一段；最后一段则宣布整章完成
function advanceRoom(room) {
  room.autoScheduled = false;
  const isLast = room.levelId >= LEVELS.length - 1;
  if (isLast) {
    room.clients.forEach(c => send(c, { t: 'finished', chapter: CHAPTER }));
    return;
  }
  const next = room.levelId + 1;
  room.levelId = next;
  const level = LEVELS[next];
  room.doorOpen = false;
  room.won = false;
  room.doorTimer = level.doorTimerMs || 8000;
  room.seqProgress = 0;
  room.prevPlate = [-1, -1];
  room.players = room.players.map((p, i) => {
    const np = makePlayer(i, level);
    np.name = p.name;
    return np;
  });
  room.clients.forEach((c, i) => send(c, {
    t: 'start', you: i, code: room.code,
    levelId: next, level: publicLevel(level),
  }));
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.myIdx = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;

    // 创建房间：房主，默认选第1关，处于等待状态
    if (msg.t === 'create') {
      const code = makeCode();
      const levelId = 0;
      const player = makePlayer(0, LEVELS[levelId]);
      player.name = (msg.name || '玩家1').slice(0, 12);
      const newRoom = {
        code, clients: [ws], players: [player],
        doorOpen: false, won: false, timer: null,
        levelId, started: false,
      };
      rooms.set(code, newRoom);
      ws.roomCode = code;
      ws.myIdx = 0;
      send(ws, {
        t: 'created', code, you: 0, host: true,
        levelId,
        levels: LEVELS.map((l, i) => ({ id: i, name: l.name })),
      });
    }

    // 加入房间
    else if (msg.t === 'join') {
      const code = String(msg.code || '').trim();
      const target = rooms.get(code);
      if (!target) return send(ws, { t: 'error', msg: '房间不存在，请核对房间码' });
      if (target.started) return send(ws, { t: 'error', msg: '这局已经开始了' });
      if (target.clients.length >= 2) return send(ws, { t: 'error', msg: '房间已满（2人）' });

      const player = makePlayer(1, LEVELS[target.levelId]);
      player.name = (msg.name || '玩家2').slice(0, 12);
      target.players.push(player);
      target.clients.push(ws);
      ws.roomCode = code;
      ws.myIdx = 1;

      // 通知房主：队友就位
      send(target.clients[0], { t: 'partner_ready', levelId: target.levelId });
      // 通知加入者：进入等待选关
      send(ws, {
        t: 'waiting', you: 1, host: false, code,
        levelId: target.levelId,
        levels: LEVELS.map((l, i) => ({ id: i, name: l.name })),
      });
    }

    // 房主选关
    else if (msg.t === 'select_level' && room && !room.started) {
      if (ws.myIdx !== 0) return; // 只有房主能选
      const id = Number(msg.levelId);
      if (id >= 0 && id < LEVELS.length) {
        room.levelId = id;
        room.players[0] && (room.players[0] = makePlayer(0, LEVELS[id]));
        if (room.players[1]) room.players[1] = makePlayer(1, LEVELS[id]);
        room.clients.forEach(c => send(c, { t: 'level_pick', levelId: id }));
      }
    }

    // 房主开始游戏（需两人就位）
    else if (msg.t === 'start_game' && room && !room.started) {
      if (ws.myIdx !== 0) return;
      if (room.clients.length < 2) return send(ws, { t: 'error', msg: '等待第二位玩家加入' });
      const level = LEVELS[room.levelId];
      room.started = true;
      room.doorOpen = false;
      room.won = false;
      room.doorTimer = level.doorTimerMs || 8000;
      room.seqProgress = 0;
      room.prevPlate = [-1, -1];
      room.players = room.players.map((p, i) => {
        const np = makePlayer(i, level);
        np.name = p.name;
        return np;
      });
      startRoomLoop(room);
      room.clients.forEach((c, i) => send(c, {
        t: 'start', you: i, code: room.code,
        levelId: room.levelId, level: publicLevel(level),
      }));
    }

    else if (msg.t === 'input' && room && room.started) {
      const p = room.players[ws.myIdx];
      if (p && p.keys.hasOwnProperty(msg.key)) p.keys[msg.key] = !!msg.down;
    }

    // 房主通关后进入下一关（循环）
    else if (msg.t === 'next_level' && room && room.won) {
      if (ws.myIdx !== 0) return;
      const next = (room.levelId + 1) % LEVELS.length;
      room.levelId = next;
      const level = LEVELS[next];
      room.doorOpen = false;
      room.won = false;
      room.doorTimer = level.doorTimerMs || 8000;
      room.seqProgress = 0;
      room.prevPlate = [-1, -1];
      room.players = room.players.map((p, i) => {
        const np = makePlayer(i, level);
        np.name = p.name;
        return np;
      });
      room.clients.forEach((c, i) => send(c, {
        t: 'start', you: i, code: room.code,
        levelId: next, level: publicLevel(level),
      }));
    }
  });

  ws.on('close', () => {
    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room) return;
    const i = room.clients.indexOf(ws);
    if (i >= 0) room.clients.splice(i, 1);
    room.players.splice(ws.myIdx, 1);
    room.players.forEach((p, ni) => { p.idx = ni; p.color = COLORS[ni]; });
    if (room.clients.length === 0) {
      clearInterval(room.timer);
      rooms.delete(ws.roomCode);
    } else {
      const remain = room.clients[0];
      remain.myIdx = 0;
      remain.started = false;
      send(remain, { t: 'partner_left' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`协作解谜 Demo 已启动：http://localhost:${PORT}`);
  console.log('一人创建房间并选关、开始，另一人输入房间码加入。');
});
