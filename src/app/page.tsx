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
  const whiteEvaluationPercent = evaluationCp === null
    ? 50
    : Math.min(92, Math.max(8, 50 + evaluationCp / 18));
  const deaTurnLabel = isBotThinking
    ? 'Thinking...'
    : game.turn() === 'b' && !game.isGameOver()
      ? 'To move'
      : 'Black';
  const playerTurnLabel = !isBotThinking && game.turn() === 'w' && !game.isGameOver()
    ? 'Your turn'
    : 'White';

  return (
    <main className="min-h-[100svh] bg-[#121212] text-white">
      {illegalMoveNotice && (
        <div
          role="alert"
          className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg bg-rose-500 px-5 py-3 font-semibold text-white shadow-2xl"
        >
          Illegal move
        </div>
      )}
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3 lg:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#81b64c] text-white">
            <Crown size={21} />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Play Dea</h1>
            <p className="text-xs text-white/55">Style match</p>
          </div>
        </div>
        <button
          onClick={reset}
          className="rounded-lg bg-white/10 p-2.5 text-white hover:bg-white/15"
          aria-label="New game"
        >
          <RotateCcw size={19} />
        </button>
      </header>

      <div className="mx-auto grid w-full max-w-[1130px] grid-cols-1 gap-5 overflow-hidden pb-6 lg:grid-cols-[minmax(540px,730px)_360px] lg:px-5 lg:py-6">
        <section className="w-full min-w-0 max-w-full overflow-hidden">
          <div className="flex items-center justify-between px-3 py-3 sm:px-4 lg:px-0 lg:pb-3 lg:pt-0">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#312e2b] font-bold text-[#b58863]">
                D
              </div>
              <div>
                <div className="font-semibold">Dea</div>
                <div className="text-xs text-white/55">{deaTurnLabel}</div>
              </div>
            </div>
            <div className="rounded-md bg-[#262522] px-3 py-1.5 text-sm font-semibold tabular-nums text-white/85">
              {evaluation.score}
            </div>
          </div>

          <div className="flex w-full max-w-full items-stretch gap-1 overflow-hidden bg-[#121212] px-0 sm:px-3 lg:px-0">
            <div className="relative w-2 shrink-0 overflow-hidden rounded-l-sm bg-[#262522] sm:w-3 sm:rounded-md">
              <div
                className="absolute inset-x-0 bottom-0 bg-[#f0f0f0] transition-[height] duration-300"
                style={{ height: `${whiteEvaluationPercent}%` }}
              />
            </div>
            <div className="play-board min-w-0 overflow-hidden sm:rounded-md">
              <Chessboard
                options={{
                  position: game.fen(),
                  onPieceDrop: onDrop,
                  allowDragging: isReady && !isBotThinking && !game.isGameOver() && game.turn() === 'w',
                  darkSquareStyle: { backgroundColor: '#b58863' },
                  lightSquareStyle: { backgroundColor: '#f0d9b5' },
                  boardStyle: {
                    gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
                    aspectRatio: '1 / 1',
                    width: '100%',
                    height: 'auto',
                    overflow: 'hidden',
                  },
                }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between px-3 py-3 sm:px-4 lg:px-0">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#f0f0f0] font-bold text-[#312e2b]">
                Y
              </div>
              <div>
                <div className="font-semibold">You</div>
                <div className="text-xs text-[#81b64c]">{playerTurnLabel}</div>
              </div>
            </div>
            <div className="text-sm text-white/55">White</div>
          </div>

          <div className="grid grid-cols-2 gap-2 px-3 sm:px-4 lg:hidden">
            <button
              onClick={takeBack}
              disabled={!canTakeBack}
              className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-[#262522] px-3 py-3 font-semibold transition hover:bg-[#343330] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Undo2 size={19} />
              Take back
            </button>
            <button
              onClick={reset}
              className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-[#81b64c] px-3 py-3 font-semibold text-white hover:bg-[#95c45d]"
            >
              <RotateCcw size={19} />
              New game
            </button>
          </div>

          <div className="mx-3 mt-3 rounded-lg bg-[#262522] p-4 sm:mx-4 lg:hidden">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-white/80">
                  <Sparkles size={16} />
                  Game status
                </div>
                <p className="mt-2 text-sm text-white/70">{message}</p>
              </div>
              <div className="text-right text-sm text-white/65">
                <div>{evaluation.summary}</div>
                <div className="mt-1 text-xs">+ White / - Dea</div>
              </div>
            </div>
            {lastBotMove && <p className="mt-2 text-xs text-white/55">Last move: {lastBotMove}</p>}
          </div>
        </section>

        <aside className="hidden rounded-xl bg-[#262522] p-5 shadow-xl lg:block">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#81b64c] text-white">
              <Crown size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Play Dea</h1>
              <p className="text-sm text-white/60">Trained from Deiko27 games</p>
            </div>
          </div>

          <div className="rounded-lg bg-[#312e2b] p-4">
            <div className="font-semibold">Dea</div>
            <div className="mt-1 text-sm text-white/60">
              {gamesLoaded ? `${gamesLoaded} standard games loaded` : 'Loading PGN memory...'}
            </div>
            {positionsLearned > 0 && (
              <div className="text-sm text-white/60">{positionsLearned.toLocaleString()} positions learned</div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between rounded-lg bg-[#312e2b] p-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-white/45">Evaluation</div>
              <div className="mt-1 text-sm text-white/70">{evaluation.summary}</div>
              <div className="mt-1 text-xs text-white/45">+ White / - Dea</div>
            </div>
            <div className="text-3xl font-bold tabular-nums">{evaluation.score}</div>
          </div>

          <div className="mt-4 rounded-lg bg-[#312e2b] p-4">
            <div className="mb-2 flex items-center gap-2 font-semibold">
              <Sparkles size={18} />
              Status
            </div>
            <p className="text-sm text-white/70">{message}</p>
            {lastBotMove && <p className="mt-2 text-sm text-white/70">Last Dea move: {lastBotMove}</p>}
            {lastCalculation && <p className="mt-2 text-sm text-white/55">{lastCalculation}</p>}
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <button
              onClick={takeBack}
              disabled={!canTakeBack}
              className="flex items-center justify-center gap-2 rounded-lg bg-[#312e2b] px-3 py-3 font-semibold transition hover:bg-[#3b3937] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Undo2 size={18} />
              Take back
            </button>
            <button
              onClick={reset}
              className="flex items-center justify-center gap-2 rounded-lg bg-[#81b64c] px-3 py-3 font-semibold hover:bg-[#95c45d]"
            >
              <RotateCcw size={18} />
              New game
            </button>
          </div>

          <p className="mt-5 text-xs leading-5 text-white/45">
            Stockfish calculates strong candidates, then Dea&apos;s recorded patterns prefer her style among sound choices.
          </p>
        </aside>
      </div>
    </main>
  );
}
