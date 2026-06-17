import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAuditData, isCustomAuditEndpoint } from './telemetry.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DISABLE_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  delete process.env.SKILLS_AUDIT_URL;
});

describe('fetchAuditData', () => {
  it('does not call the audit endpoint when telemetry is disabled', async () => {
    process.env.DISABLE_TELEMETRY = '1';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchAuditData('parlance-labs/private-skills', ['code-review'])
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('detects custom audit endpoints', () => {
    expect(isCustomAuditEndpoint()).toBe(false);

    process.env.SKILLS_AUDIT_URL = 'https://registry.example.com/api/audit';

    expect(isCustomAuditEndpoint()).toBe(true);
  });
});
