import { useEffect, useState } from 'react';
import { PRESET_DECKS } from '@mtg3d/cards';
import type { GameUpdate, JoinAck, RoomState } from '@mtg3d/protocol';
import { ask, loadSession, saveSession, socket } from './net';
import { Game } from './Game';

export function App() {
  const [connected, setConnected] = useState(socket.connected);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [update, setUpdate] = useState<GameUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      const session = loadSession();
      if (session) {
        void ask<JoinAck>('room:rejoin', session).then((r) => { if (!r.ok) saveSession(null); });
      }
    };
    const onDisconnect = () => { setConnected(false); };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('room:state', setRoom);
    socket.on('game:update', setUpdate);
    if (socket.connected) onConnect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room:state', setRoom);
      socket.off('game:update', setUpdate);
    };
  }, []);

  const leave = () => { saveSession(null); window.location.reload(); };

  return (
    <div className="app">
      <header className="topbar">
        <strong>mtg_3d</strong>
        <span className={connected ? 'ok' : 'warn'}>{connected ? 'Conectado' : 'Sin conexión…'}</span>
        {room && <span>Sala <code>{room.code}</code></span>}
        {room && <button className="link" onClick={leave}>Salir</button>}
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {!room && <Lobby onError={setError} />}
      {room && !update && <WaitingRoom room={room} onError={setError} />}
      {room && update && <Game room={room} update={update} onError={setError} />}
    </div>
  );
}

function Lobby({ onError }: { onError: (e: string | null) => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const join = async (event: 'room:create' | 'room:join') => {
    const r = await ask<JoinAck>(event, event === 'room:create' ? { name } : { name, code });
    if (!r.ok) { onError(r.error); return; }
    onError(null);
    saveSession({ code: r.code, token: r.token });
  };
  return (
    <main className="panel narrow">
      <h1>Partida entre amigos</h1>
      <label>Tu nombre <input value={name} onChange={(e) => { setName(e.target.value); }} maxLength={24} autoFocus /></label>
      <button disabled={!name.trim()} onClick={() => void join('room:create')}>Crear sala</button>
      <hr />
      <label>Código de invitación <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); }} maxLength={6} /></label>
      <button disabled={!name.trim() || code.trim().length !== 6} onClick={() => void join('room:join')}>Unirse</button>
    </main>
  );
}

function WaitingRoom({ room, onError }: { room: RoomState; onError: (e: string | null) => void }) {
  const names = Object.keys(PRESET_DECKS);
  const [deck, setDeck] = useState(names[0] ?? '');
  const me = room.seats[room.you];
  const opp = room.seats[room.you === 'p1' ? 'p2' : 'p1'];
  const choose = async () => {
    const r = await ask<{ ok: boolean; error?: string }>('room:deck', { deck: PRESET_DECKS[deck] });
    onError(r.ok ? null : (r.error ?? 'Error'));
  };
  return (
    <main className="panel narrow">
      <h1>Sala {room.code}</h1>
      <p>Pasa este código a tu amigo: <code className="big">{room.code}</code></p>
      <p>Rival: {opp ? `${opp.name}${opp.ready ? ' (listo)' : ''}` : 'esperando…'}</p>
      <label>Mazo
        <select value={deck} onChange={(e) => { setDeck(e.target.value); }} disabled={me?.ready}>
          {names.map((n) => <option key={n}>{n}</option>)}
        </select>
      </label>
      <button disabled={me?.ready} onClick={() => void choose()}>{me?.ready ? 'Listo, esperando al rival' : 'Elegir mazo'}</button>
    </main>
  );
}
