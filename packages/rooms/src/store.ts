import type { PlayerId, PlayerInput } from '@mtg3d/engine';

export interface SeatRecord {
  name: string;
  /** SHA-256 of the seat token: a leaked database does not let anyone take a seat. */
  tokenHash: string;
  deck: string[] | null;
  fullControl: boolean;
}

/** Everything needed to rebuild a room after a restart: the engine is deterministic, so seed + inputs give the state. */
export interface RoomRecord {
  code: string;
  seats: Partial<Record<PlayerId, SeatRecord>>;
  /** Engine seed: secret, never sent to clients. Null until both decks are chosen. */
  seed: number | null;
  /** Every input applied to the game, automatic passes included, in order. */
  inputs: PlayerInput[];
  updatedAt: number;
}

export interface RoomStore {
  save(r: RoomRecord): Promise<void>;
  delete(code: string): Promise<void>;
  loadAll(): Promise<RoomRecord[]>;
}

/** The part of `pg.Pool` (and of PGlite, used in tests) the store needs. */
export type Query = (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

// shortcut: the whole record is rewritten on every input (tens of KB per game); switch to an append-only inputs table if games get long.
export class PgStore implements RoomStore {
  constructor(private readonly query: Query) {}

  async init(): Promise<void> {
    await this.query('CREATE TABLE IF NOT EXISTS rooms (code text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL)');
  }

  async save(r: RoomRecord): Promise<void> {
    await this.query(
      'INSERT INTO rooms (code, data, updated_at) VALUES ($1, $2, to_timestamp($3 / 1000.0)) ON CONFLICT (code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      [r.code, JSON.stringify(r), r.updatedAt],
    );
  }

  async delete(code: string): Promise<void> {
    await this.query('DELETE FROM rooms WHERE code = $1', [code]);
  }

  async loadAll(): Promise<RoomRecord[]> {
    const { rows } = await this.query('SELECT data FROM rooms');
    return rows.map((row) => {
      const data = (row as { data: unknown }).data;
      return (typeof data === 'string' ? JSON.parse(data) : data) as RoomRecord;
    });
  }
}
