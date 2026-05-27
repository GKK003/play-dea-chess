import { Chess } from 'chess.js';
import { getDeaStyleBonus, getRecordedPlays, getSignatureOpeningMove, type DeaDecision } from '@/lib/bot';
import type { DeaMoveBook, DeaStyleProfile } from '@/data/deaGames';

const ENGINE_PATH = '/stockfish/stockfish-18-lite-single.js';
const STYLE_WINDOW_CP = 90;
const STYLE_BONUS_CAP = 65;
const SIGNATURE_OPENING_WINDOW_CP = 120;

type Candidate = {
  uci: string;
  depth: number;
  score: number;
  nodes: number;
};

type PendingAnalysis = {
  chess: Chess;
  book: DeaMoveBook;
  profile: DeaStyleProfile;
  candidates: Map<number, Candidate>;
  resolve: (decision: DeaDecision | null) => void;
};

function uciScore(kind: string, value: number) {
  if (kind === 'mate') return value > 0 ? 100000 - value : -100000 - value;
  return value;
}

function parseCandidate(line: string): { multipv: number; candidate: Candidate } | null {
  const variation = line.match(/\bmultipv (\d+).*?\bscore (cp|mate) (-?\d+).*?\bnodes (\d+).*?\bpv (\S+)/);
  const depth = line.match(/\bdepth (\d+)/)?.[1];
  if (!variation || !depth) return null;

  return {
    multipv: Number(variation[1]),
    candidate: {
      uci: variation[5],
      depth: Number(depth),
      score: uciScore(variation[2], Number(variation[3])),
      nodes: Number(variation[4]),
    },
  };
}

function moveFromUci(chess: Chess, uci: string) {
  try {
    return chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4, 5) || undefined,
    });
  } catch {
    return null;
  }
}

export class StockfishCalculator {
  private worker: Worker;
  private pending: PendingAnalysis | null = null;
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;

  constructor() {
    this.worker = new Worker(ENGINE_PATH);
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.worker.addEventListener('message', (event: MessageEvent<string>) => this.handleMessage(String(event.data)));
    this.worker.addEventListener('error', () => {
      this.readyReject(new Error('Stockfish failed to load.'));
      this.cancel();
    });
    this.worker.postMessage('uci');
  }

  private handleMessage(line: string) {
    if (line === 'uciok') {
      this.worker.postMessage('setoption name MultiPV value 10');
      this.worker.postMessage('isready');
      return;
    }

    if (line === 'readyok') {
      this.readyResolve();
      return;
    }

    if (!this.pending) return;

    if (line.startsWith('info ')) {
      const parsed = parseCandidate(line);
      if (parsed) this.pending.candidates.set(parsed.multipv, parsed.candidate);
      return;
    }

    if (line.startsWith('bestmove ')) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve(this.selectStyledCandidate(pending));
    }
  }

  private selectStyledCandidate(pending: PendingAnalysis): DeaDecision | null {
    const candidates = [...pending.candidates.values()];
    if (!candidates.length) return null;

    // Stockfish reports candidate scores for the root player; Dea is the side to move here.
    const strongest = Math.max(...candidates.map((candidate) => candidate.score));
    let chosen: { candidate: Candidate; san: string; combined: number } | null = null;

    for (const candidate of candidates) {
      if (candidate.score < strongest - STYLE_WINDOW_CP) continue;

      const board = new Chess(pending.chess.fen());
      const move = moveFromUci(board, candidate.uci);
      if (!move) continue;

      const styleBonus = Math.min(
        STYLE_BONUS_CAP,
        getDeaStyleBonus(pending.chess, move, pending.book, pending.profile),
      );
      const combined = candidate.score + styleBonus;

      if (!chosen || combined > chosen.combined) {
        chosen = { candidate, san: move.san, combined };
      }
    }

    const openingMove = getSignatureOpeningMove(pending.chess, pending.book);
    if (openingMove) {
      const candidate = candidates.find((option) => {
        const board = new Chess(pending.chess.fen());
        return moveFromUci(board, option.uci)?.san === openingMove.san;
      });

      if (candidate && candidate.score >= strongest - SIGNATURE_OPENING_WINDOW_CP) {
        chosen = { candidate, san: openingMove.san, combined: candidate.score };
      }
    }

    if (!chosen) return null;

    return {
      san: chosen.san,
      depth: chosen.candidate.depth,
      score: chosen.candidate.score,
      nodes: chosen.candidate.nodes,
      recordedPlays: getRecordedPlays(pending.chess, chosen.san, pending.book),
      calculator: 'Stockfish',
    };
  }

  async chooseMove(chess: Chess, book: DeaMoveBook, profile: DeaStyleProfile) {
    await this.ready;
    this.cancel();

    return new Promise<DeaDecision | null>((resolve) => {
      this.pending = {
        chess: new Chess(chess.fen()),
        book,
        profile,
        candidates: new Map(),
        resolve,
      };
      this.worker.postMessage(`position fen ${chess.fen()}`);
      this.worker.postMessage('go movetime 900');
    });
  }

  cancel() {
    if (!this.pending) return;

    this.worker.postMessage('stop');
    this.pending.resolve(null);
    this.pending = null;
  }

  dispose() {
    this.cancel();
    this.worker.terminate();
  }
}
