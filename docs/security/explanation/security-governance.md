# Security governance

Who is accountable for security in this project, how security decisions get
made and recorded, and what is reviewed on a schedule.

---

## 1. Proportionality, stated up front

Duckle is maintained by a small team. There is **no separate security
organization, no security steering committee and no governance board**, and
describing one would be a more serious finding than not having one - an assessor
can verify the absence of a committee far more easily than the effectiveness of
a claimed one.

What follows is what actually exists: named accountability, decisions that are
recorded where they are made, and a review cadence with dates on it. The
governance functions an enterprise expects are performed; they are performed by
fewer people, and this document says which ones and how you would check.

| Function | How it is performed here |
| :--- | :--- |
| Security ownership | Held by the project maintainers; every release is signed off against section 6 of the testing program |
| Risk acceptance | Written down, with reachability analysis and a review date, never implicit |
| Security assessment | Continuous automated testing, plus adversarial review of security-relevant changes |
| Incident response | A published runbook with defined containment steps |
| Vulnerability intake | A published policy with SLAs |
| Change control | Every change is a reviewed commit against a green cross-platform suite |
| Audit evidence | Append-only `audit.ndjson`, run receipts, and provenance on every release artifact |

---

## 2. Accountability

Security accountability sits with the project maintainers and is not delegated
to a rotating assignee, because a rotation among a small number of people is a
list, not a control.

Concretely, that means one accountable decision at each of these points:

* Whether a reported vulnerability is accepted, and its severity.
* Whether a dependency advisory with no upstream fix is accepted, and on what
  reachability grounds.
* Whether a release that touches authentication, authorization or the trust
  boundary goes out.
* Whether a change to the unauthenticated surface or the role model is correct.

The last two are enforced mechanically as well as procedurally: the public route
list is asserted as an exact set in the test suite, so changing it cannot happen
without someone editing a test that exists to make them stop and say why.

---

## 3. Where decisions are recorded

Security decisions are recorded **in the artifact they constrain**, not in a
separate register that drifts from it. This is deliberate: a governance document
that lives away from the code stops matching it, and nobody notices until an
audit.

| Decision | Where it lives |
| :--- | :--- |
| Why a control works the way it does | A doc comment on the function that implements it |
| Why a defect was possible, and what now prevents it | The commit that fixed it, and the test that was red first |
| Why a dependency risk is accepted | [Dependency advisories](../reference/dependency-advisories.md), with a review date |
| What is deliberately not implemented | The relevant reference doc, stated plainly rather than omitted |
| What the trust boundary is | [Trust boundary and threat model](trust-boundary-and-threat-model.md) |

A reader can therefore check a claim against the code that implements it, in the
same place, rather than against a description of the code.

---

## 4. Review cadence

| Review | Frequency | Output |
| :--- | :--- | :--- |
| Dependency advisories | Weekly, automated; full re-read of accepted exceptions every 6 months | A green build, or a new accepted exception with justification |
| Accepted risk register | Every 6 months, whether or not anything changed upstream | Entries removed, or re-justified with a new date |
| Threat model | On any change to the trust boundary, and at least annually | An updated boundary document |
| Recovery drill | Annually, and after any change to workspace layout or the backup job | A measured RTO and a list of what did not work |
| Pre-release security review | Every release touching auth or the trust boundary | Sign-off against a fixed checklist |
| Incident runbook | After any incident, and annually | An updated runbook |

Dates matter more than frequencies here. "No fix available upstream" and "the
threat model is unchanged" are both statements that age quietly, which is why
each carries a next-review date rather than a promise to look periodically.

---

## 5. Internal security assessment

Every security-relevant change gets an adversarial pass whose purpose is to
break it. The scope and its limits are described in
[Security testing program](security-testing-program.md) - in particular, that
an internal review is blind in the same places the design is, which is why
independent testing is tracked as a real gap there rather than as a formality.

The assessment output that matters is not a report. It is a **regression test
written red first**, so a defect found once cannot return without failing the
build.

---

## 6. Separation of duties, and its limits

Within the product, separation of duties is real and enforced:

* Three ordered roles, with the split following what an action can *do*.
  Deploying a pipeline introduces code that will execute and requires admin;
  running an already-approved one requires operator.
* Authorization is decided **before dispatch**, so a route cannot be reached by
  a handler forgetting to check.
* The audit trail attributes to the identity provider's subject, not to a name a
  user can choose.
* Credentials can be held outside the workspace entirely, in a vault the
  operator controls, so an author never handles them.

Within the *project*, separation of duties is limited by team size, and a
deployment should account for that rather than assume otherwise. The compensating
controls that do not depend on trusting our process are build provenance, the
published SBOM, the open source itself, and running the software on
infrastructure the deploying organization controls - which is the design.

---

## Related

* [Security testing program](security-testing-program.md)
* [Trust boundary and threat model](trust-boundary-and-threat-model.md)
* [Incident response runbooks](../how-to/incident-handling-runbook.md)
* [Business continuity and recovery](../how-to/business-continuity-and-recovery.md)
* [SOC 2 and ISO 27001 control matrix](../reference/soc2-iso27001-control-matrix.md)
