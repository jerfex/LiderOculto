import { useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type Player = { id: string; name: string; pos: { x: number; y: number }; role: string; connected: boolean };

function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const api = import.meta.env.VITE_API_URL || 'http://localhost:3000';
  return {
    token,
    api,
    async register(name: string, password: string) {
      const r = await fetch(`${api}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) });
      const d = await r.json();
      if (d.token) { localStorage.setItem('token', d.token); setToken(d.token); }
      return d;
    },
    async login(name: string, password: string) {
      const r = await fetch(`${api}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) });
      const d = await r.json();
      if (d.token) { localStorage.setItem('token', d.token); setToken(d.token); }
      return d;
    },
    logout() { localStorage.removeItem('token'); setToken(null); }
  };
}

export default function App() {
  const { token, api, login, register, logout } = useAuth();
  const [stage, setStage] = useState<'auth'|'lobby'|'game'>(() => token ? 'lobby' : 'auth');
  const [roomId, setRoomId] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const socketRef = useRef<Socket|null>(null);
  const [round, setRound] = useState<number>(1);
  const [question, setQuestion] = useState<string>('');
  const [liesLeft, setLiesLeft] = useState<number>(3);

  useEffect(() => {
    if (!token || stage !== 'game') return;
    const s = io(api, { auth: { token } });
    socketRef.current = s;
    s.on('roomUpdate', (data) => setPlayers(data.players));
    s.on('question', ({ text }) => setQuestion(text));
    s.on('answerGiven', ({ answer, liesLeft }) => { setLiesLeft(liesLeft); });
    s.on('stateUpdate', ({ round }) => setRound(round));
    s.on('newRound', ({ round, liesLeft }) => { setRound(round); setLiesLeft(liesLeft); setQuestion(''); });
    s.on('voteResult', ({ found }) => {});
    s.on('gameEnd', ({ winner }) => alert(`Fim de jogo: ${winner}`));
    s.emit('joinRoom', { roomId });
    return () => { s.disconnect(); };
  }, [token, api, stage, roomId]);

  async function handleCreateRoom() {
    const r = await fetch(`${api}/api/rooms`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    setRoomId(d.roomId);
    setStage('game');
  }
  async function handleJoinRoom() {
    if (!roomId) return;
    await fetch(`${api}/api/rooms/${roomId}/join`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    setStage('game');
  }
  async function handleStart() {
    await fetch(`${api}/api/rooms/${roomId}/start`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  }

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <div className="max-w-4xl mx-auto p-4">
        <h1 className="text-2xl font-bold mb-4">Líder Oculto</h1>
        {stage === 'auth' && <Auth onLogin={login} onRegister={register} />}
        {stage === 'lobby' && token && (
          <div className="space-y-2">
            <div className="flex gap-2 items-center">
              <input className="border p-2 rounded" placeholder="Código da sala" value={roomId} onChange={e=>setRoomId(e.target.value.toUpperCase())} />
              <button className="px-3 py-2 bg-blue-600 text-white rounded" onClick={handleJoinRoom}>Entrar</button>
              <button className="px-3 py-2 bg-green-600 text-white rounded" onClick={handleCreateRoom}>Criar sala</button>
              <button className="ml-auto text-sm underline" onClick={logout}>Sair</button>
            </div>
          </div>
        )}
        {stage === 'game' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <CanvasMap players={players} onClick={(x,y)=> socketRef.current?.emit('move', { roomId, x, y }) } />
            </div>
            <div className="space-y-2">
              <div className="p-2 bg-white rounded shadow">Sala: <b>{roomId}</b> | Round: {round} | Mentiras: {liesLeft}</div>
              <div className="p-2 bg-white rounded shadow">
                <h2 className="font-semibold">Pergunta</h2>
                <AskAnswerPanel roomId={roomId} socket={socketRef.current} />
                {question && <div className="mt-2 text-sm italic">“{question}”</div>}
              </div>
              <div className="p-2 bg-white rounded shadow">
                <h2 className="font-semibold">Votar</h2>
                <VotePanel roomId={roomId} socket={socketRef.current} />
                <button className="mt-2 px-3 py-2 bg-amber-600 text-white rounded" onClick={handleStart}>Iniciar Partida</button>
              </div>
              <div className="text-xs text-gray-600">“E conhecereis a verdade, e a verdade vos libertará.” (Jo 8:32)</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Auth({ onLogin, onRegister }: { onLogin: (n:string,p:string)=>Promise<any>; onRegister: (n:string,p:string)=>Promise<any> }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="max-w-sm bg-white p-4 rounded shadow space-y-2">
      <input className="border p-2 rounded w-full" placeholder="Nome" value={name} onChange={e=>setName(e.target.value)} />
      <input className="border p-2 rounded w-full" placeholder="Senha" type="password" value={password} onChange={e=>setPassword(e.target.value)} />
      <div className="flex gap-2">
        <button className="px-3 py-2 bg-blue-600 text-white rounded" onClick={()=>onLogin(name,password)}>Entrar</button>
        <button className="px-3 py-2 bg-green-600 text-white rounded" onClick={()=>onRegister(name,password)}>Registrar</button>
      </div>
    </div>
  )
}

function CanvasMap({ players, onClick }: { players: Player[]; onClick: (x:number,y:number)=>void }) {
  const ref = useRef<HTMLCanvasElement|null>(null);
  const tile = 40; const cols = 12; const rows = 8;
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0,0,cols*tile,rows*tile);
    ctx.strokeStyle = '#ddd';
    for (let x=0;x<=cols;x++) { ctx.beginPath(); ctx.moveTo(x*tile,0); ctx.lineTo(x*tile,rows*tile); ctx.stroke(); }
    for (let y=0;y<=rows;y++) { ctx.beginPath(); ctx.moveTo(0,y*tile); ctx.lineTo(cols*tile,y*tile); ctx.stroke(); }
    for (const p of players) {
      const cx = p.pos.x*tile + tile/2;
      const cy = p.pos.y*tile + tile/2;
      ctx.beginPath(); ctx.fillStyle = p.role==='leader'?'#ef4444':'#3b82f6';
      ctx.arc(cx, cy, tile*0.35, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(p.name[0]?.toUpperCase()||'?', cx, cy);
    }
  }, [players]);
  function handleClick(e: React.MouseEvent) {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left)/tile); const y = Math.floor((e.clientY - rect.top)/tile);
    onClick(Math.max(0,Math.min(11,x)), Math.max(0,Math.min(7,y)));
  }
  return <canvas ref={ref} width={cols*tile} height={rows*tile} className="bg-white rounded shadow" onClick={handleClick}/>;
}

function AskAnswerPanel({ roomId, socket }: { roomId: string; socket: Socket|null }) {
  const [text, setText] = useState('');
  return (
    <div className="flex gap-2">
      <input className="border p-2 rounded w-full" placeholder="Pergunta sim/não" value={text} onChange={e=>setText(e.target.value)} />
      <button className="px-3 py-2 bg-indigo-600 text-white rounded" onClick={()=> socket?.emit('askQuestion', { roomId, text })}>Perguntar</button>
      <button className="px-3 py-2 bg-rose-600 text-white rounded" onClick={()=> socket?.emit('answer', { roomId, answer: true, useLie: false })}>Sim</button>
      <button className="px-3 py-2 bg-rose-700 text-white rounded" onClick={()=> socket?.emit('answer', { roomId, answer: false, useLie: true })}>Não (mentir)</button>
    </div>
  );
}

function VotePanel({ roomId, socket }: { roomId: string; socket: Socket|null }) {
  const [x, setX] = useState(0); const [y, setY] = useState(0);
  return (
    <div className="flex gap-2 items-center">
      <input type="number" min={0} max={11} className="border p-1 rounded w-16" value={x} onChange={e=>setX(parseInt(e.target.value||'0'))} />
      <input type="number" min={0} max={7} className="border p-1 rounded w-16" value={y} onChange={e=>setY(parseInt(e.target.value||'0'))} />
      <button className="px-3 py-2 bg-emerald-600 text-white rounded" onClick={()=> socket?.emit('voteCell', { roomId, x, y })}>Votar</button>
    </div>
  );
}
