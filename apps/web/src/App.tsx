import { useEffect, useState } from 'react';
import { CARDS, PRESET_DECKS } from '@mtg3d/cards';
import type { GameUpdate, JoinAck, RoomState } from '@mtg3d/protocol';
import { P2P, ask, loadSession, saveSession, socket } from './net';
import { Game } from './Game';
import { DeckBuilder } from './DeckBuilder';
import { expandList, loadDecks } from './decks';
import { ManaPips } from './ManaPips';

/** ?sala=CODE in the address: an invitation link. */
const invitedCode = (): string => new URLSearchParams(window.location.search).get('sala')?.toUpperCase().slice(0, 6) ?? '';
const inviteLink = (code: string): string => `${window.location.origin}${window.location.pathname}?sala=${code}`;

export function App() {
  const [connected, setConnected] = useState(socket.connected);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [update, setUpdate] = useState<GameUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<'play' | 'decks'>('play');

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
    const onRoom = (r: RoomState) => {
      setRoom(r);
      if (r.status === 'waiting' || r.status === 'choosingDecks') setUpdate(null); // a new game is being set up
    };
    socket.on('room:state', onRoom);
    socket.on('game:update', setUpdate);
    if (socket.connected) onConnect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('room:state', onRoom);
      socket.off('game:update', setUpdate);
    };
  }, []);

  const leave = () => {
    if (update && !update.view.result && !confirm('¿Salir de la sala? La partida seguirá en marcha y podrás volver con el mismo código.')) return;
    saveSession(null);
    window.location.assign(window.location.pathname);
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark" aria-label="mtg_3d">mtg<span>_</span>3d</span>
        <nav aria-label="Secciones">
          <button className={`tab${screen === 'play' ? ' current' : ''}`} aria-current={screen === 'play' ? 'page' : undefined} onClick={() => { setScreen('play'); }}>Jugar</button>
          <button className={`tab${screen === 'decks' ? ' current' : ''}`} aria-current={screen === 'decks' ? 'page' : undefined} onClick={() => { setScreen('decks'); }}>Mis mazos</button>
        </nav>
        <span className="spacer" />
        {room && <span className="room-chip">Sala <code>{room.code}</code></span>}
        <span className={`link-state ${connected ? 'on' : 'off'}`} role="status">{connected ? (P2P ? 'Entre navegadores' : 'Conectado') : 'Reconectando…'}</span>
        {room && <button className="quiet" onClick={leave}>Salir</button>}
      </header>
      {error && <Toast text={error} onClose={() => { setError(null); }} />}
      {screen === 'decks' && <DeckBuilder />}
      {screen === 'play' && !room && <Lobby onError={setError} />}
      {screen === 'play' && room && !update && <WaitingRoom room={room} onError={setError} />}
      {screen === 'play' && room && update && <Game room={room} update={update} onError={setError} />}
    </div>
  );
}

/** Errors float over the page (they never push the table around) and fade after a few seconds. */
function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 7000); return () => { clearTimeout(t); }; }, [text, onClose]);
  return <p className="error toast" role="alert">{text} <button className="quiet" onClick={onClose} aria-label="Cerrar aviso">✕</button></p>;
}

function Lobby({ onError }: { onError: (e: string | null) => void }) {
  const [name, setName] = useState(() => { try { return localStorage.getItem('mtg3d.name') ?? ''; } catch { return ''; } });
  const [code, setCode] = useState(invitedCode);
  const [busy, setBusy] = useState(false);
  const join = async (event: 'room:create' | 'room:join') => {
    setBusy(true);
    try { localStorage.setItem('mtg3d.name', name.trim()); } catch { /* storage blocked */ }
    const r = await ask<JoinAck>(event, event === 'room:create' ? { name: name.trim() } : { name: name.trim(), code });
    setBusy(false);
    if (!r.ok) { onError(r.error); return; }
    onError(null);
    saveSession({ code: r.code, token: r.token });
  };
  const invited = invitedCode() !== '';
  return (
    <main className="lobby">
      <section className="lobby-intro">
        <div className="fan" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <span key={i} className="back" style={{ ['--i' as string]: i - 2 }} />)}</div>
        <h1>Partida entre amigos</h1>
        <p className="lede">{invited ? 'Te han invitado a una sala. Escribe tu nombre y entra.' : 'Crea una sala y pásale el código a tu amigo. Sin cuentas y sin instalar nada.'}</p>
        {P2P && <p className="aside">Quien crea la sala hace de anfitrión en su navegador: deja la pestaña abierta hasta terminar.</p>}
      </section>
      <form className="lobby-form" onSubmit={(e) => { e.preventDefault(); void join(invited || code.length === 6 ? 'room:join' : 'room:create'); }}>
        <label>Tu nombre <input value={name} onChange={(e) => { setName(e.target.value); }} maxLength={24} autoFocus autoComplete="nickname" /></label>
        {!invited && <button type="button" className="primary" disabled={!name.trim() || busy} onClick={() => void join('room:create')}>Crear sala</button>}
        {!invited && <p className="or">o únete a la de tu amigo</p>}
        <div className="join-row">
          <label>Código de invitación <input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); }} maxLength={6} autoComplete="off" spellCheck={false} className="code-input" /></label>
          <button type="button" className={invited ? 'primary' : ''} disabled={!name.trim() || code.length !== 6 || busy} onClick={() => void join('room:join')}>Unirse</button>
        </div>
      </form>
    </main>
  );
}

/** Colored mana symbols across a deck list (each W/U/B/R/G symbol counts). */
function deckColors(list: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of list) {
    const cost = CARDS.get(name)?.manaCost;
    for (const c of ['W', 'U', 'B', 'R', 'G'] as const) if (cost?.[c]) out[c] = (out[c] ?? 0) + cost[c];
  }
  return out;
}

function WaitingRoom({ room, onError }: { room: RoomState; onError: (e: string | null) => void }) {
  const options: Record<string, string[]> = { ...PRESET_DECKS };
  for (const d of loadDecks()) options[`Mío: ${d.name}`] = expandList(d.main);
  const names = Object.keys(options);
  const [deck, setDeck] = useState(names[0] ?? '');
  const [copied, setCopied] = useState(false);
  const me = room.seats[room.you];
  const opp = room.seats[room.you === 'p1' ? 'p2' : 'p1'];
  const list = options[deck] ?? [];
  const choose = async () => {
    const r = await ask<{ ok: boolean; error?: string }>('room:deck', { deck: list });
    onError(r.ok ? null : (r.error ?? 'No se pudo elegir el mazo.'));
  };
  const copy = () => {
    void navigator.clipboard.writeText(inviteLink(room.code)).then(() => { setCopied(true); setTimeout(() => { setCopied(false); }, 2000); }, () => { onError('No se pudo copiar: copia el código a mano.'); });
  };
  const seat = (who: string, s: RoomState['seats']['p1']) => (
    <div className={`seat${s?.ready ? ' ready' : ''}`}>
      <span className="seat-who">{who}</span>
      <span className="seat-name">{s?.name ?? 'Esperando…'}</span>
      <span className="seat-state">{!s ? 'Aún no ha entrado' : !s.connected ? 'Desconectado' : s.ready ? 'Listo para jugar' : 'Eligiendo mazo'}</span>
    </div>
  );
  return (
    <main className="waiting">
      <section className="invite">
        <h1>Sala <code className="big">{room.code}</code></h1>
        {!opp && <p className="lede">Pásale el código o el enlace a tu amigo. Entrará en esta misma sala.</p>}
        <button onClick={copy}>{copied ? 'Enlace copiado' : 'Copiar enlace de invitación'}</button>
      </section>
      <section className="seats" aria-label="Jugadores">
        {seat('Tú', me ?? null)}
        <span className="versus" aria-hidden="true">contra</span>
        {seat('Rival', opp ?? null)}
      </section>
      <section className="deck-pick">
        <label>Mazo
          <select value={deck} onChange={(e) => { setDeck(e.target.value); }} disabled={me?.ready}>
            {names.map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <p className="deck-facts"><span>{list.length} cartas</span> <ManaPips pool={deckColors(list)} /></p>
        <button className="primary" disabled={me?.ready} onClick={() => void choose()}>{me?.ready ? (opp?.ready ? 'Empezando…' : 'Listo: esperando al rival') : 'Elegir mazo'}</button>
      </section>
    </main>
  );
}
