export interface QuestionContent {
  questionId: string;
  topic: string;
  difficulty: string;
  type: 'mc' | 'flip';
  prompt: string | null;
  options: string[] | null;
  optionsAlt: string[] | null;
  correctIndex: number | null;
  explain: string | null;
  front: string | null;
  back: string | null;
  source: string[];
}

export interface TopicMeta {
  id: string;
  label: string;
  accent: string;
}

export interface DifficultyMeta {
  id: string;
  label: string;
}
