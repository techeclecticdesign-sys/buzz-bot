const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const db = require('./db');
const current = require('./db/index.js');

after(() => current.pool.end());

test('the legacy database entry point exposes the current store and the same pool', () => {
  assert.equal(require.resolve('./db'), path.join(__dirname, 'db.js'));
  assert.equal(db, current);
  assert.equal(db.pool, require('./db/pool').pool);
  for (const name of [
    'init', 'upsertMessage', 'pruneMessagesNotInChannels',
    'setLabellerTokenHash', 'expireStaleLabelBatches', 'pruneAdvertLabels',
    'pruneDepartedMemberState', 'setMemberAge', 'setMemberAges', 'deleteMemberState',
    'deleteApprovedHash', 'listMarketerPfps', 'listTcgCards', 'unapproveDeletedTcgCards',
  ]) {
    assert.equal(typeof db[name], 'function', `${name} must be exposed by require('./db')`);
  }
});

test('replacing a stale db.js fixes its precedence over an uploaded db directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-db-entry-'));
  t.after(() => {
    // Remove only the exact temporary fixture created by this test.
    delete require.cache[path.join(dir, 'db.js')];
    delete require.cache[path.join(dir, 'db', 'index.js')];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'db'));
  fs.writeFileSync(path.join(dir, 'db', 'index.js'), 'module.exports = { current: true };');
  fs.writeFileSync(path.join(dir, 'db.js'), 'module.exports = { legacy: true };');
  const deployedRequire = createRequire(path.join(dir, 'consumer.js'));

  // Uploading the folder alone does not replace the file Node actually loads.
  assert.deepEqual(deployedRequire('./db'), { legacy: true });
  assert.deepEqual(deployedRequire('./db/index.js'), { current: true });

  fs.copyFileSync(path.join(__dirname, 'db.js'), path.join(dir, 'db.js'));
  delete require.cache[deployedRequire.resolve('./db')];
  assert.equal(deployedRequire('./db'), deployedRequire('./db/index.js'));
  assert.deepEqual(deployedRequire('./db'), { current: true });
});
