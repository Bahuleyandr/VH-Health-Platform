import { CURRENT_BED_STRUCTURE } from '../../../scripts/seed-current-bed-structure.mjs';

describe('current VH bed structure seed', () => {
  it('keeps the current ward and bed list deterministic and non-duplicated', () => {
    const wards = CURRENT_BED_STRUCTURE.map((ward) => ward.name);
    const beds = CURRENT_BED_STRUCTURE.flatMap((ward) => ward.beds.map(([bedNumber]) => bedNumber));

    expect(wards).toEqual([
      'ER',
      'Day Care',
      'Dialysis',
      'A Block - Floor III',
      'A Block - Floor IV',
      'A Block - Floor V',
      'B Block - ICU',
      'B Block - Floor II',
      'B Block - Floor III',
    ]);
    expect(new Set(beds).size).toBe(beds.length);
    expect(beds).toHaveLength(97);
    expect(beds).toEqual(expect.arrayContaining([
      'ER-1',
      'ER-10',
      'DC-1',
      'DC-10',
      'DIAL-1',
      'DIAL-4',
      'A-301',
      'A-310A',
      'A-410',
      'B-101',
      'B-114',
      'B-212',
      'B-312',
    ]));
  });
});
