import { state } from './state.js';

export function advanceScene() {
  state.scene += 1;
  return state.scene;
}

export function sameScene(scene) {
  return scene === state.scene;
}

export function staleError() {
  const error = new Error('Ignored outdated response.');
  error.stale = true;
  return error;
}

export function isStale(error) {
  return !!(error && error.stale);
}
