-- sequence_no lost its last consumer when the ordinal moved into the title.
-- Plain column: no index, no constraint, no view references it.
ALTER TABLE assignments DROP COLUMN sequence_no;
