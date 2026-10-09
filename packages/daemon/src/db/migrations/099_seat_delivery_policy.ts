import type { Migration } from "../migrate.js";

export const seatDeliveryPolicySchema: Migration = {
  name: "099_seat_delivery_policy.sql",
  sql: `
    CREATE TABLE seat_delivery_policies (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      desired_policy TEXT NOT NULL,
      effective_policy TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      effective_at TEXT
    );
    CREATE TABLE seat_deferred_messages (
      id TEXT PRIMARY KEY REFERENCES outbox_entries(outbox_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      binding TEXT NOT NULL,
      outbox_ids TEXT NOT NULL,
      outbox_fingerprint TEXT NOT NULL,
      body TEXT NOT NULL,
      options TEXT NOT NULL,
      policy_revision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      retry_interval_ms INTEGER NOT NULL CHECK (retry_interval_ms > 0),
      state TEXT NOT NULL CHECK (state IN ('waiting','sending','held','complete','indeterminate')),
      reason TEXT NOT NULL,
      result TEXT
    );
    CREATE INDEX idx_seat_deferred_due ON seat_deferred_messages(next_attempt_at, id)
      WHERE state = 'waiting';
    CREATE INDEX idx_seat_deferred_node ON seat_deferred_messages(node_id, created_at, id);
    CREATE TABLE seat_deferred_members (
      outbox_id TEXT PRIMARY KEY REFERENCES outbox_entries(outbox_id) ON DELETE CASCADE,
      delivery_id TEXT NOT NULL REFERENCES seat_deferred_messages(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_seat_deferred_members_delivery ON seat_deferred_members(delivery_id);
  `,
};
