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
// Matches the Lambda's QUESTIONS_PER_DAY — no hard requirement they stay in
// sync, just keeps an on-demand practice session feeling the same length as
// a normal daily one.
const PRACTICE_QUESTIONS_PER_SESSION = 8;

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

// What actually got answered for one question in a session — enough to
// reconstruct a full review later (question content itself is looked up by
// questionId from the same local question bank, not duplicated here).
type StoredAnswer = {
  questionId: string;
  type: 'mc' | 'flip';
  chosenIndex?: number;
  draftAnswer?: string;
  selfGrade?: 'right' | 'wrong';
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// One-off session generated client-side for "Take again" on a Progress row
// that isn't today's live AM/PM topic. Without this, un-completing that row
// just flips its status to 'in-progress' with nothing anywhere in the app
// that actually lets you sit down and retake it — you'd have to wait for
// the daily rotation to maybe pick it back up.
type PracticeSession = {
  topic: string;
  difficulty: string;
  questionIds: string[];
};

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

// One completed session, flattened out of a DailyQuiz row's am or pm side —
// same reason SessionRecord exists below, so the history UI doesn't need to
// know about am/pm field naming either.
type HistoryEntry = {
  date: string;
  slot: 'am' | 'pm';
  topic: string;
  difficulty: string;
  questionIds: (string | null)[];
  answeredCount?: number | null;
  correctCount?: number | null;
  // Cleared the 80% auto-complete bar, or got marked complete manually —
  // distinct from just "was attempted," which is what actually gets this
  // entry included in History at all (see buildHistoryEntries below).
  completed: boolean;
  answers: StoredAnswer[];
};

// AppSync's AWSJSON scalar is a string on the wire — the Data client doesn't
// stringify a.json() values for you on the way in (see
// https://github.com/aws-amplify/amplify-js/issues/13298), so submitSession
// below stores this field as a JSON string, not a raw array. Reading it back
// means undoing that: handles a plain string (the normal case), an
// already-parsed array (in case a future client version starts doing this
// automatically), or anything else/malformed by just returning [].
function parseStoredAnswers(raw: unknown): StoredAnswer[] {
  if (Array.isArray(raw)) return raw as StoredAnswer[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StoredAnswer[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Newest-first: by date descending, and PM before AM within the same date
// since it happened later in the day. Includes any slot that was actually
// submitted at least once (answeredCount/pmAnsweredCount > 0) — NOT just
// ones that hit the 80% auto-complete bar or got marked complete manually.
// Those are two different questions: "did this clear the bar" (completed)
// vs. "is there something here worth reviewing" (was it attempted at all).
// Gating on `completed` used to mean a below-80% attempt that never got
// manually marked complete would just vanish once its date stopped being
// "today" — still sitten in DynamoDB, still fully answered, but with
// nowhere in the UI left to see it.
function buildHistoryEntries(records: DailyQuizRecord[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const r of records) {
    if (r.topic && (r.answeredCount ?? 0) > 0) {
      entries.push({
        date: r.date,
        slot: 'am',
        topic: r.topic,
        difficulty: r.difficulty,
        questionIds: r.questionIds,
        answeredCount: r.answeredCount,
        correctCount: r.correctCount,
        completed: !!r.completed,
        answers: parseStoredAnswers(r.answers),
      });
    }
    if (r.pmTopic && (r.pmAnsweredCount ?? 0) > 0) {
      entries.push({
        date: r.date,
        slot: 'pm',
        topic: r.pmTopic,
        difficulty: r.pmDifficulty ?? '',
        questionIds: r.pmQuestionIds ?? [],
        answeredCount: r.pmAnsweredCount,
        correctCount: r.pmCorrectCount,
        completed: !!r.pmCompleted,
        answers: parseStoredAnswers(r.pmAnswers),
      });
    }
  }
  entries.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    if (a.slot === b.slot) return 0;
    return a.slot === 'pm' ? -1 : 1;
  });
  return entries;
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
  onClose,
}: {
  label: string;
  record: SessionRecord | null;
  onPreview: (url: string) => void;
  // Returns whether this attempt actually cleared the auto-complete bar (or
  // null if the save itself failed) — the card only locks when `done` is
  // true, rather than unconditionally locking on any submit regardless of
  // score, which used to leave a below-threshold attempt stuck read-only
  // even though Progress still showed it as "in-progress." `answers` is what
  // actually gets persisted for later review in the History section.
  onSubmit: (result: {
    total: number;
    correct: number;
    answers: StoredAnswer[];
  }) => Promise<{ done: boolean } | null>;
  // Direct escape hatch from a locked card, independent of the Progress
  // table's Reopen/Mark complete toggle — that toggle can't help here since
  // it only flips between those two states and has nothing to offer when
  // Progress is already 'in-progress' but the card itself is still locked
  // (stale data from before a fix, or just wanting to redo a 100% session).
  onRetake: () => void;
  // Only passed for an on-demand practice session — the two permanent AM/PM
  // cards are always present (they just show "not generated yet" when
  // there's nothing today), but a practice session should be dismissible
  // once you're done with it instead of sitting on the page forever.
  onClose?: () => void;
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
    const storedAnswers: StoredAnswer[] = [];
    for (const q of sessionQuestions) {
      if (q.type === 'mc') {
        if (answers[q.questionId] === q.correctIndex) correct++;
        storedAnswers.push({ questionId: q.questionId, type: 'mc', chosenIndex: answers[q.questionId] });
      } else {
        if (flipSelfGrade[q.questionId] === 'right') correct++;
        storedAnswers.push({
          questionId: q.questionId,
          type: 'flip',
          draftAnswer: flipDrafts[q.questionId]?.trim() || undefined,
          selfGrade: flipSelfGrade[q.questionId],
        });
      }
    }
    const total = sessionQuestions.length;
    const outcome = await onSubmit({ total, correct, answers: storedAnswers });
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
          {onClose && (
            <button
              type="button"
              className="collapse-btn"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              Close ✕
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

// One past completed session (morning or afternoon), collapsed to a summary
// row by default — expanding it re-renders every question read-only with the
// same visual language QuizSession uses for a just-submitted card (option-btn
// correct/wrong highlighting, .explain, .flip-back), so a past session and a
// freshly-graded one look and read the same way.
function HistoryCard({ entry }: { entry: HistoryEntry }) {
  const [expanded, setExpanded] = useState(false);
  const total = entry.answeredCount ?? entry.answers.length;
  const correct = entry.correctCount ?? 0;
  const pct = total ? Math.round((100 * correct) / total) : 0;
  const answersById = useMemo(() => new Map(entry.answers.map((a) => [a.questionId, a])), [entry.answers]);
  const sessionQuestions = useMemo(() => {
    const byId = new Map(questions.map((q) => [q.questionId, q]));
    return entry.questionIds
      .filter((id): id is string => !!id)
      .map((id) => byId.get(id))
      .filter((q): q is QuestionContent => !!q);
  }, [entry.questionIds]);
  const sessionLabel = entry.slot === 'am' ? 'Morning' : 'Afternoon';

  return (
    <div className="history-card">
      <div className="card-header collapsible" onClick={() => setExpanded((e) => !e)}>
        <h3>
          {entry.date} — {sessionLabel}
        </h3>
        <div className="card-header-right">
          <span className="pill">{topicLabel(entry.topic)}</span>
          <span className="pill pill-muted">{difficultyLabel(entry.difficulty)}</span>
          <span className={'pill' + (pct >= AUTO_COMPLETE_THRESHOLD ? '' : ' pill-muted')}>{pct}%</span>
          {/* An attempt that's in History but didn't clear the bar and
              wasn't manually marked complete — flagging that distinction so
              it doesn't read identically to one that did. */}
          {!entry.completed && <span className="pill pill-muted">not marked complete</span>}
          <button
            type="button"
            className="collapse-btn"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((x) => !x);
            }}
          >
            {expanded ? 'Hide ▴' : 'Review ▾'}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="questions">
          {sessionQuestions.map((q, i) => {
            const a = answersById.get(q.questionId);
            return (
              <div key={q.questionId} className="question-card">
                <div className="q-index">Q{i + 1}</div>
                {q.type === 'mc' ? (
                  <>
                    <p className="q-prompt">{q.prompt}</p>
                    <div className="options">
                      {(q.options ?? []).map((opt, idx) => {
                        const isCorrect = idx === q.correctIndex;
                        const isWrongSelected = a?.chosenIndex === idx && idx !== q.correctIndex;
                        return (
                          <button
                            key={idx}
                            className={
                              'option-btn' +
                              (a?.chosenIndex === idx ? ' selected' : '') +
                              (isCorrect ? ' correct' : '') +
                              (isWrongSelected ? ' wrong' : '')
                            }
                            disabled
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                    {q.explain && <p className="explain">{q.explain}</p>}
                  </>
                ) : (
                  <>
                    <p className="q-prompt">{q.front}</p>
                    {a?.draftAnswer && (
                      <p className="explain">
                        <strong>Your answer:</strong> {a.draftAnswer}
                      </p>
                    )}
                    <p className="flip-back">{q.back}</p>
                    {a?.selfGrade && (
                      <p className={'self-grade-label' + (a.selfGrade === 'wrong' ? ' wrong' : '')}>
                        {a.selfGrade === 'right' ? 'You marked this: right' : 'You marked this: missed'}
                      </p>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {sessionQuestions.length === 0 && (
            <p className="muted">No per-question detail was saved for this session.</p>
          )}
        </div>
      )}
    </div>
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
  // The on-demand session started when "Take again" is clicked on a
  // Progress row that isn't today's live AM/PM topic. null when nothing's
  // being practiced. Bumping practiceResetToken forces a fresh mount (new
  // key), same reset-token pattern as am/pmResetToken, so retaking a
  // practice session clears its local answer state instead of reopening
  // already-submitted answers.
  const [practiceSession, setPracticeSession] = useState<PracticeSession | null>(null);
  const [practiceResetToken, setPracticeResetToken] = useState(0);
  // Every DailyQuiz row (not just today's) — kept around so History can be
  // built without a second round-trip; loadEverything already fetches this
  // full list for computeStreak, it just used to throw the rest away.
  const [allDailyQuizzes, setAllDailyQuizzes] = useState<DailyQuizRecord[]>([]);
  // How many history entries to show — "Load more" bumps this by 10 rather
  // than paginating server-side, since the whole list is already in memory.
  const [historyVisible, setHistoryVisible] = useState(10);

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
      setAllDailyQuizzes(allQuizzesPage.data);
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

  // Always fresh (completed: false) — a practice session never carries over
  // a previous attempt's lock state the way amRecord/pmRecord can, since
  // starting one always means "give me a brand new attempt right now."
  const practiceRecord: SessionRecord | null = practiceSession
    ? {
        topic: practiceSession.topic,
        difficulty: practiceSession.difficulty,
        questionIds: practiceSession.questionIds,
        answeredCount: null,
        correctCount: null,
        completed: false,
      }
    : null;

  const historyEntries = useMemo(() => buildHistoryEntries(allDailyQuizzes), [allDailyQuizzes]);

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
    result: { total: number; correct: number; answers: StoredAnswer[] },
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

    // AppSync's AWSJSON scalar is a string on the wire — the Data client
    // doesn't stringify a.json() values for you (confirmed against a real
    // "Variable 'answers' has an invalid value" failure while testing this;
    // see https://github.com/aws-amplify/amplify-js/issues/13298), so this
    // has to be JSON.stringify'd before the mutation, and parsed back on the
    // way out (parseStoredAnswers, used by buildHistoryEntries above).
    const serializedAnswers = JSON.stringify(result.answers);

    const dqResult =
      slot === 'am'
        ? await client.models.DailyQuiz.update({
            date: dailyQuiz.date,
            answeredCount: result.total,
            correctCount: result.correct,
            completed: isDone,
            answers: serializedAnswers,
          })
        : await client.models.DailyQuiz.update({
            date: dailyQuiz.date,
            pmAnsweredCount: result.total,
            pmCorrectCount: result.correct,
            pmCompleted: isDone,
            pmAnswers: serializedAnswers,
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

  // Submits an on-demand practice session — same Progress-updating logic as
  // submitSession, minus anything touching DailyQuiz, since a practice
  // session was never a DailyQuiz row to begin with. Doesn't clear
  // practiceSession on success — QuizSession's own Retake button (wired to
  // startPracticeSession again below) lets you go again immediately, and
  // Close is the explicit way to dismiss it.
  async function submitPracticeSession(result: {
    total: number;
    correct: number;
    answers: StoredAnswer[];
  }): Promise<{ done: boolean } | null> {
    if (!practiceSession) return null;
    const { topic, difficulty } = practiceSession;
    const pct = result.total ? Math.round((100 * result.correct) / result.total) : 0;

    const key = `${topic}::${difficulty}`;
    const existing = progressList.find((p) => `${p.topic}::${p.difficulty}` === key);
    const newBest = Math.max(existing?.bestScorePct ?? 0, pct);
    const autoComplete = pct >= AUTO_COMPLETE_THRESHOLD;
    // Same fallback as submitSession: a below-80% practice attempt on a
    // topic that's already complete shouldn't silently un-complete it —
    // Take again is the deliberate way to do that, not scoring low on a
    // drill session.
    const nextStatus = existing?.completedManually
      ? 'complete'
      : autoComplete
        ? 'complete'
        : existing?.status === 'complete'
          ? 'complete'
          : 'in-progress';
    const isDone = nextStatus === 'complete';

    const progressResult = existing
      ? await client.models.Progress.update({
          topic: existing.topic,
          difficulty: existing.difficulty,
          status: nextStatus,
          bestScorePct: newBest,
          streak: (existing.streak ?? 0) + 1,
          lastAttemptDate: todayStr(),
        })
      : await client.models.Progress.create({
          topic,
          difficulty,
          status: nextStatus,
          bestScorePct: pct,
          streak: 1,
          lastAttemptDate: todayStr(),
          completedManually: false,
        });
    if (progressResult.errors) {
      setError(`Score saved locally, but updating your progress failed: ${describeErrors(progressResult.errors)}.`);
      return null;
    }
    void loadEverything({ silent: true });
    return { done: isDone };
  }

  // Picks a fresh random set of questions for topic+difficulty and shows
  // them as a dismissible session, independent of today's AM/PM cadence —
  // this is what actually lets "Take again" (below) be retakeable right
  // away for a topic that isn't already live today, instead of just
  // flipping a status flag with nothing to act on.
  function startPracticeSession(topic: string, difficulty: string) {
    const pool = questions.filter((q) => q.topic === topic && q.difficulty === difficulty);
    const picked = shuffle(pool).slice(0, Math.min(PRACTICE_QUESTIONS_PER_SESSION, pool.length));
    setPracticeSession({ topic, difficulty, questionIds: picked.map((q) => q.questionId) });
    setPracticeResetToken((n) => n + 1);
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
    // Refetch BEFORE bumping the reset token — the token bump forces
    // QuizSession to remount immediately (it's part of the `key`), and that
    // remount reads `dailyQuiz`/amRecord|pmRecord to seed its initial
    // submitted/collapsed state. Bumping the token first (the old order)
    // remounted against the still-stale pre-reset `dailyQuiz` — completed
    // was still true for a moment — so the "reset" card came back already
    // marked submitted and collapsed, i.e. still locked. Awaiting here
    // means `dailyQuiz` (and the derived record) reflect the reset by the
    // time the remount actually happens.
    await loadEverything({ silent: true });
    if (slot === 'am') setAmResetToken((n) => n + 1);
    else setPmResetToken((n) => n + 1);
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
    let amNeedsRemount = false;
    let pmNeedsRemount = false;
    let matchedLiveSlot = false;
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
        amNeedsRemount = true;
        matchedLiveSlot = true;
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
        pmNeedsRemount = true;
        matchedLiveSlot = true;
      }
    }

    // Same fix as retakeSession: refetch first so `dailyQuiz` reflects the
    // reset writes above, THEN bump the reset token(s) — bumping first would
    // remount QuizSession against the still-stale (pre-reset) `dailyQuiz`,
    // leaving the "reopened" card looking submitted/collapsed anyway.
    await loadEverything({ silent: true });
    if (amNeedsRemount) setAmResetToken((n) => n + 1);
    if (pmNeedsRemount) setPmResetToken((n) => n + 1);

    // Un-completing a topic that ISN'T today's live AM/PM session — nothing
    // above gave you anywhere to actually retake it, so start an ad-hoc
    // practice session right here instead of leaving the row stuck at
    // 'in-progress' with no way to clear it back except clicking "Mark
    // complete" without actually retaking anything.
    if (!goingComplete && !matchedLiveSlot) {
      startPracticeSession(p.topic, p.difficulty);
    }
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

      {practiceSession && (
        <QuizSession
          key={`practice-${practiceResetToken}`}
          label={`Retaking: ${topicLabel(practiceSession.topic)} (${difficultyLabel(practiceSession.difficulty)})`}
          record={practiceRecord}
          onPreview={setPreviewUrl}
          onSubmit={(result) => submitPracticeSession(result)}
          onRetake={() => startPracticeSession(practiceSession.topic, practiceSession.difficulty)}
          onClose={() => setPracticeSession(null)}
        />
      )}

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
                      {p.status === 'complete' ? 'Take again' : 'Mark complete'}
                    </button>
                    {/* Independent of the toggle above — works no matter what
                        status currently reads, so a row already stuck at
                        'in-progress' (e.g. from before this button existed)
                        still has a way to actually be retaken on demand
                        rather than only via "Mark complete" with no retake. */}
                    <button
                      className="link-btn"
                      style={{ marginLeft: 8 }}
                      onClick={() => startPracticeSession(p.topic, p.difficulty)}
                    >
                      Practice
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

      <section className="card">
        <h2>History</h2>
        {historyEntries.length === 0 && <p className="muted">No completed sessions yet.</p>}
        {historyEntries.slice(0, historyVisible).map((entry) => (
          <HistoryCard key={`${entry.date}-${entry.slot}`} entry={entry} />
        ))}
        {historyVisible < historyEntries.length && (
          <button type="button" className="link-btn" onClick={() => setHistoryVisible((v) => v + 10)}>
            Load more
          </button>
        )}
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
