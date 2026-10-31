// Applies the saved theme before the first paint so a light theme never flashes dark (and vice versa).
// Plain script outside the bundle because the CSP forbids inline scripts. Logic mirrors src/lib/theme.ts.
(function () {
  var mode = 'system';
  try {
    mode = localStorage.getItem('loadlab.theme') || 'system';
  } catch (e) {}
  var dark = mode === 'dark' || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
