const ORDER = ['W', 'U', 'B', 'R', 'G', 'C'] as const;
const NAMES: Record<(typeof ORDER)[number], string> = { W: 'blanco', U: 'azul', B: 'negro', R: 'rojo', G: 'verde', C: 'incoloro' };

/** Mana as colored pips with counts, e.g. a mana pool or a deck's colored symbols. */
export function ManaPips({ pool }: { pool: Partial<Record<string, number>> }) {
  const shown = ORDER.filter((c) => (pool[c] ?? 0) > 0);
  if (shown.length === 0) return null;
  return (
    <span className="pips" aria-label={shown.map((c) => `${String(pool[c])} ${NAMES[c]}`).join(', ')}>
      {shown.map((c) => <span key={c} className={`pip pip-${c}`}>{pool[c]}</span>)}
    </span>
  );
}
