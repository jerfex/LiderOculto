import type { Server, Socket } from 'socket.io';
import { prisma } from './prisma';

type RoomState = {
  roomId: string;
  matchId: string;
  round: number;
  liesLeft: number;
  leaderUserId: string;
  voting: { [userId: string]: { x: number; y: number } };
  question?: { id: string; text: string };
  timers: { vote?: NodeJS.Timeout };
  settings: { rounds: number; roundSeconds: number; quorum: number };
};

const rooms: Record<string, RoomState> = {};

async function loadOrCreateRoomState(roomId: string): Promise<RoomState | null> {
  const match = await prisma.match.findFirst({ where: { roomId, endedAt: null }, orderBy: { id: 'desc' } });
  if (!match) return null;
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  const settings = (room?.settings as any) || { rounds: 8, roundSeconds: 45, quorum: 2 };
  const state: RoomState = {
    roomId,
    matchId: match.id,
    round: match.currentRound,
    liesLeft: match.liesLeft,
    leaderUserId: match.leaderUserId,
    voting: {},
    timers: {},
    settings
  };
  rooms[roomId] = state;
  return state;
}

function plurality<T>(vals: T[]): T | null {
  if (vals.length === 0) return null;
  const count = new Map<string, number>();
  for (const v of vals) {
    const k = JSON.stringify(v);
    count.set(k, (count.get(k) || 0) + 1);
  }
  let best: { k: string; n: number } | null = null;
  for (const [k, n] of count) {
    if (!best || n > best.n) best = { k, n };
  }
  return best ? (JSON.parse(best.k) as any) : null;
}

async function emitRoomUpdate(io: Server, roomId: string) {
  const players = await prisma.player.findMany({ where: { roomId }, include: { user: true } });
  io.to(roomId).emit('roomUpdate', {
    players: players.map((p) => ({ id: p.userId, name: p.user.name, pos: { x: p.posX, y: p.posY }, role: p.role, connected: p.connected })),
  });
}

export function socketHandlers(io: Server, socket: Socket) {
  const user = socket.data.user as { id: string; name: string };

  socket.on('joinRoom', async ({ roomId }: { roomId: string }) => {
    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room) return;
    socket.join(roomId);
    await prisma.player.updateMany({ where: { roomId, userId: user.id }, data: { connected: true } });
    await emitRoomUpdate(io, roomId);

    // send current game state if playing
    if (room.state !== 'playing') return;
    const state = rooms[roomId] || (await loadOrCreateRoomState(roomId));
    if (!state) return;
    io.to(socket.id).emit('stateUpdate', { round: state.round });
  });

  socket.on('askQuestion', async ({ roomId, text }: { roomId: string; text: string }) => {
    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room || room.state !== 'playing') return;
    const state = rooms[roomId] || (await loadOrCreateRoomState(roomId));
    if (!state) return;
    if (state.question) return; // already asked this round
    const q = await prisma.question.create({ data: { matchId: state.matchId, round: state.round, text, createdByUserId: user.id } });
    state.question = { id: q.id, text: q.text };
    io.to(roomId).emit('question', { text });
  });

  socket.on('answer', async ({ roomId, answer, useLie }: { roomId: string; answer: boolean; useLie?: boolean }) => {
    const state = rooms[roomId] || (await loadOrCreateRoomState(roomId));
    if (!state || user.id !== state.leaderUserId || !state.question) return;
    let usedLie = false;
    if (useLie && state.liesLeft > 0) {
      usedLie = true;
      state.liesLeft -= 1;
    }
    await prisma.answer.create({ data: { questionId: state.question.id, value: answer, usedLie } });
    await prisma.match.update({ where: { id: state.matchId }, data: { liesLeft: state.liesLeft } });
    io.to(roomId).emit('answerGiven', { answer, liesLeft: state.liesLeft });

    // start voting window
    state.voting = {};
    if (state.timers.vote) clearTimeout(state.timers.vote);
    state.timers.vote = setTimeout(() => finalizeVote(io, state).catch(() => {}), (state.settings.roundSeconds ?? 45) * 1000);
  });

  socket.on('voteCell', async ({ roomId, x, y }: { roomId: string; x: number; y: number }) => {
    const state = rooms[roomId] || (await loadOrCreateRoomState(roomId));
    if (!state || !state.question) return; // can only vote after answer
    state.voting[user.id] = { x, y };
    await prisma.vote.create({ data: { matchId: state.matchId, round: state.round, voterUserId: user.id, targetX: x, targetY: y } });
  });

  socket.on('move', async ({ roomId, x, y }: { roomId: string; x: number; y: number }) => {
    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room) return;
    // allow free move; rule enforcement can be tightened later
    await prisma.player.updateMany({ where: { roomId, userId: user.id }, data: { posX: x, posY: y } });
    await emitRoomUpdate(io, roomId);
  });

  socket.on('disconnect', async () => {
    // mark disconnected for all rooms
    await prisma.player.updateMany({ where: { userId: user.id }, data: { connected: false } });
  });
}

async function finalizeVote(io: Server, state: RoomState) {
  const roomId = state.roomId;
  const votes = Object.values(state.voting);
  const quorum = state.settings.quorum ?? 2;
  if (votes.length < quorum) {
    io.to(roomId).emit('voteResult', { found: false, pos: null, reason: 'no-quorum' });
    return nextRound(io, state);
  }
  const choice = plurality(votes)!; // not null because length>0

  const leader = await prisma.player.findFirst({ where: { roomId, userId: state.leaderUserId } });
  const found = leader && leader.posX === choice.x && leader.posY === choice.y;
  io.to(roomId).emit('voteResult', { found, pos: choice });

  if (found || state.round >= (state.settings.rounds ?? 8)) {
    await prisma.match.update({ where: { id: state.matchId }, data: { endedAt: new Date() } });
    io.to(roomId).emit('gameEnd', { winner: found ? 'investigators' : 'leader', leaderPos: leader ? { x: leader.posX, y: leader.posY } : null });
    delete rooms[roomId];
    await prisma.room.update({ where: { id: roomId }, data: { state: 'ended' } });
    return;
  }
  await nextRound(io, state);
}

async function nextRound(io: Server, state: RoomState) {
  state.round += 1;
  state.question = undefined;
  state.voting = {};
  await prisma.match.update({ where: { id: state.matchId }, data: { currentRound: state.round } });
  io.to(state.roomId).emit('newRound', { round: state.round, liesLeft: state.liesLeft });
}
