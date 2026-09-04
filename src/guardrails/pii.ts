/**
 * Aegis AI Gateway - In-Flight Guardrails & PII Sanitizer
 * Scans user inputs for Indonesian NIK, phone numbers, emails, credit cards,
 * sensitive API keys, and prompt injection signatures before hitting upstream LLMs.
 */

export interface PiiDetectionResult {
  sanitizedText: string;
  redactedCount: number;
  entities: {
    type: "NIK" | "PHONE" | "EMAIL" | "CREDIT_CARD" | "SECRET_KEY";
    count: number;
    sampleRedacted: string;
  }[];
  isInjectionRisk: boolean;
  injectionFlags: string[];
}

// Indonesian NIK validator (16 digits)
// Structure: [2 digits province][2 digits regency/city][2 digits district][6 digits birthdate][4 digits sequence]
const NIK_REGEX = /\b([1-9][0-9]{15})\b/g;

// Phone number regex (Indonesian 08xx, +628xx, 628xx and International)
const PHONE_REGEX = /(\+?62\s?|0)8[1-9][0-9]{1,2}[\s-]?[0-9]{3,4}[\s-]?[0-9]{3,5}\b/g;

// Email regex
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g;

// Credit Card (Visa, Mastercard, Amex, etc. with length 13-19)
const CARD_REGEX = /\b(?:\d{4}[ -]?){3}\d{4}\b|\b(?:\d{4}[ -]?){2}\d{5}\b/g;

// Secrets & API Keys (OpenAI sk-..., GitHub ghp_..., generic tokens)
const SECRET_KEY_REGEX = /\b(sk-[a-zA-Z0-9_\-]{20,}|ghp_[a-zA-Z0-9]{30,}|Bearer\s+[A-Za-z0-9\-_]{20,})\b/g;

// Prompt injection heuristic patterns
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+(instructions|prompts|rules)/i,
  /system\s+prompt\s+(override|leak|reveal)/i,
  /you\s+are\s+now\s+(unfiltered|dan|evil|jailbroken)/i,
  /disregard\s+the\s+above/i,
  /acting\s+as\s+an\s+unrestricted\s+ai/i,
  /print\s+(your\s+)?initial\s+instructions/i,
];

// Helper: Simple Luhn algorithm check for credit cards
function isLuhnValid(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export function sanitizeInput(text: string): PiiDetectionResult {
  if (!text || typeof text !== "string") {
    return {
      sanitizedText: text,
      redactedCount: 0,
      entities: [],
      isInjectionRisk: false,
      injectionFlags: [],
    };
  }

  let sanitized = text;
  const entityMap = new Map<string, { count: number; sample: string }>();

  function recordEntity(type: string, sample: string) {
    const existing = entityMap.get(type) || { count: 0, sample };
    existing.count += 1;
    entityMap.set(type, existing);
  }

  // 1. Redact Secrets & API Keys
  sanitized = sanitized.replace(SECRET_KEY_REGEX, (match) => {
    recordEntity("SECRET_KEY", match.substring(0, 4) + "..." + match.slice(-4));
    return "[REDACTED_API_KEY]";
  });

  // 2. Redact Indonesian NIK (16 Digits)
  sanitized = sanitized.replace(NIK_REGEX, (match) => {
    recordEntity("NIK", match.substring(0, 4) + "xxxxxxxx" + match.slice(-4));
    return "[REDACTED_NIK]";
  });

  // 3. Redact Credit Cards (Verify with Luhn)
  sanitized = sanitized.replace(CARD_REGEX, (match) => {
    if (isLuhnValid(match)) {
      recordEntity("CREDIT_CARD", "****-****-****-" + match.slice(-4));
      return "[REDACTED_CREDIT_CARD]";
    }
    return match;
  });

  // 4. Redact Emails
  sanitized = sanitized.replace(EMAIL_REGEX, (match) => {
    const [user, domain] = match.split("@");
    const maskedUser = user.length > 2 ? user[0] + "***" + user.slice(-1) : "***";
    recordEntity("EMAIL", `${maskedUser}@${domain}`);
    return "[REDACTED_EMAIL]";
  });

  // 5. Redact Indonesian Phone Numbers
  sanitized = sanitized.replace(PHONE_REGEX, (match) => {
    recordEntity("PHONE", match.substring(0, 4) + "xxxx" + match.slice(-2));
    return "[REDACTED_PHONE]";
  });

  // 6. Check for Prompt Injection
  const injectionFlags: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      injectionFlags.push(pattern.source);
    }
  }

  const entities = Array.from(entityMap.entries()).map(([type, data]) => ({
    type: type as any,
    count: data.count,
    sampleRedacted: data.sample,
  }));

  const totalRedacted = entities.reduce((acc, curr) => acc + curr.count, 0);

  return {
    sanitizedText: sanitized,
    redactedCount: totalRedacted,
    entities,
    isInjectionRisk: injectionFlags.length > 0,
    injectionFlags,
  };
}

/**
 * Sanitizes entire OpenAI messages array recursively
 */
export function sanitizeMessages(messages: any[]): {
  sanitizedMessages: any[];
  totalRedacted: number;
  allEntities: any[];
  isInjectionRisk: boolean;
  injectionFlags: string[];
} {
  let totalRedacted = 0;
  const entityMap = new Map<string, number>();
  const flags: string[] = [];
  let hasInjection = false;

  const sanitizedMessages = messages.map((msg) => {
    if (typeof msg.content === "string") {
      const res = sanitizeInput(msg.content);
      totalRedacted += res.redactedCount;
      if (res.isInjectionRisk) {
        hasInjection = true;
        flags.push(...res.injectionFlags);
      }
      res.entities.forEach((e) => {
        entityMap.set(e.type, (entityMap.get(e.type) || 0) + e.count);
      });
      return { ...msg, content: res.sanitizedText };
    }
    return msg;
  });

  return {
    sanitizedMessages,
    totalRedacted,
    allEntities: Array.from(entityMap.entries()).map(([type, count]) => ({ type, count })),
    isInjectionRisk: hasInjection,
    injectionFlags: flags,
  };
}
