import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCommandPreview, withCommandPreview } from '../src/command-preview.js';
const ps = (text: string) => `powershell -NoProfile -EncodedCommand ${Buffer.from(text, 'utf16le').toString('base64')}`;
const node = (text: string) => `node -e "eval(Buffer.from('${Buffer.from(text).toString('base64')}','base64').toString())"`;
test('decodes supported wrappers without changing original inputs', () => {
  const text = "Write-Output '你好';\nGet-Location";
  assert.equal(decodeCommandPreview(ps(text))?.decodedInput, text);
  assert.equal(decodeCommandPreview(ps(text))?.decodedEncoding, 'utf-16le');
  assert.equal(decodeCommandPreview(node('console.log("你好")'))?.decodedInput, 'console.log("你好")');
  const wrapped = `& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text).toString('base64')}'))))`;
  assert.equal(decodeCommandPreview(wrapped)?.decodedInput, text);
  const old = { input: ps(text), time: '2026-10-28T00:00:00Z' };
  const enriched = withCommandPreview(old) as typeof old & { decodedInput: string };
  assert.equal(enriched.input, old.input); assert.equal(enriched.decodedInput, text);
  assert.equal('decodedInput' in old, false);
});
test('unrecognized, invalid, oversized and sensitive inputs fail closed without throwing', () => {
  for (const input of [null, {}, 'echo SGVsbG8=', 'powershell -EncodedCommand !!!!',
    'powershell -EncodedCommand YQ==', node('\u0000'), node('x'.repeat(8193)),
    node('ok') + '; Remove-Item file', 'echo ' + ps('Get-Location'),
    'node -e "eval(Buffer.from(\'/w==\',\'base64\').toString())"']) {
    assert.equal(decodeCommandPreview(input), null);
  }
  assert.equal(decodeCommandPreview(ps('secret'), true), null);
  assert.deepEqual(withCommandPreview({ input: '[sensitive input]' }), { input: '[sensitive input]' });
});
test('decodes one layer and never executes scripts', () => {
  const inner = node('throw new Error("never run")');
  assert.equal(decodeCommandPreview(node(inner))?.decodedInput, inner);
});

test('nested literal file content is readable, bounded and legacy-compatible', () => {
  const code = 'print("你好")\n';
  const body = `[IO.File]::WriteAllBytes('app.py',[Convert]::FromBase64String('${Buffer.from(code).toString('base64')}'))`;
  const preview = decodeCommandPreview(ps(body))!;
  assert.equal(preview.decodedParts?.[0].text, code);
  assert.equal(preview.decodedInput, body);
  const old = {input:ps(body), decodedInput:body};
  assert.equal((withCommandPreview(old) as typeof preview).decodedParts?.[0].text, code);
  assert.equal('decodedParts' in old, false);
  const binary = decodeCommandPreview(ps("[Convert]::FromBase64String('AA==')"))!;
  assert.equal(binary.decodedParts?.[0].status,'skipped');
  const many = decodeCommandPreview(ps(Array(10).fill("[Convert]::FromBase64String('b2s=')").join(';')))!;
  assert.equal(many.decodedParts?.length,9);
  assert.equal(many.decodedParts?.[8].status,'skipped');
  assert.equal(decodeCommandPreview(ps(body),true),null);
});
