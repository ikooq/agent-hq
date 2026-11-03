// Agent HQ v3 — where an agent belongs, from its status. Pure (no Three.js) so `agent-hq test` can check it in Node.
// A session that has never been prompted (SessionStart only) goes straight to its desk;
// only a session that finished a reply (Stop after a prompt) rests in the lounge.
export const restsInLounge = (status, turn) => status === 'resting' && !!(turn && turn.requested);

export function placeFor({ kind = 'robot', status, turn = null, leaving = false, hasTask = false, inMeeting = false }) {
  if (leaving) return 'door';
  if (kind === 'lead') return 'lead';
  if (hasTask) return 'task';            // report to the lead / pin the card on the Done board
  if (inMeeting) return 'meeting';       // parent with 2+ helpers (and those helpers)
  if (kind === 'helper') return 'helper';
  if (status === 'waiting') return 'queue';
  if (restsInLounge(status, turn)) return 'lounge';
  return 'desk';                         // working, running a command, stuck, or a brand-new session
}
