// OPEN-22 (2026-09-03): install stages may copy only package manifests before
// npm ci; another npm ci invocation cannot bypass that boundary.
const MANIFEST_COPY = /^COPY package\.json package-lock\.json\*? \.\/$/;
const NPM_CI = /^RUN (?:ONNXRUNTIME_NODE_INSTALL=skip )?npm[ \t]+ci(?:[ \t]|$)/gm;

export function installStagesCopyOnlyManifestsBeforeNpmCi(dockerfile, expectedStageCount) {
  const installStages = dockerfile
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\\\r?\n[ \t]*/g, ' ')
    .split(/^FROM /m)
    .map((stage) => ({
      stage,
      installs: [...stage.matchAll(NPM_CI)],
      npmCiInvocations: stage
        .split(/\r?\n/)
        .map((line) => {
          const exec = line.match(/^\s*RUN(?:\s+--\S+)*\s+(\[.*\])\s*$/i);
          if (!exec) return line;
          try {
            const args = JSON.parse(exec[1]);
            return Array.isArray(args) ? args.join(' ') : line;
          } catch {
            return line;
          }
        })
        .flatMap((line) => [...line.matchAll(/\bnpm[ \t]+ci\b/g)]),
    }))
    .filter(({ npmCiInvocations }) => npmCiInvocations.length > 0);
  return (
    expectedStageCount > 0 &&
    installStages.length === expectedStageCount &&
    installStages.every(({ stage, installs, npmCiInvocations }) => {
      if (installs.length !== 1 || npmCiInvocations.length !== 1) return false;
      const beforeInstall = stage.slice(0, installs[0].index);
      const imports = beforeInstall
        .split(/\r?\n/)
        .map((line) => line.trimStart())
        .filter((line) => /^(?:COPY|ADD)\b/i.test(line));
      return imports.length === 1 && MANIFEST_COPY.test(imports[0]);
    })
  );
}
