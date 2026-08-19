# Security Policy

## Reporting a vulnerability

**Report privately, not as a public issue.**

Use GitHub's private vulnerability reporting on this repository:
[**Report a vulnerability**](https://github.com/slothflowlabs/duckle/security/advisories/new).
It is enabled, it is private to the maintainers, and it is the fastest route.

If you cannot use GitHub, open a public issue containing only the words "security
contact requested" and no detail, and a maintainer will arrange a private channel.

Please include, as far as you are able:

- the version (`Duckle → About`, or `duckle-runner --version`) and the platform,
- whether it affects the desktop application, `duckle-runner serve`, `duckle-runner web`,
  or the published container image,
- what an attacker gains, and the access they need to start,
- reproduction steps, and a proof of concept if you have one.

### What to expect

| | |
|---|---|
| Acknowledgement | within 3 working days |
| Initial assessment, with a severity | within 10 working days |
| Fix or documented mitigation | targeted within 90 days, sooner for anything critical |
| Credit | offered in the advisory, declined on request |

Duckle is maintained by a small team. These are honest targets rather than a
contractual SLA, and we would rather state that plainly than publish a number we
cannot always meet.

We publish fixes as [GitHub Security Advisories](https://github.com/slothflowlabs/duckle/security/advisories),
which issues a CVE where one is warranted.

### Safe harbour

We will not pursue or support legal action against anyone who reports in good
faith under this policy, who avoids privacy violations and service disruption,
who tests only against their own installation, and who gives us reasonable time
to respond before disclosing publicly.

## Supported versions

Security fixes land on `main` and ship in the next release. Only the latest
release is supported; there are no long-term support branches. Users on older
releases should upgrade rather than expect a backport.

## Scope

**In scope:** the desktop application, `duckle-runner` in all its modes, the
published container image, the workspace and credential storage formats, the
in-app updater, and this repository's build and release pipeline.

**Out of scope:** vulnerabilities in the systems Duckle connects to, in DuckDB
itself (report those to
[duckdb/duckdb](https://github.com/duckdb/duckdb/security)), findings that
require an attacker to already control the machine or the workspace directory,
and the website.

## Where the trust boundary sits

Duckle is **software you deploy and run yourself**. It is not a hosted service.

- The maintainers **never receive, process, or store any of your data**, any of
  your credentials, or any telemetry. There is no vendor-side environment to
  breach, and no sub-processor handling your data on our behalf.
- Everything Duckle reads, writes, and stores lives on infrastructure you
  provision and control.
- The only automatic outbound request the application makes on its own is a
  version check against a public GitHub URL, which sends nothing about you or
  your work. It can be ignored at the network layer with no loss of function.

This means that for a vendor security assessment, whole categories of question -
data residency, vendor-side access control, breach notification for data we hold,
sub-processor lists - have the same answer: **we hold nothing**. We would rather
say that once, clearly, than answer each one evasively.

What remains genuinely ours is the integrity of what we ship you: the source, the
build pipeline, and the release artifacts. That is where our security effort goes,
and where we invite scrutiny.

## Known limitations, stated deliberately

We would rather you learn these here than find them yourself and wonder what else
went unsaid.

- **Release binaries are not code signed** on any platform, and the checksum file
  the in-app updater verifies against is itself unsigned and served from the same
  release. Signing and a signed manifest are in progress. Until then, verify
  downloads against `SHA256SUMS.txt` and prefer a pinned version in automated
  deployments.
- **The console speaks plain HTTP.** It expects TLS to be terminated by a proxy or
  ingress in front of it. Do not expose it directly to an untrusted network.
- **The workspace encryption key is stored beside the data it protects**, in
  `.duckle/keys/`. This defends a stray file, a backup, or a commit. It does not
  defend a copied workspace directory, because the key travels with it. Protect the
  workspace directory with filesystem permissions accordingly.
- **Not every stored value is encrypted.** Connection secrets, server API keys and
  the cached git token are encrypted with AES-256-GCM. Context variables, the AI
  provider key, and any value typed directly into a pipeline field are stored in
  plain text. Use `${ENV:NAME}` for anything sensitive in a pipeline.
- **A pipeline is code.** Anyone who can deploy or run a pipeline can cause the
  server to connect to systems and execute queries with the credentials that
  server holds. Treat the operator and admin roles as you would shell access, and
  keep the console off the public internet.
- **We have no SOC 2 or ISO 27001 attestation**, and no third-party penetration
  test report. We are an open-source project; the substitute we offer is that the
  entire source, build pipeline, and release process are public and auditable by
  you or by an assessor acting for you.

## What we do

- Every change lands through a pull request with CI: build, tests, and `clippy`
  across the workspace.
- Dependency alerts and automated security updates are enabled, as are secret
  scanning and push protection.
- The audit log records who did what on a deployed console, including refusals.
- Roles are enforced in one place per surface rather than per handler, so a route
  cannot be reached by forgetting to check it at the call site.

## For security assessors

If you are evaluating Duckle on behalf of an organisation and need something this
policy does not cover - an architecture walkthrough, a data-flow description, a
dependency inventory, or answers to a specific questionnaire - open a private
report through the link above and say so. We would rather answer directly than
have you infer.
