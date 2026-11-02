import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CARDS } from '@mtg3d/cards';
import type { GameEvent, LegalAction, ManaType, ObjectId, PendingDecision, PlayerId, PlayerView, Response, Step, Target, VisibleObject } from '@mtg3d/engine';
import type { GameUpdate, RoomState } from '@mtg3d/protocol';
import { autopay } from './autopay';
import { ask, cardImage } from './net';
import { ManaPips } from './ManaPips';

// three.js is most of the bundle: load it only when the 3D table is shown.
const Table3D = lazy(() => import('./table/Table3D').then((m) => ({ default: m.Table3D })));
const webglAvailable = (): boolean => {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
};

/**
 * Clicking a card on the table (3D or 2D) talks to whichever decision panel is open: it plays or casts the card,
 * picks it as a target, attacker or blocker. Panels tell the table which cards to light up.
 */
interface TableLink {
  subscribe(fn: (id: ObjectId) => void): () => void;
  /** Cards the open panel can use now (gold) and cards already chosen (green); null = default highlights. */
  mark(offer: ObjectId[] | null, chosen: ObjectId[]): void;
}
const TableContext = createContext<TableLink>({ subscribe: () => () => undefined, mark: () => undefined });

function useTableClick(fn: (id: ObjectId) => void): void {
  const link = useContext(TableContext);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => link.subscribe((id) => { latest.current(id); }), [link]);
}

/** Lights up cards while a panel is open, and clears them when it closes. */
function useTableMarks(offer: ObjectId[] | null, chosen: ObjectId[]): void {
  const link = useContext(TableContext);
  const key = JSON.stringify([offer, chosen]);
  useEffect(() => { link.mark(offer, chosen); }, [link, key]); // keyed by content: callers pass fresh arrays each render
  useEffect(() => () => { link.mark(null, []); }, [link]);
}

const STEP_NAMES: Record<Step, string> = {
  untap: 'Enderezar', upkeep: 'Mantenimiento', draw: 'Robar', main1: 'Fase principal 1',
  beginCombat: 'Inicio del combate', declareAttackers: 'Declarar atacantes', declareBlockers: 'Declarar bloqueadores',
  combatDamage: 'Daño de combate', endCombat: 'Fin del combate', main2: 'Fase principal 2', end: 'Final', cleanup: 'Limpieza',
};

const DECISION_NAMES: Record<PendingDecision['kind'], string> = {
  chooseStartingPlayer: 'elegir quién empieza', mulligan: 'decidir el mulligan', bottomCards: 'poner cartas al fondo',
  priority: 'actuar', declareAttackers: 'declarar atacantes', declareBlockers: 'declarar bloqueadores',
  assignCombatDamage: 'repartir daño', discard: 'descartar', orderTriggers: 'ordenar sus habilidades', chooseTargets: 'elegir objetivos', legendRule: 'aplicar la regla de leyendas', searchLibrary: 'buscar en su biblioteca', surveil: 'vigilar',
};

interface Props { room: RoomState; update: GameUpdate; onError: (e: string | null) => void }

export function Game({ room, update, onError }: Props) {
  const view = update.view;
  const me = view.viewer;
  const opp: PlayerId = me === 'p1' ? 'p2' : 'p1';
  const nameOf = (p: PlayerId) => room.seats[p]?.name ?? p;
  const pending = view.pending;
  const mine = pending && pending.player === me ? (pending as PendingDecision) : null;

  // Remember every card name we have seen, so the log can name cards that already left play.
  const names = useRef(new Map<ObjectId, string>());
  for (const o of Object.values(view.objects)) names.current.set(o.id, o.card);
  for (const e of update.events) if (e.kind === 'zoneChange' && e.card) { names.current.set(e.from, e.card); names.current.set(e.to, e.card); }

  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    const lines = update.events.map((e) => describe(e, names.current, nameOf)).filter((l): l is string => l !== null);
    if (lines.length) setLog((old) => [...lines.reverse(), ...old].slice(0, 80));
  }, [update.version]); // one log entry per server update

  const send = async (response: Response) => {
    if (!mine) return;
    const r = await ask<{ ok: boolean; error?: string }>('game:input', { decisionId: mine.id, response });
    onError(r.ok ? null : (r.error ?? 'Error'));
  };

  const [mode, setMode] = useState<'3d' | '2d'>(() => {
    try { if (localStorage.getItem('mtg3d.table') === '2d') return '2d'; } catch { /* storage blocked */ }
    return webglAvailable() ? '3d' : '2d';
  });
  const switchMode = () => {
    const next = mode === '3d' ? '2d' : '3d';
    setMode(next);
    try { localStorage.setItem('mtg3d.table', next); } catch { /* storage blocked */ }
  };

  const listeners = useRef(new Set<(id: ObjectId) => void>());
  const [marks, setMarks] = useState<{ offer: ObjectId[] | null; chosen: ObjectId[] }>({ offer: null, chosen: [] });
  const link = useMemo<TableLink>(() => ({
    subscribe: (fn) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; },
    mark: (offer, chosen) => { setMarks({ offer, chosen }); },
  }), []);
  const onCardClick = (id: ObjectId) => { for (const fn of listeners.current) fn(id); };
  const usable = new Set(marks.offer ?? (mine?.kind === 'priority' ? usableActions(view, mine.legal).filter((a) => a.kind !== 'activateMana').map(subject) : []));
  const chosen = new Set(marks.chosen);

  const battlefield = (p: PlayerId) => view.zones.battlefield.map((id) => view.objects[id]).filter((o): o is VisibleObject => o?.controller === p);

  const hand = view.zones.hand.map((id) => view.objects[id]).filter((o): o is VisibleObject => !!o);
  const concede = () => { if (confirm('¿Conceder la partida? Tu rival gana.')) void ask('game:input', { concede: true }); };

  return (
    <TableContext.Provider value={link}>
    <main className={`game mode-${mode}`}>
      <PlayerBar view={view} p={opp} name={nameOf(opp)} active={view.turn.active === opp} away={room.seats[opp]?.connected === false} />
      <PhaseTrack view={view} whose={view.turn.active === me ? 'juegas tú' : `juega ${nameOf(view.turn.active)}`} />

      {!view.result && room.seats[opp]?.connected === false && (
        <p className="banner warn" role="status">{nameOf(opp)} se ha desconectado. Si no vuelve en 15 minutos, la partida será tuya.</p>
      )}
      {view.result && (
        <p className={`banner ${view.result.winner === me ? 'win' : 'loss'}`} role="status">
          {view.result.winner === null ? 'Empate.' : view.result.winner === me ? '¡Has ganado!' : `Ha ganado ${nameOf(view.result.winner)}.`}
          <button onClick={() => void ask('room:newGame', {})}>Nueva partida</button>
        </p>
      )}

      <section className="arena" aria-label="Mesa">
        {mode === '3d'
          ? <Suspense fallback={<div className="table3d loading"><p>Preparando la mesa…</p></div>}><Table3D view={view} events={update.events} usable={usable} selected={chosen} onCardClick={onCardClick} /></Suspense>
          : (<div className="table2d">
              <Zone title={`Campo de ${nameOf(opp)}`} cards={battlefield(opp)} selected={chosen} onClick={onCardClick} />
              <Zone title="Tu campo" cards={battlefield(me)} selected={chosen} onClick={onCardClick} />
              <Zone title="Tu mano" cards={hand} selected={chosen} onClick={onCardClick} />
              <div className="graveyards">
                {(['p1', 'p2'] as const).map((p) => (
                  <p key={p}><b>Cementerio de {p === me ? 'ti' : nameOf(p)}:</b> {view.zones.graveyard[p].map((id) => view.objects[id]?.card).join(', ') || 'vacío'}</p>
                ))}
                {view.zones.exile.length > 0 && <p><b>Exilio:</b> {view.zones.exile.map((id) => view.objects[id]?.card).join(', ')}</p>}
              </div>
            </div>)}
      </section>

      <section className="console">
        <div className="stack" aria-label="Pila">
          <h3>Pila</h3>
          {view.stack.length === 0 && <p className="muted">Vacía</p>}
          <ol>
            {[...view.stack].reverse().map((e) => (
              <li key={e.id} className={e.controller === me ? 'mine' : 'theirs'}>
                <b>{e.card}</b>{e.kind === 'ability' ? <span className="muted"> (habilidad)</span> : null}
                {e.targets.length > 0 && <span className="muted"> sobre {e.targets.map((t) => targetLabel(t, view, nameOf)).join(', ')}</span>}
              </li>
            ))}
          </ol>
        </div>
        <Decision view={view} mine={mine} pendingOther={pending && !mine ? pending : null} nameOf={nameOf} send={send} onError={onError} />
        <details className="log" open>
          <summary><h3>Registro</h3></summary>
          <ul>{log.map((l, i) => <li key={`${String(i)}-${l}`}>{l}</li>)}</ul>
        </details>
      </section>

      <PlayerBar view={view} p={me} name={`${nameOf(me)} (tú)`} active={view.turn.active === me}>
        <span className="controls">
          <FullControl room={room} />
          <button className="quiet" onClick={switchMode}>{mode === '3d' ? 'Mesa 2D' : 'Mesa 3D'}</button>
          {!view.result && <button className="quiet danger" onClick={concede}>Conceder</button>}
        </span>
      </PlayerBar>
    </main>
    </TableContext.Provider>
  );
}

const TRACK: [Step, string][] = [
  ['untap', 'Enderezar'], ['upkeep', 'Mantenimiento'], ['draw', 'Robar'], ['main1', 'Principal 1'],
  ['beginCombat', 'Combate'], ['declareAttackers', 'Atacantes'], ['declareBlockers', 'Bloqueadores'], ['combatDamage', 'Daño'], ['endCombat', 'Fin del combate'],
  ['main2', 'Principal 2'], ['end', 'Final'], ['cleanup', 'Limpieza'],
];
const COMBAT: ReadonlySet<Step> = new Set(['beginCombat', 'declareAttackers', 'declareBlockers', 'combatDamage', 'endCombat']);

/** The turn structure as on a playmat: the current step lit, the ones already done dimmed. */
function PhaseTrack({ view, whose }: { view: PlayerView; whose: string }) {
  const now = TRACK.findIndex(([s]) => s === view.turn.step);
  const current = useRef<HTMLLIElement>(null);
  useEffect(() => { current.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); }, [now]);
  return (
    <nav className="status phase-track" aria-label="Fases del turno">
      {view.turn.number === 0 ? <span className="turn"><b>Antes de empezar:</b> <span>quién empieza y manos iniciales</span></span> : <>
      <span className="turn"><b>Turno {view.turn.number}:</b> <span>{whose}</span></span>
      <ol>
        {TRACK.map(([step, short], i) => (
          <li key={step} ref={i === now ? current : undefined} className={`${i < now ? 'done' : i === now ? 'now' : ''}${COMBAT.has(step) ? ' combat' : ''}`} aria-current={i === now ? 'step' : undefined}>
            {i === now ? STEP_NAMES[step] : short}
          </li>
        ))}
      </ol></>}
    </nav>
  );
}

function FullControl({ room }: { room: RoomState }) {
  return (
    <label className="inline" title="Sin auto-pase: recibes la prioridad en todos los pasos">
      <input type="checkbox" checked={room.fullControl} onChange={(e) => void ask('room:settings', { fullControl: e.target.checked })} /> Control total
    </label>
  );
}

function PlayerBar({ view, p, name, active, away, children }: { view: PlayerView; p: PlayerId; name: string; active: boolean; away?: boolean; children?: React.ReactNode }) {
  const pl = view.players[p];
  return (
    <section className={`playerbar${active ? ' active' : ''}${p === view.viewer ? ' me' : ' them'}`} aria-label={name}>
      <span className="who">{name}{away && <span className="away"> desconectado</span>}</span>
      <span className="life" aria-label={`${String(pl.life)} vidas`}>{pl.life}</span>
      <span className="count">Mano <b>{pl.handSize}</b></span>
      <span className="count">Biblioteca <b>{pl.librarySize}</b></span>
      <ManaPips pool={pl.manaPool} />
      {children}
    </section>
  );
}

export function CardView({ o, selected, onClick }: { o: VisibleObject; selected?: boolean; onClick?: () => void }) {
  const [broken, setBroken] = useState(false);
  const isCreature = o.types.includes('Creature');
  return (
    <button className={`card${o.tapped ? ' tapped' : ''}${selected ? ' selected' : ''}`} onClick={onClick} disabled={!onClick} title={o.card}>
      <span className="card-text">{o.card}</span>
      {!broken && <img src={cardImage(o.card)} alt={o.card} loading="lazy" onError={() => { setBroken(true); }} />}
      {o.zone === 'battlefield' && isCreature && <span className="pt">{o.power}/{o.toughness}{o.damage > 0 ? ` (−${String(o.damage)})` : ''}</span>}
      {o.zone === 'battlefield' && isCreature && o.summoningSick && <span className="sick">mareada</span>}
      {o.zone === 'battlefield' && o.types.includes('Planeswalker') && <span className="pt">◆ {o.loyalty}</span>}
      {o.otherCounters.quest !== undefined && <span className="sick">misión {o.otherCounters.quest}</span>}
    </button>
  );
}

function Zone({ title, cards, selected, onClick }: { title: string; cards: VisibleObject[]; selected?: Set<ObjectId>; onClick?: (id: ObjectId) => void }) {
  return (
    <section className="zone">
      <h3>{title}</h3>
      <div className="cards">
        {cards.length === 0 && <span className="muted">—</span>}
        {cards.map((o) => <CardView key={o.id} o={o} selected={selected?.has(o.id) ?? false} {...(onClick && { onClick: () => { onClick(o.id); } })} />)}
      </div>
    </section>
  );
}

interface DecisionProps {
  view: PlayerView;
  mine: PendingDecision | null;
  pendingOther: PlayerView['pending'];
  nameOf: (p: PlayerId) => string;
  send: (r: Response) => Promise<void>;
  onError: (e: string | null) => void;
}

function Decision({ view, mine, pendingOther, nameOf, send, onError }: DecisionProps) {
  if (view.result) return <div className="decision" />;
  if (!mine) {
    return <div className="decision"><p className="muted">{pendingOther ? `Esperando a ${nameOf(pendingOther.player)}: ${DECISION_NAMES[pendingOther.kind]}…` : '…'}</p></div>;
  }
  return <div className="decision"><MyDecision key={mine.id} view={view} d={mine} nameOf={nameOf} send={send} onError={onError} /></div>;
}

function MyDecision({ view, d, nameOf, send, onError }: { view: PlayerView; d: PendingDecision; nameOf: (p: PlayerId) => string; send: (r: Response) => Promise<void>; onError: (e: string | null) => void }) {
  const [picked, setPicked] = useState<Set<ObjectId>>(new Set());
  const toggle = (id: ObjectId) => { setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const hand = view.zones.hand.map((id) => view.objects[id]).filter((o): o is VisibleObject => !!o);

  switch (d.kind) {
    case 'chooseStartingPlayer':
      return (<>
        <h3>¿Quién empieza?</h3>
        <button onClick={() => void send({ kind: 'chooseStartingPlayer', first: view.viewer })}>Empiezo yo</button>
        <button onClick={() => void send({ kind: 'chooseStartingPlayer', first: view.viewer === 'p1' ? 'p2' : 'p1' })}>Empieza el rival</button>
      </>);
    case 'mulligan':
      return (<>
        <h3>Mano inicial{d.mulligans > 0 ? ` (mulligan ${String(d.mulligans)})` : ''}</h3>
        <p>Tu mano está en la mesa. Con mulligan robas siete nuevas y, al quedártela, pones {d.mulligans + 1 === 1 ? 'una carta' : `${String(d.mulligans + 1)} cartas`} al fondo.</p>
        <button onClick={() => void send({ kind: 'keep' })}>Quedármela</button>
        <button onClick={() => void send({ kind: 'mulligan' })}>Mulligan</button>
      </>);
    case 'bottomCards':
    case 'discard':
      return (<>
        <h3>{d.kind === 'discard' ? `Descarta ${String(d.count)}` : `Pon ${String(d.count)} al fondo de la biblioteca`}</h3>
        <Zone title="Elige en tu mano" cards={hand} selected={picked} onClick={toggle} />
        <button disabled={picked.size !== d.count} onClick={() => void send({ kind: d.kind, cards: [...picked] })}>Confirmar</button>
      </>);
    case 'declareAttackers':
      return <Attackers view={view} d={d} send={send} nameOf={nameOf} />;
    case 'declareBlockers':
      return <Blockers view={view} d={d} send={send} />;
    case 'assignCombatDamage':
      return <DamageSplit view={view} d={d} send={send} />;
    case 'priority':
      return <Priority view={view} d={d} nameOf={nameOf} send={send} onError={onError} />;
    case 'orderTriggers':
      return <OrderTriggers d={d} send={send} />;
    case 'legendRule':
      return (<>
        <h3>Regla de leyendas: quédate con un {d.name}</h3>
        <Zone title="Elige cuál conservar" cards={d.candidates.map((id) => view.objects[id]).filter((o): o is VisibleObject => !!o)} onClick={(id) => void send({ kind: 'legendRule', keep: id })} />
      </>);
    case 'surveil':
      return <Surveil d={d} send={send} />;
    case 'searchLibrary':
      return (<>
        <h3>{d.source}: busca en tu biblioteca</h3>
        <div className="actions">
          {d.cards.map((card) => <button key={card} onClick={() => void send({ kind: 'searchLibrary', card })}>{card}</button>)}
        </div>
        <button className="link" onClick={() => void send({ kind: 'searchLibrary', card: null })}>No coger ninguna</button>
      </>);
    case 'chooseTargets':
      return (<>
        <h3>{d.card}: elige objetivo</h3>
        <TargetPicker options={d.targetOptions} view={view} nameOf={nameOf} optional={d.optional === true} onDone={(targets) => void send({ kind: 'chooseTargets', targets })} />
      </>);
  }
}

/** Picks one target per slot, then calls onDone with all of them. */
/** 701.25: choose which top cards go to the graveyard; the rest go back on top in the order shown (topmost first). */
function Surveil({ d, send }: { d: Extract<PendingDecision, { kind: 'surveil' }>; send: (r: Response) => Promise<void> }) {
  const [order, setOrder] = useState(() => d.cards.map((_, i) => i));
  const [binned, setBinned] = useState<Set<number>>(new Set());
  const move = (k: number) => { const next = [...order]; [next[k - 1], next[k]] = [next[k] as number, next[k - 1] as number]; setOrder(next); };
  return (<>
    <h3>{d.source}: vigila {d.cards.length}</h3>
    <p className="muted">Marca las que van al cementerio; el resto vuelve arriba en este orden (la primera queda encima).</p>
    {order.map((i, k) => (
      <div key={i} className="row">
        <label className="inline"><input type="checkbox" checked={binned.has(i)} onChange={(e) => { const next = new Set(binned); if (e.target.checked) next.add(i); else next.delete(i); setBinned(next); }} />{d.cards[i]}</label>
        {k > 0 && <button onClick={() => { move(k); }} aria-label={`Subir ${d.cards[i] ?? ''}`}>↑</button>}
      </div>
    ))}
    <button className="primary" onClick={() => void send({ kind: 'surveil', graveyard: [...binned], top: order.filter((i) => !binned.has(i)) })}>Confirmar</button>
  </>);
}

/** Crew (702.122): pick untapped creatures with enough total power. */
function CrewPicker({ view, vehicle, need, onDone, onCancel }: { view: PlayerView; vehicle: ObjectId; need: number; onDone: (crew: ObjectId[]) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<Set<ObjectId>>(new Set());
  const options = view.zones.battlefield.map((id) => view.objects[id]).filter((o): o is VisibleObject => !!o && o.controller === view.viewer && !o.tapped && o.id !== vehicle && o.types.includes('Creature'));
  const total = [...picked].reduce((n, id) => n + Math.max(0, view.objects[id]?.power ?? 0), 0);
  const toggle = (id: ObjectId) => { const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id); setPicked(next); };
  return (<>
    <h3>Tripular {need}: elige criaturas (fuerza {total}/{need})</h3>
    <Zone title="Tus criaturas enderezadas" cards={options} selected={picked} onClick={toggle} />
    <button className="primary" disabled={total < need} onClick={() => { onDone([...picked]); }}>Tripular</button>
    <button className="link" onClick={onCancel}>Cancelar</button>
  </>);
}

function TargetPicker({ options, view, nameOf, onDone, onCancel, optional }: { options: Target[][]; view: PlayerView; nameOf: (p: PlayerId) => string; onDone: (t: Target[]) => void; onCancel?: () => void; optional?: boolean }) {
  const [chosen, setChosen] = useState<Target[]>([]);
  const slot = options[chosen.length] ?? [];
  const pick = (t: Target) => {
    const next = [...chosen, t];
    if (next.length === options.length) onDone(next); else setChosen(next);
  };
  const objects = slot.flatMap((t) => (t.kind === 'object' ? [t.id] : []));
  useTableMarks(objects, []);
  useTableClick((id) => { const t = slot.find((x) => x.kind === 'object' && x.id === id); if (t) pick(t); });
  return (<>
    {options.length > 1 && <p className="muted">Objetivo {chosen.length + 1} de {options.length}</p>}
    {slot.map((t) => (
      <button key={JSON.stringify(t)} onClick={() => { pick(t); }}>{targetLabel(t, view, nameOf)}</button>
    ))}
    {optional && chosen.length === 0 && <button className="link" onClick={() => { onDone([]); }}>Sin objetivo</button>}
    {onCancel && <button className="link" onClick={onCancel}>Cancelar</button>}
  </>);
}

function OrderTriggers({ d, send }: { d: Extract<PendingDecision, { kind: 'orderTriggers' }>; send: (r: Response) => Promise<void> }) {
  const [order, setOrder] = useState<string[]>([]);
  return (<>
    <h3>Ordena tus habilidades disparadas</h3>
    <p className="muted">Pulsa en el orden en que quieres que se resuelvan (la primera se resuelve antes).</p>
    {d.triggers.map((t) => (
      <button key={t.id} disabled={order.includes(t.id)} onClick={() => { setOrder([...order, t.id]); }}>
        {order.includes(t.id) ? `${String(order.indexOf(t.id) + 1)}. ` : ''}{t.card}
      </button>
    ))}
    <button className="primary" disabled={order.length !== d.triggers.length} onClick={() => void send({ kind: 'orderTriggers', order })}>Confirmar</button>
    <button className="link" onClick={() => { setOrder([]); }}>Reiniciar</button>
  </>);
}

function Attackers({ view, d, send, nameOf }: { view: PlayerView; d: Extract<PendingDecision, { kind: 'declareAttackers' }>; send: (r: Response) => Promise<void>; nameOf: (p: PlayerId) => string }) {
  const [picked, setPicked] = useState<Set<ObjectId>>(new Set());
  const [aims, setAims] = useState<Record<ObjectId, ObjectId>>({});
  const toggle = (id: ObjectId) => { setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const opp = nameOf(view.viewer === 'p1' ? 'p2' : 'p1');
  useTableMarks(d.candidates, [...picked]);
  useTableClick((id) => { if (d.candidates.includes(id)) toggle(id); });
  return (<>
    <h3>Elige atacantes</h3>
    <p className="muted">Toca tus criaturas en la mesa o aquí abajo.</p>
    <Zone title="Puedes atacar con" cards={d.candidates.map((id) => view.objects[id]).filter((o): o is VisibleObject => !!o)} selected={picked} onClick={toggle} />
    {d.planeswalkers.length > 0 && [...picked].map((a) => (
      <label key={a} className="row">{view.objects[a]?.card} ataca a
        <select value={aims[a] ?? ''} onChange={(e) => { const next = { ...aims }; if (e.target.value) next[a] = e.target.value; else Reflect.deleteProperty(next, a); setAims(next); }}>
          <option value="">{opp}</option>
          {d.planeswalkers.map((pw) => <option key={pw} value={pw}>{view.objects[pw]?.card}</option>)}
        </select>
      </label>
    ))}
    <button onClick={() => void send({ kind: 'declareAttackers', attackers: [...picked], planeswalkerTargets: Object.fromEntries(Object.entries(aims).filter(([a]) => picked.has(a))) })}>
      {picked.size ? `Atacar con ${String(picked.size)}` : 'No atacar'}
    </button>
  </>);
}

function Blockers({ view, d, send }: { view: PlayerView; d: Extract<PendingDecision, { kind: 'declareBlockers' }>; send: (r: Response) => Promise<void> }) {
  const [blocks, setBlocks] = useState<Record<ObjectId, ObjectId>>({});
  const [armed, setArmed] = useState<ObjectId | null>(null);
  const card = (id: ObjectId) => view.objects[id]?.card ?? id;
  const blockers = d.candidates.map((c) => c.blocker);
  useTableMarks(armed ? d.candidates.find((c) => c.blocker === armed)?.attackers ?? [] : blockers, [...Object.keys(blocks).filter((b) => blocks[b]), ...(armed ? [armed] : [])]);
  // Tap one of your creatures, then the attacker it blocks; tap an assigned blocker again to take it back.
  useTableClick((id) => {
    if (armed && d.candidates.find((c) => c.blocker === armed)?.attackers.includes(id)) { setBlocks({ ...blocks, [armed]: id }); setArmed(null); return; }
    if (!blockers.includes(id)) return;
    if (blocks[id]) { setBlocks({ ...blocks, [id]: '' }); return; }
    setArmed(armed === id ? null : id);
  });
  return (<>
    <h3>Declara bloqueadores</h3>
    <p className="muted">{armed ? `${card(armed)}: toca el atacante que bloquea.` : 'Toca una criatura tuya en la mesa y después el atacante, o usa las listas.'}</p>
    {d.candidates.map((c) => (
      <label key={c.blocker} className="row">{card(c.blocker)} bloquea a
        <select value={blocks[c.blocker] ?? ''} onChange={(e) => { setBlocks({ ...blocks, [c.blocker]: e.target.value }); }}>
          <option value="">— nadie —</option>
          {c.attackers.map((a) => <option key={a} value={a}>{card(a)}</option>)}
        </select>
      </label>
    ))}
    <button onClick={() => void send({ kind: 'declareBlockers', blocks: Object.entries(blocks).filter(([, a]) => a).map(([blocker, attacker]) => ({ blocker, attacker })) })}>Confirmar bloqueos</button>
  </>);
}

function DamageSplit({ view, d, send }: { view: PlayerView; d: Extract<PendingDecision, { kind: 'assignCombatDamage' }>; send: (r: Response) => Promise<void> }) {
  // Default: lethal to each blocker in order, the rest to the defending player when trampling (or to the first blocker).
  const [split, setSplit] = useState<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    let left = d.amount;
    for (const b of d.blockers) { const n = Math.min(left, d.lethal[b] ?? 0); out[b] = n; left -= n; }
    if (d.trample) out.player = left;
    else if (d.blockers[0]) out[d.blockers[0]] = (out[d.blockers[0]] ?? 0) + left;
    return out;
  });
  const total = Object.values(split).reduce((a, b) => a + b, 0);
  const keys = [...d.blockers, ...(d.trample ? ['player'] : [])];
  return (<>
    <h3>Reparte {d.amount} de daño de {view.objects[d.attacker]?.card}</h3>
    {d.trample && <p className="muted">Arrollar: asigna daño letal a cada bloqueador antes de pasar el resto al jugador.</p>}
    {keys.map((k) => (
      <label key={k} className="row">{k === 'player' ? 'Jugador defensor' : `${view.objects[k]?.card ?? k} (letal: ${String(d.lethal[k] ?? 0)})`}
        <input type="number" min={0} max={d.amount} value={split[k] ?? 0} onChange={(e) => { setSplit({ ...split, [k]: Math.max(0, Math.floor(Number(e.target.value))) }); }} />
      </label>
    ))}
    <button disabled={total !== d.amount} onClick={() => void send({ kind: 'assignCombatDamage', assignment: split })}>Confirmar ({total}/{d.amount})</button>
  </>);
}

type Targeted = Extract<LegalAction, { kind: 'cast' | 'activate' }>;

const subject = (a: LegalAction) => (a.kind === 'activateMana' || a.kind === 'activate' ? a.source : a.card);

/** The automatic payment for a spell or ability, or null if the available mana cannot pay it. */
function paymentFor(view: PlayerView, legal: LegalAction[], a: Targeted): ObjectId[] | null {
  const sources = legal.flatMap((l) => (l.kind === 'activateMana' ? [l.source] : []));
  const cardOf = (id: ObjectId) => view.objects[id]?.card ?? '';
  if (a.kind === 'cast') return autopay(view, CARDS, sources, a.cost);
  // A {T} ability cannot tap its own source for mana.
  const ab = CARDS.get(cardOf(a.source))?.activated?.[a.ability];
  return autopay(view, CARDS, ab?.cost.tap ? sources.filter((x) => x !== a.source) : sources, ab?.cost.mana ?? null);
}

/** Legal actions the player can afford right now: the ones offered as buttons and highlighted on the table. */
function usableActions(view: PlayerView, legal: LegalAction[]): LegalAction[] {
  return legal.filter((a) => a.kind === 'playLand' || a.kind === 'activateMana' || paymentFor(view, legal, a) !== null);
}

function Priority({ view, d, nameOf, send, onError }: { view: PlayerView; d: Extract<PendingDecision, { kind: 'priority' }>; nameOf: (p: PlayerId) => string; send: (r: Response) => Promise<void>; onError: (e: string | null) => void }) {
  const [pending, setPending] = useState<Targeted | null>(null);
  const cardOf = (id: ObjectId) => view.objects[id]?.card ?? '';
  const payment = (a: Targeted) => paymentFor(view, d.legal, a);

  const [crewing, setCrewing] = useState<Extract<LegalAction, { kind: 'activate' }> | null>(null);
  const crewNeed = (a: LegalAction) => (a.kind === 'activate' ? CARDS.get(cardOf(a.source))?.activated?.[a.ability]?.cost.crew : undefined);

  const finish = (a: Targeted, targets: Target[], crew?: ObjectId[]) => {
    const pay = payment(a);
    if (!pay) { onError(`No tienes maná suficiente para ${cardOf(subject(a))}.`); return; }
    void send(a.kind === 'cast'
      ? { kind: 'cast', card: a.card, targets, payment: pay, warp: a.warp === true, flashback: a.flashback === true }
      : { kind: 'activate', source: a.source, ability: a.ability, targets, payment: pay, crew });
  };

  const choose = (a: LegalAction, mana?: ManaType) => {
    if (a.kind === 'playLand') {
      const etb = CARDS.get(cardOf(a.card))?.etb;
      const payLife = !!etb && 'tappedUnlessPayLife' in etb && confirm(`¿Pagar ${String(etb.tappedUnlessPayLife)} vidas para que ${cardOf(a.card)} entre enderezada?`);
      void send({ kind: 'playLand', card: a.card, payLife });
    } else if (a.kind === 'activateMana') void send({ kind: 'activateMana', source: a.source, mana });
    else if (crewNeed(a) !== undefined && a.kind === 'activate') setCrewing(a);
    else if (a.targetOptions.length === 0) finish(a, []);
    else setPending(a);
  };

  const [focus, setFocus] = useState<ObjectId | null>(null);
  // Space passes priority, unless you are typing or a button has focus (then Space presses that button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || (e.target instanceof HTMLElement && e.target.closest('input, select, textarea, button, summary'))) return;
      e.preventDefault();
      void send({ kind: 'pass' });
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [send]);
  useTableClick((id) => {
    const acts = usableActions(view, d.legal).filter((a) => a.kind !== 'activateMana' && subject(a) === id);
    if (acts.length === 1) choose(acts[0] as LegalAction);
    else if (acts.length > 1) setFocus(id); // several options (e.g. cast or warp): show just that card's
  });

  if (crewing) {
    return <CrewPicker view={view} vehicle={crewing.source} need={crewNeed(crewing) ?? 0}
      onDone={(crew) => { setCrewing(null); finish(crewing, [], crew); }} onCancel={() => { setCrewing(null); }} />;
  }
  if (pending) {
    return (<>
      <h3>{cardOf(subject(pending))}: elige objetivo</h3>
      <TargetPicker options={pending.targetOptions} view={view} nameOf={nameOf}
        onDone={(targets) => { setPending(null); finish(pending, targets); }} onCancel={() => { setPending(null); }} />
    </>);
  }

  const usable = usableActions(view, d.legal).filter((a) => focus === null || subject(a) === focus);
  const plays = usable.filter((a) => a.kind !== 'activateMana');
  const mana = usable.filter((a) => a.kind === 'activateMana');
  const label = (a: LegalAction): string[] => {
    if (a.kind === 'playLand') return [`Jugar ${cardOf(a.card)}${view.objects[a.card]?.zone === 'graveyard' ? ' desde el cementerio' : ''}`];
    if (a.kind === 'cast') return [`Lanzar ${cardOf(a.card)}${a.warp ? ' por warp' : a.flashback ? ' con flashback' : view.objects[a.card]?.zone === 'exile' ? ' desde el exilio' : ''}`];
    if (a.kind === 'activate') return [`${cardOf(a.source)}: ${CARDS.get(cardOf(a.source))?.activated?.[a.ability]?.text ?? 'activar'}`];
    return [];
  };
  return (<>
    <h3>Tienes prioridad</h3>
    {plays.length === 0 && <p>No puedes jugar nada ahora: pasa para seguir.</p>}
    <div className="actions">
      {plays.map((a) => label(a).map((text) => <button key={`${a.kind}-${subject(a)}-${text}`} onClick={() => { choose(a); }}>{text}</button>))}
    </div>
    {mana.length > 0 && (
      <details className="mana-taps">
        <summary>Girar tierras a mano</summary>
        <p className="muted">No hace falta: al lanzar algo se paga solo. Sirve para dejar maná en reserva.</p>
        {mana.map((a) => (CARDS.get(cardOf(a.source))?.manaAbilities?.[0]?.produce ?? []).map((m) => (
          <button key={`mana-${a.source}-${m}`} onClick={() => { choose(a, m); }}>Girar {cardOf(a.source)} ({m})</button>
        )))}
      </details>
    )}
    {focus && <button className="link" onClick={() => { setFocus(null); }}>Ver todas las acciones</button>}
    <button className="primary" onClick={() => void send({ kind: 'pass' })} aria-keyshortcuts="Space">{view.stack.length ? 'Pasar (resolver)' : 'Pasar'} <kbd>espacio</kbd></button>
  </>);
}

function targetLabel(t: Target, view: PlayerView, nameOf: (p: PlayerId) => string): string {
  if (t.kind === 'player') return nameOf(t.player);
  const o = view.objects[t.id];
  return o ? `${o.card} de ${nameOf(o.controller)}` : 'objetivo desaparecido';
}

function describe(e: GameEvent, names: Map<ObjectId, string>, nameOf: (p: PlayerId) => string): string | null {
  const n = (id: ObjectId) => names.get(id) ?? 'una carta';
  switch (e.kind) {
    case 'turnStarted': return `— Turno ${String(e.turn)} de ${nameOf(e.active)} —`;
    case 'drew': return e.card ? `Robas ${n(e.card)}.` : `${nameOf(e.player)} roba una carta.`;
    case 'cast': return `${nameOf(e.player)} lanza ${n(e.spell)}.`;
    case 'resolved': return `Se resuelve ${n(e.spell)}.`;
    case 'countered': return `${n(e.spell)} es contrarrestado.`;
    case 'fizzled': return `${n(e.spell)} no se resuelve: su objetivo ya no es legal.`;
    case 'damage': return `${n(e.source)} hace ${String(e.amount)} de daño a ${e.target.kind === 'player' ? nameOf(e.target.player) : n(e.target.id)}.`;
    case 'zoneChange':
      if (e.toZone === 'graveyard' && e.fromZone === 'battlefield') return `${e.card} va al cementerio.`;
      if (e.toZone === 'battlefield' && e.fromZone === 'hand') return `${nameOf(e.owner)} juega ${e.card}.`;
      return null;
    case 'attackersDeclared': return e.attackers.length ? `Atacan: ${e.attackers.map(n).join(', ')}.` : null;
    case 'blockersDeclared': return e.blocks.length ? `Bloqueos: ${e.blocks.map((b) => `${n(b.blocker)} → ${n(b.attacker)}`).join(', ')}.` : null;
    case 'mulligan': return `${nameOf(e.player)} hace mulligan (${String(e.count)}).`;
    case 'triggered': return `Se dispara la habilidad de ${e.card} (${nameOf(e.controller)}).`;
    case 'activated': return `${nameOf(e.controller)} activa una habilidad de ${e.card}.`;
    case 'tokenCreated': return `${nameOf(e.controller)} crea una ficha de ${e.card}.`;
    case 'revealed': return `${nameOf(e.player)} muestra ${e.card}.`;
    case 'surveilled': return `${nameOf(e.player)} vigila: ${String(e.toGraveyard)} al cementerio, ${String(e.toTop)} arriba.`;
    case 'searched': return e.found ? `${nameOf(e.player)} busca en su biblioteca y pone ${n(e.found)} en el campo.` : `${nameOf(e.player)} busca en su biblioteca y no coge nada.`;
    case 'playerLost': return `${nameOf(e.player)} pierde (${e.reason === 'conceded' ? 'concede' : e.reason === 'life' ? 'sin vidas' : 'sin cartas'}).`;
    default: return null;
  }
}
