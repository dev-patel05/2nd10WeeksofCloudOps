# Simplified Automated RDS Failover - Console Guide

## Your Setup (Verified)

| Region | Backend DB_HOST | RDS Instance |
|--------|-----------------|--------------|
| us-east-1 | database-1.ci7wi2mgyqeg.us-east-1.rds.amazonaws.com | Primary |
| us-west-1 | mydbinstance.cpgqgqaywtvr.us-west-1.rds.amazonaws.com | Read Replica |

Since your us-west-1 backend already points to the read replica, Lambda only needs to **promote the replica** - no DNS updates needed!

---

## Architecture Flow

```
Primary RDS Fails
       │
       ▼
CloudWatch Alarm Triggers
       │
       ▼
SNS Sends to Lambda
       │
       ▼
Lambda Promotes Replica ← ONLY THIS STEP NEEDED
       │
       ▼
mydbinstance becomes writable
       │
       ▼
us-west-1 Backend works normally ✅
```

---

## Step 1: Create SNS Topic

1. Go to **AWS Console** → **SNS** → **Topics** (us-east-1)
2. Click **Create topic**
3. Type: **Standard**
4. Name: `rds-failover-alerts`
5. Click **Create topic**
6. Copy the **Topic ARN**

### Add Email Subscription

1. Click **Create subscription**
2. Protocol: **Email**
3. Endpoint: Your email address
4. Click **Create subscription**
5. Confirm via email link

---

## Step 2: Create IAM Role for Lambda

### 2.1 Create Policy

1. Go to **IAM** → **Policies** → **Create policy**
2. Click **JSON** tab
3. Paste:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "rds:PromoteReadReplica",
                "rds:DescribeDBInstances"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": "sns:Publish",
            "Resource": "*"
        },
        {
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

4. Name: `RDSFailoverPolicy`
5. Click **Create policy**

### 2.2 Create Role

1. Go to **IAM** → **Roles** → **Create role**
2. Trusted entity: **AWS service**
3. Use case: **Lambda**
4. Click **Next**
5. Search and select: `RDSFailoverPolicy`
6. Click **Next**
7. Role name: `RDSFailoverRole`
8. Click **Create role**

---

## Step 3: Create Lambda Function

### 3.1 Create Function

1. Go to **Lambda** → **Functions** (us-east-1)
2. Click **Create function**
3. Author from scratch
4. Name: `rds-failover-handler`
5. Runtime: **Python 3.12**
6. Expand **Change default execution role**
7. Select **Use an existing role**
8. Choose: `RDSFailoverRole`
9. Click **Create function**

### 3.2 Add Code

Replace the default code with:

```python
import boto3
import json
import os

def lambda_handler(event, context):
    """
    Simple RDS Failover - Just promotes the read replica
    No DNS update needed since backend already points to replica endpoint
    """
    
    REPLICA_ID = os.environ.get('REPLICA_IDENTIFIER', 'mydbinstance')
    REPLICA_REGION = os.environ.get('REPLICA_REGION', 'us-west-1')
    SNS_TOPIC = os.environ.get('SNS_TOPIC_ARN')
    
    rds = boto3.client('rds', region_name=REPLICA_REGION)
    sns = boto3.client('sns', region_name='us-east-1')
    
    print(f"Failover triggered for replica: {REPLICA_ID}")
    
    try:
        # Check if this is an actual alarm
        if 'Records' in event:
            message = json.loads(event['Records'][0]['Sns']['Message'])
            if message.get('NewStateValue') != 'ALARM':
                print("Not an alarm state, skipping")
                return {'statusCode': 200, 'body': 'Skipped - not alarm'}
        
        # Check replica status
        response = rds.describe_db_instances(DBInstanceIdentifier=REPLICA_ID)
        db_info = response['DBInstances'][0]
        
        # Check if already promoted (no source = already primary)
        if not db_info.get('ReadReplicaSourceDBInstanceIdentifier'):
            print("Already promoted, skipping")
            sns.publish(
                TopicArn=SNS_TOPIC,
                Subject='RDS Failover - Already Promoted',
                Message=f'{REPLICA_ID} is already a primary database.'
            )
            return {'statusCode': 200, 'body': 'Already promoted'}
        
        # Promote the replica
        print(f"Promoting {REPLICA_ID}...")
        rds.promote_read_replica(
            DBInstanceIdentifier=REPLICA_ID,
            BackupRetentionPeriod=7
        )
        
        # Wait for promotion
        print("Waiting for promotion to complete...")
        waiter = rds.get_waiter('db_instance_available')
        waiter.wait(
            DBInstanceIdentifier=REPLICA_ID,
            WaiterConfig={'Delay': 30, 'MaxAttempts': 40}
        )
        
        # Get endpoint for notification
        response = rds.describe_db_instances(DBInstanceIdentifier=REPLICA_ID)
        endpoint = response['DBInstances'][0]['Endpoint']['Address']
        
        # Send success notification
        sns.publish(
            TopicArn=SNS_TOPIC,
            Subject='✅ RDS Failover Complete',
            Message=f'''RDS Failover completed successfully!

Promoted: {REPLICA_ID}
Endpoint: {endpoint}
Region: {REPLICA_REGION}

The us-west-1 backend is already configured to use this endpoint.
No further action required.

Next steps:
1. Verify application is working
2. Plan failback when us-east-1 recovers
'''
        )
        
        print(f"Failover complete. Endpoint: {endpoint}")
        return {'statusCode': 200, 'body': f'Promoted {REPLICA_ID}'}
        
    except Exception as e:
        print(f"Failover failed: {str(e)}")
        sns.publish(
            TopicArn=SNS_TOPIC,
            Subject='❌ RDS Failover FAILED',
            Message=f'''RDS Failover failed!

Error: {str(e)}
Replica: {REPLICA_ID}

MANUAL ACTION REQUIRED:
1. Go to RDS Console
2. Select {REPLICA_ID} in {REPLICA_REGION}
3. Actions → Promote read replica
'''
        )
        raise e
```

3. Click **Deploy**

### 3.3 Configure Environment Variables

1. Go to **Configuration** → **Environment variables**
2. Click **Edit**
3. Add:

| Key | Value |
|-----|-------|
| REPLICA_IDENTIFIER | mydbinstance |
| REPLICA_REGION | us-west-1 |
| SNS_TOPIC_ARN | arn:aws:sns:us-east-1:101645635382:rds-failover-alerts |

4. Click **Save**

### 3.4 Configure Timeout

1. Go to **Configuration** → **General configuration**
2. Click **Edit**
3. Timeout: **15 minutes** (900 seconds)
4. Memory: **256 MB**
5. Click **Save**

### 3.5 Add SNS Trigger

1. Go to **Configuration** → **Triggers**
2. Click **Add trigger**
3. Select **SNS**
4. Topic: `rds-failover-alerts`
5. Click **Add**

---

## Step 4: Create CloudWatch Alarm

1. Go to **CloudWatch** → **Alarms** (us-east-1)
2. Click **Create alarm**
3. Click **Select metric**
4. Choose **RDS** → **Per-Database Metrics**
5. Search for `database-1`
6. Select **DatabaseConnections**
7. Click **Select metric**

### Configure Alarm

1. Statistic: **Average**
2. Period: **1 minute**
3. Threshold: **Static**
4. Condition: **Lower/Equal** than **0**
5. Click **Next**

### Configure Actions

1. Alarm state: **In alarm**
2. SNS topic: `rds-failover-alerts`
3. Click **Next**

### Name Alarm

1. Name: `RDS-Primary-Down`
2. Click **Create alarm**

---

## Step 5: Test (Optional)

### Test Lambda Manually

1. Go to Lambda → `rds-failover-handler`
2. Click **Test**
3. Create event:

```json
{
  "Records": [{
    "Sns": {
      "Message": "{\"NewStateValue\": \"OK\"}"
    }
  }]
}
```

4. Click **Test**
5. Should show "Skipped - not alarm" (safe test)

⚠️ **Warning:** Testing with `"NewStateValue": "ALARM"` will actually promote your replica!

---

## How It Works

1. **Primary RDS fails** → No database connections
2. **CloudWatch detects** → DatabaseConnections = 0 for 2 minutes
3. **Alarm triggers** → Sends to SNS
4. **SNS invokes Lambda**
5. **Lambda promotes replica** → mydbinstance becomes writable
6. **us-west-1 backend works** → Already configured with correct endpoint
7. **Email notification sent** → You know failover happened

---

## Summary

Your setup is already well-designed! The Lambda function only needs to:
- ✅ Promote the read replica
- ✅ Send notification

It does NOT need to:
- ❌ Update Route 53 for database
- ❌ Update backend configuration
- ❌ Restart any services

Because your us-west-1 backend already has `DB_HOST=mydbinstance.cpgqgqaywtvr.us-west-1.rds.amazonaws.com` configured in the Launch Template!
