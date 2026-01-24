# Multi-Region Resilient AWS Architecture with Automated Disaster Recovery

A production-ready 3-tier application deployed across multiple AWS regions with automated failover, CI/CD pipelines, and disaster recovery capabilities.

## Architecture

![Architecture of the application](architecture_diagram (1).png)

### Architecture Highlights

| Component | Primary (us-east-1) | Secondary (us-west-1) |
|-----------|---------------------|----------------------|
| Frontend | React app on EC2 (Nginx) | React app on EC2 (Nginx) |
| Backend | Node.js API on EC2 (PM2) | Node.js API on EC2 (PM2) |
| Database | RDS MySQL (Primary) | RDS MySQL (Read Replica) |
| Load Balancer | Application Load Balancer | Application Load Balancer |
| Auto Scaling | Frontend & Backend ASGs | Frontend & Backend ASGs |
| Networking | VPC with Private Subnets | VPC with Private Subnets |

### Key Features

- **Multi-Region Deployment:** Active-passive setup across us-east-1 and us-west-1
- **Route 53 Failover:** Automatic DNS failover when primary region is unhealthy
- **RDS Cross-Region Replication:** Asynchronous replication to read replica
- **Automated RDS Failover:** Lambda-based promotion of read replica
- **CI/CD Pipeline:** GitHub Actions for automated testing and deployment
- **Security:** Private subnets, security groups, no SSH (SSM only)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React |
| Backend | Node.js, Express |
| Database | MySQL (RDS) |
| Infrastructure | AWS (EC2, RDS, ALB, ASG, Route 53, Lambda, CloudWatch, SNS, S3) |
| CI/CD | GitHub Actions |
| Process Manager | PM2 |

---

## Project Structure

```
├── client/                     # React frontend application
│   ├── src/
│   │   └── pages/
│   │       └── config.js       # API endpoint configuration
│   └── package.json
├── backend/                    # Node.js backend API
│   ├── index.js                # Express server
│   ├── test.sql                # Database schema
│   └── package.json
├── .github/
│   └── workflows/
│       ├── ci.yml              # CI pipeline (test, lint, security scan)
│       ├── deploy-backend.yml  # Backend CD pipeline (deploy to both regions)
│       └── deploy-frontend.yml # Frontend CD pipeline (deploy to both regions)
└── README.md
```

---

## Local Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- MySQL Server or access to RDS

### Frontend Setup

```bash
cd client
npm install
```

Configure the API endpoint in `src/pages/config.js`:

```javascript
const API_BASE_URL = "http://localhost:80";  // Change to your backend URL
export default API_BASE_URL;
```

Build for production:

```bash
npm run build
```

The `build/` folder can be served via Nginx or Apache.

### Backend Setup

```bash
cd backend
npm install
```

Create `.env` file:

```bash
DB_HOST=localhost          # or RDS endpoint
DB_USERNAME=your_username
DB_PASSWORD=your_password
PORT=3306
```

Initialize the database:

```bash
mysql -h <HOST> -u <USER> -p<PASSWORD> -e "CREATE DATABASE test;"
mysql -h <HOST> -u <USER> -p<PASSWORD> test < test.sql
```

Run with PM2:

```bash
npm install -g pm2
pm2 start index.js --name "backendAPI"
```

---

## AWS Deployment

### Infrastructure Components

1. **VPC Setup (Both Regions)**
   - Public subnets for ALB
   - Private subnets for EC2 instances
   - Regional NAT Gateway for outbound traffic

2. **EC2 Auto Scaling Groups**
   - Frontend ASG with Launch Template
   - Backend ASG with Launch Template
   - Instances pull code from S3 on boot

3. **Application Load Balancers**
   - Frontend ALB (port 80)
   - Backend ALB (port 80)
   - Health checks configured

4. **RDS MySQL**
   - Primary in us-east-1
   - Read Replica in us-west-1
   - Automated backups enabled

5. **Route 53**
   - Failover routing policy
   - Health checks on primary ALB

---

## CI/CD Pipeline

### Continuous Integration (ci.yml)

Triggers on push to `main` or `develop`:

- Change detection (only build what changed)
- Dependency installation
- Linting
- Testing
- Security scanning (npm audit, Gitleaks, CodeQL)
- Build artifacts

### Continuous Deployment

**Backend (deploy-backend.yml)** - Triggers on push to `main`:

- Package application
- Upload to S3
- Deploy to both regions in parallel
- SSM-based deployment (no SSH)
- Health checks after deployment

**Frontend (deploy-frontend.yml)** - Triggers on push to `main`:

- Build React application
- Upload to S3
- Deploy to both regions in parallel
- Sync to Nginx html directory via SSM
- Health checks after deployment

---

## Automated RDS Failover

When the primary RDS becomes unavailable:

1. **CloudWatch Alarm** detects ALB health check fails for both frontend and backend
2. **SNS** triggers Lambda function
3. **Lambda** promotes read replica to standalone primary
4. **Lambda** enables Multi-AZ on new primary
5. **SNS** sends notification email

The us-west-1 backend already has the replica endpoint configured, so no DNS update is needed!

---

## Credits

This project was inspired by [Ankit Joshipura's](https://github.com/AnkitJoshipura) architecture from the **#10WeeksOfCloudOps** challenge organized by [Piyush Sachdeva](https://github.com/piyushsachdeva).

### My Enhancements

- CI/CD pipeline with GitHub Actions
- Automated RDS failover using Lambda
- Multi-AZ conversion on failover
- S3-based deployment for Auto Scaling compatibility
- Security scanning in CI pipeline
- Failback strategy documentation

---

## License

This project is for educational purposes.

---

**Thank you for reading!**
