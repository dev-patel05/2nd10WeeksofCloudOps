# Automated RDS Failover with Lambda - Console Step-by-Step Guide

## Overview

This guide walks you through setting up automated RDS failover using AWS Console. When your primary RDS in us-east-1 goes down, CloudWatch will detect it and trigger a Lambda function that automatically promotes your read replica in us-west-1.

## Architecture Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ CloudWatch  │────▶│    SNS      │────▶│   Lambda    │────▶│  Promote    │
│   Alarm     │     │   Topic     │     │  Function   │     │  Replica    │
│ (RDS Down)  │     │             │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘     └──────┬──────┘
                                                                    │
                                                                    ▼
┌─────────────┐     ┌─────────────┐                          ┌─────────────┐
│   Email     │◀────│    SNS      │◀─────────────────────────│  Update     │
│   Alert     │     │  Notify     │                          │  Route 53   │
└─────────────┘     └─────────────┘                          └─────────────┘
```

---

## Prerequisites

Before starting, note down these values from your setup:
- Primary RDS Identifier: `database-1`
- Replica RDS Identifier: `mydbinstance`
- Primary Region: `us-east-1`
- Secondary Region: `us-west-1`
- Route 53 Hosted Zone ID: `Z080780511VSH9VU9VE8I`

---

## Step 1: Create SNS Topic for Alerts

SNS will receive CloudWatch alarms and trigger Lambda.

### 1.1 Create SNS Topic

1. Go to **AWS Console** → **SNS** → **Topics**
2. Click **Create topic**
3. Select **Standard** type
4. Name: `rds-failover-alerts`
5. Display name: `RDS Failover Alerts`
6. Click **Create topic**
7. **Copy the Topic ARN** (you'll need this later)
   - Example: `arn:aws:sns:us-east-1:101645635382:rds-failover-alerts`

### 1.2 Create Email Subscription

1. On the topic page, click **Create subscription**
2. Protocol: **Email**
3. Endpoint: Enter your email address
4. Click **Create subscription**
5. **Check your email** and click the confirmation link

---

## Step 2: Create IAM Role for Lambda

Lambda needs permissions to promote RDS, update Route 53, and publish to SNS.

### 2.1 Create IAM Policy

1. Go to **AWS Console** → **IAM** → **Policies**
2. Click **Create policy**
3. Click **JSON** tab
4. Paste this policy:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "RDSPermissions",
            "Effect": "Allow",
            "Action": [
                "rds:PromoteReadReplica",
                "rds:DescribeDBInstances"
            ],
            "Resource": "*"
        },
        {
            "Sid": "Route53Permissions",
            "Effect": "Allow",
            "Action": [
                "route53:ChangeResourceRecordSets",
                "route53:GetHostedZone"
            ],
            "Resource": "arn:aws:route53:::hostedzone/Z080780511VSH9VU9VE8I"
        },
        {
            "Sid": "SNSPermissions",
            "Effect": "Allow",
            "Action": [
                "sns:Publish"
            ],
            "Resource": "*"
        },
        {
            "Sid": "CloudWatchLogs",
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ],
            "Resource": "*"
        }
    ]
}
```

5. Click **Next**
6. Policy name: `RDSFailoverLambdaPolicy`
7. Click **Create policy**

### 2.2 Create IAM Role

1. Go to **IAM** → **Roles**
2. Click **Create role**
3. Trusted entity type: **AWS service**
4. Use case: **Lambda**
5. Click **Next**
6. Search and select: `RDSFailoverLambdaPolicy`
7. Click **Next**
8. Role name: `RDSFailoverLambdaRole`
9. Click **Create role**

---

## Step 3: Create Route 53 Private Hosted Zone (Optional but Recommended)

This creates a DNS name for your database so Lambda can update it during failover.

### 3.1 Create Private Hosted Zone

1. Go to **AWS Console** → **Route 53** → **Hosted zones**
2. Click **Create hosted zone**
3. Domain name: `internal.pateldev.in`
4. Type: **Private hosted zone**
5. Region: `us-east-1`
6. VPC ID: Select your VPC in us-east-1
7. Click **Create hosted zone**
8. **Copy the Hosted Zone ID** (starts with Z...)

### 3.2 Associate with us-west-1 VPC

1. On the hosted zone page, click **Edit**
2. Under VPCs, click **Add VPC**
3. Region: `us-west-1`
4. VPC ID: Select your VPC in us-west-1
5. Click **Save changes**

### 3.3 Create Database CNAME Record

1. Click **Create record**
2. Record name: `db` (this creates db.internal.pateldev.in)
3. Record type: **CNAME**
4. Value: `database-1.ci7wi2mgyqeg.us-east-1.rds.amazonaws.com`
5. TTL: `60` seconds
6. Click **Create records**

### 3.4 Update Backend Configuration

Update your backend .env file:
```
DB_HOST=db.internal.pateldev.in
```

---

## Step 4: Create Lambda Function

### 4.1 Create Function

1. Go to **AWS Console** → **Lambda** → **Functions**
2. Click **Create function**
3. Select **Author from scratch**
4. Function name: `rds-failover-handler`
5. Runtime: **Python 3.12**
6. Architecture: **x86_64**
7. Expand **Change default execution role**
8. Select **Use an existing role**
9. Choose: `RDSFailoverLambdaRole`
10. Click **Create function**

### 4.2 Add Function Code

1. In the Code tab, replace the default code with:

```python
import boto3
import json
import os
import time

def lambda_handler(event, context):
    """
    Automated RDS Failover Handler
    Triggered by CloudWatch Alarm via SNS
    """
    
    # Configuration - UPDATE THESE VALUES
    REPLICA_IDENTIFIER = os.environ.get('REPLICA_IDENTIFIER', 'mydbinstance')
    REPLICA_REGION = os.environ.get('REPLICA_REGION', 'us-west-1')
    HOSTED_ZONE_ID = os.environ.get('HOSTED_ZONE_ID', 'YOUR_PRIVATE_ZONE_ID')
    DB_CNAME = os.environ.get('DB_CNAME', 'db.internal.pateldev.in')
    SNS_TOPIC_ARN = os.environ.get('SNS_TOPIC_ARN', 'arn:aws:sns:us-east-1:101645635382:rds-failover-alerts')
    
    # Initialize clients
    rds = boto3.client('rds', region_name=REPLICA_REGION)
    route53 = boto3.client('route53')
    sns = boto3.client('sns', region_name='us-east-1')
    
    print(f"Failover triggered. Event: {json.dumps(event)}")
    
    try:
        # Step 1: Check if this is actually an alarm (not a test)
        if 'Records' in event:
            message = json.loads(event['Records'][0]['Sns']['Message'])
            alarm_state = message.get('NewStateValue', '')
            if alarm_state != 'ALARM':
                print(f"Not an alarm state: {alarm_state}. Skipping.")
                return {'statusCode': 200, 'body': 'Not an alarm, skipping'}
        
        # Step 2: Check replica status before promoting
        print(f"Checking replica status: {REPLICA_IDENTIFIER}")
        response = rds.describe_db_instances(DBInstanceIdentifier=REPLICA_IDENTIFIER)
        replica_status = response['DBInstances'][0]['DBInstanceStatus']
        
        if replica_status != 'available':
            raise Exception(f"Replica not available. Status: {replica_status}")
        
        # Check if already promoted (no source = already primary)
        source = response['DBInstances'][0].get('ReadReplicaSourceDBInstanceIdentifier')
        if not source:
            print("Replica already promoted. Skipping promotion.")
        else:
            # Step 3: Promote read replica
            print(f"Promoting replica: {REPLICA_IDENTIFIER}")
            rds.promote_read_replica(
                DBInstanceIdentifier=REPLICA_IDENTIFIER,
                BackupRetentionPeriod=7
            )
            
            # Step 4: Wait for promotion to complete
            print("Waiting for promotion to complete...")
            waiter = rds.get_waiter('db_instance_available')
            waiter.wait(
                DBInstanceIdentifier=REPLICA_IDENTIFIER,
                WaiterConfig={'Delay': 30, 'MaxAttempts': 40}
            )
        
        # Step 5: Get new endpoint
        response = rds.describe_db_instances(DBInstanceIdentifier=REPLICA_IDENTIFIER)
        new_endpoint = response['DBInstances'][0]['Endpoint']['Address']
        print(f"New endpoint: {new_endpoint}")
        
        # Step 6: Update Route 53 (if configured)
        if HOSTED_ZONE_ID and HOSTED_ZONE_ID != 'YOUR_PRIVATE_ZONE_ID':
            print(f"Updating Route 53: {DB_CNAME} -> {new_endpoint}")
            route53.change_resource_record_sets(
                HostedZoneId=HOSTED_ZONE_ID,
                ChangeBatch={
                    'Changes': [{
                        'Action': 'UPSERT',
                        'ResourceRecordSet': {
                            'Name': DB_CNAME,
                            'Type': 'CNAME',
                            'TTL': 60,
                            'ResourceRecords': [{'Value': new_endpoint}]
                        }
                    }]
                }
            )
            print("Route 53 updated successfully")
        
        # Step 7: Send success notification
        success_message = f"""
RDS FAILOVER COMPLETED SUCCESSFULLY

Replica Promoted: {REPLICA_IDENTIFIER}
New Endpoint: {new_endpoint}
Region: {REPLICA_REGION}
DNS Updated: {DB_CNAME}

Action Required:
1. Verify application connectivity
2. Monitor for any issues
3. Plan failback when primary region recovers
        """
        
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject='✅ RDS Failover Completed Successfully',
            Message=success_message
        )
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Failover completed',
                'new_endpoint': new_endpoint
            })
        }
        
    except Exception as e:
        # Send failure notification
        error_message = f"""
RDS FAILOVER FAILED

Error: {str(e)}
Replica: {REPLICA_IDENTIFIER}
Region: {REPLICA_REGION}

IMMEDIATE ACTION REQUIRED:
1. Check AWS Console for RDS status
2. Manually promote replica if needed
3. Update DNS/backend configuration manually
        """
        
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject='❌ RDS Failover FAILED - Manual Action Required',
            Message=error_message
        )
        
        print(f"Failover failed: {str(e)}")
        raise e
```

2. Click **Deploy**

### 4.3 Configure Environment Variables

1. Go to **Configuration** tab → **Environment variables**
2. Click **Edit**
3. Add these variables:

| Key | Value |
|-----|-------|
| REPLICA_IDENTIFIER | mydbinstance |
| REPLICA_REGION | us-west-1 |
| HOSTED_ZONE_ID | (your private hosted zone ID from Step 3) |
| DB_CNAME | db.internal.pateldev.in |
| SNS_TOPIC_ARN | arn:aws:sns:us-east-1:101645635382:rds-failover-alerts |

4. Click **Save**

### 4.4 Configure Timeout

1. Go to **Configuration** tab → **General configuration**
2. Click **Edit**
3. Timeout: **15 minutes** (900 seconds) - promotion takes time
4. Memory: **256 MB**
5. Click **Save**

### 4.5 Add SNS Trigger

1. Go to **Configuration** tab → **Triggers**
2. Click **Add trigger**
3. Select **SNS**
4. SNS topic: `rds-failover-alerts`
5. Click **Add**

---

## Step 5: Create CloudWatch Alarm

This alarm monitors your primary RDS and triggers when it's unhealthy.

### 5.1 Create Alarm

1. Go to **AWS Console** → **CloudWatch** → **Alarms**
2. Click **Create alarm**
3. Click **Select metric**

### 5.2 Select Metric

1. Choose **RDS** → **Per-Database Metrics**
2. Search for `database-1`
3. Select **DatabaseConnections** metric
4. Click **Select metric**

### 5.3 Configure Conditions

1. Statistic: **Average**
2. Period: **1 minute**
3. Threshold type: **Static**
4. Whenever DatabaseConnections is: **Lower/Equal** than **0**
5. Click **Next**

### 5.4 Configure Actions

1. Alarm state trigger: **In alarm**
2. Select an SNS topic: **Select an existing SNS topic**
3. Choose: `rds-failover-alerts`
4. Click **Next**

### 5.5 Name and Create

1. Alarm name: `RDS-Primary-Database-Down`
2. Alarm description: `Triggers failover when primary RDS has no connections for 2 minutes`
3. Click **Next**
4. Review and click **Create alarm**

---

## Step 6: Test the Setup

### 6.1 Test Lambda Function Manually

1. Go to **Lambda** → **rds-failover-handler**
2. Click **Test** tab
3. Create test event with this JSON:

```json
{
  "Records": [
    {
      "Sns": {
        "Message": "{\"NewStateValue\": \"ALARM\", \"AlarmName\": \"Test\"}"
      }
    }
  ]
}
```

4. Click **Test**
5. Check the execution result and CloudWatch logs

**Note:** This will actually promote your replica! Only test if you're ready for failover.

### 6.2 Test SNS to Lambda Connection

1. Go to **SNS** → **rds-failover-alerts**
2. Click **Publish message**
3. Subject: `Test`
4. Message: `{"NewStateValue": "OK", "AlarmName": "Test"}`
5. Click **Publish message**
6. Check Lambda CloudWatch logs - should show "Not an alarm, skipping"

---

## Step 7: Verify Everything is Connected

### Checklist

- [ ] SNS Topic created with email subscription confirmed
- [ ] IAM Role created with correct permissions
- [ ] Lambda function created and deployed
- [ ] Lambda environment variables configured
- [ ] Lambda timeout set to 15 minutes
- [ ] Lambda has SNS trigger attached
- [ ] CloudWatch alarm created for RDS
- [ ] CloudWatch alarm sends to SNS topic
- [ ] (Optional) Route 53 private hosted zone created
- [ ] (Optional) Backend updated to use DNS name

---

## How It Works in Production

1. **Primary RDS fails** → DatabaseConnections drops to 0
2. **CloudWatch detects** → After 2 data points (2 minutes), alarm triggers
3. **SNS receives alarm** → Forwards to Lambda
4. **Lambda executes**:
   - Verifies it's a real alarm
   - Checks replica is available
   - Promotes replica to primary
   - Waits for promotion (5-10 minutes)
   - Updates Route 53 DNS
   - Sends success/failure email
5. **Backend reconnects** → Via DNS, connects to new primary

---

## Troubleshooting

### Lambda Times Out
- Increase timeout to 15 minutes
- Check if replica is in correct state

### Permission Denied Errors
- Verify IAM role has all required permissions
- Check Route 53 hosted zone ID is correct

### Alarm Not Triggering
- Verify alarm is monitoring correct RDS instance
- Check alarm threshold and period settings

### DNS Not Updating
- Verify hosted zone ID in environment variables
- Check Route 53 permissions in IAM policy

---

## Next Steps

After setting up automated failover, you should:

1. **Document the process** for your team
2. **Set up monitoring** for the Lambda function
3. **Plan failback procedure** (see RDS-FAILBACK-EXPLAINED.md)
4. **Test periodically** to ensure everything works
5. **Set up alerts** for Lambda failures
