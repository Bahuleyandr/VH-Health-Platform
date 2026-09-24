// OPEN-22 (2026-09-03): install stages may copy only package manifests before
// npm ci; another npm ci invocation cannot bypass that boundary.
const MANIFEST_COPY = /^COPY package\.json package-lock\.json\*? \.\/$/;
const NPM_CI = /^RUN (?:ONNXRUNTIME_NODE_INSTALL=skip )?npm ci(?:[ \t]|$)/gm;

export function installStagesCopyOnlyManifestsBeforeNpmCi(dockerfile, expectedStageCount) {
  const installStages = dockerfile
    .split(/^FROM /m)
    .map((stage) => ({
      stage,
      installs: [...stage.matchAll(NPM_CI)],
      npmCiLines: stage
        .split(/\r?\n/)
        .filter((line) => !/^\s*#/.test(line) && /\bnpm[ \t]+ci\b/.test(line)),
    }))
    .filter(({ npmCiLines }) => npmCiLines.length > 0);
  return (
    expectedStageCount > 0 &&
    installStages.length === expectedStageCount &&
    installStages.every(({ stage, installs, npmCiLines }) => {
      if (installs.length !== 1 || npmCiLines.length !== 1) return false;
      const beforeInstall = stage.slice(0, installs[0].index);
      const copies = beforeInstall
        .split(/\r?\n/)
        .filter((line) => /^COPY\b/.test(line));
      return copies.length === 1 && MANIFEST_COPY.test(copies[0]);
    })
  );
}
