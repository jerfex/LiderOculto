import { Router } from 'express';
import { prisma } from '../prisma';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../middlewares/auth';

export const authRouter = Router();

const credsSchema = z.object({
  name: z.string().min(3).max(24),
  password: z.string().min(6).max(64)
});

authRouter.post('/register', async (req, res) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid payload' });
  const { name, password } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { name } });
  if (existing) return res.status(409).json({ error: 'name taken' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { name, passwordHash } });
  const token = jwt.sign({ id: user.id, name: user.name }, process.env.JWT_SECRET || 'dev', { expiresIn: '7d' });
  res.json({ token });
});

authRouter.post('/login', async (req, res) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid payload' });
  const { name, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { name } });
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ id: user.id, name: user.name }, process.env.JWT_SECRET || 'dev', { expiresIn: '7d' });
  res.json({ token });
});

authRouter.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  res.json({ id: user.id, name: user.name });
});
