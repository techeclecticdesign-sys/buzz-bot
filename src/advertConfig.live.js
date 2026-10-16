// LIVE server advert channels. Loaded when ADVERT_ENV is unset or 'live'.
// Everything else (rules, banned words, embed, #rule_infractions default,
// :staffpending: emoji, quick long-form map) comes from advertConfig.base.js.
module.exports = require('./advertConfig.base').build({
  groupChannels: [
    '641842156193054739',
    '595369255436943458',
    '933517300999524372',
    '595369232422797327',
    '595369286160089109',
    '1139250122430095440',
  ],
  oneOnOneChannels: [
    '504322272618610688', // original_adverts
    '635906684489039902',
    '504322252611780609', // fandom_adverts
    '635906716579528714',
  ],
  quickChannels: [
    '595368932001710081',
    '595368989706813444',
  ],
  // The eleven channels rpc-web browses: every advert channel but partnered_groups.
  labelChannels: [
    '504322272618610688', // original_adverts
    '595368932001710081', // quick_originals
    '635906684489039902', // 18plus_original_ads
    '504322252611780609', // fandom_adverts
    '595368989706813444', // quick_fandoms
    '635906716579528714', // 18plus_fandom_ads
    '595369255436943458', // seeking_staff
    '933517300999524372', // seeking_groups
    '595369232422797327', // original_groups
    '595369286160089109', // fandom_groups
    '1139250122430095440', // 18plus_groups
  ],
  infractionsChannelId: '641835326314381312', // #rule_infractions (live)
  introChannelId: '1048992435591729182', // #member_introductions (live)
});
