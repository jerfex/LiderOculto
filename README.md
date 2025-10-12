# Líder Oculto — Multiplayer (MVP)

Projeto full‑stack (Node.js/TypeScript + React/Tailwind) para um jogo social de dedução em células cristãs.

Tecnologias principais:
- Backend: Express, Socket.IO, Prisma (PostgreSQL), JWT, bcrypt, Zod, dotenv, CORS
- Frontend: React + TypeScript (Vite), Tailwind CSS, Socket.IO Client, Canvas 2D

Funcionalidades do MVP:
- Registro/login com JWT
- Criar e entrar em sala por link/código
- Iniciar partida e sortear Líder Oculto
- Rodadas com pergunta (sim/não), resposta do líder (com até 3 mentiras), votação por pluralidade com quórum
- Mapa 2D (12×8) com avatares simples
- Persistência em PostgreSQL (users, rooms, match, question/answer, votes)

## Como rodar

Pré‑requisitos:
- Node.js LTS
- PostgreSQL em localhost (ex.: usuário `root`, senha `123456`, DB `hidden_leader`)

1) Crie o banco no Postgres

2) Server: copie `server/.env.example` para `server/.env` e ajuste valores.

3) Instale dependências e rode migrations.

4) Start: backend e frontend (dev) em paralelo.

Veja detalhes em `server/README.md` e `client/README.md`.

> Nota temática: O recurso de "mentira" no jogo é puramente lúdico. Reforce a verdade em Cristo nas mensagens e versículos.