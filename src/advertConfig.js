// Selects the advert config for the server this instance runs on.
// Set ADVERT_ENV=test on the test-server deployment; anything else (or unset)
// loads the live config. Each server runs its own logger-bot instance, so only
// one variant is active per process.
const env = (process.env.ADVERT_ENV || 'live').toLowerCase();

module.exports = env === 'test' ? require('./advertConfig.test') : require('./advertConfig.live');
