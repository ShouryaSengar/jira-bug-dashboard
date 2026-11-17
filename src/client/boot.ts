// Runs before first paint (loaded synchronously in <head>) so the saved theme never flashes.
try {
  const prefs = JSON.parse(localStorage.getItem('jbd.v1.prefs') || '{}') as { theme?: string; accent?: string };
  const root = document.documentElement;
  root.dataset['theme'] = prefs.theme || 'system';
  root.dataset['accent'] = prefs.accent || 'blue';
} catch {
  /* storage blocked: defaults apply */
}
