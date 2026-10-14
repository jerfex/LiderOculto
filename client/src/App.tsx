import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type Player = { id: string; name: string; pos: { x: number; y: number }; role: string; connected: boolean };
type AuthUser = { id: string; name: string };
type RoomUpdatePayload = { state: 'waiting' | 'playing' | 'ended'; hostUserId: string | null; settings: { rounds: number; roundSeconds: number; quorum: number }; players: Player[] };
type StateUpdatePayload = { round: number; liesLeft: number; question: { text: string } | null; players: Player[] };
type VoteResultPayload = { found: boolean; pos: { x: number; y: number } | null; reason?: string };
type GameEndPayload = { winner: 'investigators' | 'leader'; leaderPos: { x: number; y: number } | null };

type AuthResult = { ok: boolean; error?: string };

const ROLE_LABELS: Record<string, string> = {
  leader: 'Líder Oculto',
  investigator: 'Investigador',
  observer: 'Observador'
};

const DEFAULT_SETTINGS = { rounds: 8, roundSeconds: 45, quorum: 2 };

const VERSES = [
  '“E conhecereis a verdade, e a verdade vos libertará.” (Jo 8:32)',
  '“Confia no Senhor de todo o teu coração... Ele endireitará as tuas veredas.” (Pv 3:5-6)',
  '“Por isso deixai a mentira e falai a verdade cada um com o seu próximo.” (Ef 4:25)',
  '“Se algum de vocês precisa de sabedoria, peça a Deus... e lhe será concedida.” (Tg 1:5)'
];

const ENCOURAGEMENTS = [
  'Unidos discernimos melhor.',
  'Escute com carinho: cada pergunta pode revelar a verdade.',
  'Seja gentil até na suspeita: estamos juntos em Cristo.',
  'Mantenha a calma, investigue com sabedoria e amor.'
];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [user, setUser] = useState<AuthUser | null>(null);
  const api = import.meta.env.VITE_API_URL || 'http://localhost:3000';

  const fetchProfile = useCallback(async (authToken: string) => {
    const r = await fetch(`${api}/api/me`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!r.ok) throw new Error('invalid token');
    const data = (await r.json()) as AuthUser;
    setUser(data);
  }, [api]);

  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }
    fetchProfile(token).catch(() => {
      localStorage.removeItem('token');
      setToken(null);
      setUser(null);
    });
  }, [token, fetchProfile]);

  async function authenticate(path: 'login' | 'register', name: string, password: string): Promise<AuthResult> {
    const r = await fetch(`${api}/api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, password })
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.token) {
      localStorage.setItem('token', data.token);
      setToken(data.token);
      return { ok: true };
    }
    return { ok: false, error: data.error || 'Não foi possível autenticar.' };
  }

  return {
    token,
    user,
    api,
    async login(name: string, password: string) {
      return authenticate('login', name, password);
    },
    async register(name: string, password: string) {
      return authenticate('register', name, password);
    },
    logout() {
      localStorage.removeItem('token');
      setToken(null);
      setUser(null);
    }
  };
}

export default function App() {
  const { token, user, api, login, register, logout } = useAuth();
  const [stage, setStage] = useState<'auth' | 'lobby' | 'room'>(() => (token ? 'lobby' : 'auth'));
  const [roomCode, setRoomCode] = useState('');
  const [roomState, setRoomState] = useState<'waiting' | 'playing' | 'ended'>('waiting');
  const [players, setPlayers] = useState<Player[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [round, setRound] = useState(1);
  const [question, setQuestion] = useState('');
  const [liesLeft, setLiesLeft] = useState(3);
  const [voteOpen, setVoteOpen] = useState(false);
  const [voteResult, setVoteResult] = useState<VoteResultPayload | null>(null);
  const [gameResult, setGameResult] = useState<GameEndPayload | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [verse, setVerse] = useState(() => randomFrom(VERSES));
  const [encouragement, setEncouragement] = useState(() => randomFrom(ENCOURAGEMENTS));
  const socketRef = useRef<Socket | null>(null);

  const myRole = useMemo(() => players.find((p) => p.id === user?.id)?.role ?? null, [players, user]);
  const isHost = user?.id && hostId ? user.id === hostId : false;
  const investigatorsCount = useMemo(() => players.filter((p) => p.role !== 'observer').length, [players]);

  const resetMatchState = useCallback(() => {
    setRound(1);
    setQuestion('');
    setLiesLeft(3);
    setVoteOpen(false);
    setVoteResult(null);
    setGameResult(null);
    setStatusMessage(null);
    setVerse(randomFrom(VERSES));
    setEncouragement(randomFrom(ENCOURAGEMENTS));
  }, []);

  useEffect(() => {
    if (!token) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setStage('auth');
      setRoomCode('');
      setPlayers([]);
      setHostId(null);
      setSettings(DEFAULT_SETTINGS);
      setRoomState('waiting');
      resetMatchState();
    }
  }, [token, resetMatchState]);

  useEffect(() => {
    if (token && stage === 'auth') {
      setStage('lobby');
    }
  }, [token, stage]);

  useEffect(() => {
    if (!token || stage !== 'room' || !roomCode) return;
    const socket = io(api, { auth: { token } });
    socketRef.current = socket;

    socket.on('roomUpdate', (payload: RoomUpdatePayload) => {
      setPlayers(payload.players);
      setRoomState(payload.state);
      setSettings(payload.settings || DEFAULT_SETTINGS);
      setHostId(payload.hostUserId);
    });

    socket.on('stateUpdate', (payload: StateUpdatePayload) => {
      setRound(payload.round);
      setLiesLeft(payload.liesLeft);
      setPlayers(payload.players);
      setQuestion(payload.question?.text ?? '');
    });

    socket.on('question', ({ text }: { text: string }) => {
      setQuestion(text);
      setVoteOpen(false);
      setVoteResult(null);
      setStatusMessage('Pergunta lançada! Escutem com atenção.');
    });

    socket.on('answerGiven', ({ liesLeft: remaining }: { answer: boolean; liesLeft: number }) => {
      setLiesLeft(remaining);
      setVoteOpen(true);
      setStatusMessage('O líder respondeu. Agora votem na posição suspeita!');
    });

    socket.on('voteResult', (payload: VoteResultPayload) => {
      setVoteResult(payload);
      setVoteOpen(false);
      if (payload.reason === 'no-quorum') {
        setStatusMessage('Faltou quórum de votos nesta rodada. Organizem-se e tentem novamente.');
      } else if (payload.found) {
        setStatusMessage('Parabéns! Os investigadores localizaram o líder oculto.');
      } else {
        setStatusMessage('O líder escapou desta vez. Sigam firmes e sábios!');
      }
    });

    socket.on('newRound', ({ round: nextRound, liesLeft: remaining }: { round: number; liesLeft: number }) => {
      setRound(nextRound);
      setLiesLeft(remaining);
      setQuestion('');
      setVoteResult(null);
      setVoteOpen(false);
      setStatusMessage(`Nova rodada ${nextRound}. Continuem buscando a verdade!`);
      setVerse(randomFrom(VERSES));
      setEncouragement(randomFrom(ENCOURAGEMENTS));
    });

    socket.on('gameStarted', ({ round: startRound, liesLeft: remaining, roles, settings: startSettings }: { round: number; liesLeft: number; roles?: { userId: string; role: string }[]; settings?: { rounds: number; roundSeconds: number; quorum: number } }) => {
      setRoomState('playing');
      setRound(startRound);
      setLiesLeft(remaining);
      setVoteResult(null);
      setVoteOpen(false);
      setGameResult(null);
      setStatusMessage('Partida iniciada! Deus nos guia em toda verdade.');
      setVerse(randomFrom(VERSES));
      setEncouragement(randomFrom(ENCOURAGEMENTS));
      if (startSettings) setSettings(startSettings);
      if (roles) {
        setPlayers((prev) => prev.map((p) => {
          const match = roles.find((r) => r.userId === p.id);
          return match ? { ...p, role: match.role } : p;
        }));
      }
    });

    socket.on('gameEnd', (payload: GameEndPayload) => {
      setRoomState('ended');
      setGameResult(payload);
      setVoteOpen(false);
      setStatusMessage(payload.winner === 'investigators' ? 'Alegria! Os investigadores venceram.' : 'O líder oculto venceu desta vez. Perseverem!');
      setVerse(randomFrom(VERSES));
      setEncouragement(randomFrom(ENCOURAGEMENTS));
    });

    socket.emit('joinRoom', { roomId: roomCode });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [api, roomCode, stage, token]);

  const canAsk = roomState === 'playing' && myRole === 'investigator' && !question;
  const canAnswer = roomState === 'playing' && myRole === 'leader' && !!question && !voteOpen;
  const canVote = roomState === 'playing' && myRole !== 'observer' && voteOpen;
  const canStartMatch = Boolean(isHost && investigatorsCount >= 3 && roomState !== 'playing');

  async function handleCreateRoom() {
    if (!token) return;
    const r = await fetch(`${api}/api/rooms`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.roomId) {
      setStatusMessage(data.error || 'Não foi possível criar a sala.');
      return;
    }
    resetMatchState();
    setRoomCode(data.roomId);
    setStage('room');
    setRoomState('waiting');
    setStatusMessage('Sala criada! Compartilhe o código com sua célula.');
  }

  async function handleJoinRoom() {
    if (!token) return;
    const code = roomCode.trim().toUpperCase();
    if (!code) {
      setStatusMessage('Informe um código de sala.');
      return;
    }
    const r = await fetch(`${api}/api/rooms/${code}/join`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatusMessage(data.error || 'Não foi possível entrar na sala.');
      return;
    }
    resetMatchState();
    setRoomCode(code);
    setStage('room');
    setRoomState(data.state || 'waiting');
    setStatusMessage('Conectado! Aguarde o líder iniciar a partida.');
  }

  async function handleStartMatch() {
    if (!token || !roomCode) return;
    const r = await fetch(`${api}/api/rooms/${roomCode}/start`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatusMessage(data.error || 'Não foi possível iniciar a partida.');
      return;
    }
    setStatusMessage('Sorteando papéis... Preparem-se!');
  }

  function handleLeaveRoom() {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setStage('lobby');
    setRoomCode('');
    setPlayers([]);
    setHostId(null);
    setSettings(DEFAULT_SETTINGS);
    setRoomState('waiting');
    resetMatchState();
  }

  function handleMove(x: number, y: number) {
    if (!roomCode) return;
    socketRef.current?.emit('move', { roomId: roomCode, x, y });
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="max-w-6xl mx-auto p-4 space-y-4">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
          <div>
            <h1 className="text-3xl font-bold">Líder Oculto</h1>
            <p className="text-sm text-slate-600">Descubra onde está o líder escondido e celebre a verdade em comunidade.</p>
          </div>
          {user && (
            <div className="flex items-center gap-3 text-sm">
              <span>Bem-vindo, <strong>{user.name}</strong></span>
              <button className="text-slate-500 hover:text-slate-700 underline" onClick={logout}>Sair</button>
            </div>
          )}
        </header>

        {statusMessage && (
          <div className="p-3 rounded border border-amber-300 bg-amber-100 text-amber-900">
            {statusMessage}
          </div>
        )}

        {stage === 'auth' && <Auth onLogin={login} onRegister={register} />}

        {stage === 'lobby' && token && (
          <div className="bg-white rounded shadow p-4 space-y-4">
            <h2 className="text-xl font-semibold">Entrar em uma sala</h2>
            <div className="flex flex-col md:flex-row gap-2 md:items-center">
              <input
                className="border border-slate-300 rounded px-3 py-2 uppercase tracking-widest"
                placeholder="Código da sala"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              />
              <div className="flex gap-2">
                <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={handleJoinRoom}>Entrar</button>
                <button className="px-4 py-2 bg-emerald-600 text-white rounded" onClick={handleCreateRoom}>Criar sala</button>
              </div>
            </div>
            <p className="text-sm text-slate-500">Compartilhe o código com sua célula ou crie uma sala nova para iniciar um encontro.</p>
          </div>
        )}

        {stage === 'room' && (
          <div className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-2 space-y-4">
              <CanvasMap players={players} onClick={handleMove} highlightId={user?.id ?? undefined} disabled={!roomCode} />

              {voteResult && (
                <div className="bg-white rounded shadow p-4">
                  <h3 className="text-lg font-semibold">Resultado da votação</h3>
                  {voteResult.reason === 'no-quorum' ? (
                    <p className="text-sm text-slate-600">Quórum mínimo não atingido. Participem para que a verdade prevaleça!</p>
                  ) : voteResult.found ? (
                    <p className="text-sm text-emerald-600">O líder oculto foi encontrado na célula ({voteResult.pos?.x}, {voteResult.pos?.y}).</p>
                  ) : (
                    <p className="text-sm text-rose-600">O líder escapou na rodada {round}. Perseverem!</p>
                  )}
                </div>
              )}

              {gameResult && (
                <div className="bg-white rounded shadow p-4 space-y-2">
                  <h3 className="text-lg font-semibold">Fim da partida</h3>
                  <p className="text-sm">
                    {gameResult.winner === 'investigators'
                      ? 'Os investigadores celebram a vitória!'
                      : 'O líder oculto conseguiu enganar até o fim.'}
                  </p>
                  {gameResult.leaderPos && (
                    <p className="text-sm text-slate-600">Posição real do líder: ({gameResult.leaderPos.x}, {gameResult.leaderPos.y}).</p>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    <button className="px-4 py-2 bg-emerald-600 text-white rounded" onClick={handleStartMatch} disabled={!canStartMatch}>
                      Jogar novamente
                    </button>
                    <button className="px-4 py-2 bg-slate-200 text-slate-700 rounded" onClick={handleLeaveRoom}>
                      Voltar ao lobby
                    </button>
                  </div>
                  <p className="text-xs text-slate-500">Pronto para outra rodada? O host pode reiniciar quando estiverem prontos.</p>
                </div>
              )}
            </div>

            <aside className="space-y-4">
              <div className="bg-white rounded shadow p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Sala {roomCode}</h2>
                  <span className="text-xs font-semibold px-2 py-1 rounded bg-slate-100 text-slate-600 uppercase">{roomState}</span>
                </div>
                <p className="text-sm text-slate-600">Rodada {round} · Mentiras restantes: {liesLeft}</p>
                <p className="text-xs text-slate-500">Configuração padrão: {settings.rounds} rodadas · {settings.roundSeconds}s de votação · quórum {settings.quorum}.</p>
                <div className="flex gap-2 flex-wrap">
                  <button
                    className="px-3 py-2 bg-indigo-600 text-white rounded disabled:opacity-40"
                    onClick={handleStartMatch}
                    disabled={!canStartMatch}
                  >
                    {roomState === 'ended' ? 'Reiniciar partida' : 'Iniciar partida'}
                  </button>
                  <button className="px-3 py-2 bg-slate-200 text-slate-700 rounded" onClick={handleLeaveRoom}>Sair da sala</button>
                </div>
                <p className="text-xs text-slate-500">Necessários pelo menos 3 investigadores ativos para começar. ({investigatorsCount}/3)</p>
              </div>

              <div className="bg-white rounded shadow p-4 space-y-2">
                <h2 className="text-lg font-semibold">Jogadores</h2>
                <ul className="space-y-2 text-sm">
                  {players.map((p) => (
                    <li key={p.id} className="flex items-center justify-between">
                      <div>
                        <span className="font-medium">{p.name}</span>
                        {p.id === user?.id && <span className="text-xs text-emerald-600 ml-1">(você)</span>}
                        {p.id === hostId && <span className="text-xs text-indigo-600 ml-1">(host)</span>}
                        <div className="text-xs text-slate-500">{ROLE_LABELS[p.role] ?? p.role}</div>
                      </div>
                      <span className={`text-xs font-semibold ${p.connected ? 'text-emerald-600' : 'text-slate-400'}`}>
                        {p.connected ? 'online' : 'off'}
                      </span>
                    </li>
                  ))}
                  {players.length === 0 && <li className="text-xs text-slate-500">Nenhum jogador conectado ainda.</li>}
                </ul>
              </div>

              <div className="bg-white rounded shadow p-4 space-y-3">
                <h2 className="text-lg font-semibold">Pergunta &amp; resposta</h2>
                <AskAnswerPanel
                  roomId={roomCode}
                  socket={socketRef.current}
                  canAsk={canAsk}
                  canAnswer={canAnswer}
                  liesLeft={liesLeft}
                  question={question}
                />
                {question ? (
                  <div className="text-sm italic text-slate-600">Pergunta atual: “{question}”</div>
                ) : (
                  <div className="text-xs text-slate-500">Aguardando uma nova pergunta coletiva.</div>
                )}
              </div>

              <div className="bg-white rounded shadow p-4 space-y-3">
                <h2 className="text-lg font-semibold">Votação</h2>
                <VotePanel roomId={roomCode} socket={socketRef.current} canVote={canVote} disabledMessage={voteOpen ? undefined : 'Aguarde a resposta do líder para votar.'} />
                <p className="text-xs text-slate-500">Quórum mínimo: {settings.quorum} votos concordantes.</p>
              </div>

              <div className="bg-white rounded shadow p-4 space-y-2 text-sm">
                <p className="font-semibold text-indigo-700">Palavra de encorajamento</p>
                <p className="text-slate-600">{encouragement}</p>
                <p className="text-slate-500 border-t pt-2 text-xs">{verse}</p>
              </div>

              <div className="text-xs text-slate-500">
                Nota: o recurso de "mentira" é apenas lúdico dentro do jogo. Buscamos viver na verdade e em amor.
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function Auth({ onLogin, onRegister }: { onLogin: (n: string, p: string) => Promise<AuthResult>; onRegister: (n: string, p: string) => Promise<AuthResult> }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handle(action: 'login' | 'register') {
    if (!name || !password) {
      setError('Informe um nome e senha.');
      return;
    }
    const fn = action === 'login' ? onLogin : onRegister;
    const result = await fn(name, password);
    if (!result.ok) {
      setError(result.error || 'Não foi possível autenticar.');
    } else {
      setError(null);
    }
  }

  return (
    <div className="max-w-sm mx-auto bg-white rounded shadow p-4 space-y-3">
      <h2 className="text-xl font-semibold">Acesse sua conta</h2>
      <input
        className="border border-slate-300 rounded px-3 py-2 w-full"
        placeholder="Nome"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="border border-slate-300 rounded px-3 py-2 w-full"
        placeholder="Senha"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <div className="text-sm text-rose-600">{error}</div>}
      <div className="flex gap-2">
        <button className="flex-1 px-3 py-2 bg-blue-600 text-white rounded" onClick={() => handle('login')}>Entrar</button>
        <button className="flex-1 px-3 py-2 bg-emerald-600 text-white rounded" onClick={() => handle('register')}>Registrar</button>
      </div>
    </div>
  );
}

function CanvasMap({ players, onClick, highlightId, disabled }: { players: Player[]; onClick: (x: number, y: number) => void; highlightId?: string; disabled?: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const tile = 40;
  const cols = 12;
  const rows = 8;

  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cols * tile, rows * tile);
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 1;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath();
      ctx.moveTo(x * tile, 0);
      ctx.lineTo(x * tile, rows * tile);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * tile);
      ctx.lineTo(cols * tile, y * tile);
      ctx.stroke();
    }
    for (const p of players) {
      const cx = p.pos.x * tile + tile / 2;
      const cy = p.pos.y * tile + tile / 2;
      const color = p.role === 'leader' ? '#ef4444' : p.role === 'investigator' ? '#2563eb' : '#6b7280';
      ctx.save();
      ctx.globalAlpha = p.connected ? 1 : 0.4;
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(cx, cy, tile * 0.35, 0, Math.PI * 2);
      ctx.fill();
      if (highlightId && p.id === highlightId) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#f59e0b';
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.name[0]?.toUpperCase() || '?', cx, cy);
      ctx.restore();
    }
  }, [players, highlightId]);

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (disabled) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / tile);
    const y = Math.floor((e.clientY - rect.top) / tile);
    const clampedX = Math.max(0, Math.min(cols - 1, x));
    const clampedY = Math.max(0, Math.min(rows - 1, y));
    onClick(clampedX, clampedY);
  }

  return <canvas ref={ref} width={cols * tile} height={rows * tile} className="bg-white rounded shadow" onClick={handleClick} />;
}

function AskAnswerPanel({ roomId, socket, canAsk, canAnswer, liesLeft, question }: { roomId: string; socket: Socket | null; canAsk: boolean; canAnswer: boolean; liesLeft: number; question: string }) {
  const [text, setText] = useState('');
  const [useLie, setUseLie] = useState(false);

  function submitQuestion() {
    const trimmed = text.trim();
    if (!trimmed || !canAsk) return;
    socket?.emit('askQuestion', { roomId, text: trimmed });
    setText('');
  }

  function answer(value: boolean) {
    if (!canAnswer) return;
    socket?.emit('answer', { roomId, answer: value, useLie: useLie && liesLeft > 0 });
    setUseLie(false);
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-2">
        <label className="block text-xs uppercase tracking-wide text-slate-500">Pergunta coletiva</label>
        <div className="flex gap-2">
          <input
            className="flex-1 border border-slate-300 rounded px-3 py-2"
            placeholder="Pergunta sim/não"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!canAsk}
          />
          <button className="px-3 py-2 bg-indigo-600 text-white rounded disabled:opacity-40" onClick={submitQuestion} disabled={!canAsk}>
            Perguntar
          </button>
        </div>
        {!canAsk && <p className="text-xs text-slate-400">Aguarde o início da rodada ou a resposta anterior.</p>}
      </div>

      <div className="border-t pt-3 space-y-2">
        <label className="block text-xs uppercase tracking-wide text-slate-500">Resposta do líder</label>
        <div className="flex items-center gap-2">
          <button className="px-3 py-2 bg-emerald-600 text-white rounded disabled:opacity-40" onClick={() => answer(true)} disabled={!canAnswer}>
            Sim
          </button>
          <button className="px-3 py-2 bg-rose-600 text-white rounded disabled:opacity-40" onClick={() => answer(false)} disabled={!canAnswer}>
            Não
          </button>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            <input type="checkbox" checked={useLie} onChange={(e) => setUseLie(e.target.checked)} disabled={!canAnswer || liesLeft <= 0} />
            Usar ficha de mentira ({liesLeft})
          </label>
        </div>
        {!canAnswer && <p className="text-xs text-slate-400">Somente o líder pode responder quando uma pergunta estiver ativa.</p>}
      </div>
    </div>
  );
}

function VotePanel({ roomId, socket, canVote, disabledMessage }: { roomId: string; socket: Socket | null; canVote: boolean; disabledMessage?: string }) {
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);

  function submitVote() {
    if (!canVote) return;
    socket?.emit('voteCell', { roomId, x, y });
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <label className="text-xs text-slate-500">Coluna</label>
        <input
          type="number"
          min={0}
          max={11}
          className="w-16 border border-slate-300 rounded px-2 py-1"
          value={x}
          onChange={(e) => setX(Math.max(0, Math.min(11, Number(e.target.value) || 0)))}
        />
        <label className="text-xs text-slate-500">Linha</label>
        <input
          type="number"
          min={0}
          max={7}
          className="w-16 border border-slate-300 rounded px-2 py-1"
          value={y}
          onChange={(e) => setY(Math.max(0, Math.min(7, Number(e.target.value) || 0)))}
        />
        <button className="px-3 py-2 bg-emerald-600 text-white rounded disabled:opacity-40" onClick={submitVote} disabled={!canVote}>
          Votar
        </button>
      </div>
      {!canVote && <p className="text-xs text-slate-400">{disabledMessage || 'A votação estará disponível após a resposta do líder.'}</p>}
      {canVote && <p className="text-xs text-slate-500">Dica: conversem e votem na mesma célula para atingir o quórum.</p>}
    </div>
  );
}
