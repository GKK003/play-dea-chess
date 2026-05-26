import { Chess, type Move } from 'chess.js';
import { positionKey } from '@/lib/deaBook';
import type { DeaMoveBook, DeaMoveStat, DeaStyleProfile } from '@/data/deaGames';

const MATE_SCORE = 100000;
const SEARCH_TIME_MS = 700;

const pieceValue: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};

const pieceSquare: Record<string, number[]> = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 5, 5, 0, 0, 0,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    5, 10, 10, 10, 10, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

export type DeaDecision = {
  san: string;
  depth: number;
  score: number;
  nodes: number;
  recordedPlays: number;
  calculator: 'Stockfish' | 'Opening memory' | 'Local search';
};

export type SignatureOpeningMove = {
  san: string;
  plays: number;
  share: number;
};

type SearchState = {
  deadline: number;
  nodes: number;
  stopped: boolean;
};

function evaluatePosition(chess: Chess, ply = 0) {
  if (chess.isCheckmate()) return chess.turn() === 'w' ? MATE_SCORE - ply : -MATE_SCORE + ply;
  if (chess.isDraw()) return 0;

  let score = 0;

  chess.board().forEach((row, rowIndex) => {
    row.forEach((piece, fileIndex) => {
      if (!piece) return;

      const tableIndex = piece.color === 'w'
        ? rowIndex * 8 + fileIndex
        : (7 - rowIndex) * 8 + fileIndex;
      const value = pieceValue[piece.type] + pieceSquare[piece.type][tableIndex];

      score += piece.color === 'b' ? value : -value;
    });
  });

  if (chess.isCheck()) score += chess.turn() === 'w' ? 30 : -30;

  return score;
}

function moveOrdering(move: Move) {
  let score = 0;
  if (move.isCapture()) score += 10 * pieceValue[move.captured ?? 'p'] - pieceValue[move.piece];
  if (move.isPromotion()) score += pieceValue[move.promotion ?? 'q'];
  if (move.san.includes('#')) score += MATE_SCORE;
  else if (move.san.includes('+')) score += 40;
  if (move.isKingsideCastle() || move.isQueensideCastle()) score += 25;
  return score;
}

function search(chess: Chess, depth: number, alpha: number, beta: number, ply: number, state: SearchState): number {
  state.nodes += 1;
  if (state.nodes % 128 === 0 && performance.now() >= state.deadline) {
    state.stopped = true;
    return evaluatePosition(chess, ply);
  }

  if (depth === 0 || chess.isGameOver()) return evaluatePosition(chess, ply);

  const maximizing = chess.turn() === 'b';
  const moves = chess.moves({ verbose: true }).sort((a, b) => moveOrdering(b) - moveOrdering(a));
  let best = maximizing ? -Infinity : Infinity;

  for (const move of moves) {
    chess.move(move.san);
    const score = search(chess, depth - 1, alpha, beta, ply + 1, state);
    chess.undo();

    if (state.stopped) return score;

    if (maximizing) {
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, score);
      beta = Math.min(beta, best);
    }

    if (beta <= alpha) break;
  }

  return best;
}

function recordedStyleBonus(stat: DeaMoveStat | undefined) {
  if (!stat) return 0;

  const familiarity = Math.min(42, Math.log2(stat.plays + 1) * 12);
  const results = ((stat.wins - stat.losses) / stat.plays) * 22;
  return familiarity + results;
}

function generalStyleBonus(move: Move, profile: DeaStyleProfile) {
  if (!profile.totalMoves) return 0;

  let bonus = ((profile.pieceMoves[move.piece] ?? 0) / profile.totalMoves) * 10;
  if (move.piece === 'p') {
    bonus += ((profile.pawnFiles[move.to[0]] ?? 0) / profile.totalMoves) * 18;
  }
  if (move.isCapture()) bonus += (profile.captures / profile.totalMoves) * 14;
  if (move.isKingsideCastle() || move.isQueensideCastle()) bonus += (profile.castles / profile.totalMoves) * 35;
  if (move.san.includes('+') || move.san.includes('#')) bonus += (profile.checks / profile.totalMoves) * 18;

  return bonus;
}

export function getRecordedPlays(chess: Chess, san: string, book: DeaMoveBook) {
  return book[positionKey(chess.fen())]?.[san]?.plays ?? 0;
}

export function getSignatureOpeningMove(chess: Chess, book: DeaMoveBook): SignatureOpeningMove | null {
  const fullmoveNumber = Number(chess.fen().split(' ')[5]);
  if (fullmoveNumber > 12) return null;

  const stats = Object.values(book[positionKey(chess.fen())] ?? {});
  if (!stats.length) return null;

  const totalPlays = stats.reduce((total, stat) => total + stat.plays, 0);
  const mostPlayed = stats.reduce((best, stat) => (stat.plays > best.plays ? stat : best));
  const share = mostPlayed.plays / totalPlays;

  if (mostPlayed.plays < 8 || share < 0.6) return null;

  return {
    san: mostPlayed.san,
    plays: mostPlayed.plays,
    share,
  };
}

export function chooseSignatureOpeningMove(chess: Chess, book: DeaMoveBook): DeaDecision | null {
  const move = getSignatureOpeningMove(chess, book);
  if (!move) return null;

  return {
    san: move.san,
    depth: 0,
    score: 0,
    nodes: 0,
    recordedPlays: move.plays,
    calculator: 'Opening memory',
  };
}

export function getDeaStyleBonus(chess: Chess, move: Move, book: DeaMoveBook, profile: DeaStyleProfile) {
  const stat = book[positionKey(chess.fen())]?.[move.san];
  return recordedStyleBonus(stat) + generalStyleBonus(move, profile);
}

function rootScore(
  chess: Chess,
  move: Move,
  depth: number,
  book: DeaMoveBook,
  profile: DeaStyleProfile,
  state: SearchState,
) {
  const stat = book[positionKey(chess.fen())]?.[move.san];
  chess.move(move.san);
  const calculated = search(chess, depth - 1, -Infinity, Infinity, 1, state);
  chess.undo();

  return {
    score: calculated + getDeaStyleBonus(chess, move, book, profile),
    recordedPlays: stat?.plays ?? 0,
  };
}

export function chooseDeaMove(chess: Chess, book: DeaMoveBook, profile: DeaStyleProfile): DeaDecision | null {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;

  const piecesOnBoard = chess.board().flat().filter(Boolean).length;
  const maximumDepth = piecesOnBoard <= 12 ? 4 : 3;
  const state: SearchState = {
    deadline: performance.now() + SEARCH_TIME_MS,
    nodes: 0,
    stopped: false,
  };
  const ordered = moves.sort((a, b) => moveOrdering(b) - moveOrdering(a));
  let completed: DeaDecision | null = null;

  for (let depth = 1; depth <= maximumDepth; depth += 1) {
    let bestAtDepth: DeaDecision | null = null;

    for (const move of ordered) {
      const result = rootScore(chess, move, depth, book, profile, state);
      if (state.stopped) break;

      if (!bestAtDepth || result.score > bestAtDepth.score) {
        bestAtDepth = {
          san: move.san,
          depth,
          score: Math.round(result.score),
          nodes: state.nodes,
          recordedPlays: result.recordedPlays,
          calculator: 'Local search',
        };
      }
    }

    if (state.stopped) break;
    if (bestAtDepth) completed = bestAtDepth;
  }

  return completed ?? {
    san: ordered[0].san,
    depth: 0,
    score: 0,
    nodes: state.nodes,
    recordedPlays: book[positionKey(chess.fen())]?.[ordered[0].san]?.plays ?? 0,
    calculator: 'Local search',
  };
}
