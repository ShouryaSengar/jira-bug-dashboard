// Runs right after the sidebar is parsed, before the first paint: puts the sidebar back where you left it, and makes
// sure the current guide is visible. Without this the list starts at the top on every page and visibly jumps.
(() => {
  const side = document.getElementById('learnSide');
  if (!side) return;
  let saved = null;
  try { saved = sessionStorage.getItem('jbd.v1.learn.side'); } catch { /* storage blocked */ }
  if (saved !== null) side.scrollTop = Number(saved) || 0;
  const on = side.querySelector('a.on');
  if (on) {
    const top = on.getBoundingClientRect().top - side.getBoundingClientRect().top + side.scrollTop;
    const outside = top < side.scrollTop + 8 || top + on.offsetHeight > side.scrollTop + side.clientHeight - 8;
    if (outside && side.clientHeight > 0) side.scrollTop = Math.max(0, top - side.clientHeight / 2);
  }
})();
