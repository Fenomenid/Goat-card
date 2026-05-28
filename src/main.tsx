import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import "./styles.css";

type Suit = "clubs" | "spades" | "hearts" | "diamonds";
type Rank = "9" | "J" | "Q" | "K" | "10" | "A";
type Phase = "lobby" | "playing" | "trick_result" | "round_result" | "game_over";
type TableAction = "lead" | "beat" | "discard";
type Card = { id: string; suit: Suit; rank: Rank };
type PlayerView = { id: string; name: string; isHost: boolean; penalty: number; eliminated: boolean; handCount: number; bankPoints?: number; isYou: boolean };
type TableEntry = { playerId: string; playerName: string; cards: Card[]; faceDown: boolean; action: TableAction };
type RoundSummary = { points: Record<string, number>; penalties: Record<string, number>; eggs: boolean; instantWinnerId?: string; instantName?: string };
type RoomSnapshot = {
  id: string;
  phase: Phase;
  players: PlayerView[];
  selfId: string;
  selfHand: Card[];
  deckCount: number;
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
  summary?: RoundSummary;
  inviteUrl?: string;
};

const socketUrl = import.meta.env.VITE_SERVER_URL ?? (import.meta.env.DEV ? "http://localhost:3001" : window.location.origin);
const socket = io(socketUrl);
const suitSymbols: Record<Suit, string> = { clubs: "♣", spades: "♠", hearts: "♥", diamonds: "♦" };
const suitNames: Record<Suit, string> = { clubs: "крести", spades: "пики", hearts: "черви", diamonds: "бубны" };
const rankPower: Record<Rank, number> = { "9": 1, J: 2, Q: 3, K: 4, "10": 5, A: 6 };
const trump: Suit = "diamonds";

function App() {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [playerName, setPlayerName] = useState(localStorage.getItem("goatName") ?? "");
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const roomIdFromUrl = useMemo(() => window.location.pathname.match(/\/room\/([A-Za-z0-9]+)/)?.[1]?.toUpperCase() ?? "", []);
  const self = room?.players.find((player) => player.isYou);
  const isHost = Boolean(self?.isHost);
  const currentPlayer = room?.players[room.activePlayerIndex];
  const isMyTurn = Boolean(room && currentPlayer?.id === room.selfId && (room.phase === "playing" || room.phase === "trick_result"));
  const selectedCards = room ? room.selfHand.filter((card) => selectedIds.includes(card.id)) : [];
  const isLeading = Boolean(room && room.leadCards.length === 0);
  const requiredCount = room ? Math.min(room.leadCards.length, room.selfHand.length) : 0;
  const canLead = isMyTurn && isLeading && selectedCards.length > 0 && sameSuit(selectedCards);
  const canDiscard = isMyTurn && !isLeading && selectedCards.length === requiredCount;
  const canBeat = isMyTurn && !isLeading && canBeatSet(room?.leadCards ?? [], selectedCards);

  useEffect(() => {
    socket.on("room", (snapshot: RoomSnapshot) => {
      setRoom(snapshot);
      setError("");
      setSelectedIds([]);
      if (!window.location.pathname.includes(`/room/${snapshot.id}`)) {
        window.history.replaceState(null, "", `/room/${snapshot.id}`);
      }
    });
    socket.on("error", ({ message }: { message: string }) => setError(message));
    return () => {
      socket.off("room");
      socket.off("error");
    };
  }, []);

  function rememberName() {
    localStorage.setItem("goatName", playerName.trim());
  }

  function createRoom() {
    rememberName();
    socket.emit("room:create", { playerName });
  }

  function joinRoom() {
    rememberName();
    socket.emit("room:join", { roomId: roomIdFromUrl, playerName });
  }

  async function copyInvite() {
    if (!room) return;
    await navigator.clipboard.writeText(room.inviteUrl ?? `${window.location.origin}/room/${room.id}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  }

  function toggleCard(cardId: string) {
    if (!isMyTurn) return;
    setSelectedIds((current) => current.includes(cardId) ? current.filter((id) => id !== cardId) : [...current, cardId]);
  }

  function emitAction(event: "cards:lead" | "cards:beat" | "cards:discard") {
    if (!room) return;
    socket.emit(event, { roomId: room.id, cardIds: selectedIds });
  }

  if (!room) {
    return (
      <main className="app-shell auth-shell">
        <section className="hero auth-hero">
          <div>
            <p className="eyebrow">Сетевая карточная игра</p>
            <h1>Козел 32</h1>
            <p className="muted">Создайте комнату, отправьте ссылку и играйте с разных браузеров.</p>
          </div>
          <div className="deck-visual" aria-hidden="true"><div className="float-card card-a">A♦</div><div className="float-card card-k">K♠</div><div className="float-card card-9">9♣</div></div>
        </section>
        <section className="setup-panel auth-panel">
          <label className="field"><span>Ваше имя</span><input value={playerName} onChange={(event) => setPlayerName(event.target.value)} placeholder="Например, Макс" /></label>
          {roomIdFromUrl ? <button className="primary" onClick={joinRoom}>Войти в комнату {roomIdFromUrl}</button> : <button className="primary" onClick={createRoom}>Создать комнату</button>}
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><p className="eyebrow">Комната {room.id}</p><h1>Козел 32</h1><p className="muted">Вы: <strong>{self?.name}</strong></p></div>
        <button className="secondary" onClick={copyInvite}>{copied ? "Ссылка скопирована" : "Пригласить"}</button>
      </header>
      {error && <p className="error">{error}</p>}
      <section className="game-layout">
        <aside className="scoreboard">
          <div className="panel-title compact-title"><h2>Игроки</h2></div>
          <div className="players-list">{room.players.map((player, index) => <PlayerRow key={player.id} player={player} active={index === room.activePlayerIndex && (room.phase === "playing" || room.phase === "trick_result")} />)}</div>
          <div className="rules-card"><strong>Козырь: ♦ бубны</strong><span>9=0 · J=2 · Q=3 · K=4 · 10=10 · A=11</span></div>
        </aside>
        <section className="table-panel">
          {room.phase === "lobby" && <Lobby room={room} isHost={isHost} />}
          {(room.phase === "playing" || room.phase === "trick_result") && (
            <>
              <div className="table-topline"><div><p className="eyebrow">Ход</p><h2>{currentPlayer?.isYou ? "Ваш ход" : currentPlayer?.name}</h2></div><p className="notice">{room.message}</p></div>
              <FeltTable table={room.table} resolving={room.phase === "trick_result"} />
              {room.phase === "playing" && <HandPanel hand={room.selfHand} selectedIds={selectedIds} isMyTurn={isMyTurn} isLeading={isLeading} requiredCount={requiredCount} canLead={canLead} canBeat={canBeat} canDiscard={canDiscard} onToggle={toggleCard} onLead={() => emitAction("cards:lead")} onBeat={() => emitAction("cards:beat")} onDiscard={() => emitAction("cards:discard")} />}
            </>
          )}
          {room.phase === "round_result" && <RoundResult room={room} isHost={isHost} />}
          {room.phase === "game_over" && <GameOver room={room} isHost={isHost} />}
        </section>
      </section>
    </main>
  );
}

function Lobby({ room, isHost }: { room: RoomSnapshot; isHost: boolean }) {
  return <div className="result-panel"><p className="eyebrow">Лобби</p><h2>Ожидание игроков</h2><p className="notice">Нужно 2-4 игрока. Сейчас: {room.players.length}.</p>{isHost ? <button className="primary" disabled={room.players.length < 2} onClick={() => socket.emit("game:start", { roomId: room.id })}>Раздать карты</button> : <p className="muted">Хост начнет игру.</p>}</div>;
}

function FeltTable({ table, resolving }: { table: TableEntry[]; resolving: boolean }) {
  return <div className={`felt-table ${resolving ? "resolving" : ""}`}><div className="table-center">{table.length === 0 ? <p className="empty-table">Стол пуст</p> : table.map((entry, index) => <div className={`trick-entry ${entry.action}`} key={`${entry.playerId}-${index}`} style={{ animationDelay: `${index * 80}ms` }}><span>{entry.playerName}: {entry.action === "lead" ? "ход" : entry.action === "beat" ? "бьет" : "сброс"}</span><div className="mini-cards">{entry.cards.map((card) => <CardView key={card.id} card={card} faceDown={entry.faceDown} mini />)}</div></div>)}</div></div>;
}

function HandPanel(props: { hand: Card[]; selectedIds: string[]; isMyTurn: boolean; isLeading: boolean; requiredCount: number; canLead: boolean; canBeat: boolean; canDiscard: boolean; onToggle: (id: string) => void; onLead: () => void; onBeat: () => void; onDiscard: () => void }) {
  const hint = props.isMyTurn ? (props.isLeading ? "Выберите одну или несколько карт одной масти." : `Выберите ${props.requiredCount} карт, чтобы побить или сбросить.`) : "Ждите своего хода.";
  return <div className="hand-panel"><div className="hand-header"><div><strong>{hint}</strong><p className="muted">Ваши карты: {props.hand.length}</p></div><div className="actions">{props.isLeading ? <button className="primary" disabled={!props.canLead} onClick={props.onLead}>Сделать ход</button> : <><button className="primary" disabled={!props.canBeat} onClick={props.onBeat}>Побить</button><button className="secondary" disabled={!props.canDiscard} onClick={props.onDiscard}>Сбросить</button></>}</div></div><div className="hand-row">{props.hand.map((card, index) => <button className={`card-button ${props.selectedIds.includes(card.id) ? "selected" : ""}`} key={card.id} disabled={!props.isMyTurn} onClick={() => props.onToggle(card.id)} style={{ animationDelay: `${index * 55}ms` }}><CardView card={card} /></button>)}</div></div>;
}

function PlayerRow({ player, active }: { player: PlayerView; active: boolean }) {
  return <div className={`player-row ${active ? "active" : ""} ${player.eliminated ? "eliminated" : ""}`}><div><strong>{player.name}{player.isYou ? " (Вы)" : ""}{player.isHost ? " · хост" : ""}</strong><span>{player.eliminated ? "выбыл" : `${player.handCount} карт · ${player.bankPoints === undefined ? "банк скрыт" : `банк ${player.bankPoints}`}`}</span></div><b>{player.penalty}</b></div>;
}

function RoundResult({ room, isHost }: { room: RoomSnapshot; isHost: boolean }) {
  const summary = room.summary;
  if (!summary) return null;
  return <div className="result-panel"><p className="eyebrow">Итоги раунда</p><h2>{summary.eggs ? "Яйца" : "Штрафы начислены"}</h2><p className="notice">{room.message}</p><div className="result-grid">{room.players.map((player) => <div className="result-row" key={player.id}><strong>{player.name}</strong><span>{summary.points[player.id] ?? 0} очков</span><b>+{summary.penalties[player.id] ?? 0}</b></div>)}</div>{isHost && <button className="primary" onClick={() => socket.emit("round:next", { roomId: room.id })}>Следующий раунд</button>}</div>;
}

function GameOver({ room, isHost }: { room: RoomSnapshot; isHost: boolean }) {
  const winner = room.summary?.instantWinnerId ? room.summary.instantName : room.players.find((player) => !player.eliminated)?.name;
  return <div className="result-panel finale"><p className="eyebrow">Финал</p><h2>{winner ?? "Партия завершена"}</h2><p className="notice">{room.message}</p><div className="result-grid">{room.players.map((player) => <div className="result-row" key={player.id}><strong>{player.name}</strong><span>{player.eliminated ? "выбыл" : "в игре"}</span><b>{player.penalty}</b></div>)}</div>{isHost && <button className="primary" onClick={() => socket.emit("game:start", { roomId: room.id })}>Новая партия</button>}</div>;
}

function CardView({ card, faceDown, mini }: { card: Card; faceDown?: boolean; mini?: boolean }) {
  if (faceDown) return <div className={`playing-card back ${mini ? "mini" : ""}`}><span>◆</span></div>;
  const red = card.suit === "hearts" || card.suit === "diamonds";
  return <div className={`playing-card ${red ? "red" : "black"} ${card.suit === trump ? "trump" : ""} ${mini ? "mini" : ""}`}><div className="corner"><strong>{card.rank}</strong><span>{suitSymbols[card.suit]}</span></div><div className="suit-mark" aria-label={suitNames[card.suit]}>{suitSymbols[card.suit]}</div><div className="corner bottom"><strong>{card.rank}</strong><span>{suitSymbols[card.suit]}</span></div></div>;
}

function sameSuit(cards: Card[]) { return cards.length > 0 && cards.every((card) => card.suit === cards[0].suit); }
function beats(attack: Card, defense: Card) { if (attack.suit === defense.suit) return rankPower[defense.rank] > rankPower[attack.rank]; return defense.suit === trump && attack.suit !== trump; }
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

createRoot(document.getElementById("root")!).render(<App />);
