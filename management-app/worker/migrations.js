// Migration registry. Per TDS_Slice_Online_Revamp.md §3.7.3.
//
// Adding a migration file also means adding an entry here, in order. The
// duplication is deliberate: the file is the source of truth, this list is
// what makes it visible to the in-app runner (worker/index.js).

import m0001 from '../../migrations/0001_online_revamp_init.sql';

export const MIGRATIONS = [
  { name: '0001_online_revamp_init.sql', sql: m0001 },
];
