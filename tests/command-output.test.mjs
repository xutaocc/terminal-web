import test from 'node:test';
import assert from 'node:assert/strict';
import {outputView} from '../remote-agent/client/output-view.mjs';
test('compact output omits duplicates, details remain available on demand', () => {
  const record = {requestId:'r',state:'sent',input:'BASE64'.repeat(1000),decodedInput:'write expression',decodedParts:[{expression:'expression',status:'decoded',text:'print("hello")'}]};
  const compact = outputView({records:[record]});
  assert.equal(compact.records[0].input,undefined);
  assert.equal(compact.records[0].decodedParts,undefined);
  assert.equal(compact.records[0].inputPreview,'write [content fragment 1]');
  const readable = outputView(record,'readable');
  assert.equal(readable.decodedParts[0].text,'print("hello")');
  assert.equal(readable.decodedParts[0].expression,undefined);
  assert.equal(outputView(record,'raw').input,record.input);
  assert.equal(outputView(record,'full'),record);
  assert.throws(()=>outputView(null,'invalid'));
  assert.equal(record.decodedInput,'write expression');
  assert.deepEqual(outputView({events:[{data:'terminal output'}]}),{events:[{data:'terminal output'}]});
});
