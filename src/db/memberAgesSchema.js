// Ages belong to the current member baseline, so existing departure cleanup
// removes them too. Keep only the stated number, timestamp, and source id.
const MEMBER_AGES_SQL = `
  ALTER TABLE member_state ADD COLUMN IF NOT EXISTS
    age_stated INT CHECK (age_stated BETWEEN 15 AND 99);
  ALTER TABLE member_state ADD COLUMN IF NOT EXISTS age_stated_at TIMESTAMPTZ;
  ALTER TABLE member_state ADD COLUMN IF NOT EXISTS age_message_id TEXT;
`;

async function initMemberAges(run) {
  await run(MEMBER_AGES_SQL);
}

module.exports = { initMemberAges, MEMBER_AGES_SQL };
