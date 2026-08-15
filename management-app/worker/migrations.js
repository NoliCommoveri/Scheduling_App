// Migration registry. Per TDS_Slice_Online_Revamp.md §3.7.3.
//
// Adding a migration file also means adding an entry here, in order. The
// duplication is deliberate: the file is the source of truth, this list is
// what makes it visible to the in-app runner (worker/index.js).

import m0001 from '../../migrations/0001_online_revamp_init.sql';
import m0002 from '../../migrations/0002_backfill_children_projection.sql';
import m0003 from '../../migrations/0003_commit_chunks.sql';
import m0004 from '../../migrations/0004_completion_note.sql';
import m0005 from '../../migrations/0005_assignment_messages.sql';
import m0006 from '../../migrations/0006_chore_instances.sql';
import m0007 from '../../migrations/0007_shared_chore_claims.sql';
import m0008 from '../../migrations/0008_drop_sequence_no.sql';
import m0009 from '../../migrations/0009_wall_device_scope.sql';
import m0010 from '../../migrations/0010_wall_slots.sql';
import m0011 from '../../migrations/0011_wall_school_blocks.sql';

export const MIGRATIONS = [
  { name: '0001_online_revamp_init.sql', sql: m0001 },
  { name: '0002_backfill_children_projection.sql', sql: m0002 },
  { name: '0003_commit_chunks.sql', sql: m0003 },
  { name: '0004_completion_note.sql', sql: m0004 },
  { name: '0005_assignment_messages.sql', sql: m0005 },
  { name: '0006_chore_instances.sql', sql: m0006 },
  { name: '0007_shared_chore_claims.sql', sql: m0007 },
  { name: '0008_drop_sequence_no.sql', sql: m0008 },
  { name: '0009_wall_device_scope.sql', sql: m0009 },
  { name: '0010_wall_slots.sql', sql: m0010 },
  { name: '0011_wall_school_blocks.sql', sql: m0011 },
];
