import { afterEach, describe, expect, it } from 'vitest';
import { TestDatabase } from '../testing.js';
import { SourcePolicyRepository } from './source-policies.js';

let database: TestDatabase | null = null;

afterEach(async () => {
  await database?.close();
  database = null;
});

describe('source policy operator workflow', () => {
  it('records an evidence hash and separate production approval with audit events', async () => {
    database = await TestDatabase.create();
    const policies = new SourcePolicyRepository(database);
    const id = await policies.recordReview({
      domain: 'WWW.Example.gov',
      collectionStatus: 'review_required',
      commercialUseStatus: 'unknown',
      solicitationStatus: 'restricted',
      automatedAccessStatus: 'permitted',
      policyUrl: 'https://example.gov/terms',
      policyTextSnapshot: 'Automated access is permitted subject to rate limits.',
      reviewNotes: 'Read the terms and robots policy.',
      reviewedBy: 'owner@example.test',
    });

    await policies.approve(id, 'owner@example.test', 'Approve conservative automated collection.');
    const [policy] = await policies.list();
    expect(policy).toMatchObject({
      domain: 'example.gov',
      collectionStatus: 'review_required',
      reviewedBy: 'owner@example.test',
      productionApprovedBy: 'owner@example.test',
    });
    expect(policy?.policyTextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await database.count('audit_events')).toBe(2);
  });

  it('never permits an approval around a prohibited decision', async () => {
    database = await TestDatabase.create();
    const policies = new SourcePolicyRepository(database);
    const id = await policies.recordReview({
      domain: 'blocked.example.gov',
      collectionStatus: 'prohibited',
      commercialUseStatus: 'prohibited',
      solicitationStatus: 'prohibited',
      automatedAccessStatus: 'prohibited',
      reviewNotes: 'Terms explicitly prohibit automated access.',
      reviewedBy: 'owner@example.test',
    });

    await expect(
      policies.approve(id, 'owner@example.test', 'Attempted prohibited approval.'),
    ).rejects.toThrow(/cannot be approved/);
  });
});
