const MONEY_MAX_ABSOLUTE = 1_000_000_000_000;

function normalizeText(value) {
  return String(value ?? "")
    .replaceAll("−", "-")
    .replaceAll("﹣", "-")
    .replaceAll("－", "-")
    .replaceAll("＄", "$")
    .replaceAll("\u00a0", " ")
    .replace(/\s+/g, " ");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse the first bounded numeric value immediately following a visible card label. */
export function parseLabeledNumber(text, label) {
  const normalized = normalizeText(text);
  const labelMatch = normalized.match(new RegExp(escapeRegExp(label), "i"));
  if (!labelMatch || labelMatch.index === undefined) return Number.NaN;

  const start = labelMatch.index + labelMatch[0].length;
  const suffix = normalized.slice(start, start + 96);
  const match = suffix.match(
    /^\s*(\()?\s*([+-])?\s*(?:USD\s*)?\$?\s*([+-])?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(\))?/i,
  );
  if (!match) return Number.NaN;

  const openingParenthesis = Boolean(match[1]);
  const closingParenthesis = Boolean(match[5]);
  if (openingParenthesis !== closingParenthesis) return Number.NaN;
  if (match[2] && match[3]) return Number.NaN;
  if ((match[2] === "+" || match[3] === "+") && openingParenthesis) return Number.NaN;

  const parsed = Number(match[4].replaceAll(",", ""));
  if (!Number.isFinite(parsed) || parsed > MONEY_MAX_ABSOLUTE) return Number.NaN;
  return openingParenthesis || match[2] === "-" || match[3] === "-" ? -parsed : parsed;
}

export function parseLabeledMoney(text, label) {
  return parseLabeledNumber(text, label);
}

export function parseAgentRouterUserId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function normalizeAgentRouterUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const id = parseAgentRouterUserId(user.id);
  return id === null ? null : { ...user, id };
}

export function authoritativeMoneyFromUser(user, quotaPerUnit) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  if (typeof quotaPerUnit !== "number" || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) return null;

  const quota = user.quota;
  const usedQuota = user.used_quota;
  const requestCount = user.request_count;
  if (typeof quota !== "number" || !Number.isFinite(quota)) return null;
  if (typeof usedQuota !== "number" || !Number.isFinite(usedQuota) || usedQuota < 0) return null;
  if (!Number.isSafeInteger(requestCount) || requestCount < 0) return null;

  return {
    balance: quota / quotaPerUnit,
    consumed: usedQuota / quotaPerUnit,
    requestCount,
  };
}
