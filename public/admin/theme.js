(function () {
  var theme = null;
  try { theme = localStorage.getItem('icpc-theme'); } catch (e) { /* storage blocked */ }
  if (theme !== 'dark' && theme !== 'light') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();