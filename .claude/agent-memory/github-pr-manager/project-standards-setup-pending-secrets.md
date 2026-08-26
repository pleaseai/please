---
name: project-standards-setup-pending-secrets
description: pleaseai/please release-please and SonarCloud CI need org secrets/registration that did not exist as of 2026-08-27 (PR #1)
metadata:
  type: project
---

As of 2026-08-27 (PR #1, `chore/standards-setup`), two CI integrations added to this repo are not yet fully provisioned:

- `.github/workflows/release-please.yml` requires org variable `RELEASE_GITHUB_APP_CLIENT_ID` and org secret `RELEASE_GITHUB_APP_PRIVATE_KEY`. If those are still missing when the branch merges, the workflow fails on main.
- SonarCloud project registration and `SONAR_TOKEN` are pending; the scan step is guarded by an env check so CI stays green. `sonar.projectKey` was guessed as `pleaseai_please` and must be verified against what SonarCloud assigns.

**Why:** the standards setup landed the workflows before the org-side provisioning was done, so the repo can go red on main without any code change.
**How to apply:** before approving/merging any PR that touches release or Sonar CI here, confirm the variable/secret/registration status first; a red release-please run on main is most likely this, not a regression.
