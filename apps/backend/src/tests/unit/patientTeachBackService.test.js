import {
  buildTeachBackQuestions,
  detectTeachBackMisunderstandings,
  scoreTeachBackAnswers,
} from '../../services/ai/patientTeachBackService.js';

function medicationEvent(overrides = {}) {
  return {
    event_type: 'medication',
    id: overrides.id || 100,
    summary: overrides.summary || 'Amoxicillin 500 mg oral',
    timestamp: '2026-04-22T10:00:00.000Z',
    payload: overrides.payload || {
      medication_name: 'Amoxicillin',
      dose: '500 mg',
      route: 'oral',
      frequency: 'twice daily',
      duration: '7 days',
    },
  };
}

describe('patient teach-back helpers', () => {
  it('builds questions covering medications, warning signs, and emergency escalation', () => {
    const built = buildTeachBackQuestions({
      medications: [medicationEvent()],
      allergies: [{ id: 1, allergen: 'Penicillin' }],
      admission: { patient_uid: 'abc', discharge_follow_up: 'Follow up in OPD in 1 week' },
      aftercare: {
        medications: [{ name: 'Amoxicillin', dose: '500 mg', frequency: 'twice daily' }],
        warning_signs: ['high fever above 38 degrees', 'severe chest pain'],
        follow_up: 'Follow up in OPD in 1 week',
        diet: 'Avoid spicy food',
        activity: 'No heavy lifting',
        wound_care: 'Keep the wound clean and dry; change dressing daily',
        emergency: 'Call ambulance 108 for emergencies',
      },
      source_generation_id: 42,
    });

    const categories = new Set(built.questions.map((q) => q.category));
    expect(categories.has('medications')).toBe(true);
    expect(categories.has('warning_signs')).toBe(true);
    expect(categories.has('follow_up')).toBe(true);
    expect(categories.has('diet_activity')).toBe(true);
    expect(categories.has('wound_care')).toBe(true);
    expect(categories.has('emergency_escalation')).toBe(true);
    expect(built.coverage.medications).toBe(true);
    expect(built.coverage.emergency_escalation).toBe(true);
    expect(built.questions.every((q) => q.prompt && q.id)).toBe(true);
  });

  it('flags uncertain answers as misunderstandings without altering care', () => {
    const built = buildTeachBackQuestions({
      medications: [medicationEvent()],
      allergies: [],
      aftercare: {
        medications: [{ name: 'Amoxicillin' }],
        warning_signs: ['high fever'],
        emergency: 'Call 108',
      },
    });

    const medQuestion = built.questions.find((q) => q.category === 'medications');
    expect(medQuestion).toBeTruthy();

    const answers = built.questions.map((q) => ({
      question_id: q.id,
      answer: q.category === 'medications' ? q.expected : "I don't know",
    }));

    const scoring = scoreTeachBackAnswers({ questions: built.questions, answers });
    const flags = detectTeachBackMisunderstandings({ questions: built.questions, answers });

    expect(scoring.score).toBeLessThan(100);
    expect(scoring.score).toBeGreaterThan(0);
    expect(scoring.answered_count).toBe(built.questions.length);
    expect(flags.some((flag) => flag.code === 'TEACH_BACK_UNCERTAIN')).toBe(true);
    expect(flags.every((flag) => flag.question_id && flag.severity)).toBe(true);
  });

  it('raises score when keyword-grounded correct answers are provided', () => {
    const built = buildTeachBackQuestions({
      medications: [medicationEvent()],
      aftercare: {
        medications: [{ name: 'Amoxicillin', dose: '500 mg', frequency: 'twice daily' }],
        warning_signs: ['high fever above 38 degrees'],
        follow_up: 'OPD in one week',
        emergency: 'Call ambulance 108',
      },
    });

    const correctAnswers = built.questions.map((q) => {
      if (q.category === 'emergency_escalation') return { question_id: q.id, answer: 'Call 108 ambulance' };
      if (q.category === 'medications' && Array.isArray(q.choices)) {
        return { question_id: q.id, answer: q.expected };
      }
      return { question_id: q.id, answer: q.expected || 'fever' };
    });

    const scoring = scoreTeachBackAnswers({ questions: built.questions, answers: correctAnswers });
    const flags = detectTeachBackMisunderstandings({
      questions: built.questions,
      answers: correctAnswers,
    });

    expect(scoring.score).toBeGreaterThan(60);
    expect(flags.length).toBeLessThan(built.questions.length);
  });

  it('accepts 108 / 112 as valid emergency answers', () => {
    const built = buildTeachBackQuestions({
      aftercare: { emergency: 'Call 108 emergency' },
    });
    const emergencyQuestion = built.questions.find((q) => q.category === 'emergency_escalation');
    expect(emergencyQuestion).toBeTruthy();

    const scoring = scoreTeachBackAnswers({
      questions: [emergencyQuestion],
      answers: [{ question_id: emergencyQuestion.id, answer: '112' }],
    });
    const flags = detectTeachBackMisunderstandings({
      questions: [emergencyQuestion],
      answers: [{ question_id: emergencyQuestion.id, answer: '112' }],
    });

    expect(scoring.score).toBe(100);
    expect(flags).toHaveLength(0);
  });
});
