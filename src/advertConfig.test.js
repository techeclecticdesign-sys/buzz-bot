// TEST server advert channels. Loaded when ADVERT_ENV=test.
// Only the channel lists and #rule_infractions differ from live — the
// :staffpending: reaction, DM footers, and quick long-form map are inherited
// from advertConfig.base.js (same as before / same as live).
module.exports = require('./advertConfig.base').build({
  groupChannels: [
    '1517731392623214622',
  ],
  oneOnOneChannels: [
    '1517639866731462697',
    '1517648098778812546',
    '1517648613830824078',
    '1517650539490443324',
  ],
  quickChannels: [
    '1517639785953497099',
    '1517648585259356312',
  ],
  infractionsChannelId: '1505355022828048384', // #rule_infractions (test)
});
