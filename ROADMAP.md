# Plumberr roadmap

Plumberr has a real path to a startup: an AI on-call engineer that cuts outage time and saves teams from 3am pages. This is how we would grow it from the hackathon demo into a product teams can trust.

## Finish the core product

- Real GitHub PRs through a GitHub App, plus GitLab and Bitbucket support.
- One-click rollback when a recent deploy caused the problem, with an approval step.
- Fixes verified in a test environment before the PR opens: run the tests, replay the failing requests, and confirm the errors drop.
- A confidence score with each fix, so it only acts on its own when it's very sure.

## Plug into what teams already use

- Alerts from Datadog, Grafana, Sentry, PagerDuty, Opsgenie, New Relic and Prometheus.
- Logs from CloudWatch, Loki, Elastic and Splunk, and traces from OpenTelemetry.
- Slack and Teams: it posts the diagnosis in the incident channel, and engineers can approve the fix from there.
- Kubernetes, AWS, GCP and Vercel, so it can read deploys, config changes and pod health.

## Make it smarter over time

- Memory of past incidents, so it recognises repeat problems and gets faster each time.
- Learning each company's own runbooks and architecture docs.
- A map of how services depend on each other, so it can trace a problem upstream.
- Postmortems written automatically, with the timeline, root cause and prevention steps.
- Spotting trouble before it happens, from rising errors, slow queries or memory leaks.

## Trust and safety

Needed to sell to companies.

- Permission levels: read-only, suggest only, open PRs, or fully automatic for safe fixes.
- A full audit log of every step the agent took.
- Self-hosted and private-network options, plus SOC 2 and GDPR.
- Secrets automatically hidden from logs.

## Business

- A free tier for side projects, then pricing per service or per incident for teams.
- Start with fast-moving startups that have small on-call teams.
- Pitch it as "cut your time to fix by 90% and stop 3am pages."
- Open-source the agent's core to build a community, and sell the hosted platform.
- Compete in the AIOps and AI SRE space, which includes PagerDuty and incident.io.

## Next 30 days

- Turn on real PRs and build the Slack integration.
- Give 5 friendly startups free access and collect feedback.
- Measure real time-to-fix numbers to use in the pitch.
- Apply to accelerators like Y Combinator, Entrepreneur First and NDRC in Dublin.
