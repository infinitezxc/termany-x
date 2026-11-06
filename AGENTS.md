# Project rules

- Before committing, check `git log -10 --oneline` and follow the existing
  commit message convention, such as `fix(server): describe the change`.
- After repacking, check whether the running server needs restarting. Compare
  the running process and installed bundle with the new build; matching version
  numbers alone do not prove the code is current.
- Report whether the new build is installed and whether a restart is needed.
  If needed, give the verified server PID and exact `kill <PID>` command.
  Do not stop active sessions unless restarting is authorized.
