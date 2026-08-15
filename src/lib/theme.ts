/**
 * Theme preference — a per-machine display setting persisted in localStorage.
 *
 * Ported from inkubus/frontend/src/theme.js, with the polarity inverted: Coglin
 * is a light-first product (plan §4), so LIGHT is the absence of the attribute
 * and `[data-theme="dark"]` is the exception. Adds a "system" mode, which
 * Inkubus does not have.
 *
 * The initial application happens in an inline script in index.html, before
 * first paint — see THEME_BOOT_SCRIPT. Anything that runs after the bundle
 * loads is already too late to avoid a flash.
 */

export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'coglin.theme';

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** What "system" currently resolves to. */
export function systemTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? systemTheme() : theme;
}

export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  if (resolved === 'dark') {
    document.documentElement.dataset.theme = 'dark';
  } else {
    delete document.documentElement.dataset.theme;
  }
  // Lets the browser paint form controls and scrollbars to match.
  document.documentElement.style.colorScheme = resolved;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode — the theme just won't persist */
  }
}

/**
 * Re-apply when the OS flips, but only while the user is on "system".
 * Returns an unsubscribe function.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => {};
  const handler = () => {
    if (storedTheme() === 'system') onChange();
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

/**
 * Inlined verbatim into index.html. Kept here so the storage key and the
 * attribute logic have exactly one source of truth — if you edit this, copy it
 * across. It is deliberately tiny and dependency-free: it runs before anything
 * else on the page.
 */
export const THEME_BOOT_SCRIPT = `
try {
  var t = localStorage.getItem('${THEME_KEY}');
  var dark = t === 'dark' || (t !== 'light' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.dataset.theme = 'dark';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
} catch (e) {}
`;
