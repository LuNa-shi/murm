# Task Flow

Task Service owns the completion decision. Agents can publish an Artifact, register it as the current Execution candidate, request a wait, and ask for acceptance; they cannot write `SATISFIED` directly.

The supported completion paths are:

```text
research/default child
  -> Material delivery
  -> WAITING(parent_review)
  -> Parent accept -> Execution SUCCEEDED + Task SATISFIED
                    or Parent rework -> steer Material + same lineage resumed

proof or checked implementation
  -> candidate Material
  -> CheckResult
  -> Task Service binding/CAS check
  -> PASS: SATISFIED
     FAIL/ERROR: evidence retained, Execution becomes recoverable
```

`required_materials`, `required_candidate`, `required_children`, and `required_check` are evaluated from the registered completion contract. A child becoming `SATISFIED` only changes that child; the Parent Task remains open for its own contract. Research Tasks without `required_check` never enter the Judge path.

`request_wait` requires the checkpoint to already be recorded for the current Execution. The wait and wake keys are persisted so repeated notifications cannot create another wait or resume the Agent twice. A rework request appends an immutable `steer` Material. While the prior Execution is still valid, its workspace, Initial Context, checkpoint, and Execution identity are retained; after fencing or expiry, a new Execution inherits the same lineage and increments the attempt number.

CheckResult application verifies the target Task and spec version, input snapshot, candidate Material, checker, checker version, environment, and current Execution fence. A result arriving after cancellation is archived as `IGNORED`; a result from an old fence is rejected. Only a matching PASS can close a proof Task.
