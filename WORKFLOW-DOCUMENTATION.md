# GitHub Actions Workflow Documentation

## Overview

This document provides a detailed line-by-line explanation of the CI/CD workflows used to deploy the 3-tier bookshop application to AWS Auto Scaling Groups.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         GitHub Repository                                │
│                              (main branch)                               │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │ Push/Merge
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CI Pipeline (ci.yml)                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Checkout  │─▶│  Install    │─▶│   Build     │─▶│   Upload    │    │
│  │    Code     │  │   Deps      │  │  Frontend   │  │  Artifact   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │ On Success (triggers both)
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
┌───────────────────────────────┐ ┌───────────────────────────────┐
│  Deploy Frontend Workflow     │ │  Deploy Backend Workflow      │
│  (deploy-frontend.yml)        │ │  (deploy-backend.yml)         │
└───────────────┬───────────────┘ └───────────────┬───────────────┘
                │                                 │
                ▼                                 ▼
┌───────────────────────────────┐ ┌───────────────────────────────┐
│         S3 Bucket             │ │         S3 Bucket             │
│  /frontend/latest/            │ │  /backend/latest/backend.zip  │
│  /frontend/{timestamp}/       │ │  /backend/backend-{ts}.zip    │
└───────────────┬───────────────┘ └───────────────┬───────────────┘
                │ SSM Deploy                      │ SSM Deploy
                ▼                                 ▼
┌───────────────────────────────┐ ┌───────────────────────────────┐
│     Frontend ASG Instances    │ │     Backend ASG Instances     │
│  ┌─────────┐  ┌─────────┐     │ │  ┌─────────┐  ┌─────────┐     │
│  │  Nginx  │  │  Nginx  │     │ │  │  PM2    │  │  PM2    │     │
│  │  EC2-1  │  │  EC2-2  │     │ │  │  EC2-1  │  │  EC2-2  │     │
│  └─────────┘  └─────────┘     │ │  └─────────┘  └─────────┘     │
└───────────────────────────────┘ └───────────────┬───────────────┘
                                                  │
                                                  ▼
                                  ┌───────────────────────────────┐
                                  │        RDS MySQL              │
                                  │        (Multi-AZ)             │
                                  └───────────────────────────────┘
```

---

## Part 1: Deploy Frontend Workflow (deploy-frontend.yml)

### Complete File with Explanations

```yaml
name: Deploy Frontend
```
**Line 1:** Names the workflow "Deploy Frontend" - this appears in GitHub Actions UI.

---

```yaml
on:
  workflow_run:
    workflows: ["CI Pipeline"]
    branches: [main]
    types: [completed]
  workflow_dispatch:
```
**Lines 3-9: Trigger Configuration**
- `workflow_run`: This workflow triggers AFTER another workflow completes
- `workflows: ["CI Pipeline"]`: Specifically waits for the "CI Pipeline" workflow
- `branches: [main]`: Only triggers when CI runs on the main branch
- `types: [completed]`: Triggers when CI completes (success OR failure - we check success later)
- `workflow_dispatch`: Allows manual triggering from GitHub Actions UI (useful for re-deploys)

---

```yaml
concurrency:
  group: deploy-frontend
  cancel-in-progress: false
```
**Lines 11-13: Concurrency Control**
- `group: deploy-frontend`: All runs of this workflow belong to this group
- `cancel-in-progress: false`: If a new deployment starts, DON'T cancel the running one
- This prevents partial deployments - each deployment completes fully

---

```yaml
permissions:
  id-token: write
  contents: read
  actions: read
```
**Lines 15-18: GitHub Token Permissions**
- `id-token: write`: Required for OIDC authentication with AWS (generates JWT token)
- `contents: read`: Allows reading repository code
- `actions: read`: Allows downloading artifacts from other workflow runs

---

```yaml
env:
  AWS_REGION: us-east-1
```
**Lines 20-21: Environment Variables**
- Sets AWS region globally for all steps
- All AWS CLI commands will use this region

---

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' || github.event_name == 'workflow_dispatch' }}
```
**Lines 23-26: Job Configuration**
- `runs-on: ubuntu-latest`: Uses GitHub's Ubuntu runner
- `if` condition: Only runs if:
  - CI Pipeline succeeded (`workflow_run.conclusion == 'success'`), OR
  - Manually triggered (`workflow_dispatch`)
- This prevents deployment if CI tests failed

---

### Step 1: Download Build Artifact

```yaml
    steps:
      - name: Download build artifact
        uses: actions/download-artifact@v4
        with:
          name: frontend-build
          path: ./build
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
        continue-on-error: true
        id: download-artifact
```
**Lines 28-38: Download Pre-built Frontend**
- Tries to download the build artifact from CI Pipeline
- `name: frontend-build`: Artifact name uploaded by CI
- `path: ./build`: Where to extract the artifact
- `run-id`: Gets the specific CI run that triggered this workflow
- `continue-on-error: true`: If download fails, continue (we have a fallback)
- `id: download-artifact`: Gives this step an ID to check its outcome later

---

### Steps 2-4: Fallback Build (if artifact missing)

```yaml
      - name: Checkout and build if no artifact
        if: steps.download-artifact.outcome == 'failure'
        uses: actions/checkout@v4
      
      - name: Setup Node.js (fallback build)
        if: steps.download-artifact.outcome == 'failure'
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
          cache-dependency-path: client/package-lock.json
      
      - name: Build frontend (fallback)
        if: steps.download-artifact.outcome == 'failure'
        run: |
          cd client
          npm ci
          npm run build
          mv build ../build
        env:
          REACT_APP_API_URL: ${{ vars.API_BASE_URL }}
```
**Lines 40-60: Fallback Build**
- Only runs if artifact download failed
- `steps.download-artifact.outcome == 'failure'`: Checks previous step result
- Checks out code, installs Node.js 18, builds the React app
- `npm ci`: Clean install (faster, uses package-lock.json exactly)
- `REACT_APP_API_URL`: Environment variable for React build

---

### Step 5: AWS Authentication

```yaml
      - name: Configure AWS credentials via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}
```
**Lines 62-67: OIDC Authentication**
- Uses OpenID Connect (OIDC) - no long-lived AWS keys stored in GitHub
- GitHub generates a JWT token, AWS validates it, returns temporary credentials
- `role-to-assume`: IAM role ARN stored in GitHub Secrets
- Much more secure than storing AWS_ACCESS_KEY_ID/SECRET

**How OIDC Works:**
```
GitHub Runner → JWT Token → AWS STS → Temporary Credentials (15 min)
```

---

### Step 6: Upload to S3

```yaml
      - name: Upload build to S3
        run: |
          TIMESTAMP=$(date +%Y%m%d%H%M%S)
          
          # Upload timestamped version
          aws s3 sync ./build s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/frontend/$TIMESTAMP/
          
          # Upload as latest (for new ASG instances)
          aws s3 sync ./build s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/frontend/latest/
          
          echo "DEPLOY_PATH=frontend/$TIMESTAMP" >> $GITHUB_ENV
          echo "✅ Uploaded to s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/frontend/$TIMESTAMP/"
```
**Lines 69-80: S3 Upload Strategy**

**Two uploads happen:**
1. **Timestamped version** (`/frontend/20240115143022/`):
   - Keeps history of all deployments
   - Useful for rollbacks
   
2. **Latest version** (`/frontend/latest/`):
   - Always contains current production code
   - **Critical for ASG**: New instances pull from here on boot

**Why both?**
- Existing instances: Get deployed via SSM (next step)
- New instances (scale-out/replacement): Pull from `/latest/` in userdata

---

### Step 7: Get ASG Instances

```yaml
      - name: Get ASG Instance IDs
        id: get-instances
        run: |
          INSTANCE_IDS=$(aws autoscaling describe-auto-scaling-groups \
            --auto-scaling-group-names ${{ secrets.FRONTEND_ASG_NAME }} \
            --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`].InstanceId' \
            --output text)
          
          if [ -z "$INSTANCE_IDS" ]; then
            echo "::warning::No InService instances found in ASG"
            echo "INSTANCE_COUNT=0" >> $GITHUB_ENV
          else
            INSTANCE_COUNT=$(echo "$INSTANCE_IDS" | wc -w)
            echo "Found $INSTANCE_COUNT instance(s): $INSTANCE_IDS"
            echo "INSTANCE_IDS=$INSTANCE_IDS" >> $GITHUB_ENV
            echo "INSTANCE_COUNT=$INSTANCE_COUNT" >> $GITHUB_ENV
          fi
```
**Lines 82-98: Dynamic Instance Discovery**

**Key Points:**
- Queries ASG to find ALL currently running instances
- `LifecycleState==InService`: Only healthy, active instances
- Stores instance IDs in environment variable for next step
- Handles edge case of 0 instances (ASG scaled to 0)

**Why not hardcode instance IDs?**
- ASG instances are ephemeral - they get replaced
- Instance IDs change on every scale event
- This approach always deploys to current instances

---

### Step 8: Deploy via SSM

```yaml
      - name: Deploy to all ASG instances via SSM
        if: env.INSTANCE_COUNT != '0'
        run: |
          echo "🚀 Deploying to ${{ env.INSTANCE_COUNT }} instance(s)..."
          
          COMMAND_ID=$(aws ssm send-command \
            --targets "Key=tag:aws:autoscaling:groupName,Values=${{ secrets.FRONTEND_ASG_NAME }}" \
            --document-name "AWS-RunShellScript" \
            --parameters commands="[
              \"echo Downloading frontend build from S3...\",
              \"aws s3 sync s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/frontend/latest/ /tmp/frontend-build/\",
              \"echo Deploying to web server...\",
              \"sudo rm -rf /usr/share/nginx/html/*\",
              \"sudo cp -r /tmp/frontend-build/* /usr/share/nginx/html/\",
              \"sudo chown -R nginx:nginx /usr/share/nginx/html/\",
              \"sudo systemctl reload nginx\",
              \"rm -rf /tmp/frontend-build\",
              \"echo Deployment complete!\"
            ]" \
            --timeout-seconds 120 \
            --query 'Command.CommandId' --output text)
```
**Lines 100-121: SSM Remote Execution**

**What is SSM (Systems Manager)?**
- AWS service to run commands on EC2 instances remotely
- No SSH needed, no security groups to open
- Works through SSM Agent installed on instances

**Command Breakdown:**
1. `aws s3 sync`: Download build from S3 to temp folder
2. `sudo rm -rf /usr/share/nginx/html/*`: Clear old files
3. `sudo cp -r`: Copy new files to Nginx document root
4. `sudo chown -R nginx:nginx`: Set correct ownership
5. `sudo systemctl reload nginx`: Reload Nginx (zero-downtime)
6. `rm -rf /tmp/frontend-build`: Cleanup temp files

**Why `/usr/share/nginx/html/`?**
- Amazon Linux 2023 default Nginx document root
- Different from older AL2 which used `/var/www/html/`

---

### Step 8 (continued): Wait for Completion

```yaml
          echo "Command ID: $COMMAND_ID"
          echo "COMMAND_ID=$COMMAND_ID" >> $GITHUB_ENV
          
          echo "Waiting for deployment to complete on all instances..."
          for i in {1..20}; do
            STATUSES=$(aws ssm list-command-invocations \
              --command-id $COMMAND_ID \
              --query 'CommandInvocations[*].[InstanceId,Status]' \
              --output text)
            
            echo "Status check $i/20:"
            echo "$STATUSES"
            
            PENDING=$(echo "$STATUSES" | grep -E "Pending|InProgress" | wc -l)
            FAILED=$(echo "$STATUSES" | grep -E "Failed|Cancelled|TimedOut" | wc -l)
            
            if [ "$FAILED" -gt 0 ]; then
              echo "::error::Deployment failed on one or more instances"
              exit 1
            fi
            
            if [ "$PENDING" -eq 0 ]; then
              echo "✅ All instances deployed successfully"
              break
            fi
            
            sleep 5
          done
```
**Lines 123-150: Deployment Status Monitoring**

**Polling Loop:**
- Checks SSM command status every 5 seconds
- Maximum 20 attempts (100 seconds total)
- Tracks status for ALL instances simultaneously

**Status Values:**
- `Pending`: Command queued
- `InProgress`: Currently executing
- `Success`: Completed successfully
- `Failed/Cancelled/TimedOut`: Error states

**Failure Handling:**
- If ANY instance fails, entire workflow fails
- Prevents partial deployments

---

### Step 9: Health Check via SSM

```yaml
      - name: Health check via SSM
        if: env.INSTANCE_COUNT != '0'
        run: |
          echo "Running health check from inside the instance via SSM..."
          
          FIRST_INSTANCE=$(echo "${{ env.INSTANCE_IDS }}" | awk '{print $1}')
          
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids "$FIRST_INSTANCE" \
            --document-name "AWS-RunShellScript" \
            --parameters commands="[
              \"sleep 3\",
              \"HTTP_CODE=\\$(curl -s -o /dev/null -w '%{http_code}' http://localhost/ --max-time 10)\",
              \"echo HTTP_CODE=\\$HTTP_CODE\",
              \"if [ \\\"\\$HTTP_CODE\\\" != \\\"200\\\" ]; then echo HEALTH_CHECK_FAILED; exit 1; fi\",
              \"echo HEALTH_CHECK_PASSED\"
            ]" \
            --timeout-seconds 60 \
            --query 'Command.CommandId' --output text)
```
**Lines 152-170: Internal Health Check**

**Why SSM instead of direct curl?**
- GitHub runner can't reach private ALB/instances
- Running curl FROM the instance tests actual deployment
- Tests localhost:80 which is what ALB health checks use

**Command Breakdown:**
1. `sleep 3`: Wait for Nginx reload
2. `curl -s -o /dev/null -w '%{http_code}'`: Get HTTP status code only
3. Check if 200, exit 1 if not

---

### Step 10: Deployment Summary

```yaml
      - name: Deployment summary
        if: success()
        run: |
          echo "## ✅ Frontend Deployment Successful!" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "| Detail | Value |" >> $GITHUB_STEP_SUMMARY
          echo "|--------|-------|" >> $GITHUB_STEP_SUMMARY
          echo "| Commit | \`${{ github.sha }}\` |" >> $GITHUB_STEP_SUMMARY
          echo "| Branch | ${{ github.ref_name }} |" >> $GITHUB_STEP_SUMMARY
          echo "| Deployed by | ${{ github.actor }} |" >> $GITHUB_STEP_SUMMARY
          echo "| Instances | ${{ env.INSTANCE_COUNT }} |" >> $GITHUB_STEP_SUMMARY
          echo "| S3 Path | \`s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/${{ env.DEPLOY_PATH }}/\` |" >> $GITHUB_STEP_SUMMARY
```
**Lines 190-202: Job Summary**
- Creates a nice summary table in GitHub Actions UI
- `$GITHUB_STEP_SUMMARY`: Special file that renders as markdown
- Shows commit, branch, deployer, instance count, S3 path

---

## Part 2: Deploy Backend Workflow (deploy-backend.yml)

### Complete File with Explanations

```yaml
name: Deploy Backend
```
**Line 1:** Names the workflow "Deploy Backend".

---

```yaml
on:
  workflow_run:
    workflows: ["CI Pipeline"]
    branches: [main]
    types: [completed]
  workflow_dispatch:
```
**Lines 3-9:** Same trigger configuration as frontend - runs after CI Pipeline succeeds.

---

```yaml
concurrency:
  group: deploy-backend
  cancel-in-progress: false
```
**Lines 11-13:** Prevents concurrent backend deployments.

---

```yaml
permissions:
  id-token: write
  contents: read
  actions: read

env:
  AWS_REGION: us-east-1
```
**Lines 15-21:** Same permissions and region as frontend.

---

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' || github.event_name == 'workflow_dispatch' }}
```
**Lines 23-26:** Same job configuration - only runs on CI success or manual trigger.

---

### Step 1: Checkout Repository

```yaml
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
```
**Lines 28-30:** Checks out the repository code.

**Note:** Backend doesn't use artifacts like frontend because:
- Backend needs to be packaged fresh (zip file)
- No build step needed (Node.js runs source directly)

---

### Step 2: AWS Authentication

```yaml
      - name: Configure AWS credentials via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}
```
**Lines 32-37:** Same OIDC authentication as frontend.

---

### Step 3: Package and Upload to S3

```yaml
      - name: Package backend and upload to S3
        run: |
          TIMESTAMP=$(date +%Y%m%d%H%M%S)
          cd backend
          zip -r ../backend-$TIMESTAMP.zip . -x "node_modules/*" -x ".env"
          
          # Upload timestamped version
          aws s3 cp ../backend-$TIMESTAMP.zip \
            s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/backend/backend-$TIMESTAMP.zip
          
          # Upload as latest (for new ASG instances)
          aws s3 cp ../backend-$TIMESTAMP.zip \
            s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/backend/latest/backend.zip
          
          echo "DEPLOY_FILE=backend/backend-$TIMESTAMP.zip" >> $GITHUB_ENV
          echo "✅ Uploaded to s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/backend/backend-$TIMESTAMP.zip"
```
**Lines 39-55: Backend Packaging**

**Zip Command Breakdown:**
- `zip -r`: Recursive zip
- `-x "node_modules/*"`: Exclude node_modules (will npm install on instance)
- `-x ".env"`: **CRITICAL** - Never include .env in deployment package!

**Why exclude node_modules?**
- node_modules is huge (100MB+)
- Contains platform-specific binaries
- `npm ci` on target instance ensures correct dependencies

**Why exclude .env?**
- Contains database credentials
- Should never be in version control or deployment packages
- Instances have their own .env files

**Two uploads (same as frontend):**
1. Timestamped for history/rollback
2. `/latest/` for new ASG instances

---

### Step 4: Get ASG Instances

```yaml
      - name: Get ASG Instance IDs
        id: get-instances
        run: |
          INSTANCE_IDS=$(aws autoscaling describe-auto-scaling-groups \
            --auto-scaling-group-names ${{ secrets.BACKEND_ASG_NAME }} \
            --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`].InstanceId' \
            --output text)
          
          if [ -z "$INSTANCE_IDS" ]; then
            echo "::warning::No InService instances found in ASG"
            echo "INSTANCE_COUNT=0" >> $GITHUB_ENV
          else
            INSTANCE_COUNT=$(echo "$INSTANCE_IDS" | wc -w)
            echo "Found $INSTANCE_COUNT instance(s): $INSTANCE_IDS"
            echo "INSTANCE_IDS=$INSTANCE_IDS" >> $GITHUB_ENV
            echo "INSTANCE_COUNT=$INSTANCE_COUNT" >> $GITHUB_ENV
          fi
```
**Lines 57-73:** Same dynamic instance discovery as frontend.

---

### Step 5: Deploy via SSM

```yaml
      - name: Deploy to all ASG instances via SSM
        if: env.INSTANCE_COUNT != '0'
        run: |
          echo "🚀 Deploying to ${{ env.INSTANCE_COUNT }} instance(s)..."
          
          COMMAND_ID=$(aws ssm send-command \
            --targets "Key=tag:aws:autoscaling:groupName,Values=${{ secrets.BACKEND_ASG_NAME }}" \
            --document-name "AWS-RunShellScript" \
            --parameters commands="[
              \"cd /home/ec2-user\",
              \"echo Downloading deployment package...\",
              \"aws s3 cp s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/backend/latest/backend.zip /tmp/backend.zip\",
              \"echo Extracting and deploying...\",
              \"rm -rf app.new && mkdir -p app.new\",
              \"unzip -o /tmp/backend.zip -d app.new\",
              \"cp app/.env app.new/.env 2>/dev/null || echo No existing .env to preserve\",
              \"cd app.new && npm ci --production\",
              \"rm -rf ../app.old && mv ../app ../app.old 2>/dev/null || true\",
              \"mv ../app.new ../app\",
              \"cd ../app && pm2 restart backendAPI || pm2 start index.js --name backendAPI\",
              \"pm2 save\",
              \"rm -f /tmp/backend.zip\",
              \"echo Deployment complete!\"
            ]" \
            --timeout-seconds 300 \
            --query 'Command.CommandId' --output text)
```
**Lines 75-101: Backend Deployment Commands**

**Deployment Strategy: Blue-Green Style**

```
/home/ec2-user/
├── app/          ← Current production (will become app.old)
├── app.new/      ← New deployment being prepared
└── app.old/      ← Previous version (backup)
```

**Command-by-Command Breakdown:**

1. `cd /home/ec2-user` - Working directory
2. `aws s3 cp ... /tmp/backend.zip` - Download package
3. `rm -rf app.new && mkdir -p app.new` - Clean staging area
4. `unzip -o /tmp/backend.zip -d app.new` - Extract new code
5. `cp app/.env app.new/.env` - **CRITICAL**: Preserve existing .env file!
6. `cd app.new && npm ci --production` - Install dependencies
7. `mv ../app ../app.old` - Backup current version
8. `mv ../app.new ../app` - Promote new version
9. `pm2 restart backendAPI || pm2 start index.js --name backendAPI` - Restart/start PM2
10. `pm2 save` - Save PM2 process list for auto-restart on reboot
11. `rm -f /tmp/backend.zip` - Cleanup

**Why preserve .env?**
- .env contains database credentials
- Not included in deployment package
- Must survive deployments

**PM2 Command Logic:**
- `pm2 restart backendAPI`: If process exists, restart it
- `|| pm2 start index.js --name backendAPI`: If not, start new process
- Handles both updates and fresh deployments

---

### Step 5 (continued): Wait for Completion

```yaml
          echo "Command ID: $COMMAND_ID"
          echo "COMMAND_ID=$COMMAND_ID" >> $GITHUB_ENV
          
          echo "Waiting for deployment to complete on all instances..."
          for i in {1..30}; do
            STATUSES=$(aws ssm list-command-invocations \
              --command-id $COMMAND_ID \
              --query 'CommandInvocations[*].[InstanceId,Status]' \
              --output text)
            
            echo "Status check $i/30:"
            echo "$STATUSES"
            
            PENDING=$(echo "$STATUSES" | grep -E "Pending|InProgress" | wc -l)
            FAILED=$(echo "$STATUSES" | grep -E "Failed|Cancelled|TimedOut" | wc -l)
            
            if [ "$FAILED" -gt 0 ]; then
              echo "::error::Deployment failed on one or more instances"
              exit 1
            fi
            
            if [ "$PENDING" -eq 0 ]; then
              echo "✅ All instances deployed successfully"
              break
            fi
            
            sleep 10
          done
```
**Lines 103-130:** Same polling loop as frontend, but:
- 30 iterations (vs 20 for frontend)
- 10 second sleep (vs 5 for frontend)
- Total timeout: 300 seconds (backend takes longer due to npm ci)

---

### Step 6: Health Check via SSM

```yaml
      - name: Health check via SSM
        if: env.INSTANCE_COUNT != '0'
        run: |
          echo "Running health check from inside the instance via SSM..."
          
          FIRST_INSTANCE=$(echo "${{ env.INSTANCE_IDS }}" | awk '{print $1}')
          
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids "$FIRST_INSTANCE" \
            --document-name "AWS-RunShellScript" \
            --parameters commands="[
              \"sleep 5\",
              \"HTTP_CODE=\\$(curl -s -o /dev/null -w '%{http_code}' http://localhost/books --max-time 10)\",
              \"echo HTTP_CODE=\\$HTTP_CODE\",
              \"if [ \\\"\\$HTTP_CODE\\\" != \\\"200\\\" ]; then echo HEALTH_CHECK_FAILED; exit 1; fi\",
              \"echo HEALTH_CHECK_PASSED\"
            ]" \
            --timeout-seconds 60 \
            --query 'Command.CommandId' --output text)
```
**Lines 132-150: Backend Health Check**

**Differences from Frontend:**
- Checks `/books` endpoint (not `/`)
- Longer sleep (5s vs 3s) - PM2 restart takes time
- Tests actual API functionality, not just static files

---

### Step 7: Deployment Summary

```yaml
      - name: Deployment summary
        if: success()
        run: |
          echo "## ✅ Backend Deployment Successful!" >> $GITHUB_STEP_SUMMARY
          ...
```
**Lines 170-182:** Same summary format as frontend.

---

## Part 3: ASG Instance Lifecycle & Auto-Deployment

### How New Instances Get Code

When ASG launches a new instance (scale-out, replacement, etc.), the Launch Template's UserData script runs:

#### Frontend Launch Template UserData
```bash
#!/bin/bash
set -e

# Install Nginx
dnf update -y
dnf install nginx -y
systemctl enable nginx
systemctl start nginx

# Install SSM Agent (usually pre-installed on AL2023)
dnf install -y amazon-ssm-agent
systemctl enable amazon-ssm-agent
systemctl start amazon-ssm-agent

# Configure Nginx for React SPA
cat > /etc/nginx/conf.d/app.conf << 'EOF'
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /health {
        return 200 'healthy';
    }
}
EOF

systemctl restart nginx

# Download latest build from S3
aws s3 sync s3://bookstore-deployments-101645635382/frontend/latest/ /usr/share/nginx/html/
chown -R nginx:nginx /usr/share/nginx/html/

echo "Frontend setup complete"
```

#### Backend Launch Template UserData
```bash
#!/bin/bash
set -e

# Install Node.js
dnf update -y
dnf install -y nodejs npm

# Install PM2 globally
npm install -g pm2

# Install SSM Agent
dnf install -y amazon-ssm-agent
systemctl enable amazon-ssm-agent
systemctl start amazon-ssm-agent

# Create app directory
mkdir -p /home/ec2-user/app
cd /home/ec2-user

# Download latest backend from S3
aws s3 cp s3://bookstore-deployments-101645635382/backend/latest/backend.zip /tmp/backend.zip
unzip -o /tmp/backend.zip -d app

# Install dependencies
cd app
npm ci --production

# Start with PM2 (Note: .env must be pre-configured or use SSM Parameter Store)
pm2 start index.js --name backendAPI
pm2 save
pm2 startup

echo "Backend setup complete"
```

### Instance Lifecycle Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ASG Instance Lifecycle                                │
└─────────────────────────────────────────────────────────────────────────────┘

1. LAUNCH TRIGGER
   ├── Scale-out (CPU > 70%)
   ├── Instance terminated (unhealthy)
   ├── Manual capacity increase
   └── Scheduled scaling

2. INSTANCE LAUNCH
   ├── ASG creates new EC2 from Launch Template
   ├── Instance starts in "Pending" state
   └── UserData script begins execution

3. USERDATA EXECUTION
   ├── Install required software (Nginx/Node.js)
   ├── Configure services
   ├── Download code from S3 /latest/ path    ◄── Gets current production code!
   └── Start application

4. HEALTH CHECK GRACE PERIOD
   ├── Instance in "Pending:Wait" state
   ├── ALB health checks begin
   └── Wait for application to be ready

5. INSTANCE BECOMES HEALTHY
   ├── ALB health check passes
   ├── Instance moves to "InService" state
   └── ALB starts routing traffic to instance

6. NORMAL OPERATION
   ├── Instance serves traffic
   ├── Future deployments via SSM (not userdata)
   └── Monitored by ALB health checks

7. TERMINATION (if needed)
   ├── Scale-in event
   ├── Health check failure
   ├── Spot interruption
   └── Instance replaced, cycle repeats
```

---

## Part 4: Key Concepts Explained

### OIDC Authentication (No Long-Lived Keys)

**Traditional Approach (Insecure):**
```yaml
# DON'T DO THIS - Keys can be leaked
env:
  AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

**OIDC Approach (Secure):**
```yaml
# GitHub generates a JWT, AWS validates it
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789:role/github-actions-role
```

**How it works:**
1. GitHub generates a signed JWT token with claims (repo, branch, workflow)
2. AWS IAM validates the token against GitHub's OIDC provider
3. AWS STS returns temporary credentials (valid 15 minutes)
4. No secrets stored in GitHub!

---

### SSM vs SSH for Deployment

**SSH Approach (Complex):**
- Need to manage SSH keys
- Need to open port 22 in security groups
- Need bastion host for private instances
- Key rotation is painful

**SSM Approach (Simple):**
- No ports to open
- No keys to manage
- Works with private instances
- IAM-based authentication
- Full audit trail in CloudTrail

---

### Why Two S3 Paths (Timestamped + Latest)?

```
s3://bucket/
├── frontend/
│   ├── latest/              ← Always current production
│   │   ├── index.html
│   │   └── static/
│   ├── 20240115143022/      ← Historical versions
│   ├── 20240114120000/
│   └── 20240113090000/
└── backend/
    ├── latest/
    │   └── backend.zip      ← Always current production
    ├── backend-20240115143022.zip
    └── backend-20240114120000.zip
```

**Use Cases:**
- `/latest/`: New ASG instances pull from here
- Timestamped: Rollback to specific version if needed

---

### Health Check: Why SSM Instead of Direct Curl?

**Problem with Direct Curl:**
```yaml
# This FAILS with exit code 28 (timeout)
- run: curl http://$ALB_DNS/books
```

**Why it fails:**
- GitHub runner is on public internet
- ALB might be internal or have security groups
- Network path: GitHub → Internet → ALB (blocked)

**Solution with SSM:**
```yaml
# This WORKS - runs from inside the instance
- run: |
    aws ssm send-command \
      --parameters commands="curl http://localhost/books"
```

**Why it works:**
- Command runs ON the EC2 instance
- Tests localhost (same as ALB health check)
- No network restrictions

---

## Part 5: Troubleshooting Guide

### Common Issues and Solutions

| Issue | Symptom | Solution |
|-------|---------|----------|
| Health check timeout | Exit code 28 | Use SSM-based health check |
| 502 Bad Gateway | ALB can't reach instances | Check security groups, PM2 status |
| Frontend shows old IP | Network error in console | Update config.js with ALB DNS |
| Backend can't connect to RDS | Connection timeout | Add RDS SG rule for backend SG |
| New instance has no code | 502 after scale-out | Check userdata pulls from /latest/ |
| npm ci fails | SSM command fails | Check Node.js version, disk space |
| .env missing after deploy | DB connection error | Ensure cp app/.env preserves file |

### Debugging Commands

```bash
# Check SSM command output
aws ssm get-command-invocation \
  --command-id <COMMAND_ID> \
  --instance-id <INSTANCE_ID> \
  --query 'StandardOutputContent'

# Check PM2 status on backend
aws ssm send-command \
  --instance-ids <INSTANCE_ID> \
  --document-name "AWS-RunShellScript" \
  --parameters commands="pm2 status"

# Check Nginx status on frontend
aws ssm send-command \
  --instance-ids <INSTANCE_ID> \
  --document-name "AWS-RunShellScript" \
  --parameters commands="systemctl status nginx"

# View backend logs
aws ssm send-command \
  --instance-ids <INSTANCE_ID> \
  --document-name "AWS-RunShellScript" \
  --parameters commands="pm2 logs backendAPI --lines 50"
```

---

## Part 6: GitHub Secrets Reference

| Secret Name | Description | Example Value |
|-------------|-------------|---------------|
| `AWS_ROLE_ARN` | IAM role for OIDC auth | `arn:aws:iam::101645635382:role/github-actions-role` |
| `S3_DEPLOYMENT_BUCKET` | S3 bucket for artifacts | `bookstore-deployments-101645635382` |
| `FRONTEND_ASG_NAME` | Frontend ASG name | `frontend-asg-primary` |
| `BACKEND_ASG_NAME` | Backend ASG name | `backend-asg-primary` |
| `FRONTEND_ALB_NAME` | Frontend ALB name | `frontend-alb-primary` |
| `BACKEND_ALB_NAME` | Backend ALB name | `backend-alb-primary` |

---

## Summary

This CI/CD pipeline provides:

1. **Automated Deployments**: Push to main → automatic deployment
2. **Zero-Downtime**: Rolling updates via SSM
3. **ASG Compatibility**: New instances auto-deploy from S3
4. **Security**: OIDC auth, no long-lived keys, .env protection
5. **Reliability**: Health checks, failure detection, rollback capability
6. **Observability**: Deployment summaries, SSM command logs
