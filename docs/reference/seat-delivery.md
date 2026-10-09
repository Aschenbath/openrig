# Per-seat terminal delivery

Choose how OpenRig sends messages into one seat's terminal. The default remains
typing guard `off`; opting in on one seat does not change its siblings.

| Mode | Terminal input | When input is unavailable |
|---|---|---|
| `off` | Existing delivery and prompt checks | Existing send result |
| `draft-aware` | Paste only into a recognized empty input; check the staged text again before Enter | Retain the original message and retry within a deadline and attempt cap |
| `hold` | No automatic terminal input, even at an empty prompt | Retain for inspection outside the pane; no automatic retry |

These are three modes of the existing typing guard, separate from runtime
permissions. Existing recipient and interactive-prompt checks still apply.
`--raw`, `--force` and `--dangerously-interact` do not bypass a protected seat's
typing guard. Direct human terminal input remains available.

## Configure and inspect

Run from a seat shell with `OPENRIG_SESSION_NAME` set. The daemon derives the
preference's audit actor from the request's transport identity.

```sh
rig seat set-typing-guard dev-impl@my-rig --mode draft-aware \
  --hold-seconds 120 --max-attempts 10 --reason "preserve my unfinished input"
rig seat status dev-impl@my-rig
```

`--hold-seconds` initially defaults to 120 and accepts integers from 1 to 3600.
`--max-attempts` initially defaults to 10 and accepts integers from 1 to 100, including
the initial attempt. Omitted limits keep the seat’s previous settings.
Use exactly one of `--mode off|draft-aware|hold` or the compatible
`--enabled true|false`: true means hold, false means off.
Retries are spaced by the hold duration divided by the
attempt cap, with a minimum interval of 250 ms. A busy operation lease can
delay an attempt; it cannot extend the deadline.

Activation waits for an already-started seat operation to finish. The API can
return HTTP 202 with `pending: true`; inspect `desiredMode` and `effectiveMode`
in `rig seat status` and wait for `pending: false` before relying on the requested
mode. The legacy `desired` and `effective` booleans still mean hold everything.
The preference
and waiting deliveries survive daemon restart. Reapplying identical settings
keeps the existing guard revision and its retries.

`rig seat held-messages` lists retained bodies and includes each retry’s original
ID, state, attempts, cap, deadline, next attempt and reason:

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

Faint placeholders and autocomplete suggestions after the cursor are display
hints, not draft text. Their styling must be present in the capture. Typing the
same words and moving the cursor to the start still counts as a draft. A mixed
suffix containing normal text cannot be discarded as a suggestion.

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
even after changing guard mode. Use the by-ID inspection command for historical
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
old ones. Changing guard mode or retry settings likewise ends retries
created under the older guard revision.

With `hold`, writing lifecycle operations refuse before effects. With
`draft-aware`, a writing lifecycle operation on an active seat also requires
an explicit switch to `off` first. Fresh startup is exempt from draft
inspection only after the adapter creates a new pane or successfully respawns
a dead pane within that lifecycle operation. An absent/dead binding permits
the lifecycle preflight, but adopting or rebinding an existing pane does not
grant this exemption; existing lifecycle and recipient checks remain.

Terminal capture is observational, not an atomic editor API. The before-Enter
check and brokered-human-input invalidation narrow the paste/submit race, but
cannot prevent a separate program or direct tmux client from writing after
the final observation. Collapsed paste labels are accepted only when observed
after this operation's paste, with the expected line count and unchanged
label/cursor at submission. Unrecognized provider versions and other runtimes
retain until the hold bound; choose `off` when that tradeoff is unsuitable.

HTTP equivalents are `POST /api/seat/set-typing-guard/:seatRef` with
`{mode, holdSeconds?, maxAttempts?, reason}` or `{enabled, reason}`, plus
`GET /api/seat/status/:seatRef` and the existing held-message routes.
No RigSpec field is required.
