// Nickname / role / account-name change detection. Diffs each incoming member or
// user against the last state we stored (member_state / user_state) rather than
// the event's oldMember/oldUser, which are empty for uncached members after a
// restart. Persists the diff and the new baseline, and posts an embed via the
// injected sendLog.
//
// create({ sendLog, client }) returns the two async trackers; memberRoleIds and
// queueMemberChange are stateless and exported directly (index.js also seeds
// member state on join/startup with memberRoleIds).
const db = require('./db');
const { nicknameEmbed, roleChangeEmbed, profileNameEmbed } = require('./embeds');

// A member's role ids minus @everyone (whose id equals the guild id), sorted so
// two states compare equal regardless of order.
function memberRoleIds(member) {
  return [...member.roles.cache.keys()].filter((id) => id !== member.guild.id).sort();
}

// Serialize member-change handling per member. Discord fires a separate
// guildMemberUpdate for each role change, so a burst (onboarding flows assign
// several roles back-to-back) can have two handlers in flight diffing against
// the same stale baseline — double-recording the earlier change. Chaining them
// per member makes each diff see the previous one's saved state.
const memberChangeQueues = new Map();
function queueMemberChange(key, fn) {
  const prev = memberChangeQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn); // prev never rejects (entry swallows below)
  const entry = run.then(() => {}, () => {}).finally(() => {
    if (memberChangeQueues.get(key) === entry) memberChangeQueues.delete(key);
  });
  memberChangeQueues.set(key, entry);
  return run; // caller awaits this one and handles any rejection
}

function create({ sendLog, client }) {
  // Detects nickname and role changes by diffing the incoming member against the
  // last state we stored, then persists the diff and the new baseline. With no
  // prior baseline (a member we've never recorded) we just seed it — we can't
  // know what changed, so we wait for the next change to log it.
  async function trackMemberChanges(member) {
    const { guild } = member;
    const tag = member.user.tag;
    const nickname = member.nickname ?? null;
    const displayName = member.displayName ?? null;
    const roleIds = memberRoleIds(member);

    const state = await db.getMemberState(member.id);
    if (!state) {
      await db.seedMemberState(member.id, tag, nickname, roleIds, displayName);
      return;
    }

    // Nickname changes are always logged; role changes only when enabled. Either
    // way the DB record is written so >>nicknames / >>roles history stays complete.
    if ((state.nickname ?? null) !== nickname) {
      await db.recordNickname(member.id, tag, nickname);
      await sendLog({ embeds: [nicknameEmbed(member, state.nickname ?? null, nickname)] });
    }

    const before = new Set(state.role_ids ?? []);
    const after = new Set(roleIds);
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    const embeds = [];
    for (const id of added) {
      const name = guild.roles.cache.get(id)?.name ?? null;
      await db.recordRoleChange(member.id, tag, id, name, 'add');
      embeds.push(roleChangeEmbed(member, id, name, 'add'));
    }
    for (const id of removed) {
      const name = guild.roles.cache.get(id)?.name ?? null;
      await db.recordRoleChange(member.id, tag, id, name, 'remove');
      embeds.push(roleChangeEmbed(member, id, name, 'remove'));
    }
    if (embeds.length && (await db.getGuildSettings()).log_role_changes) {
      // One embed per change; Discord caps a message at 10 embeds, so chunk.
      for (let i = 0; i < embeds.length; i += 10) {
        await sendLog({ embeds: embeds.slice(i, i + 10) });
      }
    }

    await db.setMemberState(member.id, tag, nickname, roleIds, displayName);
  }

  // Detect account-level name changes — username and display name — which arrive
  // via userUpdate, not guildMemberUpdate. Diffed against stored user_state so a
  // restart never misses one (same reason member_state exists). Always logged.
  async function trackUserNameChanges(user) {
    const state = await db.getUserState(user.id);
    const newUsername = user.username ?? null;
    const newGlobal = user.globalName ?? null;

    if (!state) {
      await db.seedUserState(user.id, newUsername, newGlobal);
      return;
    }

    const oldUsername = state.username ?? null;
    const oldGlobal = state.global_name ?? null;
    const usernameChanged = oldUsername !== newUsername;
    const globalChanged = oldGlobal !== newGlobal;
    if (!usernameChanged && !globalChanged) return;

    // userUpdate is account-global; log it under each guild we share with the user
    // (this bot is effectively single-guild, so that's normally just one).
    for (const guild of client.guilds.cache.values()) {
      if (!guild.members.cache.has(user.id)) continue;
      if (usernameChanged)
        await db.recordNameChange(user.id, user.tag, 'username', oldUsername, newUsername);
      if (globalChanged)
        await db.recordNameChange(user.id, user.tag, 'global_name', oldGlobal, newGlobal);
      await sendLog({
        embeds: [
          profileNameEmbed(user, { usernameChanged, oldUsername, newUsername, globalChanged, oldGlobal, newGlobal }),
        ],
      });
    }

    await db.setUserState(user.id, newUsername, newGlobal);
  }

  return { trackMemberChanges, trackUserNameChanges };
}

module.exports = { memberRoleIds, queueMemberChange, create };
