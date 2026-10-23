require('dotenv').config();
const {
  AuditLogEvent,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');
const config = require('./config');
config.validate();
const db = require('./db');
const jsonArchive = require('./jsonArchive');
const { isIgnoredMessage } = require('./ignoredChannels');
const failsafe = require('./failsafe');
const advertFailsafe = require('./advertFailsafe');
const infractionSticky = require('./infractionSticky');
const infractionExpiry = require('./infractionExpiry');
const onboardingFailsafe = require('./onboardingFailsafe');
const advertConfig = require('./advertConfig');
const advertImages = require('./advertImages');
const retention = require('./retention');
const linkCheck = require('./checkLinks');
const memberStats = require('./memberStatsCollector');
const game = require('./game');
const polls = require('./polls');
const adultCheck = require('./adultCheck');
const surveySubmissions = require('./surveySubmissions');
const advertReconcile = require('./advertReconcile');
const advertLabeller = require('./advertLabeller');
const { siteAdvertAuthor } = require('./advertAttribution');
const fandomReport = require('./fandomReport');
const pfpGuard = require('./pfpGuard');
const { sleep } = require('./util');
const { DESC_MAX, truncate, splitTruncate, attachmentList } = require('./format');
const { memberJoinEmbed, memberLeaveEmbed, buildSettingsMessage } = require('./embeds');
const { findDeleteExecutor, primeAuditCounts } = require('./auditLog');
const { consumeBotDelete } = require('./botDeleteAttribution');
const memberTracking = require('./memberTracking');
const memberAgesFactory = require('./memberAges');
const memberAges = memberAgesFactory.create();
const { memberRoleIds, queueMemberChange } = memberTracking;
const commands = require('./commands');
const { PREFIX, NICK_PREFIX, handleCommand, handleNickPrefixCommand } = commands;
const advertSyncFactory = require('./advertSync');
const tcgApprovalFactory = require('./tcgApproval');

const { TOKEN, LOG_CHANNEL_ID, IGNORE_BOTS, LOGGING_ENABLED } = config;

// Intents are requested per enabled feature. Logging, age tracking and the
// failsafe read messages/members; the
// failsafe additionally needs presence to see whether YAGPDB is online.
const needMessageIntents = LOGGING_ENABLED || failsafe.ENABLED || surveySubmissions.enabled || memberAgesFactory.ENABLED;
const intents = [GatewayIntentBits.Guilds];
if (needMessageIntents) {
  intents.push(
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    // Reactions serve two features: the onboarding failsafe's rules-agreement
    // step, and keeping advert posts' reaction counts current for rpc-web.
    GatewayIntentBits.GuildMessageReactions
  );
}
// The pfp guard only needs join events.
if (pfpGuard.ENABLED && !intents.includes(GatewayIntentBits.GuildMembers)) {
  intents.push(GatewayIntentBits.GuildMembers);
}
// Presence sees whether YAGPDB is online (drives the failsafes).
if (failsafe.ENABLED) {
  intents.push(GatewayIntentBits.GuildPresences);
}

const client = new Client({
  intents,
  // Partials make update/delete events fire for uncached messages, member-update
  // for uncached members, and the rules reaction fire on the old rules message.
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.Reaction],
});

// Advert channels whose posts' reactions we keep mirrored for rpc-web. Empty
// when no advert config is set (test/game-only), which disables the sync.
const ADVERT_CHANNEL_SET = new Set(advertConfig.ALL_ADVERT_CHANNELS);

// Member/user diff trackers and advert sync close over the client and the log
// sender, so they're wired once here (sendLog is a hoisted function below).
const { trackMemberChanges, trackUserNameChanges } = memberTracking.create({ sendLog, client });
const advertSync = advertSyncFactory.create({
  loggingEnabled: LOGGING_ENABLED,
  advertChannelSet: ADVERT_CHANNEL_SET,
  advertConfig,
});
const tcgApproval = tcgApprovalFactory.create({
  client,
  emojiId: advertSyncFactory.parseEmojiId(advertConfig.SHARED?.staffApprovedEmoji),
});

async function sendLog(payload) {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    // Master switch (>>settings): when off, stay silent in the log channel.
    // Everything is still archived to the DB — only the channel post is skipped.
    const settings = await db.getGuildSettings();
    if (!settings.log_to_channel) return;
    await channel.send(payload);
  } catch (err) {
    console.error('[log] failed to send to log channel:', err.message);
  }
}

async function botDeletedByLine(guild) {
  let displayName = client.user?.username ?? 'logger-bot';
  if (guild?.members) {
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    displayName = me?.displayName ?? displayName;
  }
  return displayName;
}

// The member an ad posted from rpc-web belongs to (null for any other message).
// These come from our own webhook, so they're bot posts that IGNORE_BOTS would drop.
function siteAuthor(message) {
  return siteAdvertAuthor(message, client.application?.id, advertConfig.ALL_ADVERT_CHANNELS);
}

function shouldTrack(message) {
  if (!message.guildId) return false; // ignore DMs
  if (message.channelId === memberAgesFactory.CHANNEL_ID) return false; // age baseline only; no raw archive
  if (message.channelId === LOG_CHANNEL_ID) return false; // avoid feedback loops
  if (isIgnoredMessage(message)) return false; // IGNORE_CHANNELS opt-out
  if (message.author?.id === client.user.id) return false;
  if (IGNORE_BOTS && message.author?.bot && !siteAuthor(message)) return false;
  return true;
}

client.on('messageCreate', async (message) => {
  try {
    await memberAges.onMessage(message);
  } catch (err) {
    console.error('[member-ages] live update failed:', err.message);
  }
  // #rule_infractions sticky cleanup: when anyone other than logger-bot posts
  // there, YAGPDB owns the sticky again, so drop any copycat we left. Runs before
  // the shouldTrack gate because #rule_infractions may be an ignored channel.
  try {
    await infractionSticky.handleForeignPost(message);
  } catch (err) {
    console.error('[infr-sticky] cleanup error:', err.message);
  }
  if (message.guildId && !message.author.bot) {
    if (message.content.startsWith(PREFIX)) await handleCommand(message);
    else if (message.content.startsWith(NICK_PREFIX)) await handleNickPrefixCommand(message);
  }
  // Onboarding failsafe: age verification in the age channel. Runs BEFORE the
  // shouldTrack gate because the age channel is (deliberately) in IGNORE_CHANNELS
  // for privacy — otherwise the age→Rules Please advance would never fire there.
  // It self-gates on YAGPDB being offline and the channel/member matching, and it
  // never archives the message, so the privacy intent is preserved.
  try {
    await onboardingFailsafe.handleAgeMessage(message, sendLog);
  } catch (err) {
    console.error('[onboarding-failsafe] error:', err.message);
  }
  // Questionnaire posts may be sent by a webhook/bot and their channel can be
  // ignored by the archive, so this runs before shouldTrack(). The handler is
  // inert until both the Apps Script URL and its shared secret are configured.
  try {
    await surveySubmissions.handleMessage(message);
  } catch (err) {
    console.error('[survey-submissions] handler error:', err.message);
  }
  if (!shouldTrack(message)) return;
  if (LOGGING_ENABLED) {
    try {
      await db.upsertMessage(message, { author: siteAuthor(message) ?? undefined });
      // Group-ad images are captured after the row exists (setAdvertAttachments
      // updates it). Own try/catch inside, so it never masks the insert error.
      await advertSync.syncAdvertImages(message);
    } catch (err) {
      console.error('[create] db error:', err.message);
    }
  }
  // Advert failsafe runs after archiving so its cooldown/duplicate queries see
  // prior posts. It self-gates: no-ops unless YAGPDB is offline and this is a
  // configured advert channel.
  try {
    await advertFailsafe.handleAdvert(message, sendLog);
  } catch (err) {
    console.error('[advert-failsafe] error:', err.message);
  }
  // Member-intro failsafe: 800-char limit + one-intro-per-member. Self-gates on
  // YAGPDB being offline and the message being in the configured intros channel.
  try {
    await advertFailsafe.handleIntro(message, sendLog);
  } catch (err) {
    console.error('[intro-failsafe] error:', err.message);
  }
});

client.on('messageUpdate', async (_oldMessage, newMessage) => {
  // The edit path serves two features: edit logging (needs LOGGING_ENABLED) and
  // advert/intro edit-enforcement (independent of logging). Bail early only when
  // none is active, so a game-only or logging-off bot still stays cheap.
  if (!LOGGING_ENABLED && !advertFailsafe.editChecksActive && !advertFailsafe.introEditActive) return;
  try {
    if (newMessage.partial) newMessage = await newMessage.fetch();
  } catch {
    return; // message was deleted before we could fetch it
  }
  if (!shouldTrack(newMessage)) return;

  // Discord fires messageUpdate for pins, embed loads, flag changes, etc.
  // Real content edits always set editedTimestamp; the rest never do.
  if (!newMessage.editedTimestamp) return;

  // Look up the archived (pre-edit) content: drives the content-changed guard and
  // the before/after log. editedTimestamp stays set forever, so Discord re-fires
  // messageUpdate for embed unfurls/pins/flag changes that don't touch the text;
  // the guard skips those so edit-enforcement doesn't re-flag. The archive is
  // updated at the end of this handler, so a genuine edit differs while a re-fire
  // matches.
  let stored;
  try {
    stored = await db.getMessage(newMessage.id);
  } catch (err) {
    console.error('[update] archive lookup error:', err.message);
  }
  const oldContent = stored?.content ?? null;
  const contentUnchanged = oldContent !== null && oldContent === newMessage.content;

  // Enforce advert rules on genuinely-edited content. YAGPDB's free tier can't run
  // commands on edits, so this always runs (not just during an outage). It's
  // non-destructive (over-length is warned, not deleted); skipped when the text is
  // unchanged so an edit isn't double-flagged.
  if (!contentUnchanged) {
    try {
      await advertFailsafe.handleAdvertEdit(newMessage, sendLog);
    } catch (err) {
      console.error('[advert-edit] error:', err.message);
    }
    // Same for member intros: an edit that pushes the intro over the 800-char
    // limit is warned (not deleted), which YAGPDB's free tier can't do on edits.
    try {
      await advertFailsafe.handleIntroEdit(newMessage, sendLog);
    } catch (err) {
      console.error('[intro-edit] error:', err.message);
    }
  }

  if (!LOGGING_ENABLED) return;

  try {
    // Already logged this edit (e.g. a later embed-load event re-fired update),
    // or an attachment-only edit that left the text unchanged. Skip the edit
    // log, but still reconcile group-ad images — an image may have been added or
    // removed with no text change (a no-op when the image set is untouched).
    if (contentUnchanged) {
      await advertSync.reconcileAdvertImages(newMessage, stored);
      return;
    }

    const beforeText = oldContent !== null
      ? (oldContent || '*(no text content)*')
      : '*(original not archived — sent before this bot came online)*';
    const afterText = newMessage.content || '*(no text content)*';

    const meta =
      `**Author:** ${newMessage.author} (\`${newMessage.author.tag}\`)\n` +
      `**Channel:** ${newMessage.channel} — [jump to message](${newMessage.url})\n` +
      `**Originally sent:** <t:${Math.floor(newMessage.createdTimestamp / 1000)}:f>`;

    // The description minus the two bodies (metadata + labels + separators); its
    // length is the budget the before/after bodies share.
    const scaffold = `${meta}\n\n**Before:**\n\n\n**After:**\n`;
    const [before, after] = splitTruncate(beforeText, afterText, DESC_MAX - scaffold.length);

    const embed = new EmbedBuilder()
      .setColor(0xf5a623)
      .setTitle('Message edited')
      .setDescription(`${meta}\n\n**Before:**\n${before}\n\n**After:**\n${after}`)
      .setFooter({ text: `Message ID: ${newMessage.id}` })
      .setTimestamp();

    await sendLog({ embeds: [embed] });
    jsonArchive.append(newMessage.guildId, newMessage.channelId, newMessage.channel?.name, {
      type: 'edit',
      id: newMessage.id,
      authorTag: newMessage.author.tag,
      before: oldContent,
      after: newMessage.content ?? '',
      at: new Date().toISOString(),
    });

    if (stored) {
      await db.updateContent(newMessage.id, newMessage.content ?? '', new Date());
    } else {
      await db.upsertMessage(newMessage, { author: siteAuthor(newMessage) ?? undefined });
    }
    // Reconcile group-ad images (row exists now for the FK); only re-downloads
    // when the image set changed.
    await advertSync.reconcileAdvertImages(newMessage, stored);
  } catch (err) {
    console.error('[update] error:', err.message);
  }
});

client.on('messageDelete', async (message) => {
  // The advert failsafe deleted this itself and already logged it — skip the
  // embed. Consumed before the LOGGING_ENABLED guard so the marker never leaks.
  if (advertFailsafe.consumeSuppressedDelete(message.id)) return;
  const botDelete = consumeBotDelete(message.id);
  if (!LOGGING_ENABLED) return;
  if (message.guildId && message.channelId === LOG_CHANNEL_ID) return;
  // IGNORE_CHANNELS opt-out, matching shouldTrack.
  if (isIgnoredMessage(message)) return;
  // IGNORE_BOTS applies to the post's author, not the deleter: a bot's post was
  // never archived, so skip it (a human post deleted by a bot is still logged).
  // Catches cached bot posts; uncached ones are handled after the row lookup.
  // Ads posted from rpc-web are archived, so their deletes are tracked.
  if (IGNORE_BOTS && message.author?.bot && !siteAuthor(message)) return;
  try {
    const stored = await db.getMessage(message.id);
    if (!stored && !message.guildId) return; // uncached DM, nothing to report
    // Uncached bot post (IGNORE_BOTS on): no stored row and no cached author, so
    // logging it yields a useless "unknown" embed. A human post is archived on
    // create, so a missing row + missing author means it was a bot (or predates us).
    if (IGNORE_BOTS && !stored && !message.author) return;

    const authorLine = stored
      ? `<@${stored.author_id}> (\`${stored.author_tag}\`)`
      : message.author
        ? `${message.author} (\`${message.author.tag}\`)`
        : '*unknown (not archived)*';
    const content = stored ? stored.content : message.content;
    // Attachments aren't in the DB, so list them only when the message is still
    // cached (non-partial).
    const attachments = message.attachments
      ? [...message.attachments.values()].map((a) => ({ name: a.name, url: a.url }))
      : [];
    const createdAt = stored?.created_at ?? message.createdAt;

    if (stored?.author_id === client.user.id) return;

    const authorId = stored?.author_id ?? message.author?.id ?? null;
    let executor = null;
    let deletedBy;
    if (botDelete) {
      deletedBy = await botDeletedByLine(message.guild ?? client.guilds.cache.get(message.guildId));
    } else {
      executor = await findDeleteExecutor(message.guild, authorId, message.channelId);
      deletedBy =
        executor ? `${executor} (\`${executor.tag}\`)`
        : executor === null ? 'Not in audit log (deleted either by author or a bot).'
        : '*unknown*';
    }

    // A stored row or a cached (non-partial) message means we know the real
    // content (even if empty — attachment-only messages).
    const contentText = stored || !message.partial
      ? (content || '*(no text content)*')
      : '*(content not archived — sent before this bot came online)*';

    const meta =
      `**Author:** ${authorLine}\n` +
      `**Deleted by:** ${deletedBy}\n` +
      (botDelete ? `**Reason:** ${botDelete.reason}\n` : '') +
      `**Channel:** <#${stored?.channel_id ?? message.channelId}>\n` +
      (createdAt ? `**Originally sent:** <t:${Math.floor(new Date(createdAt).getTime() / 1000)}:f>` : '');

    const scaffold = `${meta}\n\n**Content:**\n`;
    const body = truncate(contentText, DESC_MAX - scaffold.length);

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('Message deleted')
      .setDescription(`${meta}\n\n**Content:**\n${body}`)
      .setFooter({ text: `Message ID: ${message.id}` })
      .setTimestamp();

    const files = attachmentList(attachments);
    if (files) embed.addFields({ name: 'Attachments', value: files });

    await sendLog({ embeds: [embed] });
    jsonArchive.append(message.guildId, stored?.channel_id ?? message.channelId, message.channel?.name, {
      type: 'delete',
      id: message.id,
      authorTag: stored?.author_tag ?? message.author?.tag ?? null,
      deletedBy: botDelete
        ? client.user?.tag ?? 'logger-bot'
        : executor?.tag ?? (executor === null ? 'author-or-bot' : null),
      deleteReason: botDelete?.reason ?? null,
      content: stored ? stored.content : message.content ?? null,
      at: new Date().toISOString(),
    });
    if (stored) await db.markDeleted(message.id);
    // Reclaim any stored group-ad image bytes for the removed post.
    if (advertImages.isGroupChannel(message.channelId)) {
      await db.clearAdvertAttachments(message.id);
    }
  } catch (err) {
    console.error('[delete] error:', err.message);
  }
});

client.on('messageDeleteBulk', async (messages) => {
  if (!LOGGING_ENABLED) return;
  if (messages.first()?.channelId === LOG_CHANNEL_ID) return;
  if (isIgnoredMessage(messages.first() ?? {})) return; // IGNORE_CHANNELS opt-out
  const ids = [...messages.keys()];
  try {
    const stored = await db.getMessages(ids);
    const byId = new Map(stored.map((r) => [r.id, r]));

    const lines = ids.map((id) => {
      const r = byId.get(id);
      if (!r) return `[${id}] (not archived)`;
      const when = r.created_at ? new Date(r.created_at).toISOString() : 'unknown time';
      return `[${when}] ${r.author_tag ?? r.author_id}: ${r.content || '(no text content)'}`;
    });

    const channelId = stored[0]?.channel_id ?? messages.first()?.channelId;

    // Bulk deletes have their own audit type; the entry is always fresh.
    let purgedBy = '*unknown*';
    try {
      await sleep(1200);
      const guild = messages.first()?.guild;
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageBulkDelete, limit: 5 });
      const entry = logs.entries.find(
        (e) => e.targetId === channelId && Date.now() - e.createdTimestamp < 10_000
      );
      if (entry?.executor) purgedBy = `${entry.executor} (\`${entry.executor.tag}\`)`;
    } catch (err) {
      console.error('[audit] bulk fetch failed:', err.message);
    }

    const transcript = new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), {
      name: `bulk-delete-${Date.now()}.txt`,
    });
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('Bulk message delete')
      .setDescription(
        `**${ids.length}** messages deleted in <#${channelId}> by ${purgedBy}. Full transcript attached.`
      )
      .setTimestamp();

    await sendLog({ embeds: [embed], files: [transcript] });
    const first = messages.first();
    for (const id of ids) {
      const r = byId.get(id);
      jsonArchive.append(first?.guildId, r?.channel_id ?? first?.channelId, first?.channel?.name, {
        type: 'delete',
        id,
        bulk: true,
        authorTag: r?.author_tag ?? null,
        content: r?.content ?? null,
        at: new Date().toISOString(),
      });
    }
    await db.markDeleted(ids);
    if (advertImages.isGroupChannel(channelId)) {
      await Promise.all(ids.map((id) => db.clearAdvertAttachments(id)));
    }
  } catch (err) {
    console.error('[bulk-delete] error:', err.message);
  }
});

// Onboarding failsafe: reacting to the rules message advances Rules Please →
// Newbie while YAGPDB is offline. Self-gates on message id, emoji, YAGPDB status.
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    await onboardingFailsafe.handleRulesReaction(reaction, user, sendLog);
  } catch (err) {
    console.error('[onboarding-failsafe] reaction error:', err.message);
  }
});

// Keep advert posts' stored reactions and trading-card approvals current on
// add/remove/clear. The syncs live in advertSync (gated to advert channels) and
// tcgApproval (gated to :staffapproved: on card posts); these just forward.
client.on(Events.MessageReactionAdd, (reaction) => {
  advertSync.syncAdvertReactions(reaction);
  tcgApproval.onReaction(reaction);
});
client.on(Events.MessageReactionRemove, (reaction) => {
  advertSync.syncAdvertReactions(reaction);
  tcgApproval.onReaction(reaction);
});
client.on(Events.MessageReactionRemoveEmoji, (reaction) => {
  advertSync.syncAdvertReactions(reaction);
  tcgApproval.onReaction(reaction);
});
// Removing all reactions gives a message, not a reaction — clear the column.
client.on(Events.MessageReactionRemoveAll, (message) => {
  advertSync.clearAdvertReactions(message);
  tcgApproval.onReactionsCleared(message);
});
// A deleted card post or thread unapproves the card.
client.on(Events.MessageDelete, (message) => {
  tcgApproval.onDeleted({ messageIds: [message.id] });
});
client.on(Events.MessageBulkDelete, (messages) => {
  tcgApproval.onDeleted({ messageIds: [...messages.keys()] });
});
client.on(Events.ThreadDelete, (thread) => {
  tcgApproval.onDeleted({ channelId: thread.id });
});

// Seed a baseline for brand-new members so their first nickname/role change is
// captured (trackMemberChanges only logs once a baseline exists).
client.on(Events.GuildMemberAdd, async (member) => {
  memberAges.onJoin(member);
  if (!LOGGING_ENABLED && memberAgesFactory.ENABLED) {
    try {
      await queueMemberChange(`${member.guild.id}:${member.id}`, () => db.seedMemberState(
        member.id, member.user.tag, member.nickname ?? null, memberRoleIds(member), member.displayName ?? null
      ));
    } catch (err) {
      console.error('[member-add] age baseline error:', err.message);
    }
  }
  if (LOGGING_ENABLED) {
    try {
      // Queue both immediately so a quick leave cannot delete first and have
      // a still-running join handler recreate either baseline afterwards.
      await Promise.all([
        queueMemberChange(`${member.guild.id}:${member.id}`, () => db.seedMemberState(
          member.id, member.user.tag, member.nickname ?? null,
          memberRoleIds(member), member.displayName ?? null
        )),
        queueMemberChange(`user:${member.id}`, () => db.seedUserState(
          member.id, member.user.username, member.user.globalName ?? null
        )),
      ]);
    } catch (err) {
      console.error('[member-add] db error:', err.message);
    }
    // Post the join card. Separate try so a DB hiccup above never blocks it.
    try {
      await sendLog({ embeds: [memberJoinEmbed(member)] });
    } catch (err) {
      console.error('[member-add] log error:', err.message);
    }
  }
  // Kick members wearing a banned marketer pfp; a kicked member needs no gate role.
  try {
    if (await pfpGuard.handleMemberJoin(member, sendLog)) return;
  } catch (err) {
    console.error('[member-add] pfp guard error:', err.message);
  }
  // Assign the Age Please gate role on join instantly (idempotent if YAGPDB also
  // assigns it). Separate try so a DB hiccup above doesn't block it.
  try {
    await failsafe.handleMemberJoin(member, sendLog);
  } catch (err) {
    console.error('[member-add] failsafe error:', err.message);
  }
});

// Leave card on any departure (leave/kick/ban). memberLeaveEmbed handles a
// partial/uncached member. Always on; sendLog still honours log_to_channel.
client.on(Events.GuildMemberRemove, async (member) => {
  if (member.user?.id === client.user.id) return; // ignore our own removal
  // Hard-delete the departed member's baselines (roles/nickname/names). Queued on
  // the same keys as the change trackers so an in-flight update can't re-write the
  // row after we drop it. A rejoin then seeds fresh from their actual (empty) roles.
  try {
    await Promise.all([
      memberAges.onLeave(member),
      queueMemberChange(`user:${member.id}`, () => db.deleteUserState(member.id)),
    ]);
  } catch (err) {
    console.error('[member-remove] db error:', err.message);
  }
  if (!LOGGING_ENABLED) return;
  try {
    await sendLog({ embeds: [memberLeaveEmbed(member)] });
  } catch (err) {
    console.error('[member-remove] log error:', err.message);
  }
});

client.on(Events.GuildMemberUpdate, async (_oldMember, newMember) => {
  if (!LOGGING_ENABLED) return;
  const isCurrent = memberAges.current(newMember);
  try {
    if (newMember.partial) newMember = await newMember.fetch();
  } catch {
    return; // member left before we could fetch
  }
  try {
    const member = newMember;
    await queueMemberChange(`${member.guild.id}:${member.id}`, () => {
      if (isCurrent()) return trackMemberChanges(member);
    });
  } catch (err) {
    console.error('[member-update] error:', err.message);
  }
});

client.on(Events.UserUpdate, async (_oldUser, newUser) => {
  if (!LOGGING_ENABLED) return;
  try {
    // Serialize per user: userUpdate also fires for avatars and Discord can
    // deliver duplicates, so two handlers could diff the same stale user_state and
    // double-post. The `user:` prefix avoids colliding with guild-member keys.
    await queueMemberChange(`user:${newUser.id}`, () => {
      if ([...client.guilds.cache.values()].some((g) => g.members.cache.has(newUser.id))) {
        return trackUserNameChanges(newUser);
      }
    });
  } catch (err) {
    console.error('[user-update] error:', err.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton() || !interaction.customId.startsWith('settings:toggle:')) return;
    if (!interaction.guild || interaction.user.id !== interaction.guild.ownerId) {
      await interaction.reply({
        content: 'Only the server owner can change these settings.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Flip the one toggled field, keep the rest, and re-render in place.
    // customId is settings:toggle:channel (master switch) or settings:toggle:role.
    const current = await db.getGuildSettings();
    const field = interaction.customId.endsWith(':channel') ? 'log_to_channel' : 'log_role_changes';
    const next = {
      log_role_changes: current.log_role_changes,
      log_to_channel: current.log_to_channel,
      [field]: !current[field],
    };
    await db.setGuildSettings(next);
    await interaction.update(buildSettingsMessage(next));
  } catch (err) {
    console.error('[interaction] error:', err.message);
  }
});

// Game interactions (slash commands + its buttons/menus). Self-gates and
// self-catches, so it's a no-op for non-game interactions or when disabled.
client.on(Events.InteractionCreate, (interaction) => {
  if (game.ENABLED) game.handleInteraction(interaction);
});

// Anonymous poll interactions. Self-gates on /poll, /closepoll, and poll button
// custom IDs.
client.on(Events.InteractionCreate, (interaction) => {
  if (polls.ENABLED) polls.handleInteraction(interaction);
});

// Age-restricted /verify-adult. Self-gates on its command name.
client.on(Events.InteractionCreate, (interaction) => {
  if (adultCheck.ENABLED) adultCheck.handleInteraction(interaction);
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}.`);
  const slashCommands = [];
  if (game.ENABLED) slashCommands.push(...game.commandData());
  if (polls.ENABLED) slashCommands.push(...polls.commandData());
  if (adultCheck.ENABLED) slashCommands.push(...adultCheck.commandData());
  if (slashCommands.length) {
    for (const guild of client.guilds.cache.values()) {
      try {
        await client.application.commands.set(slashCommands, guild.id);
        console.log(`[commands] registered ${slashCommands.length} command(s) in ${guild.name}`);
      } catch (err) {
        console.error(`[commands] registration failed for ${guild.name}:`, err.message);
      }
    }
  }
  if (polls.ENABLED) await polls.start(client);

  // Prime member state so post-startup changes are detected even for members who
  // never fired an event. The fetch also populates the cache the failsafe needs.
  if (needMessageIntents) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const startedAt = new Date();
        const members = await guild.members.fetch();
        if (LOGGING_ENABLED) {
          for (const member of members.values()) {
            await Promise.all([
              queueMemberChange(`${guild.id}:${member.id}`, async () => {
                if (!guild.members.cache.has(member.id)) return;
                await db.seedMemberState(member.id, member.user.tag, member.nickname ?? null,
                  memberRoleIds(member), member.displayName ?? null);
              }),
              queueMemberChange(`user:${member.id}`, async () => {
                if (!guild.members.cache.has(member.id)) return;
                await db.seedUserState(member.id, member.user.username, member.user.globalName ?? null);
              }),
            ]);
          }
        }
        // Drop baselines for anyone who left while we were offline. Tables carry
        // no guild_id, so only safe when this is the bot's only guild.
        if (client.guilds.cache.size === 1 && members.size > 0) {
          const present = [...guild.members.cache.keys()];
          const goneMembers = await db.pruneDepartedMemberState(present, startedAt);
          const goneUsers = await db.pruneDepartedUserState(present, startedAt);
          if (goneMembers || goneUsers) {
            console.log(`[seed] dropped ${goneMembers} member_state / ${goneUsers} user_state row(s) for departed members`);
          }
        }
        console.log(`[seed] members primed for ${guild.name} (${members.size})`);
      } catch (err) {
        console.warn(`[seed] could not prime members for ${guild.name}:`, err.message);
      }
    }
  }
  // Catch age declarations missed while offline, including the initial history.
  // Runs in the background so a long channel scan doesn't delay bot startup.
  memberAges.backfill(client).catch((err) => console.error('[member-ages] backfill failed:', err.message));

  // Prime audit counters so deletes right after a restart aren't misread as
  // self-deletes when a mod's existing audit entry gets incremented.
  if (LOGGING_ENABLED) {
    for (const guild of client.guilds.cache.values()) {
      try {
        await primeAuditCounts(guild);
      } catch (err) {
        console.warn(`[audit] could not prime counts for ${guild.name}:`, err.message);
      }
    }
  }

  // Report failsafe/YAGPDB detection so a misconfigured match is obvious at boot.
  if (failsafe.ENABLED) {
    for (const guild of client.guilds.cache.values()) {
      const s = failsafe.describeStatus(guild);
      const names = s.found.map((m) => `${m.user.username}=${failsafe.statusLabel(m)}`).join(', ') || 'none';
      console.log(
        `[failsafe] ${guild.name}: ${s.found.length} YAGPDB bot(s) [${names}] → ` +
        `${s.active ? 'ACTIVE (YAGPDB offline)' : 'standby (YAGPDB online)'}`
      );
      if (s.found.length === 0) {
        console.warn(`[failsafe] no YAGPDB match in ${guild.name} — it would treat YAGPDB as offline.`);
      }
    }
    if (advertFailsafe.configured) {
      console.log(`[failsafe] advert failsafe armed for ${advertFailsafe.channelCount} channel(s).`);
      if (!LOGGING_ENABLED) {
        console.warn(
          '[failsafe] LOGGING_ENABLED=false — new adverts are not archived, so the advert ' +
          "failsafe's cooldown/duplicate checks have nothing to compare against " +
          '(length and advisory checks still work).'
        );
      }
    } else {
      console.log('[failsafe] advert failsafe inactive — no channel IDs set in src/advertConfig.js.');
    }
    if (advertFailsafe.introConfigured) {
      console.log('[failsafe] member-intro failsafe armed (800-char limit + one per member).');
    } else {
      console.log('[failsafe] member-intro failsafe inactive — no introChannelId set in src/advertConfig.js.');
    }
    if (onboardingFailsafe.configured) {
      console.log(`[failsafe] onboarding failsafe armed for age channel ${onboardingFailsafe.channelId}.`);
    } else {
      console.log('[failsafe] onboarding failsafe inactive — set AGE_VERIFY_CHANNEL_ID to enable.');
    }
    // Refresh each guild's "last seen online" stamp so the sustained-outage guard
    // measures real downtime, not time since boot.
    for (const guild of client.guilds.cache.values()) failsafe.markYagpdbSeen(guild);
    const tick = setInterval(() => {
      for (const guild of client.guilds.cache.values()) failsafe.markYagpdbSeen(guild);
    }, 20000);
    tick.unref?.();
  } else {
    console.log('[failsafe] disabled (FAILSAFE_ENABLED=false); GuildPresences intent not requested.');
  }

  // Advert edit-enforcement is independent of the failsafe (YAGPDB can't cover
  // edits on any tier), so report it separately.
  if (advertFailsafe.editChecksActive) {
    console.log(
      `[advert-edit] armed — advert rules enforced on edits for ${advertFailsafe.channelCount} ` +
      'channel(s), regardless of YAGPDB status.'
    );
  } else {
    console.log('[advert-edit] inactive — no advert channels configured or ADVERT_EDIT_CHECKS=false.');
  }
  if (advertFailsafe.introEditActive) {
    console.log('[intro-edit] armed — 800-char limit enforced on intro edits, regardless of YAGPDB status.');
  }

  // Retention prune: trims the DB archive (DB rows only, never Discord). Adverts
  // pruned after their window, other channels after a longer one.
  if (retention.ENABLED) {
    console.log(
      `[retention] armed — adverts pruned after ${retention.advertRetentionDays}d, ` +
      `other channels after ${retention.otherRetentionDays}d; daily. (DB rows only.)`
    );
    retention.schedule();
  } else {
    console.log('[retention] disabled (DB_RETENTION_ENABLED=false).');
  }

  // Dead-link sweep: daily, in-process (no cron on hosts like Wispbyte). Dormant
  // unless LINK_CHECK_CHANNELS is set; `npm run check-links` runs it manually.
  linkCheck.scheduleLinkCheck(client);

  // Member-growth stats: scan #guestbook + the member-count channel to keep
  // member_events / member_count_samples current for rpc-web. Catches up on boot,
  // then runs just after each UTC midnight. Needs the message intents.
  if (memberStats.ENABLED && needMessageIntents) {
    memberStats.schedule(client, db.pool);
    console.log(
      `[member-stats] armed — catch-up on boot, then daily ~${memberStats.midnightOffsetMin} min after UTC midnight.`
    );
  } else if (memberStats.ENABLED) {
    console.log(
      '[member-stats] inactive — message intents not enabled (LOGGING_ENABLED=false and failsafe off).'
    );
  } else {
    console.log('[member-stats] disabled (MEMBER_STATS_ENABLED=false).');
  }

  // Infraction re-check: re-tests flagged adverts/intros on a schedule; clears
  // :staffpending: / marks the ping :staffapproved: when fixed, or removes a
  // still-broken post at the terminal stage. Resumes across restarts (DB-backed).
  advertFailsafe.scheduleRechecks(client, sendLog);

  // Daily reconcile: soft-delete adverts that were removed on Discord while the
  // bot was offline (the gateway never saw the delete). Runs at 3am ET, not on boot.
  advertReconcile.scheduleAdvertReconcile(client);

  // AI advert keywords: from 8am ET, sends unlabelled adverts to the Claude Code
  // routine in batches; it writes the labels back itself. Off unless LABEL_ENABLED.
  // Once a day's run is over, #bot_spam gets the posters with two standing
  // one-on-one adverts that share a fandom.
  advertLabeller.scheduleAdvertLabeller({
    runOver: (run) => fandomReport.run(client, run),
  });

  // Trading-card approvals: catch up on changes made while offline (not awaited:
  // one fetch per card), then sweep new cards every few minutes.
  tcgApproval.start();

  // Expire the #rule_infractions pings this bot posts (YAGPDB's sweep skips bot
  // messages, so they'd never age out). No-op until a post is recorded.
  if (advertConfig.SHARED?.infractionsChannelId) {
    infractionExpiry.scheduleInfractionExpiry(client);
  }
});

client.on('error', (err) => console.error('[client] error:', err.message));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
// Backstop: a throw in a timer/callback would otherwise crash the process and stop
// logging. Log and stay alive — the bot is stateless per-event and the pool self-heals.
process.on('uncaughtException', (err) => console.error('[uncaught]', err));

db.init()
  .then(() => (game.ENABLED ? game.init() : null))
  .then(() => (polls.ENABLED ? polls.init() : null))
  .then(() => client.login(TOKEN))
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
