import { Router } from 'express';
import { prisma } from '../prisma';
import { requireAuth, type AuthRequest } from '../middlewares/auth';
import { shortRoomId } from '../utils/id';

export const roomsRouter = Router();

roomsRouter.post('/rooms', requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const id = shortRoomId();
  const room = await prisma.room.create({ data: { id, hostUserId: user.id, state: 'waiting', settings: { rounds: 8, roundSeconds: 45, quorum: 2 } } });
  await prisma.player.create({ data: { roomId: room.id, userId: user.id, role: 'investigator' } });
  res.json({ roomId: room.id });
});

roomsRouter.post('/rooms/:roomId/join', requireAuth, async (req: AuthRequest, res) => {
  const { roomId } = req.params;
  const user = req.user!;
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) return res.status(404).json({ error: 'room not found' });
  const existing = await prisma.player.findFirst({ where: { roomId, userId: user.id } });
  if (!existing) {
    const role = room.state === 'waiting' ? 'investigator' : 'observer';
    await prisma.player.create({ data: { roomId, userId: user.id, role } });
  }
  res.json({ ok: true });
});

roomsRouter.post('/rooms/:roomId/start', requireAuth, async (req: AuthRequest, res) => {
  const { roomId } = req.params;
  const user = req.user!;
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) return res.status(404).json({ error: 'room not found' });
  if (room.hostUserId !== user.id) return res.status(403).json({ error: 'only host can start' });
  const players = await prisma.player.findMany({ where: { roomId } });
  const investigators = players.filter(p => p.role !== 'observer');
  if (investigators.length < 3) return res.status(400).json({ error: 'need at least 3 players' });
  // choose leader randomly
  const leaderIdx = Math.floor(Math.random() * investigators.length);
  const leader = investigators[leaderIdx];
  await prisma.$transaction([
    prisma.room.update({ where: { id: roomId }, data: { state: 'playing' } }),
    prisma.player.update({ where: { id: leader.id }, data: { role: 'leader' } }),
    prisma.match.create({ data: { roomId, leaderUserId: leader.userId, currentRound: 1, liesLeft: 3 } })
  ]);
  res.json({ ok: true });
});
