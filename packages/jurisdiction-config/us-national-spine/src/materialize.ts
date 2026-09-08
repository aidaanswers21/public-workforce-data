import { OrganizationRepository, type SqlClient } from '@public-workforce/database';
import { texasEducationJurisdiction } from '@public-workforce/jurisdiction-texas-education';
import type { Uuid } from '@public-workforce/shared-types';

export const TEXAS_ASKTED_SOURCE_KEY = 'texas-askted-site-2026';

export async function ensureTexasEducationJurisdiction(client: SqlClient): Promise<Uuid> {
  const config = texasEducationJurisdiction;
  return new OrganizationRepository(client).upsertJurisdiction({
    code: config.jurisdiction.code,
    name: config.jurisdiction.name,
    governmentLevelCode: config.governmentLevelCode,
  });
}

/** Materialize only unambiguous values that the Texas organization file publishes. */
export async function materializeTexasEducationAttributes(client: SqlClient): Promise<number> {
  const result = await client.query<{ organization_id: Uuid }>(
    `insert into education_organization_attributes (
       organization_id, low_grade, high_grade, school_type, operational_status,
       is_charter, is_magnet, is_virtual, enrollment, enrollment_as_of,
       source_document_id, first_seen_at, last_seen_at
     )
     select r.organization_id,
            nullif(r.attributes ->> 'lowGrade', ''),
            nullif(r.attributes ->> 'highGrade', ''),
            nullif(r.attributes ->> 'instructionType', ''),
            nullif(r.attributes ->> 'status', ''),
            case
              when nullif(r.attributes ->> 'charterType', '') is not null then true
              else null
            end,
            case r.attributes ->> 'magnetStatus'
              when 'Y' then true
              when 'N' then false
              else null
            end,
            case r.attributes ->> 'virtualStatus'
              when 'Virtual' then true
              when 'No' then false
              else null
            end,
            case
              when jsonb_typeof(r.attributes -> 'enrollment') = 'number'
                then (r.attributes ->> 'enrollment')::integer
              else null
            end,
            null,
            r.source_document_id, r.first_seen_at, r.last_seen_at
     from organization_spine_records r
     where r.source_key = $1 and r.status = 'imported' and r.organization_id is not null
     on conflict (organization_id) do update set
       low_grade = coalesce(excluded.low_grade, education_organization_attributes.low_grade),
       high_grade = coalesce(excluded.high_grade, education_organization_attributes.high_grade),
       school_type = coalesce(excluded.school_type, education_organization_attributes.school_type),
       operational_status = coalesce(
         excluded.operational_status,
         education_organization_attributes.operational_status
       ),
       is_charter = coalesce(excluded.is_charter, education_organization_attributes.is_charter),
       is_magnet = coalesce(excluded.is_magnet, education_organization_attributes.is_magnet),
       is_virtual = coalesce(excluded.is_virtual, education_organization_attributes.is_virtual),
       enrollment = coalesce(excluded.enrollment, education_organization_attributes.enrollment),
       source_document_id = excluded.source_document_id,
       first_seen_at = least(
         education_organization_attributes.first_seen_at,
         excluded.first_seen_at
       ),
       last_seen_at = greatest(
         education_organization_attributes.last_seen_at,
         excluded.last_seen_at
       )
     returning organization_id`,
    [TEXAS_ASKTED_SOURCE_KEY],
  );
  return result.rows.length;
}
