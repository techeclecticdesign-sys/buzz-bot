// Facade for the data layer. The queries are split by feature into the sibling
// modules; this re-exports them (plus the shared pool and the schema init) as one
// object, so every consumer keeps doing `require('./db').fn(...)` unchanged.
//
//   pool.js         shared Pool + retrying query()
//   migrate.js      init() — schema + in-place migrations
//   messages.js     archive, edits/deletes, advert reads, image attachments, prunes
//   memberState.js  nickname + role tracking
//   userState.js    account-level username / display-name tracking
//   settings.js     per-guild logging preferences
//   flaggedPosts.js link-check grace tracking
//   infractions.js  advert re-check queue + #rule_infractions ledger
//   approvals.js    approved advert-text hashes (repost recognition)
//   tcgCards.js     trading-card approval flags (rpc-web's cards)
//   marketerPfps.js banned marketer profile pictures (pfpGuard)
//   advertLabels.js AI advert keyword batches + labels (advertLabeller)
const { pool } = require('./pool');
const { init } = require('./migrate');

module.exports = {
  pool,
  init,
  ...require('./messages'),
  ...require('./memberState'),
  ...require('./userState'),
  ...require('./settings'),
  ...require('./flaggedPosts'),
  ...require('./infractions'),
  ...require('./approvals'),
  ...require('./tcgCards'),
  ...require('./marketerPfps'),
  ...require('./advertLabels'),
};
