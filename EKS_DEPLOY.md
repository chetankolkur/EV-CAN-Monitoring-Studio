# E3 Diagnostic Software — EKS deploy

Same flow as `E3_Zoho_Desk_API`: **Build → Deliver (ECR) → Deploy (Helm) → Verify**.

## GitHub repository

Create / push under:

```
https://github.com/e3electricAI/E3_Diagonistic_Software.git
```

(or your preferred org repo name)

## Branch → environment

| Branch | Namespace | URL |
|--------|-----------|-----|
| `main` | `prod` | https://e3-diagnostic-software.e3techworld.com |
| `dev` | `dev` | https://e3-diagnostic-software-dev.e3techworld.com |
| `test` | `test` | https://e3-diagnostic-software-test.e3techworld.com |

## Names

| What | Name |
|------|------|
| ECR repo | `e3-diagnostic-software` |
| Helm release | `e3-diagnostic-software` |
| Deployment / app label | `e3-diagnostic-software` |
| GitHub Actions IAM role | `arn:aws:iam::222634361936:role/GitHubActions-ECR-EKS` (same as Zoho) |

## One-time GitHub setup

1. Repo → **Settings → Actions → General** → allow workflows  
2. Create GitHub Environments: `prod`, `dev`, `test` (same OIDC role as Zoho)  
3. Optional repo Variables (defaults already in workflow):
   - `AWS_REGION` = `ap-south-1`
   - `AWS_ACCOUNT_ID` = `222634361936`
   - `EKS_CLUSTER` = `e3-eks`
   - `ECR_REPOSITORY` = `e3-diagnostic-software`
   - `IAM_ROLE_ARN` = `arn:aws:iam::222634361936:role/GitHubActions-ECR-EKS`
   - `HELM_RELEASE` = `e3-diagnostic-software`

## AWS Secrets Manager (prod)

`values-prod.yaml` sets:

```yaml
secret:
  name: e3electric/e3-diagnostic-softwar/tool
```

Create that secret in AWS Secrets Manager as JSON, for example:

```json
{
  "SOFTWARE_VERSIONS_API_KEY": "...",
  "SOFTWARE_VERSIONS_BEARER_TOKEN": "..."
}
```

The pod loads it at startup via `SECRETS_MANAGER_SECRET_NAME` (see `app.py`).

**Required:** Pod Identity / IRSA on service account `e3-diagnostic-software` with
`iam-service-account/pod-secrets-policy.json` (GetSecretValue on that secret).

Local runs skip Secrets Manager when `SECRETS_MANAGER_SECRET_NAME` is unset (use `.env`).

## Deploy

- Push to `main` / `dev` / `test`, **or**
- Actions → **Build and deploy (EKS)** → Run workflow → pick environment

## Rollback

Actions → **Rollback (EKS)** → pick environment (and optional Helm revision)

## Local test

```bash
docker build -t e3-diagnostic-software:local .
docker run --rm -p 8000:8000 e3-diagnostic-software:local
curl http://localhost:8000/api/v1/health
```
