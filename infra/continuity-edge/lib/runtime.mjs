import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function loadRuntime(
  runtimeRoot = process.env.VHEDGE_RUNTIME_ROOT ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime'),
) {
  const verifierPath = path.join(runtimeRoot, 'continuityEdgeMirrorVerifier.js');
  const canonicalPath = path.join(runtimeRoot, 'continuityPackCanonical.js');
  await Promise.all([access(verifierPath), access(canonicalPath)]);
  const nonce = `?loaded=${Date.now()}`;
  const [verifier, canonical] = await Promise.all([
    import(`${pathToFileURL(verifierPath).href}${nonce}`),
    import(`${pathToFileURL(canonicalPath).href}${nonce}`),
  ]);
  return {
    verifyContinuityEdgeMirror: verifier.verifyContinuityEdgeMirror,
    reasons: verifier.EDGE_MIRROR_VERIFICATION_REASONS,
    canonical,
  };
}
