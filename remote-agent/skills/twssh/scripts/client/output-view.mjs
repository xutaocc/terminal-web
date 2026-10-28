/** Limit stdout sent to agents; the server's original records remain unchanged. */
export function outputView(data, detail = 'compact') {
  if (!['compact','readable','raw','full'].includes(detail)) throw Error('--detail must be compact, readable, raw or full');
  if (detail === 'full' || !data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(value => outputView(value, detail));
  const result = {...data};
  if (Array.isArray(result.records)) result.records = result.records.map(r => outputView(r, detail));
  if (typeof result.input !== 'string') return result;
  const {input, decodedInput, decodedParts, decodedEncoding, decodedScope, ...metadata} = result;
  if (detail === 'raw') return {...metadata, input};
  const parts = Array.isArray(decodedParts) ? decodedParts : [];
  let readable = decodedInput ?? input;
  for (const [i, part] of parts.entries()) if (part.expression) readable = readable.replace(part.expression, `[content fragment ${i + 1}]`);
  if (detail === 'readable') return {...metadata, readableInput: readable, previewOnly: true,
    ...(parts.length ? {decodedParts:parts.map(({expression,...part}) => part)} : {})};
  // Older servers may have no preview: don't echo a giant encoded command.
  return {...metadata, inputPreview: readable.slice(0, 240), previewTruncated: readable.length > 240,
    ...(parts.length ? {contentFragments:parts.length} : {}), detailsAvailable:true};
}
