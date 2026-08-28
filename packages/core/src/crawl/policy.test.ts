import { describe, expect, it } from 'vitest';
import { HttpRobotsProvider, RobotsTxt, isAllowedDomain, withPolicyDefaults } from './policy.js';

const UA = 'PensionAppointmentNetworkBot/0.1';

describe('RobotsTxt', () => {
  const robots = RobotsTxt.parse(`
User-agent: *
Disallow: /private
Disallow: /search
Allow: /private/public-directory
Crawl-delay: 5

User-agent: PensionAppointmentNetworkBot
Disallow: /no-bots
`);

  it('allows a path with no matching rule', () => {
    expect(robots.check('/staff-directory', 'SomeOtherBot/1.0').allowed).toBe(true);
  });

  it('honours a disallow for the wildcard group', () => {
    expect(robots.check('/private/records', 'SomeOtherBot/1.0').allowed).toBe(false);
  });

  it('lets a longer allow override a shorter disallow', () => {
    const decision = robots.check('/private/public-directory/list', 'SomeOtherBot/1.0');
    expect(decision.allowed).toBe(true);
    expect(decision.matchedRule).toContain('Allow');
  });

  it('prefers the group matching our own user agent', () => {
    expect(robots.check('/no-bots', UA).allowed).toBe(false);
    expect(robots.check('/private', UA).allowed).toBe(true);
  });

  it('reports the crawl delay', () => {
    expect(robots.check('/staff', 'SomeOtherBot/1.0').crawlDelaySeconds).toBe(5);
  });

  it('supports wildcards and the end anchor', () => {
    const wild = RobotsTxt.parse('User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/private');
    expect(wild.check('/files/report.pdf', 'X/1').allowed).toBe(false);
    expect(wild.check('/files/report.pdf?x=1', 'X/1').allowed).toBe(true);
    expect(wild.check('/a/b/private', 'X/1').allowed).toBe(false);
  });

  it('ignores comments and blank lines', () => {
    const commented = RobotsTxt.parse('# comment\n\nUser-agent: *\nDisallow: /x # trailing');
    expect(commented.check('/x', 'X/1').allowed).toBe(false);
  });
});

describe('HttpRobotsProvider', () => {
  it('treats an unavailable robots.txt as permissive but says so', async () => {
    const provider = new HttpRobotsProvider(() =>
      Promise.resolve({ ok: false, status: 404, body: '' }),
    );
    const decision = await provider.check('https://x.example.org/staff', UA);
    expect(decision.allowed).toBe(true);
    expect(decision.note).toContain('unavailable');
  });

  it('fetches robots.txt once per origin', async () => {
    let calls = 0;
    const provider = new HttpRobotsProvider(() => {
      calls += 1;
      return Promise.resolve({ ok: true, status: 200, body: 'User-agent: *\nDisallow: /private' });
    });
    await provider.check('https://x.example.org/a', UA);
    await provider.check('https://x.example.org/b', UA);
    expect(calls).toBe(1);
  });

  it('applies the fetched rules', async () => {
    const provider = new HttpRobotsProvider(() =>
      Promise.resolve({ ok: true, status: 200, body: 'User-agent: *\nDisallow: /private' }),
    );
    expect((await provider.check('https://x.example.org/private/x', UA)).allowed).toBe(false);
  });
});

describe('isAllowedDomain', () => {
  const seed = 'https://sample-isd.example.org/staff';

  it('allows the seed domain and its subdomains by default', () => {
    const policy = withPolicyDefaults();
    expect(isAllowedDomain('https://sample-isd.example.org/staff?page=2', seed, policy)).toBe(true);
    expect(isAllowedDomain('https://staff.sample-isd.example.org/list', seed, policy)).toBe(true);
  });

  it('refuses an unrelated domain by default', () => {
    expect(isAllowedDomain('https://vendor.example.net/staff', seed, withPolicyDefaults())).toBe(
      false,
    );
  });

  it('honours an explicit allow list', () => {
    const policy = withPolicyDefaults({ allowedDomains: ['vendor.example.net'] });
    expect(isAllowedDomain('https://vendor.example.net/staff', seed, policy)).toBe(true);
    expect(isAllowedDomain('https://sample-isd.example.org/staff', seed, policy)).toBe(false);
  });
});
