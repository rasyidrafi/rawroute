import { aiPagePaths } from "../contracts/pages"

export function aiWorkspaceChanged(pathname: string) {
  return pathname.startsWith(`${aiPagePaths.providers}/`) ? aiPagePaths.providers : undefined
}
