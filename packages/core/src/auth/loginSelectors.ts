// Modern LinkedIn login inputs can be rendered with React-generated ids and
// no stable `name` attributes, so we match a small set of semantic fallbacks.
const LINKEDIN_LOGIN_EMAIL_INPUT_SELECTORS = [
  "input#username",
  "input[name='session_key']:not([type='hidden'])",
  "input[autocomplete~='username' i]",
  "input[inputmode='email' i]",
  "input[aria-label*='email' i]",
  "input[aria-label*='phone' i]",
  "input[placeholder*='email' i]",
  "input[placeholder*='phone' i]",
] as const;

const LINKEDIN_LOGIN_PASSWORD_INPUT_SELECTORS = [
  "input#password",
  "input[name='session_password']:not([type='hidden'])",
  "input[type='password']",
  "input[autocomplete~='current-password' i]",
  "input[aria-label*='password' i]",
  "input[placeholder*='password' i]",
] as const;

export const LINKEDIN_LOGIN_EMAIL_INPUT_SELECTOR =
  LINKEDIN_LOGIN_EMAIL_INPUT_SELECTORS.join(", ");

export const LINKEDIN_LOGIN_PASSWORD_INPUT_SELECTOR =
  LINKEDIN_LOGIN_PASSWORD_INPUT_SELECTORS.join(", ");
