import test from 'node:test';
import assert from 'node:assert/strict';
import { hostOfKey, hostUrl, makeKey, splitKey } from '../web/hosts.js';
import { remoteRoute, validRemoteUrl } from '../src/remotes.js';

test('local keys stay plain names; remote keys carry their host', () => {
  assert.equal(makeKey('', 'web'), 'web');
  assert.equal(makeKey('ab12', 'web'), '@ab12/web');
  assert.deepEqual(splitKey('@ab12/web'), { host: 'ab12', raw: 'web' });
  assert.deepEqual(splitKey('web'), { host: '', raw: 'web' });
  assert.deepEqual(splitKey(makeKey('ab12', '')), { host: 'ab12', raw: '' });
  assert.equal(hostOfKey('3f9a-uuid'), '');
});

test('remote API paths go through the forwarder', () => {
  assert.equal(hostUrl('', '/api/sessions'), '/api/sessions');
  assert.equal(hostUrl('ab12', '/ws'), '/remote/ab12/ws');
  assert.deepEqual(remoteRoute('/remote/ab12/api/files/list'), { id: 'ab12', rest: '/api/files/list' });
  assert.equal(remoteRoute('/remote/AB/ws'), null);
  assert.equal(remoteRoute('/api/sessions'), null);
});

test('remote addresses are plain http(s) origins', () => {
  assert.equal(validRemoteUrl(' http://192.168.88.119:8090/ '), 'http://192.168.88.119:8090');
  assert.equal(validRemoteUrl('ftp://x'), null);
  assert.equal(validRemoteUrl('http://u:p@x'), null);
  assert.equal(validRemoteUrl('nonsense'), null);
});

test('address suffixes are as short as they can be and still differ', async () => {
  const { shortAddresses } = await import('../web/hosts.js');
  assert.deepEqual(shortAddresses(['172.16.69.56', '192.168.88.119']), ['.56', '.119']);
  assert.deepEqual(shortAddresses(['192.168.1.5', '192.168.2.5']), ['.1.5', '.2.5']);
  assert.deepEqual(shortAddresses(['', 'nas.local']), ['', 'nas']);
});
