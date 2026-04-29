import { parseNearbyCoordinates } from '../../controllers/sosController.js';

describe('parseNearbyCoordinates', () => {
  it('accepts canonical latitude and longitude query names', () => {
    expect(parseNearbyCoordinates({ latitude: '13.0827', longitude: '80.2707' })).toEqual({
      latitude: 13.0827,
      longitude: 80.2707
    });
  });

  it('accepts mobile-friendly lat and lng aliases', () => {
    expect(parseNearbyCoordinates({ lat: '13.0827', lng: '80.2707' })).toEqual({
      latitude: 13.0827,
      longitude: 80.2707
    });
  });

  it('rejects missing or out-of-range coordinates', () => {
    expect(parseNearbyCoordinates({ lat: '13.0827' })).toBeNull();
    expect(parseNearbyCoordinates({ lat: '91', lng: '80.2707' })).toBeNull();
    expect(parseNearbyCoordinates({ lat: '13.0827', lng: '181' })).toBeNull();
  });
});
