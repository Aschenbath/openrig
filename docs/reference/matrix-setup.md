# Matrix interactive chat

OpenRig connects as a bot user with an access token, using Matrix client-server v3 APIs and
outbound `/sync` long polling. No public callback URL or Application Service is required.
Use an **unencrypted** room: this connector does not implement end-to-end encryption.

Create a bot account and obtain its access token on your homeserver. Then configure it:

```sh
rig matrix setup --homeserver-url https://matrix.example.org \
  --access-token-file /path/to/bot-token --device-id BOTDEVICE \
  --default-room '!room:example.org'
rig matrix verify --join --send-test
rig gateway human add alice --display-name Alice --delivery-class B \
  --binding 'matrix:!room:example.org;handle=@alice:example.org'
rig matrix enable
rig matrix status --json
```

`--device-id` describes an existing bot device; it does not register a new device or enable
cryptography. The token is stored in a separate 0600 env file, never in connector JSON.
`OPENRIG_MATRIX_ACCESS_TOKEN` or `MATRIX_ACCESS_TOKEN` can override the file at runtime.
Setup accepts incremental flags, like Slack setup. Rewire after configuration changes with
`rig matrix disable --reason 'reconfigure'` followed by `rig matrix enable`.

Bindings use `matrix:!room:server` or `matrix:#alias:server`, optionally followed by
`;role=primary|secondary` and then `;handle=@user:server`. A server may include a port.
Role defaults to `primary`; exactly one connector binding per human must be primary. Omit
`handle` for outbound-only delivery. Inbound messages require the registered user ID in the
bound room; handles are unique per connector kind. The connector's configured secret store
supplies credentials for all Matrix bindings. Secondary bindings admit inbound messages;
outbound delivery uses the primary binding. Aliases resolve to room IDs when services start.

A new queue conversation posts a root; subsequent notifications for that conversation reply
using `m.thread` with the reply fallback relation. An update with `replyTo` may reuse an earlier
conversation's thread. Each structured question gets its own message in the thread with
1️⃣–4️⃣ options. React on that question message to answer. The exact event ID, room and asked
human determine which answer is recorded; other reactions are ignored. Completed answers
return through the existing queue and human reply resolver.

Enable seeds existing alerts as history, matching Slack's enable behavior. First sync establishes
an initial floor, so old room messages are not imported. Later pages commit their `since` token
only after admitted events land. Failed pages retry with backoff; invalid tokens stop polling
and appear in status. A limited incremental timeline reports a gap and retains the cursor:
history backfill is not implemented yet. Ask the maintainer to investigate such a gap rather
than deleting the cursor and silently discarding unread events.

This MVP supports text, notice and emote messages, threads and structured reaction answers.
It does not support encrypted rooms, attachments, edits, redactions, reaction removal or history
backfill. Matrix readiness is passive and reports external verification as indeterminate;
`rig matrix verify` explicitly checks identity and can exercise room membership and sending.
Slack delivery preference deferrals/digests are not implemented in the Matrix polling driver.
Thread maps, per-part sends and sync cursors are atomic JSON files under `$OPENRIG_HOME/state`;
Matrix transaction IDs and deterministic queue IDs support replay. As with Slack's delivery
contract, a crash between remote acceptance and local persistence can replay a send (Matrix's
transaction deduplication lifetime is homeserver-dependent).

All automated API tests use mocked fetch. A real homeserver still needs to validate alias
resolution, membership/power levels, client thread display/fallbacks, reaction emoji variants,
long-poll behavior and reconnects. The repository tests do not contact Matrix homeservers.
