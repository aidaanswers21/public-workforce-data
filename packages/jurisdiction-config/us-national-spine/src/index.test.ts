import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { parseDelimitedObjects } from '@public-workforce/jurisdiction-kit';
import {
  ncesLeaRecord,
  ncesSchoolRecord,
  publishedWebsite,
  texasDistrictOverlay,
  texasSchoolOverlay,
  websiteQueueRecord,
} from './index.js';

describe('national spine source normalization', () => {
  it('streams quoted records across chunk boundaries', async () => {
    const rows: Record<string, string>[] = [];
    for await (const row of parseDelimitedObjects(
      Readable.from(['ID,Name,Note\n1,"Example, Ci', 'ty","Line one\nLine ""two"""\n']),
    )) {
      rows.push(row);
    }
    expect(rows).toEqual([{ ID: '1', Name: 'Example, City', Note: 'Line one Line "two"' }]);
  });

  it('normalizes a published website while retaining the exact source value', () => {
    expect(publishedWebsite('www.example.gov')).toEqual({
      publishedValue: 'www.example.gov',
      canonicalUrl: 'https://www.example.gov/',
      primaryDomain: 'example.gov',
    });
    expect(publishedWebsite('')).toBeNull();
  });

  it('keeps NCES hierarchy, addresses and published aggregate metrics organization-scoped', () => {
    const lea = ncesLeaRecord({
      LEAID: '0100002',
      ST_LEAID: 'AL-210',
      ST: 'AL',
      LEA_NAME: 'Alabama Youth Services',
      LSTREET1: '1000 Industrial School Road',
      LCITY: 'Mt Meigs',
      LSTATE: 'AL',
      LZIP: '36057',
      WEBSITE: 'http://www.example.gov/district',
      LEA_TYPE_TEXT: 'Regular public school district',
      SY_STATUS_TEXT: 'Open',
    });
    const school = ncesSchoolRecord({
      NCESSCH: '010000500870',
      LEAID: '0100002',
      ST_SCHID: 'AL-210-0010',
      ST: 'AL',
      SCH_NAME: 'Example Middle School',
      LSTREET1: '600 Main Avenue',
      LCITY: 'Example',
      LSTATE: 'AL',
      LZIP: '35950',
      WEBSITE: '',
      SCH_TYPE_TEXT: 'Regular School',
    });

    expect(lea).toMatchObject({
      organizationTypeCode: 'school_district',
      governmentLevelCode: null,
      identifiers: expect.arrayContaining([
        { systemCode: 'nces_district_id', value: '0100002', issuingStateCode: null },
      ]),
    });
    expect(school).toMatchObject({
      organizationTypeCode: 'school',
      parentIdentifiers: [
        { systemCode: 'nces_district_id', value: '0100002', issuingStateCode: null },
      ],
      website: null,
    });
    expect(websiteQueueRecord(school!)).toMatchObject({
      sourceRecordKey: '010000500870',
      nextStages: [
        'exact_identifier_overlay',
        'official_registry_match',
        'official_directory_match',
        'search_result_review',
      ],
    });
  });

  it('allowlists organization fields from the Texas overlay and excludes people', () => {
    const row = {
      'District Number': "'001902",
      'District Name': 'Cayuga ISD',
      'NCES District ID': "'4813200",
      'County Name': 'ANDERSON COUNTY',
      'District Site Street Address': '17750 N US HWY 287',
      'District Site City': 'TENNESSEE COLONY',
      'District Site State': 'TX',
      'District Site Zip': '75861',
      'District Web Page Address': 'www.cayugaisd.com',
      'District Superintendent': 'A PERSON WHO MUST NOT ENTER THIS IMPORT',
      'District Enrollment as of Oct 2025': '575',
      'School Number': "'001902001",
      'School Name': 'CAYUGA H S',
      'NCES School ID': "'481320000821",
      'School Site Street Address': '17750 N US HWY 287',
      'School Site City': 'TENNESSEE COLONY',
      'School Site State': 'TX',
      'School Site Zip': '75861',
      'School Web Page Address': 'www.cayugaisd.com',
      'School Principal': 'ANOTHER PERSON WHO MUST NOT ENTER THIS IMPORT',
      'School Enrollment as of Oct 2025': '196',
    };
    const district = texasDistrictOverlay(row);
    const school = texasSchoolOverlay(row);
    const serialized = JSON.stringify([district, school]);

    expect(district).toMatchObject({
      sourceRecordKey: 'district:001902',
      governmentLevelCode: 'special_district',
      attributes: { enrollment: 575 },
    });
    expect(school).toMatchObject({
      sourceRecordKey: 'school:001902001',
      parentIdentifiers: expect.arrayContaining([
        { systemCode: 'nces_district_id', value: '4813200', issuingStateCode: null },
      ]),
      attributes: { enrollment: 196 },
    });
    expect(serialized).not.toContain('A PERSON');
    expect(serialized).not.toContain('ANOTHER PERSON');
  });
});
