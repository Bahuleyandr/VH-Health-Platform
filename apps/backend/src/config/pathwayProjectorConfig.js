export const PATHWAY_PROJECTOR_CONSUMER_KEY = 'care_pathway_projector';
export const PATHWAY_PROJECTOR_GENERATION = 4;

export function isPathwayProjectorShadowEnabled(env = process.env) {
  return String(env.PATHWAY_PROJECTOR_SHADOW_ENABLED || '').trim().toLowerCase() === 'true';
}
