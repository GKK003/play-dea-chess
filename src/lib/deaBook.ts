import { Chess } from 'chess.js';
import {
  deaPgnPlayerName,
  type DeaColor,
  type DeaMoveBook,
  type DeaMoveStat,
  type DeaStyleProfile,
  type DeaTrainingData,
} from '@/data/deaGames';

function stripHeaders(pgn: string) {
  return pgn
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/1-0|0-1|1\/2-1\/2|\*/g, ' ')
    .trim();
}

function getHeaderValue(pgn: string, header: string) {
  return pgn.match(new RegExp(`^\\[${header} "([^"]*)"\\]`, 'm'))?.[1];
}

export function positionKey(fen: string) {
  return fen.split(' ').slice(0, 4).join(' ');
}

function updateResult(stat: DeaMoveStat, result: string | undefined, deaColor: DeaColor) {
  const deaWon = deaColor === 'w' ? result === '1-0' : result === '0-1';
  const deaLost = deaColor === 'w' ? result === '0-1' : result === '1-0';

  if (deaWon) stat.wins += 1;
  else if (deaLost) stat.losses += 1;
  else stat.draws += 1;
}

export function buildDeaBook(pgnArchive: string, deaColor: DeaColor = 'b'): DeaTrainingData {
  const book: DeaMoveBook = {};
  const profile: DeaStyleProfile = {
    totalMoves: 0,
    captures: 0,
    checks: 0,
    castles: 0,
    pieceMoves: {},
    pawnFiles: {},
  };
  const games = pgnArchive.split(/(?=^\[Event\s+")/m).filter((pgn) => pgn.trim());
  let gamesUsed = 0;
  const deaHeader = deaColor === 'w' ? 'White' : 'Black';

  for (const pgn of games) {
    if (getHeaderValue(pgn, deaHeader) !== deaPgnPlayerName || getHeaderValue(pgn, 'Variant') !== 'Standard') {
      continue;
    }

    gamesUsed += 1;
    const result = getHeaderValue(pgn, 'Result');
    const chess = new Chess();
    const tokens = stripHeaders(pgn).split(/\s+/).filter(Boolean);

    for (const san of tokens) {
      const fenBefore = positionKey(chess.fen());
      const isDeaMove = chess.turn() === deaColor;
      let move;

      try {
        move = chess.move(san, { strict: false });
      } catch {
        break;
      }

      if (!isDeaMove) continue;

      if (!book[fenBefore]) book[fenBefore] = {};
      if (!book[fenBefore][move.san]) {
        book[fenBefore][move.san] = { san: move.san, plays: 0, wins: 0, draws: 0, losses: 0 };
      }

      const stat = book[fenBefore][move.san];
      stat.plays += 1;
      updateResult(stat, result, deaColor);

      profile.totalMoves += 1;
      profile.pieceMoves[move.piece] = (profile.pieceMoves[move.piece] ?? 0) + 1;

      if (move.piece === 'p') {
        const file = move.to[0];
        profile.pawnFiles[file] = (profile.pawnFiles[file] ?? 0) + 1;
      }

      if (move.isCapture()) profile.captures += 1;
      if (move.isKingsideCastle() || move.isQueensideCastle()) profile.castles += 1;
      if (move.san.includes('+') || move.san.includes('#')) profile.checks += 1;
    }
  }

  return { book, profile, gamesUsed };
}
