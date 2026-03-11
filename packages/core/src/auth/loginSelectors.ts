// Modern LinkedIn login inputs can be rendered with React-generated ids and
// no stable `name` attributes, so we match a small set of semantic fallbacks.
const LINKEDIN_LOGIN_EMAIL_INPUT_SELECTORS = [
  "input[name='session_key']",
  "input#username",
  "input[autocomplete~='username' i]",
  "input[inputmode='email' i]",
  "input[aria-label*='email' i]",
  "input[aria-label*='phone' i]",
  "input[placeholder*='email' i]",
  "input[placeholder*='phone' i]"
] as const;

const LINKEDIN_LOGIN_PASSWORD_INPUT_SELECTORS = [
  "input[name='session_password']",
  "input#password",
  "input[type='password']",
  "input[autocomplete~='current-password' i]",
  "input[aria-label*='password' i]",
  "input[placeholder*='password' i]"
] as const;

const LINKEDIN_LOGIN_OTHER_ACCOUNT_SELECTORS = [
  "a[data-view-name='sign-in-other-account-button-remember-me']:visible",
  "a[href='/login/'][data-view-name='sign-in-other-account-button-remember-me']:visible",
  "a[href='https://www.linkedin.com/login/'][data-view-name='sign-in-other-account-button-remember-me']:visible"
] as const;

const LINKEDIN_LOGIN_REMEMBERED_ACCOUNT_SELECTORS = [
  "[data-view-name='remember-me-submit-button']:visible"
] as const;

export const LINKEDIN_LOGIN_EMAIL_INPUT_SELECTOR =
  LINKEDIN_LOGIN_EMAIL_INPUT_SELECTORS.join(", ");

export const LINKEDIN_LOGIN_PASSWORD_INPUT_SELECTOR =
  LINKEDIN_LOGIN_PASSWORD_INPUT_SELECTORS.join(", ");

export const LINKEDIN_LOGIN_OTHER_ACCOUNT_SELECTOR =
  LINKEDIN_LOGIN_OTHER_ACCOUNT_SELECTORS.join(", ");

export const LINKEDIN_LOGIN_REMEMBERED_ACCOUNT_SELECTOR =
  LINKEDIN_LOGIN_REMEMBERED_ACCOUNT_SELECTORS.join(", ");
