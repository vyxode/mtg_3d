import { PRESET_DECKS } from '@mtg3d/cards';
import type { PlayerId } from '@mtg3d/engine';
import type { GameUpdate, RoomState } from '@mtg3d/protocol';
import { openSession, Rooms } from '@mtg3d/rooms';
import { botResponse } from './bot';
import type { Hub } from './hub';

/**
 * Practice without a friend: the room runs in this browser (no network), you sit at p1 and the other seat is either
 * the practice bot or yourself ("las dos manos": the table turns to whichever player has to act).
 */
export type PracticeMode = 'bot' | 'self';

const randomDeck = (): string[] => { const all = Object.values(PRESET_DECKS); return all[Math.floor(Math.random() * all.length)] ?? []; };

export function createPractice(hub: Hub, mode: PracticeMode): (event: string, payload: unknown) => Promise<unknown> {
  const rooms = new Rooms((token) => token); // nothing leaves this page
  const latest: Partial<Record<PlayerId, GameUpdate>> = {};
  const theirDeck = randomDeck();

  /** Self mode shows the seat that has to act; otherwise always yours. */
  const show = () => {
    const other = latest.p2;
    const u = mode === 'self' && other?.view.pending?.player === 'p2' && !other.view.result ? other : latest.p1 ?? other;
    if (u) hub.emit('game:update', u);
  };

  const you = openSession(rooms, {
    roomState: (s) => { hub.emit('room:state', s); },
    gameUpdate: (u) => { latest.p1 = u; show(); },
  });

  let acting: ReturnType<typeof setTimeout> | null = null;
  const other = openSession(rooms, {
    roomState: (s: RoomState) => {
      if (s.status === 'choosingDecks' && s.seats.p2?.ready === false) other.handle('room:deck', { deck: theirDeck }); // also after "Nueva partida"
    },
    gameUpdate: (u) => {
      latest.p2 = u;
      show();
      if (mode !== 'bot' || u.view.pending?.player !== 'p2' || u.view.result) return;
      // The bot takes a moment, like someone looking at the table; passing is quicker than playing.
      const id = u.view.pending.id;
      if (acting) clearTimeout(acting);
      const response = botResponse(u.view);
      acting = setTimeout(() => {
        if (latest.p2?.view.pending?.id !== id || !response) return;
        const ack = other.handle('game:input', { decisionId: id, response });
        if (ack.ok) return;
        console.warn('bot move rejected', response, ack.error);
        const fallback = response.kind === 'declareAttackers' ? { kind: 'declareAttackers', attackers: [] }
          : response.kind === 'declareBlockers' ? { kind: 'declareBlockers', blocks: [] } : { kind: 'pass' };
        other.handle('game:input', { decisionId: id, response: fallback });
      }, response?.kind === 'pass' ? 350 : 900);
    },
  });

  hub.setConnected(true);
  return (event, payload) => {
    if (event === 'game:input' && mode === 'self' && latest.p2?.view.pending?.player === 'p2') return Promise.resolve(other.handle(event, payload));
    const ack = you.handle(event, payload);
    if (event === 'room:create' && ack.ok && 'code' in ack) {
      other.handle('room:join', { code: ack.code, name: mode === 'bot' ? 'La máquina' : 'Tu otra mano' });
    }
    return Promise.resolve(ack);
  };
}
