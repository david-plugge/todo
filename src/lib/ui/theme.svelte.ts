import {
  applyTheme,
  isThemePreference,
  resolveTheme,
  themeStorageKey,
  type ThemePreference,
} from './theme';

function storedPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Reactive theme preference, persisted across sessions and kept in sync with the system setting. */
export function createTheme() {
  let preference = $state<ThemePreference>('system');
  let systemDark = $state(false);

  $effect(() => {
    preference = storedPreference();
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    systemDark = query.matches;
    const onChange = (event: MediaQueryListEvent) => (systemDark = event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  });

  $effect(() => {
    applyTheme(resolveTheme(preference, systemDark));
  });

  return {
    get preference() {
      return preference;
    },
    get resolved() {
      return resolveTheme(preference, systemDark);
    },
    set(next: ThemePreference) {
      preference = next;
      try {
        localStorage.setItem(themeStorageKey, next);
      } catch {
        // A blocked storage still themes the current session.
      }
    },
  };
}
