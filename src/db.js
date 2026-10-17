// Compatibility entry point for deployments that still have the old src/db.js.
// Node resolves that file before src/db/index.js; uploading this replacement
// keeps every require('./db') on the current modules and their shared pool.
module.exports = require('./db/index.js');
