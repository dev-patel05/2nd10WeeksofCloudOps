# Implementation Plan: GitHub Actions CI/CD Pipeline

## Overview

This implementation plan covers setting up a complete CI/CD pipeline using GitHub Actions with AWS SSM for deployment to EC2 instances in private subnets. The pipeline includes security scanning, code quality gates, automated deployments, and CloudWatch monitoring.

## Prerequisites

Before starting, ensure you have:
- AWS account with appropriate permissions
- GitHub repository with admin access
- EC2 instances with SSM Agent installed and running
- S3 bucket for deployment artifacts
- IAM user/role for GitHub Actions

## Tasks

- [ ] 1. AWS Infrastructure Setup
  - [ ] 1.1 Create S3 bucket for deployment artifacts
    - Create bucket with versioning enabled
    - Configure lifecycle rules to delete old artifacts after 30 days
    - _Requirements: 5.3, 6.2_
  
  - [ ] 1.2 Create IAM user for GitHub Actions
    - Create IAM user with programmatic access
    - Attach policy for SSM, S3, and CloudWatch permissions
    - Generate access keys for GitHub Secrets
    - _Requirements: 1.2_
  
  - [ ] 1.3 Verify EC2 SSM Agent configuration
    - Confirm SSM Agent is running on both EC2 instances
    - Verify EC2 instance IAM role has SSM permissions
    - Test SSM connectivity with a simple command
    - _Requirements: 1.1, 1.3, 1.4_

- [ ] 2. GitHub Repository Configuration
  - [ ] 2.1 Configure GitHub Secrets
    - Add AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
    - Add FRONTEND_INSTANCE_ID, BACKEND_INSTANCE_ID
    - Add S3_DEPLOYMENT_BUCKET
    - Add DB_HOST, DB_USERNAME, DB_PASSWORD
    - Add API_BASE_URL
    - _Requirements: 2.1, 2.3_
  
  - [ ] 2.2 Create GitHub Environment for production
    - Create "production" environment
    - Configure environment protection rules (manual approval)
    - Add environment-specific secrets if needed
    - _Requirements: 11.1, 11.2, 11.3_
  
  - [ ] 2.3 Configure branch protection rules
    - Require status checks to pass before merging
    - Require pull request reviews
    - Prevent force pushes to main
    - _Requirements: 7.1, 7.2, 13.4, 13.5_

- [ ] 3. Create CI Workflow
  - [ ] 3.1 Create `.github/workflows/ci.yml` with frontend CI job
    - Checkout, Node.js setup, npm ci, lint, test with coverage, build
    - Upload build artifact
    - Configure npm caching
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 10.1, 10.2, 10.3_
  
  - [ ] 3.2 Add backend CI job to ci.yml
    - Checkout, Node.js setup, npm ci, lint, validate config
    - Configure npm caching
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  
  - [ ] 3.3 Add security scanning job to ci.yml
    - npm audit for both frontend and backend
    - Gitleaks for secret detection
    - CodeQL for SAST
    - License compliance check
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_
  
  - [ ] 3.4 Add code quality job to ci.yml
    - SonarCloud integration
    - Code coverage upload to Codecov
    - _Requirements: 12.6, 13.1, 13.2, 13.3_

- [ ] 4. Checkpoint - Verify CI Pipeline
  - Run CI pipeline on a test branch
  - Verify all jobs complete successfully
  - Check artifacts are uploaded correctly
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Create Frontend Deployment Workflow
  - [ ] 5.1 Create `.github/workflows/deploy-frontend.yml`
    - Configure workflow_run trigger on CI success
    - Add workflow_dispatch for manual deployments
    - Configure concurrency to prevent parallel deployments
    - _Requirements: 5.1, 7.3, 7.4, 7.5_
  
  - [ ] 5.2 Add artifact download and S3 upload steps
    - Download build artifact from CI
    - Configure AWS credentials
    - Upload to S3 deployment bucket
    - _Requirements: 5.2, 5.3_
  
  - [ ] 5.3 Add SSM deployment steps for frontend
    - Backup current deployment via SSM
    - Deploy new build via SSM (S3 sync, copy to /var/www/html, reload Nginx)
    - _Requirements: 5.4, 5.5, 5.6, 5.7_
  
  - [ ] 5.4 Add health check and rollback steps for frontend
    - Health check via SSM (curl localhost)
    - Automatic rollback on failure
    - _Requirements: 5.8, 9.1, 9.3, 9.4_

- [ ] 6. Create Backend Deployment Workflow
  - [ ] 6.1 Create `.github/workflows/deploy-backend.yml`
    - Configure workflow_run trigger on CI success
    - Add workflow_dispatch for manual deployments
    - Configure concurrency to prevent parallel deployments
    - _Requirements: 6.1, 7.3, 7.4, 7.5_
  
  - [ ] 6.2 Add code packaging and S3 upload steps
    - Checkout code
    - Configure AWS credentials
    - Zip backend code (exclude node_modules, .env)
    - Upload to S3 deployment bucket
    - _Requirements: 6.2_
  
  - [ ] 6.3 Add SSM deployment steps for backend
    - Backup current deployment via SSM
    - Deploy new code via SSM (download from S3, unzip, preserve .env, npm ci, PM2 restart)
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 6.7_
  
  - [ ] 6.4 Add health check and rollback steps for backend
    - Health check via SSM (curl /books endpoint)
    - Automatic rollback on failure
    - _Requirements: 6.8, 9.2, 9.3, 9.4_

- [ ] 7. Checkpoint - Verify Deployment Pipelines
  - Trigger frontend deployment manually
  - Trigger backend deployment manually
  - Verify backups are created
  - Verify health checks pass
  - Test rollback by simulating failure
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Add Notifications
  - [ ] 8.1 Add Slack notification to deployment workflows
    - Configure Slack webhook in GitHub Secrets
    - Add notification step with deployment metadata (commit, branch, status)
    - Send on both success and failure
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 9. Setup CloudWatch Monitoring
  - [ ] 9.1 Create CloudWatch Agent configuration script
    - Configure log collection for PM2 logs
    - Configure custom metrics (CPU, memory)
    - Add to deployment workflow to run via SSM
    - _Requirements: 14.1, 14.3_
  
  - [ ] 9.2 Create CloudWatch Alarms
    - Create alarm for high CPU (>80%)
    - Create alarm for health check failures
    - Configure SNS topic for alerts
    - _Requirements: 14.2, 14.6_

- [ ] 10. Create Manual Rollback Workflow
  - [ ] 10.1 Create `.github/workflows/rollback.yml`
    - Add workflow_dispatch trigger with environment input
    - Add target selection (frontend/backend)
    - Implement rollback logic via SSM
    - _Requirements: 5.8, 6.8_

- [ ] 11. Add Supporting Files
  - [ ] 11.1 Create `.github/CODEOWNERS` file
    - Define code ownership for frontend, backend, and CI/CD files
    - _Requirements: 13.6_
  
  - [ ] 11.2 Add ESLint configuration to frontend (if missing)
    - Create `.eslintrc.json` with React rules
    - Add lint script to package.json
    - _Requirements: 3.3_
  
  - [ ] 11.3 Add ESLint configuration to backend (if missing)
    - Create `.eslintrc.json` with Node.js rules
    - Add lint script to package.json
    - _Requirements: 4.3_

- [ ] 12. Final Checkpoint - End-to-End Testing
  - Create a test PR to main branch
  - Verify CI runs and all checks pass
  - Merge PR and verify deployment triggers
  - Verify frontend and backend are deployed
  - Verify Slack notifications are received
  - Verify CloudWatch logs are being collected
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- SSM commands may take 30-60 seconds to complete; workflows include appropriate waits
- Rollback relies on backups created during deployment; ensure backup step succeeds before proceeding
