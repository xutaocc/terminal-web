/** Bounded observation only: silence never establishes command completion. */
export function readOptions(options, action) {
  if (!['read', 'exec'].includes(action)) return {};
  const number = (key, fallback, min, max, integer = false) => {
    if (options[key] === undefined) return fallback;
    const n = Number(options[key]);
    if (typeof options[key] !== 'string' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      throw Error(`--${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
    }
    return n;
  };
  const wait = number('wait', 0, 0, 30) * 1000;
  const batches = number('max-batches', 8, 1, 32, true);
  const bytes = number('max-bytes', 262144, 1024, 4194304, true);
  const after = number('after', undefined, 0, Number.MAX_SAFE_INTEGER, true);
  const aggregate = options.collect !== undefined || (action === 'exec' && options.wait !== undefined);
  if (options.collect !== undefined && options.collect !== true) throw Error('--collect is a flag');
  if (action === 'exec' && options.collect !== undefined && options.wait === undefined) throw Error('exec --collect requires --wait');
  if (action === 'exec' && options.after !== undefined) throw Error('--after is only supported for read');
  if (!aggregate && (options['max-batches'] !== undefined || options['max-bytes'] !== undefined)) throw Error('read limits require --collect or exec --wait');
  return { wait, batches, bytes, after, aggregate };
}

export async function collectEvents(call, state, save, options) {
  const start = performance.now();
  let cursor = options.after ?? state.cursor, epoch = state.epoch;
  const events = [];
  let bytes = 0, reads = 0, gap = false, last;
  const finish = reason => ({ ...last, events, gap, collection: { reason, reads, bytes,
    elapsedMs: Math.round(performance.now() - start), completion: 'unknown',
    mayHaveMore: ['batch-limit', 'byte-limit', 'deadline'].includes(reason) } });
  do {
    const remaining = Math.max(0, options.wait - (performance.now() - start));
    const waitMs = options.aggregate ? Math.min(events.length ? 200 : 5000, remaining) : Math.min(5000, options.wait);
    let data;
    try {
      data = await call('/events?' + new URLSearchParams({ after: String(cursor), waitMs: String(Math.floor(waitMs)), ...(epoch ? { epoch } : {}) }), 'GET');
    } catch (error) {
      // Preserve already acknowledged pages instead of losing them on a later read failure.
      if (!last) throw error;
      return { ...finish('read-error'), readError: String(error.message) };
    }
    if (!Array.isArray(data.events) || !Number.isSafeInteger(data.cursor) || data.cursor < 0 || typeof data.epoch !== 'string') throw Error('Invalid events response');
    state.cursor = cursor = data.cursor; state.epoch = epoch = data.epoch; save();
    if (!options.aggregate) return data;
    last = data; reads++; gap ||= !!data.gap;
    events.push(...data.events);
    bytes += Buffer.byteLength(JSON.stringify(data.events));
    if (!data.alive) return finish('closed');
    if (data.mine === false) return finish('not-owner');
    // Do not combine different terminal epochs as though their output were continuous.
    if (data.gap) return finish('gap');
    if (bytes >= options.bytes) return finish('byte-limit');
    if (reads >= options.batches) return finish('batch-limit');
    if (performance.now() - start >= options.wait) return finish('deadline');
    if (!data.events.length && events.length) return finish('quiet');
  } while (true);
}
