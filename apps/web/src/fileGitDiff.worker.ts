import { addedGitLines, type GitDiffRequest, type GitDiffResponse } from "./fileGitDiff";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<GitDiffRequest>) => void;
  postMessage: (response: GitDiffResponse) => void;
};
scope.onmessage = ({ data }) => {
  let lines: number[] | undefined;
  try {
    lines = addedGitLines(data.base, data.current);
  } catch {
    // An unavailable diff preserves existing editor decorations.
  }
  scope.postMessage({ id: data.id, lines });
};
