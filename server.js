const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/health', (_, res) => res.json({ status: 'ok', game: 'Damn It!' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {};

function cardValue(rank) {
  if (rank === 'clown') return 0;
  if (['ten', 'prince', 'queen', 'king', 'ace'].includes(rank)) return 10;
  const map = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  return map[rank] || 0;
}

function handTotal(hand) {
  return hand.reduce((sum, c) => sum + cardValue(c.rank), 0);
}

function createFresh54Deck() {
  const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
  const ranks = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'prince', 'queen', 'king', 'ace'];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ id: `${rank}_${suit}`, suit, rank });
    }
  }
  deck.push({ id: 'clown_1', suit: 'clown', rank: 'clown' });
  deck.push({ id: 'clown_2', suit: 'clown', rank: 'clown' });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function replenishDeckIfNeeded(room) {
  if (room.drawDeck.length > 0 || room.floorPile.length <= 1) return;
  const topCard = room.floorPile.pop();
  room.drawDeck = [...room.floorPile];
  room.floorPile = [topCard];
  for (let i = room.drawDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.drawDeck[i], room.drawDeck[j]] = [room.drawDeck[j], room.drawDeck[i]];
  }
}

function nextSurvivingIndex(players, currentIdx) {
  let idx = (currentIdx + 1) % players.length;
  while (players[idx].lifeScore <= 0) {
    idx = (idx + 1) % players.length;
  }
  return idx;
}

function sanitizeRoomForPlayer(room, socketId) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    roundNumber: room.roundNumber,
    activePlayerIndex: room.activePlayerIndex,
    drawDeckCount: room.drawDeck.length,
    topFloorCard: room.floorPile.length > 0 ? room.floorPile[room.floorPile.length - 1] : null,
    floorCount: room.floorPile.length,
    previousFloorCardAvailable: room.previousFloorCardAvailable,
    lastRoundSummary: room.lastRoundSummary,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      lifeScore: p.lifeScore,
      cardCount: p.hand.length,
      eligibleToCallNextTurn: p.eligibleToCallNextTurn,
      hand: (p.id === socketId || room.phase === 'roundShowdown' || room.phase === 'matchOver') ? p.hand : []
    }))
  };
}

function broadcastRoom(room) {
  for (const p of room.players) {
    io.to(p.id).emit('room_state', sanitizeRoomForPlayer(room, p.id));
  }
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ playerName }) => {
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[code] = {
      code,
      hostId: socket.id,
      players: [{
        id: socket.id,
        name: playerName || 'Player 1',
        lifeScore: 101,
        hand: [],
        eligibleToCallNextTurn: false
      }],
      phase: 'lobby',
      roundNumber: 1,
      activePlayerIndex: 0,
      drawDeck: [],
      floorPile: [],
      previousFloorCardAvailable: null,
      lastRoundSummary: null
    };
    socket.join(code);
    broadcastRoom(rooms[code]);
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit('game_error', 'Room not found.');
    if (room.phase !== 'lobby') return socket.emit('game_error', 'Match already in progress.');
    if (room.players.length >= 8) return socket.emit('game_error', 'Room is full (max 8 players).');

    room.players.push({
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      lifeScore: 101,
      hand: [],
      eligibleToCallNextTurn: false
    });
    socket.join(code);
    broadcastRoom(room);
  });

  socket.on('start_match', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return socket.emit('game_error', 'Need at least 2 players.');

    room.activePlayerIndex = Math.floor(Math.random() * room.players.length);
    room.phase = 'selectingDealSize';
    room.roundNumber = 1;
    broadcastRoom(room);
  });

  socket.on('select_deal_size', ({ roomCode, cardsPerPlayer }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'selectingDealSize') return;
    if (room.players[room.activePlayerIndex].id !== socket.id) return;

    const survivors = room.players.filter(p => p.lifeScore > 0);
    if (cardsPerPlayer * survivors.length > 52) {
      return socket.emit('game_error', 'Not enough cards in 54-card deck for that deal size.');
    }

    room.drawDeck = createFresh54Deck();
    for (const p of room.players) {
      p.hand = [];
      p.eligibleToCallNextTurn = false;
      if (p.lifeScore > 0) {
        for (let i = 0; i < cardsPerPlayer; i++) {
          p.hand.push(room.drawDeck.pop());
        }
        p.eligibleToCallNextTurn = handTotal(p.hand) <= 5;
      }
    }
    room.floorPile = [room.drawDeck.pop()];
    room.phase = 'mustPlayCards';
    room.previousFloorCardAvailable = null;
    broadcastRoom(room);
  });

  socket.on('play_cards', ({ roomCode, cardIds }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'mustPlayCards') return;
    const player = room.players[room.activePlayerIndex];
    if (player.id !== socket.id) return;

    const selected = player.hand.filter(c => cardIds.includes(c.id));
    if (selected.length === 0 || selected.length !== cardIds.length) return;
    const rank = selected[0].rank;
    if (!selected.every(c => c.rank === rank)) {
      return socket.emit('game_error', 'All played cards must have the same rank.');
    }

    room.previousFloorCardAvailable = room.floorPile.length > 0 ? room.floorPile[room.floorPile.length - 1] : null;
    player.hand = player.hand.filter(c => !cardIds.includes(c.id));
    room.floorPile.push(...selected);
    room.phase = 'mustDrawCard';
    broadcastRoom(room);
  });

  socket.on('draw_card', ({ roomCode, fromFloor }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'mustDrawCard') return;
    const player = room.players[room.activePlayerIndex];
    if (player.id !== socket.id) return;

    if (fromFloor) {
      if (!room.previousFloorCardAvailable) return;
      room.floorPile = room.floorPile.filter(c => c.id !== room.previousFloorCardAvailable.id);
      player.hand.push(room.previousFloorCardAvailable);
    } else {
      replenishDeckIfNeeded(room);
      if (room.drawDeck.length === 0) return;
      player.hand.push(room.drawDeck.pop());
    }

    player.eligibleToCallNextTurn = handTotal(player.hand) <= 5;
    room.previousFloorCardAvailable = null;
    room.activePlayerIndex = nextSurvivingIndex(room.players, room.activePlayerIndex);
    room.phase = 'mustPlayCards';
    broadcastRoom(room);
  });

  socket.on('call_damn_it', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'mustPlayCards') return;
    const caller = room.players[room.activePlayerIndex];
    if (caller.id !== socket.id) return;
    const callerScore = handTotal(caller.hand);
    if (!caller.eligibleToCallNextTurn || callerScore > 5) return;

    const survivors = room.players.filter(p => p.lifeScore > 0);
    const opponents = survivors.filter(p => p.id !== caller.id);
    const handTotals = {};
    const deductions = {};
    survivors.forEach(p => {
      handTotals[p.id] = handTotal(p.hand);
      deductions[p.id] = 0;
    });

    const lowestOppScore = Math.min(...opponents.map(p => handTotals[p.id]));
    const callerWon = callerScore < lowestOppScore;
    let explanation = '';

    if (callerWon) {
      opponents.forEach(opp => {
        deductions[opp.id] = handTotals[opp.id];
        opp.lifeScore -= handTotals[opp.id];
      });
      explanation = `${caller.name} won with ${callerScore} pts! Opponents lose their remaining hand points.`;
    } else {
      const tied = opponents.filter(p => handTotals[p.id] === callerScore);
      if (tied.length > 0) {
        const tiedSum = tied.reduce((s, p) => s + handTotals[p.id], 0);
        const penalty = callerScore + tiedSum;
        deductions[caller.id] = penalty;
        caller.lifeScore -= penalty;
        explanation = `DRAW! ${caller.name} (${callerScore}) tied with ${tied.map(p => p.name).join(', ')}. Takes -${penalty} pts!`;
      } else {
        const lowestOpps = opponents.filter(p => handTotals[p.id] === lowestOppScore);
        const beatenSum = lowestOpps.reduce((s, p) => s + handTotals[p.id], 0);
        const penalty = callerScore + beatenSum;
        deductions[caller.id] = penalty;
        caller.lifeScore -= penalty;
        explanation = `CAUGHT! ${lowestOpps.map(p => p.name).join(', ')} had ${lowestOppScore} pts. ${caller.name} takes -${penalty} pts!`;
      }
    }

    room.lastRoundSummary = {
      callerId: caller.id,
      callerName: caller.name,
      callerWon,
      handTotals,
      pointsDeducted: deductions,
      explanation
    };

    const remaining = room.players.filter(p => p.lifeScore > 0);
    room.phase = remaining.length <= 1 ? 'matchOver' : 'roundShowdown';
    broadcastRoom(room);
  });

  socket.on('next_round', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'roundShowdown') return;
    if (room.hostId !== socket.id) return;

    let nextDealer = room.activePlayerIndex;
    if (room.lastRoundSummary && room.lastRoundSummary.callerWon) {
      const idx = room.players.findIndex(p => p.id === room.lastRoundSummary.callerId);
      if (idx !== -1 && room.players[idx].lifeScore > 0) nextDealer = idx;
    }
    if (room.players[nextDealer].lifeScore <= 0) {
      nextDealer = nextSurvivingIndex(room.players, nextDealer);
    }

    room.activePlayerIndex = nextDealer;
    room.roundNumber += 1;
    room.drawDeck = [];
    room.floorPile = [];
    room.phase = 'selectingDealSize';
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
          delete rooms[code];
        } else {
          if (room.hostId === socket.id) room.hostId = room.players[0].id;
          if (room.activePlayerIndex >= room.players.length) room.activePlayerIndex = 0;
          broadcastRoom(room);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Damn It! Server listening on port ${PORT}`));
