# Security policy

Security fixes target the latest version on `main`. Update the checkout and rerun
`python3 install.py` to install fixes; consumers using a submodule must also update
its pinned commit.

## Reporting a vulnerability

Please report suspected vulnerabilities privately using
[Report a vulnerability](https://github.com/codexceed/herdr-ide/security/advisories/new).
Include affected versions, reproduction steps, and the expected impact. Do not
include credentials or private session logs, or disclose vulnerabilities in public
issues before a fix is available.

## Local access and installation

The layout runs local commands and reads files you open, repository information,
and local agent session metadata. See the README for the paths and programs used.
The installer may download Mermaid CLI and its browser dependency; use
`--no-mermaid` to skip those downloads.
