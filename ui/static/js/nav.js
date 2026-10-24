// Navigation hooks shared by the shell and the views. The shell (main.js) fills
// these in at start-up; views call them without importing main.js, which would
// make an import cycle.

const mq = window.matchMedia("(max-width: 860px)");  // must match styles.css
export const isMobile = () => mq.matches;
export const onBreakpointChange = (fn) => mq.addEventListener("change", fn);

export const nav = {
  go: (hash) => { location.hash = hash; },
  refresh: async () => {},
  reloadMe: async () => {},
  switchProfile: async () => {},
};
