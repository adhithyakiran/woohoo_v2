/**
 * PII redaction — architecture doc §57.2.
 *
 * Runs before the transcript enters the model context or the audit store. The failure mode to
 * avoid is over-redaction that breaks the turn: "send this to [NAME]" is useless. So the
 * redactor has two profiles — the audit copy is redacted hard, the model copy keeps what the
 * agent actually needs.
 *
 * Card numbers are the one category blocked on BOTH paths unconditionally (§60.1): a guest
 * reading a card number aloud in a hotel room must never reach a model, a log or a vendor.
 */

export type RedactionProfile = 'model' | 'audit';

export interface RedactionResult {
  text: string;
  /** Category counts only. The values themselves are never recorded (§70). */
  found: Record<string, number>;
}

interface Rule {
  category: string;
  re: RegExp;
  replacement: string;
  profiles: RedactionProfile[];
}

const RULES: Rule[] = [
  // Payment card shapes: 13–19 digits with optional separators, Luhn-checked below.
  {
    category: 'card',
    re: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: '[REDACTED_CARD]',
    profiles: ['model', 'audit'],
  },
  {
    category: 'email',
    re: /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi,
    replacement: '[EMAIL]',
    profiles: ['model', 'audit'],
  },
  {
    category: 'phone',
    re: /(?<!\d)(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]?\d{3,4}(?!\d)/g,
    replacement: '[PHONE]',
    profiles: ['audit'],
  },
  {
    category: 'passport',
    re: /\b[A-Z]{1,2}\d{6,9}\b/g,
    replacement: '[ID]',
    profiles: ['model', 'audit'],
  },
];

function luhnValid(digits: string): boolean {
  const s = digits.replace(/\D/g, '');
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redact(text: string, profile: RedactionProfile): RedactionResult {
  const found: Record<string, number> = {};
  let out = text;

  for (const rule of RULES) {
    if (!rule.profiles.includes(profile)) continue;
    out = out.replace(rule.re, (match) => {
      // Only treat a digit run as a card if it actually passes Luhn — otherwise room numbers,
      // times and prices get shredded and the turn stops working.
      if (rule.category === 'card' && !luhnValid(match)) return match;
      found[rule.category] = (found[rule.category] ?? 0) + 1;
      return rule.replacement;
    });
  }

  return { text: out, found };
}

/**
 * Kept deliberately: room numbers, times, dates, menu items, temperatures, free-text problem
 * descriptions and sentiment. The agent needs all of them, and none identifies a person on
 * their own once the stay reference is tokenised (§55.2).
 */
export const RETAINED_BY_DESIGN = [
  'room number',
  'times and dates',
  'menu items',
  'temperatures',
  'problem descriptions',
] as const;
