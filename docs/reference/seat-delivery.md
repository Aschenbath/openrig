# Per-seat terminal delivery

Choose how OpenRig sends messages into one seat's terminal. The default remains
`automatic`; opting in on one seat does not change its siblings.

| Mode | Terminal input | When input is unavailable |
|---|---|---|
| `automatic` | Existing delivery and prompt checks | Existing send result |
| `draft-aware` | Paste only into a recognized empty input; check the staged text again before Enter | Retain the original message and retry within a deadline and attempt cap |
| `inbox-only` | No automatic terminal input, even at an empty prompt | Retain for inspection outside the pane; no automatic retry |

These are delivery preferences, separate from runtime permissions. Existing
recipient, interactive-prompt and manual typing-guard checks still apply.
`--raw`, `--force` and `--dangerously-interact` do not bypass a protected seat's
delivery policy. Direct human terminal input remains available.

## Configure and inspect

Run from a seat shell with `OPENRIG_SESSION_NAME` set. The daemon derives the
preference's audit actor from the request's transport identity.

```sh
rig seat set-delivery-policy dev-impl@my-rig --mode draft-aware \
  --hold-seconds 120 --max-attempts 10 --reason "preserve my unfinished input"
rig seat delivery-policy dev-impl@my-rig --json
rig seat status dev-impl@my-rig
```

`--hold-seconds` defaults to 120 and accepts integers from 1 to 3600.
`--max-attempts` defaults to 10 and accepts integers from 1 to 100, including
the initial attempt. Retries are spaced by the hold duration divided by the
attempt cap, with a minimum interval of 250 ms. A busy operation lease can
delay an attempt; it cannot extend the deadline.

Activation waits for an already-started seat operation to finish. The API can
return HTTP 202 with `pending: true`; inspect `desired` and `effective` and wait
for the requested policy to become effective before relying on it. The preference
and waiting deliveries survive daemon restart. Reapplying identical settings
keeps the existing policy revision and its retries.

`rig seat delivery-policy` also shows the latest 100 deferred deliveries, with
their original ID, state, attempts, cap, deadline, next attempt and reason.
`rig seat held-messages` lists retained bodies and includes deferred status:

```sh
rig seat held-messages dev-impl@my-rig --json
rig seat held-messages dev-impl@my-rig --id <outbox-id> --json
rig seat retire-held-message dev-impl@my-rig <outbox-id> --reason "read outside the pane"
```

Reading never sends a message. Retirement releases its active retention quota
while preserving evidence. Retiring any member of a combined queue wake stops
that combined delivery; other members remain available for inspection.
It does not close the underlying queue work.

## Draft checks and retry outcomes

Draft-aware delivery recognizes framed Claude input and Codex input with a
known footer. It examines the visible input containing the cursor, independently
of whether an activity hook reports idle or running. A draft, copy mode, an
unrecognized layout or an unreadable capture does not permit automatic input.
The check runs after payload preparation, immediately before paste, and again
before Enter. A changed input after paste remains visible for human review;
OpenRig does not clear it or submit it.

| Delivery state | Meaning |
|---|---|
| `waiting` | The original message is retained; another bounded check is scheduled |
| `sending` | An attempt owns the existing delivery IDs; its result is not resolved yet |
| `held` | Automatic retries have ended; inspect the retained message and reason |
| `complete` | Transport execution succeeded; if render verification was requested it also succeeded. Native consumption is not asserted |
| `indeterminate` | Input may have occurred, or its render was not confirmed; no automatic replay |

A held send returns `outcome: "retained"`, `sent: false` and `outboxIds`.
Retries keep those IDs and original bodies. They do not create replacement
queue items or duplicate audit rows. A caller using the HTTP `deliveryId` can
read back that original request by repeating the same content and sender,
even after changing policy. Use the by-ID inspection command for historical
results, including retired and uncertain deliveries.

The cap or deadline leaves the message retained. There is no final warning
typed into the pane. A changed recipient, changed original record, closed or
superseded queue wake, or unavailable live prerequisite also ends retries.
A daemon restart retries waiting requests only: an attempt interrupted while
writing becomes `indeterminate`. A partial paste or ambiguous native command
result is never blindly retried.

The existing active retention limits apply: 100 records and 8 MiB per seat,
with a 1 MiB message limit. New admissions fail explicitly at capacity.
Already-committed queue intent remains durable even if protection activates
after its transaction and takes retention over the limit.

## Manual pause and lifecycle operations

`rig seat set-typing-guard <seat> --enabled true --reason <text>` remains a
manual pause of all automatic terminal input. Enabling it permanently stops
scheduled draft retries. Disabling it permits new sends; it does not replay
old ones. Changing delivery mode or retry settings likewise ends retries
created under the older policy revision.

With `inbox-only`, writing lifecycle operations refuse before effects. With
`draft-aware`, a writing lifecycle operation on an active seat also requires
an explicit switch to `automatic` first. Fresh startup is exempt from draft
inspection only when there is no bound input, or the bound session/pane is
positively absent or dead; existing lifecycle and recipient checks remain.

Terminal capture is observational, not an atomic editor API. The before-Enter
check and brokered-human-input invalidation narrow the paste/submit race, but
cannot prevent a separate program or direct tmux client from writing after
the final observation. Collapsed paste labels are accepted only when observed
after this operation's paste, with the expected line count and unchanged
label/cursor at submission. Unrecognized provider versions and other runtimes
retain until the hold bound; choose `automatic` when that tradeoff is unsuitable.

HTTP equivalents are `POST /api/seat/set-delivery-policy/:seatRef` with
`{mode, holdSeconds?, maxAttempts?, reason}`, `GET /api/seat/delivery-policy/:seatRef`,
and the existing held-message routes. No RigSpec field is required.
