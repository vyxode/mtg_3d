/** Messages between browser and server. Zod validates everything that comes from a client; the engine validates the rules. */
import { z } from 'zod';
import type { GameEvent, PlayerId, PlayerView, Response } from '@mtg3d/engine';

const id = z.string().min(1).max(32);
const player = z.enum(['p1', 'p2']);
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('player'), player }),
  z.object({ kind: z.literal('object'), id }),
]);

export const responseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chooseStartingPlayer'), first: player }),
  z.object({ kind: z.literal('keep') }),
  z.object({ kind: z.literal('mulligan') }),
  z.object({ kind: z.literal('bottomCards'), cards: z.array(id).max(60) }),
  z.object({ kind: z.literal('pass') }),
  z.object({ kind: z.literal('playLand'), card: id, payLife: z.boolean().optional() }),
  z.object({ kind: z.literal('cast'), card: id, targets: z.array(target).max(10), payment: z.array(id).max(60), warp: z.boolean().optional(), flashback: z.boolean().optional() }),
  z.object({ kind: z.literal('activateMana'), source: id, mana: z.enum(['W', 'U', 'B', 'R', 'G', 'C']).optional() }),
  z.object({ kind: z.literal('activate'), source: id, ability: z.number().int().min(0).max(20), targets: z.array(target).max(10), payment: z.array(id).max(60), crew: z.array(id).max(60).optional() }),
  z.object({ kind: z.literal('declareAttackers'), attackers: z.array(id).max(200), planeswalkerTargets: z.record(id, id).optional() }),
  z.object({ kind: z.literal('declareBlockers'), blocks: z.array(z.object({ blocker: id, attacker: id })).max(200) }),
  z.object({ kind: z.literal('assignCombatDamage'), assignment: z.record(id, z.number().int().min(0).max(1000)) }),
  z.object({ kind: z.literal('discard'), cards: z.array(id).max(60) }),
  z.object({ kind: z.literal('orderTriggers'), order: z.array(id).max(100) }),
  z.object({ kind: z.literal('chooseTargets'), targets: z.array(target).max(10) }),
  z.object({ kind: z.literal('legendRule'), keep: id }),
  z.object({ kind: z.literal('searchLibrary'), card: z.string().max(200).nullable() }),
  z.object({ kind: z.literal('surveil'), graveyard: z.array(z.number().int().min(0).max(100)).max(100), top: z.array(z.number().int().min(0).max(100)).max(100) }),
]) satisfies z.ZodType<Response>;

const name = z.string().trim().min(1).max(24);
export const ROOM_CODE_LENGTH = 6;
const code = z.string().trim().toUpperCase().length(ROOM_CODE_LENGTH);

export const clientMessages = {
  'room:create': z.object({ name }),
  'room:join': z.object({ code, name }),
  'room:rejoin': z.object({ code, token: z.string().min(16).max(64) }),
  'room:deck': z.object({ deck: z.array(z.string().min(1).max(141)).min(1).max(250) }),
  'room:settings': z.object({ fullControl: z.boolean() }),
  /** After a game: back to choosing decks, same room and seats. */
  'room:newGame': z.object({}),
  'game:input': z.union([
    z.object({ decisionId: z.number().int().nonnegative(), response: responseSchema }),
    z.object({ concede: z.literal(true) }),
  ]),
} as const;

export type ClientMessage = keyof typeof clientMessages;
export type ClientPayload<K extends ClientMessage> = z.infer<(typeof clientMessages)[K]>;

export type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: string };
export type JoinAck = Ack<{ code: string; seat: PlayerId; token: string }>;

export interface SeatInfo { name: string; connected: boolean; ready: boolean }
export interface RoomState {
  code: string;
  you: PlayerId;
  status: 'waiting' | 'choosingDecks' | 'playing' | 'finished';
  seats: Record<PlayerId, SeatInfo | null>;
  fullControl: boolean;
}

export interface GameUpdate {
  /** Increases by one with every applied input; a gap means the client must ask for a fresh view. */
  version: number;
  view: PlayerView;
  events: GameEvent[];
}

export interface ServerToClient {
  'room:state': (s: RoomState) => void;
  'game:update': (u: GameUpdate) => void;
}

export interface ClientToServer {
  'room:create': (p: ClientPayload<'room:create'>, ack: (a: JoinAck) => void) => void;
  'room:join': (p: ClientPayload<'room:join'>, ack: (a: JoinAck) => void) => void;
  'room:rejoin': (p: ClientPayload<'room:rejoin'>, ack: (a: JoinAck) => void) => void;
  'room:deck': (p: ClientPayload<'room:deck'>, ack: (a: Ack) => void) => void;
  'room:settings': (p: ClientPayload<'room:settings'>, ack: (a: Ack) => void) => void;
  'room:newGame': (p: ClientPayload<'room:newGame'>, ack: (a: Ack) => void) => void;
  'game:input': (p: ClientPayload<'game:input'>, ack: (a: Ack) => void) => void;
}
