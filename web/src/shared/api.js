import { isStale, sameScene, staleError } from './scene.js';
import { state } from './state.js';

export function dispatchServer(method, args) {
  beginRequest(method);
  if (!window.eeCall) {
    endRequest(method);
    return Promise.reject(new Error('The EE Hub is still connecting.'));
  }
  return window.eeCall(method, args).then(function(result) {
    endRequest(method);
    return result;
  }, function(error) {
    endRequest(method);
    const message = error && error.message ? error.message : String(error);
    throw new Error(message);
  });
}

export function callServer(method) {
  const args = Array.prototype.slice.call(arguments, 1);
  const scene = state.scene;
  return dispatchServer(method, args).then(function(result) {
    if (!sameScene(scene)) throw staleError();
    return result;
  }, function(error) {
    if (!sameScene(scene)) throw staleError();
    throw error;
  });
}

export function runMutation(method, args, options) {
  const config = options || {};
  const queueKey = config.key || method;
  const prior = state.mutationQueues[queueKey] || Promise.resolve();
  const operation = prior.catch(function() {}).then(function() {
    const operationId = ++state.requests.nextId;
    if (config.start) config.start(operationId);
    return callServer.apply(null, [method].concat(args || [])).then(function(result) {
      if (config.confirm) config.confirm(result, operationId);
      return result;
    }).catch(function(error) {
      if (isStale(error)) return { stale: true };
      if (config.reject) {
        config.reject(error, operationId);
        return { rejected: true, error: error };
      }
      throw error;
    });
  });
  state.mutationQueues[queueKey] = operation.catch(function() {});
  return operation;
}

export function enqueueTicket(ticketId, work) {
  const key = 'ticket:' + ticketId;
  const prior = state.mutationQueues[key] || Promise.resolve();
  const operation = prior.catch(function() {}).then(work);
  state.mutationQueues[key] = operation.catch(function() {});
  return operation;
}

export function beginRequest(label) {
  state.requests.active += 1;
  const indicator = document.getElementById('request-indicator');
  if (indicator) {
    indicator.textContent = label ? 'Saving ' + humanizeRequestLabel(label) + '...' : 'Working...';
    indicator.classList.add('active');
    indicator.setAttribute('aria-busy', 'true');
  }
}

export function endRequest() {
  state.requests.active = Math.max(0, state.requests.active - 1);
  const indicator = document.getElementById('request-indicator');
  if (indicator && state.requests.active === 0) {
    indicator.textContent = '';
    indicator.classList.remove('active');
    indicator.setAttribute('aria-busy', 'false');
  }
}

export function humanizeRequestLabel(label) {
  return String(label).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

export function markSync(element, status) {
  if (!element) return;
  element.classList.remove('sync-pending', 'sync-confirmed', 'sync-rejected');
  if (status === 'pending') {
    element.classList.add('sync-pending');
    element.setAttribute('aria-busy', 'true');
    return;
  }
  element.setAttribute('aria-busy', 'false');
  if (status === 'confirmed' || status === 'rejected') {
    element.classList.add('sync-' + status);
    window.setTimeout(function() { element.classList.remove('sync-' + status); }, 900);
  }
}

export function quietServer(method, args) {
  if (!window.eeCall) return Promise.reject(new Error('The EE Hub is still connecting.'));
  return window.eeCall(method, args || []).then(function(result) {
    return result;
  }, function(error) {
    throw new Error(error && error.message ? error.message : String(error));
  });
}
