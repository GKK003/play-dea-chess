import { Chess } from 'chess.js';
import { deaPgnPlayerName, type DeaMoveBook, type DeaMoveStat, type DeaStyleProfile } from '@/data/deaGames';

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

function updateResult(stat: DeaMoveStat, result: string | undefined) {
  if (result === '0-1') stat.wins += 1;
  else if (result === '1-0') stat.losses += 1;
  else stat.draws += 1;
}

export function buildDeaBook(pgnArchive: string) {
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

  for (const pgn of games) {
    if (getHeaderValue(pgn, 'Black') !== deaPgnPlayerName || getHeaderValue(pgn, 'Variant') !== 'Standard') {
      continue;
    }

    gamesUsed += 1;
    const result = getHeaderValue(pgn, 'Result');
    const chess = new Chess();
    const tokens = stripHeaders(pgn).split(/\s+/).filter(Boolean);

    for (const san of tokens) {
      const fenBefore = positionKey(chess.fen());
      const isDeaMove = chess.turn() === 'b';
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
      updateResult(stat, result);

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
