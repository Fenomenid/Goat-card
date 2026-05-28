import { randomUUID } from "node:crypto";

export type Suit = "clubs" | "spades" | "hearts" | "diamonds";
export type Rank = "9" | "J" | "Q" | "K" | "10" | "A";
export type Phase = "lobby" | "playing" | "trick_result" | "round_result" | "game_over";
export type TableAction = "lead" | "beat" | "discard";

export type Card = { id: string; suit: Suit; rank: Rank };
export type Player = {
  id: string;
  name: string;
  isHost: boolean;
  hand: Card[];
  bank: Card[];
  penalty: number;
  eliminated: boolean;
};
export type TableEntry = { playerId: string; playerName: string; cards: Card[]; faceDown: boolean; action: TableAction };
export type RoundSummary = { points: Record<string, number>; penalties: Record<string, number>; eggs: boolean; instantWinnerId?: string; instantName?: string };
export type Room = {
  id: string;
  phase: Phase;
  players: Player[];
  deck: Card[];
  dealerIndex: number;
  activePlayerIndex: number;
  leaderId?: string;
  currentWinnerId?: string;
  leadCards: Card[];
  responderOrder: string[];
  responderCursor: number;
  table: TableEntry[];
  roundNo: number;
  lastTrickWinnerId?: string;
  message: string;
  pendingTrickWinnerId?: string;
  forceTrumpLeadPlayerId?: string;
  unbeatableLead?: boolean;
  summary?: RoundSummary;
};
export type PlayerView = Omit<Player, "hand" | "bank"> & { handCount: number; bankPoints?: number; isYou: boolean };
export type RoomSnapshot = Omit<Room, "players" | "deck"> & {
  players: PlayerView[];
  selfId: string;
  selfHand: Card[];
  deckCount: number;
  inviteUrl?: string;
};

const suits: Suit[] = ["clubs", "spades", "hearts", "diamonds"];
const ranks: Rank[] = ["9", "J", "Q", "K", "10", "A"];
const cardPoints: Record<Rank, number> = { "9": 0, J: 2, Q: 3, K: 4, "10": 10, A: 11 };
const rankPower: Record<Rank, number> = { "9": 1, J: 2, Q: 3, K: 4, "10": 5, A: 6 };
const trump: Suit = "diamonds";
const handLimit = 4;
const maxPenalty = 12;

export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameError";
  }
}

export class GameManager {
  private rooms = new Map<string, Room>();
  private socketRooms = new Map<string, string>();

  createRoom(socketId: string, name: string) {
    const room: Room = {
      id: this.createRoomId(),
      phase: "lobby",
      players: [this.createPlayer(socketId, name, true)],
      deck: [],
      dealerIndex: 0,
      activePlayerIndex: 0,
      leadCards: [],
      responderOrder: [],
      responderCursor: 0,
      table: [],
      roundNo: 0,
      message: "Ждем игроков.",
    };
    this.rooms.set(room.id, room);
    this.socketRooms.set(socketId, room.id);
    return room;
  }

  joinRoom(socketId: string, roomId: string, name: string) {
    const room = this.getRoom(roomId);
    if (room.phase !== "lobby") throw new GameError("Игра уже началась");
    if (room.players.length >= 4) throw new GameError("В комнате максимум 4 игрока");
    room.players.push(this.createPlayer(socketId, name, false));
    this.socketRooms.set(socketId, room.id);
    room.message = `${name.trim()} вошел в комнату.`;
    return room;
  }

  leave(socketId: string) {
    const roomId = this.socketRooms.get(socketId);
    if (!roomId) return undefined;
    const room = this.rooms.get(roomId);
    this.socketRooms.delete(socketId);
    if (!room) return undefined;
    room.players = room.players.filter((player) => player.id !== socketId);
    if (room.players.length === 0) {
      this.rooms.delete(room.id);
      return undefined;
    }
    if (!room.players.some((player) => player.isHost)) room.players[0].isHost = true;
    if (room.phase !== "lobby") {
      room.phase = "lobby";
      room.deck = [];
      room.table = [];
      room.leadCards = [];
      room.responderOrder = [];
      room.message = "Игрок отключился, раунд остановлен. Хост может начать заново.";
    }
    return room;
  }

  roomIdForSocket(socketId: string) {
    return this.socketRooms.get(socketId);
  }

  startGame(roomId: string, socketId: string) {
    const room = this.getRoom(roomId);
    this.assertHost(room, socketId);
    if (room.players.length < 2) throw new GameError("Нужно минимум 2 игрока");
    room.players = room.players.map((player) => ({ ...player, penalty: 0, eliminated: false, bank: [], hand: [] }));
    return this.startRound(room, 0, 1);
  }

  nextRound(roomId: string, socketId: string) {
    const room = this.getRoom(roomId);
    this.assertHost(room, socketId);
    if (room.phase !== "round_result") throw new GameError("Следующий раунд доступен после итогов");
    const dealerIndex = room.lastTrickWinnerId ? this.playerIndex(room, room.lastTrickWinnerId) : this.nextActiveIndex(room, room.dealerIndex);
    return this.startRound(room, dealerIndex, room.roundNo + 1);
  }

  lead(roomId: string, socketId: string, cardIds: string[]) {
    const room = this.getRoom(roomId);
    this.assertPlaying(room);
    const player = this.currentPlayer(room, socketId);
    if (room.leadCards.length > 0) throw new GameError("Сейчас нужно отвечать на ход");
    const { selected, rest } = takeCards(player.hand, cardIds);
    if (!sameSuit(selected)) throw new GameError("Ходить можно одной мастью");
    if (room.forceTrumpLeadPlayerId) {
      if (room.forceTrumpLeadPlayerId !== player.id) throw new GameError("Сейчас внеочередной ход у игрока с 4 козырями");
      if (selected.length !== handLimit || !selected.every((card) => card.suit === trump)) {
        throw new GameError("При 4 козырях нужно ходить всеми козырями");
      }
      room.unbeatableLead = true;
      room.forceTrumpLeadPlayerId = undefined;
    } else {
      room.unbeatableLead = false;
    }
    player.hand = rest;
    room.leaderId = player.id;
    room.currentWinnerId = player.id;
    room.leadCards = selected;
    room.responderOrder = this.clockwisePlayerIds(room, room.activePlayerIndex).filter((id) => id !== player.id);
    room.responderCursor = 0;
    room.table.push({ playerId: player.id, playerName: player.name, cards: selected, faceDown: false, action: "lead" });
    const nextId = room.responderOrder[0];
    room.activePlayerIndex = nextId ? this.playerIndex(room, nextId) : room.activePlayerIndex;
    room.message = room.unbeatableLead
      ? `${player.name} ходит 4 козырями. Этот ход нельзя побить, остальные сбрасывают карты.`
      : `${player.name} сделал ход. ${room.players[room.activePlayerIndex].name} отвечает.`;
    return room;
  }

  beat(roomId: string, socketId: string, cardIds: string[]) {
    return this.respond(roomId, socketId, cardIds, "beat");
  }

  discard(roomId: string, socketId: string, cardIds: string[]) {
    return this.respond(roomId, socketId, cardIds, "discard");
  }

  getRoom(roomId: string) {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) throw new GameError("Комната не найдена");
    return room;
  }

  snapshot(room: Room, viewerId: string, origin?: string): RoomSnapshot {
    const viewer = room.players.find((player) => player.id === viewerId);
    return {
      ...room,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        isHost: player.isHost,
        penalty: player.penalty,
        eliminated: player.eliminated,
        handCount: player.hand.length,
        bankPoints: room.phase === "round_result" || room.phase === "game_over" ? handPoints(player.bank) : undefined,
        isYou: player.id === viewerId,
      })),
      selfId: viewerId,
      selfHand: viewer?.hand ?? [],
      deckCount: room.deck.length,
      inviteUrl: origin ? `${origin}/room/${room.id}` : undefined,
    };
  }

  private respond(roomId: string, socketId: string, cardIds: string[], action: "beat" | "discard") {
    const room = this.getRoom(roomId);
    this.assertPlaying(room);
    const player = this.currentPlayer(room, socketId);
    if (room.leadCards.length === 0) throw new GameError("Сейчас нужно сделать ход");
    const requiredCount = Math.min(room.leadCards.length, player.hand.length);
    const { selected, rest } = takeCards(player.hand, cardIds);
    if (selected.length !== requiredCount) throw new GameError(`Нужно выбрать ${requiredCount} карт`);
    if (action === "beat" && room.unbeatableLead) throw new GameError("4 козыря нельзя побить, можно только сбросить");
    if (action === "beat" && !canBeatSet(room.leadCards, selected)) throw new GameError("Этими картами нельзя побить ход");
    player.hand = rest;
    if (action === "beat") room.currentWinnerId = player.id;
    room.table.push({ playerId: player.id, playerName: player.name, cards: selected, faceDown: action === "discard", action });

    const nextCursor = room.responderCursor + 1;
    const nextResponderId = room.responderOrder[nextCursor];
    if (nextResponderId) {
      room.responderCursor = nextCursor;
      room.activePlayerIndex = this.playerIndex(room, nextResponderId);
      room.message = `${player.name} ${action === "beat" ? "побил" : "сбросил карты"}. ${room.players[room.activePlayerIndex].name} отвечает.`;
      return room;
    }

    const winnerId = room.currentWinnerId ?? room.leaderId ?? player.id;
    room.phase = "trick_result";
    room.pendingTrickWinnerId = winnerId;
    room.activePlayerIndex = this.playerIndex(room, winnerId);
    room.message = `${room.players[room.activePlayerIndex].name} забирает взятку. Запомните открытые карты.`;
    return room;
  }

  collectPendingTrick(roomId: string) {
    const room = this.getRoom(roomId);
    if (room.phase !== "trick_result" || !room.pendingTrickWinnerId) return room;
    return this.collectTrick(room, room.pendingTrickWinnerId);
  }

  private collectTrick(room: Room, winnerId: string) {
    const trickCards = room.table.flatMap((entry) => entry.cards);
    const winner = room.players[this.playerIndex(room, winnerId)];
    winner.bank.push(...trickCards);
    const drawn = drawToFour(room.players, room.deck, winnerId, (id) => this.playerIndex(room, id), (index) => this.nextActiveIndex(room, index));
    room.players = drawn.players;
    room.deck = drawn.deck;
    room.activePlayerIndex = this.playerIndex(room, winnerId);
    room.lastTrickWinnerId = winnerId;
    room.leaderId = undefined;
    room.currentWinnerId = undefined;
    room.leadCards = [];
    room.responderOrder = [];
    room.responderCursor = 0;
    room.table = [];
    room.pendingTrickWinnerId = undefined;
    room.unbeatableLead = false;
    room.forceTrumpLeadPlayerId = undefined;
    room.phase = "playing";
    room.message = `${winner.name} забирает взятку и ходит следующим.`;

    if (room.deck.length === 0 && this.activePlayers(room).every((player) => player.hand.length === 0)) {
      return this.finishRound(room);
    }
    const instantWinner = this.findInstantWinner(room);
    if (instantWinner) {
      room.phase = "game_over";
      room.activePlayerIndex = this.playerIndex(room, instantWinner.id);
      room.summary = { points: {}, penalties: {}, eggs: false, instantWinnerId: instantWinner.id, instantName: instantWinner.name };
      room.message = hasFourOfRank(instantWinner, "9") ? "Сопливый козел: четыре девятки." : "Генеральский козел: четыре туза.";
      return room;
    }
    const fourTrumpPlayer = this.findFourTrumpPlayer(room);
    if (fourTrumpPlayer) {
      room.activePlayerIndex = this.playerIndex(room, fourTrumpPlayer.id);
      room.forceTrumpLeadPlayerId = fourTrumpPlayer.id;
      room.message = `${fourTrumpPlayer.name} собрал 4 козыря и ходит вне очереди. Такой ход нельзя побить.`;
    }
    return room;
  }

  private startRound(room: Room, dealerIndex: number, roundNo: number) {
    room.phase = "playing";
    room.deck = shuffle(createDeck());
    room.dealerIndex = dealerIndex;
    room.roundNo = roundNo;
    room.table = [];
    room.leadCards = [];
    room.responderOrder = [];
    room.responderCursor = 0;
    room.forceTrumpLeadPlayerId = undefined;
    room.unbeatableLead = false;
    room.summary = undefined;
    room.players = room.players.map((player) => ({ ...player, hand: [], bank: [] }));
    for (let cardNo = 0; cardNo < handLimit; cardNo += 1) {
      for (const player of room.players) if (!player.eliminated) player.hand.push(room.deck.shift()!);
    }

    const instant = this.findInstantWinner(room);
    if (instant) {
      room.phase = "game_over";
      room.activePlayerIndex = this.playerIndex(room, instant.id);
      room.summary = { points: {}, penalties: {}, eggs: false, instantWinnerId: instant.id, instantName: instant.name };
      room.message = hasFourOfRank(instant, "9") ? "Сопливый козел: четыре девятки." : "Генеральский козел: четыре туза.";
      return room;
    }

    const fourTrump = room.players.find((player) => !player.eliminated && hasFourTrumps(player));
    room.activePlayerIndex = fourTrump ? this.playerIndex(room, fourTrump.id) : this.nextActiveIndex(room, dealerIndex);
    room.forceTrumpLeadPlayerId = fourTrump?.id;
    room.message = fourTrump
      ? `${fourTrump.name} собрал 4 козыря и ходит вне очереди. Такой ход нельзя побить.`
      : `Первым ходит ${room.players[room.activePlayerIndex].name}.`;
    return room;
  }

  private finishRound(room: Room) {
    const points: Record<string, number> = {};
    const penalties: Record<string, number> = {};
    const contenders = this.activePlayers(room);
    for (const player of contenders) points[player.id] = handPoints(player.bank);
    const values = contenders.map((player) => points[player.id]);
    const eggs = values.length > 0 && values.every((value) => value === values[0]);
    if (!eggs) {
      const over31 = contenders.filter((player) => points[player.id] > 31);
      const maxOver31 = over31.length > 0 ? Math.max(...over31.map((player) => points[player.id])) : 0;
      for (const player of contenders) {
        const score = points[player.id];
        let penalty = 0;
        if (score === 0) penalty = 6;
        else if (score < 31) penalty = 4;
        else if (score > 31 && score < maxOver31) penalty = 2;
        penalties[player.id] = penalty;
        player.penalty += penalty;
        if (player.penalty >= maxPenalty) player.eliminated = true;
      }
    } else {
      for (const player of contenders) penalties[player.id] = 0;
    }
    room.summary = { points, penalties, eggs };
    const survivors = this.activePlayers(room);
    room.phase = survivors.length <= 1 ? "game_over" : "round_result";
    room.message = room.phase === "game_over" ? `Победитель: ${survivors[0]?.name ?? "нет"}.` : eggs ? "Яйца: штрафов нет." : "Раунд завершен.";
    return room;
  }

  private createPlayer(socketId: string, name: string, isHost: boolean): Player {
    const trimmed = name.trim();
    if (!trimmed) throw new GameError("Введите имя");
    return { id: socketId, name: trimmed.slice(0, 24), isHost, hand: [], bank: [], penalty: 0, eliminated: false };
  }

  private assertHost(room: Room, socketId: string) {
    if (!room.players.find((player) => player.id === socketId)?.isHost) throw new GameError("Доступно только хосту");
  }

  private assertPlaying(room: Room) {
    if (room.phase !== "playing") throw new GameError("Раунд сейчас не идет");
  }

  private currentPlayer(room: Room, socketId: string) {
    const player = room.players[room.activePlayerIndex];
    if (!player || player.id !== socketId) throw new GameError("Сейчас ходит другой игрок");
    return player;
  }

  private activePlayers(room: Room) {
    return room.players.filter((player) => !player.eliminated);
  }

  private nextActiveIndex(room: Room, fromIndex: number) {
    for (let offset = 1; offset <= room.players.length; offset += 1) {
      const index = (fromIndex + offset) % room.players.length;
      if (!room.players[index].eliminated) return index;
    }
    return fromIndex;
  }

  private clockwisePlayerIds(room: Room, fromIndex: number) {
    const ids: string[] = [];
    for (let offset = 1; offset <= room.players.length; offset += 1) {
      const player = room.players[(fromIndex + offset) % room.players.length];
      if (!player.eliminated) ids.push(player.id);
    }
    return ids;
  }

  private playerIndex(room: Room, playerId: string) {
    const index = room.players.findIndex((player) => player.id === playerId);
    return index >= 0 ? index : 0;
  }

  private findFourTrumpPlayer(room: Room) {
    return room.players.find((player) => !player.eliminated && hasFourTrumps(player));
  }

  private findInstantWinner(room: Room) {
    return room.players.find((player) => !player.eliminated && (hasFourOfRank(player, "9") || hasFourOfRank(player, "A")));
  }

  private createRoomId() {
    let id = "";
    do id = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    while (this.rooms.has(id));
    return id;
  }
}

function createDeck(): Card[] {
  return suits.flatMap((suit) => ranks.map((rank) => ({ id: `${rank}-${suit}`, rank, suit })));
}
function shuffle<T>(items: T[]) {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}
function takeCards(hand: Card[], ids: string[]) {
  const unique = [...new Set(ids)];
  const selected = hand.filter((card) => unique.includes(card.id));
  if (selected.length !== unique.length || selected.length === 0) throw new GameError("Выберите карты из руки");
  return { selected, rest: hand.filter((card) => !unique.includes(card.id)) };
}
function sameSuit(cards: Card[]) {
  return cards.length > 0 && cards.every((card) => card.suit === cards[0].suit);
}
function beats(attack: Card, defense: Card) {
  if (attack.suit === defense.suit) return rankPower[defense.rank] > rankPower[attack.rank];
  return defense.suit === trump && attack.suit !== trump;
}
function canBeatSet(attackCards: Card[], defenseCards: Card[]) {
  if (attackCards.length !== defenseCards.length) return false;
  const remaining = [...defenseCards].sort((a, b) => rankPower[a.rank] - rankPower[b.rank]);
  for (const attack of [...attackCards].sort((a, b) => rankPower[a.rank] - rankPower[b.rank])) {
    const index = remaining.findIndex((defense) => beats(attack, defense));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}
function handPoints(cards: Card[]) {
  return cards.reduce((sum, card) => sum + cardPoints[card.rank], 0);
}
function hasFourOfRank(player: Player, rank: Rank) {
  return player.hand.length === 4 && player.hand.every((card) => card.rank === rank);
}
function hasFourTrumps(player: Player) {
  return player.hand.length === 4 && player.hand.every((card) => card.suit === trump);
}
function drawToFour(players: Player[], deck: Card[], startPlayerId: string, indexById: (id: string) => number, nextActiveIndex: (index: number) => number) {
  const nextPlayers = players.map((player) => ({ ...player, hand: [...player.hand] }));
  const nextDeck = [...deck];
  let index = indexById(startPlayerId);
  for (let loops = 0; loops < nextPlayers.length * handLimit; loops += 1) {
    const player = nextPlayers[index];
    if (!player.eliminated && player.hand.length < handLimit && nextDeck.length > 0) player.hand.push(nextDeck.shift()!);
    index = nextActiveIndex(index);
    if (nextDeck.length === 0 || nextPlayers.filter((p) => !p.eliminated).every((p) => p.hand.length >= handLimit)) break;
  }
  return { players: nextPlayers, deck: nextDeck };
}
