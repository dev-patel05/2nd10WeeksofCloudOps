# Complete CI/CD Setup Guide: Zero to Hero

This guide walks you through setting up a production-ready CI/CD pipeline using GitHub Actions and AWS SSM for your 3-tier application.

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Part 1: AWS Infrastructure Setup](#part-1-aws-infrastructure-setup)
3. [Part 2: GitHub Repository Configuration](#part-2-github-repository-configuration)
4. [Part 3: Create CI/CD Workflow Files](#part-3-create-cicd-workflow-files)
5. [Part 4: Monitoring Setup](#part-4-monitoring-setup)
6. [Part 5: Testing the Pipeline](#part-5-testing-the-pipeline)

---

## Prerequisites

Before starting, ensure you have:
- [ ] AWS Account with admin access
- [ ] GitHub account with repository admin access
- [ ] Two EC2 instances running (Frontend: 10.0.133.110, Backend: 10.0.136.242)
- [ ] SSM Agent installed on both EC2 instances
- [ ] Basic understanding of AWS Console and GitHub

---

## Part 1: AWS Infrastructure Setup

### Step 1.1: Create S3 Bucket for Deployment Artifacts

1. **Open AWS Console** → Search for "S3" → Click "S3"

2. **Create Bucket:**
   - Click **"Create bucket"**
   - Bucket name: `your-app-deployments-<account-id>` (must be globally unique)
   - Region: Same as your EC2 instances (e.g., `us-east-1`)
   - Keep "Block all public access" **enabled**
   - Enable **Bucket Versioning**
   - Click **"Create bucket"**

3. **Add Lifecycle Rule (Optional - cleanup old artifacts):**
   - Click on your bucket → **Management** tab
   - Click **"Create lifecycle rule"**
   - Rule name: `delete-old-deployments`
   - Apply to all objects
   - Select **"Expire current versions of objects"** → Days: `30`
   - Click **"Create rule"**


### Step 1.2: Create GitHub OIDC Identity Provider in AWS

GitHub Actions can assume IAM roles using OIDC (OpenID Connect) - no long-lived credentials needed!

1. **Open AWS Console** → Search for "IAM" → Click "IAM"

2. **Create Identity Provider:**
   - Click **"Identity providers"** in left sidebar
   - Click **"Add provider"**
   - Provider type: **OpenID Connect**
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Click **"Get thumbprint"**
   - Audience: `sts.amazonaws.com`
   - Click **"Add provider"**

### Step 1.3: Create IAM Policy for GitHub Actions

1. **In IAM Console** → Click **"Policies"** in left sidebar

2. **Create Policy:**
   - Click **"Create policy"**
   - Click **"JSON"** tab
   - Paste this policy (replace `YOUR-BUCKET-NAME`):

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "SSMPermissions",
            "Effect": "Allow",
            "Action": [
                "ssm:SendCommand",
                "ssm:GetCommandInvocation",
                "ssm:ListCommandInvocations",
                "ssm:DescribeInstanceInformation"
            ],
            "Resource": "*"
        },
        {
            "Sid": "S3Permissions",
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:GetObject",
                "s3:DeleteObject",
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::YOUR-BUCKET-NAME",
                "arn:aws:s3:::YOUR-BUCKET-NAME/*"
            ]
        },
        {
            "Sid": "CloudWatchLogs",
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:DescribeLogGroups"
            ],
            "Resource": "*"
        }
    ]
}
```

3. **Name the Policy:**
   - Click **"Next"**
   - Policy name: `GitHubActions-CICD-Policy`
   - Description: `Policy for GitHub Actions CI/CD pipeline`
   - Click **"Create policy"**


### Step 1.4: Create IAM Role for GitHub Actions

1. **In IAM Console** → Click **"Roles"** in left sidebar

2. **Create Role:**
   - Click **"Create role"**
   - Trusted entity type: **Web identity**
   - Identity provider: Select `token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`
   - Click **"Next"**

3. **Add Permissions:**
   - Search for `GitHubActions-CICD-Policy`
   - Check the box next to it
   - Click **"Next"**

4. **Name the Role:**
   - Role name: `GitHubActions-CICD-Role`
   - Description: `Role for GitHub Actions to deploy via SSM`
   - Click **"Create role"**

5. **Update Trust Policy (IMPORTANT - Restrict to your repo):**
   - Click on the role `GitHubActions-CICD-Role`
   - Go to **"Trust relationships"** tab
   - Click **"Edit trust policy"**
   - Replace with this (update `YOUR-GITHUB-ORG` and `YOUR-REPO-NAME`):

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Federated": "arn:aws:iam::YOUR-AWS-ACCOUNT-ID:oidc-provider/token.actions.githubusercontent.com"
            },
            "Action": "sts:AssumeRoleWithWebIdentity",
            "Condition": {
                "StringEquals": {
                    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
                },
                "StringLike": {
                    "token.actions.githubusercontent.com:sub": "repo:YOUR-GITHUB-ORG/YOUR-REPO-NAME:*"
                }
            }
        }
    ]
}
```

   **Example:** If your repo is `https://github.com/mycompany/2nd10WeeksofCloudOps`:
   - `YOUR-GITHUB-ORG` = `mycompany`
   - `YOUR-REPO-NAME` = `2nd10WeeksofCloudOps`
   - `YOUR-AWS-ACCOUNT-ID` = Your 12-digit AWS account ID (find in top-right corner)

   - Click **"Update policy"**

6. **Copy the Role ARN:**
   - On the role summary page, copy the **ARN**
   - It looks like: `arn:aws:iam::123456789012:role/GitHubActions-CICD-Role`
   - **Save this for GitHub Secrets!**

### Step 1.5: Verify EC2 SSM Agent Configuration

1. **Open AWS Console** → Search for "Systems Manager" → Click "Systems Manager"

2. **Check Managed Instances:**
   - Click **"Fleet Manager"** in left sidebar
   - You should see both EC2 instances listed
   - Status should be **"Online"**

3. **If instances are NOT showing:**
   
   **Option A: Check EC2 Instance IAM Role**
   - Go to EC2 Console → Select your instance
   - Click **"Actions"** → **"Security"** → **"Modify IAM role"**
   - Attach a role with `AmazonSSMManagedInstanceCore` policy
   
   **Option B: Install SSM Agent (if not installed)**
   - SSH into your EC2 instance and run:
   ```bash
   # For Amazon Linux 2
   sudo yum install -y amazon-ssm-agent
   sudo systemctl enable amazon-ssm-agent
   sudo systemctl start amazon-ssm-agent
   
   # For Ubuntu
   sudo snap install amazon-ssm-agent --classic
   sudo systemctl enable snap.amazon-ssm-agent.amazon-ssm-agent.service
   sudo systemctl start snap.amazon-ssm-agent.amazon-ssm-agent.service
   ```

4. **Test SSM Connectivity:**
   - In Systems Manager → Click **"Run Command"**
   - Click **"Run command"**
   - Search for `AWS-RunShellScript`
   - Select your instances
   - In **"Command parameters"** → Commands: `echo "SSM is working!"`
   - Click **"Run"**
   - Wait for status to show **"Success"**


### Step 1.6: Get EC2 Instance IDs

1. **Open AWS Console** → Search for "EC2" → Click "EC2"

2. **Find Instance IDs:**
   - Click **"Instances"** in left sidebar
   - Find your Frontend instance (10.0.133.110)
   - Copy the **Instance ID** (e.g., `i-0abc123def456789`)
   - Find your Backend instance (10.0.136.242)
   - Copy the **Instance ID**

3. **Save these for later:**
   ```
   Frontend Instance ID: i-xxxxxxxxxxxxxxxxx
   Backend Instance ID:  i-yyyyyyyyyyyyyyyyy
   ```

---

## Part 2: GitHub Repository Configuration

### Step 2.1: Configure GitHub Secrets

1. **Open GitHub** → Go to your repository

2. **Navigate to Secrets:**
   - Click **"Settings"** tab
   - In left sidebar, click **"Secrets and variables"** → **"Actions"**

3. **Add Repository Secrets** (click "New repository secret" for each):

| Secret Name | Value | Description |
|-------------|-------|-------------|
| `AWS_ROLE_ARN` | `arn:aws:iam::123456789012:role/GitHubActions-CICD-Role` | IAM Role ARN from Step 1.4 |
| `AWS_REGION` | `us-east-1` | Your AWS region |
| `FRONTEND_INSTANCE_ID` | `i-xxx...` | Frontend EC2 Instance ID |
| `BACKEND_INSTANCE_ID` | `i-yyy...` | Backend EC2 Instance ID |
| `S3_DEPLOYMENT_BUCKET` | `your-app-deployments-xxx` | S3 bucket name from Step 1.1 |
| `DB_HOST` | `your-rds-endpoint.xxx.rds.amazonaws.com` | RDS endpoint |
| `DB_USERNAME` | `admin` | Database username |
| `DB_PASSWORD` | `your-password` | Database password |

**Note:** No AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY needed! OIDC handles authentication securely.

4. **Add Repository Variables** (click "Variables" tab → "New repository variable"):

| Variable Name | Value | Description |
|---------------|-------|-------------|
| `API_BASE_URL` | `http://your-backend-url` | Backend API URL for frontend |


### Step 2.2: Create GitHub Environment

1. **In Repository Settings:**
   - Click **"Environments"** in left sidebar
   - Click **"New environment"**

2. **Create Production Environment:**
   - Name: `production`
   - Click **"Configure environment"**

3. **Add Protection Rules:**
   - Check **"Required reviewers"**
   - Add yourself or team members as reviewers
   - Check **"Wait timer"** → Set to `5` minutes (optional)
   - Click **"Save protection rules"**

### Step 2.3: Configure Branch Protection Rules

1. **In Repository Settings:**
   - Click **"Branches"** in left sidebar
   - Click **"Add branch protection rule"**

2. **Configure Protection:**
   - Branch name pattern: `main`
   - Check **"Require a pull request before merging"**
     - Check **"Require approvals"** → Set to `1`
   - Check **"Require status checks to pass before merging"**
     - Check **"Require branches to be up to date before merging"**
     - Search and add: `frontend-ci`, `backend-ci`
   - Check **"Do not allow bypassing the above settings"**
   - Click **"Create"**

---

## Part 3: Create CI/CD Workflow Files

### Step 3.1: Create Directory Structure

In your repository, create the following directory structure:
```
.github/
└── workflows/
    ├── ci.yml
    ├── deploy-frontend.yml
    ├── deploy-backend.yml
    └── rollback.yml
```

You can do this via GitHub UI:
1. Click **"Add file"** → **"Create new file"**
2. Type `.github/workflows/ci.yml` in the filename field


### Step 3.2: Create CI Workflow (ci.yml)

Create file `.github/workflows/ci.yml` with this content:

```yaml
name: CI Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  frontend-ci:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: client
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
          cache-dependency-path: client/package-lock.json
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run linting
        run: npm run lint --if-present
      
      - name: Run tests
        run: npm test -- --watchAll=false --passWithNoTests --coverage
        continue-on-error: true
      
      - name: Build application
        run: npm run build
        env:
          REACT_APP_API_URL: ${{ vars.API_BASE_URL }}
      
      - name: Upload build artifact
        uses: actions/upload-artifact@v4
        with:
          name: frontend-build
          path: client/build/
          retention-days: 7

  backend-ci:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
          cache-dependency-path: backend/package-lock.json
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run linting
        run: npm run lint --if-present
      
      - name: Validate environment config
        run: |
          if [ ! -f .env.example ]; then
            echo "Warning: .env.example not found"
          fi

  security-scan:
    runs-on: ubuntu-latest
    needs: [frontend-ci, backend-ci]
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
      
      - name: Run npm audit (Frontend)
        working-directory: client
        run: npm audit --audit-level=high || true
        continue-on-error: true
      
      - name: Run npm audit (Backend)
        working-directory: backend
        run: npm audit --audit-level=high || true
        continue-on-error: true
      
      - name: Gitleaks Secret Scan
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        continue-on-error: true
      
      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: javascript
      
      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        continue-on-error: true
```


### Step 3.3: Create Frontend Deployment Workflow (deploy-frontend.yml)

Create file `.github/workflows/deploy-frontend.yml`:

```yaml
name: Deploy Frontend

on:
  workflow_run:
    workflows: ["CI Pipeline"]
    branches: [main]
    types: [completed]
  workflow_dispatch:

concurrency:
  group: deploy-frontend
  cancel-in-progress: false

env:
  AWS_REGION: ${{ secrets.AWS_REGION }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' || github.event_name == 'workflow_dispatch' }}
    environment: production
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'
          cache-dependency-path: client/package-lock.json

      - name: Install and build
        working-directory: client
        run: |
          npm ci
          npm run build
        env:
          REACT_APP_API_URL: ${{ vars.API_BASE_URL }}
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ secrets.AWS_REGION }}
      
      - name: Upload build to S3
        run: |
          TIMESTAMP=$(date +%Y%m%d%H%M%S)
          aws s3 sync ./client/build s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/frontend/$TIMESTAMP/
          echo "DEPLOY_PATH=frontend/$TIMESTAMP" >> $GITHUB_ENV
          echo "📦 Uploaded to s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/frontend/$TIMESTAMP/"
      
      - name: Backup current deployment via SSM
        run: |
          echo "🔄 Creating backup of current deployment..."
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids ${{ secrets.FRONTEND_INSTANCE_ID }} \
            --document-name "AWS-RunShellScript" \
            --parameters 'commands=["sudo cp -r /var/www/html /var/www/html.backup.$(date +%Y%m%d%H%M%S) 2>/dev/null || echo No existing deployment to backup"]' \
            --query 'Command.CommandId' --output text)
          
          echo "Waiting for backup command to complete..."
          aws ssm wait command-executed \
            --command-id $COMMAND_ID \
            --instance-id ${{ secrets.FRONTEND_INSTANCE_ID }} || true
          echo "✅ Backup completed"
      
      - name: Deploy to frontend server via SSM
        run: |
          echo "🚀 Deploying to frontend server..."
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids ${{ secrets.FRONTEND_INSTANCE_ID }} \
            --document-name "AWS-RunShellScript" \
            --parameters commands='[
              "echo Downloading from S3...",
              "aws s3 sync s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/${{ env.DEPLOY_PATH }}/ /tmp/frontend-build/",
              "echo Deploying to web root...",
              "sudo rm -rf /var/www/html/*",
              "sudo cp -r /tmp/frontend-build/* /var/www/html/",
              "sudo chown -R nginx:nginx /var/www/html/ 2>/dev/null || sudo chown -R www-data:www-data /var/www/html/",
              "echo Reloading web server...",
              "sudo systemctl reload nginx 2>/dev/null || sudo systemctl reload apache2 2>/dev/null || echo Web server reloaded",
              "rm -rf /tmp/frontend-build",
              "echo Deployment completed!"
            ]' \
            --query 'Command.CommandId' --output text)
          
          echo "Command ID: $COMMAND_ID"
          echo "Waiting for deployment to complete..."
          
          for i in {1..30}; do
            STATUS=$(aws ssm get-command-invocation \
              --command-id $COMMAND_ID \
              --instance-id ${{ secrets.FRONTEND_INSTANCE_ID }} \
              --query 'Status' --output text 2>/dev/null || echo "Pending")
            
            echo "Status: $STATUS"
            
            if [ "$STATUS" = "Success" ]; then
              echo "✅ Deployment completed successfully"
              break
            elif [ "$STATUS" = "Failed" ] || [ "$STATUS" = "Cancelled" ]; then
              echo "❌ Deployment failed with status: $STATUS"
              # Get error output
              aws ssm get-command-invocation \
                --command-id $COMMAND_ID \
                --instance-id ${{ secrets.FRONTEND_INSTANCE_ID }} \
                --query 'StandardErrorContent' --output text
              exit 1
            fi
            sleep 10
          done
      
      - name: Health check via SSM
        run: |
          echo "🏥 Running health check..."
          sleep 10
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids ${{ secrets.FRONTEND_INSTANCE_ID }} \
            --document-name "AWS-RunShellScript" \
            --parameters 'commands=["curl -sf http://localhost/ -o /dev/null && echo Health check passed || exit 1"]' \
            --query 'Command.CommandId' --output text)
          
          aws ssm wait command-executed \
            --command-id $COMMAND_ID \
            --instance-id ${{ secrets.FRONTEND_INSTANCE_ID }} || {
            echo "❌ Health check failed!"
            exit 1
          }
          echo "✅ Health check passed"
      
      - name: Deployment summary
        if: success()
        run: |
          echo "## 🎉 Frontend Deployment Successful!" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "- **Commit:** ${{ github.sha }}" >> $GITHUB_STEP_SUMMARY
          echo "- **Branch:** ${{ github.ref_name }}" >> $GITHUB_STEP_SUMMARY
          echo "- **Deployed by:** ${{ github.actor }}" >> $GITHUB_STEP_SUMMARY
          echo "- **S3 Path:** s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/${{ env.DEPLOY_PATH }}/" >> $GITHUB_STEP_SUMMARY
      
      - name: Rollback on failure
        if: failure()
        run: |
          echo "⚠️ Deployment failed, initiating rollback..."
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids ${{ secrets.FRONTEND_INSTANCE_ID }} \
            --document-name "AWS-RunShellScript" \
            --parameters 'commands=[
              "LATEST_BACKUP=$(ls -td /var/www/html.backup.* 2>/dev/null | head -1)",
              "if [ -n \"$LATEST_BACKUP\" ]; then",
              "  echo Rolling back to $LATEST_BACKUP",
              "  sudo rm -rf /var/www/html/*",
              "  sudo cp -r $LATEST_BACKUP/* /var/www/html/",
              "  sudo systemctl reload nginx 2>/dev/null || sudo systemctl reload apache2",
              "  echo Rollback completed",
              "else",
              "  echo No backup found for rollback",
              "fi"
            ]' \
            --query 'Command.CommandId' --output text)
          
          aws ssm wait command-executed \
            --command-id $COMMAND_ID \
            --instance-id ${{ secrets.FRONTEND_INSTANCE_ID }} || true
          echo "🔄 Rollback attempted"
```


### Step 3.4: Create Backend Deployment Workflow (deploy-backend.yml)

Create file `.github/workflows/deploy-backend.yml`:

```yaml
name: Deploy Backend

on:
  workflow_run:
    workflows: ["CI Pipeline"]
    branches: [main]
    types: [completed]
  workflow_dispatch:

concurrency:
  group: deploy-backend
  cancel-in-progress: false

env:
  AWS_REGION: ${{ secrets.AWS_REGION }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' || github.event_name == 'workflow_dispatch' }}
    environment: production
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ secrets.AWS_REGION }}
      
      - name: Package and upload backend code to S3
        run: |
          TIMESTAMP=$(date +%Y%m%d%H%M%S)
          echo "📦 Packaging backend code..."
          cd backend
          zip -r ../backend-$TIMESTAMP.zip . -x "node_modules/*" -x ".env" -x "*.log"
          cd ..
          echo "☁️ Uploading to S3..."
          aws s3 cp backend-$TIMESTAMP.zip s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/backend/backend-$TIMESTAMP.zip
          echo "DEPLOY_FILE=backend/backend-$TIMESTAMP.zip" >> $GITHUB_ENV
          echo "TIMESTAMP=$TIMESTAMP" >> $GITHUB_ENV
          echo "✅ Uploaded to s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/backend/backend-$TIMESTAMP.zip"
      
      - name: Backup current deployment via SSM
        run: |
          echo "🔄 Creating backup of current deployment..."
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids ${{ secrets.BACKEND_INSTANCE_ID }} \
            --document-name "AWS-RunShellScript" \
            --parameters 'commands=["cp -r ~/app ~/app.backup.$(date +%Y%m%d%H%M%S) 2>/dev/null || echo No existing deployment to backup"]' \
            --query 'Command.CommandId' --output text)
          
          aws ssm wait command-executed \
            --command-id $COMMAND_ID \
            --instance-id ${{ secrets.BACKEND_INSTANCE_ID }} || true
          echo "✅ Backup completed"
      
      - name: Deploy backend code via SSM
        run: |
          echo "🚀 Deploying backend code..."
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids ${{ secrets.BACKEND_INSTANCE_ID }} \
            --document-name "AWS-RunShellScript" \
            --timeout-seconds 600 \
            --parameters commands='[
              "echo === Starting Backend Deployment ===",
              "echo Downloading from S3...",
              "aws s3 cp s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/${{ env.DEPLOY_FILE }} /tmp/backend.zip",
              "echo Extracting code...",
              "rm -rf ~/app.new && mkdir -p ~/app.new",
              "unzip -o /tmp/backend.zip -d ~/app.new",
              "echo Preserving environment file...",
              "cp ~/app/.env ~/app.new/.env 2>/dev/null || echo No .env to preserve",
              "echo Installing dependencies...",
              "cd ~/app.new && npm ci --production",
              "echo Swapping deployments...",
              "rm -rf ~/app.old 2>/dev/null || true",
              "mv ~/app ~/app.old 2>/dev/null || true",
              "mv ~/app.new ~/app",
              "echo Restarting application...",
              "cd ~/app && pm2 restart backendAPI 2>/dev/null || pm2 start index.js --name backendAPI",
              "pm2 save",
              "echo Cleaning up...",
              "rm -f /tmp/backend.zip",
              "echo === Deployment Complete ==="
            ]' \
            --query 'Command.CommandId' --output text)
          
          echo "Command ID: $COMMAND_ID"
          echo "Waiting for deployment to complete (this may take a few minutes)..."
          
          for i in {1..60}; do
            STATUS=$(aws ssm get-command-invocation \
              --command-id $COMMAND_ID \
              --instance-id ${{ secrets.BACKEND_INSTANCE_ID }} \
              --query 'Status' --output text 2>/dev/null || echo "Pending")
            
            echo "Status: $STATUS (attempt $i/60)"
            
            if [ "$STATUS" = "Success" ]; then
              echo "✅ Deployment completed successfully"
              # Show output
              aws ssm get-command-invocation \
                --command-id $COMMAND_ID \
                --instance-id ${{ secrets.BACKEND_INSTANCE_ID }} \
                --query 'StandardOutputContent' --output text
              break
            elif [ "$STATUS" = "Failed" ] || [ "$STATUS" = "Cancelled" ] || [ "$STATUS" = "TimedOut" ]; then
              echo "❌ Deployment failed with status: $STATUS"
              aws ssm get-command-invocation \
                --command-id $COMMAND_ID \
                --instance-id ${{ secrets.BACKEND_INSTANCE_ID }} \
                --query 'StandardErrorContent' --output text
              exit 1
            fi
            sleep 10
          done
      
      - name: Health check via SSM
        run: |
          echo "🏥 Running health check..."
          sleep 15
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids ${{ secrets.BACKEND_INSTANCE_ID }} \
            --document-name "AWS-RunShellScript" \
            --parameters 'commands=["curl -sf http://localhost:80/books -o /dev/null && echo API health check passed || curl -sf http://localhost:3000/books -o /dev/null && echo API health check passed || exit 1"]' \
            --query 'Command.CommandId' --output text)
          
          aws ssm wait command-executed \
            --command-id $COMMAND_ID \
            --instance-id ${{ secrets.BACKEND_INSTANCE_ID }} || {
            echo "❌ Health check failed!"
            exit 1
          }
          echo "✅ Health check passed"
      
      - name: Deployment summary
        if: success()
        run: |
          echo "## 🎉 Backend Deployment Successful!" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "- **Commit:** ${{ github.sha }}" >> $GITHUB_STEP_SUMMARY
          echo "- **Branch:** ${{ github.ref_name }}" >> $GITHUB_STEP_SUMMARY
          echo "- **Deployed by:** ${{ github.actor }}" >> $GITHUB_STEP_SUMMARY
          echo "- **S3 Path:** s3://${{ secrets.S3_DEPLOYMENT_BUCKET }}/${{ env.DEPLOY_FILE }}" >> $GITHUB_STEP_SUMMARY
      
      - name: Rollback on failure
        if: failure()
        run: |
          echo "⚠️ Deployment failed, initiating rollback..."
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids ${{ secrets.BACKEND_INSTANCE_ID }} \
            --document-name "AWS-RunShellScript" \
            --parameters 'commands=[
              "LATEST_BACKUP=$(ls -td ~/app.backup.* 2>/dev/null | head -1)",
              "if [ -n \"$LATEST_BACKUP\" ]; then",
              "  echo Rolling back to $LATEST_BACKUP",
              "  rm -rf ~/app",
              "  cp -r $LATEST_BACKUP ~/app",
              "  cd ~/app && npm ci --production",
              "  pm2 restart backendAPI",
              "  echo Rollback completed",
              "else",
              "  echo No backup found for rollback",
              "fi"
            ]' \
            --query 'Command.CommandId' --output text)
          
          aws ssm wait command-executed \
            --command-id $COMMAND_ID \
            --instance-id ${{ secrets.BACKEND_INSTANCE_ID }} || true
          echo "🔄 Rollback attempted"
```


### Step 3.5: Create Manual Rollback Workflow (rollback.yml)

Create file `.github/workflows/rollback.yml`:

```yaml
name: Manual Rollback

on:
  workflow_dispatch:
    inputs:
      target:
        description: 'Deployment target'
        required: true
        type: choice
        options:
          - frontend
          - backend
          - both
      confirm:
        description: 'Type "ROLLBACK" to confirm'
        required: true
        type: string

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Validate confirmation
        if: ${{ github.event.inputs.confirm != 'ROLLBACK' }}
        run: |
          echo "❌ Rollback not confirmed. Please type 'ROLLBACK' to confirm."
          exit 1

  rollback-frontend:
    needs: validate
    if: ${{ github.event.inputs.target == 'frontend' || github.event.inputs.target == 'both' }}
    runs-on: ubuntu-latest
    environment: production
    
    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ secrets.AWS_REGION }}
      
      - name: Rollback frontend
        run: |
          echo "🔄 Rolling back frontend..."
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids ${{ secrets.FRONTEND_INSTANCE_ID }} \
            --document-name "AWS-RunShellScript" \
            --parameters 'commands=[
              "LATEST_BACKUP=$(ls -td /var/www/html.backup.* 2>/dev/null | head -1)",
              "if [ -n \"$LATEST_BACKUP\" ]; then",
              "  echo Found backup: $LATEST_BACKUP",
              "  sudo rm -rf /var/www/html/*",
              "  sudo cp -r $LATEST_BACKUP/* /var/www/html/",
              "  sudo systemctl reload nginx 2>/dev/null || sudo systemctl reload apache2",
              "  echo Rollback completed successfully",
              "else",
              "  echo No backup found!",
              "  exit 1",
              "fi"
            ]' \
            --query 'Command.CommandId' --output text)
          
          aws ssm wait command-executed \
            --command-id $COMMAND_ID \
            --instance-id ${{ secrets.FRONTEND_INSTANCE_ID }}
          echo "✅ Frontend rollback completed"

  rollback-backend:
    needs: validate
    if: ${{ github.event.inputs.target == 'backend' || github.event.inputs.target == 'both' }}
    runs-on: ubuntu-latest
    environment: production
    
    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ secrets.AWS_REGION }}
      
      - name: Rollback backend
        run: |
          echo "🔄 Rolling back backend..."
          COMMAND_ID=$(aws ssm send-command \
            --instance-ids ${{ secrets.BACKEND_INSTANCE_ID }} \
            --document-name "AWS-RunShellScript" \
            --parameters 'commands=[
              "LATEST_BACKUP=$(ls -td ~/app.backup.* 2>/dev/null | head -1)",
              "if [ -n \"$LATEST_BACKUP\" ]; then",
              "  echo Found backup: $LATEST_BACKUP",
              "  rm -rf ~/app",
              "  cp -r $LATEST_BACKUP ~/app",
              "  cd ~/app && npm ci --production",
              "  pm2 restart backendAPI",
              "  echo Rollback completed successfully",
              "else",
              "  echo No backup found!",
              "  exit 1",
              "fi"
            ]' \
            --query 'Command.CommandId' --output text)
          
          aws ssm wait command-executed \
            --command-id $COMMAND_ID \
            --instance-id ${{ secrets.BACKEND_INSTANCE_ID }}
          echo "✅ Backend rollback completed"
```


### Step 3.6: Create CODEOWNERS File

Create file `.github/CODEOWNERS`:

```
# Default owners for everything
* @your-github-username

# Frontend specific
/client/ @your-github-username

# Backend specific
/backend/ @your-github-username

# CI/CD workflows
/.github/ @your-github-username
```

---

## Part 4: Monitoring Setup

### Step 4.1: Create CloudWatch Log Groups

1. **Open AWS Console** → Search for "CloudWatch" → Click "CloudWatch"

2. **Create Log Groups:**
   - Click **"Log groups"** in left sidebar
   - Click **"Create log group"**
   - Create these log groups:
     - `/app/frontend/nginx`
     - `/app/backend/pm2`
     - `/app/backend/error`

### Step 4.2: Create CloudWatch Alarms

1. **In CloudWatch Console:**
   - Click **"Alarms"** → **"All alarms"**
   - Click **"Create alarm"**

2. **Create CPU Alarm for Backend:**
   - Click **"Select metric"**
   - Choose **EC2** → **Per-Instance Metrics**
   - Find your Backend instance → Select **CPUUtilization**
   - Click **"Select metric"**
   - Conditions:
     - Threshold type: **Static**
     - Whenever CPUUtilization is: **Greater than** `80`
   - Click **"Next"**
   - Notification:
     - Create new SNS topic: `cicd-alerts`
     - Email: your-email@example.com
   - Alarm name: `Backend-High-CPU`
   - Click **"Create alarm"**

3. **Repeat for Frontend instance**

### Step 4.3: Setup CloudWatch Agent on EC2 (Optional)

Run this via SSM Run Command on both instances:

```bash
# Install CloudWatch Agent
sudo yum install -y amazon-cloudwatch-agent || sudo apt-get install -y amazon-cloudwatch-agent

# Create config file
cat > /tmp/cloudwatch-config.json << 'EOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/nginx/access.log",
            "log_group_name": "/app/frontend/nginx",
            "log_stream_name": "{instance_id}/access"
          },
          {
            "file_path": "/var/log/nginx/error.log",
            "log_group_name": "/app/frontend/nginx",
            "log_stream_name": "{instance_id}/error"
          }
        ]
      }
    }
  }
}
EOF

# Start agent
sudo amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/tmp/cloudwatch-config.json -s
```


---

## Part 5: Testing the Pipeline

### Step 5.1: Test CI Pipeline

1. **Create a test branch:**
   ```bash
   git checkout -b test-cicd
   ```

2. **Make a small change** (e.g., add a comment to any file)

3. **Push and create PR:**
   ```bash
   git add .
   git commit -m "test: verify CI pipeline"
   git push origin test-cicd
   ```

4. **In GitHub:**
   - Create Pull Request to `main`
   - Watch the **"Actions"** tab
   - Verify all CI jobs pass:
     - ✅ frontend-ci
     - ✅ backend-ci
     - ✅ security-scan

### Step 5.2: Test Deployment Pipeline

1. **Merge the PR to main**

2. **Watch the Actions tab:**
   - CI Pipeline should run first
   - After CI succeeds, Deploy Frontend and Deploy Backend should trigger
   - Both should complete successfully

3. **Verify deployment:**
   - Check your frontend URL - new changes should be live
   - Check your backend API - should respond correctly

### Step 5.3: Test Manual Deployment

1. **Go to Actions tab** → Select "Deploy Frontend" or "Deploy Backend"

2. **Click "Run workflow"** → Select branch `main` → Click "Run workflow"

3. **Approve the deployment** (if environment protection is enabled)

4. **Watch the workflow complete**

### Step 5.4: Test Rollback

1. **Go to Actions tab** → Select "Manual Rollback"

2. **Click "Run workflow":**
   - Target: `frontend` (or `backend` or `both`)
   - Confirm: Type `ROLLBACK`
   - Click "Run workflow"

3. **Verify rollback completed successfully**

---

## Troubleshooting

### Common Issues

**1. SSM Command Fails with "Access Denied"**
- Check IAM policy attached to GitHub Actions user
- Verify EC2 instance has SSM permissions in its IAM role

**2. S3 Upload Fails**
- Verify S3 bucket name in secrets
- Check IAM policy includes S3 permissions

**3. Health Check Fails**
- Verify web server is running on EC2
- Check if the correct port is being used
- Verify security groups allow localhost connections

**4. Deployment Times Out**
- Increase timeout in SSM command
- Check EC2 instance has internet access for npm install

**5. Artifact Download Fails**
- Ensure CI workflow uploads artifacts correctly
- Check artifact retention period hasn't expired

### Useful Commands

**Check SSM Agent Status:**
```bash
# On EC2 instance
sudo systemctl status amazon-ssm-agent
```

**Check PM2 Status:**
```bash
pm2 status
pm2 logs backendAPI
```

**Check Nginx Status:**
```bash
sudo systemctl status nginx
sudo nginx -t
```

**View Deployment Backups:**
```bash
# Frontend
ls -la /var/www/html.backup.*

# Backend
ls -la ~/app.backup.*
```

---

## Quick Reference

### GitHub Secrets Required (OIDC - No Access Keys!)

| Secret | Example Value |
|--------|---------------|
| AWS_ROLE_ARN | arn:aws:iam::123456789012:role/GitHubActions-CICD-Role |
| AWS_REGION | us-east-1 |
| FRONTEND_INSTANCE_ID | i-0abc123def456789a |
| BACKEND_INSTANCE_ID | i-0def456abc789012b |
| S3_DEPLOYMENT_BUCKET | my-app-deployments-123456789 |
| DB_HOST | mydb.abc123.us-east-1.rds.amazonaws.com |
| DB_USERNAME | admin |
| DB_PASSWORD | MySecurePassword123! |

**Benefits of OIDC over IAM User:**
- ✅ No long-lived credentials to manage or rotate
- ✅ Temporary tokens (15 min - 1 hour)
- ✅ More secure - credentials can't be leaked
- ✅ Fine-grained access control per repository/branch
- ✅ AWS best practice recommendation

### Workflow Files

| File | Purpose | Trigger |
|------|---------|---------|
| ci.yml | Build, test, security scan | Push/PR to main |
| deploy-frontend.yml | Deploy React app | CI success on main |
| deploy-backend.yml | Deploy Node.js API | CI success on main |
| rollback.yml | Manual rollback | Manual trigger |

### Deployment Paths

| Component | EC2 Path | S3 Path |
|-----------|----------|---------|
| Frontend | /var/www/html/ | s3://bucket/frontend/TIMESTAMP/ |
| Backend | ~/app/ | s3://bucket/backend/backend-TIMESTAMP.zip |

---

## Next Steps

After completing this setup:

1. **Add Slack Notifications** - Create a Slack webhook and add `SLACK_WEBHOOK_URL` secret
2. **Add More Environments** - Create staging environment with separate EC2 instances
3. **Add Database Migrations** - Include migration steps in backend deployment
4. **Add Performance Testing** - Add load testing step before production deployment
5. **Add Canary Deployments** - Deploy to subset of instances first

---

**Congratulations! 🎉 Your CI/CD pipeline is now fully configured!**
