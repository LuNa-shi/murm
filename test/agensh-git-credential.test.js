import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialReply } from '../scripts/git-credential-agensh.mjs';

test('image Git helper releases only this peer token for its exact repository', () => {
  const env = { RUN_REPOSITORY: 'http://172.18.0.1:3000/run/repo.git', GITEA_TOKEN: 'private-marker', GITEA_USERNAME: 'peer' };
  const input = 'protocol=http\nhost=172.18.0.1:3000\npath=run/repo.git\n\n';
  assert.equal(credentialReply('get', input, env), 'username=peer\npassword=private-marker\n\n');
  assert.equal(credentialReply('store', input, env), '');
  for (const forbidden of [input.replace('3000', '3001'), input.replace('run/repo', 'other/repo'), input.replace('http', 'https'), input + 'username=other\n', input + 'host=evil\n']) {
    assert.equal(credentialReply('get', forbidden, env), '');
  }
  assert.equal(credentialReply('get', input, { ...env, RUN_REPOSITORY: 'http://user:secret@172.18.0.1:3000/run/repo.git' }), '');
});
