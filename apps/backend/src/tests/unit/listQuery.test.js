import { buildPagination, normalizeSortOrder, parseListQuery } from '../../utils/listQuery.js';

describe('list query utilities', () => {
  it('clamps invalid pagination and normalizes sort order', () => {
    const parsed = parseListQuery(
      { page: '-3', limit: '500', sortBy: 'unknown', sortOrder: 'asc', search: '  ward  ' },
      {
        defaultLimit: 20,
        maxLimit: 100,
        defaultSortBy: 'created_at',
        allowedSortFields: ['created_at', 'name'],
      }
    );

    expect(parsed).toEqual({
      page: 1,
      limit: 100,
      offset: 0,
      search: 'ward',
      sortBy: 'created_at',
      sortOrder: 'ASC',
    });
  });

  it('accepts explicit offsets only for offset-compatible endpoints', () => {
    expect(parseListQuery({ page: '2', limit: '10', offset: '30' }).offset).toBe(10);
    expect(parseListQuery({ page: '2', limit: '10', offset: '30' }, { allowOffset: true }).offset).toBe(30);
  });

  it('returns canonical pagination flags', () => {
    expect(buildPagination(101, 2, 50)).toEqual({
      page: 2,
      limit: 50,
      total: 101,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });
    expect(normalizeSortOrder('not-valid')).toBe('DESC');
  });
});
