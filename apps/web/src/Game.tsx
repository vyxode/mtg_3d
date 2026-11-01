import { useEffect, useMemo, useRef, useState } from 'react';
import { CARDS } from '@mtg3d/cards';
import type { GameEvent, LegalAction, ObjectId, PendingDecision, PlayerId, PlayerView, Response, Step, Target, VisibleObject } from '@mtg3d/engine';
import type { GameUpdate, RoomState } from '@mtg3d/protocol';
import { autopay } from './autopay';
import { ask, cardImage } from './net';

const STEP_NAMES: Record<Step, string> = {
  untap: 'Enderezar', upkeep: 'Mantenimiento', draw: 'Robar', main1: 'Fase principal 1',
  beginCombat: 'Inicio del combate', declareAttackers: 'Declarar atacantes', declareBlockers: 'Declarar bloqueadores',
  combatDamage: 'Daño de combate', endCombat: 'Fin del combate', main2: 'Fase principal 2', end: 'Final', cleanup: 'Limpieza',
};

const DECISION_NAMES: Record<PendingDecision['kind'], string> = {
  chooseStartingPlayer: 'elegir quién empieza', mulligan: 'decidir el mulligan', bottomCards: 'poner cartas al fondo',
  priority: 'actuar', declareAttackers: 'declarar atacantes', declareBlockers: 'declarar bloqueadores',
  assignCombatDamage: 'repartir daño', discard: 'descartar', orderTriggers: 'ordenar sus habilidades', chooseTargets: 'elegir objetivos',
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

  const battlefield = (p: PlayerId) => view.zones.battlefield.map((id) => view.objects[id]).filter((o): o is VisibleObject => o?.controller === p);

  return (
    <main className="game">
      <section className="status">
        <span>Turno {view.turn.number} · {nameOf(view.turn.active)} · <b>{STEP_NAMES[view.turn.step]}</b></span>
        <FullControl room={room} />
        {!view.result && <button className="danger" onClick={() => { if (confirm('¿Conceder la partida?')) void ask('game:input', { concede: true }); }}>Conceder</button>}
      </section>

      {view.result && (
        <p className="banner">{view.result.winner === null ? 'Empate.' : view.result.winner === me ? '¡Has ganado!' : `Ha ganado ${nameOf(view.result.winner)}.`}</p>
      )}

      <PlayerBar view={view} p={opp} name={nameOf(opp)} />
      <Zone title={`Campo de ${nameOf(opp)}`} cards={battlefield(opp)} />

      <section className="middle">
        <div className="stack">
          <h3>Pila</h3>
          {view.stack.length === 0 && <p className="muted">Vacía</p>}
          {[...view.stack].reverse().map((e) => (
            <div key={e.id} className="stack-item">
              <b>{e.card}</b>{e.kind === 'ability' ? ' — habilidad' : ''} ({nameOf(e.controller)})
              {e.targets.length > 0 && <> → {e.targets.map((t) => targetLabel(t, view, nameOf)).join(', ')}</>}
            </div>
          ))}
        </div>
        <Decision view={view} mine={mine} pendingOther={pending && !mine ? pending : null} nameOf={nameOf} send={send} onError={onError} />
        <div className="log">
          <h3>Registro</h3>
          {log.map((l, i) => <div key={`${String(i)}-${l}`}>{l}</div>)}
        </div>
      </section>

      <Zone title="Tu campo" cards={battlefield(me)} />
      <PlayerBar view={view} p={me} name={`${nameOf(me)} (tú)`} />
      <Zone title="Tu mano" cards={view.zones.hand.map((id) => view.objects[id]).filter((o): o is VisibleObject => !!o)} />
      <details>
        <summary>Cementerios</summary>
        {(['p1', 'p2'] as const).map((p) => (
          <p key={p}>{nameOf(p)}: {view.zones.graveyard[p].map((id) => view.objects[id]?.card).join(', ') || '—'}</p>
        ))}
      </details>
    </main>
  );
}

function FullControl({ room }: { room: RoomState }) {
  return (
    <label className="inline" title="Sin auto-pase: recibes la prioridad en todos los pasos">
      <input type="checkbox" checked={room.fullControl} onChange={(e) => void ask('room:settings', { fullControl: e.target.checked })} /> Control total
    </label>
  );
}

function PlayerBar({ view, p, name }: { view: PlayerView; p: PlayerId; name: string }) {
  const pl = view.players[p];
  const mana = Object.entries(pl.manaPool).filter(([, n]) => n > 0).map(([c, n]) => `${c}×${String(n)}`).join(' ');
  return (
    <section className="playerbar">
      <b>{name}</b>
      <span className="life">♥ {pl.life}</span>
      <span>Mano {pl.handSize}</span>
      <span>Biblioteca {pl.librarySize}</span>
      {mana && <span>Maná: {mana}</span>}
    </section>
  );
}

export function CardView({ o, selected, onClick }: { o: VisibleObject; selected?: boolean; onClick?: () => void }) {
  const [broken, setBroken] = useState(false);
  const isCreature = CARDS.get(o.card)?.types.includes('Creature') ?? false;
  return (
    <button className={`card${o.tapped ? ' tapped' : ''}${selected ? ' selected' : ''}`} onClick={onClick} disabled={!onClick} title={o.card}>
      <span className="card-text">{o.card}</span>
      {!broken && <img src={cardImage(o.card)} alt={o.card} loading="lazy" onError={() => { setBroken(true); }} />}
      {o.zone === 'battlefield' && isCreature && <span className="pt">{o.power}/{o.toughness}{o.damage > 0 ? ` (−${String(o.damage)})` : ''}</span>}
      {o.zone === 'battlefield' && isCreature && o.summoningSick && <span className="sick">mareada</span>}
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
      return (<>
        <h3>Elige atacantes</h3>
        <Zone title="Puedes atacar con" cards={d.candidates.map((id) => view.objects[id]).filter((o): o is VisibleObject => !!o)} selected={picked} onClick={toggle} />
        <button onClick={() => void send({ kind: 'declareAttackers', attackers: [...picked] })}>{picked.size ? `Atacar con ${String(picked.size)}` : 'No atacar'}</button>
      </>);
    case 'declareBlockers':
      return <Blockers view={view} d={d} send={send} />;
    case 'assignCombatDamage':
      return <DamageSplit view={view} d={d} send={send} />;
    case 'priority':
      return <Priority view={view} d={d} nameOf={nameOf} send={send} onError={onError} />;
    case 'orderTriggers':
      return <OrderTriggers d={d} send={send} />;
    case 'chooseTargets':
      return (<>
        <h3>{d.card}: elige objetivo</h3>
        <TargetPicker options={d.targetOptions} view={view} nameOf={nameOf} onDone={(targets) => void send({ kind: 'chooseTargets', targets })} />
      </>);
  }
}

/** Picks one target per slot, then calls onDone with all of them. */
function TargetPicker({ options, view, nameOf, onDone, onCancel }: { options: Target[][]; view: PlayerView; nameOf: (p: PlayerId) => string; onDone: (t: Target[]) => void; onCancel?: () => void }) {
  const [chosen, setChosen] = useState<Target[]>([]);
  const slot = options[chosen.length] ?? [];
  return (<>
    {options.length > 1 && <p className="muted">Objetivo {chosen.length + 1} de {options.length}</p>}
    {slot.map((t) => (
      <button key={JSON.stringify(t)} onClick={() => {
        const next = [...chosen, t];
        if (next.length === options.length) onDone(next); else setChosen(next);
      }}>{targetLabel(t, view, nameOf)}</button>
    ))}
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

function Blockers({ view, d, send }: { view: PlayerView; d: Extract<PendingDecision, { kind: 'declareBlockers' }>; send: (r: Response) => Promise<void> }) {
  const [blocks, setBlocks] = useState<Record<ObjectId, ObjectId>>({});
  const card = (id: ObjectId) => view.objects[id]?.card ?? id;
  return (<>
    <h3>Declara bloqueadores</h3>
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

function Priority({ view, d, nameOf, send, onError }: { view: PlayerView; d: Extract<PendingDecision, { kind: 'priority' }>; nameOf: (p: PlayerId) => string; send: (r: Response) => Promise<void>; onError: (e: string | null) => void }) {
  const [casting, setCasting] = useState<Extract<LegalAction, { kind: 'cast' }> | null>(null);
  const sources = useMemo(() => d.legal.flatMap((a) => (a.kind === 'activateMana' ? [a.source] : [])), [d.legal]);
  const affordable = (a: LegalAction) => a.kind !== 'cast' || autopay(view, CARDS, sources, CARDS.get(view.objects[a.card]?.card ?? '')?.manaCost ?? null) !== null;
  const actionsFor = (id: ObjectId) => d.legal.filter((a) => (('card' in a && a.card === id) || ('source' in a && a.source === id)) && affordable(a));

  const finishCast = (action: Extract<LegalAction, { kind: 'cast' }>, targets: Target[]) => {
    const card = view.objects[action.card]?.card ?? '';
    const payment = autopay(view, CARDS, sources, CARDS.get(card)?.manaCost ?? null);
    if (!payment) { onError(`No tienes maná suficiente para ${card}.`); setCasting(null); return; }
    void send({ kind: 'cast', card: action.card, targets, payment });
  };

  const choose = (a: LegalAction) => {
    if (a.kind === 'playLand') void send({ kind: 'playLand', card: a.card });
    else if (a.kind === 'activateMana') void send({ kind: 'activateMana', source: a.source });
    else if (a.targetOptions.length === 0) finishCast(a, []);
    else setCasting(a);
  };

  if (casting) {
    return (<>
      <h3>{view.objects[casting.card]?.card}: elige objetivo</h3>
      <TargetPicker options={casting.targetOptions} view={view} nameOf={nameOf}
        onDone={(targets) => { setCasting(null); finishCast(casting, targets); }} onCancel={() => { setCasting(null); }} />
    </>);
  }

  const playable = [...view.zones.hand, ...view.zones.battlefield].filter((id) => actionsFor(id).length > 0);
  return (<>
    <h3>Tienes prioridad</h3>
    <div className="actions">
      {playable.map((id) => actionsFor(id).map((a) => (
        <button key={`${a.kind}-${id}`} onClick={() => { choose(a); }}>
          {a.kind === 'playLand' ? 'Jugar' : a.kind === 'cast' ? 'Lanzar' : 'Girar'} {view.objects[id]?.card}
        </button>
      )))}
    </div>
    <button className="primary" onClick={() => void send({ kind: 'pass' })}>{view.stack.length ? 'Pasar (resolver)' : 'Pasar'}</button>
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
    case 'playerLost': return `${nameOf(e.player)} pierde (${e.reason === 'conceded' ? 'concede' : e.reason === 'life' ? 'sin vidas' : 'sin cartas'}).`;
    default: return null;
  }
}
