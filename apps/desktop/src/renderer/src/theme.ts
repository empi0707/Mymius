export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'mymius.theme'
export const THEME_EVENT = 'mymius-theme'

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

/** What is actually showing, once "system" has been resolved. */
export function isDark(): boolean {
  const c = getThemeChoice()
  return c === 'dark' || (c === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', choice)
  void window.mymius.setTheme(choice) // native dialogs and menus follow too
  window.dispatchEvent(new Event(THEME_EVENT))
}

export function setThemeChoice(choice: ThemeChoice): void {
  try { localStorage.setItem(KEY, choice) } catch { /* private window: applies for this session only */ }
  applyTheme(choice)
}
