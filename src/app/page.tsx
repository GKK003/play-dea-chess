'use client';

import { useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { Chessboard, type PieceDropHandlerArgs } from 'react-chessboard';
import { Crown, RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import { buildDeaBook } from '@/lib/deaBook';
import { chooseDeaMove, chooseSignatureOpeningMove } from '@/lib/bot';
import { StockfishCalculator } from '@/lib/stockfish';
import { deaPgnAssetPath, type DeaMoveBook, type DeaStyleProfile } from '@/data/deaGames';

const emptyProfile: DeaStyleProfile = {
  totalMoves: 0,
  captures: 0,
  checks: 0,
  castles: 0,
  pieceMoves: {},
  pawnFiles: {},
};

export default function Home() {
  const [game, setGame] = useState(() => new Chess());
  const [book, setBook] = useState<DeaMoveBook>({});
  const [profile, setProfile] = useState<DeaStyleProfile>(emptyProfile);
  const [gamesLoaded, setGamesLoaded] = useState(0);
  const [positionsLearned, setPositionsLearned] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [message, setMessage] = useState('Loading Dea games...');
  const [lastBotMove, setLastBotMove] = useState<string | null>(null);
  const [lastCalculation, setLastCalculation] = useState<string | null>(null);
  const [evaluationCp, setEvaluationCp] = useState<number | null>(0);
  const [illegalMoveNotice, setIllegalMoveNotice] = useState(false);
  const [canTakeBack, setCanTakeBack] = useState(false);
  const [isBotThinking, setIsBotThinking] = useState(false);
  const botMoveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const illegalMoveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const calculationId = useRef(0);
  const calculator = useRef<StockfishCalculator | null>(null);
  const turnHistory = useRef<Array<{ fen: string; evaluationCp: number | null }>>([]);

  useEffect(() => {
    let cancelled = false;

    try {
      calculator.current = new StockfishCalculator();
    } catch {
      calculator.current = null;
    }

    async function loadGames() {
      try {
        const response = await fetch(deaPgnAssetPath);
        if (!response.ok) throw new Error(`Unable to load PGN: ${response.status}`);

        const loaded = buildDeaBook(await response.text());
        if (cancelled) return;

        setBook(loaded.book);
        setProfile(loaded.profile);
        setGamesLoaded(loaded.gamesUsed);
        setPositionsLearned(Object.keys(loaded.book).length);
        setIsReady(true);
        setMessage(`Play White. Dea learned from ${loaded.gamesUsed} games as Black.`);
      } catch {
        if (cancelled) return;

        setIsReady(true);
        setMessage('PGN memory could not be loaded. Dea will use fallback moves.');
      }
    }

    void loadGames();

    return () => {
      cancelled = true;
      calculationId.current += 1;
      if (botMoveTimeout.current) clearTimeout(botMoveTimeout.current);
      if (illegalMoveTimeout.current) clearTimeout(illegalMoveTimeout.current);
      calculator.current?.dispose();
    };
  }, []);

  function showIllegalMoveNotice() {
    if (illegalMoveTimeout.current) clearTimeout(illegalMoveTimeout.current);

    setIllegalMoveNotice(true);
    illegalMoveTimeout.current = setTimeout(() => {
      setIllegalMoveNotice(false);
      illegalMoveTimeout.current = null;
    }, 3000);
  }

  function getWhiteEvaluation(decisionScore: number, calculatorName: string) {
    if (calculatorName === 'Opening memory') return null;
    return -decisionScore;
  }

  function formatEvaluation(score: number | null) {
    if (score === null) return { score: '--', summary: 'Waiting for analysis' };
    if (score > 90000) return { score: 'M', summary: 'White has mate' };
    if (score < -90000) return { score: '-M', summary: 'Dea has mate' };

    const pawns = score / 100;
    const displayScore = `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`;

    if (Math.abs(pawns) < 0.15) return { score: displayScore, summary: 'Position is equal' };
    return {
      score: displayScore,
      summary: pawns > 0 ? 'White is better' : 'Dea is better',
    };
  }

  async function makeBotMove(chessAfterUser: Chess, requestId: number) {
    let decision;

    try {
      decision = await calculator.current?.chooseMove(chessAfterUser, book, profile);
    } catch {
      calculator.current?.dispose();
      calculator.current = null;
    }

    if (requestId !== calculationId.current) return;

    decision ??= chooseSignatureOpeningMove(chessAfterUser, book) ?? chooseDeaMove(chessAfterUser, book, profile);

    if (!decision) {
      setIsBotThinking(false);
      return;
    }

    const played = chessAfterUser.move(decision.san, { strict: false });
    if (!played) return;

    setGame(chessAfterUser);
    setIsBotThinking(false);
    setEvaluationCp(getWhiteEvaluation(decision.score, decision.calculator));
    setLastBotMove(played.san);
    setLastCalculation(decision.calculator === 'Opening memory'
      ? 'Opening memory: dominant recorded reply.'
      : `${decision.calculator}: depth ${decision.depth}, ${decision.nodes.toLocaleString()} positions evaluated.`);
    setMessage(
      decision.recordedPlays
        ? `Dea calculated ${played.san}, supported by ${decision.recordedPlays} recorded plays.`
        : `Dea calculated ${played.san} in her learned style.`,
    );
  }

  function onDrop({ sourceSquare, targetSquare }: PieceDropHandlerArgs) {
    if (!isReady || isBotThinking || game.turn() !== 'w') return false;
    if (!targetSquare) {
      showIllegalMoveNotice();
      return false;
    }

    const nextGame = new Chess(game.fen());
    let move;

    try {
      move = nextGame.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: 'q',
      });
    } catch {
      showIllegalMoveNotice();
      return false;
    }

    if (!move) {
      showIllegalMoveNotice();
      return false;
    }

    turnHistory.current.push({ fen: game.fen(), evaluationCp });
    setCanTakeBack(true);
    setGame(nextGame);

    if (nextGame.isGameOver()) {
      setEvaluationCp(nextGame.isCheckmate() ? 100000 : 0);
      setMessage('Game over.');
      return true;
    }

    setEvaluationCp(null);
    setIsBotThinking(true);
    setMessage('Dea is calculating...');
    const requestId = ++calculationId.current;
    botMoveTimeout.current = setTimeout(() => {
      const botGame = new Chess(nextGame.fen());
      botMoveTimeout.current = null;
      void makeBotMove(botGame, requestId);
    }, 250);

    return true;
  }

  function takeBack() {
    const previousTurn = turnHistory.current.pop();
    if (!previousTurn) return;

    calculationId.current += 1;
    calculator.current?.cancel();

    if (botMoveTimeout.current) {
      clearTimeout(botMoveTimeout.current);
      botMoveTimeout.current = null;
    }

    setGame(new Chess(previousTurn.fen));
    setEvaluationCp(previousTurn.evaluationCp);
    setIsBotThinking(false);
    setLastBotMove(null);
    setLastCalculation(null);
    setCanTakeBack(turnHistory.current.length > 0);
    setMessage('Move taken back. Play White.');
  }

  function reset() {
    calculationId.current += 1;
    calculator.current?.dispose();

    try {
      calculator.current = new StockfishCalculator();
    } catch {
      calculator.current = null;
    }

    if (botMoveTimeout.current) {
      clearTimeout(botMoveTimeout.current);
      botMoveTimeout.current = null;
    }

    setGame(new Chess());
    turnHistory.current = [];
    setCanTakeBack(false);
    setEvaluationCp(0);
    setIsBotThinking(false);
    setLastBotMove(null);
    setLastCalculation(null);
    setMessage('New game. Play White.');
  }

  const evaluation = formatEvaluation(evaluationCp);

  return (
    <main className="min-h-screen bg-[#0f172a] px-4 py-8 text-white">
      {illegalMoveNotice && (
        <div
          role="alert"
          className="fixed left-1/2 top-6 z-50 -translate-x-1/2 rounded-xl bg-rose-500 px-5 py-3 font-semibold text-white shadow-2xl"
        >
          Illegal move
        </div>
      )}
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[380px_1fr]">
        <section className="rounded-3xl border border-white/10 bg-white/10 p-5 shadow-2xl backdrop-blur">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-[#0f172a]">
              <Crown size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Play Dea</h1>
              <p className="text-sm text-white/70">Trained from uploaded Deiko27 games</p>
            </div>
          </div>

          <div className="rounded-2xl border border-white bg-white p-4 text-[#0f172a]">
            <div className="font-bold">Dea</div>
            <div className="text-sm text-slate-600">
              {gamesLoaded ? `${gamesLoaded} standard games loaded` : 'Loading uploaded PGN memory...'}
            </div>
            {positionsLearned > 0 && (
              <div className="text-sm text-slate-600">{positionsLearned.toLocaleString()} positions learned</div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between rounded-2xl border border-white/10 bg-black/25 p-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-white/50">Evaluation</div>
              <div className="mt-1 text-sm text-white/75">{evaluation.summary}</div>
              <div className="mt-1 text-xs text-white/45">+ White / - Dea</div>
            </div>
            <div className="text-3xl font-bold tabular-nums">{evaluation.score}</div>
          </div>

          <div className="mt-6 rounded-2xl bg-black/25 p-4">
            <div className="mb-2 flex items-center gap-2 font-semibold">
              <Sparkles size={18} />
              Status
            </div>
            <p className="text-sm text-white/75">{message}</p>
            {lastBotMove && <p className="mt-2 text-sm text-white/75">Last Dea move: {lastBotMove}</p>}
            {lastCalculation && <p className="mt-2 text-sm text-white/60">{lastCalculation}</p>}
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <button
              onClick={takeBack}
              disabled={!canTakeBack}
              className="flex items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white/5 px-3 py-3 font-bold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Undo2 size={18} />
              Take back
            </button>
            <button
              onClick={reset}
              className="flex items-center justify-center gap-2 rounded-2xl bg-white px-3 py-3 font-bold text-[#0f172a] hover:bg-white/90"
            >
              <RotateCcw size={18} />
              New game
            </button>
          </div>

          <p className="mt-5 text-xs leading-5 text-white/50">
            Stockfish calculates strong candidates, then Dea&apos;s recorded patterns prefer her style among sound choices.
          </p>
        </section>

        <section className="rounded-3xl border border-white/10 bg-white/10 p-4 shadow-2xl">
          <div className="mx-auto max-w-[680px]">
            <Chessboard
              options={{
                position: game.fen(),
                onPieceDrop: onDrop,
                allowDragging: isReady && !isBotThinking && !game.isGameOver() && game.turn() === 'w',
                boardStyle: {
                  borderRadius: '20px',
                  overflow: 'hidden',
                  boxShadow: '0 25px 80px rgba(0,0,0,.45)',
                },
              }}
            />
          </div>
        </section>
      </div>
    </main>
  );
}
