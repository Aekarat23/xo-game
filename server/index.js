require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { initDB } = require('./db');
const { authRoutes, recordGameResult, verifyToken } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Auth routes
authRoutes(app);

// Initialize database
initDB().catch(console.error);

// Game state
const waitingMatch = [];
const rooms = {};
const socketPlayers = {}; // socket.id -> { playerId, username, displayName, avatarUrl }

function checkWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  if (board.every(cell => cell !== null)) {
    return { winner: 'draw', line: [] };
  }
  return null;
}

function generateRoomId() {
  let id;
  do {
    id = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms[id]);
  return id;
}

// Auth guard for socket events
function checkAuth(socket) {
  const sp = socketPlayers[socket.id];
  if (!sp || !sp.playerId) {
    socket.emit('auth-required', { message: 'กรุณาเข้าสู่ระบบก่อนเล่น' });
    return false;
  }
  return true;
}

async function handleGameEnd(roomId, resultMark, board) {
  const room = rooms[roomId];
  if (!room) return;

  const resultData = { result: { winner: resultMark === 'draw' ? 'draw' : resultMark, line: resultMark === 'draw' ? [] : (checkWinner(board)?.line || []) }, board };
  io.to(roomId).emit('game-over', resultData);

  // Record stats for logged-in players (non-bot games)
  if (!room.isBot) {
    for (const playerId of room.players) {
      const sp = socketPlayers[playerId];
      if (!sp?.playerId) continue;

      let res;
      if (resultMark === 'draw') res = 'draw';
      else if (room.marks[playerId] === resultMark) res = 'win';
      else res = 'lose';

      await recordGameResult(sp.playerId, res);
    }
  } else {
    // Bot game - record for human player only
    const humanSocket = room.players[0];
    const sp = socketPlayers[humanSocket];
    if (sp?.playerId) {
      let res;
      if (resultMark === 'draw') res = 'draw';
      else if (room.marks[humanSocket] === resultMark) res = 'win';
      else res = 'lose';
      await recordGameResult(sp.playerId, res);
    }
  }

  if (room.countdown) clearInterval(room.countdown);
  delete rooms[roomId];
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Authenticate socket
  socket.on('auth', ({ token }) => {
    const decoded = verifyToken(token);
    if (decoded) {
      socketPlayers[socket.id] = {
        playerId: decoded.id,
        username: decoded.username,
        displayName: decoded.displayName,
        avatarUrl: decoded.avatarUrl
      };
      socket.emit('auth-success');
    } else {
      socket.emit('auth-fail');
    }
  });

  // --- BOT MODE ---
  socket.on('bot-start', () => {
    if (!checkAuth(socket)) return;
    const roomId = 'BOT-' + socket.id.substring(0, 6);
    rooms[roomId] = {
      players: [socket.id, 'BOT'],
      board: Array(9).fill(null),
      turn: 0,
      ready: {},
      marks: { [socket.id]: 'X', 'BOT': 'O' },
      isBot: true,
      countdown: null
    };
    socket.join(roomId);
    socket.emit('game-start', {
      roomId,
      mark: 'X',
      opponent: 'BOT',
      board: Array(9).fill(null),
      yourTurn: true
    });
  });

  socket.on('bot-move', ({ roomId, index }) => {
    if (!checkAuth(socket)) return;
    const room = rooms[roomId];
    if (!room || room.board[index] !== null) return;
    if (room.players[room.turn] !== socket.id) return;

    room.board[index] = 'X';
    const result = checkWinner(room.board);
    if (result) {
      handleGameEnd(roomId, result.winner, room.board);
      return;
    }

    room.turn = 1;

    setTimeout(() => {
      const empty = room.board.map((v, i) => v === null ? i : -1).filter(i => i !== -1);
      if (empty.length === 0) return;

      let botMove = null;
      for (const i of empty) {
        const test = [...room.board];
        test[i] = 'O';
        if (checkWinner(test)?.winner === 'O') { botMove = i; break; }
      }
      if (botMove === null) {
        for (const i of empty) {
          const test = [...room.board];
          test[i] = 'X';
          if (checkWinner(test)?.winner === 'X') { botMove = i; break; }
        }
      }
      if (botMove === null) {
        botMove = empty[Math.floor(Math.random() * empty.length)];
      }

      room.board[botMove] = 'O';
      const botResult = checkWinner(room.board);
      if (botResult) {
        handleGameEnd(roomId, botResult.winner, room.board);
        return;
      }

      room.turn = 0;
      io.to(roomId).emit('update-board', { board: room.board, lastMove: botMove, nextTurn: socket.id });
    }, 400);
  });

  // --- RANDOM MATCH ---
  socket.on('matchmaking-join', () => {
    if (!checkAuth(socket)) return;
    const idx = waitingMatch.indexOf(socket.id);
    if (idx !== -1) return;

    if (waitingMatch.length > 0) {
      const opponentId = waitingMatch.shift();
      const roomId = 'MATCH-' + socket.id.substring(0, 4) + '-' + opponentId.substring(0, 4);

      rooms[roomId] = {
        players: [opponentId, socket.id],
        board: Array(9).fill(null),
        turn: 0,
        ready: {},
        marks: { [opponentId]: 'X', [socket.id]: 'O' },
        isBot: false,
        countdown: null
      };

      socket.join(roomId);
      io.sockets.sockets.get(opponentId)?.join(roomId);

      const p1Name = socketPlayers[opponentId]?.username || 'ผู้เล่น';
      const p2Name = socketPlayers[socket.id]?.username || 'ผู้เล่น';

      io.to(roomId).emit('match-found', {
        roomId,
        players: { [opponentId]: 'X', [socket.id]: 'O' },
        names: { [opponentId]: p1Name, [socket.id]: p2Name }
      });
    } else {
      waitingMatch.push(socket.id);
      socket.emit('matchmaking-waiting');
    }
  });

  socket.on('matchmaking-cancel', () => {
    const idx = waitingMatch.indexOf(socket.id);
    if (idx !== -1) waitingMatch.splice(idx, 1);
  });

  // --- CREATE ROOM ---
  socket.on('room-create', () => {
    if (!checkAuth(socket)) return;
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: [socket.id],
      board: Array(9).fill(null),
      turn: 0,
      ready: {},
      marks: { [socket.id]: 'X' },
      isBot: false,
      countdown: null
    };
    socket.join(roomId);
    socket.emit('room-created', { roomId });
  });

  socket.on('room-join', ({ roomId }) => {
    if (!checkAuth(socket)) return;
    const room = rooms[roomId];
    if (!room) { socket.emit('room-error', 'ไม่พบห้องนี้'); return; }
    if (room.players.length >= 2) { socket.emit('room-error', 'ห้องเต็มแล้ว'); return; }

    room.players.push(socket.id);
    room.marks[socket.id] = 'O';
    socket.join(roomId);

    const p1Name = socketPlayers[room.players[0]]?.username || 'ผู้เล่น';
    const p2Name = socketPlayers[socket.id]?.username || 'ผู้เล่น';

    io.to(roomId).emit('room-joined', {
      roomId,
      players: { [room.players[0]]: 'X', [socket.id]: 'O' },
      names: { [room.players[0]]: p1Name, [socket.id]: p2Name }
    });
  });

  // --- READY ---
  socket.on('player-ready', ({ roomId }) => {
    if (!checkAuth(socket)) return;
    const room = rooms[roomId];
    if (!room) return;
    room.ready[socket.id] = true;

    if (room.players.length === 2 && room.players.every(p => room.ready[p])) {
      let count = 5;
      io.to(roomId).emit('countdown', count);
      room.countdown = setInterval(() => {
        count--;
        if (count > 0) {
          io.to(roomId).emit('countdown', count);
        } else {
          clearInterval(room.countdown);
          room.countdown = null;
          io.to(roomId).emit('game-start', {
            roomId,
            players: room.marks,
            firstTurn: room.players[0]
          });
        }
      }, 1000);
    } else {
      io.to(roomId).emit('opponent-ready');
    }
  });

  // --- GAME MOVE ---
  socket.on('make-move', ({ roomId, index }) => {
    if (!checkAuth(socket)) return;
    const room = rooms[roomId];
    if (!room || room.board[index] !== null) return;
    if (room.players[room.turn] !== socket.id) return;

    const mark = room.marks[socket.id];
    room.board[index] = mark;

    const result = checkWinner(room.board);
    if (result) {
      handleGameEnd(roomId, result.winner, room.board);
      return;
    }

    room.turn = (room.turn + 1) % 2;
    const nextPlayer = room.players[room.turn];
    io.to(roomId).emit('update-board', { board: room.board, lastMove: index, nextTurn: nextPlayer });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    const idx = waitingMatch.indexOf(socket.id);
    if (idx !== -1) waitingMatch.splice(idx, 1);

    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players.includes(socket.id)) {
        if (room.countdown) clearInterval(room.countdown);
        io.to(roomId).emit('opponent-disconnected');
        delete rooms[roomId];
      }
    }
    delete socketPlayers[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`XO Game server running on http://localhost:${PORT}`);
});
