// Shared advert-config builder. The per-server variant files
// (advertConfig.test.js / advertConfig.live.js) call build() with just their
// channel IDs; advertConfig.js picks which variant to load. Keeping the rules,
// banned list, and embed here — rather than duplicated per variant — avoids the
// drift problem the YAGPDB templates warn about.

const BANNED = ['futa', 'futanari', 'futas', 'futanaris']; // keep lowercase

const EMBED = {
  icon: 'https://i.ibb.co/mt5sNFb/Main.png',
  authorName: 'Roleplay Central Database',
  color: 14905344,
};

// Per-type rules (identical across servers).
//   headers: 'group' (≤1 sized) | 'none' (any disallowed) | false (skip)
//   images / links: true = disallowed, false = skip
const TYPES = {
  group: {
    name: 'group',
    lengthMode: 'chars',
    maxChars: 2100,
    lockoutHours: 168, // 7 days
    rules: { headers: 'group', images: false, links: false },
  },
  '1x1': {
    name: '1x1',
    lengthMode: 'chars',
    maxChars: 2100,
    lockoutHours: 96, // 4 days
    rules: { headers: 'none', images: true, links: false },
  },
  quick: {
    name: 'quick',
    lengthMode: 'words',
    maxWords: 105, // blocks at >= 105 words ("100 word limit" + buffer)
    lockoutHours: 96, // 4 days
    rules: { headers: 'none', images: true, links: true },
  },
};

function build(opts) {
  const {
    groupChannels = [],
    oneOnOneChannels = [],
    quickChannels = [],
    infractionsChannelId, // per-server — #rule_infractions
    advertRulesChannelId = '462444993529905172', // live default; override per server
    askTheStaffChannelId = '324571668569915393', // live default; override per server
    staffPendingEmoji = 'staffpending:1442331141771366513', // set null to skip the reaction
    // Over-length quick DM points to the matching long-form channel, keyed by
    // the quick channel's NAME (matches the template's .Channel.Name switch).
    // The names are the same on both servers, so this default serves both.
    quickLongformByName = {
      quick_fandoms: { name: 'fandom_adverts', id: '504322252611780609' },
      quick_originals: { name: 'original_adverts', id: '504322272618610688' },
    },
  } = opts;

  const SHARED = {
    infractionsChannelId,
    advertRulesChannelId,
    askTheStaffChannelId,
    staffPendingEmoji,
    graceSecs: 600, // 10-min delete-and-repost grace window
    banned: BANNED,
    embed: EMBED,
  };

  const CHANNEL_TYPE = new Map();
  for (const id of groupChannels) CHANNEL_TYPE.set(id, 'group');
  for (const id of oneOnOneChannels) CHANNEL_TYPE.set(id, '1x1');
  for (const id of quickChannels) CHANNEL_TYPE.set(id, 'quick');
  const ALL_ADVERT_CHANNELS = [...CHANNEL_TYPE.keys()];

  return {
    SHARED,
    TYPES,
    QUICK_LONGFORM_BY_NAME: quickLongformByName,
    ALL_ADVERT_CHANNELS,
    typeForChannel(channelId) {
      const key = CHANNEL_TYPE.get(channelId);
      return key ? TYPES[key] : null;
    },
    configured: ALL_ADVERT_CHANNELS.length > 0,
  };
}

module.exports = { build, TYPES };
