/**
 * Theme switch, shared by every page.
 *
 * Light is the default because that is what was asked for; the choice is remembered per
 * browser and stamped on <html> before first paint by the inline snippet in each page,
 * so there is no flash of the wrong theme.
 */
const KEY = 'woohoo-console-theme';

export function currentTheme() {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private window - the choice just will not persist */
  }
}

/** Adds the toggle to a container and keeps its label in step. */
export function mountThemeToggle(container) {
  if (!container) return;
  const button = document.createElement('button');
  button.className = 'theme-toggle';
  const label = () => (currentTheme() === 'dark' ? 'Light' : 'Dark');
  button.textContent = label();
  button.title = 'Switch theme';
  button.addEventListener('click', () => {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    button.textContent = label();
  });
  container.prepend(button);
}

applyTheme(currentTheme());
