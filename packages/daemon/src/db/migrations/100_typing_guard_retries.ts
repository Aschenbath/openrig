import type { Migration } from "../migrate.js";

export const typingGuardRetriesSchema: Migration = {
  name: "100_typing_guard_retries.sql",
  sql: `
    ALTER TABLE seat_delivery_guards ADD COLUMN desired_config TEXT;
    ALTER TABLE seat_delivery_guards ADD COLUMN effective_config TEXT;
    ALTER TABLE seat_delivery_guard_changes ADD COLUMN desired_config TEXT;
    ALTER TABLE outbox_entries ADD COLUMN retry_owner TEXT;
    ALTER TABLE outbox_entries ADD COLUMN retry_request TEXT;
    CREATE INDEX idx_outbox_retry_due
      ON outbox_entries(json_extract(retry_request, '$.nextAttemptAt'), outbox_id)
      WHERE retry_request IS NOT NULL AND delivery_state='retained'
        AND json_extract(retry_request, '$.nextAttemptAt') IS NOT NULL;
    CREATE INDEX idx_outbox_retry_node
      ON outbox_entries(json_extract(guard_binding, '$.nodeId'), ts_dispatched, outbox_id)
      WHERE retry_request IS NOT NULL;
  `,
};
