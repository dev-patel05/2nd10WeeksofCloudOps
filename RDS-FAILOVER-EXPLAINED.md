# RDS Failover - Explained

## What is RDS Failover?

Failover is the process of switching database operations from a failed primary database to a standby or replica database. In your setup, when the primary RDS in us-east-1 becomes unavailable, you need to promote the read replica in us-west-1 to become the new primary.

---

## Your Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         NORMAL STATE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   us-east-1 (Primary)              us-west-1 (Secondary)        │
│   ┌─────────────────┐              ┌─────────────────┐          │
│   │   database-1    │  ──────────▶ │  mydbinstance   │          │
│   │   (PRIMARY)     │   Async      │  (READ REPLICA) │          │
│   │   Read + Write  │   Replication│   Read Only     │          │
│   └─────────────────┘              └─────────────────┘          │
│          ▲                                                      │
│          │                                                      │
│   ┌──────┴──────┐                                               │
│   │   Backend   │                                               │
│   │   Service   │                                               │
│   └─────────────┘                                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Why Failover is Needed

When the primary database fails due to:
- Hardware failure
- Network issues
- Region-wide AWS outage
- Maintenance gone wrong

Your application cannot write data, and users experience errors. Failover restores service by making the replica the new primary.

---

## Approach 1: Manual Promote Read Replica

### How It Works

This is the simplest approach where you manually promote the read replica to become a standalone primary database.

**Before Failover:**
- database-1 (us-east-1) = Primary, handles all reads and writes
- mydbinstance (us-west-1) = Read Replica, receives async replication from primary

**What Happens During Promotion:**
1. AWS breaks the replication link between primary and replica
2. The replica becomes a standalone database instance
3. The replica is now writable (no longer read-only)
4. The replica gets its own backup configuration
5. The old primary (if still exists) is now isolated

**After Failover:**
- database-1 (us-east-1) = Dead/Isolated
- mydbinstance (us-west-1) = New Primary, handles all reads and writes

**What You Need to Do:**
1. Detect that primary is down
2. Run the promote command in AWS Console or CLI
3. Wait 5-10 minutes for promotion to complete
4. Update your backend to connect to the new endpoint
5. Restart backend services

**Pros:**
- Simple to understand and execute
- Full control over when failover happens
- No additional infrastructure needed

**Cons:**
- Requires manual intervention (someone needs to be awake)
- Takes 15-30 minutes total
- Need to update backend configuration manually

---

## Approach 2: Route 53 CNAME for Database

### How It Works

Instead of your backend connecting directly to the RDS endpoint, it connects to a DNS name that you control. When failover happens, you update the DNS to point to the new database.

**Setup:**
- Create a DNS record: db.internal.pateldev.in
- Point it to: database-1.ci7wi2mgyqeg.us-east-1.rds.amazonaws.com
- Backend connects to: db.internal.pateldev.in (not the direct RDS endpoint)

**Before Failover:**
```
Backend → db.internal.pateldev.in → database-1 (us-east-1)
```

**After Failover:**
```
Backend → db.internal.pateldev.in → mydbinstance (us-west-1)
```

**What Happens:**
1. Primary fails
2. You promote the replica (same as Approach 1)
3. You update the DNS record to point to new endpoint
4. Backend automatically connects to new database (within DNS TTL, usually 60 seconds)
5. No backend restart needed

**Pros:**
- No backend code changes or restarts needed
- Faster failover (just DNS update after promotion)
- Centralized endpoint management

**Cons:**
- Need to set up private hosted zone
- DNS propagation delay (60 seconds with low TTL)
- Additional Route 53 cost (minimal)

---

## Approach 3: AWS Secrets Manager

### How It Works

Store your database connection details in AWS Secrets Manager. When failover happens, update the secret with the new endpoint. Backend reads from Secrets Manager.

**Setup:**
- Create a secret containing: host, username, password, port
- Backend reads connection details from Secrets Manager at startup

**Before Failover:**
```
Secret contains: host = database-1.xxx.us-east-1.rds.amazonaws.com
Backend reads secret → connects to us-east-1
```

**After Failover:**
```
Secret updated: host = mydbinstance.xxx.us-west-1.rds.amazonaws.com
Backend reads secret → connects to us-west-1
```

**What Happens:**
1. Primary fails
2. You promote the replica
3. You update the secret with new endpoint
4. Backend needs to restart or refresh its cached credentials

**Pros:**
- Secure credential management
- Audit trail for all changes
- Can replicate secrets across regions

**Cons:**
- Requires backend code changes to use Secrets Manager SDK
- May need restart unless you implement secret refresh
- Additional AWS cost

---

## Approach 4: Automated Failover with Lambda

### How It Works

CloudWatch monitors your RDS. When it detects the database is down, it triggers a Lambda function that automatically promotes the replica and updates DNS.

**Components:**
1. CloudWatch Alarm - monitors RDS health metrics
2. SNS Topic - receives alarm notifications
3. Lambda Function - executes failover steps
4. Route 53 - DNS record to update

**Flow:**
```
RDS Down → CloudWatch Alarm → SNS → Lambda → Promote Replica → Update DNS → Notify Admin
```

**What Happens:**
1. CloudWatch detects database connections = 0 for 2 minutes
2. Alarm triggers and sends message to SNS
3. SNS invokes Lambda function
4. Lambda promotes the read replica
5. Lambda waits for promotion to complete
6. Lambda updates Route 53 DNS record
7. Lambda sends notification to admin
8. Backend automatically reconnects via DNS

**Pros:**
- Fully automated, no human intervention needed
- Fastest recovery time (2-5 minutes)
- Works 24/7

**Cons:**
- Most complex to set up
- Risk of false positives (accidental failover)
- Requires thorough testing
- Lambda needs proper IAM permissions

---

## Comparison Summary

| Approach | Recovery Time | Complexity | Human Needed | Best For |
|----------|--------------|------------|--------------|----------|
| Manual Promote | 15-30 min | Low | Yes | Dev/Test environments |
| Route 53 CNAME | 5-10 min | Medium | Yes | Staging, small production |
| Secrets Manager | 10-15 min | Medium | Yes | Secure production |
| Lambda Automation | 2-5 min | High | No | Critical production |

---

## Important Considerations

### Data Loss Risk

With async replication, there's always a small window where data written to the primary hasn't reached the replica yet. When you failover:
- Any data not yet replicated is lost
- Typical lag is 1-5 seconds under normal conditions
- During high load, lag can be higher

### Replication Lag

Before failover, check the replication lag:
- If lag is 0 seconds: Safe to failover, no data loss
- If lag is high: Some recent data may be lost

### Application Behavior

Your backend needs to handle:
- Connection failures gracefully
- Reconnection attempts
- Possible duplicate transactions (if using retries)

### Cost Implications

After failover:
- You're now paying for a primary in us-west-1
- The old primary (if still running) is still costing money
- You need to create a new replica for DR capability
