import { builtinQuotes, readQuotePool } from './admin';
import { getOpeningMessages } from './messaging';
import { App, audit, currentUser } from './session';
import { quoteDayStamp } from './util';

export async function loadingQuotes(app: App) {
  const today = quoteDayStamp();
  try {
    const stored = await app.store.getMeta('quotes');
    const quotes = Array.isArray(stored?.quotes) ? stored.quotes.map((line: unknown) => String(line || '').trim()).filter(Boolean) : [];
    if (stored?.day === today && quotes.length) return quotes;
  } catch { /* fall through */ }
  const pool = await readQuotePool(app).catch(() => builtinQuotes());
  const copy = pool.slice();
  const sample = [];
  const limit = Math.min(10, copy.length);
  for (let index = 0; index < limit; index++) {
    const pick = Math.floor(Math.random() * copy.length);
    sample.push(copy.splice(pick, 1)[0]);
  }
  const quotes = sample.length ? sample : builtinQuotes();
  try { await app.store.setMeta('quotes', { day: today, quotes }); } catch { /* still return quotes */ }
  return quotes;
}

export async function getAppBootstrap(app: App) {
  let quotes = builtinQuotes();
  try { quotes = await loadingQuotes(app); } catch { quotes = builtinQuotes(); }
  const quote = quotes[Math.floor(Math.random() * quotes.length)];
  try {
    const user = await currentUser(app);
    try { await audit(app, 'LOGIN_SUCCESS', { role: user.role }, user.email); } catch (error) { console.error('Unable to audit login', error); }
    let messages = null;
    try { messages = await getOpeningMessages(app); } catch (error) { console.error('Unable to load opening messages', error); }
    return { user, quote, quotes, messages };
  } catch (error) {
    try { await audit(app, 'ACCESS_DENIED', { reason: 'No authorized account' }, app.email); }
    catch (auditError) { console.error('Unable to audit denied login', auditError); }
    return { user: null, quote, quotes };
  }
}
