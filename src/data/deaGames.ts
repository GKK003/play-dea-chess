export type DeaMoveStat = {
  san: string;
  plays: number;
  wins: number;
  draws: number;
  losses: number;
};

export type DeaMoveBook = Record<string, Record<string, DeaMoveStat>>;

export type DeaColor = 'w' | 'b';

export type DeaStyleProfile = {
  totalMoves: number;
  captures: number;
  checks: number;
  castles: number;
  pieceMoves: Record<string, number>;
  pawnFiles: Record<string, number>;
};

export type DeaTrainingData = {
  book: DeaMoveBook;
  profile: DeaStyleProfile;
  gamesUsed: number;
};

export const deaPgnAssetPath = '/dea-games.pgn';
export const deaPgnPlayerName = 'Deiko27';
