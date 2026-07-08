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

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dailyQuiz, setDailyQuiz] = useState<DailyQuizRecord | null>(null);
  const [progressList, setProgressList] = useState<ProgressRecord[]>([]);
  const [streak, setStreak] = useState(0);

  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [flipRevealed, setFlipRevealed] = useState<Record<string, boolean>>({});
  const [flipSelfGrade, setFlipSelfGrade] = useState<Record<string, 'right' | 'wrong'>>({});
  const [submitted, setSubmitted] = useState(false);
  const [scorePct, setScorePct] = useState<number | null>(null);

  useEffect(() => {
    void loadEverything();
  }, []);

  async function loadEverything() {
    setLoading(true);
    setError(null);
    try {
      const today = todayStr();
      const [dq, progressPage, allQuizzesPage] = await Promise.all([
        client.models.DailyQuiz.get({ date: today }),
        client.models.Progress.list({ limit: 200 }),
        client.models.DailyQuiz.list({ limit: 400 }),
      ]);
      setDailyQuiz(dq.data ?? null);
      setProgressList(progressPage.data);
      setStreak(computeStreak(allQuizzesPage.data));
      if (dq.data?.completed) {
        setSubmitted(true);
        setScorePct(
          dq.data.answeredCount ? Math.round((100 * (dq.data.correctCount ?? 0)) / dq.data.answeredCount) : null,
        );
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Failed to load. Have you deployed the backend yet (npx ampx sandbox) and seeded questions?',
      );
    } finally {
      setLoading(false);
    }
  }

  const todaysQuestions = useMemo(() => {
    if (!dailyQuiz) return [];
    const byId = new Map(questions.map((q) => [q.questionId, q]));
    return dailyQuiz.questionIds
      .filter((id): id is string => !!id)
      .map((id) => byId.get(id))
      .filter((q): q is QuestionContent => !!q);
  }, [dailyQuiz]);

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
    if (!dailyQuiz) return;
    let correct = 0;
    for (const q of todaysQuestions) {
      if (q.type === 'mc') {
        if (answers[q.questionId] === q.correctIndex) correct++;
      } else {
        if (flipSelfGrade[q.questionId] === 'right') correct++;
      }
    }
    const total = todaysQuestions.length;
    const pct = total ? Math.round((100 * correct) / total) : 0;
    setScorePct(pct);
    setSubmitted(true);

    await client.models.DailyQuiz.update({
      date: dailyQuiz.date,
      answeredCount: total,
      correctCount: correct,
      completed: true,
    });

    const key = `${dailyQuiz.topic}::${dailyQuiz.difficulty}`;
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

    if (existing) {
      await client.models.Progress.update({
        topic: existing.topic,
        difficulty: existing.difficulty,
        status: nextStatus,
        bestScorePct: newBest,
        streak: (existing.streak ?? 0) + 1,
        lastAttemptDate: dailyQuiz.date,
      });
    } else {
      await client.models.Progress.create({
        topic: dailyQuiz.topic,
        difficulty: dailyQuiz.difficulty,
        status: nextStatus,
        bestScorePct: pct,
        streak: 1,
        lastAttemptDate: dailyQuiz.date,
        completedManually: false,
      });
    }
    void loadEverything();
  }

  async function toggleManualComplete(p: ProgressRecord) {
    const goingComplete = p.status !== 'complete';
    await client.models.Progress.update({
      topic: p.topic,
      difficulty: p.difficulty,
      status: goingComplete ? 'complete' : 'in-progress',
      completedManually: goingComplete,
    });
    void loadEverything();
  }

  if (loading) return <div className="wrap"><p>Loading...</p></div>;

  return (
    <div className="wrap">
      <header className="header">
        <h1>Daily Backend Quiz</h1>
        <p className="subtitle">Automated morning practice — separate progress from the self-guided quiz.html</p>
        {streak > 0 && <div className="streak-badge">Streak: {streak} day{streak === 1 ? '' : 's'}</div>}
      </header>

      {error && (
        <div className="error-card">
          <p>{error}</p>
        </div>
      )}

      <section className="card">
        <h2>Today's quiz</h2>
        {!dailyQuiz && !error && (
          <p className="muted">
            No quiz assigned yet for today. The scheduled function creates one each morning — or trigger it manually
            from the AWS Lambda console to test it right now.
          </p>
        )}
        {dailyQuiz && (
          <>
            <p className="quiz-meta">
              <span className="pill">{topicLabel(dailyQuiz.topic)}</span>
              <span className="pill pill-muted">{difficultyLabel(dailyQuiz.difficulty)}</span>
            </p>

            <div className="questions">
              {todaysQuestions.map((q, i) => (
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
                      {!flipRevealed[q.questionId] ? (
                        <button className="option-btn" onClick={() => revealFlip(q.questionId)}>
                          Show answer
                        </button>
                      ) : (
                        <>
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
                      )}
                    </>
                  )}
                  {q.source.length > 0 && (
                    <p className="source-note">
                      Source:{' '}
                      {q.source.map((src, idx) => (
                        <span key={src}>
                          <a href={`${GUIDE_BASE_URL}${src}`} target="_blank" rel="noopener noreferrer">
                            {src}
                          </a>
                          {idx < q.source.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              ))}
            </div>

            {!submitted ? (
              <button className="submit-btn" onClick={handleSubmit}>
                Submit today's quiz
              </button>
            ) : (
              <div className="result-banner">
                Score: {scorePct}%{' '}
                {scorePct !== null && scorePct >= AUTO_COMPLETE_THRESHOLD && '— section auto-marked complete'}
              </div>
            )}
          </>
        )}
      </section>

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
    </div>
  );
}
