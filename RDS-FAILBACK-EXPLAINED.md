# RDS Failback - Explained

## What is RDS Failback?

Failback is the process of returning database operations to the original primary region after a failover event. After your us-west-1 replica was promoted during failover, failback moves everything back to us-east-1.

---

## Why Failback is Important

1. **Cost Optimization** - Your original architecture was designed with us-east-1 as primary for a reason (lower latency, cost, compliance)
2. **Restore DR Capability** - After failover, you have no replica. Failback re-establishes your disaster recovery setup
3. **Performance** - Your application may perform better with the database in the original region
4. **Compliance** - Some regulations require data to reside in specific regions

---

## State After Failover

```
┌─────────────────────────────────────────────────────────────────┐
│                    AFTER FAILOVER STATE                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   us-east-1 (Original Primary)     us-west-1 (Current Primary)  │
│   ┌─────────────────┐              ┌─────────────────┐          │
│   │   database-1    │              │  mydbinstance   │          │
│   │   (DOWN/DEAD)   │              │  (NOW PRIMARY)  │          │
│   │   No longer     │              │   Read + Write  │          │
│   │   receiving     │              │   All traffic   │          │
│   │   replication   │              │   goes here     │          │
│   └─────────────────┘              └─────────────────┘          │
│                                           ▲                     │
│                                           │                     │
│                                    ┌──────┴──────┐              │
│                                    │   Backend   │              │
│                                    │   Service   │              │
│                                    └─────────────┘              │
│                                                                 │
│   ⚠️ NO DISASTER RECOVERY - If us-west-1 fails, you're down!   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Approach 1: Create New Replica and Promote

### How It Works

This is the cleanest approach. You create a fresh read replica in us-east-1 from the current primary in us-west-1, wait for it to sync, then promote it.

**Step-by-Step Process:**

**Phase 1: Create Replica in Original Region**
```
us-west-1 (Primary)                  us-east-1 (New Replica)
┌─────────────────┐                  ┌─────────────────┐
│  mydbinstance   │  ──────────────▶ │ database-1-new  │
│  (PRIMARY)      │   Cross-region   │ (READ REPLICA)  │
│  Read + Write   │   Replication    │  Read Only      │
└─────────────────┘                  └─────────────────┘
```

What happens:
- AWS creates a snapshot of us-west-1 database
- Snapshot is copied to us-east-1
- New instance is created from snapshot
- Replication starts from us-west-1 to us-east-1
- This takes 30-60 minutes

**Phase 2: Wait for Synchronization**

The new replica needs to catch up with all changes made since the snapshot was taken. Monitor the replication lag:
- Lag = 0 means replica is fully synchronized
- Lag > 0 means replica is still catching up

**Phase 3: Promote New Replica**

Once synchronized:
- Stop writes to current primary (maintenance window)
- Verify lag is 0
- Promote the us-east-1 replica to standalone primary
- Update DNS/backend to point to new us-east-1 primary

**Phase 4: Re-establish DR**

Create a new read replica in us-west-1 from the new us-east-1 primary:
```
us-east-1 (New Primary)              us-west-1 (New Replica)
┌─────────────────┐                  ┌─────────────────┐
│ database-1-new  │  ──────────────▶ │ mydbinstance-dr │
│  (PRIMARY)      │   Cross-region   │ (READ REPLICA)  │
│  Read + Write   │   Replication    │  Read Only      │
└─────────────────┘                  └─────────────────┘
```

**Pros:**
- Clean, fresh setup
- Guaranteed data consistency
- No risk of stale data

**Cons:**
- Takes 1-2 hours total
- Requires maintenance window for cutover
- Creates new instance identifiers

---

## Approach 2: Restore from Snapshot

### How It Works

If your original primary had a hardware failure but the data was backed up, you can restore from a snapshot. However, this creates a point-in-time copy, so you'll need to sync recent data.

**The Problem:**
```
Timeline:
─────────────────────────────────────────────────────────────────▶
     │                    │                              │
  Snapshot            Failover                        Now
  taken               happened
     │                    │                              │
     └────────────────────┴──────────────────────────────┘
           Data in              Data written to
           snapshot             us-west-1 after failover
                                (NOT in snapshot)
```

**What Happens:**
1. Restore creates instance with data up to snapshot time
2. Any data written after snapshot is missing
3. You need to manually sync the missing data

**When to Use:**
- When you need to recover to a specific point in time
- When the original primary had data corruption
- When you want to investigate what happened before failure

**Pros:**
- Can recover to specific point in time
- Useful for data corruption scenarios

**Cons:**
- Data gap between snapshot and current state
- Manual data sync required
- More complex and error-prone

---

## Approach 3: In-Place Failback (If Original Recovers)

### How It Works

Sometimes the original primary comes back online on its own (network issue resolved, AWS fixed the problem). In this case, you might be able to use it directly.

**The Challenge:**

When the original primary comes back:
- It has data up to the moment it failed
- It's missing all data written to us-west-1 during the outage
- You cannot just switch back without syncing

**Process:**
1. Check if original primary is online
2. Compare data between both databases
3. Sync missing data from us-west-1 to us-east-1
4. Verify data consistency
5. Switch traffic back to us-east-1
6. Re-establish replication

**Data Sync Options:**
- Use mysqldump to export/import
- Use AWS DMS for continuous sync
- Manual SQL scripts for specific tables

**Pros:**
- Fastest if original is healthy
- Maintains original instance identifiers

**Cons:**
- Risk of data inconsistency
- Requires careful validation
- Complex data sync process

---

## Approach 4: Blue-Green with AWS DMS

### How It Works

AWS Database Migration Service (DMS) can continuously replicate data between two databases. This allows zero-downtime failback.

**Setup:**
```
us-west-1 (Current Primary)          us-east-1 (Target)
┌─────────────────┐                  ┌─────────────────┐
│  mydbinstance   │                  │ database-1-new  │
│  (SOURCE)       │                  │  (TARGET)       │
└────────┬────────┘                  └────────▲────────┘
         │                                    │
         │         ┌─────────────┐            │
         └────────▶│  AWS DMS    │────────────┘
                   │ Replication │
                   │  Instance   │
                   └─────────────┘
```

**How DMS Works:**
1. Full Load: DMS copies all existing data from source to target
2. CDC (Change Data Capture): DMS continuously captures and applies changes
3. When target is caught up, you can switch traffic

**Process:**
1. Create new RDS instance in us-east-1
2. Set up DMS replication from us-west-1 to us-east-1
3. Wait for full load to complete
4. Monitor CDC until lag is near zero
5. Stop application writes briefly
6. Wait for final CDC sync
7. Switch traffic to us-east-1
8. Stop DMS task

**Pros:**
- Near-zero downtime
- Continuous sync until cutover
- Best for large databases
- Can validate data before cutover

**Cons:**
- Most complex setup
- Additional DMS costs
- Requires DMS expertise
- Takes time to set up properly

---

## Comparison Summary

| Approach | Downtime | Data Loss Risk | Complexity | Best For |
|----------|----------|----------------|------------|----------|
| New Replica + Promote | 5-10 min | None | Medium | Most cases |
| Restore from Snapshot | 15-30 min | Possible | Medium | Point-in-time recovery |
| In-Place Failback | 5-15 min | Possible | Low | Quick recovery |
| DMS Blue-Green | Near zero | None | High | Large DBs, critical apps |

---

## Key Concepts

### Why Can't You Just "Undo" Failover?

Once you promote a read replica:
- The replication link is permanently broken
- The replica becomes an independent database
- You cannot re-establish the original replication direction
- You must create a new replica to restore DR capability

### Replication Direction

```
BEFORE FAILOVER:
us-east-1 (Primary) ────▶ us-west-1 (Replica)

AFTER FAILOVER:
us-east-1 (Dead)         us-west-1 (Primary, no replica)

AFTER FAILBACK:
us-east-1 (Primary) ────▶ us-west-1 (New Replica)
```

### Data Consistency

The most critical aspect of failback is ensuring no data is lost:
- Always verify replication lag is 0 before promoting
- Consider a brief write freeze during cutover
- Validate data counts and checksums after failback

### Instance Identifiers

After failback, you'll likely have new instance identifiers:
- Old: database-1, mydbinstance
- New: database-1-new, mydbinstance-dr

Update your monitoring, alarms, and documentation accordingly.

---

## Recommended Failback Strategy for Your Setup

Given your architecture, I recommend **Approach 1 (New Replica + Promote)**:

1. Create cross-region replica from us-west-1 to us-east-1
2. Wait for full synchronization (lag = 0)
3. Schedule 10-minute maintenance window
4. Promote us-east-1 replica
5. Update Route 53/backend configuration
6. Create new replica in us-west-1 for DR
7. Verify everything works
8. Clean up old instances after 24-48 hours

This approach gives you:
- Zero data loss
- Minimal downtime (5-10 minutes)
- Clean, predictable process
- Full DR capability restored
