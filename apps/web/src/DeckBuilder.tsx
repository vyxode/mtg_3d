import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { CARDS, DEFS } from '@mtg3d/cards';
import { manaValue, type ManaCost } from '@mtg3d/engine';
import { cardImage } from './net';
import { CardImage } from './CardImage';
import {
  FORMATS, TYPE_GROUPS, colorSymbols, countOf, exportDeckText, frontName, loadDecks, manaCurve, newDeck, parseDeckText, saveDecks, typeGroup, validateDeck,
  type Deck, type DeckCard, type Format,
} from './decks';

/** A search result: the catalog's card, or an implemented card when the catalog is not loaded. */
interface Result extends DeckCard { oracleId: string | null; oracleText: string; printingCount: number }
interface SetRow { code: string; name: string; releasedAt: string; setType: string; cardCount: number }
interface Printing { id: string; setName: string; collectorNumber: string; image: string | null }

const COLORS = [['W', 'Blanco'], ['U', 'Azul'], ['B', 'Negro'], ['R', 'Rojo'], ['G', 'Verde'], ['c', 'Incoloro']] as const;

const costText = (c: ManaCost | null): string => {
  if (!c) return '';
  const parts = c.generic ? [`{${String(c.generic)}}`] : [];
  for (const k of ['W', 'U', 'B', 'R', 'G', 'C'] as const) for (let i = 0; i < (c[k] ?? 0); i++) parts.push(`{${k}}`);
  return parts.join('');
};

/** Implemented cards as search results, used while the server has no catalog. */
const LOCAL: Result[] = DEFS.filter((d) => !d.token && !d.frontFace).map((d) => ({
  oracleId: null, name: d.name, cmc: manaValue(d.manaCost), manaCost: costText(d.manaCost), oracleText: '', printingCount: 1,
  typeLine: [d.supertypes?.join(' '), d.types.join(' ')].filter(Boolean).join(' ') + (d.subtypes?.length ? ` — ${d.subtypes.join(' ')}` : ''),
  image: cardImage(d.name), legalities: {}, anyNumber: false,
}));

interface Filters { name: string; text: string; type: string; colors: string[]; cmc: string; set: string; format: string }
const EMPTY: Filters = { name: '', text: '', type: '', colors: [], cmc: '', set: '', format: '' };

export function DeckBuilder() {
  const [decks, setDecks] = useState<Deck[]>(() => loadDecks());
  const [currentId, setCurrentId] = useState<string | null>(decks[0]?.id ?? null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [results, setResults] = useState<{ total: number; page: number; cards: Result[] }>({ total: 0, page: 0, cards: [] });
  const [online, setOnline] = useState<boolean | null>(null);
  const [tab, setTab] = useState<'search' | 'sets'>('search');
  const [detail, setDetail] = useState<Result | null>(null);
  const deck = decks.find((d) => d.id === currentId) ?? null;

  const update = (next: Deck[]) => { setDecks(next); saveDecks(next); };
  const change = (fn: (d: Deck) => Deck) => { if (deck) update(decks.map((d) => (d.id === deck.id ? { ...fn(d), updatedAt: new Date().toISOString() } : d))); };

  useEffect(() => { void fetch('/api/status').then((r) => r.json()).then((s: { cards: number }) => { setOnline(s.cards > 0); }).catch(() => { setOnline(false); }); }, []);
  // Show cards right away instead of an empty grid.
  useEffect(() => { if (online !== null) void search(0); }, [online]); // once, when we know where cards come from

  const search = async (page = 0) => {
    if (!online) {
      const f = filters;
      const hits = LOCAL.filter((c) => (!f.name || c.name.toLowerCase().includes(f.name.toLowerCase())) && (!f.type || c.typeLine.toLowerCase().includes(f.type.toLowerCase())) && (!f.cmc || c.cmc === Number(f.cmc)) && f.colors.every((x) => x === 'c' ? !/[WUBRG]/.test(c.manaCost) : c.manaCost.includes(x)));
      setResults({ total: hits.length, page: 0, cards: hits });
      return;
    }
    const p = new URLSearchParams();
    for (const k of ['name', 'text', 'type', 'set', 'format'] as const) if (filters[k]) p.set(k, filters[k]);
    if (filters.colors.length) p.set('colors', filters.colors.join(','));
    if (filters.cmc) p.set('cmc', filters.cmc);
    p.set('page', String(page));
    const r = await (await fetch(`/api/cards?${p.toString()}`)).json() as { total: number; page: number; cards: { oracleId: string; name: string; cmc: number; typeLine: string; manaCost: string; oracleText: string; legalities: Record<string, string>; printings: Printing[]; printingCount: number }[] };
    setResults({ total: r.total, page: r.page, cards: r.cards.map((c) => ({
      oracleId: c.oracleId, name: frontName(c.name), cmc: c.cmc, typeLine: c.typeLine, manaCost: c.manaCost, oracleText: c.oracleText, legalities: c.legalities,
      image: c.printings[0]?.image ?? cardImage(c.name), printingCount: c.printingCount, anyNumber: /A deck can have any number of cards named/i.test(c.oracleText),
    })) });
  };

  const add = (c: DeckCard, board: 'main' | 'side', delta: number) => {
    if (!deck) { // the first card added starts a deck
      const d = { ...newDeck(), [board]: { [c.name]: 1 }, info: { [c.name]: c } };
      update([d, ...decks]);
      setCurrentId(d.id);
      return;
    }
    change((d) => {
      const counts = { ...d[board] };
      counts[c.name] = Math.max(0, (counts[c.name] ?? 0) + delta);
      if (counts[c.name] === 0) Reflect.deleteProperty(counts, c.name);
      return { ...d, [board]: counts, info: { ...d.info, [c.name]: d.info[c.name] ?? c } };
    });
  };

  const onDrop = (board: 'main' | 'side') => (e: DragEvent) => {
    e.preventDefault();
    const name = e.dataTransfer.getData('text/plain');
    const c = results.cards.find((x) => x.name === name);
    if (c) add(c, board, 1);
  };

  const importText = () => {
    const text = prompt('Pega la lista (formato «4 Lightning Bolt»; «Sideboard» separa el banquillo):');
    if (!text) return;
    const parsed = parseDeckText(text);
    const known = new Map([...LOCAL, ...results.cards].map((c) => [c.name, c]));
    const info: Record<string, DeckCard> = {};
    for (const name of [...Object.keys(parsed.main), ...Object.keys(parsed.side)]) {
      info[name] = known.get(name) ?? { name, cmc: 0, typeLine: '', manaCost: '', image: cardImage(name), legalities: {}, anyNumber: false };
    }
    const d = { ...newDeck('Mazo importado'), main: parsed.main, side: parsed.side, info };
    update([d, ...decks]);
    setCurrentId(d.id);
    if (parsed.errors.length) alert(parsed.errors.join('\n'));
  };

  return (
    <main className="builder">
      <aside className="panel deck-list">
        <h3>Mis mazos</h3>
        <button onClick={() => { const d = newDeck(); update([d, ...decks]); setCurrentId(d.id); }}>Nuevo mazo</button>
        <button onClick={importText}>Importar lista</button>
        {decks.map((d) => (
          <button key={d.id} className={d.id === currentId ? 'selected-row' : 'row-button'} onClick={() => { setCurrentId(d.id); }}>
            {d.name} <span className="muted">({countOf(d.main)})</span>
          </button>
        ))}
      </aside>

      <section className="panel search">
        <div className="tabs">
          <button className={tab === 'search' ? 'primary' : ''} onClick={() => { setTab('search'); }}>Buscar cartas</button>
          <button className={tab === 'sets' ? 'primary' : ''} onClick={() => { setTab('sets'); }} disabled={!online}>Expansiones</button>
        </div>
        {online === false && <p className="muted">Se muestran las cartas que el juego ya sabe jugar.</p>}
        {tab === 'sets' ? <SetExplorer onPick={(code) => { setFilters({ ...EMPTY, set: code }); setTab('search'); }} /> : (<>
          <form className="filters" onSubmit={(e) => { e.preventDefault(); void search(0); }}>
            <input placeholder="Nombre" value={filters.name} onChange={(e) => { setFilters({ ...filters, name: e.target.value }); }} />
            <input placeholder="Tipo (Creature, Instant…)" value={filters.type} onChange={(e) => { setFilters({ ...filters, type: e.target.value }); }} />
            {online && <input placeholder="Texto de reglas" value={filters.text} onChange={(e) => { setFilters({ ...filters, text: e.target.value }); }} />}
            <input placeholder="Valor de maná" inputMode="numeric" value={filters.cmc} onChange={(e) => { setFilters({ ...filters, cmc: e.target.value.replace(/\D/g, '') }); }} />
            {online && <input placeholder="Set (código)" value={filters.set} onChange={(e) => { setFilters({ ...filters, set: e.target.value.toLowerCase() }); }} />}
            {online && <select value={filters.format} onChange={(e) => { setFilters({ ...filters, format: e.target.value }); }}>
              <option value="">Cualquier formato</option>
              {FORMATS.filter((f) => f !== 'casual').map((f) => <option key={f}>{f}</option>)}
            </select>}
            <div className="row">{COLORS.map(([c, label]) => (
              <label key={c} className="inline"><input type="checkbox" checked={filters.colors.includes(c)} onChange={(e) => { setFilters({ ...filters, colors: e.target.checked ? [...filters.colors, c] : filters.colors.filter((x) => x !== c) }); }} />{label}</label>
            ))}</div>
            <button className="primary" type="submit">Buscar</button>
          </form>
          <p className="muted">{results.total} resultados</p>
          <div className="results">
            {results.cards.map((c) => (
              <div key={c.name} className="result" draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', c.name); }}>
                <CardImage name={c.name} src={c.image ?? cardImage(c.name)} loading="lazy" onClick={() => { setDetail(c); }} />
                <button className="link result-name" onClick={() => { setDetail(c); }}>{c.name}</button>
                <div className="result-actions">
                  {!CARDS.has(c.name) && <span className="badge" title="El motor todavía no implementa esta carta">no jugable</span>}
                  <button onClick={() => { add(c, 'main', 1); }} title="Añadir al mazo" aria-label={`Añadir ${c.name} al mazo`}>+ Mazo</button>
                  <button onClick={() => { add(c, 'side', 1); }} title="Añadir al banquillo" aria-label={`Añadir ${c.name} al banquillo`}>+ Banq.</button>
                </div>
              </div>
            ))}
          </div>
          {online && results.total > (results.page + 1) * 60 && <button onClick={() => void search(results.page + 1)}>Siguiente página</button>}
          {online && results.page > 0 && <button onClick={() => void search(results.page - 1)}>Página anterior</button>}
        </>)}
      </section>

      <section className="panel deck" onDragOver={(e) => { e.preventDefault(); }} onDrop={onDrop('main')}>
        {deck ? <DeckView deck={deck} change={change} add={add} onDropSide={onDrop('side')}
          onDuplicate={() => { const d = { ...structuredClone(deck), id: crypto.randomUUID(), name: `${deck.name} (copia)` }; update([d, ...decks]); setCurrentId(d.id); }}
          onDelete={() => { if (confirm(`¿Borrar ${deck.name}?`)) { const next = decks.filter((d) => d.id !== deck.id); update(next); setCurrentId(next[0]?.id ?? null); } }} />
          : <p className="muted">Añade una carta con «+ Mazo» y se creará un mazo nuevo, o importa una lista.</p>}
      </section>

      {detail && <CardDetail card={detail} onClose={() => { setDetail(null); }} onPickPrinting={(image) => { change((d) => (d.info[detail.name] ? { ...d, info: { ...d.info, [detail.name]: { ...(d.info[detail.name] as DeckCard), image } } } : d)); setDetail(null); }} />}
    </main>
  );
}

function DeckView({ deck, change, add, onDropSide, onDuplicate, onDelete }: {
  deck: Deck; change: (fn: (d: Deck) => Deck) => void; add: (c: DeckCard, b: 'main' | 'side', delta: number) => void;
  onDropSide: (e: DragEvent) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const { errors, unplayable } = useMemo(() => validateDeck(deck, CARDS), [deck]);
  const curve = manaCurve(deck);
  const colors = colorSymbols(deck);
  const max = Math.max(1, ...curve);
  const groups = TYPE_GROUPS.map((g) => [g, Object.keys(deck.main).filter((n) => typeGroup(deck.info[n]?.typeLine ?? '') === g)] as const).filter(([, names]) => names.length);
  const row = (name: string, board: 'main' | 'side') => {
    const info = deck.info[name] ?? { name, cmc: 0, typeLine: '', manaCost: '', image: null, legalities: {}, anyNumber: false };
    return (
      <div key={`${board}-${name}`} className="deck-row">
        <span>{deck[board][name]}× {name}</span>
        <span className="muted">{info.manaCost}</span>
        <button onClick={() => { add(info, board, 1); }} aria-label={`Una ${name} más`}>+</button>
        <button onClick={() => { add(info, board, -1); }} aria-label={`Una ${name} menos`}>−</button>
      </div>
    );
  };
  return (<>
    <input className="deck-name" value={deck.name} onChange={(e) => { change((d) => ({ ...d, name: e.target.value })); }} aria-label="Nombre del mazo" />
    <div className="row">
      <select value={deck.format} onChange={(e) => { change((d) => ({ ...d, format: e.target.value as Format })); }} aria-label="Formato">
        {FORMATS.map((f) => <option key={f}>{f}</option>)}
      </select>
      <button onClick={() => void navigator.clipboard.writeText(exportDeckText(deck)).then(() => { alert('Lista copiada: pégala a tu amigo o en Arena/MTGO.'); })}>Exportar / compartir</button>
      <button onClick={onDuplicate}>Duplicar</button>
      <button className="danger" onClick={onDelete}>Borrar</button>
    </div>
    <p><b>{countOf(deck.main)}</b> cartas · banquillo <b>{countOf(deck.side)}</b></p>
    {errors.map((e) => <p key={e} className="error">{e}</p>)}
    {unplayable.length > 0 && <p className="warn">No jugable todavía (el motor no implementa): {unplayable.join(', ')}</p>}
    {errors.length === 0 && unplayable.length === 0 && countOf(deck.main) > 0 && <p className="ok">Mazo válido y jugable.</p>}
    <div className="curve" aria-label="Curva de maná">
      {curve.map((n, i) => <div key={i} className="bar"><div style={{ height: `${String((n / max) * 60)}px` }} /><span>{i === 7 ? '7+' : i}</span><span className="muted">{n}</span></div>)}
    </div>
    <p className="muted">Símbolos de color: {Object.entries(colors).filter(([, n]) => n > 0).map(([c, n]) => `${c} ${String(n)}`).join(' · ') || '—'}</p>
    {groups.map(([g, names]) => (
      <div key={g}><h3>{g} ({names.reduce((a, n) => a + (deck.main[n] ?? 0), 0)})</h3>{names.map((n) => row(n, 'main'))}</div>
    ))}
    <div className="sideboard" onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }} onDrop={(e) => { e.stopPropagation(); onDropSide(e); }}>
      <h3>Banquillo (suelta aquí)</h3>
      {Object.keys(deck.side).map((n) => row(n, 'side'))}
    </div>
  </>);
}

function SetExplorer({ onPick }: { onPick: (code: string) => void }) {
  const [sets, setSets] = useState<SetRow[]>([]);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  useEffect(() => { void fetch('/api/sets').then((r) => r.json()).then((s: SetRow[]) => { setSets(s); }); }, []);
  const types = [...new Set(sets.map((s) => s.setType))].sort();
  const shown = sets.filter((s) => (!type || s.setType === type) && (!q || `${s.name} ${s.code}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
  return (<>
    <div className="row">
      <input placeholder="Nombre o código" value={q} onChange={(e) => { setQ(e.target.value); }} />
      <select value={type} onChange={(e) => { setType(e.target.value); }}><option value="">Todos los tipos</option>{types.map((t) => <option key={t}>{t}</option>)}</select>
    </div>
    <p className="muted">{shown.length} de {sets.length} expansiones</p>
    <div className="set-list">
      {shown.map((s) => (
        <button key={s.code} className="row-button" onClick={() => { onPick(s.code); }}>
          <code>{s.code.toUpperCase()}</code> {s.name} <span className="muted">{s.releasedAt} · {s.setType} · {s.cardCount}</span>
        </button>
      ))}
    </div>
  </>);
}

function CardDetail({ card, onClose, onPickPrinting }: { card: Result; onClose: () => void; onPickPrinting: (image: string | null) => void }) {
  const [full, setFull] = useState<{ oracleText: string; printings: Printing[] } | null>(null);
  useEffect(() => {
    if (card.oracleId) void fetch(`/api/cards/${card.oracleId}`).then((r) => r.json()).then(setFull);
  }, [card.oracleId]);
  return (
    <div className="modal" role="dialog" aria-label={card.name} onClick={onClose}>
      <div className="panel" onClick={(e) => { e.stopPropagation(); }}>
        <div className="row">
          <CardImage className="big-card" name={card.name} src={card.image ?? cardImage(card.name)} />
          <div>
            <h1>{card.name}</h1>
            <p>{card.typeLine} · {card.manaCost}</p>
            <p className="oracle">{full?.oracleText ?? card.oracleText}</p>
            <p>{CARDS.has(card.name) ? <span className="ok">Implementada en el motor</span> : <span className="warn">El motor todavía no la implementa</span>}</p>
          </div>
        </div>
        {full && full.printings.length > 1 && (<>
          <h3>Impresiones ({full.printings.length}) — elige la que verás en tu mazo</h3>
          <div className="results">
            {full.printings.map((p) => <img key={p.id} src={p.image ?? ''} alt={`${card.name} · ${p.setName} ${p.collectorNumber}`} title={`${p.setName} #${p.collectorNumber}`} loading="lazy" onClick={() => { onPickPrinting(p.image); }} />)}
          </div>
        </>)}
        <button onClick={onClose}>Cerrar</button>
      </div>
    </div>
  );
}
