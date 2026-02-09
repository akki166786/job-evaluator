import type { JobData, ResumeRecord } from './types';

const SYSTEM_PROMPT = `You are a strict career advisor. Your goal is to save the user's time by reducing wasted applications.
You must respond with ONLY a single valid JSON object. No markdown, no code fences, no text before or after the JSON. Be conservative; scores above 75 should be rare.
Rules for JSON: use only double quotes for strings; use \\n for newlines inside strings (never literal line breaks); no trailing commas after the last item in objects or arrays. Keep explanation and bullet strings short (one short sentence each). Tone: factual, direct, no hype.`;

function escapeForPrompt(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

export function buildUserPrompt(
  job: JobData,
  profileIntent: string,
  skillsTechStack: string,
  negativeFilters: string,
  resumes: ResumeRecord[]
): string {
  const jobBlock = `
## JOB
Title: ${escapeForPrompt(job.title)}
Location: ${escapeForPrompt(job.location)}

Description:
${escapeForPrompt(job.description)}
`.trim();

  const profileBlock = `
## USER PROFILE INTENT (what they want)
${profileIntent ? escapeForPrompt(profileIntent) : '(None provided)'}
`.trim();

  const skillsBlock = `
## USER SKILLS / TECH STACK
${skillsTechStack ? escapeForPrompt(skillsTechStack) : '(None provided)'}
`.trim();

  const negativeBlock = `
## USER NEGATIVE FILTERS (hard deal-breakers; if job violates these, verdict must be not_worth or maybe and score low)
${negativeFilters ? escapeForPrompt(negativeFilters) : '(None provided)'}
`.trim();

  const resumesBlock =
    resumes.length > 0
      ? `
## USER RESUMES (label + text; pick bestResumeLabel from one of these labels)
${resumes
  .map(
    (r) =>
      `--- Resume: ${r.label} ---\n${escapeForPrompt(r.text)}\n`
  )
  .join('\n')}
`.trim()
      : `
## USER RESUMES
(No resumes provided. Match only against profile intent and skills/tech stack above.)
`.trim();

  const hasResumes = resumes.length > 0;
  const instructions = hasResumes
    ? `
## INSTRUCTIONS

1. **Phase 1 — Hard rejection**: Check for clear deal-breakers against the user's negative filters, profile intent, and skills/tech stack (e.g. language like "Fluent Dutch required", on-site-only far from user, tech stack opposite to skills like Java when they list JavaScript, seniority mismatch). If any clear violation: set verdict to "not_worth" or "maybe", set hardRejectionReason, and keep score below 40.

2. **Phase 2 — Semantic matching**: If not hard-rejected, compare the job to each resume, profile intent, and skills/tech stack. Compute fit (skill overlap, seniority, domain). Choose bestResumeLabel (one of the resume labels that fits best). Score 0–100: ~70% resume–job relevance, ~30% profile+skills alignment. Remain conservative; 75+ only for strong fit.

Respond with ONLY this JSON object (no other text). Example format:
{"score":50,"verdict":"maybe","hardRejectionReason":null,"matchBullets":["skill match"],"riskBullets":["missing X"],"bestResumeLabel":"Frontend","explanation":"One short sentence."}
Required keys: score (0-100 number), verdict ("worth" or "maybe" or "not_worth"), hardRejectionReason (string or null), matchBullets (array of short strings), riskBullets (array of short strings), bestResumeLabel (one of the resume labels), explanation (one short sentence). No trailing commas. No newlines inside strings.
`.trim()
    : `
## INSTRUCTIONS

1. **Phase 1 — Hard rejection**: Check for clear deal-breakers against the user's negative filters, profile intent, and skills/tech stack (e.g. language requirements, on-site-only, tech stack opposite to their skills, seniority mismatch). If any clear violation: set verdict to "not_worth" or "maybe", set hardRejectionReason, and keep score below 40.

2. **Phase 2 — Semantic matching**: No resumes are provided. Match the job only against the user's profile intent and skills/tech stack. Compute fit (skill overlap with job requirements, seniority, domain). Set bestResumeLabel to null. Score 0–100 based on how well the job aligns with intent and skills. Remain conservative; 75+ only for strong fit.

Respond with ONLY this JSON object (no other text). Example format:
{"score":50,"verdict":"maybe","hardRejectionReason":null,"matchBullets":["skill match"],"riskBullets":["missing X"],"bestResumeLabel":null,"explanation":"One short sentence."}
Required keys: score (0-100 number), verdict ("worth" or "maybe" or "not_worth"), hardRejectionReason (string or null), matchBullets (array of short strings), riskBullets (array of short strings), bestResumeLabel (must be null when no resumes), explanation (one short sentence). No trailing commas. No newlines inside strings.
`.trim();

  return [jobBlock, profileBlock, skillsBlock, negativeBlock, resumesBlock, instructions].join('\n\n');
}

export { SYSTEM_PROMPT };
