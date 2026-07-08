import { useEffect, useMemo, useState } from 'react';
import { client } from './dataClient';
import type { Schema } from '../amplify/data/resource';
import questionsData from './data/questions.json';
import topicsData from './data/topics.json';
import difficultiesData from './data/difficulties.json';
import type { QuestionContent, TopicMeta, DifficultyMeta } from './types';
import './App.css';

const questions = questionsData as QuestionContent[];
const topics = topicsData as TopicMeta[];
const difficulties = difficultiesData as DifficultyMeta[];

const AUTO_COMPLETE_THRESHOLD = 80;

// The static study guide (index.html, quiz.html, all topic pages) is hosted
// separately via GitHub Pages, decoupled from this app's own Amplify
// deploy — see infra-as-code.html on the guide itself for why that split
// is deliberate. Each question's `source` is a relative path + anchor
// (e.g. "node-express-onepager.html#info-express") that just gets appended
// to this base to link straight to the exact spot the question came from.
const GUIDE_BASE_URL = 'https://cshepscorp.github.io/back-end-trainer/';

// Separate localStorage key from the guide's own ('sg-theme') — this app
// runs on a different origin (Amplify vs GitHub Pages), so localStorage
// can't be shared between them anyway; each site remembers its own
// preference independently, same pattern, no actual cross-site sync.
const THEME_STORAGE_KEY = 'daily-quiz-theme';
type Theme = 'dark' | 'light';

type DailyQuizRecord = Schema['DailyQuiz']['type'];
type ProgressRecord = Schema['Progress']['type'];

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function topicLabel(id: string): string {
  return topics.find((t) => t.id === id)?.label ?? id;
}
function difficultyLabel(id: string): string {
  return difficulties.find((d) => d.id === id)?.label ?? id;
}

// Consecutive-day streak of completed daily quizzes, walking back from today.
function computeStreak(allDailyQuizzes: DailyQuizRecord[]): number {
  const completedDates = new Set(
    allDailyQuizzes.filter((d) => d.completed).map((d) => d.date),
  );
  let streakCount = 0;
  const cursor = new Date();
  // If today isn't done yet, start counting from yesterday instead of
  // breaking the streak at zero the moment you wake up.
  if (!completedDates.has(todayStr())) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  for (;;) {
    const key = cursor.toISOString().slice(0, 10);
    if (!completedDates.has(key)) break;
    streakCount++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streakCount;
}

// One slot's worth of a DailyQuiz row — either the morning fields as-is, or
// the pm* fields remapped onto the same shape, so QuizSession below doesn't
// need to know which slot it's rendering.
type SessionRecord = {
  topic: string;
  difficulty: string;
  questionIds: (string | null)[];
  answeredCount?: number | null;
  correctCount?: number | null;
  completed?: boolean | null;
};

// Renders one quiz session (morning or afternoon) with its own independent
// in-progress answer state. Two of these render side by side in App, each
// getting a different slice of the same DailyQuiz row — pulled out into its
// own component specifically so that independence didn't have to be faked
// with parallel amAnswers/pmAnswers-style state variables in App itself.
function QuizSession({
  label,
  record,
  onPreview,
  onSubmit,
  onRetake,
}: {
  label: string;
  record: SessionRecord | null;
  onPreview: (url: string) => void;
  // Returns whether this attempt actually cleared the auto-complete bar (or
  // null if the save itself failed) — the card only locks when `done` is
  // true, rather than unconditionally locking on any submit regardless of
  // score, which used to leave a below-threshold attempt stuck read-only
  // even though Progress still showed it as "in-progress."
  onSubmit: (result: { total: number; correct: number }) => Promise<{ done: boolean } | null>;
  // Direct escape hatch from a locked card, independent of the Progress
  // table's Reopen/Mark complete toggle — that toggle can't help here since
  // it only flips between those two states and has nothing to offer when
  // Progress is already 'in-progress' but the card itself is still locked
  // (stale data from before a fix, or just wanting to redo a 100% session).
  onRetake: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [flipRevealed, setFlipRevealed] = useState<Record<string, boolean>>({});
  const [flipSelfGrade, setFlipSelfGrade] = useState<Record<string, 'right' | 'wrong'>>({});
  // Session-only draft, same as the rest of this app's in-progress state —
  // not persisted to localStorage like quiz.html's version. Just gives you
  // somewhere to commit to an answer before revealing, rather than jumping
  // straight to "Show answer" with nothing typed.
  const [flipDrafts, setFlipDrafts] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(!!record?.completed);
  const [scorePct, setScorePct] = useState<number | null>(
    record?.completed && record.answeredCount
      ? Math.round((100 * (record.correctCount ?? 0)) / record.answeredCount)
      : null,
  );
  // Starts collapsed if this session was already complete on mount — e.g.
  // returning in the afternoon and the morning one's already done, so it
  // doesn't take up scroll space above the thing you actually came for.
  // Only relevant once something's been submitted at all; nothing to
  // collapse for a session you haven't touched yet.
  const [collapsed, setCollapsed] = useState(!!record?.completed);
  const canCollapse = !!record && submitted;

  const sessionQuestions = useMemo(() => {
    if (!record) return [];
    const byId = new Map(questions.map((q) => [q.questionId, q]));
    return record.questionIds
      .filter((id): id is string => !!id)
      .map((id) => byId.get(id))
      .filter((q): q is QuestionContent => !!q);
  }, [record]);

  function selectMcAnswer(questionId: string, idx: number) {
    if (submitted) return;
    setAnswers((prev) => ({ ...prev, [questionId]: idx }));
  }

  function revealFlip(questionId: string) {
    setFlipRevealed((prev) => ({ ...prev, [questionId]: true }));
  }

  function gradeFlip(questionId: string, grade: 'right' | 'wrong') {
    if (submitted) return;
    setFlipSelfGrade((prev) => ({ ...prev, [questionId]: grade }));
  }

  async function handleSubmit() {
    let correct = 0;
    for (const q of sessionQuestions) {
      if (q.type === 'mc') {
        if (answers[q.questionId] === q.correctIndex) correct++;
      } else {
        if (flipSelfGrade[q.questionId] === 'right') correct++;
      }
    }
    const total = sessionQuestions.length;
    const outcome = await onSubmit({ total, correct });
    if (!outcome) return; // save failed — error banner already shown up top; leave this attempt untouched so nothing typed is lost
    // Always show the graded feedback (score, correct/incorrect highlighting,
    // explanations) regardless of whether this attempt cleared the
    // auto-complete bar — silently wiping answers with no feedback on a low
    // score was worse than the bug it was meant to fix. `outcome.done` only
    // controls whether the underlying record locks as 'complete' behind the
    // scenes; Retake (below) is the one explicit way to go again either way.
    const pct = total ? Math.round((100 * correct) / total) : 0;
    setScorePct(pct);
    setSubmitted(true);
  }

  return (
    <section className="card">
      <div
        className={'card-header' + (canCollapse ? ' collapsible' : '')}
        onClick={() => canCollapse && setCollapsed((c) => !c)}
      >
        <h2>{label}</h2>
        <div className="card-header-right">
          {record && (
            <>
              <span className="pill">{topicLabel(record.topic)}</span>
              <span className="pill pill-muted">{difficultyLabel(record.difficulty)}</span>
            </>
          )}
          {submitted && scorePct !== null && (
            <span className={'pill' + (scorePct >= AUTO_COMPLETE_THRESHOLD ? '' : ' pill-muted')}>{scorePct}%</span>
          )}
          {canCollapse && (
            <button
              type="button"
              className="collapse-btn"
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed((c) => !c);
              }}
            >
              {collapsed ? 'Show ▾' : 'Hide ▴'}
            </button>
          )}
        </div>
      </div>
      {!record && !collapsed && (
        <p className="muted">
          Not generated yet for today — the scheduled function creates this one at its scheduled time, or trigger it
          manually from the AWS Lambda console to test it right now.
        </p>
      )}
      {record && !collapsed && (
        <>
          <div className="questions">
            {sessionQuestions.map((q, i) => (
              <div key={q.questionId} className="question-card">
                <div className="q-index">Q{i + 1}</div>
                {q.type === 'mc' ? (
                  <>
                    <p className="q-prompt">{q.prompt}</p>
                    <div className="options">
                      {(q.options ?? []).map((opt, idx) => {
                        const isSelected = answers[q.questionId] === idx;
                        const isCorrect = submitted && idx === q.correctIndex;
                        const isWrongSelected = submitted && isSelected && idx !== q.correctIndex;
                        return (
                          <button
                            key={idx}
                            className={
                              'option-btn' +
                              (isSelected ? ' selected' : '') +
                              (isCorrect ? ' correct' : '') +
                              (isWrongSelected ? ' wrong' : '')
                            }
                            onClick={() => selectMcAnswer(q.questionId, idx)}
                            disabled={submitted}
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                    {submitted && q.explain && <p className="explain">{q.explain}</p>}
                  </>
                ) : (
                  <>
                    <p className="q-prompt">{q.front}</p>
                    {(() => {
                      // Once the session is submitted, treat every flip
                      // question as already revealed and read-only — no
                      // Show-answer/textarea flow that implies you can still
                      // interact, and no grading buttons (nothing left to
                      // grade). Previously this only checked flipRevealed,
                      // so a completed session still showed a live-looking
                      // textarea with grading silently missing underneath.
                      const revealed = submitted || flipRevealed[q.questionId];
                      const draft = flipDrafts[q.questionId]?.trim();
                      if (!revealed) {
                        return (
                          <>
                            <textarea
                              className="answer-draft"
                              placeholder="Type your answer here before revealing the official one..."
                              value={flipDrafts[q.questionId] ?? ''}
                              onChange={(e) =>
                                setFlipDrafts((prev) => ({ ...prev, [q.questionId]: e.target.value }))
                              }
                            />
                            <button className="option-btn" onClick={() => revealFlip(q.questionId)}>
                              Show answer
                            </button>
                          </>
                        );
                      }
                      return (
                        <>
                          {draft && (
                            <p className="explain">
                              <strong>Your answer:</strong> {draft}
                            </p>
                          )}
                          <p className="flip-back">{q.back}</p>
                          {!submitted && (
                            <div className="self-grade">
                              <button
                                className={'grade-btn' + (flipSelfGrade[q.questionId] === 'right' ? ' selected' : '')}
                                onClick={() => gradeFlip(q.questionId, 'right')}
                              >
                                I had this right
                              </button>
                              <button
                                className={'grade-btn' + (flipSelfGrade[q.questionId] === 'wrong' ? ' selected' : '')}
                                onClick={() => gradeFlip(q.questionId, 'wrong')}
                              >
                                I missed this
                              </button>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </>
                )}
                {q.source.length > 0 && (
                  <div className="source-note">
                    <span className="source-label">Source:</span>
                    {q.source.map((src, idx) => {
                      const fullUrl = `${GUIDE_BASE_URL}${src}`;
                      return (
                        <span className="source-item" key={src}>
                          <span className="source-path">{src}</span>
                          <button type="button" className="source-action" onClick={() => onPreview(fullUrl)}>
                            Preview
                          </button>
                          <a className="source-action" href={fullUrl} target="_blank" rel="noopener noreferrer">
                            New tab ↗
                          </a>
                          {idx < q.source.length - 1 ? <span className="source-sep">&middot;</span> : null}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {!submitted ? (
            <button className="submit-btn" onClick={handleSubmit}>
              Submit {label.toLowerCase()}
            </button>
          ) : (
            <div className="result-banner">
              <span>
                Score: {scorePct}%{' '}
                {scorePct !== null && scorePct >= AUTO_COMPLETE_THRESHOLD && '— section auto-marked complete'}
              </span>
              <button type="button" className="link-btn" onClick={onRetake}>
                Retake
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dailyQuiz, setDailyQuiz] = useState<DailyQuizRecord | null>(null);
  const [progressList, setProgressList] = useState<ProgressRecord[]>([]);
  const [streak, setStreak] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(THEME_STORAGE_KEY) as Theme | null) ?? 'dark',
  );
  const [pausedUntil, setPausedUntil] = useState<string | null>(null);
  const [showPauseForm, setShowPauseForm] = useState(false);
  const [pauseDraft, setPauseDraft] = useState('');
  // Bumped only when Reopen actually resets that slot's DailyQuiz fields
  // (see toggleManualComplete) — used as part of QuizSession's key below so
  // reopening forces a fresh mount and clears stale local answer state.
  // Deliberately NOT tied to answeredCount/completed directly, so a normal
  // submit doesn't also trigger a remount and lose the nice
  // just-answered/correct highlighting for a moment.
  const [amResetToken, setAmResetToken] = useState(0);
  const [pmResetToken, setPmResetToken] = useState(0);

  useEffect(() => {
    void loadEverything();
  }, []);

  // Applied to <html> (not just this component's root) so the toggle
  // affects body background etc. too, same as the guide's data-theme
  // approach — kept in sync with localStorage on every change.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }

  // The guide's own "← back to topics" link, repurposed by its theme.js
  // into a close control when it detects it's embedded, signals back via
  // postMessage — not a direct window.parent call, since this app and the
  // guide are on different origins (this app on Amplify, the guide on
  // GitHub Pages) and a direct cross-origin call would just throw.
  useEffect(() => {
    if (!previewUrl) return;
    function handleMessage(e: MessageEvent) {
      if (e.data && e.data.type === 'close-source-preview') setPreviewUrl(null);
    }
    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') setPreviewUrl(null);
    }
    window.addEventListener('message', handleMessage);
    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('keydown', handleKeydown);
    };
  }, [previewUrl]);

  // `silent` skips the full-page "Loading..." placeholder — App returns
  // just that placeholder whenever `loading` is true, which unmounts the
  // *entire* tree (both QuizSession instances, Progress table, everything),
  // discarding all local component state in the process. That's fine for
  // the very first load (nothing to show yet anyway), but every later call
  // — after submit, retake, reopen — was doing the same full teardown,
  // which is what silently wiped the just-set score/feedback state and
  // scrolled the page back to the top on every action.
  async function loadEverything(opts: { silent?: boolean } = {}) {
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      const today = todayStr();
      const [dq, progressPage, allQuizzesPage, settings] = await Promise.all([
        client.models.DailyQuiz.get({ date: today }),
        client.models.Progress.list({ limit: 200 }),
        client.models.DailyQuiz.list({ limit: 400 }),
        client.models.QuizSettings.get({ id: 'global' }),
      ]);
      setDailyQuiz(dq.data ?? null);
      setProgressList(progressPage.data);
      setStreak(computeStreak(allQuizzesPage.data));
      setPausedUntil(settings.data?.pausedUntil ?? null);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Failed to load. Have you deployed the backend yet (npx ampx sandbox) and seeded questions?',
      );
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }

  // Same DailyQuiz row, two independent slices — QuizSession only ever sees
  // its own slot's shape, never has to know am/pm fields exist at all.
  const amRecord: SessionRecord | null =
    dailyQuiz && dailyQuiz.topic
      ? {
          topic: dailyQuiz.topic,
          difficulty: dailyQuiz.difficulty,
          questionIds: dailyQuiz.questionIds,
          answeredCount: dailyQuiz.answeredCount,
          correctCount: dailyQuiz.correctCount,
          completed: dailyQuiz.completed,
        }
      : null;
  const pmRecord: SessionRecord | null =
    dailyQuiz && dailyQuiz.pmTopic
      ? {
          topic: dailyQuiz.pmTopic,
          difficulty: dailyQuiz.pmDifficulty ?? '',
          questionIds: dailyQuiz.pmQuestionIds ?? [],
          answeredCount: dailyQuiz.pmAnsweredCount,
          correctCount: dailyQuiz.pmCorrectCount,
          completed: dailyQuiz.pmCompleted,
        }
      : null;

  // This client returns { data, errors } rather than throwing on a failed
  // mutation (confirmed by scripts/seed-questions.ts's own error-checking
  // pattern) — none of the calls below used to check that, so a failed
  // write (like a Progress update losing a race with something else) could
  // silently vanish while a sibling call succeeded, leaving DailyQuiz and
  // Progress out of sync with zero visible error. Every mutation site below
  // now checks .errors and surfaces a message via setError instead.
  function describeErrors(errors: { message?: string }[] | null | undefined): string {
    return errors?.[0]?.message ?? 'unknown error — check the browser console for details';
  }

  async function submitSession(
    slot: 'am' | 'pm',
    result: { total: number; correct: number },
  ): Promise<{ done: boolean } | null> {
    if (!dailyQuiz) return null;
    const topic = slot === 'am' ? dailyQuiz.topic : dailyQuiz.pmTopic;
    const difficulty = slot === 'am' ? dailyQuiz.difficulty : dailyQuiz.pmDifficulty;
    if (!topic || !difficulty) return null;

    const pct = result.total ? Math.round((100 * result.correct) / result.total) : 0;

    // Computed before the DailyQuiz write (not after, like before) so the
    // card's lock state is driven by the exact same status Progress will
    // show, instead of always locking on any submit regardless of score —
    // that mismatch is what left a below-80% attempt stuck read-only while
    // Progress still said "in-progress."
    const key = `${topic}::${difficulty}`;
    const existing = progressList.find((p) => `${p.topic}::${p.difficulty}` === key);
    const newBest = Math.max(existing?.bestScorePct ?? 0, pct);
    const autoComplete = pct >= AUTO_COMPLETE_THRESHOLD;
    const nextStatus = existing?.completedManually
      ? 'complete'
      : autoComplete
        ? 'complete'
        : existing?.status === 'complete'
          ? 'complete'
          : 'in-progress';
    const isDone = nextStatus === 'complete';

    const dqResult =
      slot === 'am'
        ? await client.models.DailyQuiz.update({
            date: dailyQuiz.date,
            answeredCount: result.total,
            correctCount: result.correct,
            completed: isDone,
          })
        : await client.models.DailyQuiz.update({
            date: dailyQuiz.date,
            pmAnsweredCount: result.total,
            pmCorrectCount: result.correct,
            pmCompleted: isDone,
          });
    if (dqResult.errors) {
      setError(`Couldn't save your score: ${describeErrors(dqResult.errors)}`);
      return null;
    }

    const progressResult = existing
      ? await client.models.Progress.update({
          topic: existing.topic,
          difficulty: existing.difficulty,
          status: nextStatus,
          bestScorePct: newBest,
          streak: (existing.streak ?? 0) + 1,
          lastAttemptDate: dailyQuiz.date,
        })
      : await client.models.Progress.create({
          topic,
          difficulty,
          status: nextStatus,
          bestScorePct: pct,
          streak: 1,
          lastAttemptDate: dailyQuiz.date,
          completedManually: false,
        });
    if (progressResult.errors) {
      setError(
        `Score saved, but updating your progress failed: ${describeErrors(progressResult.errors)}. ` +
          `Your score is safe — try Reopen/retake or refresh to resync.`,
      );
    }
    void loadEverything({ silent: true });
    return { done: isDone };
  }

  // Direct reset for a specific slot, independent of Progress.status
  // entirely — unlike Reopen (which only exists as a byproduct of toggling
  // Progress), this works no matter what Progress currently says, which is
  // exactly the case Reopen can't handle: a card stuck locked (stale data,
  // or just wanting another attempt) while Progress already reads
  // 'in-progress' and therefore only offers "Mark complete," not "Reopen."
  async function retakeSession(slot: 'am' | 'pm') {
    if (!dailyQuiz) return;
    const result =
      slot === 'am'
        ? await client.models.DailyQuiz.update({
            date: dailyQuiz.date,
            completed: false,
            answeredCount: 0,
            correctCount: 0,
          })
        : await client.models.DailyQuiz.update({
            date: dailyQuiz.date,
            pmCompleted: false,
            pmAnsweredCount: 0,
            pmCorrectCount: 0,
          });
    if (result.errors) {
      setError(`Couldn't reset that session: ${describeErrors(result.errors)}`);
      return;
    }
    if (slot === 'am') setAmResetToken((n) => n + 1);
    else setPmResetToken((n) => n + 1);
    void loadEverything({ silent: true });
  }

  // No separate "resume" mutation needed elsewhere — the scheduled function
  // just compares today's date against pausedUntil on every run, so setting
  // this to null (or letting the date pass) is the entire resume mechanism.
  async function setPause(dateOrNull: string | null) {
    const existing = await client.models.QuizSettings.get({ id: 'global' });
    const result = existing.data
      ? await client.models.QuizSettings.update({ id: 'global', pausedUntil: dateOrNull })
      : await client.models.QuizSettings.create({ id: 'global', pausedUntil: dateOrNull });
    if (result.errors) {
      setError(`Couldn't save pause setting: ${describeErrors(result.errors)}`);
      return;
    }
    setPausedUntil(dateOrNull);
  }

  async function toggleManualComplete(p: ProgressRecord) {
    const goingComplete = p.status !== 'complete';
    const progressResult = await client.models.Progress.update({
      topic: p.topic,
      difficulty: p.difficulty,
      status: goingComplete ? 'complete' : 'in-progress',
      completedManually: goingComplete,
    });
    if (progressResult.errors) {
      setError(`Couldn't update progress: ${describeErrors(progressResult.errors)}`);
      return;
    }

    // Reopening only ever flipped this Progress row before — the actual
    // DailyQuiz session card still thought it was done, since nothing told
    // it otherwise. If this combo is today's currently-showing AM and/or PM
    // session, actually reset that slot so the card becomes retakeable, and
    // bump its reset token so QuizSession remounts fresh instead of holding
    // onto stale "already submitted" local state.
    if (!goingComplete && dailyQuiz) {
      if (dailyQuiz.topic === p.topic && dailyQuiz.difficulty === p.difficulty) {
        const resetResult = await client.models.DailyQuiz.update({
          date: dailyQuiz.date,
          completed: false,
          answeredCount: 0,
          correctCount: 0,
        });
        if (resetResult.errors) {
          setError(`Reopened, but resetting today's card failed: ${describeErrors(resetResult.errors)}`);
        }
        setAmResetToken((n) => n + 1);
      }
      if (dailyQuiz.pmTopic === p.topic && dailyQuiz.pmDifficulty === p.difficulty) {
        const resetResult = await client.models.DailyQuiz.update({
          date: dailyQuiz.date,
          pmCompleted: false,
          pmAnsweredCount: 0,
          pmCorrectCount: 0,
        });
        if (resetResult.errors) {
          setError(`Reopened, but resetting today's card failed: ${describeErrors(resetResult.errors)}`);
        }
        setPmResetToken((n) => n + 1);
      }
    }

    void loadEverything({ silent: true });
  }

  if (loading) return <div className="wrap"><p>Loading...</p></div>;

  return (
    <div className="wrap">
      <header className="header">
        <div className="header-text">
          <h1>Daily Backend Quiz</h1>
          <p className="subtitle">Automated morning + afternoon practice — separate progress from the self-guided quiz.html</p>
          {streak > 0 && <div className="streak-badge">Streak: {streak} day{streak === 1 ? '' : 's'}</div>}
        </div>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span className="toggle-icon">{theme === 'dark' ? '☀︎' : '☽'}</span>
          <span className="toggle-label">{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
      </header>

      {pausedUntil && pausedUntil >= todayStr() ? (
        <div className="pause-banner">
          <span>Paused until {pausedUntil} — no quizzes or emails until then.</span>
          <button className="link-btn" onClick={() => setPause(null)}>Resume now</button>
        </div>
      ) : (
        <div className="pause-control">
          {!showPauseForm ? (
            <button className="link-btn" onClick={() => { setShowPauseForm(true); setPauseDraft(todayStr()); }}>
              Going away? Pause quizzes…
            </button>
          ) : (
            <span className="pause-form">
              <label htmlFor="pauseUntilInput" className="muted">Pause until</label>
              <input
                id="pauseUntilInput"
                type="date"
                value={pauseDraft}
                min={todayStr()}
                onChange={(e) => setPauseDraft(e.target.value)}
              />
              <button
                className="link-btn"
                onClick={async () => {
                  if (!pauseDraft) return;
                  await setPause(pauseDraft);
                  setShowPauseForm(false);
                }}
              >
                Save
              </button>
              <button className="link-btn" onClick={() => setShowPauseForm(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="error-card">
          <p>{error}</p>
        </div>
      )}

      <QuizSession
        key={`am-${amResetToken}`}
        label="Morning quiz"
        record={amRecord}
        onPreview={setPreviewUrl}
        onSubmit={(result) => submitSession('am', result)}
        onRetake={() => void retakeSession('am')}
      />
      <QuizSession
        key={`pm-${pmResetToken}`}
        label="Afternoon quiz"
        record={pmRecord}
        onPreview={setPreviewUrl}
        onSubmit={(result) => submitSession('pm', result)}
        onRetake={() => void retakeSession('pm')}
      />

      <section className="card">
        <h2>Progress</h2>
        <table className="progress-table">
          <thead>
            <tr>
              <th>Topic</th>
              <th>Difficulty</th>
              <th>Status</th>
              <th>Best score</th>
              <th>Attempts</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {progressList
              .slice()
              .sort((a, b) => (a.topic + a.difficulty).localeCompare(b.topic + b.difficulty))
              .map((p) => (
                <tr key={`${p.topic}::${p.difficulty}`}>
                  <td>{topicLabel(p.topic)}</td>
                  <td>{difficultyLabel(p.difficulty)}</td>
                  <td>
                    <span className={'status-pill status-' + p.status}>{p.status}</span>
                  </td>
                  <td>{p.bestScorePct ?? 0}%</td>
                  <td>{p.streak ?? 0}</td>
                  <td>
                    <button className="link-btn" onClick={() => toggleManualComplete(p)}>
                      {p.status === 'complete' ? 'Reopen' : 'Mark complete'}
                    </button>
                  </td>
                </tr>
              ))}
            {progressList.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No sections attempted yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {previewUrl && (
        <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) setPreviewUrl(null); }}>
          <div className="modal-box">
            <div className="modal-bar">
              <span className="modal-bar-label">{previewUrl}</span>
              <div className="modal-bar-actions">
                <a className="modal-btn" href={previewUrl} target="_blank" rel="noopener noreferrer">
                  Open in new tab &#8599;
                </a>
                <button type="button" className="modal-btn" onClick={() => setPreviewUrl(null)}>
                  Close &#10005;
                </button>
              </div>
            </div>
            {/* key={previewUrl} forces React to remount a fresh iframe on
                every new preview target, so the anchor scroll always fires
                — same reasoning as quiz.html's own about:blank-then-reload
                trick, just done the React way. */}
            <iframe key={previewUrl} className="modal-iframe" src={previewUrl} title="Guide reference" />
          </div>
        </div>
      )}
    </div>
  );
}
