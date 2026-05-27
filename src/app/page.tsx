'use client';

import { useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { Chessboard, type PieceDropHandlerArgs } from 'react-chessboard';
import { Crown, RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import { buildDeaBook } from '@/lib/deaBook';
import { chooseDeaMove } from '@/lib/bot';
import { StockfishCalculator } from '@/lib/stockfish';
import { deaPgnAssetPath, type DeaColor, type DeaStyleProfile, type DeaTrainingData } from '@/data/deaGames';

const emptyProfile: DeaStyleProfile = {
  totalMoves: 0,
  captures: 0,
  checks: 0,
  castles: 0,
  pieceMoves: {},
  pawnFiles: {},
};

const emptyTraining: DeaTrainingData = {
  book: {},
  profile: emptyProfile,
  gamesUsed: 0,
};

function oppositeColor(color: DeaColor): DeaColor {
  return color === 'w' ? 'b' : 'w';
}

function colorName(color: DeaColor) {
  return color === 'w' ? 'White' : 'Black';
}

export default function Home() {
  const [game, setGame] = useState(() => new Chess());
  const [playerColor, setPlayerColor] = useState<DeaColor>('w');
  const [trainingByColor, setTrainingByColor] = useState<Record<DeaColor, DeaTrainingData>>({
    w: emptyTraining,
    b: emptyTraining,
  });
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
  const playerColorRef = useRef<DeaColor>('w');

  const deaColor = oppositeColor(playerColor);
  const training = trainingByColor[deaColor];
  const gamesLoaded = training.gamesUsed;
  const positionsLearned = Object.keys(training.book).length;

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

        const archive = await response.text();
        const loadedByColor: Record<DeaColor, DeaTrainingData> = {
          w: buildDeaBook(archive, 'w'),
          b: buildDeaBook(archive, 'b'),
        };
        if (cancelled) return;

        setTrainingByColor(loadedByColor);
        setIsReady(true);
        const selectedPlayerColor = playerColorRef.current;
        const selectedDeaColor = oppositeColor(selectedPlayerColor);
        setMessage(
          `Play ${colorName(selectedPlayerColor)}. Dea learned from ${loadedByColor[selectedDeaColor].gamesUsed} games as ${colorName(selectedDeaColor)}.`,
        );
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

  function getWhiteEvaluation(decisionScore: number, calculatorName: string, movingDeaColor: DeaColor) {
    if (calculatorName === 'Opening memory') return null;
    return movingDeaColor === 'w' ? decisionScore : -decisionScore;
  }

  function getGameOverEvaluation(chess: Chess) {
    if (!chess.isCheckmate()) return 0;
    return chess.turn() === 'w' ? -100000 : 100000;
  }

  function formatEvaluation(score: number | null) {
    if (score === null) return { score: '--', summary: 'Waiting for analysis' };
    if (score > 90000) return { score: 'M', summary: 'White has mate' };
    if (score < -90000) return { score: '-M', summary: 'Black has mate' };

    const pawns = score / 100;
    const displayScore = `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`;

    if (Math.abs(pawns) < 0.15) return { score: displayScore, summary: 'Position is equal' };
    return {
      score: displayScore,
      summary: pawns > 0 ? 'White is better' : 'Black is better',
    };
  }

  async function makeBotMove(
    chessAfterUser: Chess,
    requestId: number,
    movingDeaColor: DeaColor,
    movingTraining: DeaTrainingData,
  ) {
    let decision;

    try {
      decision = await calculator.current?.chooseMove(chessAfterUser, movingTraining.book, movingTraining.profile);
    } catch {
      calculator.current?.dispose();
      calculator.current = null;
    }

    if (requestId !== calculationId.current) return;

    decision ??= chooseDeaMove(
      chessAfterUser,
      movingTraining.book,
      movingTraining.profile,
      movingDeaColor,
    );

    if (!decision) {
      setIsBotThinking(false);
      return;
    }

    const played = chessAfterUser.move(decision.san, { strict: false });
    if (!played) return;

    setGame(chessAfterUser);
    setIsBotThinking(false);
    setEvaluationCp(
      chessAfterUser.isGameOver()
        ? getGameOverEvaluation(chessAfterUser)
        : getWhiteEvaluation(decision.score, decision.calculator, movingDeaColor),
    );
    setLastBotMove(played.san);
    setLastCalculation(decision.calculator === 'Opening memory'
      ? 'Opening memory: dominant recorded reply.'
      : `${decision.calculator}: depth ${decision.depth}, ${decision.nodes.toLocaleString()} positions evaluated.`);
    setMessage(chessAfterUser.isGameOver()
      ? 'Game over.'
      : decision.recordedPlays
        ? `Dea calculated ${played.san}, supported by ${decision.recordedPlays} recorded plays.`
        : `Dea calculated ${played.san} in her learned style.`);
  }

  function queueBotMove(chess: Chess, movingDeaColor: DeaColor, movingTraining: DeaTrainingData, delay = 250) {
    setEvaluationCp(null);
    setIsBotThinking(true);
    setMessage(`Dea is calculating as ${colorName(movingDeaColor)}...`);
    const requestId = ++calculationId.current;
    botMoveTimeout.current = setTimeout(() => {
      const botGame = new Chess(chess.fen());
      botMoveTimeout.current = null;
      void makeBotMove(botGame, requestId, movingDeaColor, movingTraining);
    }, delay);
  }

  function onDrop({ sourceSquare, targetSquare }: PieceDropHandlerArgs) {
    if (!isReady || isBotThinking || game.turn() !== playerColor) return false;
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
      setEvaluationCp(getGameOverEvaluation(nextGame));
      setMessage('Game over.');
      return true;
    }

    queueBotMove(nextGame, deaColor, training);

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
    setMessage(`Move taken back. Play ${colorName(playerColor)}.`);
  }

  function reset(nextPlayerColor = playerColor) {
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
    setPlayerColor(nextPlayerColor);
    playerColorRef.current = nextPlayerColor;
    turnHistory.current = [];
    setCanTakeBack(false);
    setEvaluationCp(0);
    setIsBotThinking(false);
    setLastBotMove(null);
    setLastCalculation(null);
    const nextDeaColor = oppositeColor(nextPlayerColor);

    if (isReady && nextDeaColor === 'w') {
      queueBotMove(new Chess(), nextDeaColor, trainingByColor[nextDeaColor], 150);
    } else {
      setMessage(`New game. Play ${colorName(nextPlayerColor)}.`);
    }
  }

  const evaluation = formatEvaluation(evaluationCp);
  const whiteEvaluationPercent = evaluationCp === null
    ? 50
    : Math.min(92, Math.max(8, 50 + evaluationCp / 18));
  const deaTurnLabel = isBotThinking
    ? 'Thinking...'
    : game.turn() === deaColor && !game.isGameOver()
      ? 'To move'
      : colorName(deaColor);
  const playerTurnLabel = !isBotThinking && game.turn() === playerColor && !game.isGameOver()
    ? 'Your turn'
    : colorName(playerColor);

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
          onClick={() => reset()}
          className="rounded-lg bg-white/10 p-2.5 text-white hover:bg-white/15"
          aria-label="New game"
        >
          <RotateCcw size={19} />
        </button>
      </header>

      <div className="mx-auto grid w-full max-w-[1130px] grid-cols-1 gap-5 overflow-hidden pb-6 lg:grid-cols-[minmax(540px,730px)_360px] lg:px-5 lg:py-6">
        <section className="w-full min-w-0 max-w-full overflow-hidden">
          <div className="flex items-center justify-between px-3 py-3 sm:px-4 lg:px-0 lg:pb-3 lg:pt-0">
            {playerColor === 'w' ? (
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#312e2b] font-bold text-[#b58863]">
                  D
                </div>
                <div>
                  <div className="font-semibold">Dea</div>
                  <div className="text-xs text-white/55">{deaTurnLabel}</div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#312e2b] font-bold text-white">
                  Y
                </div>
                <div>
                  <div className="font-semibold">You</div>
                  <div className="text-xs text-[#81b64c]">{playerTurnLabel}</div>
                </div>
              </div>
            )}
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
                  boardOrientation: playerColor === 'w' ? 'white' : 'black',
                  allowDragging: isReady && !isBotThinking && !game.isGameOver() && game.turn() === playerColor,
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
            {playerColor === 'w' ? (
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#f0f0f0] font-bold text-[#312e2b]">
                  Y
                </div>
                <div>
                  <div className="font-semibold">You</div>
                  <div className="text-xs text-[#81b64c]">{playerTurnLabel}</div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#f0f0f0] font-bold text-[#312e2b]">
                  D
                </div>
                <div>
                  <div className="font-semibold">Dea</div>
                  <div className="text-xs text-white/55">{deaTurnLabel}</div>
                </div>
              </div>
            )}
            <div className="text-sm text-white/55">
              {playerColor === 'w' ? colorName(playerColor) : colorName(deaColor)}
            </div>
          </div>

          <div className="mx-3 mb-3 flex items-center justify-between rounded-lg bg-[#262522] p-1 lg:hidden">
            <span className="px-3 text-sm font-semibold text-white/65">Play as</span>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => reset('w')}
                disabled={!isReady}
                className={`rounded-md px-4 py-2 text-sm font-semibold transition disabled:opacity-40 ${playerColor === 'w' ? 'bg-[#81b64c] text-white' : 'text-white/65 hover:bg-white/10'}`}
              >
                White
              </button>
              <button
                type="button"
                onClick={() => reset('b')}
                disabled={!isReady}
                className={`rounded-md px-4 py-2 text-sm font-semibold transition disabled:opacity-40 ${playerColor === 'b' ? 'bg-[#81b64c] text-white' : 'text-white/65 hover:bg-white/10'}`}
              >
                Black
              </button>
            </div>
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
              onClick={() => reset()}
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
                <div className="mt-1 text-xs">+ White / - Black</div>
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
            <div className="font-semibold">Dea as {colorName(deaColor)}</div>
            <div className="mt-1 text-sm text-white/60">
              {gamesLoaded ? `${gamesLoaded} standard games learned` : 'Loading PGN memory...'}
            </div>
            {positionsLearned > 0 && (
              <div className="text-sm text-white/60">{positionsLearned.toLocaleString()} positions learned</div>
            )}
          </div>

          <div className="mt-4 rounded-lg bg-[#312e2b] p-4">
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-white/45">Play as</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => reset('w')}
                disabled={!isReady}
                className={`rounded-lg px-3 py-2.5 font-semibold transition disabled:opacity-40 ${playerColor === 'w' ? 'bg-[#81b64c]' : 'bg-[#262522] text-white/70 hover:bg-[#3b3937]'}`}
              >
                White
              </button>
              <button
                type="button"
                onClick={() => reset('b')}
                disabled={!isReady}
                className={`rounded-lg px-3 py-2.5 font-semibold transition disabled:opacity-40 ${playerColor === 'b' ? 'bg-[#81b64c]' : 'bg-[#262522] text-white/70 hover:bg-[#3b3937]'}`}
              >
                Black
              </button>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between rounded-lg bg-[#312e2b] p-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-white/45">Evaluation</div>
              <div className="mt-1 text-sm text-white/70">{evaluation.summary}</div>
              <div className="mt-1 text-xs text-white/45">+ White / - Black</div>
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
              onClick={() => reset()}
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
