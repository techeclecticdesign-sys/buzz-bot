// Pure string/formatting helpers for Discord embeds. No I/O and no discord.js —
// just text budgeting against Discord's embed limits, so it's all unit-testable.

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// Discord caps a description at 4096. Budget a little below that so an ellipsis or
// surrogate-pair miscount can't push a post over the cap (which would drop the
// whole log entry).
const DESC_LIMIT = 4096;
const DESC_SAFETY_BUFFER = 96;
const DESC_MAX = DESC_LIMIT - DESC_SAFETY_BUFFER; // 4000

// Fit `before` and `after` into `budget` chars total: each gets up to half, and
// whatever one leaves unused goes to the other, so a short side is never cut to
// match a long one. The two returned strings always sum to <= budget.
function splitTruncate(before, after, budget) {
  if (budget <= 0) return ['', ''];
  if (before.length + after.length <= budget) return [before, after];
  const half = Math.floor(budget / 2);
  let beforeMax, afterMax;
  if (before.length <= half) {
    beforeMax = before.length;
    afterMax = budget - before.length;
  } else if (after.length <= half) {
    afterMax = after.length;
    beforeMax = budget - after.length;
  } else {
    beforeMax = half;
    afterMax = budget - half;
  }
  return [truncate(before, beforeMax), truncate(after, afterMax)];
}

function attachmentList(attachments) {
  if (!attachments?.length) return null;
  // Truncate by whole lines so a markdown link is never cut in half.
  let out = '';
  for (const a of attachments) {
    const line = `[${a.name}](${a.url})`;
    if (out.length + line.length + 3 > 1024) {
      out += '\n…';
      break;
    }
    out += (out ? '\n' : '') + line;
  }
  return out;
}

// Join lines into an embed-description-safe block (Discord caps at 4096),
// dropping the oldest and noting how many were hidden.
function fitLines(lines, budget = 3800) {
  let out = [];
  let len = 0;
  let dropped = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (len + lines[i].length + 1 > budget) {
      dropped = i + 1;
      break;
    }
    out.unshift(lines[i]);
    len += lines[i].length + 1;
  }
  if (dropped) out.unshift(`*…${dropped} older entries not shown*`);
  return out.join('\n');
}

module.exports = {
  DESC_LIMIT,
  DESC_SAFETY_BUFFER,
  DESC_MAX,
  truncate,
  splitTruncate,
  attachmentList,
  fitLines,
};
