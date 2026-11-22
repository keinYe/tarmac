import type { IParser, IDisposable } from '@xterm/xterm';

export interface QueryGuard extends IDisposable {
  shouldForwardData(): boolean;
}

// The daemon owns terminal replies. Consume query sequences through public
// parser hooks, preserving onData for keyboard, IME, paste and mouse events.
export function suppressTerminalQueries(parser: IParser): QueryGuard {
  const handlers: IDisposable[] = [];
  let colorQueryTurn = false;
  for (const id of [
    { final: 'c' },
    { prefix: '>', final: 'c' },
    { prefix: '=', final: 'c' },
    { final: 'n' },
    { prefix: '?', final: 'n' },
    { prefix: '>', final: 'q' },
    { intermediates: '$', final: 'p' },
    { prefix: '?', intermediates: '$', final: 'p' },
    { prefix: '?', final: 'u' },
  ]) handlers.push(parser.registerCsiHandler(id, () => true));
  handlers.push(parser.registerCsiHandler({ final: 't' }, params => {
    const value = params[0];
    return typeof value === 'number' && value >= 11 && value <= 21;
  }));
  for (const id of [
    { intermediates: '$', final: 'q' },
    { intermediates: '+', final: 'q' },
  ]) handlers.push(parser.registerDcsHandler(id, () => true));
  for (const id of [4, 10, 11, 12]) {
    handlers.push(parser.registerOscHandler(id, data => {
      if (data.split(';').includes('?') && !colorQueryTurn) {
        // In pinned xterm 6, the native color handler emits its reply
        // synchronously. Keep its SET operations intact and suppress only
        // data produced in this JS turn; real DOM input runs after this clears.
        colorQueryTurn = true;
        queueMicrotask(() => { colorQueryTurn = false; });
      }
      return false;
    }));
  }
  return {
    shouldForwardData: () => !colorQueryTurn,
    dispose: () => { handlers.forEach(handler => handler.dispose()); colorQueryTurn = false; },
  };
}
