import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { authRouter } from './routes/auth';
import { roomsRouter } from './routes/rooms';
import { socketHandlers } from './socket';
import { setIoInstance } from './socketRegistry';

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*'}));

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use('/api', authRouter);
app.use('/api', roomsRouter);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.CORS_ORIGIN?.split(',') || '*' }
});

setIoInstance(io);

io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error('no auth token'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev');
    // @ts-ignore
    socket.data.user = payload;
    next();
  } catch (e) {
    next(new Error('invalid token'));
  }
});

io.on('connection', (socket) => socketHandlers(io, socket));

const PORT = Number(process.env.PORT || 3000);
httpServer.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
});
